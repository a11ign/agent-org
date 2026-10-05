// @ts-check
// a11ign/a11ign#3494, first slice: THE TRACE STORE -- one append-only record per event, keyed by row (and pull request, and repository).
//
// FOUR SOURCES TODAY, and each record says which: `source: "gh-ledger"` for one `gh` call (`gh-calls.mjs`, #3516), `source: "transcript"` for a model turn (`message.usage` of a Claude transcript, or a request of a Codex reviewer session,
// `codex-turns.mjs`, #3519, marked `harness: "codex"`), `source: "wake-ledger"` for the
// order the gate delivered, `source: "github"` for what GitHub saw of a row and its pull requests (`github-events.mjs`, #3508). The platform-first reading (posted on #3494) found Claude Code's OpenTelemetry carries tokens, `cost_usd` and per-request duration, but
// it has no file exporter, needs a receiver the host does not run, and cannot reach a standing seat that is already running. So the transcript is the source and
// OTel records can be added later under another `source` without changing a reader.
//
// WHAT IS MEASURED AND WHAT IS INFERRED, because the two wear the same clothes in a report:
//   tokens        MEASURED: the API's own `usage` for the message.
//   costUsd       COMPUTED from `PRICES`. Checked against Claude Code's own `cost_usd` on one Haiku and one Sonnet 5.5 request (exact to 7 places); the Fable 5.1,
//                 Opus 5.5, Opus 5 and Sonnet 5 rows are the published rates, not checked. A model with no row costs `null`, never 0 (a Codex model has none: no rate
//                 for it is sourced, a11ign/a11ign#3582).
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
  "EVENT: one record in the store, `kind` turn | wake | compaction, or one of GitHub's (`GITHUB_KINDS`). A record is never edited; running the ingest twice adds nothing, because every record has a stable `id`.",
  "TURN: one API message of a Claude session (de-duplicated by message id), with its tokens, cost and wall-clock. It belongs to the wake that precedes it in its transcript.",
  "WAKE: a delivery that started a model turn (wakes-per-row's definition). `deliveryLagMs` is delivery minus the time `wake` typed the order, when the ledger line pairs (not the gate's deferral, which no record keeps).",
  "WALL-CLOCK OF A TURN (inferred): from the record before its first block to its last block. A turn after a slow tool call includes that call.",
  "COST: tokens x the rate in PRICES, cache writes at the 1-hour rate when the split is absent (every transcript seen writes 1-hour). `null` for a model with no price.",
  "GITHUB EVENT: what GitHub's REST API holds of a row or pull request (`source: github`, session `github`): filed/opened, claimed/released (the claim-record comments), labeled/unlabeled for an order to a session or a hold, ready_for_review, reviewed (state, and the head it was posted on), head_moved, ci_run, added_to_merge_queue, removed_from_merge_queue, merged, closed.",
  "HEAD_MOVED (inferred): `at` is the commit's own date, not the push's; the timeline carries no push event. CI RUN: each head the timeline names is asked for its check-runs; the merge queue's own runs, on its temporary branch, and legacy commit statuses are not read.",
  "OUTCOME of a queue exit (inferred): `merged` when it falls within 5 s of the pull request's merge, else `unmerged` (an ejection or a person). GitHub writes the same event for both.",
  "KEY: row, pr and repo come from the order's cause key, else the session's name (worker-<n> is row n, reviewer-<n> is pull request n). An event with none is kept, with row null.",
  "SEVERAL ROWS (`rows`, `prs`): a cause key that lists rows (`row-call-count-signal/3125,3404`) puts the wake and its turns on EACH of them and leaves `row` null; a turn is then on every row it is listed under, so the cost of such a turn is in each of those rows' totals and the totals of two rows are not to be added.",
  "TOUCHED (`touchedRows`, `touchedPrs`, inferred): the rows and pull requests of the primary repository a turn WROTE to with `gh issue|pr edit|comment|close|reopen|ready|merge|review <n>`, read off the command text. A `gh issue view` is not a write; a command that names another clone or another `--repo`, and a `gh api` write, are not read. It puts a ruling's turn on the row ruled on when the order that woke the seat named another subject, or none (an order typed by `prompt:session` has no ledger line).",
  "CODEX TURN (`harness: codex`, `source: transcript`): one model request of a Codex reviewer session (`~/.codex/sessions`), keyed to the pull request in its name (`reviewer-<n>`), with tokens (`input` the uncached part, `cacheRead` the cached part, `output` including reasoning) and the model. `costUsd` is null: PRICES has no row for the model (no rate for a Codex model is sourced). Its wall-clock runs from the last record sent to the model.",
  "GH CALL (`kind: gh_call`, `source: gh-ledger`, #3516): one line of a `gh-calls.tsv` ledger (`host/gh`, #3466), with `account`, `resource` (`graphql`, `graphql?` for a call only inferred to spend that pool, `core`, `other`), `cost` (the points the RESPONSE carried, else null: most list calls carry none, so a null cost on a GraphQL call is a FLOOR of one point), `exit` (the call's exit status; `status` is a CI run's), `command` (its first two arguments), `workspace` and `script` (what the calling process was). KEYED BY THE LINE'S SESSION ID (#3589): `host/gh` writes `CLAUDE_CODE_SESSION_ID` (a Codex session's `CODEX_THREAD_ID`) on each call, which is the file name of its transcript, and a turn carries its transcript's id; a call is on that session and, through the session's next turn, on a row (`keyedBy: session`). A line with no id (a unit or script outside any session, or a line written before the wrapper named its session) is `unkeyed: script`; one whose session has no later turn in the store yet is `unkeyed: no-turn`; either way the call's session is `gh-ledger` and it has no row. A ledger keeps 2 MiB, so a call older than its trim is not in the store unless it was ingested first.",
  "SUPERSEDED: the store is an append-only log in which the LAST copy of an id is the event. A corrected copy of an event (a turn re-read after a fix to its attribution) is appended and supersedes the stored one; an identical copy adds nothing.",
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
  // The ids before 5.5 (a11ign/a11ign#3582). `costOf` takes the FIRST prefix that matches, so these stand after `-5-5` or they would price its turns. Rates: the claude-api
  // skill's model docs (2026-09-25): Opus 5 $5 / $25 with cache reads at 0.1x ("every other model", Opus 5.5 being 0.05x and Fable 5.1 0.025x), Sonnet 5 at Sonnet 5.5's
  // prices ($2 / $10, reads $0.20). Not reproduced against a `cost_usd`.
  { prefix: "claude-opus-5", input: 5, output: 25, cacheRead: 0.5, verified: false },
  { prefix: "claude-sonnet-5", input: 2, output: 10, cacheRead: 0.2, verified: false },
  { prefix: "claude-haiku-4-5", input: 1, output: 5, cacheRead: 0.1, verified: true },
];

