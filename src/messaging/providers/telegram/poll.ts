// THE TELEGRAM PROVIDER'S LONG POLL AND THE LOOP THAT RUNS IT (a11ign/a11ign#2907; docs/messaging.md decision 1, "Long polling"). The
// provider of send.ts plus `poll`, so it is a provider by the same single definition (`runProviderConformance`, now with its `poll`
// section RUN because `capabilities.conversation` is declared). **No inbound port: the listener asks Telegram, Telegram never calls it.**
//
// THE ORDER OF ONE BATCH, AND WHY EACH STEP SITS WHERE IT DOES:
//   1. `getUpdates(offset)` -- long poll, `message` and `callback_query` for the chairman, and `my_chat_member` and `channel_post` so the
//      listener learns the id of a channel the bot is added to. THE LISTENER IS THE ONLY CALLER THAT CAN: a second `getUpdates` caller is a
//      409. Those two are RECORDED by the core (`noted`) and never acted on, and a `noted` is never a chat to leave;
//   2. every update goes through `inbound.handle`, which writes ITS LEDGER LINE before it answers, so a crash after that point loses one
//      message and never repeats one (the core's rule, inbound.ts);
//   3. THE OFFSET IS PERSISTED AFTER THE BATCH, never before: a crash between 2 and 3 re-asks for the same updates, and the core's
//      dedupe by update id turns that replay into `replayed`, which does nothing. The offset is the optimisation and the ledger is the memory.
//
// **EVERY BUTTON PRESS IS ANSWERED, WHOEVER PRESSED IT AND WHATEVER BECAME OF IT** (`answerCallbackQuery`): an unanswered one leaves the
// button spinning on the chairman's phone, and a dropped one leaves a stranger's spinning, which tells them it was received. The answer
// goes FIRST and carries no text, so what the handler does next can fail without leaving a button stuck.
//
// **A 409 IS FATAL, NOT RETRYABLE.** Two pollers on one bot each steal the other's updates; retrying makes the listener one of them
// forever. It is thrown as `PollConflictError` and the listener exits naming what it may be.
//
// **THE TOKEN IS IN THE URL**, so every request goes through `redactingFetch` and every message here is scrubbed by the token's own value.

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import { redactingFetch } from "../../secret.ts";
import { createTelegramProvider, TELEGRAM_API } from "./send.ts";

/** How long Telegram holds one `getUpdates` open when nothing arrives. */
export const LONG_POLL_SECONDS = 50;
/** A request that outlives the long poll by more than this has lost its connection, and is abandoned rather than awaited forever. */
const REQUEST_SLACK_MS = 10_000;
const MS_PER_SECOND = 1000;
export const BACKOFF_INITIAL_MS = 1000;
/** The ceiling a run of failures backs off to: a listener whose network is down should come back within a minute of it returning. */
export const BACKOFF_CEILING_MS = 60_000;
const CONFLICT = 409;
const OFFSET_FILE_MODE = 0o600;
const OFFSET_DIRECTORY_MODE = 0o700;
const GROUP_CHAT_TYPES = new Set(["group", "supergroup", "channel"]);
/** `my_chat_member` and `channel_post` are for `chat-seen` (a11ign/a11ign#4743): inbound.ts records them and acts on neither. */
export const ALLOWED_UPDATES = Object.freeze(["message", "callback_query", "my_chat_member", "channel_post"]);

export class TelegramApiError extends Error {
  declare status?: number;
  /** `message` is already scrubbed. */
  constructor(message: string, { status }: { status?: number; } = {}) {
    super(message);
    this.name = "TelegramApiError";
    this.status = status;
  }
}

/** Telegram answered 409: somebody else is polling this bot (or a webhook is set on it). The listener refuses to run and says so. */
export class PollConflictError extends TelegramApiError {
  /** `message`: already scrubbed */
  constructor(message: string) {
    super(message, { status: CONFLICT });
    this.name = "PollConflictError";
  }
}

