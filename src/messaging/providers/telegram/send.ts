// THE TELEGRAM PROVIDER, SEND ONLY (a11ign/a11ign#2902; docs/messaging.md decision 1). It passes `runProviderConformance`, so it is a
// provider by the only definition there is. `poll` is the polling provider's (./poll.ts).
//
// **BUTTONS ARE DRAWN HERE (a11ign/a11ign#3423).** `actions` become `reply_markup.inline_keyboard`, one button per row, on the FIRST part of a split
// message only: the first part's id is the `messageRef` the ledger keeps, and a press is routed by the message it sits under. The provider draws
// what it is handed and decides nothing about which presses mean what; the closed vocabulary is `inbound.ts`'s, where a press is received.
//
// **PLAIN TEXT, NO `parse_mode`.** A message body is quoted from a row title or a comment, which anybody may have written. Under
// Markdown or HTML a stray `_` or `<` makes Telegram refuse the whole message (a corrupted alert), and a crafted one injects markup
// into what the chairman reads. With no `parse_mode` there is nothing to escape, so there is no escaping defect to have.
//
// **THE SPLIT IS THE PROVIDER'S, AND `maxText` SAYS HOW FAR IT GOES.** Telegram refuses over 4,096 characters, and the contract has
// `send` refuse anything over `maxText`. Declaring `maxText` as a few whole messages' worth lets the core's shortening still bound a
// runaway body while this module cuts what it is given into messages Telegram will take, on a line boundary where one exists.
//
// **ONE CHAT ID PER AUDIENCE (a11ign/a11ign#4742).** `ask` goes to `chatId`, the chairman's conversation; `announcement` goes to
// `announcementsChatId` when there is one, and to `chatId` when there is not, exactly as every message did before the channel existed. The
// channel is ONE-WAY, so an announcement carrying `actions` is refused before anything is sent (no kind that is an announcement draws any, so
// that refusal changes nothing today), and so is one carrying `replyTo` INTO THE CHANNEL. With no channel an announcement is in the chairman's
// chat as it always was, where an incident's "cleared" threads under the original, so `replyTo` is accepted there: refusing it would fail
// every such notice, and the row says that case is exactly as before.
//
// **EDIT AND PIN (a11ign/a11ign#4744).** The asks list is one message per ask, ticked in place when it is resolved, and one pinned message
// listing what is open, so the provider can `edit` a sent message (`editMessageText`) and `pin` one (`pinChatMessage`, always with
// `disable_notification: true`: a pin is bookkeeping and must not ring). Both act in the destination's chat, `ask` unless told otherwise,
// because a message id means something only inside its own chat: an edit that guessed the chat would rewrite another message. **An edit is
// ONE message**, so it refuses past `TELEGRAM_MAX_MESSAGE`, where `send` splits up to `maxText`. Telegram answers an edit that changes
// nothing with 400 "message is not modified"; that is the state asked for, so it is `unchanged: true` and not a failure (and not logged
// as one). `pinChatMessage` ADDS to a chat's pinned list and replaces nothing, so a caller pins the list once and edits it in place.
//
// **THE TOKEN IS IN THE URL (`/bot<token>/`), SO EVERY `fetch` GOES THROUGH `redactingFetch`** and every line this module logs or
// throws is scrubbed again by the secret's own value. A failure the HTTP layer reports is described by its status and Telegram's own
// `description`, which is Telegram's text and not the request's.

import { AUDIENCE, AUDIENCES } from "../../provider-contract.ts";
import { redactingFetch } from "../../secret.ts";

export const TELEGRAM_API = "https://api.telegram.org";
export const TELEGRAM_MAX_MESSAGE = 4096;
/** How many Telegram messages one `send` may become. A body longer than this is the core's to shorten, and is refused here. */
export const MAX_PARTS = 5;

