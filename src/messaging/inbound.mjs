// @ts-check
// THE INBOUND CORE (decision 2(a), (b) and (d)): who may speak to the organisation through the chat, and what happens to what they say.
// A LEAF module over the ledger and the classifier, with the provider's updates passed IN and nothing fetched, so it is tested with
// plain objects shaped like Telegram's `getUpdates`.
//
// THREE THINGS, in the order an update meets them:
//   1. `acceptUpdate(update, { chairman })` -- IDENTITY. Accepts only `from.id == userId AND chat.id == chatId AND chat.type == "private"`,
//      for a message and for a button press alike. Everything else is a DROP with a distinct reason, and a drop is a value, never a throw.
//   2. `classifyText` (./classify.mjs) -- on an accepted MESSAGE, before it is forwarded.
//   3. `createInbound({ ledger, chairman }).handle(update)` -- the two above, plus DEDUPE by the provider's update id, plus ONE ledger line
//      per verdict. It returns what the caller (the listener, row 8) must do; it does none of it.
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

import { createHash } from "node:crypto";
import { classifyText, VERDICT } from "./classify.mjs";

const BRAND = Symbol("chairman-accepted-update");
/** @type {WeakMap<object, {userId: number, chatId: number}>} what was minted, and for whom */
const MINTED = new WeakMap();

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
});

const KNOWN_CHAT_TYPES = new Set(["private", "group", "supergroup", "channel"]);
const FORWARD_FIELDS = ["forward_origin", "forward_date", "forward_from", "forward_from_chat", "forward_sender_name", "forward_from_message_id"];
const EDIT_TYPES = new Set(["edited_message"]);
const CHANNEL_TYPES = new Set(["channel_post", "edited_channel_post"]);

/** @param {unknown} value @returns {number | null} an id only when it is a safe integer; anything else is attacker text and is not recorded */
function safeId(value) {
  return Number.isSafeInteger(value) ? /** @type {number} */ (value) : null;
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} content @returns {{length: number | null, sha256: string | null}} what the ledger may hold about it: never the text */
function describeContent(content) {
  if (typeof content !== "string") return { length: null, sha256: null };
  return { length: content.length, sha256: createHash("sha256").update(content, "utf8").digest("hex") };
}

/**
 * @param {{chairman: {userId: number, chatId: number}}} options
 * @throws {TypeError} when the chairman's ids are not both safe integers: with an id missing, "the sender's id equals the chairman's" would
 *   be `null === undefined`-shaped and an update with no sender could be accepted by accident.
 */
function checkedChairman({ chairman }) {
  if (!isObject(chairman) || safeId(chairman.userId) === null || safeId(chairman.chatId) === null) {
    throw new TypeError("acceptUpdate: chairman.userId and chairman.chatId must both be integers");
  }
  return chairman;
}

/**
 * What an update is, before anyone is asked who sent it.
 *
 * @param {unknown} update
 * @returns {{drop: string} | {kind: "message" | "button", payload: Record<string, any>}}
 */