/** Returns the offset that confirms everything seen: the last id plus one, never lower than before */
export function nextCursor(updates: unknown[], cursor: number | undefined): number | undefined {
  const ids = updates.map((update) => (update as { update_id?: unknown } | null | undefined)?.update_id).filter(Number.isSafeInteger) as number[];
  return ids.length === 0 ? cursor : Math.max(cursor ?? 0, ...ids.map((id) => id + 1));
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

/** Returns what to do about a 409, which is the one failure with a remedy the operator owns */
function conflictMessage(status: number, description: string): string {
  return `telegram answered ${status} Conflict (${description}): another process is polling this bot, or a webhook is set on it. `
    + "Stop the other poller (a second `messaging:listen`, a `messaging:pair` still running, or another host using this token) and start this one again.";
}

/** One Telegram Bot API method, as a function. Every failure is scrubbed of the token and carries the status. */
function callerFor({ token, fetch: fetchImpl, apiBase }: { token: import("../../secret.ts").Secret; fetch: typeof fetch; apiBase: string; }): (method: string, payload: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number; }) => Promise<any> {
  const guarded = redactingFetch(fetchImpl, token);
  return async (method, payload, { signal, timeoutMs = REQUEST_SLACK_MS } = {}) => {
    const limit = AbortSignal.timeout(timeoutMs);
    const response = await guarded(`${apiBase}/bot${token.reveal()}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      signal: signal === undefined ? limit : AbortSignal.any([signal, limit]),
    });
    const body = await readBody(response);
    if (response.ok && body.ok === true) return body.result;
    const status = Number(body.error_code ?? response.status);
    const description = typeof body.description === "string" ? body.description : "no description";
    if (status === CONFLICT) throw new PollConflictError(token.scrub(conflictMessage(status, description)));
    throw new TelegramApiError(token.scrub(`telegram ${method} failed: ${status} ${description}`), { status });
  };
}

/**
 * The send-only provider plus the inbound half: `poll(cursor, signal)` per docs/messaging.md, and the four calls the listener makes in
 * answer to what `inbound.handle` says to do. `chatId` is the chairman's, which `send` speaks to.
 */
export function createTelegramPollingProvider(options: {
        token: import("../../secret.ts").Secret; chatId: number | string; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>;
        log?: (line: string) => void; apiBase?: string; listenSeconds?: number;
    }) {
  const { token, fetch: fetchImpl = globalThis.fetch, apiBase = TELEGRAM_API, listenSeconds = LONG_POLL_SECONDS } = options;
  const sender = createTelegramProvider(options);
  const call = callerFor({ token, fetch: fetchImpl, apiBase });
  return {
    ...sender,
    capabilities: Object.freeze({ ...sender.capabilities, conversation: true }),
    /**
     * `cursor`: the offset to ask from; undefined asks for whatever Telegram still holds
     * `signal`: aborted, the call returns at once with nothing: the listener's shutdown does not wait out a long poll
     */
    async poll(cursor: number | undefined, signal?: AbortSignal): Promise<{ updates: any[]; cursor: number | undefined; }> {
      if (signal?.aborted) return { updates: [], cursor };
      const payload = { timeout: listenSeconds, allowed_updates: ALLOWED_UPDATES, ...(cursor === undefined ? {} : { offset: cursor }) };
      try {
        const updates = await call("getUpdates", payload, { signal, timeoutMs: listenSeconds * MS_PER_SECOND + REQUEST_SLACK_MS });
        return { updates: Array.isArray(updates) ? updates : [], cursor: nextCursor(Array.isArray(updates) ? updates : [], cursor) };
      } catch (error) {
        // An abort rejects the fetch; that is the shutdown working, and not a failure to back off from.
        if (signal?.aborted) return { updates: [], cursor };
        throw error;
      }
    },
    /** Stops the spinner; no text, so a stranger learns nothing from it */
    async answerCallbackQuery(callbackQueryId: string): Promise<void> {
      await call("answerCallbackQuery", { callback_query_id: callbackQueryId });
    },
    async leaveChat(chatId: number): Promise<void> {
      await call("leaveChat", { chat_id: chatId });
    },
    async deleteMessage({ chatId, messageId }: { chatId: number; messageId: number | null; }): Promise<void> {
      if (messageId === null) throw new TypeError("deleteMessage: the update named no message id to delete");
      await call("deleteMessage", { chat_id: chatId, message_id: messageId });
    },
  };
}

/**
 * Where the offset is kept, so a restart asks from it. A corrupt or unreadable file is "no offset": the ledger's dedupe makes asking from
 * the beginning of what Telegram still holds safe, and a listener that refuses to start over a bad cache is worse than one that replays.
 */
export function createOffsetStore(path: string, { log = () => {} }: { log?: (line: string) => void; } = {}): { path: string; read: () => number | undefined; write: (offset: number) => void; } {
  return {
    path,
    read() {
      let stored: unknown;
      try {
        stored = JSON.parse(readFileSync(path, "utf8")).offset;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") log(`offset file ${path} is unreadable (${(error as Error).message}); asking from the start`);
        return undefined;
      }
      if (Number.isSafeInteger(stored) && (stored as number) >= 0) return stored as number;
      log(`offset file ${path} does not hold an offset; asking from the start`);
      return undefined;
    },
    write(offset) {
      mkdirSync(dirname(path), { recursive: true, mode: OFFSET_DIRECTORY_MODE });
      // Created 0600 under a temporary name and renamed into place: a crash leaves the old file or the whole new one, never half of one.
      const temporary = `${path}.${process.pid}.tmp`;
      const descriptor = openSync(temporary, "w", OFFSET_FILE_MODE);
      try {
        writeSync(descriptor, `${JSON.stringify({ offset })}\n`);
      } catch (error) {
        closeSync(descriptor);
        unlinkSync(temporary);
        throw error;
      }
      closeSync(descriptor);
      renameSync(temporary, path);
    },
  };
}

export type PollingProvider = ReturnType<typeof createTelegramPollingProvider>;

/** Answers the update's button press, if it carries one */
function answererFor({ provider, log }: { provider: PollingProvider; chairman: { userId: number; chatId: number; }; log: (line: string) => void; }): (update: any) => Promise<void> {
  return async (update) => {
    const id = update?.callback_query?.id;
    if (typeof id !== "string") return;
    await provider.answerCallbackQuery(id).catch((error: Error) => log(`answerCallbackQuery failed: ${error.message}`));
  };
}

/** Returns the chat to leave: a group, supergroup or channel that is not the chairman's */
function chatToLeave(action: import("../../inbound.ts").Handled, chairmanChatId: number): number | null {
  if (action.action !== "ignore" || action.chatId === null || action.chatId === chairmanChatId) return null;
  return action.chatType !== null && GROUP_CHAT_TYPES.has(action.chatType) ? action.chatId : null;
}

/**
 * What the core said to do, done. A failure of one step is logged and does not stop the next: a secret that could not be deleted still
 * gets its reply, and one update's failure never keeps the offset from moving past it.
 */
function performerFor({ provider, chairman, onForward, log }: {
        provider: PollingProvider; chairman: { userId: number; chatId: number; }; onForward: (accepted: Readonly<Record<string, any>>) => Promise<void> | void;
        log: (line: string) => void;
    }): (action: import("../../inbound.ts").Handled) => Promise<void> {
  const attempt = async (what: string, step: () => Promise<unknown> | unknown) => {
    try {
      await step();
    } catch (error) {
      log(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return async (action) => {
    const leaving = chatToLeave(action, chairman.chatId);
    if (leaving !== null) await attempt(`leaveChat ${leaving}`, () => provider.leaveChat(leaving));
    if (action.action === "reply") {
      // The deletion first: the longer a credential sits in the chat, the longer it is there.
      const doomed = action.deleteMessage; // a local, so the null check still holds inside the closure
      if (doomed !== null) await attempt("deleteMessage", () => provider.deleteMessage(doomed));
      await attempt("reply", () => provider.send({ text: action.text }));
    }
    if (action.action === "forward") await attempt("forward", () => onForward(action.accepted));
  };
}

/** One batch: every update through the core, its button answered, what the core said done. THE OFFSET IS NOT TOUCHED HERE. */
async function handleBatch(updates: any[], { inbound, answer, perform }: {
        inbound: { handle: (update: unknown) => import("../../inbound.ts").Handled; }; answer: (update: any) => Promise<void>;
        perform: (action: import("../../inbound.ts").Handled) => Promise<void>;
    }) {
  for (const update of updates) {
    await answer(update);
    await perform(inbound.handle(update));
  }
}

/**
 * The next wait after a failure: 1, 2, 4 ... seconds up to the ceiling. PURE.
 * `previousMs`: the last wait, or null when the last call succeeded
 */
export function nextBackoff(previousMs: number | null): number {
  return previousMs === null ? BACKOFF_INITIAL_MS : Math.min(previousMs * 2, BACKOFF_CEILING_MS);
}

/**
 * THE LISTENER'S LOOP. Returns when `signal` aborts; throws `PollConflictError` on a 409 and whatever the ledger or offset file throws
 * that cannot be retried past. Every other failure of a poll is waited out on `sleep` (the injected clock) and retried.
 */
export async function runListener({ provider, inbound, offsets, chairman, onForward = () => {}, sleep, signal, log = () => {} }: {
        provider: PollingProvider; inbound: { handle: (update: unknown) => import("../../inbound.ts").Handled; };
        offsets: ReturnType<typeof createOffsetStore>; chairman: { userId: number; chatId: number; };
        onForward?: (accepted: Readonly<Record<string, any>>) => Promise<void> | void; sleep: (ms: number) => Promise<void>;
        signal?: AbortSignal; log?: (line: string) => void;
    }): Promise<void> {
  const parts = {
    inbound, answer: answererFor({ provider, chairman, log }), perform: performerFor({ provider, chairman, onForward, log }),
  };
  let cursor = offsets.read();
  let waited: number | null = null;
  while (signal?.aborted !== true) {
    try {
      const batch = await provider.poll(cursor, signal);
      await handleBatch(batch.updates, parts);
      if (batch.cursor !== undefined && batch.cursor !== cursor) offsets.write(batch.cursor);
      cursor = batch.cursor;
      // Success is a batch HANDLED and its offset kept, not merely a poll answered: a ledger that cannot be written must keep backing off.
      waited = null;
    } catch (error) {
      if (error instanceof PollConflictError) throw error;
      waited = nextBackoff(waited);
      log(`poll failed (${error instanceof Error ? error.message : String(error)}); retrying in ${waited / MS_PER_SECOND}s`);
      await sleep(waited);
    }
  }
}
