// THE INBOUND CORE (decision 2(a), (b) and (d)): who may speak to the organisation through the chat, and what happens to what they say.
// A LEAF module over the ledger and the classifier, with the provider's updates passed IN and nothing fetched, so it is tested with
// plain objects shaped like Telegram's `getUpdates`.
//
// THREE THINGS, in the order an update meets them:
//   1. `acceptUpdate(update, { chairman })` -- IDENTITY. Accepts only `from.id == userId AND chat.id == chatId AND chat.type == "private"`,
//      for a message and for a button press alike. Everything else is a DROP with a distinct reason, and a drop is a value, never a throw.
//   2. `classifyText` (./classify.ts) -- on an accepted MESSAGE, before it is forwarded.
//   3. `createInbound({ ledger, chairman }).handle(update)` -- the two above, plus DEDUPE by the provider's update id, plus ONE ledger line
//      per verdict. It returns what the caller (the listener, row 8) must do; it does none of it.
//
// **A BUTTON'S DATA IS A CLOSED VOCABULARY (a11ign/a11ign#3423).** `ans:<option id>` for an option a brief offers, and `act:<name>` for one of the
// fixed words in `BUTTON_ACTIONS`. Anything else is a DROP with its own reason and a hash of the data, never forwarded: the data is read back from
// Telegram, so it is the chat's and not the organisation's, and a press the organisation never drew must reach nothing. What each word MEANS is
// `answers.ts`'s; this module only says which words exist.
//
// **THE ACCEPTED VALUE IS BRANDED, AND ONLY `handle` MINTS ONE.** (b): "there is no code path from a chat message to a worker", and the
// function that writes a chairman-attributed row comment (row 9) accepts only what `isAccepted(value, chairman)` says this module minted
// FOR THAT CHAIRMAN. Three things carry that, and each closes a hole the one before leaves:
//   * a module-private Symbol is the brand (a copy made with `{ ...value }` or a JSON round trip does not carry it), and a module-private
//     registry is what was minted (the symbol can be read off a value with reflection, and a value built around it is not registered);
//   * THE REGISTRY HOLDS THE IDS the value was minted for, and `isAccepted` makes the caller name the chairman it is configured with. The
//     brand alone proves "this module's checks ran", not "against the right person": any code can call `createInbound` with ids of its own;
//   * the value is minted only AFTER the classifier said forward. `acceptUpdate` is identity alone, and what it returns is a plain
//     object that is NOT accepted, so a value that skipped the classifier cannot be mistaken for one that did not.
//
// **THE LEDGER LINE NEVER HOLDS THE TEXT** (decision 1): ids, a reason, a length and a sha256. A dropped message is attacker-chosen text,
// and a refused one may have been a secret the classifier half-recognised. For a SECRET verdict (a drop, or a message withheld as one nobody is sure of) the sha256 is also left out (null): a
// hash of a bare password is a dictionary away from the password, and the length and the update id already say everything a reader
// needs about a message that was thrown away.
//
// **A CHAT NOTICE IS RECORDED, NEVER ACTED ON (a11ign/a11ign#4743).** `my_chat_member` (the bot was added to a chat) and `channel_post` (one posted
// in it) are not the chairman speaking, and they must never reach the classifier, a command or the forward path. `handle` takes the ONE fact
// they carry, which chat exists, and writes it once as a `chat-seen` line (`chatsSeen` reads it back, so `messaging:chats` prints the id with
// no token in sight). The post's text is not read at all. And the answer is its own action, `noted`, never `ignore`: an `ignore` that named a
// channel would have the listener LEAVE it (`chatToLeave`), which is the one thing the chairman's announcements channel must never see.

import { createHash } from "node:crypto";
import { classifyText, VERDICT } from "./classify.ts";

const BRAND = Symbol("chairman-accepted-update");
/** What was minted, and for whom. */
const MINTED: WeakMap<object, { userId: number; chatId: number; }> = new WeakMap();

/** The reasons an update is dropped on identity or shape. Distinct, so a ledger reader can tell a stranger from an edit. */
export const DROP_REASON = Object.freeze({
  malformed: "malformed",
  unsupportedType: "unsupported-type",
  edited: "edited",
  channelPost: "channel-post",
  noSender: "no-sender",
  wrongUser: "wrong-user",
  notPrivateChat: "not-private-chat",
  wrongChat: "wrong-chat",
  forwarded: "forwarded",
  notText: "not-text",
  unknownCallbackData: "unknown-callback-data",
});