function locatePayload(update) {
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

/** @param {Record<string, any>} chat @param {{userId: number, chatId: number}} chairman @returns {string | null} the reason this chat is not the chairman's */
function chatDrop(chat, chairman) {
  if (chat.type !== "private") return DROP_REASON.notPrivateChat;
  return chat.id === chairman.chatId ? null : DROP_REASON.wrongChat;
}

/**
 * The accepted value. Frozen, branded, registered against the chairman it was minted for. Called only by `handle`, after the classifier.
 *
 * @param {Record<string, unknown>} fields @param {{userId: number, chatId: number}} chairman @returns {Readonly<Record<string, any>>}
 */
function mint(fields, { userId, chatId }) {
  const value = { ...fields };
  Object.defineProperty(value, BRAND, { value: true, enumerable: false });
  MINTED.set(value, { userId, chatId });
  return Object.freeze(value);
}

/**
 * The check the chairman-attributed writer makes: this module minted it, after classifying it, for THIS chairman.
 *
 * @param {unknown} value
 * @param {{userId: number, chatId: number}} chairman  the ids the CALLER is configured with, never read off the value
 * @returns {boolean}
 * @throws {TypeError} when the chairman's ids are not both safe integers: a check that cannot say who it checks for is not run
 */
export function isAccepted(value, chairman) {
  const { userId, chatId } = checkedChairman({ chairman });
  if (!isObject(value)) return false;
  const minted = MINTED.get(value);
  return minted !== undefined && minted.userId === userId && minted.chatId === chatId && /** @type {any} */ (value)[BRAND] === true;
}

/**
 * @typedef {{updateId: number | null, userId: number | null, chatId: number | null, chatType: string | null, kind: string | null,
 *            length: number | null, sha256: string | null}} Facts  what the ledger may say about an update. Never the text.
 * @typedef {{ok: true, accepted: Readonly<Record<string, any>>, facts: Facts} | {ok: false, reason: string, facts: Facts}} Acceptance
 */

/**
 * Identity, and nothing else: whether this update is the chairman speaking in the chairman's own private chat. **Not the classifier, and
 * what it returns is NOT `isAccepted`**: only `createInbound(...).handle` mints, and only after the classifier has said forward.
 *
 * Dropped, each with its own reason: a message from anyone but the chairman; the chairman in a group, supergroup or channel; the
 * chairman in a private chat that is not the paired one; an edit; a forward; a channel post; and every other update type.
 *
 * @param {unknown} update  one entry of a provider's `updates`, Telegram's shape
 * @param {{chairman: {userId: number, chatId: number}}} options
 * @returns {Acceptance}
 */
export function acceptUpdate(update, options) {
  const chairman = checkedChairman(options);
  const updateId = isObject(update) ? safeId(update.update_id) : null;
  const located = locatePayload(update);
  /** @type {Facts} */
  const facts = { updateId, userId: null, chatId: null, chatType: null, kind: "kind" in located ? located.kind : null, length: null, sha256: null };
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
 *
 * @param {string} kind @param {Record<string, any>} message @returns {number | null}
 */
function replyTarget(kind, message) {
  return kind === "message" && isObject(message.reply_to_message) ? safeId(message.reply_to_message.message_id) : null;
}

/**
 * @param {{sender: unknown, chat: unknown, message: unknown, payload: Record<string, any>, kind: string, chairman: {userId: number, chatId: number}}} parts
 * @returns {string | null} why this is not the chairman, or null when it is
 */
function identityDrop({ sender, chat, message, payload, kind, chairman }) {
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
 *
 * @param {Facts & {verdict: string, reason: string | null, hashed: boolean}} fields
 */
function inboundLine({ updateId, userId, chatId, chatType, kind, length, sha256, verdict, reason, hashed }) {
  return { direction: "in", updateId, verdict, reason, kind, userId, chatId, chatType, length, sha256: hashed ? sha256 : null };
}

/**
 * @typedef {{action: "replayed", updateId: number}
 *   | {action: "ignore", reason: string, chatId: number | null, chatType: string | null}
 *   | {action: "forward", accepted: Readonly<Record<string, any>>}
 *   | {action: "reply", reason: string, text: string, chatId: number, deleteMessage: {chatId: number, messageId: number | null} | null}} Handled
 */

/**
 * `ledger` is `createLedger(...)` from ./ledger.mjs (its `append` and `read`). Its `now` stamps the lines, so a test owns the clock.
 *
 * @param {{ledger: {append: (entry: Record<string, unknown>) => Record<string, any>, read: () => Record<string, any>[]},
 *          chairman: {userId: number, chatId: number}}} options
 */
export function createInbound({ ledger, chairman }) {
  checkedChairman({ chairman });
  // THE LEDGER IS THE MEMORY (as in the core): a listener that restarts and is handed the same batch again acts on none of it twice.
  const seen = new Set(ledger.read().filter((line) => line.direction === "in" && Number.isSafeInteger(line.updateId)).map((line) => line.updateId));

  /** @param {Facts} facts @param {{verdict: string, reason: string | null, hashed?: boolean}} verdict */
  function record(facts, { verdict, reason, hashed = true }) {
    // The line is written BEFORE the caller is told what to do: a crash between the two loses one message and never repeats one.
    ledger.append(inboundLine({ ...facts, verdict, reason, hashed }));
    if (facts.updateId !== null) seen.add(facts.updateId);
  }

  /** @param {Readonly<Record<string, any>>} accepted @param {Facts} facts @returns {Handled} */
  function classified(accepted, facts) {
    // A button's data is the organisation's own (it chose what each button says), so only free text is classified.
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

  return {
    /** @param {unknown} update @returns {Handled} */
    handle(update) {
      const updateId = isObject(update) ? safeId(update.update_id) : null;
      if (updateId !== null && seen.has(updateId)) return { action: "replayed", updateId };
      const acceptance = acceptUpdate(update, { chairman });
      if (acceptance.ok) return classified(acceptance.accepted, acceptance.facts);
      const { facts, reason } = acceptance;
      record(facts, { verdict: VERDICT.drop, reason });
      return { action: "ignore", reason, chatId: facts.chatId, chatType: facts.chatType };
    },
  };
}
