// @ts-check
// THE TELEGRAM PROVIDER, SEND ONLY (a11ign/a11ign#2902; docs/messaging.md decision 1). It passes `runProviderConformance`, so it is a
// provider by the only definition there is. `poll` is the polling provider's (./poll.mjs).
//
// **BUTTONS ARE DRAWN HERE (a11ign/a11ign#3423).** `actions` become `reply_markup.inline_keyboard`, one button per row, on the FIRST part of a split
// message only: the first part's id is the `messageRef` the ledger keeps, and a press is routed by the message it sits under. The provider draws
// what it is handed and decides nothing about which presses mean what; the closed vocabulary is `inbound.mjs`'s, where a press is received.
//
// **PLAIN TEXT, NO `parse_mode`.** A message body is quoted from a row title or a comment, which anybody may have written. Under
// Markdown or HTML a stray `_` or `<` makes Telegram refuse the whole message (a corrupted alert), and a crafted one injects markup
// into what the chairman reads. With no `parse_mode` there is nothing to escape, so there is no escaping defect to have.
//
// **THE SPLIT IS THE PROVIDER'S, AND `maxText` SAYS HOW FAR IT GOES.** Telegram refuses over 4,096 characters, and the contract has
// `send` refuse anything over `maxText`. Declaring `maxText` as a few whole messages' worth lets the core's shortening still bound a
// runaway body while this module cuts what it is given into messages Telegram will take, on a line boundary where one exists.
//
// **THE TOKEN IS IN THE URL (`/bot<token>/`), SO EVERY `fetch` GOES THROUGH `redactingFetch`** and every line this module logs or
// throws is scrubbed again by the secret's own value. A failure the HTTP layer reports is described by its status and Telegram's own
// `description`, which is Telegram's text and not the request's.

import { redactingFetch } from "../../secret.mjs";

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
/** What Telegram answers when the markup it is asked to remove is already gone: the keyboard is off, which is what was wanted. */
const NOT_MODIFIED = /message is not modified/i;

