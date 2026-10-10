// a11ign/a11ign#3494, first slice: THE TRACE STORE -- one append-only record per event, keyed by row (and pull request, and repository).
//
// FOUR SOURCES TODAY, and each record says which: `source: "gh-ledger"` for one `gh` call (`gh-calls.ts`, #3516), `source: "transcript"` for a model turn (`message.usage` of a Claude transcript, or a request of a Codex reviewer session,
// `codex-turns.ts`, #3519, marked `harness: "codex"`), `source: "wake-ledger"` for the
// order the gate delivered, `source: "github"` for what GitHub saw of a row and its pull requests (`github-events.ts`, #3508). The platform-first reading (posted on #3494) found Claude Code's OpenTelemetry carries tokens, `cost_usd` and per-request duration, but
// it has no file exporter, needs a receiver the host does not run, and cannot reach a standing seat that is already running. So the transcript is the source and
// OTel records can be added later under another `source` without changing a reader.
//
// WHAT IS MEASURED AND WHAT IS INFERRED, because the two wear the same clothes in a report:
//   tokens        MEASURED: the API's own `usage` for the message.
//   costUsd       COMPUTED from `PRICES` when the turn is INGESTED, and again when a report READS it (`repriceEvents`): the stored value is a first reading, never the one printed. Checked against Claude Code's own `cost_usd` on one Haiku and one Sonnet 5.5 request (exact to 7 places); the Fable 5.1,
//                 Opus 5.5, Opus 5 and Sonnet 5 rows are the published rates, not checked. A model with no row costs `null`, never 0. The one Codex model with a row (`gpt-5.6-luna`, #4076) is matched by its exact name and carries the URL and date its rate was quoted from;
//                 any other Codex model stays `null`.
//   wallClockMs   INFERRED: the gap from the record before the message's first block to its last block. That record is the harness's (the tool's result, or an attachment stamped a
//                 few seconds after it), stamped AFTER the tool finished, so it is the model's own time and NOT the tool's: MEASURED on worker-3641 (a11ign/a11ign#3669), five
//                 tool calls of 365-524 s were followed by messages whose `wallClockMs` was 3-7 s. A turn that follows a slow tool does NOT read long. Named in `DEFINITIONS`.
//   toolMs        MEASURED when the message follows a tool call: from the last block of the message before it to the tool's result record. `null` when it does not follow one
//                 (an order, a prompt, the first record of a read with nothing carried), never 0. It is the stretch no turn's span holds, which is why it is a field of its own.
//   deliveryLagMs MEASURED when the ledger line pairs with the delivery: delivered - typed. `null` when it does not pair (never 0). It is the harness's lag, NOT the
//                 gate's deferral: how long a busy seat held an order before `wake` typed it was in no durable record (`wake-deferred` is rewritten every tick and holds
//                 only what is deferred NOW) until `wake-deferral-log` (#3510), which keeps each ENDED deferral and is read as `kind: deferral`.
//
// ONE API MESSAGE IS WRITTEN ONCE PER CONTENT BLOCK (measured: 23 assistant records were 8 message ids in one live transcript). A reader that sums every record
// double counts, so a turn is built per `message.id` from its LAST record, whose `output_tokens` is the final figure.
//
// IT READS `wakes-per-row.ts`'s PARSERS by import and edits nothing in it. `parseTranscript` returns wakes without their times of typing or their usage, so the
// transcript is walked here once more for the records this store needs; the wake record it yields is `isWake`'s, the same test.
import { appendFileSync, closeSync, constants, copyFileSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sessionOf } from "../token-audit.ts";
import { isWake, matchLedger, reviewerTarget } from "../wakes-per-row.ts";
import type { LedgerEntry } from "../wakes-per-row.ts";
import type { EndedDeferral } from "../deferral-log.ts";
import type { GithubKind } from "./github-events.ts";
import { restampStoreBytes } from "./ingest-state.ts";
import type { Carry, Previous } from "./ingest-state.ts";

export const DEFINITIONS = [
  "EVENT: one record in the store, `kind` turn | wake | compaction | gh_call | deferral, or one of GitHub's (`GITHUB_KINDS`). A record is never edited; running the ingest twice adds nothing, because every record has a stable `id`.",
  "TURN: one API message of a Claude session (de-duplicated by message id), with its tokens, cost and wall-clock. It belongs to the wake that precedes it in its transcript.",
  "WAKE: a delivery that started a model turn (wakes-per-row's definition). `deliveryLagMs` is delivery minus the time `wake` typed the order, when the ledger line pairs (not the gate's deferral, which no record keeps).",
  "WALL-CLOCK OF A TURN (inferred): from the record before its first block to its last block. That record is stamped after a tool call ends, so the call is NOT in it: it is the model's own time.",
  "TOOL TIME OF A TURN (`toolMs`, measured): when the message follows a tool call, from the last block of the message before it to the tool's result record; `null` when it follows no tool call, never 0. A turn that follows an order or a prompt has none, and so does the first turn of a read when nothing was carried to say when the call began.",
  "TOOL READ (`toolRead`, measured): on the turn that CARRIES a result, the growth of the window the result caused: this turn's `input + cacheRead + cacheWrite5m + cacheWrite1h`, less the previous message's, less the previous message's own `output` (which re-enters the window the same way). Present only when the previous message called `Read`, `Grep` or `Glob`; `tool` is that tool, or `mixed` when the message called more than one tool (any mix with a tool that is not one of the three is in it too), and `tokens` is `null` (never 0) when the window cannot be read that way: a prompt, an order or a compaction came between, the window shrank, or the previous message is not in the store. `null` on a turn stored by this reader means no such call preceded it; an ABSENT field is a turn stored before the reader, which says nothing.",
  "COST: tokens x the rate in PRICES, cache writes at the 1-hour rate when the split is absent (every transcript seen writes 1-hour). `null` for a model with no price. A STORED `costUsd` IS A FIRST READING, priced at the rates of the day it was ingested (the stored value switched cache-read pricing from $0.20 to $0.10 on 2026-10-08), so a sum of stored `costUsd` over the raw file is wrong for that reason as well as for the duplicate ids under SUPERSEDED: `repriceEvents` reprices every turn at read and `trace cost` is the command that sums.",
  "GITHUB EVENT: what GitHub's REST API holds of a row or pull request (`source: github`, session `github`): filed/opened, claimed/released (the claim-record comments), labeled/unlabeled for an order to a session or a hold, ready_for_review, reviewed (state, and the head it was posted on), head_moved, ci_run, added_to_merge_queue, removed_from_merge_queue, merged, closed.",
  "HEAD_MOVED (inferred): `at` is the commit's own date, not the push's; the timeline carries no push event. CI RUN: each head the timeline names is asked for its check-runs; the merge queue's own runs, on its temporary branch, and legacy commit statuses are not read.",
  "OUTCOME of a queue exit (inferred): `merged` when it falls within 5 s of the pull request's merge, else `unmerged` (an ejection or a person). GitHub writes the same event for both.",
  "KEY: row, pr and repo come from the order's cause key, else the session's name (worker-<n> is row n, reviewer-<n> is pull request n). An event with none is kept, with row null.",
  "SEVERAL ROWS (`rows`, `prs`): a cause key that lists rows (`row-call-count-signal/3125,3404`) puts the wake and its turns on EACH of them and leaves `row` null; a turn is then on every row it is listed under, so the cost of such a turn is in each of those rows' totals and the totals of two rows are not to be added.",
  "TOUCHED (`touchedRows`, `touchedPrs`, inferred): the rows and pull requests of the primary repository a turn WROTE to with `gh issue|pr edit|comment|close|reopen|ready|merge|review <n>`, read off the command text. A `gh issue view` is not a write; a command that names another clone or another `--repo`, and a `gh api` write, are not read. It puts a ruling's turn on the row ruled on when the order that woke the seat named another subject, or none (an order typed by `prompt:session` has no ledger line).",
  "CODEX TURN (`harness: codex`, `source: transcript`): one model request of a Codex reviewer session (`~/.codex/sessions`), keyed to the pull request in its name (`reviewer-<n>`), with tokens (`input` the uncached part, `cacheRead` the cached part, `output` including reasoning) and the model. `costUsd` is null when PRICES has no row for the model (only `gpt-5.6-luna` has one, quoted from OpenAI's model page) or the request's prompt is above that row's `maxPrompt`. Its wall-clock runs from the last record sent to the model.",
  "DEFERRAL (`kind: deferral`, `source: deferral-log`, #3510): one wait of an order for a busy seat, written by the gate's own tick when it ENDED (`wake-deferral-log`, beside `wake-deferred`): `startedAt` is the tick that first found the order deferred, `completedAt` (and `at`) the tick that found it no longer deferred, so each end is at most one tick late, and `how` is `delivered` (the ledger holds that cause key at or after the start) or `gone` (it left with no delivery: the order stopped being true). `session` is the addressee in the key. KEYED BY THE CAUSE KEY'S ROW OR PULL REQUEST (`subjectOf`), else the session's name. A wait still OPEN is not here (the log holds ended ones), and a wait that ended before the first tick to write the log is in no record: it can only be inferred from the review event, the ledger's delivery and the seat's own turns.",
  "GH CALL (`kind: gh_call`, `source: gh-ledger`, #3516): one line of a `gh-calls.tsv` ledger (`host/gh`, #3466), with `account`, `resource` (`graphql`, `graphql?` for a call only inferred to spend that pool, `core`, `other`), `cost` (the points the RESPONSE carried, else null: most list calls carry none, so a null cost on a GraphQL call is a FLOOR of one point), `exit` (the call's exit status; `status` is a CI run's), `command` (its first two arguments), `workspace` and `script` (what the calling process was). KEYED BY THE LINE'S SESSION ID (#3589): `host/gh` writes `CLAUDE_CODE_SESSION_ID` (a Codex session's `CODEX_THREAD_ID`) on each call, which is the file name of its transcript, and a turn carries its transcript's id; a call is on that session and, through the session's next turn, on a row (`keyedBy: session`). A line with no id (a unit or script outside any session, or a line written before the wrapper named its session) is `unkeyed: script`; one whose session has no later turn in the store yet is `unkeyed: no-turn`; either way the call's session is `gh-ledger` and it has no row. A ledger keeps 2 MiB, so a call older than its trim is not in the store unless it was ingested first.",
  "SUPERSEDED: the store keeps ONE line per event id. A corrected copy of an event (a turn re-read after a fix to its attribution) replaces the stored one on disk; an identical copy adds nothing. A file from before that can carry an id twice, and the LAST copy is the event: `trace compact-store` removes the rest, so a sum over the file's lines is a sum over its events.",
];

