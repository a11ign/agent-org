// @ts-check
// a11ign/a11ign#3494, first slice: THE TRACE STORE -- one append-only record per event, keyed by row (and pull request, and repository).
//
// TWO SOURCES TODAY, and each record says which: `source: "transcript"` for a model turn (`message.usage` of a Claude transcript), `source: "wake-ledger"` for the
// order the gate delivered. The platform-first reading (posted on #3494) found Claude Code's OpenTelemetry carries tokens, `cost_usd` and per-request duration, but
// it has no file exporter, needs a receiver the host does not run, and cannot reach a standing seat that is already running. So the transcript is the source and
// OTel records can be added later under another `source` without changing a reader.
//
// WHAT IS MEASURED AND WHAT IS INFERRED, because the two wear the same clothes in a report:
//   tokens        MEASURED: the API's own `usage` for the message.
//   costUsd       COMPUTED from `PRICES`. Checked against Claude Code's own `cost_usd` on one Haiku and one Sonnet 5.5 request (exact to 7 places); the Fable 5.1 and
//                 Opus 5.5 rows are the published rates, not checked. A model with no row costs `null`, never 0.
//   wallClockMs   INFERRED: the gap from the record before the message's first block to its last block. It includes the time the harness spent on the tool call that
//                 preceded the message, so a turn that follows a slow tool reads long. Named in `DEFINITIONS`.
//   deliveryLagMs MEASURED when the ledger line pairs with the delivery: delivered - typed. `null` when it does not pair (never 0). It is the harness's lag, NOT the
//                 gate's deferral: how long a busy seat held an order before `wake` typed it is in no durable record (`wake-deferred` is rewritten every tick and holds
//                 only what is deferred NOW), so deferral spans are a later slice that snapshots it.
//
// ONE API MESSAGE IS WRITTEN ONCE PER CONTENT BLOCK (measured: 23 assistant records were 8 message ids in one live transcript). A reader that sums every record
// double counts, so a turn is built per `message.id` from its LAST record, whose `output_tokens` is the final figure.
//
// IT READS `wakes-per-row.mjs`'s PARSERS by import and edits nothing in it. `parseTranscript` returns wakes without their times of typing or their usage, so the
// transcript is walked here once more for the records this store needs; the wake record it yields is `isWake`'s, the same test.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { isWake, matchLedger, reviewerTarget } from "../wakes-per-row.mjs";

export const DEFINITIONS = [
  "EVENT: one record in the store, `kind` turn | wake | compaction. A record is never edited; running the ingest twice adds nothing, because every record has a stable `id`.",
  "TURN: one API message of a Claude session (de-duplicated by message id), with its tokens, cost and wall-clock. It belongs to the wake that precedes it in its transcript.",
  "WAKE: a delivery that started a model turn (wakes-per-row's definition). `deliveryLagMs` is delivery minus the time `wake` typed the order, when the ledger line pairs (not the gate's deferral, which no record keeps).",
  "WALL-CLOCK OF A TURN (inferred): from the record before its first block to its last block. A turn after a slow tool call includes that call.",
  "COST: tokens x the rate in PRICES, cache writes at the 1-hour rate when the split is absent (every transcript seen writes 1-hour). `null` for a model with no price.",
  "KEY: row, pr and repo come from the order's cause key, else the session's name (worker-<n> is row n, reviewer-<n> is pull request n). An event with none is kept, with row null.",
];

const TOKENS_PER_MILLION = 1_000_000;
const COST_PRECISION = 100_000_000; // Claude Code reports cost_usd to 7 places; rounding only removes float noise
const WRITE_5M_FACTOR = 1.25;
const WRITE_1H_FACTOR = 2;

/**
 * Dollars per million tokens. `readFactor` is not always 0.1: Fable 5.1's cache read is $0.25 on a $10 input. `verified` is true where the formula reproduced Claude
 * Code's own `cost_usd` (2026-10-04, #3494); the others are the published rates.
 * @type {{ prefix: string, input: number, output: number, cacheRead: number, verified: boolean }[]}
 */