const OPTION_PREFIX = "ans:";
const ACTION_PREFIX = "act:";
/** The same shape `parseChairmanOptions` accepts for an option id (`sources/requests.ts` `OPTION_ID`); `inbound.test.mjs` pins the two together, because this module is a leaf and does not import it. */
const OPTION_ID_SHAPE = /^[A-Za-z0-9_-]{1,16}$/;
/** The fixed words a button may carry beside an option id: the closed set of the chairman's point 5 (Approve, Done, Stuck, Later, Explain more, Do it for me). */
export const BUTTON_ACTIONS = Object.freeze(["approve", "done", "stuck", "later", "explain", "forme"]);

/** What a button offering that option carries as `callback_data`. */
export function optionData(optionId: string): string {
  return `${OPTION_PREFIX}${optionId}`;
}

/** What a button for that word (one of `BUTTON_ACTIONS`) carries as `callback_data`. */
export function actionData(action: string): string {
  return `${ACTION_PREFIX}${action}`;
}

/**
 * The one reading of a button's data. PURE, and null for everything outside the vocabulary: no prefix, an id of the wrong shape, a word not in the set.
 */
export function parseButtonData(data: unknown): { kind: "option"; id: string; } | { kind: "action"; name: string; } | null {
  if (typeof data !== "string") return null;
  if (data.startsWith(OPTION_PREFIX)) {
    const id = data.slice(OPTION_PREFIX.length);
    return OPTION_ID_SHAPE.test(id) ? { kind: "option", id } : null;
  }
  const name = data.startsWith(ACTION_PREFIX) ? data.slice(ACTION_PREFIX.length) : null;
  return name !== null && BUTTON_ACTIONS.includes(name) ? { kind: "action", name } : null;
}

const KNOWN_CHAT_TYPES = new Set(["private", "group", "supergroup", "channel"]);
const FORWARD_FIELDS = ["forward_origin", "forward_date", "forward_from", "forward_from_chat", "forward_sender_name", "forward_from_message_id"];
const EDIT_TYPES = new Set(["edited_message"]);
const CHANNEL_TYPES = new Set(["channel_post", "edited_channel_post"]);
/** The updates that say a CHAT exists and carry nothing anybody said in it for this module to act on. */
const CHAT_NOTICE_TYPES = new Set(["my_chat_member", "channel_post"]);
/** A private chat is the chairman's or a stranger's, and `acceptUpdate` judges it; only a place the bot was put is worth remembering. */
const NOTICED_CHAT_TYPES = new Set(["group", "supergroup", "channel"]);
/** What `my_chat_member.new_chat_member.status` says when the bot is no longer in the chat: a chat it left is not one to post to. */
const GONE_STATUSES = new Set(["left", "kicked"]);
/** Telegram's own limit on a chat title; a longer one did not come from Telegram. */
const TITLE_LIMIT = 128;
/** The ledger line's `direction`. Not `in`: it is no message, so nothing that counts or dedupes inbound messages sees it. */
const CHAT_SEEN = "chat-seen";

/** An id only when it is a safe integer; anything else is attacker text and is not recorded. */
function safeId(value: unknown): number | null {
  return Number.isSafeInteger(value) ? value as number : null;
}

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** What the ledger may hold about it: never the text. */
function describeContent(content: unknown): { length: number | null; sha256: string | null; } {
  if (typeof content !== "string") return { length: null, sha256: null };
  return { length: content.length, sha256: createHash("sha256").update(content, "utf8").digest("hex") };
}

/**
 * @throws {TypeError} when the chairman's ids are not both safe integers: with an id missing, "the sender's id equals the chairman's" would
 *   be `null === undefined`-shaped and an update with no sender could be accepted by accident.
 */
function checkedChairman({ chairman }: { chairman: { userId: number; chatId: number; }; }) {
  if (!isObject(chairman) || safeId(chairman.userId) === null || safeId(chairman.chatId) === null) {
    throw new TypeError("acceptUpdate: chairman.userId and chairman.chatId must both be integers");
  }
  return chairman;
}

/**
 * What an update is, before anyone is asked who sent it.
 */