const MS_PER_SECOND = 1000;
const TOO_MANY_REQUESTS = 429;
const BAD_REQUEST = 400;
const CLIENT_ERROR_FLOOR = 400;
const SERVER_ERROR_FLOOR = 500;
/** Telegram asks for 1 message per second per chat; the parts of one `send` keep to it, so a long body does not provoke a 429 of its own. */
const PART_SPACING_MS = 1000;
/** A `retry_after` longer than this is not waited for inside a tick: the send fails, the ledger records it, and the next tick tries. */
const MAX_RETRY_WAIT_SECONDS = 60;

/** A request with no answer by then is abandoned and reported as a failure: without it a hung connection holds the send until the process is killed. */
export const REQUEST_TIMEOUT_MS = 30_000;

const NEWLINE = "\n";

/** Telegram refuses `callback_data` over 64 BYTES (not characters), and refuses a keyboard of more than 100 buttons; one message needs far fewer. */
export const MAX_CALLBACK_DATA_BYTES = 64;
export const MAX_BUTTONS = 8;
export const MAX_BUTTON_LABEL = 64;
/** What Telegram answers when an edit changes nothing: the markup it is asked to remove is already gone, or the text is the text. Either way it is the state asked for. */
const NOT_MODIFIED = /message is not modified/i;