const TOKENS_PER_MILLION = 1_000_000;
const COST_PRECISION = 100_000_000; // Claude Code reports cost_usd to 7 places; rounding only removes float noise
const WRITE_5M_FACTOR = 1.25;
const WRITE_1H_FACTOR = 2;

type Rates = { input: number; output: number; cacheRead: number; verified: boolean };

/**
 * Dollars per million tokens, `cacheRead` as the pricing page lists it (read 2026-10-08, #4057): the factor on input is not the same for every model (Fable 5.1 $0.25 on a $10 input,
 * Fable 5 $1, Sonnet 5.5 $0.10). `verified` is true where the formula reproduced Claude Code's own `cost_usd` (2026-10-04, #3494); the others are the published rates.
 * A row is NOT verified when it disagrees with the page: `cost_usd` is the client's estimate and the page is the billing rate (Sonnet 5.5, which `cost_usd` priced at the old $0.20).
 * A Claude row matches by `prefix` (ids carry dated suffixes). A row of any OTHER vendor matches by `model`, the EXACT name, and carries `source` (the URL it was quoted from) and `fetched`
 * (the date), because a rate borrowed from a neighbouring model is an invention with a citation on it (#4076, #4055 move 10): `gpt-5.6-luna-pro` is a different model with a different price.
 * `maxPrompt` is the largest prompt (input + cached + cache writes) the listed rates are quoted for: a request above it costs `null`, because the page states a different rate there and not all of it.
 */
export const PRICES: (Rates & { prefix?: string; model?: string; source?: string; fetched?: string; maxPrompt?: number; })[] = [
  // `claude-fable-5-1` stands BEFORE `claude-fable-5`: the page lists them apart, and `costOf` takes the first prefix that matches.
  { prefix: "claude-fable-5-1", input: 10, output: 50, cacheRead: 0.25, verified: false },
  { prefix: "claude-fable-5", input: 10, output: 50, cacheRead: 1, verified: false },
  { prefix: "claude-opus-5-5", input: 4, output: 20, cacheRead: 0.2, verified: false },
  { prefix: "claude-sonnet-5-5", input: 2, output: 10, cacheRead: 0.1, verified: false },
  // The ids before 5.5 (a11ign/a11ign#3582). `costOf` takes the FIRST prefix that matches, so these stand after `-5-5` or they would price its turns. Rates: the claude-api
  // skill's model docs (2026-09-25): Opus 5 $5 / $25 with cache reads at 0.1x ("every other model", Opus 5.5 being 0.05x and Fable 5.1 0.025x), Sonnet 5 at Sonnet 5.5's
  // prices ($2 / $10, reads $0.20). Not reproduced against a `cost_usd`.
  { prefix: "claude-opus-5", input: 5, output: 25, cacheRead: 0.5, verified: false },
  { prefix: "claude-sonnet-5", input: 2, output: 10, cacheRead: 0.2, verified: false },
  // Haiku 5.5 (#4186; found on #4183, where its turns read `costUsd: null`). The claude-api skill's model docs (2026-10-08): $0.10 / $0.50 per MTok for a prompt of 100K tokens or fewer, cache reads at 0.1x
  // the input rate ($0.01), and "$0.50 / $2.50 when it is longer", so `maxPrompt` makes a longer request `null` rather than priced at the wrong card. Not reproduced against a `cost_usd`.
  // Ahead of `-4-5` by reading order only: the prefixes do not overlap.
  { prefix: "claude-haiku-5-5", input: 0.1, output: 0.5, cacheRead: 0.01, verified: false, maxPrompt: 100_000 },
  { prefix: "claude-haiku-4-5", input: 1, output: 5, cacheRead: 0.1, verified: true },
  // The Codex reviewers' model (#4076). OpenAI's model page, "Text tokens": Input $0.2, Cached input $0.02, Output $1.2 per 1M tokens (curl the URL below; the pricing page's Standard table carries the same three).
  // The page adds "Prompts with >272K input tokens are priced at 2x input and 1.5x output for the full request" and says nothing of the cached rate there, so a request above 272K is `null`, never a guess.
  // Not checked against an invoice. No Codex request in the 7 days before 2026-10-08 reached 272K (the largest was 159,638).
  { model: "gpt-5.6-luna", input: 0.2, output: 1.2, cacheRead: 0.02, verified: false, source: "https://developers.openai.com/api/docs/models/gpt-5.6-luna.md", fetched: "2026-10-08", maxPrompt: 272_000 },
];

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number };
export type TraceEvent = {
  id: string; kind: "turn" | "wake" | "compaction" | "gh_call" | "deferral" | GithubKind; source: "transcript" | "wake-ledger" | "github" | "gh-ledger" | "deferral-log"; at: number; session: string; row: number | null;
  pr: number | null; repo: string | null; cause: string | null; causeKey: string | null; wakeId: string | null; model?: string; tokens?: Tokens;
  costUsd?: number | null; toolRead?: ToolRead | null; transcript?: string; wallClockMs?: number | null; toolMs?: number | null; deliveryLagMs?: number | null; bytes?: number; sidechain?: boolean; harness?: "codex";
  rows?: number[]; prs?: number[]; touchedRows?: number[]; touchedPrs?: number[]; actor?: string | null; seq?: number; claimant?: string; name?: string; state?: string | null; status?: string; headSha?: string; mergeSha?: string; startedAt?: number;
  completedAt?: number | null; how?: "delivered" | "gone"; outcome?: "merged" | "unmerged"; account?: string; resource?: string; cost?: number | null; exit?: number; command?: string; workspace?: string;
  script?: string; sessionId?: string; keyedBy?: "session" | "time" | null; unkeyed?: "script" | "no-turn";
  /** a turn's reasoning effort as Claude Code wrote it on the transcript record; ABSENT when the record carried none, which is not `low` (agent-org#469) */
  effort?: string;
};

