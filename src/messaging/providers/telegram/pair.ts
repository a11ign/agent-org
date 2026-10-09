// `messaging:pair` (a11ign/a11ign#2902; docs/messaging.md decision 1, "Secret by reference only"): THE ONLY WAY THE CHAIRMAN'S IDS GET
// INTO THE CHAIRMAN FILE. The chairman's Telegram user id and chat id are not secrets but are personal data, and this repository is
// public, so nobody types them anywhere: the host prints a ONE-TIME CODE in the chairman's own shell, the chairman sends `/pair <code>`
// to the bot, and the bot records the first sender that proves it.
//
// **THE CODE IS SINGLE USE AND SHORT-LIVED, AND THE CHECKS RUN IN AN ORDER THAT SAYS LEAST TO A STRANGER.** A message that is not a
// private-chat `/pair` is ignored outright; an expired or used-up session refuses before the code is compared, so what a late guess
// learns is "expired", never "close". The code is compared in constant time.
//
// **A REFUSAL NAMES ITS REASON AND NEVER QUOTES THE SENDER'S TEXT.** The reason goes to the chairman's shell (`print`), where it is
// useful; the bot says nothing back to a stranger, so it is not an oracle for a guess. Nothing is written on a refusal.
//
// **THE FILE IS WRITTEN 0600 AT CREATION, THEN MOVED INTO PLACE.** `open(..., 0o600)` on a temporary name and a `rename`, so no
// moment exists at which the ids sit in a file another user can read, and a crash leaves either the old file or the whole new one.

import { randomInt, timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { MessagingConfigRefusal, readMessagingConfig } from "../../config.ts";
import { readSecretFile, redactingFetch } from "../../secret.ts";
import type { Secret } from "../../secret.ts";
import { TELEGRAM_API } from "./send.ts";

export const PAIRING_TTL_MS = 10 * 60 * 1000;
const CODE_LENGTH = 10;
/** No `0 O 1 I L`: a code is read off a terminal and typed on a phone. 31 symbols over 10 places is about 49 bits. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const LONG_POLL_SECONDS = 25;
const EMPTY_BATCH_PAUSE_MS = 1000;
const MS_PER_SECOND = 1000;
const CHAIRMAN_FILE_MODE = 0o600;
const CHAIRMAN_DIRECTORY_MODE = 0o700;
const PAIR_COMMAND = /^\/pair(?:@\w+)?[ \t]+(\S+)[ \t]*$/;

export const REFUSAL = Object.freeze({
  expired: "the code has expired",
  used: "the code was already used",
  wrong: "the code is wrong",
  notPrivate: "the message was not sent in a private chat with the bot",
  malformed: "the update names no sender or chat",
});

/** A fresh code from the system's randomness. */
export function generateCode(): string {
  return Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
}

/** Equal, without the time telling how many leading characters matched. */
function sameCode(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The parts pairing reads, or null when it is not a message. */
function messageParts(update: any): { userId: number; chatId: number; chatType: string; text: string; } | null {
  const message = update?.message;
  const userId = message?.from?.id;
  const chatId = message?.chat?.id;
  if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(chatId)) return null;
  return { userId, chatId, chatType: String(message.chat.type), text: typeof message.text === "string" ? message.text : "" };
}

/**
 * ONE pairing attempt's state: the code, when it dies, and whether it has been spent. PURE but for the injected clock.
 */
export function createPairingSession({ code, now, ttlMs = PAIRING_TTL_MS }: { code: string; now: () => number; ttlMs?: number; }): { code: string; expiresAt: number; expired(): boolean; attempt(update: unknown): { outcome: "ignored"; } | { outcome: "refused"; reason: string; } | { outcome: "paired"; userId: number; chatId: number; }; } {
  if (typeof code !== "string" || code === "") throw new TypeError("a pairing code is a non-empty string");
  const expiresAt = now() + ttlMs;
  let spent = false;
  return {
    code,
    expiresAt,
    expired: () => now() >= expiresAt,
    attempt(update) {
      const parts = messageParts(update);
      // Anything that is not somebody sending the bot `/pair <code>` is none of pairing's business, and is not worth a line of output.
      const guess = parts?.text.match(PAIR_COMMAND)?.[1];
      if (parts === null || guess === undefined) return { outcome: "ignored" };
      if (parts.chatType !== "private") return { outcome: "refused", reason: REFUSAL.notPrivate };
      if (now() >= expiresAt) return { outcome: "refused", reason: REFUSAL.expired };
      if (spent) return { outcome: "refused", reason: REFUSAL.used };
      if (!sameCode(guess, code)) return { outcome: "refused", reason: REFUSAL.wrong };
      spent = true;
      return { outcome: "paired", userId: parts.userId, chatId: parts.chatId };
    },
  };
}

/**
 * Writes the chairman file at mode 0600 from its first byte.
 */
export function writeChairmanFile(path: string, { userId, chatId }: { userId: number; chatId: number; }, { now }: { now: () => number; }) {
  mkdirSync(dirname(path), { recursive: true, mode: CHAIRMAN_DIRECTORY_MODE });
  const temporary = `${path}.${process.pid}.tmp`;
  const content = `${JSON.stringify({ userId, chatId, pairedAt: new Date(now()).toISOString() })}\n`;
  const descriptor = openSync(temporary, "wx", CHAIRMAN_FILE_MODE);
  try {
    writeSync(descriptor, content);
  } catch (error) {
    closeSync(descriptor);
    unlinkSync(temporary);
    throw error;
  }
  closeSync(descriptor);
  renameSync(temporary, path);
}

/** One `getUpdates` call. */
function updatesFrom({ token, fetch: fetchImpl, apiBase, signal }: { token: Secret; fetch: typeof fetch; apiBase: string; signal?: AbortSignal; }): (offset: number | undefined, timeoutSeconds: number) => Promise<any[]> {
  const guarded = redactingFetch(fetchImpl, token);
  return async (offset, timeoutSeconds) => {
    const body = { timeout: timeoutSeconds, allowed_updates: ["message"], ...(offset === undefined ? {} : { offset }) };
    const response = await guarded(`${apiBase}/bot${token.reveal()}/getUpdates`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
    });
    const parsed = await response.json().catch(() => ({}));
    if (response.ok && parsed.ok === true && Array.isArray(parsed.result)) return parsed.result;
    const hint = response.status === 409 ? " (another process is polling this bot: stop the listener first)" : "";
    throw new Error(token.scrub(`telegram getUpdates failed: ${parsed.error_code ?? response.status} ${parsed.description ?? "no description"}${hint}`));
  };
}