/**
 * @typedef {{ input: number, output: number, cacheRead: number, cacheWrite5m: number, cacheWrite1h: number }} Tokens
 * @typedef {{ id: string, kind: "turn" | "wake" | "compaction" | "gh_call" | import("./github-events.mjs").GithubKind, source: "transcript" | "wake-ledger" | "github" | "gh-ledger", at: number, session: string, row: number | null,
 *   pr: number | null, repo: string | null, cause: string | null, causeKey: string | null, wakeId: string | null, model?: string, tokens?: Tokens,
 *   costUsd?: number | null, transcript?: string, wallClockMs?: number | null, deliveryLagMs?: number | null, bytes?: number, sidechain?: boolean, harness?: "codex",
 *   rows?: number[], prs?: number[], touchedRows?: number[], touchedPrs?: number[], actor?: string | null, seq?: number, claimant?: string, name?: string, state?: string | null, status?: string, headSha?: string, mergeSha?: string, startedAt?: number,
 *   completedAt?: number | null, outcome?: "merged" | "unmerged", account?: string, resource?: string, cost?: number | null, exit?: number, command?: string, workspace?: string,
 *   script?: string, sessionId?: string, keyedBy?: "session" | "time" | null, unkeyed?: "script" | "no-turn" }} TraceEvent
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
 * The rows or pull requests a cause key names when it names SEVERAL, as a comma list (`row-call-count-signal/3125,3404`): `subjectOf` keeps `row: null` for it,
 * because the first of the list is a guess, and an event the key names twice was about both. `{}` for a key that names one subject or none.
 * @param {string} key the ledger key, `<group>/<cause>/<subject...>`
 * @returns {{ rows?: number[], prs?: number[] }}
 */