function locatePayload(update: unknown): { drop: string; } | { kind: "message" | "button"; payload: Record<string, any>; } {
  if (!isObject(update)) return { drop: DROP_REASON.malformed };
  // No integer id, no dedupe: a replay of it would act twice, so it is not acted on once. The provider always supplies one.
  if (safeId(update.update_id) === null) return { drop: DROP_REASON.malformed };
  const payloads = Object.keys(update).filter((key) => key !== "update_id");
  // An update carries ONE payload. Zero is nothing to act on and two is not something the provider sends, so neither is guessed at.
  if (payloads.length !== 1) return { drop: DROP_REASON.malformed };
  const [type] = payloads;
  if (EDIT_TYPES.has(type)) return { drop: DROP_REASON.edited };
  if (CHANNEL_TYPES.has(type)) return { drop: DROP_REASON.channelPost };
  if (type !== "message" && type !== "callback_query") return { drop: DROP_REASON.unsupportedType };
  return isObject(update[type]) ? { kind: type === "message" ? "message" : "button", payload: update[type] } : { drop: DROP_REASON.malformed };
}

/** The reason this chat is not the chairman's. */
function chatDrop(chat: Record<string, any>, chairman: { userId: number; chatId: number; }): string | null {
  if (chat.type !== "private") return DROP_REASON.notPrivateChat;
  return chat.id === chairman.chatId ? null : DROP_REASON.wrongChat;
}

/** A chat the bot was put in, as the ledger holds it. `title` is the chat's name, which is not a secret, and null when there is none. */
export type ChatSeen = { chatId: number; type: string; title: string | null };

/** A title as text a terminal can show: a string, without control characters, and no longer than Telegram allows. It is a stranger's to choose. */
function safeTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\p{Cc}/gu, " ").trim().slice(0, TITLE_LIMIT);
  return text === "" ? null : text;
}

/**
 * The chat a notice names, or null when the update is not a notice or names nothing worth remembering. PURE, and it reads the chat and
 * nothing else: not the post's text, not who sent it. Null is not a verdict: it hands the update to `acceptUpdate`, whose reasons
 * (`channel-post`, `unsupported-type`, `malformed`) are exactly what they were before a notice was recognised.
 */
function chatNotice(update: unknown, { chatId: chairmanChatId }: { chatId: number; }): ChatSeen | null {
  if (!isObject(update) || safeId(update.update_id) === null) return null;
  const types = Object.keys(update).filter((key) => key !== "update_id");
  if (types.length !== 1 || !CHAT_NOTICE_TYPES.has(types[0])) return null;
  const notice = update[types[0]];
  if (!isObject(notice) || !isObject(notice.chat) || !NOTICED_CHAT_TYPES.has(notice.chat.type)) return null;
  if (isObject(notice.new_chat_member) && GONE_STATUSES.has(notice.new_chat_member.status)) return null;
  const chatId = safeId(notice.chat.id);
  // The chairman's own chat is `acceptUpdate`'s, whatever an update calls it (as `chatToLeave` refuses to leave it).
  if (chatId === null || chatId === chairmanChatId) return null;
  return { chatId, type: notice.chat.type, title: safeTitle(notice.chat.title) };
}

/**
 * The chats the ledger has recorded, in the order they were first seen. THE ONE READER of the `chat-seen` line, beside its one writer
 * (`createInbound`), so `messaging:chats` and the dedupe below cannot disagree about what a line is.
 */
export function chatsSeen(lines: Record<string, any>[]): ChatSeen[] {
  const found = new Map<number, ChatSeen>();
  for (const line of lines) {
    if (line.direction !== CHAT_SEEN || safeId(line.chatId) === null || typeof line.type !== "string") continue;
    if (!found.has(line.chatId)) found.set(line.chatId, { chatId: line.chatId, type: line.type, title: typeof line.title === "string" ? line.title : null });
  }
  return [...found.values()];
}

/**
 * The accepted value. Frozen, branded, registered against the chairman it was minted for. Called only by `handle`, after the classifier.
 */
function mint(fields: Record<string, unknown>, { userId, chatId }: { userId: number; chatId: number; }): Readonly<Record<string, any>> {
  const value = { ...fields };
  Object.defineProperty(value, BRAND, { value: true, enumerable: false });
  MINTED.set(value, { userId, chatId });
  return Object.freeze(value);
}

/**
 * The check the chairman-attributed writer makes: this module minted it, after classifying it, for THIS chairman.
 *
 * `chairman` is the ids the CALLER is configured with, never read off the value.
 * @throws {TypeError} when the chairman's ids are not both safe integers: a check that cannot say who it checks for is not run
 */
export function isAccepted(value: unknown, chairman: { userId: number; chatId: number; }): boolean {
  const { userId, chatId } = checkedChairman({ chairman });
  if (!isObject(value)) return false;
  const minted = MINTED.get(value);
  return minted !== undefined && minted.userId === userId && minted.chatId === chatId && (value as Record<symbol, unknown>)[BRAND] === true;
}