export const PRICES = [
  { prefix: "claude-fable-5", input: 10, output: 50, cacheRead: 0.25, verified: false },
  { prefix: "claude-opus-5-5", input: 4, output: 20, cacheRead: 0.2, verified: false },
  { prefix: "claude-sonnet-5-5", input: 2, output: 10, cacheRead: 0.2, verified: true },
  { prefix: "claude-haiku-4-5", input: 1, output: 5, cacheRead: 0.1, verified: true },
];

/**
 * @typedef {{ input: number, output: number, cacheRead: number, cacheWrite5m: number, cacheWrite1h: number }} Tokens
 * @typedef {{ id: string, kind: "turn" | "wake" | "compaction", source: "transcript" | "wake-ledger", at: number, session: string, row: number | null,
 *   pr: number | null, repo: string | null, cause: string | null, causeKey: string | null, wakeId: string | null, model?: string, tokens?: Tokens,
 *   costUsd?: number | null, wallClockMs?: number | null, deliveryLagMs?: number | null, bytes?: number, sidechain?: boolean }} TraceEvent
 */

/**
 * Cost of a turn, or `null` when the model has no price: an unpriced turn is unknown, and 0 would say it was free.
 * @param {string | undefined} model @param {Tokens} tokens
 * @returns {number | null}
 */
export function costOf(model, tokens) {
  const price = PRICES.find((entry) => model?.startsWith(entry.prefix));
  if (!price) return null;
  const dollars = (tokens.input * price.input + tokens.output * price.output + tokens.cacheRead * price.cacheRead
    + tokens.cacheWrite5m * price.input * WRITE_5M_FACTOR + tokens.cacheWrite1h * price.input * WRITE_1H_FACTOR) / TOKENS_PER_MILLION;
  return Math.round(dollars * COST_PRECISION) / COST_PRECISION;
}