export function subjectsOf(key) {
  const [, cause = "", ...rest] = key.split("/");
  const subject = rest.join("/").split("@deferred:")[0];
  const meaning = BARE_NUMBER_IS.get(cause);
  if (!meaning || !/^\d+(,\d+)+$/.test(subject)) return {};
  const numbers = subject.split(",").map(Number);
  return meaning === "row" ? { rows: numbers } : { prs: numbers };
}

/**
 * What a session's NAME says when the order's key says nothing: a spawned `worker-<n>` is row n and `reviewer-<n>` is pull request n.
 * @param {string} session @param {string} rowRepo
 */
export function subjectOfSession(session, rowRepo) {
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
 * A message whose last block is younger than this may still be gaining blocks, and its turn is built from the LAST one, so it is held back to the next run.
 * Measured 2026-10-04 on 80 transcripts (1,985 messages): the longest gap between two blocks of one message was 47 s, and blocks of one message are sometimes
 * separated by other records, so "a record follows it" does not settle a message and only its age does.
 */
export const QUIET_MS = 5 * 60 * 1000;

/** How long a consumed ledger line is remembered: it must exceed wakes-per-row's `LEDGER_LEAD_MS` (10 min), the window in which a later wake could claim it again. */
const LEDGER_MEMORY_MS = 60 * 60 * 1000;

/** @typedef {{ start: number, index: number, at: number, record: any }} Rec */

/**
 * @param {string} text one transcript, or the part of one that starts at a line boundary
 * @returns {{ records: Rec[], unreadable: number[], end: number, tail: number | null }} `start` is a byte offset into `text`; `unreadable` the start of each line that is not JSON;
 *   `tail` where a final line WITHOUT its newline begins when it is not JSON (a half-written line, to be read again), else `null`; `end` where the readable text ends
 */
export function readRecords(text) {
  /** @type {Rec[]} */
  const records = [];
  /** @type {number[]} */
  const unreadable = [];
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

/** @typedef {{ id: string, first: number, last: number, record: any }} MessageGroup */

/**
 * One group per `message.id`: the position of its first and last block (in `records`) and its last record, whose usage is final.
 * @param {Rec[]} records
 * @returns {MessageGroup[]}
 */
function messageGroups(records) {
  /** @type {Map<string, MessageGroup>} */
  const byMessage = new Map();
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
 * @param {{ records: Rec[], groups: MessageGroup[], end: number, now: number }} input
 * @returns {{ boundary: number, held: MessageGroup[], settleAt: number | null }}
 */
function settledBoundary({ records, groups, end, now }) {
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

/** @typedef {import("./ingest-state.mjs").Carry} Carry */

/** A Claude transcript's id is its file name (`<id>.jsonl`), and is what `CLAUDE_CODE_SESSION_ID` holds in the session that wrote it: the key `host/gh` writes on a `gh` call (#3589). @param {string} file */
const transcriptId = (file) => (file.split("/").pop() ?? file).replace(/\.jsonl$/, "");

/**
 * Every event one transcript holds, or the part of it from a resume point. A turn belongs to the latest wake before it; a turn before any wake belongs to the session
 * itself. `carry` is what the read before this one left (`null` for a read from byte 0), and the returned `carry` and `consumed` are what the next one starts from:
 * `consumed` is how many bytes of `text` are turned into events (the rest is a half-written line or a message that may still be gaining blocks), so a caller that
 * resumes at `consumed` sees every event exactly as one read of the whole file would have given it. `now` defaults to "nothing is young": a caller that reads
 * a finished file in one piece holds nothing back.
 * @param {{ text: string, file: string, ledger: import("../wakes-per-row.mjs").LedgerEntry[], rowRepo: string, carry?: Carry | null, now?: number }} input
 * @returns {{ session: string, events: TraceEvent[], unreadable: number, carry: Carry, consumed: number, held: number, settleAt: number | null, namedLate: boolean }}
 */
export function eventsOfTranscript({ text, file, ledger, rowRepo, carry = null, now = Number.POSITIVE_INFINITY }) {
  const { records, unreadable, end, tail } = readRecords(text);
  const groups = messageGroups(records);
  const { boundary, held, settleAt } = settledBoundary({ records, groups, end, now });
  const settled = records.filter(({ start }) => start < boundary);
  const wakeRecords = settled.filter(({ record }) => isWake(record) && !Number.isNaN(Date.parse(record.timestamp)));
  // The session's name is the first ORDER's, never a mention of one further down (a tool result can quote another session's brief).
  const named = wakeRecords.map(({ record }) => SESSION_NAME.exec(record.message.content)?.[1]).find(Boolean) ?? null;
  const session = carry?.session ?? named ?? `unnamed:${file.split("/").pop()}`;
  const wakes = wakeRecords.map(({ record }) => ({ at: Date.parse(record.timestamp), bytes: Buffer.byteLength(record.message.content), session }));
  const used = carry?.used ?? [];
  const free = ledger.filter((entry) => entry.session === session && !used.some((spent) => spent.at === entry.at && spent.key === entry.key));
  const paired = matchLedger(wakes, free);
  /** @type {TraceEvent[]} */
  const events = [];
  /** @type {NonNullable<Carry["owner"]>[]} */
  const placed = [];
  /** @type {{ at: number, key: string }[]} */
  const spent = [];
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
  const owner = (/** @type {number} */ at) => placed.findLast((wake) => wake.at <= at) ?? carry?.owner
    ?? { id: null, ...subjectOfSession(session, rowRepo), cause: null, causeKey: null };
  const priorAt = carry?.lastAt ?? null;
  events.push(...turnsOf({ records, groups: groups.filter((group) => !held.includes(group)), session, transcript: transcriptId(file), owner, priorAt, rowRepo }), ...compactionsOf(settled, session, owner));
  const lastAt = settled.findLast((candidate) => !Number.isNaN(candidate.at))?.at ?? priorAt;
  const remembered = [...used, ...spent].filter((entry) => latest === null || entry.at >= latest.at - LEDGER_MEMORY_MS);
  return {
    session, events, unreadable: unreadable.filter((start) => start < boundary || start === tail).length, consumed: boundary, held: held.length, settleAt,
    carry: { session: carry?.session ?? named, owner: latest, lastAt, used: remembered }, namedLate: carry !== null && carry.session === null && named !== null,
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
 * @param {Rec[]} blocks the records of one API message @param {string} rowRepo
 * @returns {{ touchedRows?: number[], touchedPrs?: number[] }}
 */
export function touchesOf(blocks, rowRepo) {
  const rows = new Set();
  const prs = new Set();
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

/** @typedef {(at: number) => { id: string | null, row: number | null, pr: number | null, repo: string | null, rows?: number[], prs?: number[], cause: string | null, causeKey: string | null }} Owner */

/** The several subjects a wake's key named, as event fields: present only when it named several, so an event with one subject is the shape it always was. @param {{ rows?: number[], prs?: number[] }} own */
const listedBy = ({ rows, prs }) => ({ ...(rows ? { rows } : {}), ...(prs ? { prs } : {}) });

/**
 * One turn per `message.id`, from its last record. `priorAt` is the time of the record before this read began, for the wall-clock of a turn that is the first thing in it.
 * @param {{ records: Rec[], groups: MessageGroup[], session: string, transcript: string, owner: Owner, priorAt: number | null, rowRepo: string }} input
 * @returns {TraceEvent[]}
 */
function turnsOf({ records, groups, session, transcript, owner, priorAt, rowRepo }) {
  const before = recordBefore(records, priorAt);
  return groups.map(({ id: messageId, first, last, record }) => {
    const endedAt = records[last].at;
    const previous = before[first];
    const tokens = tokensOf(record.message.usage);
    const own = owner(endedAt);
    return {
      id: `turn:${messageId}`, kind: "turn", source: "transcript", at: endedAt, session, transcript, row: own.row, pr: own.pr, repo: own.repo, ...listedBy(own), cause: own.cause,
      causeKey: own.causeKey, wakeId: own.id, model: record.message.model, tokens, costUsd: costOf(record.message.model, tokens),
      wallClockMs: previous !== null && !Number.isNaN(endedAt) ? Math.max(0, endedAt - previous) : null, sidechain: record.isSidechain === true,
      ...touchesOf(records.slice(first, last + 1).filter(({ record: block }) => block?.message?.id === messageId), rowRepo),
    };
  });
}

/** For each position, the time of the last record before it that has one, in one pass (a search per message was quadratic in the file). @param {Rec[]} records @param {number | null} priorAt */
function recordBefore(records, priorAt) {
  let latest = priorAt;
  return records.map(({ at }) => {
    const before = latest;
    if (!Number.isNaN(at)) latest = at;
    return before;
  });
}

/** @param {{ index: number, at: number, record: any }[]} records @param {string} session @param {Owner} owner @returns {TraceEvent[]} */
function compactionsOf(records, session, owner) {
  return records.filter(({ record }) => record?.isCompactSummary === true && !Number.isNaN(Date.parse(record.timestamp))).map(({ at }) => {
    const own = owner(at);
    return { id: `compaction:${session}:${at}`, kind: "compaction", source: "transcript", at, session, row: own.row, pr: own.pr, repo: own.repo, ...listedBy(own),
      cause: own.cause, causeKey: own.causeKey, wakeId: own.id };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// The store: append-only, idempotent

/**
 * The events in a store file. The file is an append-only LOG: an event whose attribution was later corrected (`appendToStore`) is on it twice, and the LAST copy of an id
 * is the event, at the position of its last copy.
 * @param {string} path @returns {TraceEvent[]}
 */
export function readStore(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const last = new Map(lines.map((event, position) => [event.id, position]));
  return lines.filter((event, position) => last.get(event.id) === position);
}

/**
 * The store, read ONCE: its events and where each id sits. A run that appends in several batches (the transcripts, then GitHub) shares one of these, so the
 * file is parsed once per run, not once per transcript (the shipped `appendEvents` re-parsed all of it on every call, about 20 GB of JSON for 1,247 transcripts).
 * @param {string} path @param {(path: string) => TraceEvent[]} [read] a parameter so a test can count the reads
 * @returns {{ path: string, events: TraceEvent[], at: Map<string, number> }} `at` is each id's index in `events`
 */
export function openStore(path, read = readStore) {
  const events = read(path);
  return { path, events, at: new Map(events.map((event, position) => [event.id, position])) };
}

/**
 * Append what an open store does not have, as ONE write. An event it already holds is left alone when the new copy is identical (a second call with the same events adds
 * nothing); a copy that DIFFERS supersedes it: it is appended, and `readStore` takes the last copy of an id. Nothing already on disk is rewritten. A correction is how a
 * fix to the attribution of a turn reaches the turns stored before the fix: ids are stable, so without it they would stay as first read.
 * @param {{ path: string, events: TraceEvent[], at: Map<string, number> }} store @param {TraceEvent[]} events
 * @returns {{ added: number, superseded: number, skipped: number }}
 */
export function appendToStore(store, events) {
  /** @type {TraceEvent[]} */
  const fresh = [];
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
    mkdirSync(dirname(store.path), { recursive: true });
    appendFileSync(store.path, fresh.map((event) => `${JSON.stringify(event)}\n`).join(""));
  }
  return { added: fresh.length - superseded, superseded, skipped: events.length - fresh.length };
}

/** Open, append, done: for a caller with one batch. @param {string} path @param {TraceEvent[]} events */
export const appendEvents = (path, events) => appendToStore(openStore(path), events);

/**
 * The events about a subject: those of its rows, and of its pull requests (the ones that close the rows, and the one asked about when it IS a pull request).
 * @param {TraceEvent[]} events @param {{ rows: number[], prs: number[] }} subject
 * @returns {TraceEvent[]}
 */
export function eventsForRow(events, { rows, prs }) {
  const wantedRows = new Set(rows);
  const wantedPulls = new Set(prs);
  const about = (/** @type {TraceEvent} */ event) => (event.row !== null && wantedRows.has(event.row)) || (event.pr !== null && event.repo === null && wantedPulls.has(event.pr))
    || [...(event.rows ?? []), ...(event.touchedRows ?? [])].some((row) => wantedRows.has(row)) || [...(event.prs ?? []), ...(event.touchedPrs ?? [])].some((pr) => wantedPulls.has(pr));
  return events.filter(about)
    .sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0) || a.id.localeCompare(b.id));
}