/** What the ledger may say about an update. Never the text. */
export type Facts = {
  updateId: number | null; userId: number | null; chatId: number | null; chatType: string | null; kind: string | null;
  length: number | null; sha256: string | null;
};
export type Acceptance = { ok: true; accepted: Readonly<Record<string, any>>; facts: Facts } | { ok: false; reason: string; facts: Facts };

/**
 * Identity, and nothing else: whether this update is the chairman speaking in the chairman's own private chat. **Not the classifier, and
 * what it returns is NOT `isAccepted`**: only `createInbound(...).handle` mints, and only after the classifier has said forward.
 *
 * Dropped, each with its own reason: a message from anyone but the chairman; the chairman in a group, supergroup or channel; the
 * chairman in a private chat that is not the paired one; an edit; a forward; a channel post; and every other update type.
 *
 * `update` is one entry of a provider's `updates`, Telegram's shape.
 */
export function acceptUpdate(update: unknown, options: { chairman: { userId: number; chatId: number; }; }): Acceptance {
  const chairman = checkedChairman(options);
  const updateId = isObject(update) ? safeId(update.update_id) : null;
  const located = locatePayload(update);
  const facts: Facts = { updateId, userId: null, chatId: null, chatType: null, kind: "kind" in located ? located.kind : null, length: null, sha256: null };
  if ("drop" in located) return { ok: false, reason: located.drop, facts };
  const { kind, payload } = located;
  // A button press carries its chat on the message the button sits under.
  const message = kind === "button" ? payload.message : payload;
  const sender = payload.from;
  const chat = isObject(message) ? message.chat : undefined;
  Object.assign(facts, {
    userId: isObject(sender) ? safeId(sender.id) : null,
    chatId: isObject(chat) ? safeId(chat.id) : null,
    chatType: isObject(chat) && KNOWN_CHAT_TYPES.has(chat.type) ? chat.type : null,
    ...describeContent(kind === "button" ? payload.data : payload.text),
  });
  const reason = identityDrop({ sender, chat, message, payload, kind, chairman });
  if (reason !== null) return { ok: false, reason, facts };
  const content = kind === "button" ? { data: payload.data, callbackQueryId: payload.id } : { text: payload.text };
  const accepted = Object.freeze({
    kind, updateId, userId: chairman.userId, chatId: chairman.chatId, messageId: safeId(message.message_id), replyToMessageId: replyTarget(kind, message), ...content,
  });
  return { ok: true, accepted, facts };
}

/**
 * The bot message a chairman's reply points at, so the answer to a request is routed from the value alone. Only a MESSAGE can be a reply: a press
 * sits under its message and says so with `messageId`. A target that is not a safe integer is attacker-shaped text and is null, as in `safeId`.
 */
function replyTarget(kind: string, message: Record<string, any>): number | null {
  return kind === "message" && isObject(message.reply_to_message) ? safeId(message.reply_to_message.message_id) : null;
}

/** Why this is not the chairman, or null when it is. */
function identityDrop({ sender, chat, message, payload, kind, chairman }: { sender: unknown; chat: unknown; message: unknown; payload: Record<string, any>; kind: string; chairman: { userId: number; chatId: number; }; }): string | null {
  if (!isObject(sender) || safeId(sender.id) === null) return DROP_REASON.noSender;
  if (sender.id !== chairman.userId) return DROP_REASON.wrongUser;
  if (!isObject(chat)) return DROP_REASON.malformed;
  const wrongChat = chatDrop(chat, chairman);
  if (wrongChat !== null) return wrongChat;
  if (!isObject(message)) return DROP_REASON.malformed;
  if (FORWARD_FIELDS.some((field) => field in message)) return DROP_REASON.forwarded;
  if (kind === "message" && (typeof message.text !== "string" || message.text === "")) return DROP_REASON.notText;
  // A button's data and query id are what row 9 acts on and answers, so a press whose either is not a string (`{evil: 1}`) is not one.
  if (kind === "button" && (typeof payload.data !== "string" || payload.data === "" || typeof payload.id !== "string")) return DROP_REASON.malformed;
  return null;
}

/**
 * The line for one verdict. Ids are recorded only when they are integers; the content only as a length and (but for a secret) a hash.
 */