export type ToolRead = { tool: "Read" | "Grep" | "Glob" | "mixed"; tokens: number | null };

/**
 * Cost of a turn, or `null` when the model has no price: an unpriced turn is unknown, and 0 would say it was free.
 * @param cacheReadRate dollars per million for the cache-read tokens in place of the model's own: how `trace cost` reads a turn the way Claude Code's own display does
 */
export function costOf(model: string | undefined, tokens: Tokens, cacheReadRate?: number): number | null {
  const price = PRICES.find((entry) => (entry.model === undefined ? model?.startsWith(entry.prefix ?? "") : model === entry.model));
  if (!price) return null;
  if (price.maxPrompt !== undefined && tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h > price.maxPrompt) return null;
  const dollars = (tokens.input * price.input + tokens.output * price.output + tokens.cacheRead * (cacheReadRate ?? price.cacheRead)
    + tokens.cacheWrite5m * price.input * WRITE_5M_FACTOR + tokens.cacheWrite1h * price.input * WRITE_1H_FACTOR) / TOKENS_PER_MILLION;
  return Math.round(dollars * COST_PRECISION) / COST_PRECISION;
}

/**
 * The events with every turn's `costUsd` REPRICED from `PRICES` as it stands now, never read off the line it was stored on: the store is append-only and a transcript that has not
 * changed is not read again, so a price added after ingest (a11ign/a11ign#3582) would otherwise never reach the turns stored before it (#3638: 147,675 turns kept `null`).
 * A model with no price stays `null`. A turn with no `tokens` has nothing to price from and is left as stored, and any event that is not a turn is returned as it came.
 */
export function repriceEvents(events: TraceEvent[]): TraceEvent[] {
  return events.map((event) => {
    if (event.kind !== "turn" || !event.tokens) return event;
    const costUsd = costOf(event.model, event.tokens);
    return costUsd === event.costUsd ? event : { ...event, costUsd };
  });
}