/** Whole seconds to long-poll for: the pairing window may end sooner than a full poll. */
const pollSeconds = (untilMs: number, nowMs: number): number => Math.max(1, Math.min(LONG_POLL_SECONDS, Math.ceil((untilMs - nowMs) / MS_PER_SECOND)));

/** The offset that confirms everything seen so far. */
function nextOffset(batch: any[], offset: number | undefined): number | undefined {
  return batch.reduce((next, update) => Math.max(next ?? 0, Number(update.update_id) + 1), offset);
}

/**
 * Hands each update of a batch to the session, in order, so two correct codes in one batch pair the first and refuse the second.
 * Returns who proved the code, if anyone did.
 */
function judgeBatch(batch: any[], session: ReturnType<typeof createPairingSession>, print: (line: string) => void): { userId: number; chatId: number; } | null {
  let paired: { userId: number; chatId: number; } | null = null;
  for (const update of batch) {
    const verdict = session.attempt(update);
    if (verdict.outcome === "refused") print(`pairing refused: ${verdict.reason}; nothing was written`);
    if (verdict.outcome === "paired") paired = { userId: verdict.userId, chatId: verdict.chatId };
  }
  return paired;
}

export async function runPairing(options: {
        token: Secret; chairmanFile: string; fetch?: typeof fetch; now?: () => number;
        sleep?: (ms: number) => Promise<void>; print?: (line: string) => void; code?: string; ttlMs?: number; apiBase?: string; signal?: AbortSignal;
    }): Promise<{ paired: true; userId: number; chatId: number; } | { paired: false; reason: string; }> {
  const { token, chairmanFile, fetch: fetchImpl = globalThis.fetch, now = Date.now, sleep = defaultSleep, print = defaultPrint,
    code = generateCode(), ttlMs = PAIRING_TTL_MS, apiBase = TELEGRAM_API, signal } = options;
  const session = createPairingSession({ code, now, ttlMs });
  const getUpdates = updatesFrom({ token, fetch: fetchImpl, apiBase, signal });
  print(`Send this to your bot within ${Math.round(ttlMs / (MS_PER_SECOND * 60))} minutes, from your own private chat with it:\n\n  /pair ${code}\n`);
  let offset: number | undefined;
  while (!session.expired() && signal?.aborted !== true) {
    const batch = await getUpdates(offset, pollSeconds(session.expiresAt, now()));
    if (batch.length === 0) await sleep(EMPTY_BATCH_PAUSE_MS);
    offset = nextOffset(batch, offset);
    const paired = judgeBatch(batch, session, print);
    if (paired === null) continue;
    writeChairmanFile(chairmanFile, paired, { now });
    // Confirm the batch with Telegram, so the `/pair` message is not handed again to the listener that polls this bot next.
    await getUpdates(offset, 0);
    print(`paired: ${chairmanFile} written (mode 0600)`);
    return { paired: true, ...paired };
  }
  const reason = session.expired() ? REFUSAL.expired : "pairing was cancelled";
  print(`pairing ended: ${reason}; nothing was written`);
  return { paired: false, reason };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function defaultPrint(line: string) {
  process.stdout.write(`${line}\n`);
}

/** The project root: `--root=<dir>`, else the current directory. */
function rootFrom(argv: string[]): string {
  const flag = argv.find((arg) => arg.startsWith("--root="));
  return flag === undefined ? process.cwd() : flag.slice("--root=".length);
}

/** The exit code: 0 paired, 1 not. */
export async function main(argv: string[]): Promise<number> {
  try {
    const config = readMessagingConfig(rootFrom(argv));
    if (!config.enabled) {
      defaultPrint("messaging: OFF (no `messaging` key in .agent-org/project.json); there is nothing to pair");
      return 1;
    }
    const result = await runPairing({ token: readSecretFile(config.tokenFile), chairmanFile: config.chairmanFile });
    return result.paired ? 0 : 1;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    process.stderr.write(`messaging:pair: ${error instanceof MessagingConfigRefusal ? "MALFORMED -- " : ""}${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