export class TelegramSendError extends Error {
  declare status?: number;
  declare retryAfter?: number;
  /** `message` is already scrubbed. */
  constructor(message: string, { status, retryAfter }: { status?: number; retryAfter?: number; } = {}) {
    super(message);
    this.name = "TelegramSendError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Returns: `end`, moved back by one when it would cut a surrogate pair in half */
function whole(text: string, end: number): number {
  const code = text.charCodeAt(end - 1);
  const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
  return isHighSurrogate && end > 1 ? end - 1 : end;
}

/** Returns the first part, and what is left to send */
function takeOne(text: string, limit: number): { part: string; rest: string; } {
  if (text.length <= limit) return { part: text, rest: "" };
  const lineEnd = text.lastIndexOf(NEWLINE, limit);
  // A newline at index 0 would make an empty part; a line longer than the limit has none to cut at, so it is cut where it stands.
  if (lineEnd > 0) return { part: text.slice(0, lineEnd), rest: text.slice(lineEnd + NEWLINE.length) };
  const end = whole(text, limit);
  return { part: text.slice(0, end), rest: text.slice(end) };
}

/**
 * `text` as parts of at most `limit` characters, each ending at a line boundary where the text has one. The newline a part ends at is
 * the separator and is not repeated at the head of the next part; a line longer than `limit` is cut at the limit.
 */
export function splitText(text: string, limit: number = TELEGRAM_MAX_MESSAGE): string[] {
  const parts = [];
  let rest = text;
  while (rest !== "") {
    const taken = takeOne(rest, limit);
    parts.push(taken.part);
    rest = taken.rest;
  }
  return parts;
}

/** Returns the JSON body, or `{}` when there is none to read */
async function readBody(response: Response | Record<string, any>): Promise<Record<string, any>> {
  try {
    const body = await response.json();
    return body !== null && typeof body === "object" ? body : {};
  } catch {
    // Telegram's own failures are JSON; a proxy's error page is not, and the status alone then says what happened.
    return {};
  }
}

function retryAfterOf(body: Record<string, any>, response: Response | Record<string, any>): number | undefined {
  const fromBody = Number(body.parameters?.retry_after);
  if (Number.isFinite(fromBody) && fromBody >= 0) return fromBody;
  const fromHeader = Number(response.headers?.get?.("retry-after"));
  return Number.isFinite(fromHeader) && fromHeader >= 0 ? fromHeader : undefined;
}

function isNotModified(error: unknown): boolean {
  return error instanceof TelegramSendError && error.status === BAD_REQUEST && NOT_MODIFIED.test(error.message);
}

/** Returns the id a `messageRef` names, or refuses it before any request is made */
function messageIdOf(messageRef: string): number {
  const messageId = /^\d+$/.test(messageRef) ? Number(messageRef) : NaN;
  if (!Number.isSafeInteger(messageId) || messageId === 0) throw new TypeError(`telegram: ${JSON.stringify(messageRef)} is not a message id`);
  return messageId;
}

/** Returns the audience, `ask` when absent; an unknown one is refused */
function knownAudience(audience: string | undefined): string {
  const named = audience ?? AUDIENCE.ask;
  if (!AUDIENCES.includes(named)) throw new RangeError(`telegram: audience ${JSON.stringify(named)} is not one of ${AUDIENCES.join(", ")}`);
  return named;
}

/** `deadline` is the request's clock, injected like `sleep` */
export function createTelegramProvider({ token, chatId, announcementsChatId, fetch: fetchImpl = globalThis.fetch, sleep = defaultSleep, log = defaultLog, apiBase = TELEGRAM_API, deadline = AbortSignal.timeout }: {
        token: import("../../secret.ts").Secret; chatId: number | string; announcementsChatId?: number | string; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>;
        log?: (line: string) => void; apiBase?: string; deadline?: (ms: number) => AbortSignal;
    }) {
  if (typeof token?.reveal !== "function") throw new TypeError("createTelegramProvider: token must be a Secret (createSecret / readSecretFile)");
  if (chatId === undefined || chatId === null || chatId === "") throw new TypeError("createTelegramProvider: chatId is required");
  if (announcementsChatId === null || announcementsChatId === "") throw new TypeError("createTelegramProvider: announcementsChatId, when given, must be a chat id");
  const chatFor: Record<string, number | string> = { [AUDIENCE.ask]: chatId, [AUDIENCE.announcement]: announcementsChatId ?? chatId };
  const destinations = new Set(Object.values(chatFor).map(String)).size;
  const hasChannel = destinations === AUDIENCES.length;
  const guardedFetch = redactingFetch(fetchImpl, token);
  // Every string that reaches `log` is either a number-only line or a `TelegramSendError` message, scrubbed where it is built (`attempt`).
  const note = log;

  /**
   * One HTTP attempt.
   * `method`: the Bot API method
   */
  async function attempt(method: string, payload: Record<string, unknown>): Promise<{ ok: true; result: Record<string, any>; } | { ok: false; error: TelegramSendError; }> {
    let response;
    try {
      response = await guardedFetch(`${apiBase}/bot${token.reveal()}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: deadline(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // A request that never got an answer is a send failure like any other, so it is logged (`refused`) and annotated (`partial`).
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, error: new TelegramSendError(token.scrub(`telegram ${method} failed: no response: ${reason}`)) };
    }
    const body = await readBody(response);
    if (response.ok && body.ok === true) return { ok: true, result: body.result ?? {} };
    const status = Number(body.error_code ?? response.status);
    const description = typeof body.description === "string" ? body.description : "no description";
    const error = new TelegramSendError(token.scrub(`telegram ${method} failed: ${status} ${description}`), { status, retryAfter: retryAfterOf(body, response) });
    return { ok: false, error };
  }

  /**
   * One call, retried ONCE and only when Telegram says 429 and says when.
   * Returns Telegram's `result`
   */
  async function callOnce(method: string, payload: Record<string, unknown>): Promise<Record<string, any>> {
    const first = await attempt(method, payload);
    if (first.ok) return first.result;
    // Not a failure, so not logged as one: an edit that changes nothing is routine, and a "refused by Telegram" line for it would be a lie.
    if (isNotModified(first.error)) throw first.error;
    const { status, retryAfter } = first.error;
    if (status !== TOO_MANY_REQUESTS || retryAfter === undefined || retryAfter > MAX_RETRY_WAIT_SECONDS) throw refused(first.error, { retried: false });
    note(`telegram: 429, waiting ${retryAfter}s as Telegram asked, then sending once more`);
    await sleep(retryAfter * MS_PER_SECOND);
    const second = await attempt(method, payload);
    if (second.ok) return second.result;
    throw refused(second.error, { retried: true });
  }

  /**
   * One part of a message.
   * Returns the messageRef
   */
  async function sendPart(payload: Record<string, unknown>): Promise<string> {
    const result = await callOnce("sendMessage", payload);
    if (!Number.isSafeInteger(result.message_id)) throw refused(new TelegramSendError("telegram sendMessage failed: no message_id in the reply"), { retried: false });
    return String(result.message_id);
  }

  /** Takes the keyboard off a message; one that has none is already what was asked for */
  async function clearKeyboard(messageRef: string): Promise<void> {
    const messageId = messageIdOf(messageRef);
    try {
      await callOnce("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
    } catch (error) {
      if (!isNotModified(error)) throw error;
    }
  }

  /**
   * Rewrites a sent message's text in place, in plain text like `send`. An edit carries no `reply_markup`, so Telegram takes the message's
   * keyboard off with it: a resolved ask has nothing left to press.
   * Returns the same `messageRef`, and whether Telegram said the text was already that
   */
  async function edit({ messageRef, text, audience }: { messageRef: string; text: string; audience?: string; }): Promise<{ messageRef: string; unchanged: boolean; }> {
    const chat = chatFor[knownAudience(audience)];
    const messageId = messageIdOf(messageRef);
    if (typeof text !== "string" || text === "") throw new RangeError("telegram: text is empty");
    if (text.length > TELEGRAM_MAX_MESSAGE) throw new RangeError(`telegram: an edit is one message and ${text.length} characters exceeds ${TELEGRAM_MAX_MESSAGE}`);
    try {
      await callOnce("editMessageText", { chat_id: chat, message_id: messageId, text });
      return { messageRef, unchanged: false };
    } catch (error) {
      if (isNotModified(error)) return { messageRef, unchanged: true };
      throw error;
    }
  }

  /** Pins a message without notifying anybody. Returns the same `messageRef` */
  async function pin({ messageRef, audience }: { messageRef: string; audience?: string; }): Promise<{ messageRef: string; }> {
    const chat = chatFor[knownAudience(audience)];
    await callOnce("pinChatMessage", { chat_id: chat, message_id: messageIdOf(messageRef), disable_notification: true });
    return { messageRef };
  }

  /** Logs a failure, with whether the one retry was spent, and hands the error back to throw. */
  function refused(error: TelegramSendError, { retried }: { retried: boolean; }) {
    const status = error.status ?? 0;
    const kind = status >= CLIENT_ERROR_FLOOR && status < SERVER_ERROR_FLOOR ? "refused by Telegram" : "failed";
    note(`telegram: ${kind}, ${retried ? "still failing after the one retry" : "not retried"}: ${error.message}`);
    return error;
  }

  return {
    id: "telegram",
    capabilities: Object.freeze({
      silent: true, buttons: true, replies: true, conversation: false, edit: true, pin: true,
      maxText: TELEGRAM_MAX_MESSAGE * MAX_PARTS, ratePerSecond: 1, destinations,
    }),
    clearKeyboard,
    edit,
    pin,
    async send(message: { text: string; silent?: boolean; actions?: unknown[]; replyTo?: string; audience?: string; }): Promise<{ messageRef: string; silent: boolean; messageRefs: string[]; audience: string; }> {
      const parts = partsOf(message?.text);
      const audience = audienceOf(message, { hasChannel });
      const keyboard = keyboardOf(message.actions);
      const silent = message.silent === true;
      const chat = chatFor[audience];
      const messageRefs: string[] = [];
      for (const [index, part] of parts.entries()) {
        if (index > 0) await sleep(PART_SPACING_MS);
        try {
          messageRefs.push(await sendPart(payloadFor({ chatId: chat, text: part, silent, replyTo: index === 0 ? message.replyTo : undefined, keyboard: index === 0 ? keyboard : undefined })));
        } catch (error) {
          throw partial(error, { index, total: parts.length });
        }
      }
      return { messageRef: messageRefs[0], silent, messageRefs, audience };
    },
  };
}

/**
 * Returns where the message is for. An absent audience is `ask`, the only destination there was; an unknown one is refused, and so is an
 * announcement that asks for an answer, before any part is sent.
 */
function audienceOf(message: { audience?: string; actions?: unknown[]; replyTo?: string; }, { hasChannel }: { hasChannel: boolean; }): string {
  const audience = knownAudience(message.audience);
  if (audience !== AUDIENCE.announcement) return audience;
  if ((message.actions?.length ?? 0) > 0) throw new RangeError("telegram: an announcement is one-way and carries no actions (a message that needs an answer is an ask)");
  if (hasChannel && message.replyTo !== undefined) throw new RangeError("telegram: an announcement in the channel is one-way and carries no replyTo");
  return audience;
}

/** Returns the parts, or a refusal: a provider rejects what it cannot deliver whole rather than cutting it silently */
function partsOf(text: unknown): string[] {
  if (typeof text !== "string" || text === "") throw new RangeError("telegram: text is empty");
  const limit = TELEGRAM_MAX_MESSAGE * MAX_PARTS;
  if (text.length > limit) throw new RangeError(`telegram: ${text.length} characters exceeds maxText ${limit}`);
  const parts = splitText(text);
  if (parts.length > MAX_PARTS) throw new RangeError(`telegram: the text needs ${parts.length} messages, over the ${MAX_PARTS} one send may become`);
  return parts;
}

/**
 * `actions` as Telegram's inline keyboard, one button per row, or `undefined` for none: a message with no action carries no `reply_markup`.
 * A malformed action is refused whole, before any part is sent: a keyboard missing the button the chairman meant to press is a quieter wrong than none.
 */
function keyboardOf(actions: unknown): { text: string; callback_data: string; }[][] | undefined {
  if (actions === undefined || (Array.isArray(actions) && actions.length === 0)) return undefined;
  if (!Array.isArray(actions) || actions.length > MAX_BUTTONS) throw new RangeError(`telegram: actions must be a list of at most ${MAX_BUTTONS}`);
  return actions.map((action) => {
    const { label, data } = action ?? {};
    if (typeof label !== "string" || label === "" || label.length > MAX_BUTTON_LABEL) throw new RangeError(`telegram: an action needs a label of 1-${MAX_BUTTON_LABEL} characters`);
    if (typeof data !== "string" || data === "" || Buffer.byteLength(data, "utf8") > MAX_CALLBACK_DATA_BYTES) throw new RangeError(`telegram: an action needs data of 1-${MAX_CALLBACK_DATA_BYTES} bytes`);
    return [{ text: label, callback_data: data }];
  });
}

/** Returns: `disable_notification` is present ONLY when silent: an ordinary message carries no such key; `reply_markup` ONLY with a keyboard */
function payloadFor({ chatId, text, silent, replyTo, keyboard }: { chatId: number | string; text: string; silent: boolean; replyTo?: string; keyboard?: { text: string; callback_data: string; }[][]; }): Record<string, unknown> {
  const payload = { chat_id: chatId, text };
  if (silent) Object.assign(payload, { disable_notification: true });
  if (keyboard !== undefined) Object.assign(payload, { reply_markup: { inline_keyboard: keyboard } });
  if (replyTo !== undefined && Number.isSafeInteger(Number(replyTo))) {
    Object.assign(payload, { reply_parameters: { message_id: Number(replyTo), allow_sending_without_reply: true } });
  }
  return payload;
}

/**
 * Says how much of a split message was already delivered when a later part failed: the core retries a failed send whole, so the
 * chairman may see the earlier parts twice, and an error that does not say so hides the cause of the duplicate.
 */
function partial(error: unknown, { index, total }: { index: number; total: number; }): unknown {
  if (index === 0 || !(error instanceof TelegramSendError)) return error;
  const wrapped = new TelegramSendError(`${error.message} (part ${index + 1} of ${total}; the ${index} before it WERE delivered)`, { status: error.status, retryAfter: error.retryAfter });
  return wrapped;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function defaultLog(line: string) {
  console.error(line);
}