export function tokensOf(usage: any): Tokens {
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
 * @param key the ledger key, `<group>/<cause>/<subject...>`
 */
export function subjectOf(key: string): { row: number | null; pr: number | null; repo: string | null; } {
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
 * The rows or pull requests a cause key names when it names SEVERAL, as a comma list (`row-call-count-signal/3125,3404`): `subjectOf` keeps `row: null` for it,
 * because the first of the list is a guess, and an event the key names twice was about both. `{}` for a key that names one subject or none.
 * @param key the ledger key, `<group>/<cause>/<subject...>`
 */
export function subjectsOf(key: string): { rows?: number[]; prs?: number[]; } {
  const [, cause = "", ...rest] = key.split("/");
  const subject = rest.join("/").split("@deferred:")[0];
  const meaning = BARE_NUMBER_IS.get(cause);
  if (!meaning || !/^\d+(,\d+)+$/.test(subject)) return {};
  const numbers = subject.split(",").map(Number);
  return meaning === "row" ? { rows: numbers } : { prs: numbers };
}

/**
 * What a session's NAME says when the order's key says nothing: a spawned `worker-<n>` is row n and `reviewer-<n>` is pull request n.
 */
export function subjectOfSession(session: string, rowRepo: string) {
  const worker = /^worker-(\d+)$/.exec(session);
  if (worker) return { row: Number(worker[1]), pr: null, repo: null };
  const reviewer = reviewerTarget(session, rowRepo);
  if (reviewer) return { row: null, pr: reviewer.number, repo: reviewer.repo === rowRepo ? null : reviewer.repo.split("/")[1] };
  return { row: null, pr: null, repo: null };
}

/**
 * One event per ended deferral of the gate's log (`deferral-log.ts`). The id is made of the cause key and the start, so a line read twice (a tick killed between the log and `wake-deferred` appends it
 * again) is the one event. `at` is the END, which is when the store learned of it; the start is `startedAt`.
 */
export function eventsOfDeferrals(spans: EndedDeferral[], rowRepo: string): TraceEvent[] {
  return spans.map(({ key, startMs, endMs, how }) => {
    const [session = key, cause = null] = key.split("/");
    const subject = subjectOf(key);
    const several = subjectsOf(key);
    const named = subject.row === null && subject.pr === null && !several.rows && !several.prs ? subjectOfSession(session, rowRepo) : { ...subject, ...several };
    return { id: `deferral:${key}:${startMs}`, kind: "deferral", source: "deferral-log", at: endMs, session, ...named, cause, causeKey: key, wakeId: null, startedAt: startMs, completedAt: endMs, how };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Reading a transcript into events

/**
 * A message whose last block is younger than this may still be gaining blocks, and its turn is built from the LAST one, so it is held back to the next run.
 * Measured 2026-10-04 on 80 transcripts (1,985 messages): the longest gap between two blocks of one message was 47 s, and blocks of one message are sometimes
 * separated by other records, so "a record follows it" does not settle a message and only its age does.
 */
export const QUIET_MS = 5 * 60 * 1000;

/** How long a consumed ledger line is remembered: it must exceed wakes-per-row's `LEDGER_LEAD_MS` (10 min), the window in which a later wake could claim it again. */
const LEDGER_MEMORY_MS = 60 * 60 * 1000;

export type Rec = { start: number; index: number; at: number; record: any };

/**
 * @param text one transcript, or the part of one that starts at a line boundary
 * @returns `start` is a byte offset into `text`; `unreadable` the start of each line that is not JSON;
 *   `tail` where a final line WITHOUT its newline begins when it is not JSON (a half-written line, to be read again), else `null`; `end` where the readable text ends
 */
export function readRecords(text: string): { records: Rec[]; unreadable: number[]; end: number; tail: number | null; } {
  const records: Rec[] = [];
  const unreadable: number[] = [];
  let start = 0;
  let tail = null;
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const length = Buffer.byteLength(line);
    if (line.trim()) {
      try {
        const record = JSON.parse(line);
        const at = Date.parse(record?.timestamp);
        records.push({ start, index, at: Number.isNaN(at) ? NaN : at, record });
      } catch {
        unreadable.push(start); // a live transcript's last line is often half written; counted and reported, never silently dropped
        if (index === lines.length - 1) tail = start;
      }
    }
    start += length + 1;
  }
  return { records, unreadable, end: tail ?? Buffer.byteLength(text), tail };
}

type MessageGroup = { id: string; first: number; last: number; record: any };

/**
 * One group per `message.id`: the position of its first and last block (in `records`) and its last record, whose usage is final.
 */
function messageGroups(records: Rec[]): MessageGroup[] {
  const byMessage: Map<string, MessageGroup> = new Map();
  for (const [position, { record }] of records.entries()) {
    const id = record?.type === "assistant" ? record.message?.id : null;
    if (!id || !record.message.usage) continue;
    byMessage.set(id, { id, first: byMessage.get(id)?.first ?? position, last: position, record });
  }
  return [...byMessage.values()];
}

/**
 * The byte before which everything is settled: the start of the earliest message still young enough to be gaining blocks, or `end`. A message is wholly before the
 * boundary or wholly after it: a settled message with blocks on both sides pulls the boundary back to its first block.
 */
function settledBoundary({ records, groups, end, now }: { records: Rec[]; groups: MessageGroup[]; end: number; now: number; }): { boundary: number; held: MessageGroup[]; settleAt: number | null; } {
  const young = groups.filter((group) => now - records[group.last].at < QUIET_MS);
  let boundary = Math.min(end, ...young.map((group) => records[group.first].start));
  for (let moved = true; moved;) {
    moved = false;
    for (const group of groups) {
      if (records[group.first].start < boundary && records[group.last].start >= boundary) {
        boundary = records[group.first].start;
        moved = true;
      }
    }
  }
  const held = groups.filter((group) => records[group.last].start >= boundary);
  const settleAt = young.length > 0 ? Math.max(...young.map((group) => records[group.last].at)) + QUIET_MS : null;
  return { boundary, held, settleAt };
}

/** A Claude transcript's id is its file name (`<id>.jsonl`), and is what `CLAUDE_CODE_SESSION_ID` holds in the session that wrote it: the key `host/gh` writes on a `gh` call (#3589). */
const transcriptId = (file: string) => (file.split("/").pop() ?? file).replace(/\.jsonl$/, "");

/**
 * Every event one transcript holds, or the part of it from a resume point. A turn belongs to the latest wake before it; a turn before any wake belongs to the session
 * itself. `carry` is what the read before this one left (`null` for a read from byte 0), and the returned `carry` and `consumed` are what the next one starts from:
 * `consumed` is how many bytes of `text` are turned into events (the rest is a half-written line or a message that may still be gaining blocks), so a caller that
 * resumes at `consumed` sees every event exactly as one read of the whole file would have given it. `now` defaults to "nothing is young": a caller that reads
 * a finished file in one piece holds nothing back.
 */
export function eventsOfTranscript({ text, file, ledger, rowRepo, carry = null, now = Number.POSITIVE_INFINITY }: { text: string; file: string; ledger: LedgerEntry[]; rowRepo: string; carry?: Carry | null; now?: number; }): { session: string; events: TraceEvent[]; unreadable: number; carry: Carry; consumed: number; held: number; settleAt: number | null; namedLate: boolean; } {
  const { records, unreadable, end, tail } = readRecords(text);
  const groups = messageGroups(records);
  const { boundary, held, settleAt } = settledBoundary({ records, groups, end, now });
  const settled = records.filter(({ start }) => start < boundary);
  const wakeRecords = settled.filter(({ record }) => isWake(record) && !Number.isNaN(Date.parse(record.timestamp)));
  // The session's name is the first ORDER's, never a mention of one further down (a tool result can quote another session's brief).
  const named = wakeRecords.map(({ record }) => sessionOf(record.message.content)).find(Boolean) ?? null;
  const session = carry?.session ?? named ?? `unnamed:${file.split("/").pop()}`;
  const wakes = wakeRecords.map(({ record }) => ({ at: Date.parse(record.timestamp), bytes: Buffer.byteLength(record.message.content), session }));
  const used = carry?.used ?? [];
  const free = ledger.filter((entry) => entry.session === session && !used.some((spent) => spent.at === entry.at && spent.key === entry.key));
  const paired = matchLedger(wakes, free);
  const events: TraceEvent[] = [];
  const placed: NonNullable<Carry["owner"]>[] = [];
  const spent: { at: number; key: string; }[] = [];
  for (const wake of paired.wakes) {
    const key = ledger.find((entry) => entry.session === session && entry.at === wake.typedAt && entry.cause === wake.cause)?.key ?? null;
    if (key) spent.push({ at: wake.typedAt, key });
    const subject = key ? subjectOf(key) : { row: null, pr: null, repo: null };
    const several = key ? subjectsOf(key) : {};
    const named_ = subject.row === null && subject.pr === null && !several.rows && !several.prs ? { ...subjectOfSession(session, rowRepo) } : { ...subject, ...several };
    const id = `wake:${session}:${wake.at}`;
    const cause = wake.cause === "unknown" ? null : wake.cause;
    placed.push({ at: wake.at, id, ...named_, cause, causeKey: key });
    events.push({ id, kind: "wake", source: "wake-ledger", at: wake.at, session, ...named_, cause, causeKey: key, wakeId: id, bytes: wake.bytes,
      deliveryLagMs: cause === null ? null : Math.max(0, wake.at - wake.typedAt) });
  }
  // The wake in force at the offset: the carried one answers for a turn before the first wake of this read, which is how the row survives a resume.
  const latest = placed.at(-1) ?? carry?.owner ?? null;
  const owner = (at: number) => placed.findLast((wake) => wake.at <= at) ?? carry?.owner
    ?? { id: null, ...subjectOfSession(session, rowRepo), cause: null, causeKey: null };
  const priorAt = carry?.lastAt ?? null;
  const reads = toolReadsOf({ records, groups: groups.filter((group) => !held.includes(group)), end: settled.length, carried: carry?.previous ?? null });
  events.push(...turnsOf({ records, groups: groups.filter((group) => !held.includes(group)), session, transcript: transcriptId(file), owner, priorAt, rowRepo, reads: reads.byMessage }), ...compactionsOf(settled, session, owner));
  const lastAt = settled.findLast((candidate) => !Number.isNaN(candidate.at))?.at ?? priorAt;
  const remembered = [...used, ...spent].filter((entry) => latest === null || entry.at >= latest.at - LEDGER_MEMORY_MS);
  return {
    session, events, unreadable: unreadable.filter((start) => start < boundary || start === tail).length, consumed: boundary, held: held.length, settleAt,
    carry: { session: carry?.session ?? named, owner: latest, lastAt, used: remembered, previous: reads.previous }, namedLate: carry !== null && carry.session === null && named !== null,
  };
}

/**
 * The verbs of `gh issue` / `gh pr` that WRITE to the thing they name. A `view` is not here: a turn that only read a row was not what ruled on it, and a ruling's turn is
 * the one that edits or comments.
 */
const GH_WRITES = /\bgh\s+(issue|pr)\s+(?:edit|comment|close|reopen|ready|merge|review)\s+(\d+)\b([^\n;&|]*)/g;

/** Another repository's clone, named in a command: its `gh issue edit 187` is that repository's 187, not the primary's. */
const OTHER_CLONE = /agent-org|screenreader-worker|documents/;

/**
 * The rows and pull requests of the primary repository a turn WROTE to with `gh issue|pr <verb> <n>` (INFERRED from the command text: the harness records no cwd for a
 * command, so a command that names another clone or another `--repo` is left out, and a `gh api` write is not read). Present only when the turn wrote to one.
 * @param blocks the records of one API message
 */
export function touchesOf(blocks: Rec[], rowRepo: string): { touchedRows?: number[]; touchedPrs?: number[]; } {
  const rows = new Set<number>();
  const prs = new Set<number>();
  for (const { record } of blocks) {
    for (const block of Array.isArray(record?.message?.content) ? record.message.content : []) {
      const command = block?.type === "tool_use" && typeof block.input?.command === "string" ? block.input.command : "";
      if (OTHER_CLONE.test(command)) continue;
      for (const [, noun, number, rest] of command.matchAll(GH_WRITES)) {
        const repoFlag = /(?:--repo|-R)[ =](\S+)/.exec(rest)?.[1];
        if (repoFlag && repoFlag !== rowRepo) continue;
        (noun === "issue" ? rows : prs).add(Number(number));
      }
    }
  }
  return { ...(rows.size > 0 ? { touchedRows: [...rows].sort((a, b) => a - b) } : {}), ...(prs.size > 0 ? { touchedPrs: [...prs].sort((a, b) => a - b) } : {}) };
}

type Owner = (at: number) => { id: string | null; row: number | null; pr: number | null; repo: string | null; rows?: number[]; prs?: number[]; cause: string | null; causeKey: string | null };

/** The several subjects a wake's key named, as event fields: present only when it named several, so an event with one subject is the shape it always was. */
const listedBy = ({ rows, prs }: { rows?: number[]; prs?: number[]; }) => ({ ...(rows ? { rows } : {}), ...(prs ? { prs } : {}) });

/**
 * One turn per `message.id`, from its last record. `priorAt` is the time of the record before this read began, for the wall-clock of a turn that is the first thing in it.
 */
function turnsOf({ records, groups, session, transcript, owner, priorAt, rowRepo, reads }: { records: Rec[]; groups: MessageGroup[]; session: string; transcript: string; owner: Owner; priorAt: number | null; rowRepo: string; reads: Map<string, ToolRead | null>; }): TraceEvent[] {
  const before = recordBefore(records, priorAt);
  const assistantAt = assistantBefore(records, priorAt);
  return groups.map(({ id: messageId, first, last, record }) => {
    const endedAt = records[last].at;
    const previous = before[first];
    const tokens = tokensOf(record.message.usage);
    const own = owner(endedAt);
    return {
      id: `turn:${messageId}`, kind: "turn", source: "transcript", at: endedAt, session, transcript, row: own.row, pr: own.pr, repo: own.repo, ...listedBy(own), cause: own.cause,
      causeKey: own.causeKey, wakeId: own.id, model: record.message.model, tokens, costUsd: costOf(record.message.model, tokens), toolRead: reads.get(messageId) ?? null,
      wallClockMs: previous !== null && !Number.isNaN(endedAt) ? Math.max(0, endedAt - previous) : null, toolMs: toolMsBefore(records, first, assistantAt[first]),
      sidechain: record.isSidechain === true, ...effortOf(record),
      ...touchesOf(records.slice(first, last + 1).filter(({ record: block }) => block?.message?.id === messageId), rowRepo),
    };
  });
}

/**
 * The effort a turn ran at, as the transcript record names it: `perTurnEffort` (the turn's own) before `effort` (the session's). MEASURED on Claude Code 2.1.296, where the two agree on
 * every one of 43,000+ assistant records and neither is on a record an older client wrote. Present only when the record carried one: an absent effort is unknown, never `low`.
 */
export function effortOf(record: any): { effort?: string } {
  const named = [record?.perTurnEffort, record?.effort].find((value) => typeof value === "string" && value !== "");
  return named === undefined ? {} : { effort: named };
}

/** The tools whose results the report calls READ tokens. */
export const READ_TOOLS = ["Read", "Grep", "Glob"];

/** @param tokens the window a turn was sent: everything on the input side */
const windowOf = (tokens: Tokens) => tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;

/** Whether the records in `[from, to)` of one side (main thread or a subagent's) hold only tool results: a prompt, an order or a compaction summary there means the window grew by more than the results. */
function onlyToolResults(records: Rec[], { from, to, side }: { from: number; to: number; side: boolean; }) {
  return records.slice(from, to).every(({ record }) => record?.type !== "user" || (record.isSidechain === true) !== side
    || (Array.isArray(record.message?.content) && record.message.content.some((block: { type?: string; }) => block?.type === "tool_result")));
}

/** @returns the tool the message called, one name per call */
function toolsCalled(records: Rec[], { id, first, last }: MessageGroup): string[] {
  return records.slice(first, last + 1).filter(({ record }) => record?.message?.id === id)
    .flatMap(({ record }) => (Array.isArray(record.message.content) ? record.message.content : []).filter((block: { type?: string; }) => block?.type === "tool_use").map((block: { name?: string; }) => String(block.name)));
}

/**
 * What each message's results cost the window (`toolRead`, defined in `DEFINITIONS`): a turn is sent the whole window again, so the growth since the message before it, less that
 * message's own output, is what the results (and the few tokens of framing around them) added. A thread is its own sequence: a subagent's messages are not between the main thread's.
 * `carried` is what the read before this one left, so a resumed read derives its first turn the way one read of the whole file would have.
 * @param input `end` is where the settled records end
 */
function toolReadsOf({ records, groups, end, carried }: { records: Rec[]; groups: MessageGroup[]; end: number; carried: { main: Previous | null; side: Previous | null; } | null; }): { byMessage: Map<string, ToolRead | null>; previous: { main: Previous | null; side: Previous | null; }; } {
  const previous = { main: carried?.main ?? null, side: carried?.side ?? null };
  const lastAt = { main: -1, side: -1 };
  const byMessage: Map<string, ToolRead | null> = new Map();
  for (const group of groups) {
    const thread: "main" | "side" = group.record.isSidechain === true ? "side" : "main";
    const prior = previous[thread];
    const clean = prior !== null && prior.clean && onlyToolResults(records, { from: lastAt[thread] + 1, to: group.first, side: thread === "side" });
    const tokens = tokensOf(group.record.message.usage);
    byMessage.set(group.id, prior === null ? null : toolReadOf(prior, { window: windowOf(tokens), clean }));
    previous[thread] = { window: windowOf(tokens), output: tokens.output, tools: toolsCalled(records, group), clean: true };
    lastAt[thread] = group.last;
  }
  for (const thread of ["main", "side"] as const) {
    const last = previous[thread];
    if (last !== null) previous[thread] = { ...last, clean: (lastAt[thread] >= 0 || last.clean) && onlyToolResults(records, { from: lastAt[thread] + 1, to: end, side: thread === "side" }) };
  }
  return { byMessage, previous };
}

/** @param prior the message before @returns `null` when that message called no read tool */
function toolReadOf(prior: Previous, { window, clean }: { window: number; clean: boolean; }): ToolRead | null {
  if (!prior.tools.some((tool) => READ_TOOLS.includes(tool))) return null;
  const distinct = [...new Set(prior.tools)];
  const grown = window - prior.window - prior.output;
  return { tool: distinct.length === 1 ? (distinct[0] as "Read" | "Grep" | "Glob") : "mixed", tokens: clean && grown >= 0 ? grown : null };
}

/** For each position, the time of the last record before it that has one, in one pass (a search per message was quadratic in the file). */
function recordBefore(records: Rec[], priorAt: number | null) {
  let latest = priorAt;
  return records.map(({ at }) => {
    const before = latest;
    if (!Number.isNaN(at)) latest = at;
    return before;
  });
}

/** For each position, the time of the last ASSISTANT record before it (`priorAt` before the first one of this read), in one pass: where a tool call's run begins. */
function assistantBefore(records: Rec[], priorAt: number | null) {
  let latest = priorAt;
  return records.map(({ at, record }) => {
    const before = latest;
    if (record?.type === "assistant" && !Number.isNaN(at)) latest = at;
    return before;
  });
}

/**
 * How long the tool call that precedes the message at `first` ran: from `startedAt`, the last block of the message that made the call, to the latest tool result before this
 * message (parallel calls answer one by one). `null` when the records before the message are not tool results: a user record that is anything else (an order, a prompt) means
 * no tool ran, and nothing known about `startedAt` means nobody can say when it began. Records of other kinds (attachments, titles) are the harness's and are stepped over.
 * @param first position of the message's first block
 */
function toolMsBefore(records: Rec[], first: number, startedAt: number | null): number | null {
  let resultAt = Number.NaN;
  for (let position = first - 1; position >= 0 && records[position].record?.type !== "assistant"; position--) {
    const { at, record } = records[position];
    if (record?.type !== "user") continue;
    const answered = Array.isArray(record.message?.content) && record.message.content.some((block: { type?: string; }) => block?.type === "tool_result");
    if (!answered) return null;
    if (!Number.isNaN(at)) resultAt = Number.isNaN(resultAt) ? at : Math.max(resultAt, at);
  }
  return startedAt === null || Number.isNaN(resultAt) ? null : Math.max(0, resultAt - startedAt);
}

function compactionsOf(records: { index: number; at: number; record: any; }[], session: string, owner: Owner): TraceEvent[] {
  return records.filter(({ record }) => record?.isCompactSummary === true && !Number.isNaN(Date.parse(record.timestamp))).map(({ at }) => {
    const own = owner(at);
    return { id: `compaction:${session}:${at}`, kind: "compaction", source: "transcript", at, session, row: own.row, pr: own.pr, repo: own.repo, ...listedBy(own),
      cause: own.cause, causeKey: own.causeKey, wakeId: own.id };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// The store: one line per event id, idempotent

/** Bytes read from the store at a time. The file is never held as ONE string: V8 refuses a string past 2^29-24 characters, and the store crossed that at 537,274,044 bytes. */
const STORE_READ_CHUNK = 8 * 1024 * 1024;
const NEWLINE_BYTE = 0x0a;

/**
 * Every line of the file open at `fd`, in order, with whether a newline ended it (only the last can lack one). READ IN CHUNKS AND SPLIT ON THE NEWLINE BYTE
 * (0x0a never occurs inside a multi-byte UTF-8 sequence), so a line is decoded whole and the file's size is no limit. `line` is a view of the chunk: copy it to keep it.
 * @param chunkBytes a parameter so a test can make a line span chunks
 */
function eachLine(fd: number, take: (line: Buffer, terminated: boolean) => void, chunkBytes: number = STORE_READ_CHUNK): void {
  const chunk = Buffer.allocUnsafe(chunkBytes);
  let carry: Buffer = Buffer.alloc(0);
  for (let read = readSync(fd, chunk, 0, chunkBytes, null); read > 0; read = readSync(fd, chunk, 0, chunkBytes, null)) {
    let start = 0;
    for (let end = chunk.indexOf(NEWLINE_BYTE); end !== -1 && end < read; end = chunk.indexOf(NEWLINE_BYTE, start)) {
      take(carry.length > 0 ? Buffer.concat([carry, chunk.subarray(start, end)]) : chunk.subarray(start, end), true);
      carry = Buffer.alloc(0);
      start = end + 1;
    }
    carry = Buffer.concat([carry, chunk.subarray(start, read)]);
  }
  take(carry, false);
}

/**
 * The events in a store file: the LAST copy of an id is the event, at the position of its last copy. The file holds one line per id (`appendToStore` replaces a superseded
 * copy), but a file written before that, or by a writer that only appends (`otel-receiver.ts`), can carry an id twice, and this is what reads it right.
 * A line that does not parse THROWS, as it did when the file was one string: a store with a damaged line is reported, never read around.
 * @param chunkBytes a parameter so a test can make a line span chunks
 */
export function readStore(path: string, chunkBytes: number = STORE_READ_CHUNK): TraceEvent[] {
  if (!existsSync(path)) return [];
  const last = new Map<string, TraceEvent>();
  const fd = openSync(path, "r");
  try {
    eachLine(fd, (line) => {
      if (line.length === 0) return;
      const event = JSON.parse(line.toString("utf8"));
      last.delete(event.id); // delete then set: a map keeps the position of the FIRST set, and the event sits at its last copy
      last.set(event.id, event);
    }, chunkBytes);
  } finally {
    closeSync(fd);
  }
  return [...last.values()];
}

/**
 * The store, read ONCE: its events and where each id sits. A run that appends in several batches (the transcripts, then GitHub) shares one of these, so the
 * file is parsed once per run, not once per transcript (the shipped `appendEvents` re-parsed all of it on every call, about 20 GB of JSON for 1,247 transcripts).
 * @param read a parameter so a test can count the reads
 * @returns `at` is each id's index in `events`
 */
export function openStore(path: string, read: (path: string) => TraceEvent[] = readStore): { path: string; events: TraceEvent[]; at: Map<string, number>; } {
  const events = read(path);
  return { path, events, at: new Map(events.map((event, position) => [event.id, position])) };
}

const ID_PREFIX = Buffer.from('{"id":"');
const QUOTE_BYTE = 0x22;
const BACKSLASH_BYTE = 0x5c;

/**
 * The id of one stored line WITHOUT parsing the line into an event: an event is written `{"id":"...",...}`, so the id is the bytes up to the next quote. A line that does not start that
 * way, or whose id holds an escape, is parsed as JSON, so the answer never depends on the key order of the writer that wrote it.
 */
function idOfLine(line: Buffer): string {
  if (line.subarray(0, ID_PREFIX.length).equals(ID_PREFIX)) {
    const close = line.indexOf(QUOTE_BYTE, ID_PREFIX.length);
    if (close !== -1 && !line.subarray(ID_PREFIX.length, close).includes(BACKSLASH_BYTE)) return line.toString("utf8", ID_PREFIX.length, close);
  }
  const { id } = JSON.parse(line.toString("utf8"));
  if (typeof id !== "string") throw new Error(`a stored line carries no id: ${line.toString("utf8", 0, 120)}`);
  return id;
}

/** `ids` maps each id found on more than one line to the number of lines it is on; `extra` is the lines past the first of each, which is what `compact-store` removes. */
export type Duplicates = { lines: number; distinct: number; extra: number; ids: Map<string, number>; };

/**
 * The ids that appear on more than one line of a store file, and how many extra lines they hold: the count `readStore` hides, because it keeps the last copy of each id. It reads the file
 * in chunks and takes each line's id off its first bytes, never parsing a line into an event (the file is hundreds of megabytes and this runs on a clock). The unterminated end is a line a
 * writer is still writing, and is not counted. A missing file holds none.
 * @param chunkBytes a parameter so a test can make a line span chunks
 */
export function duplicateIds(path: string, chunkBytes: number = STORE_READ_CHUNK): Duplicates {
  const copies = new Map<string, number>();
  let lines = 0;
  if (existsSync(path)) {
    const fd = openSync(path, "r");
    try {
      eachLine(fd, (line, terminated) => {
        if (!terminated || line.length === 0) return;
        const id = idOfLine(line);
        lines += 1;
        copies.set(id, (copies.get(id) ?? 0) + 1);
      }, chunkBytes);
    } finally {
      closeSync(fd);
    }
  }
  const ids = new Map([...copies].filter(([, count]) => count > 1));
  return { lines, distinct: copies.size, extra: lines - copies.size, ids };
}

/** What Claude Code's own cost display reads a cache-read token at, per million (the stored value was priced at it until 2026-10-08, and `PRICES` holds the page's rate). */
export const CLIENT_CACHE_READ_RATE = 0.2;

export type CostBy = "day" | "row" | "cause" | "session";
export const COST_BY: CostBy[] = ["day", "row", "cause", "session"];
export type CostRow = { key: string; turns: number; unpriced: number; usd: number; usdAtClientRate: number; };

const NO_KEY = { row: "(no row)", cause: "(no cause)" };

/** The keys a turn is reported under. A turn on SEVERAL rows (`rows`, `row` null) is under each of them, as `DEFINITIONS` says, so the rows of a `--by row` are not to be added. */
function costKeys(event: TraceEvent, by: CostBy): string[] {
  if (by === "day") return [new Date(event.at).toISOString().slice(0, "YYYY-MM-DD".length)];
  if (by === "session") return [event.session];
  if (by === "cause") return [event.cause ?? NO_KEY.cause];
  if (event.row !== null) return [`#${event.row}`];
  return event.rows && event.rows.length > 0 ? event.rows.map((row) => `#${row}`) : [NO_KEY.row];
}

/**
 * The turns of a store summed by `day` (UTC), `row`, `cause` or `session`: each turn ONCE (the caller read through `readStore`) and priced from `PRICES` at the call, never from the stored
 * `costUsd` (a stored value that disagrees is not the one summed). `usdAtClientRate` is the same turns with every cache-read token priced at `CLIENT_CACHE_READ_RATE`, so the two differ by
 * the cache-read tokens times the gap between that rate and the model's own. A turn with no price (or no tokens) is counted in `unpriced` and adds no dollars, which is not the same as free.
 * @returns the rows by key, and the total, in which a turn counts once however many rows it is on
 */
export function costBy(events: TraceEvent[], by: CostBy, since: number | null = null): { rows: CostRow[]; total: CostRow; } {
  const sum = (key: string): CostRow => ({ key, turns: 0, unpriced: 0, usd: 0, usdAtClientRate: 0 });
  const total = sum("total");
  const rows = new Map<string, CostRow>();
  const add = (row: CostRow, usd: number | null, atClient: number | null) => {
    row.turns += 1;
    if (usd === null || atClient === null) row.unpriced += 1;
    else {
      row.usd += usd;
      row.usdAtClientRate += atClient;
    }
  };
  for (const event of events) {
    if (event.kind !== "turn" || (since !== null && event.at < since)) continue;
    const usd = event.tokens ? costOf(event.model, event.tokens) : null;
    const atClient = event.tokens ? costOf(event.model, event.tokens, CLIENT_CACHE_READ_RATE) : null;
    add(total, usd, atClient);
    for (const key of costKeys(event, by)) add(rows.get(key) ?? rows.set(key, sum(key)).get(key) as CostRow, usd, atClient);
  }
  const settled = (row: CostRow): CostRow => ({ ...row, usd: Math.round(row.usd * COST_PRECISION) / COST_PRECISION, usdAtClientRate: Math.round(row.usdAtClientRate * COST_PRECISION) / COST_PRECISION });
  return { rows: [...rows.values()].map(settled).sort((a, b) => a.key.localeCompare(b.key, "en", { numeric: true })), total: settled(total) };
}

/** What a store file holds: its lines, the ids among them, the lines a rewrite removes (all but the last copy of an id) and how many of those are of each `kind`. */
export type StoreCount = { lines: number; distinct: number; removed: number; byKind: Record<string, number>; };

const TAIL_POLLS = 100;
const TAIL_POLL_MS = 10;
/** A rewrite that finds the file replaced under it by another rewrite starts again, this many times, then says so. */
const REWRITE_ATTEMPTS = 3;

/** The bytes of `fd` from `from` to its end NOW, once the last of them is a newline: a writer's line is read whole, never as the half a read caught mid-write. */
function settledTail(fd: number, from: number): Buffer {
  let tail = Buffer.alloc(0);
  for (let poll = 0; poll < TAIL_POLLS; poll += 1) {
    tail = Buffer.alloc(fstatSync(fd).size - from);
    tail = tail.subarray(0, tail.length > 0 ? readSync(fd, tail, 0, tail.length, from) : 0);
    if (tail.length === 0 || tail[tail.length - 1] === NEWLINE_BYTE) return tail;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, TAIL_POLL_MS);
  }
  throw new Error(`the store ends in a line with no newline (${tail.length} bytes after byte ${from}) that was not completed in ${TAIL_POLLS * TAIL_POLL_MS} ms`);
}

/**
 * ONE PASS OF A REWRITE, or `null` when the file was replaced under it. The file is streamed once (a line is kept as its own bytes, not parsed and written again), each id keeps its
 * LAST copy at the position of that copy (what `readStore` gives it), `appended` is added as if it had been appended, and the result goes to a temp file in the same directory and is renamed
 * over the store.
 *
 * THE OTHER WRITER (`otel-receiver.ts` appends to this file with `appendFileSync` while the host runs) IS NOT LOST BY RE-READING, NOT BY A LOCK: the file is held open, so its old inode
 * stays readable after the rename, and what was appended past the bytes this pass consumed is read from it (a) when the temp file is written, and added to it, and (b) again after the
 * rename, where it is appended to the new file. The receiver is not changed and takes no lock, so a rewrite never stalls a request. What remains is a window of microseconds in (b):
 * an `appendFileSync` that opened the old file before the rename and writes after the sweep found nothing. A line appended by another process that is itself a copy of an id the pass
 * kept is added raw, so the id is on the file twice until the next rewrite, and `readStore` takes the later.
 */
function rewriteOnce(path: string, appended: string, dryRun: boolean, during: (stage: RewriteStage) => void): StoreCount | null {
  const fd = openSync(path, "r");
  const temp = `${path}.${process.pid}.tmp`;
  let renamed = false;
  try {
    const kept = new Map<string, { kind: string; line: Buffer | null; }>();
    const byKind: Record<string, number> = {};
    let removed = 0;
    const keep = (line: Buffer) => {
      if (line.length === 0) return;
      const event = JSON.parse(line.toString("utf8"));
      const earlier = kept.get(event.id);
      if (earlier) {
        kept.delete(event.id); // delete then set, as `readStore` does: the id sits at its last copy
        removed += 1;
        byKind[earlier.kind] = (byKind[earlier.kind] ?? 0) + 1;
      }
      kept.set(event.id, { kind: String(event.kind ?? "unknown"), line: dryRun ? null : Buffer.from(line) });
    };
    let consumed = 0; // the bytes up to and including the last newline that was read
    eachLine(fd, (line, terminated) => {
      if (!terminated) return; // the unterminated end is the tail's: a line a writer is still writing
      consumed += line.length + 1;
      keep(line);
    });
    during("scanned");
    for (const line of linesOf(Buffer.from(appended))) keep(line);
    const count = { lines: kept.size + removed, distinct: kept.size, removed, byKind };
    if (dryRun) return count;
    const out = openSync(temp, "w", fstatSync(fd).mode & 0o777);
    try {
      let pending: Buffer[] = [];
      let pendingBytes = 0;
      const flush = () => {
        writeFileSync(out, Buffer.concat(pending));
        pending = [];
        pendingBytes = 0;
      };
      for (const { line } of kept.values()) {
        pending.push(line as Buffer, Buffer.from("\n"));
        pendingBytes += (line as Buffer).length + 1;
        if (pendingBytes >= STORE_READ_CHUNK) flush();
      }
      flush();
      during("written");
      const late = settledTail(fd, consumed); // appended while the file was being read and the temp file written: after the lines above, before the rename
      writeFileSync(out, late);
      fsyncSync(out);
      consumed += late.length;
    } finally {
      closeSync(out);
    }
    if (statSync(path).ino !== fstatSync(fd).ino) return null; // another rewrite replaced the file: what it wrote is not in this pass
    renameSync(temp, path);
    renamed = true;
    during("renamed");
    const after = settledTail(fd, consumed); // a write that reached the old inode before the rename
    if (after.length > 0) appendFileSync(path, after);
    return count;
  } finally {
    closeSync(fd);
    if (!renamed) rmSync(temp, { force: true });
  }
}

/** Where a rewrite is, for a test that must append as the other writer would: after the file is read, after the temp file is written, after the rename. */
export type RewriteStage = "scanned" | "written" | "renamed";

/** The lines of a buffer of complete lines, each as bytes of its own. */
const linesOf = (bytes: Buffer): Buffer[] => bytes.toString("utf8").split("\n").map((line) => Buffer.from(line));

/**
 * Rewrite the store file so each id is on it ONCE, at the position of its last copy, and return what it held (`dryRun` counts and writes nothing). `appended` is text in the file's own
 * form (lines, each ending in a newline) to be added as if appended: how `appendToStore` lets a superseding copy replace the stored one. The ingest state's `storeBytes` is
 * restamped, because the file is smaller and a smaller store reads as deleted.
 * @param during a parameter so a test can append at each stage, as the receiver would
 */
export function rewriteStore(path: string, { appended = "", dryRun = false, during = () => {} }: { appended?: string; dryRun?: boolean; during?: (stage: RewriteStage) => void; } = {}): StoreCount {
  for (let attempt = 0; attempt < REWRITE_ATTEMPTS; attempt += 1) {
    const count = rewriteOnce(path, appended, dryRun, during);
    if (count === null) continue;
    if (!dryRun) restampStoreBytes(path);
    return count;
  }
  throw new Error(`${path} was replaced by another writer in each of ${REWRITE_ATTEMPTS} attempts to rewrite it: nothing was lost, run it again`);
}

/**
 * Add what an open store does not have, as ONE write. An event it already holds is left alone when the new copy is identical (a second call with the same events adds
 * nothing). A copy that DIFFERS supersedes it, and the superseded line does not stay on disk: the file is rewritten (`rewriteStore`) with each id once. A batch of only new ids is
 * a plain append that touches nothing already on disk. A correction is how a fix to the attribution of a turn reaches the turns stored before the fix: ids are stable, so without
 * it they would stay as first read.
 */
export function appendToStore(store: { path: string; events: TraceEvent[]; at: Map<string, number>; }, events: TraceEvent[]): { added: number; superseded: number; skipped: number; } {
  const fresh: TraceEvent[] = [];
  let superseded = 0;
  for (const event of events) {
    const held = store.at.get(event.id);
    if (held === undefined) {
      store.at.set(event.id, store.events.length);
      store.events.push(event); // one at a time, never push(...fresh): a cold run is tens of thousands of events, past the argument limit
      fresh.push(event);
    } else if (JSON.stringify(store.events[held]) !== JSON.stringify(event)) {
      store.events[held] = event;
      fresh.push(event);
      superseded += 1;
    }
  }
  if (fresh.length > 0) {
    const lines = fresh.map((event) => `${JSON.stringify(event)}\n`).join("");
    if (superseded > 0 && existsSync(store.path)) rewriteStore(store.path, { appended: lines });
    else {
      mkdirSync(dirname(store.path), { recursive: true });
      appendFileSync(store.path, lines);
    }
  }
  return { added: fresh.length - superseded, superseded, skipped: events.length - fresh.length };
}

const countLine = (label: string, count: StoreCount) => {
  const kinds = Object.entries(count.byKind).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([kind, lines]) => `${kind} ${lines}`).join(", ");
  return `${label}: ${count.lines} lines, ${count.distinct} distinct ids, ${count.removed} lines ${label === "before" ? "to remove" : "removable"}${kinds ? ` (by kind: ${kinds})` : ""}`;
};

/**
 * `compact-store`: the one-off that leaves ONE line per event id in a store written before `appendToStore` replaced a superseded copy (agent-org#475). It prints the lines, the distinct
 * ids, the lines it would remove and their count by kind; `dryRun` stops there and writes nothing. Otherwise it copies the store to `<store>.bak-<UTC date>` FIRST (refused when that
 * name exists: an earlier backup holds older bytes), rewrites, and prints the same counts read back from the new file. The rewrite restamps the ingest state's `storeBytes`.
 * @returns the lines to print
 */
export function compactStore({ store, dryRun, now = Date.now() }: { store: string; dryRun: boolean; now?: number; }): string[] {
  if (!existsSync(store)) throw new Error(`no store at ${store}`);
  const before = rewriteStore(store, { dryRun: true });
  const out = [countLine("before", before)];
  if (dryRun) return [...out, `dry run: ${before.removed} lines would be removed; nothing was written`];
  if (before.removed === 0) return [...out, "nothing to remove: the store was not rewritten and no backup was made"];
  const backup = `${store}.bak-${new Date(now).toISOString().slice(0, 10)}`;
  copyFileSync(store, backup, constants.COPYFILE_EXCL);
  out.push(`backup: ${backup}`);
  const done = rewriteStore(store);
  out.push(`rewritten: ${done.removed} lines removed`);
  return [...out, countLine("after", rewriteStore(store, { dryRun: true }))];
}

/** Open, append, done: for a caller with one batch. */
export const appendEvents = (path: string, events: TraceEvent[]) => appendToStore(openStore(path), events);

/**
 * The events about a subject: those of its rows, and of its pull requests (the ones that close the rows, and the one asked about when it IS a pull request).
 */
export function eventsForRow(events: TraceEvent[], { rows, prs }: { rows: number[]; prs: number[]; }): TraceEvent[] {
  const wantedRows = new Set(rows);
  const wantedPulls = new Set(prs);
  const about = (event: TraceEvent) => (event.row !== null && wantedRows.has(event.row)) || (event.pr !== null && event.repo === null && wantedPulls.has(event.pr))
    || [...(event.rows ?? []), ...(event.touchedRows ?? [])].some((row) => wantedRows.has(row)) || [...(event.prs ?? []), ...(event.touchedPrs ?? [])].some((pr) => wantedPulls.has(pr));
  return events.filter(about)
    .sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0) || a.id.localeCompare(b.id));
}