function inboundLine({ updateId, userId, chatId, chatType, kind, length, sha256, verdict, reason, hashed }: Facts & { verdict: string; reason: string | null; hashed: boolean; }) {
  return { direction: "in", updateId, verdict, reason, kind, userId, chatId, chatType, length, sha256: hashed ? sha256 : null };
}

export type Handled =
  | { action: "replayed"; updateId: number }
  | { action: "ignore"; reason: string; chatId: number | null; chatType: string | null }
  /** A chat notice. NOT an `ignore`, which names a chat and so would have the listener leave it. `recorded` is false for a chat already known. */
  | { action: "noted"; chatId: number; recorded: boolean }
  | { action: "forward"; accepted: Readonly<Record<string, any>> }
  | { action: "reply"; reason: string; text: string; chatId: number; deleteMessage: { chatId: number; messageId: number | null } | null };

/**
 * `ledger` is `createLedger(...)` from ./ledger.ts (its `append` and `read`). Its `now` stamps the lines, so a test owns the clock.
 */
export function createInbound({ ledger, chairman }: {
        ledger: { append: (entry: Record<string, unknown>) => Record<string, any>; read: () => Record<string, any>[]; };
        chairman: { userId: number; chatId: number; };
    }) {
  checkedChairman({ chairman });
  // THE LEDGER IS THE MEMORY (as in the core): a listener that restarts and is handed the same batch again acts on none of it twice.
  const lines = ledger.read();
  const seen = new Set(lines.filter((line) => line.direction === "in" && Number.isSafeInteger(line.updateId)).map((line) => line.updateId));
  // The same memory for a chat: a restart, or Telegram repeating a post, writes no second line for a chat already recorded.
  const knownChats = new Set(chatsSeen(lines).map((chat) => chat.chatId));

  function record(facts: Facts, { verdict, reason, hashed = true }: { verdict: string; reason: string | null; hashed?: boolean; }) {
    // The line is written BEFORE the caller is told what to do: a crash between the two loses one message and never repeats one.
    ledger.append(inboundLine({ ...facts, verdict, reason, hashed }));
    if (facts.updateId !== null) seen.add(facts.updateId);
  }

  /** A drop, with the hash of the data `facts` already holds. */
  function dropped(facts: Facts, reason: string): Handled {
    record(facts, { verdict: VERDICT.drop, reason });
    return { action: "ignore", reason, chatId: facts.chatId, chatType: facts.chatType };
  }

  function classified(accepted: Readonly<Record<string, any>>, facts: Facts): Handled {
    // A button's data is classified by VOCABULARY and not as text: it is a word the organisation drew or it is nothing, so no secret can be in it.
    if (accepted.kind === "button" && parseButtonData(accepted.data) === null) return dropped(facts, DROP_REASON.unknownCallbackData);
    const result = accepted.kind === "button" ? { verdict: VERDICT.forward } : classifyText(accepted.text);
    if (result.verdict === VERDICT.forward) {
      record(facts, { verdict: VERDICT.forward, reason: null });
      return { action: "forward", accepted: mint(accepted, chairman) };
    }
    // A withheld message is a secret nobody is sure of, so it is handled as one: no hash in its line, and it is deleted from the chat.
    const secret = result.verdict === VERDICT.drop || result.verdict === VERDICT.withhold;
    record(facts, { verdict: result.verdict, reason: result.reason, hashed: !secret });
    const deleteMessage = secret ? { chatId: accepted.chatId, messageId: accepted.messageId } : null;
    return { action: "reply", reason: result.reason, text: result.reply, chatId: accepted.chatId, deleteMessage };
  }

  /** One line per distinct chat, and nothing of what was said in it. Written before the caller is told, as every line here is. */
  function noted(chat: ChatSeen): Handled {
    const recorded = !knownChats.has(chat.chatId);
    if (recorded) {
      ledger.append({ direction: CHAT_SEEN, chatId: chat.chatId, type: chat.type, title: chat.title });
      knownChats.add(chat.chatId);
    }
    return { action: "noted", chatId: chat.chatId, recorded };
  }

  return {
    handle(update: unknown): Handled {
      const updateId = isObject(update) ? safeId(update.update_id) : null;
      if (updateId !== null && seen.has(updateId)) return { action: "replayed", updateId };
      const notice = chatNotice(update, chairman);
      if (notice !== null) return noted(notice);
      const acceptance = acceptUpdate(update, { chairman });
      if (acceptance.ok) return classified(acceptance.accepted, acceptance.facts);
      return dropped(acceptance.facts, acceptance.reason);
    },
  };
}