export class TelegramSendError extends Error {
  /** @param {string} message already scrubbed @param {{ status?: number, retryAfter?: number }} [details] */
  constructor(message, { status, retryAfter } = {}) {
    super(message);
    this.name = "TelegramSendError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** @param {string} text @param {number} end @returns {number} `end`, moved back by one when it would cut a surrogate pair in half */
function whole(text, end) {
  const code = text.charCodeAt(end - 1);
  const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
  return isHighSurrogate && end > 1 ? end - 1 : end;
}

/** @param {string} text @param {number} limit @returns {{ part: string, rest: string }} the first part, and what is left to send */
function takeOne(text, limit) {
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
 * @param {string} text @param {number} [limit] @returns {string[]}
 */
export function splitText(text, limit = TELEGRAM_MAX_MESSAGE) {
  const parts = [];
  let rest = text;
  while (rest !== "") {
    const taken = takeOne(rest, limit);
    parts.push(taken.part);
    rest = taken.rest;
  }
  return parts;
}

/** @param {Response | Record<string, any>} response @returns {Promise<Record<string, any>>} the JSON body, or `{}` when there is none to read */
async function readBody(response) {
  try {
    const body = await response.json();
    return body !== null && typeof body === "object" ? body : {};
  } catch {
    // Telegram's own failures are JSON; a proxy's error page is not, and the status alone then says what happened.
    return {};
  }
}

/** @param {Record<string, any>} body @param {Response | Record<string, any>} response @returns {number | undefined} */
function retryAfterOf(body, response) {
  const fromBody = Number(body.parameters?.retry_after);
  if (Number.isFinite(fromBody) && fromBody >= 0) return fromBody;
  const fromHeader = Number(response.headers?.get?.("retry-after"));
  return Number.isFinite(fromHeader) && fromHeader >= 0 ? fromHeader : undefined;
}

/**
 * @param {{ token: import("../../secret.mjs").Secret, chatId: number | string, fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>,
 *   log?: (line: string) => void, apiBase?: string, deadline?: (ms: number) => AbortSignal }} options `deadline` is the request's clock, injected like `sleep`
 */
export function createTelegramProvider({ token, chatId, fetch: fetchImpl = globalThis.fetch, sleep = defaultSleep, log = defaultLog, apiBase = TELEGRAM_API, deadline = AbortSignal.timeout }) {
  if (typeof token?.reveal !== "function") throw new TypeError("createTelegramProvider: token must be a Secret (createSecret / readSecretFile)");
  if (chatId === undefined || chatId === null || chatId === "") throw new TypeError("createTelegramProvider: chatId is required");
  const guardedFetch = redactingFetch(fetchImpl, token);
  // Every string that reaches `log` is either a number-only line or a `TelegramSendError` message, scrubbed where it is built (`attempt`).
  const note = log;

  /** One HTTP attempt. @param {string} method the Bot API method @param {Record<string, unknown>} payload @returns {Promise<{ ok: true, result: Record<string, any> } | { ok: false, error: TelegramSendError }>} */
  async function attempt(method, payload) {
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

  /** One call, retried ONCE and only when Telegram says 429 and says when. @param {string} method @param {Record<string, unknown>} payload @returns {Promise<Record<string, any>>} Telegram's `result` */
  async function callOnce(method, payload) {
    const first = await attempt(method, payload);
    if (first.ok) return first.result;
    const { status, retryAfter } = first.error;
    if (status !== TOO_MANY_REQUESTS || retryAfter === undefined || retryAfter > MAX_RETRY_WAIT_SECONDS) throw refused(first.error, { retried: false });
    note(`telegram: 429, waiting ${retryAfter}s as Telegram asked, then sending once more`);
    await sleep(retryAfter * MS_PER_SECOND);
    const second = await attempt(method, payload);
    if (second.ok) return second.result;
    throw refused(second.error, { retried: true });
  }

  /** One part of a message. @param {Record<string, unknown>} payload @returns {Promise<string>} the messageRef */
  async function sendPart(payload) {
    const result = await callOnce("sendMessage", payload);
    if (!Number.isSafeInteger(result.message_id)) throw refused(new TelegramSendError("telegram sendMessage failed: no message_id in the reply"), { retried: false });
    return String(result.message_id);
  }

  /** @param {string} messageRef @returns {Promise<void>} takes the keyboard off a message; one that has none is already what was asked for */
  async function clearKeyboard(messageRef) {
    const messageId = /^\d+$/.test(messageRef) ? Number(messageRef) : NaN;
    if (!Number.isSafeInteger(messageId) || messageId === 0) throw new TypeError(`telegram: ${JSON.stringify(messageRef)} is not a message id`);
    try {
      await callOnce("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
    } catch (error) {
      if (!(error instanceof TelegramSendError && error.status === BAD_REQUEST && NOT_MODIFIED.test(error.message))) throw error;
    }
  }

  /** Logs a failure, with whether the one retry was spent, and hands the error back to throw. @param {TelegramSendError} error @param {{ retried: boolean }} spent */
  function refused(error, { retried }) {
    const status = error.status ?? 0;
    const kind = status >= CLIENT_ERROR_FLOOR && status < SERVER_ERROR_FLOOR ? "refused by Telegram" : "failed";
    note(`telegram: ${kind}, ${retried ? "still failing after the one retry" : "not retried"}: ${error.message}`);
    return error;
  }

  return {
    id: "telegram",
    capabilities: Object.freeze({
      silent: true, buttons: true, replies: true, conversation: false,
      maxText: TELEGRAM_MAX_MESSAGE * MAX_PARTS, ratePerSecond: 1,
    }),
    clearKeyboard,
    /** @param {{ text: string, silent?: boolean, actions?: unknown[], replyTo?: string }} message @returns {Promise<{ messageRef: string, silent: boolean, messageRefs: string[] }>} */
    async send(message) {
      const parts = partsOf(message?.text);
      const keyboard = keyboardOf(message.actions);
      const silent = message.silent === true;
      /** @type {string[]} */
      const messageRefs = [];
      for (const [index, part] of parts.entries()) {
        if (index > 0) await sleep(PART_SPACING_MS);
        try {
          messageRefs.push(await sendPart(payloadFor({ chatId, text: part, silent, replyTo: index === 0 ? message.replyTo : undefined, keyboard: index === 0 ? keyboard : undefined })));
        } catch (error) {
          throw partial(error, { index, total: parts.length });
        }
      }
      return { messageRef: messageRefs[0], silent, messageRefs };
    },
  };
}

/** @param {unknown} text @returns {string[]} the parts, or a refusal: a provider rejects what it cannot deliver whole rather than cutting it silently */
function partsOf(text) {
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
 *
 * @param {unknown} actions @returns {{ text: string, callback_data: string }[][] | undefined}
 */
function keyboardOf(actions) {
  if (actions === undefined || (Array.isArray(actions) && actions.length === 0)) return undefined;
  if (!Array.isArray(actions) || actions.length > MAX_BUTTONS) throw new RangeError(`telegram: actions must be a list of at most ${MAX_BUTTONS}`);
  return actions.map((action) => {
    const { label, data } = action ?? {};
    if (typeof label !== "string" || label === "" || label.length > MAX_BUTTON_LABEL) throw new RangeError(`telegram: an action needs a label of 1-${MAX_BUTTON_LABEL} characters`);
    if (typeof data !== "string" || data === "" || Buffer.byteLength(data, "utf8") > MAX_CALLBACK_DATA_BYTES) throw new RangeError(`telegram: an action needs data of 1-${MAX_CALLBACK_DATA_BYTES} bytes`);
    return [{ text: label, callback_data: data }];
  });
}

/**
 * @param {{ chatId: number | string, text: string, silent: boolean, replyTo?: string, keyboard?: { text: string, callback_data: string }[][] }} fields
 * @returns {Record<string, unknown>} `disable_notification` is present ONLY when silent: an ordinary message carries no such key; `reply_markup` ONLY with a keyboard
 */
function payloadFor({ chatId, text, silent, replyTo, keyboard }) {
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
 * @param {unknown} error @param {{ index: number, total: number }} where @returns {unknown}
 */
function partial(error, { index, total }) {
  if (index === 0 || !(error instanceof TelegramSendError)) return error;
  const wrapped = new TelegramSendError(`${error.message} (part ${index + 1} of ${total}; the ${index} before it WERE delivered)`, { status: error.status, retryAfter: error.retryAfter });
  return wrapped;
}

/** @param {number} ms @returns {Promise<void>} */
function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** @param {string} line */
function defaultLog(line) {
  console.error(line);
}
