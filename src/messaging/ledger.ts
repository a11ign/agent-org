// @ts-check
// THE DELIVERY LOG, AND THE ONLY STATE THE CORE KEEPS (decision 1: "append-only JSONL, one line per attempt"). A LEAF module.
//
// **THE LEDGER IS ALSO THE MEMORY.** A watcher is a unit that restarts, and a core that held "already sent" only in memory would send
// the same `needs:chairman` row again after every restart -- the measured defect (19 times in a day) this whole module exists to end.
// So there is no second state file to drift from the log: `foldLedger` rebuilds what the core needs from the lines, and an attempt
// the log does not hold did not happen.
//
// **NOTHING SECRET-SHAPED IS WRITTEN.** Telegram quotes the bot token in the URL, and a failed `fetch` quotes the URL in its message,
// so an error is passed through `redact` BEFORE it is a line. `append` redacts `error` again at the boundary: the caller that forgot
// is the one this protects.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export const STATUS = Object.freeze({
  sent: "sent",
  /** Refused by the token bucket: nothing is lost, the next tick tries again. */
  deferred: "deferred",
  /** Refused by the hourly cap: held for the ONE digest line, never dropped. */
  digested: "digested",
  failed: "failed",
  /** Resolved before the digest naming it went out, so the digest must not name it. */
  withdrawn: "withdrawn",
  invalid: "invalid",
});