/** @param {any} usage @returns {Tokens} */
export function tokensOf(usage) {
  const split = usage?.cache_creation;
  const written = usage?.cache_creation_input_tokens ?? 0;
  return {
    input: usage?.input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    cacheRead: usage?.cache_read_input_tokens ?? 0,
    cacheWrite5m: split ? (split.ephemeral_5m_input_tokens ?? 0) : 0,
    cacheWrite1h: split ? (split.ephemeral_1h_input_tokens ?? 0) : written,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// The order's subject: which row or pull request a ledger cause key is about

/** Causes whose key ends in a bare number, and what that number is. A cause not listed is NOT guessed at: its subject is unknown, not absent. */
const BARE_NUMBER_IS = new Map([
  ["ready-row-unclaimed", "row"], ["row-call-count-signal", "row"], ["row-off-board", "row"], ["pr-green-unarmed", "pr"], ["pr-codeowner-review-missing", "pr"],
]);

/**
 * The row and pull request a cause key names. `worker-3490/pr-review-blocked/pr-agent-org#165/...` is agent-org pull request 165; `pr-3406` is pull request 3406 of
 * the primary repository; `row-3390` is a row. `repo` is the keyed repository's name, or `null` for the primary.
 * @param {string} key the ledger key, `<group>/<cause>/<subject...>`
 * @returns {{ row: number | null, pr: number | null, repo: string | null }}
 */
export function subjectOf(key) {
  const [, cause = "", ...rest] = key.split("/");
  const subject = rest.join("/").split("@deferred:")[0];
  const row = /(?:^|\/)row-(\d+)/.exec(subject);
  if (row) return { row: Number(row[1]), pr: null, repo: null };
  const pr = /(?:^|\/)pr-(?:([\w.-]+)#)?(\d+)/.exec(subject);
  if (pr) return { row: null, pr: Number(pr[2]), repo: pr[1] ?? null };
  const awaiting = /^(\d+):[A-Z_]+/.exec(subject);
  if (awaiting) return { row: null, pr: Number(awaiting[1]), repo: null };
  const bare = /^(\d+)$/.exec(subject); // `7,9` names two rows: attributing it to the first would be a guess
  const meaning = BARE_NUMBER_IS.get(cause);
  if (bare && meaning === "row") return { row: Number(bare[1]), pr: null, repo: null };
  if (bare && meaning === "pr") return { row: null, pr: Number(bare[1]), repo: null };
  return { row: null, pr: null, repo: null };
}

/**
 * What a session's NAME says when the order's key says nothing: a spawned `worker-<n>` is row n and `reviewer-<n>` is pull request n.
 * @param {string} session @param {string} rowRepo
 */
function subjectOfSession(session, rowRepo) {
  const worker = /^worker-(\d+)$/.exec(session);
  if (worker) return { row: Number(worker[1]), pr: null, repo: null };
  const reviewer = reviewerTarget(session, rowRepo);
  if (reviewer) return { row: null, pr: reviewer.number, repo: reviewer.repo === rowRepo ? null : reviewer.repo.split("/")[1] };
  return { row: null, pr: null, repo: null };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Reading a transcript into events

const SESSION_NAME = /You are `([^`]+)`/;

/**
 * @param {string} text one transcript
 * @returns {{ records: { index: number, at: number, record: any }[], unreadable: number }}
 */
function readRecords(text) {
  /** @type {{ index: number, at: number, record: any }[]} */
  const records = [];
  let unreadable = 0;
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      unreadable += 1; // a live transcript's last line is often half written; counted and reported, never silently dropped
      continue;
    }
    const at = Date.parse(record?.timestamp);
    records.push({ index, at: Number.isNaN(at) ? NaN : at, record });
  }
  return { records, unreadable };
}

/**
 * Every event one transcript holds. A turn belongs to the latest wake before it; a turn before any wake belongs to the session itself.
 * @param {{ text: string, file: string, ledger: import("../wakes-per-row.mjs").LedgerEntry[], rowRepo: string }} input
 * @returns {{ session: string, events: TraceEvent[], unreadable: number }}
 */
export function eventsOfTranscript({ text, file, ledger, rowRepo }) {
  const { records, unreadable } = readRecords(text);
  const wakeRecords = records.filter(({ record }) => isWake(record) && !Number.isNaN(Date.parse(record.timestamp)));
  // The session's name is the first ORDER's, never a mention of one further down (a tool result can quote another session's brief).
  const session = wakeRecords.map(({ record }) => SESSION_NAME.exec(record.message.content)?.[1]).find(Boolean) ?? `unnamed:${file.split("/").pop()}`;
  const wakes = wakeRecords.map(({ record }) => ({ at: Date.parse(record.timestamp), bytes: Buffer.byteLength(record.message.content), session }));
  const paired = matchLedger(wakes, ledger.filter((entry) => entry.session === session));
  /** @type {TraceEvent[]} */
  const events = [];
  /** @type {{ at: number, id: string, row: number | null, pr: number | null, repo: string | null, cause: string | null, causeKey: string | null }[]} */
  const placed = [];
  for (const wake of paired.wakes) {
    const key = ledger.find((entry) => entry.session === session && entry.at === wake.typedAt && entry.cause === wake.cause)?.key ?? null;
    const subject = key ? subjectOf(key) : { row: null, pr: null, repo: null };
    const named_ = subject.row === null && subject.pr === null ? subjectOfSession(session, rowRepo) : subject;
    const id = `wake:${session}:${wake.at}`;
    const cause = wake.cause === "unknown" ? null : wake.cause;
    placed.push({ at: wake.at, id, ...named_, cause, causeKey: key });
    events.push({ id, kind: "wake", source: "wake-ledger", at: wake.at, session, ...named_, cause, causeKey: key, wakeId: id, bytes: wake.bytes,
      deliveryLagMs: cause === null ? null : Math.max(0, wake.at - wake.typedAt) });
  }
  const owner = (/** @type {number} */ at) => placed.findLast((wake) => wake.at <= at)
    ?? { id: null, ...subjectOfSession(session, rowRepo), cause: null, causeKey: null };
  events.push(...turnsOf(records, session, owner), ...compactionsOf(records, session, owner));
  return { session, events, unreadable };
}

/** @typedef {(at: number) => { id: string | null, row: number | null, pr: number | null, repo: string | null, cause: string | null, causeKey: string | null }} Owner */

/**
 * One turn per `message.id`, from its last record.
 * @param {{ index: number, at: number, record: any }[]} records @param {string} session @param {Owner} owner
 * @returns {TraceEvent[]}
 */
function turnsOf(records, session, owner) {
  /** @type {Map<string, { first: number, last: number, record: any }>} */
  const byMessage = new Map();
  for (const [position, { record }] of records.entries()) {
    const id = record?.type === "assistant" ? record.message?.id : null;
    if (!id || !record.message.usage) continue;
    const known = byMessage.get(id);
    byMessage.set(id, { first: known?.first ?? position, last: position, record });
  }
  return [...byMessage.entries()].map(([messageId, { first, last, record }]) => {
    const endedAt = records[last].at;
    const before = records.slice(0, first).findLast((candidate) => !Number.isNaN(candidate.at));
    const tokens = tokensOf(record.message.usage);
    const own = owner(endedAt);
    return {
      id: `turn:${messageId}`, kind: "turn", source: "transcript", at: endedAt, session, row: own.row, pr: own.pr, repo: own.repo, cause: own.cause,
      causeKey: own.causeKey, wakeId: own.id, model: record.message.model, tokens, costUsd: costOf(record.message.model, tokens),
      wallClockMs: before && !Number.isNaN(endedAt) ? Math.max(0, endedAt - before.at) : null, sidechain: record.isSidechain === true,
    };
  });
}

/** @param {{ index: number, at: number, record: any }[]} records @param {string} session @param {Owner} owner @returns {TraceEvent[]} */
function compactionsOf(records, session, owner) {
  return records.filter(({ record }) => record?.isCompactSummary === true && !Number.isNaN(Date.parse(record.timestamp))).map(({ at }) => {
    const own = owner(at);
    return { id: `compaction:${session}:${at}`, kind: "compaction", source: "transcript", at, session, row: own.row, pr: own.pr, repo: own.repo,
      cause: own.cause, causeKey: own.causeKey, wakeId: own.id };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// The store: append-only, idempotent

/** @param {string} path @returns {TraceEvent[]} */
export function readStore(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Append the events the store does not have. Nothing already in it is rewritten, and a second call with the same events adds nothing.
 * @param {string} path @param {TraceEvent[]} events
 * @returns {{ added: number, skipped: number }}
 */
export function appendEvents(path, events) {
  const known = new Set(readStore(path).map((event) => event.id));
  const fresh = events.filter((event, index) => !known.has(event.id) && events.findIndex((other) => other.id === event.id) === index);
  if (fresh.length > 0) {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, fresh.map((event) => `${JSON.stringify(event)}\n`).join(""));
  }
  return { added: fresh.length, skipped: events.length - fresh.length };
}

/**
 * The events about a subject: those of its rows, and of its pull requests (the ones that close the rows, and the one asked about when it IS a pull request).
 * @param {TraceEvent[]} events @param {{ rows: number[], prs: number[] }} subject
 * @returns {TraceEvent[]}
 */
export function eventsForRow(events, { rows, prs }) {
  const wantedRows = new Set(rows);
  const wantedPulls = new Set(prs);
  return events.filter((event) => (event.row !== null && wantedRows.has(event.row)) || (event.pr !== null && event.repo === null && wantedPulls.has(event.pr)))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}