const REDACTED = "<redacted>";
const CAUSE_DEPTH = 5;
const SECRET_ASSIGNMENT = /\b(token|secret|password|passwd|api[_-]?key|authorization)(["']?\s*[=:]\s*["']?)[^\s"',;&]+/gi;

/** Ordered, most specific first: the catch-all at the end is the net, not the rule. */
const TOKEN_SHAPES = Object.freeze(/** @type {[RegExp, string][]} */ ([
  [/\/bot\d+:[A-Za-z0-9_-]+/g, "/bot<redacted>"],
  [/\b\d{6,}:[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, REDACTED],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/\b[A-Za-z0-9_-]{32,}\b/g, REDACTED],
]));

/** @param {string} text @returns {string} `text` with every token-shaped string replaced */
export function redact(text: string): string {
  const keyed = text.replace(SECRET_ASSIGNMENT, (_whole, name, separator) => `${name}${separator}${REDACTED}`);
  return TOKEN_SHAPES.reduce((current, [shape, replacement]) => current.replace(shape, replacement), keyed);
}

/**
 * An error as one redacted line, its `cause` chain included: `fetch` failures keep the URL (and so the token) in the cause.
 *
 * @param {unknown} error @returns {string}
 */
export function describeError(error: unknown): string {
  const parts = [];
  let current = error;
  for (let depth = 0; depth < CAUSE_DEPTH && current !== undefined && current !== null; depth += 1) {
    parts.push(current instanceof Error ? `${current.name}: ${current.message}` : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return redact(parts.join(" <- "));
}

/**
 * One outbound attempt as a ledger line, with every design-mandated field present (null when it does not apply) so a reader never
 * has to distinguish "absent" from "not recorded". `extra` carries what the fold needs: `kind`, `stateHash`, `reminder`, `covers`.
 *
 * @param {{key: string, provider: string, status: string, providerMessageId?: string | null, error?: string | null,
 *          [extra: string]: unknown}} fields
 */
export function deliveryLine({ key, provider, status, providerMessageId = null, error = null, ...extra }: {
        key: string; provider: string; status: string; providerMessageId?: string | null; error?: string | null;
        [extra: string]: unknown;
    }) {
  return { key, provider, status, providerMessageId, error, ...extra };
}

/** @param {string} path @returns {Record<string, any>[]} */
export function readLedgerLines(path: string): Record<string, any>[] {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return [];
    throw error;
  }
  return raw.split("\n").flatMap((text, index) => {
    if (text.trim() === "") return [];
    try {
      return [JSON.parse(text)];
    } catch (cause) {
      // Fail closed: skipping a line the core cannot read could send again what it already sent.
      throw new Error(`ledger ${path}: line ${index + 1} is not JSON`, { cause });
    }
  });
}

/**
 * @param {{path: string, now: () => number}} options  `now` is injected so a test owns the clock.
 * @returns {{path: string, append: (entry: Record<string, unknown>) => Record<string, any>, read: () => Record<string, any>[]}}
 */
export function createLedger({ path, now }: { path: string; now: () => number; }): { path: string; append: (entry: Record<string, unknown>) => Record<string, any>; read: () => Record<string, any>[]; } {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return {
    path,
    append(entry) {
      /** @type {Record<string, any>} */
      const line: Record<string, any> = { ...entry, ts: new Date(now()).toISOString() };
      if (typeof line.error === "string") line.error = redact(line.error);
      appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
      return line;
    },
    read: () => readLedgerLines(path),
  };
}

/**
 * What the core remembers about one key.
 * `open`: the chairman has been told (or the digest holding it is pending) and has not been told it cleared.
 * `pending`: held for the digest line, with the text to name it by.
 *
 * @typedef {{open: boolean, lastNotifiedAt: number, reminders: number, stateHash: string, messageRef: string | null,
 *            clearedAt: number | null, pending: {kind: string, text: string} | null}} KeyRecord
 */

/** @param {Map<string, KeyRecord>} state @param {string} key @returns {KeyRecord} */
function recordFor(state: Map<string, KeyRecord>, key: string): KeyRecord {
  let record = state.get(key);
  if (!record) {
    record = { open: false, lastNotifiedAt: 0, reminders: 0, stateHash: "", messageRef: null, clearedAt: null, pending: null };
    state.set(key, record);
  }
  return record;
}

/** @param {KeyRecord} record @param {Record<string, any>} line @param {number} at */
function applyNotification(record: KeyRecord, line: Record<string, any>, at: number) {
  if (line.kind === "cleared") {
    Object.assign(record, { open: false, clearedAt: at });
  } else if (line.kind === "reminder") {
    Object.assign(record, { reminders: line.reminder, lastNotifiedAt: at });
  } else {
    Object.assign(record, { open: true, lastNotifiedAt: at, reminders: 0, stateHash: line.stateHash, messageRef: null });
  }
  if (line.status === STATUS.sent) record.messageRef = line.providerMessageId ?? record.messageRef;
}

/**
 * Applies one ledger line. A `digested` line applies the effect of the message it stands in for (the chairman WILL be told, in the
 * digest), so reminders count from the overflow rather than starting over; the digest line then only clears `pending`.
 *
 * @param {Map<string, KeyRecord>} state @param {Record<string, any>} line
 */
export function applyLine(state: Map<string, KeyRecord>, line: Record<string, any>) {
  if (line.direction === "in" || typeof line.key !== "string") return;
  const at = Date.parse(line.ts);
  if (line.kind === "digest") {
    if (line.status !== STATUS.sent) return;
    for (const covered of line.covers ?? []) if (state.has(covered)) /** @type {KeyRecord} */ (state.get(covered)).pending = null;
    return;
  }
  const record = recordFor(state, line.key);
  if (line.status === STATUS.sent || line.status === STATUS.digested) {
    applyNotification(record, line, at);
    record.pending = line.status === STATUS.digested ? { kind: line.kind, text: line.text ?? line.key } : null;
  } else if (line.status === STATUS.withdrawn) {
    Object.assign(record, { open: false, clearedAt: at, pending: null });
  }
}

/** @param {Record<string, any>[]} lines @returns {Map<string, KeyRecord>} */
export function foldLedger(lines: Record<string, any>[]): Map<string, KeyRecord> {
  const state = new Map();
  for (const line of lines) applyLine(state, line);
  return state;
}

/** @param {Record<string, any>[]} lines @returns {number[]} when each delivered outbound message went, for the hourly cap to restart from */
export function deliveredTimestamps(lines: Record<string, any>[]): number[] {
  return lines.filter((line) => line.direction !== "in" && line.status === STATUS.sent).map((line) => Date.parse(line.ts));
}
