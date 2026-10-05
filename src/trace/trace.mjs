#!/usr/bin/env node
// @ts-check
// command: trace -- every model turn, wake and GitHub event of one row, in order (a11ign/a11ign#3494, first and second slices).
//
// `agent-org trace -- <row-or-pr> [--since <ISO>] [--store <path>] [--json 1]`, and `agent-org trace -- --aggregate [--since <ISO>] [--calls <n>] [--store <path>] [--json 1]` (`aggregate.mjs`, #3513)
//
// It does three things in order: INGEST the Claude transcripts, the Codex reviewers' sessions and the wake ledger, INGEST what GitHub saw of the row and its pull requests (`github-events.mjs`),
// then PRINT the events about the row. Each ingest appends only the events the store does not have, so running it twice, or for two rows, adds nothing the first did
// not. What the store does NOT hold is named in the footer of every report so the absence is not read as "nothing happened": deferral spans,
// and from when each kind of actor's transcripts and each account's `gh` calls are held. The `gh` call ledgers are ingested beside the transcripts (`gh-calls.mjs`, #3516).
//
// GITHUB IS READ THROUGH `gh api` ONLY (the REST pool), to learn which rows a pull request closes and which pull requests close a row, and then for the events
// themselves. The calls are counted and the report says how many were made.
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { measure, mergedRows, parseLedger, readInstances, readTranscripts, rowsClosedBy } from "../wakes-per-row.mjs";
import { aggregate, claimsOf, renderAggregate, weekStart } from "./aggregate.mjs";
import { eventsOfCodexSession } from "./codex-turns.mjs";
import { ghCallLines, ghIngestLines, ingestGhCalls } from "./gh-calls.mjs";
import { countingGh, readGithubEvents } from "./github-events.mjs";
import { fingerprint, HEAD_BYTES, loadState, planRead, saveState, stateFileFor } from "./ingest-state.mjs";
import { appendToStore, DEFINITIONS, eventsForRow, eventsOfTranscript, openStore, readStore } from "./store.mjs";

/** @typedef {import("./ingest-state.mjs").FileState} FileState
 * @typedef {import("./ingest-state.mjs").IngestState} IngestState
 * @typedef {import("./ingest-state.mjs").Carry} Carry */

const DEFAULT_SINCE_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WEEK_DAYS = 7;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const GH_MAX_BUFFER = 64 * 1024 * 1024;
const SEARCH_PAGE = 100;
const SEARCH_RESULT_CAP = 1000; // GitHub's search returns no more than this many results of one query, however many pages are asked for
const LIST_MAX_PAGES = 30;
const BUDGET_SPENT = "GH_CALLS_SPENT";
const COST_DECIMALS = 4;
const SHORT_SHA = 7;
const CODEX_DEPTH = 3; // sessions/<year>/<month>/<day>/rollout-*.jsonl
const AGGREGATE_FLAG = "--aggregate";
const DEFAULT_GITHUB_CALLS = 1500; // a third of the REST pool an hour: the pool is the whole org's, and a second run continues where this one stopped
const DEFAULT_AGGREGATE_WEEKS = 4; // the weeks before this one that `--aggregate` reads when `--since` is not given

/** What this slice does not hold. Printed under every report. */
export const NOT_HELD = "NOT IN THIS STORE YET: the gate's deferral spans, the transcripts of Claude Code subagents (`<session>/subagents/`, one level below the sessions read).";

/** @param {string[]} argv */
export function parseArgs(argv) {
  const [first, ...rest] = argv[0] === "--" ? argv.slice(1) : argv;
  const number = Number(first);
  if (!Number.isInteger(number) || number <= 0) throw new Error("usage: trace -- <row-or-pr number> [--since <ISO>] [--store <path>] [--json 1]");
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 0; index < rest.length; index += 2) flags[rest[index].replace(/^--/, "")] = rest[index + 1];
  const since = flags.since ? Date.parse(flags.since) : Date.now() - DEFAULT_SINCE_DAYS * MS_PER_DAY;
  if (Number.isNaN(since)) throw new Error(`--since must be an ISO time (got ${flags.since})`);
  return { number, since, store: flags.store ?? defaultStore(), json: flags.json === "1" };
}

/**
 * `trace -- --aggregate [--since <ISO>] [--calls <n>] [--store <path>] [--json 1]`: the weekly token-efficiency report. `--since` is rounded down to its Monday 00:00 UTC, so the first week is a
 * whole one; without it the report starts four weeks before the current one.
 * @param {string[]} argv
 */
export function parseAggregateArgs(argv) {
  const rest = (argv[0] === "--" ? argv.slice(1) : argv).filter((word) => word !== AGGREGATE_FLAG);
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 0; index < rest.length; index += 2) flags[rest[index].replace(/^--/, "")] = rest[index + 1];
  const requested = flags.since ? Date.parse(flags.since) : weekStart(Date.now()) - DEFAULT_AGGREGATE_WEEKS * WEEK_DAYS * MS_PER_DAY;
  if (Number.isNaN(requested)) throw new Error(`--since must be an ISO time (got ${flags.since})`);
  const budget = flags.calls === undefined ? DEFAULT_GITHUB_CALLS : Number(flags.calls);
  if (!Number.isInteger(budget) || budget < 0) throw new Error(`--calls must be a whole number of gh api calls (got ${flags.calls})`);
  return { since: weekStart(requested), store: flags.store ?? defaultStore(), json: flags.json === "1", budget };
}

/** @param {string[]} argv */
export const isAggregate = (argv) => argv.includes(AGGREGATE_FLAG);

/** The `gh` call ledgers `host/gh` writes (#3466): one per account, in the config directory the wrapper routes that account to. An account that never called has none, and the ingest says so. */
const ghLedgerFiles = () => [join(homedir(), "workers", "gh"), join(homedir(), "leads", "gh"), join(homedir(), ".config", "gh")].map((dir) => join(dir, "gh-calls.tsv"));

const defaultStore = () => join(homedir(), ".cache", "a11ign", "trace", "events.ndjson");

/**
 * @typedef {{ read: number, codexRead: number, unchanged: number, bytesRead: number, unreadableLines: number, failed: string[], reread: string[], heldBack: number, added: number,
 *   coldStart: string | null, firstRunAt: number, firstRunSince: number, ghCalls?: import("./gh-calls.mjs").GhCallsReport }} IngestReport
 */

/** Read `[start, end)` of a file, counting what was read: the report says how many bytes a run touched, so "only what changed" is a measurement. @param {string} file @param {number} start @param {number} end @param {{ bytes: number }} meter */
function readRange(file, start, end, meter) {
  const buffer = Buffer.alloc(Math.max(0, end - start));
  const descriptor = openSync(file, "r");
  try {
    readSync(descriptor, buffer, 0, buffer.length, start);
  } finally {
    closeSync(descriptor);
  }
  meter.bytes += buffer.length;
  return buffer;
}

/** A file that vanished between the listing and the stat is not a transcript to read; any other failure is real and throws. @param {string} path */
function statOrNull(path) {
  try {
    return statSync(path);
  } catch (cause) {
    if (/** @type {NodeJS.ErrnoException} */ (cause).code === "ENOENT") return null;
    throw cause;
  }
}

/**
 * The `.jsonl` files exactly `depth` directories under `root`, modified since `since`. Claude Code keeps a session at `projects/<project>/<id>.jsonl` (depth 1, and its
 * `<id>/subagents/` files, deeper, are not read); Codex at `sessions/<year>/<month>/<day>/rollout-*.jsonl` (depth 3).
 * @param {string} root @param {number} since @param {number} depth
 * @returns {{ file: string, stat: import("node:fs").Stats }[]}
 */
function transcriptsSince(root, since, depth) {
  /** @type {{ file: string, stat: import("node:fs").Stats }[]} */
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (depth > 0 && entry.isDirectory()) found.push(...transcriptsSince(path, since, depth - 1));
    if (depth === 0 && entry.name.endsWith(".jsonl")) {
      const stat = statOrNull(path);
      if (stat && stat.mtimeMs >= since) found.push({ file: path, stat });
    }
  }
  return found;
}

/** The two kinds of session file, and how each is read: a Codex session has no wake, no ledger line and no message held back. */
const READERS = {
  /** @param {Parameters<typeof eventsOfTranscript>[0]} input */
  claude: ({ text, file, ledger, rowRepo, carry, now }) => eventsOfTranscript({ text, file, ledger, rowRepo, carry, now }),
  /** @param {Parameters<typeof eventsOfCodexSession>[0]} input */
  codex: ({ text, file, rowRepo, carry }) => ({ ...eventsOfCodexSession({ text, file, rowRepo, carry }), held: 0, settleAt: null, namedLate: false }),
};

/**
 * Read one transcript from where the state says to, and say what the state becomes: `null` when nothing is to be read. A transcript the state cannot be trusted for
 * is read from byte 0 and `reread` says why.
 * @param {{ file: string, kind: keyof typeof READERS, stat: { size: number, mtimeMs: number }, entry: FileState | undefined, ledger: import("../wakes-per-row.mjs").LedgerEntry[],
 *   rowRepo: string, now: number }} input @param {{ bytes: number }} meter
 */
function readTranscript({ file, kind, stat, entry, ledger, rowRepo, now }, meter) {
  const headMatches = () => !entry || fingerprint(readRange(file, 0, entry.headBytes, meter)) === entry.headHash;
  const plan = planRead({ entry, stat, now, headMatches });
  if (plan.action === "skip") return null;
  const readFrom = (/** @type {number} */ start, /** @type {Carry | null} */ carry) => {
    const bytes = readRange(file, start, stat.size, meter);
    return { bytes, start, result: /** @type {any} */ (READERS[kind])({ text: bytes.toString("utf8"), file, ledger, rowRepo, carry, now }) };
  };
  let reread = plan.reason;
  let pass = plan.action === "resume" && entry ? readFrom(entry.offset, entry.carry) : readFrom(0, null);
  if (pass.result.namedLate) { // the order that names the session came after turns already read under `unnamed:`
    reread = "its session was named by an order after turns it had already read";
    pass = readFrom(0, null);
  }
  const { bytes, start, result } = pass;
  const head = start === 0 ? bytes.subarray(0, Math.min(HEAD_BYTES, result.consumed)) : null;
  return { result, reread: reread ? `${file}: ${reread}` : null, next: /** @type {FileState} */ ({
    offset: start + result.consumed, size: stat.size, mtimeMs: stat.mtimeMs, firstReadAt: entry?.firstReadAt ?? now, settleAt: result.settleAt, carry: result.carry,
    headBytes: head ? head.length : (entry?.headBytes ?? 0), headHash: head ? fingerprint(head) : (entry?.headHash ?? fingerprint(Buffer.alloc(0))),
  }) };
}

/**
 * Ingest the transcripts modified since `since` that gained bytes since the state last saw them. Their events are appended to the open store as ONE batch, and the
 * state returned is to be saved AFTER that append: a run killed in between leaves a state older than the store, which costs a re-read and no more. A file that cannot
 * be read is listed, never skipped quietly.
 * @param {{ root: string, codexRoot?: string | null, since: number, ledger: import("../wakes-per-row.mjs").LedgerEntry[], rowRepo: string, store: ReturnType<typeof openStore>,
 *   state: IngestState, coldStart?: string | null, now?: number }} input
 * @returns {IngestReport & { state: IngestState }}
 */
export function ingest({ root, codexRoot = null, since, ledger, rowRepo, store, state, coldStart = null, now = Date.now() }) {
  const meter = { bytes: 0 };
  const files = { ...state.files };
  /** @type {import("./store.mjs").TraceEvent[]} */
  const batch = [];
  /** @type {string[]} */
  const failed = [];
  /** @type {string[]} */
  const reread = [];
  const counts = { read: 0, unchanged: 0, unreadableLines: 0, heldBack: 0, codexRead: 0 };
  const sources = [{ kind: /** @type {const} */ ("claude"), files: transcriptsSince(root, since, 1) },
    ...(codexRoot && existsSync(codexRoot) ? [{ kind: /** @type {const} */ ("codex"), files: transcriptsSince(codexRoot, since, CODEX_DEPTH) }] : [])];
  for (const { kind, file, stat } of sources.flatMap((source) => source.files.map((found) => ({ kind: source.kind, ...found })))) {
    try {
      const done = readTranscript({ file, kind, stat, entry: state.files[file], ledger, rowRepo, now }, meter);
      if (!done) {
        counts.unchanged += 1;
        continue;
      }
      for (const event of done.result.events) batch.push(event);
      counts.unreadableLines += done.result.unreadable;
      counts.heldBack += done.result.held;
      if (done.reread) reread.push(done.reread);
      files[file] = done.next;
      counts.read += 1;
      if (kind === "codex") counts.codexRead += 1;
    } catch (cause) {
      failed.push(`${file}: ${/** @type {Error} */ (cause).message}`);
    }
  }
  const { added } = appendToStore(store, batch);
  return { ...counts, bytesRead: meter.bytes, failed, reread, added, coldStart, firstRunAt: state.firstRunAt, firstRunSince: state.firstRunSince, state: { ...state, files } };
}

/**
 * One run's ingest half: open the store (the one read of it), load the state, ingest the transcripts and then the `gh` call ledgers (whose calls are keyed to the turns just read), and save the
 * state once the events are in. The state is saved even when a file failed, because the files that did not fail were read.
 * @param {{ root: string, codexRoot?: string | null, since: number, ledger: import("../wakes-per-row.mjs").LedgerEntry[], rowRepo: string, storePath: string, ghLedgers?: string[], now?: number }} input
 * @param {(path: string) => import("./store.mjs").TraceEvent[]} [readEvents] a parameter so a test can count the reads of the store
 */
export function ingestTranscripts({ root, codexRoot = null, since, ledger, rowRepo, storePath, ghLedgers = [], now = Date.now() }, readEvents = readStore) {
  const store = openStore(storePath, readEvents);
  const statePath = stateFileFor(storePath);
  const { state, coldStart } = loadState({ statePath, storePath, now, since });
  const { state: afterTranscripts, ...report } = ingest({ root, codexRoot, since, ledger, rowRepo, store, state, coldStart, now });
  const calls = ghLedgers.length > 0 ? ingestGhCalls({ ledgers: ghLedgers, store, state: afterTranscripts, now }) : null;
  saveState(statePath, { ...(calls?.state ?? afterTranscripts), storeBytes: existsSync(storePath) ? statSync(storePath).size : 0 });
  return { store, report: calls ? { ...report, ghCalls: calls.report } : report };
}

/**
 * What `number` is about, by `gh api` on the REST pool: when it is a pull request, the rows it closes; when it is a row, itself; and in both cases every pull request
 * that closes one of those rows. A call that fails THROWS: an empty answer from a failed call would print a trace that silently lacks the standing leads' turns.
 * @param {number} number @param {string} rowRepo @param {(args: string[]) => any} [gh] `gh api <args>` parsed; a parameter so a test can hand it a fixture
 * @returns {{ rows: number[], prs: number[] }}
 */
export function resolveSubject(number, rowRepo, gh = ghApi) {
  const pull = askPull(number, rowRepo, gh);
  const rows = pull ? rowsClosedBy(pull.body ?? "", rowRepo) : [number];
  const prs = new Set(pull ? [number] : []);
  for (const row of rows) {
    const found = gh(["-X", "GET", "search/issues", "-f", `q=repo:${rowRepo} is:pr ${row} in:body`, "-f", `per_page=${SEARCH_PAGE}`]);
    for (const candidate of found.items ?? []) if (rowsClosedBy(candidate.body ?? "", rowRepo).includes(row)) prs.add(candidate.number);
  }
  return { rows, prs: [...prs] };
}

/** @param {string[]} args */
function ghApi(args) {
  return JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: GH_MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] }));
}

/** The pull request numbered `number`, or `null` on a 404 (it is a row); any other failure throws. @param {number} number @param {string} rowRepo @param {(args: string[]) => any} gh */
function askPull(number, rowRepo, gh) {
  try {
    return gh([`repos/${rowRepo}/pulls/${number}`]);
  } catch (cause) {
    if (!/404|Not Found/.test(String(/** @type {any} */ (cause).stderr ?? cause))) throw cause;
    return null;
  }
}

/** @param {number} ms */
function clock(ms) {
  const seconds = Math.round(ms / MS_PER_SECOND);
  return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m${String(seconds % SECONDS_PER_MINUTE).padStart(2, "0")}s`;
}

/** @param {import("./store.mjs").Tokens} tokens */
const tokenLine = (tokens) => `in ${tokens.input} out ${tokens.output} read ${tokens.cacheRead} write ${tokens.cacheWrite5m + tokens.cacheWrite1h}`;

/** @type {Record<string, (event: import("./store.mjs").TraceEvent) => string>} */
const GITHUB_DETAIL = {
  filed: (event) => `FILED   row #${event.row} by ${event.actor}`,
  opened: (event) => `OPENED  pull request #${event.pr} by ${event.actor}`,
  claimed: (event) => `CLAIMED by ${event.claimant}`,
  released: (event) => `RELEASED by ${event.claimant}`,
  labeled: (event) => `LABEL   + ${event.name} by ${event.actor}`,
  unlabeled: (event) => `LABEL   - ${event.name} by ${event.actor}`,
  ready_for_review: (event) => `READY   for review by ${event.actor}`,
  reviewed: (event) => `REVIEW  ${event.state} by ${event.actor} at head ${event.headSha?.slice(0, SHORT_SHA)}`,
  head_moved: (event) => `HEAD    ${event.headSha?.slice(0, SHORT_SHA)}`,
  ci_run: (event) => `CI      ${event.name} ${event.state ?? event.status}${event.completedAt ? ` in ${clock(Math.max(0, event.completedAt - (event.startedAt ?? event.completedAt)))}` : ""} at head ${event.headSha?.slice(0, SHORT_SHA)}`,
  added_to_merge_queue: (event) => `QUEUED  by ${event.actor}`,
  removed_from_merge_queue: (event) => `DEQUEUED (${event.outcome})`,
  merged: (event) => `MERGED  by ${event.actor}`,
  closed: (event) => `CLOSED  ${event.row === null ? `pull request #${event.pr}` : `row #${event.row}`} by ${event.actor}`,
};

/** @param {import("./store.mjs").TraceEvent} event */
const githubDetail = (event) => (GITHUB_DETAIL[event.kind] ?? (() => event.kind))(event);

/**
 * @param {import("./store.mjs").TraceEvent} event
 * @returns {string}
 */
function line(event) {
  const when = new Date(event.at).toISOString().slice(0, "YYYY-MM-DDTHH:MM:SS".length).replace("T", " ");
  const who = event.session.padEnd(18);
  if (event.source === "github") return `${when}  ${who} ${githubDetail(event)}`;
  if (event.kind === "turn" && event.tokens) {
    const cost = event.costUsd === null || event.costUsd === undefined ? "$?" : `$${event.costUsd.toFixed(COST_DECIMALS)}`;
    const wall = event.wallClockMs === null || event.wallClockMs === undefined ? "?" : clock(event.wallClockMs);
    return `${when}  ${who} turn   ${wall.padStart(7)}  ${cost.padStart(8)}  ${tokenLine(event.tokens)}  ${event.model}${event.sidechain ? " (subagent)" : ""}`;
  }
  if (event.kind === "wake") {
    const lag = event.deliveryLagMs === null || event.deliveryLagMs === undefined ? "" : `  lag ${clock(event.deliveryLagMs)}`;
    return `${when}  ${who} WAKE   ${event.causeKey ?? "(no ledger line)"}${lag}`;
  }
  return `${when}  ${who} COMPACTION`;
}

/** @param {import("./store.mjs").TraceEvent} event the session as one line of the totals: `reviewer-3406` run by Codex is not `reviewer-3406` run by Claude Code */
const actorOf = (event) => `${event.session}${event.harness === "codex" ? " (codex)" : ""}`;

/** The KIND of actor, for "since when do we hold its transcripts": a worker or reviewer per row is one kind. @param {import("./store.mjs").TraceEvent} event */
function kindOfActor(event) {
  const kind = /^(worker|reviewer)-/.test(event.session) ? event.session.split("-")[0] : event.session.replace(/^unnamed:.*/, "unnamed (no order named it)").replace(/^codex:.*/, "other directory");
  return `${kind}${event.harness === "codex" ? " (codex)" : ""}`;
}

/** One line per actor of the row: its turns, its priced cost, and its output tokens. @param {import("./store.mjs").TraceEvent[]} turns */
function actorTotals(turns) {
  /** @type {Map<string, { turns: number, priced: number, cost: number, output: number }>} */
  const byActor = new Map();
  for (const turn of turns) {
    const total = byActor.get(actorOf(turn)) ?? { turns: 0, priced: 0, cost: 0, output: 0 };
    total.turns += 1;
    total.output += turn.tokens?.output ?? 0;
    if (typeof turn.costUsd === "number") {
      total.priced += 1;
      total.cost += turn.costUsd;
    }
    byActor.set(actorOf(turn), total);
  }
  return [...byActor].map(([actor, t]) => `  ${actor.padEnd(26)} ${String(t.turns).padStart(4)} turns  $${t.cost.toFixed(COST_DECIMALS)} over ${t.priced} priced  out ${t.output}`);
}

/** The earliest turn or wake the store holds, per kind of actor, over the whole store: an absence before it is "not read", never "nothing happened". @param {import("./store.mjs").TraceEvent[]} everything */
function heldFrom(everything) {
  /** @type {Map<string, number>} */
  const first = new Map();
  for (const event of everything) {
    if (event.source === "github" || event.source === "gh-ledger") continue;
    const kind = kindOfActor(event);
    first.set(kind, Math.min(first.get(kind) ?? Number.POSITIVE_INFINITY, event.at));
  }
  const iso = (/** @type {number} */ ms) => new Date(ms).toISOString().slice(0, "YYYY-MM-DDTHH:MM".length);
  return [...first].sort(([, a], [, b]) => a - b).map(([kind, at]) => `  ${kind.padEnd(28)} held from ${iso(at)}Z`);
}

/** The transcript half of the footer: what this run read, and from when the state holds the transcripts, so an absence before that is not read as "nothing happened". @param {IngestReport} ingested */
function ingestLines(ingested) {
  const iso = (/** @type {number} */ ms) => new Date(ms).toISOString().slice(0, "YYYY-MM-DDTHH:MM".length);
  const lines = [`ingested ${ingested.read} transcripts (${ingested.bytesRead} bytes read; ${ingested.unchanged} unchanged since the last run); ${ingested.unreadableLines} unreadable lines; `
    + `${ingested.failed.length} files failed${ingested.failed.map((f) => `\n  ${f}`).join("")}`];
  lines.push(`${ingested.codexRead} of those were Codex reviewer sessions (read from ~/.codex/sessions, never written)`);
  if (ingested.coldStart) lines.push(`COLD START (every transcript in the window read from its first byte): ${ingested.coldStart}`);
  for (const reason of ingested.reread) lines.push(`read again from byte 0: ${reason}`);
  if (ingested.heldBack > 0) lines.push(`${ingested.heldBack} messages written in the last 5 minutes are held back to the next run (a message may still be gaining blocks, and its turn is built from the last)`);
  if (ingested.ghCalls) lines.push(...ghIngestLines(ingested.ghCalls));
  lines.push(`TRANSCRIPT STATE: holds each transcript from the run that first read it, the first run being ${iso(ingested.firstRunAt)}Z over transcripts modified after ${iso(ingested.firstRunSince)}Z. `
    + "A transcript is read from its first byte then, but one last modified before that window is not in the store: absence before it is not \"nothing happened\".");
  return lines;
}

/**
 * The report for one row's events, as text.
 * @param {{ number: number, rows: number[], prs: number[], events: import("./store.mjs").TraceEvent[], ingest?: IngestReport,
 *   github?: { calls: number, read: number, added: number }, held?: import("./store.mjs").TraceEvent[] }} input `held` is every event of the store, for the footer's "held from"
 */
export function render({ number, rows, prs, events: found, ingest: ingested, github, held }) {
  const events = found.filter((event) => event.source !== "gh-ledger"); // a row can hold thousands of calls: they are summarised below, never one line each
  const turns = events.filter((event) => event.kind === "turn");
  const priced = turns.filter((event) => typeof event.costUsd === "number");
  const total = priced.reduce((sum, event) => sum + (event.costUsd ?? 0), 0);
  const sessions = [...new Set(events.filter((event) => event.source !== "github").map((event) => event.session))];
  const fromGithub = events.filter((event) => event.source === "github").length;
  const named = [rows.length > 0 ? `rows: ${rows.map((row) => `#${row}`).join(", ")}` : "", prs.length > 0 ? `pull requests: ${prs.map((pr) => `#${pr}`).join(", ")}` : ""].filter(Boolean);
  const out = [`TRACE #${number}${named.length > 0 ? `  (${named.join("; ")})` : ""}`];
  if (events.length === 0) out.push("no events: nothing in the store names this row or its pull requests within the ingested window (widen it with --since).");
  for (const event of events) out.push(line(event));
  out.push("", `${events.length} events (${fromGithub} from GitHub), ${turns.length} turns across ${sessions.length} sessions (${sessions.join(", ")})`);
  out.push(`cost $${total.toFixed(COST_DECIMALS)} over ${priced.length} priced turns; ${turns.length - priced.length} turns have a model with no price and are NOT in that total`);
  if (turns.length > 0) out.push("per actor on this row:", ...actorTotals(turns));
  if (ingested) out.push(...ingestLines(ingested));
  if (held) out.push("TRANSCRIPTS HELD, per actor (the earliest turn or wake in the store; Claude Code sessions and Codex reviewer sessions):", ...heldFrom(held));
  out.push(...ghCallLines({ events: found, held }));
  if (github) out.push(`GitHub: ${github.calls} REST calls (gh api); ${github.read} events read, ${github.added} new to the store`);
  out.push(NOT_HELD, "", ...DEFINITIONS);
  return out.join("\n");
}

/**
 * `gh` that makes at most `budget` calls and counts every one (a failed call is still a call). The (budget+1)th THROWS, before it is made, with `code: GH_CALLS_SPENT`: the budget is
 * checked per CALL, because one pull request costs several (the issue, each page of its timeline, a check-runs list per head), so a check per pull request can be overshot by all of them.
 * @param {{ gh: (args: string[]) => any, budget: number }} input
 * @returns {((args: string[]) => any) & { calls: number }}
 */
export function budgetedGh({ gh, budget }) {
  const counted = countingGh(gh);
  const bounded = (/** @type {string[]} */ args) => {
    if (counted.calls >= budget) throw Object.assign(new Error(`--calls ${budget} is spent`), { code: BUDGET_SPENT });
    return counted(args);
  };
  return /** @type {any} */ (Object.defineProperty(bounded, "calls", { get: () => counted.calls }));
}

/** @param {any} error */
const isSpent = (error) => error?.code === BUDGET_SPENT;

/**
 * Merged pull requests of one repository in the window, one counted call per page of the search API. Past GitHub's 1000-result cap the list would be CUT SHORT without saying so
 * (`gh api --paginate` stops there silently), and a week missing its pull requests prints as a smaller week: so that is refused, and `--since` is narrowed instead.
 * @param {{ repo: string, window: { from: number, to: number }, gh: (args: string[]) => any }} input
 * @returns {import("../wakes-per-row.mjs").PullRequest[]}
 */
export function listMergedPulls({ repo, window, gh }) {
  const range = `${new Date(window.from).toISOString()}..${new Date(window.to).toISOString()}`;
  /** @type {import("../wakes-per-row.mjs").PullRequest[]} */
  const pulls = [];
  for (let page = 1; page <= SEARCH_RESULT_CAP / SEARCH_PAGE; page += 1) {
    const reply = gh(["-X", "GET", "search/issues", "-f", `q=repo:${repo} is:pr is:merged merged:${range}`, "-f", `per_page=${SEARCH_PAGE}`, "-f", `page=${page}`]);
    const items = reply.items ?? [];
    pulls.push(...items.map((/** @type {any} */ item) => ({ repo, number: item.number, createdAt: item.created_at, mergedAt: item.pull_request?.merged_at, body: item.body ?? "" })));
    if (pulls.length >= reply.total_count || items.length < SEARCH_PAGE) return pulls;
  }
  throw new Error(`${repo} has more merged pull requests since ${new Date(window.from).toISOString()} than GitHub's search returns (${SEARCH_RESULT_CAP}); a list cut short would print smaller weeks, so narrow --since`);
}

/** The rows GitHub says are open now, one counted call per page, pull requests (which the issues endpoint also lists) left out. @param {{ rowRepo: string, gh: (args: string[]) => any }} input @returns {number[]} */
export function listOpenRows({ rowRepo, gh }) {
  /** @type {number[]} */
  const rows = [];
  for (let page = 1; page <= LIST_MAX_PAGES; page += 1) {
    const items = gh(["-X", "GET", `repos/${rowRepo}/issues`, "-f", "state=open", "-f", `per_page=${SEARCH_PAGE}`, "-f", `page=${page}`]);
    if (!Array.isArray(items)) throw new Error(`gh api repos/${rowRepo}/issues: the reply carried no list where one was expected`);
    rows.push(...items.filter((item) => !item.pull_request).map((item) => item.number));
    if (items.length < SEARCH_PAGE) return rows;
  }
  throw new Error(`gh api repos/${rowRepo}/issues: more than ${LIST_MAX_PAGES} pages; refusing to call a row open on part of the list`);
}

/**
 * What the run must know before it can place a single week: the merged pull requests of every code repository, then which rows are open. Both are counted calls. Without the pull
 * requests there is no list of merged rows, so a budget that cannot list them is an ERROR (a partial list would print smaller weeks); the open rows are optional, and a budget
 * spent before them leaves them unknown (`null`, printed `not asked`).
 * @param {{ repos: string[], rowRepo: string, window: { from: number, to: number }, gh: ReturnType<typeof budgetedGh>, budget: number }} input
 */
export function readListings({ repos, rowRepo, window, gh, budget }) {
  try {
    const pulls = repos.flatMap((repo) => listMergedPulls({ repo, window, gh }));
    return { pulls, openRows: openRowsWithin({ rowRepo, gh }) };
  } catch (cause) {
    if (!isSpent(cause)) throw cause;
    throw new Error(`--calls ${budget} is too small to list the merged pull requests (${gh.calls} made): no week can be placed without that list, and a part of it would print smaller weeks; raise --calls`, { cause });
  }
}

/** @param {{ rowRepo: string, gh: ReturnType<typeof budgetedGh> }} input @returns {number[] | null} */
function openRowsWithin({ rowRepo, gh }) {
  try {
    return listOpenRows({ rowRepo, gh });
  } catch (error) {
    if (isSpent(error)) return null;
    throw error;
  }
}

/** One pull request's own events, tagged with its repository's short name when it is a keyed repository's (how the store keeps `repo`). @param {{ pull: import("../wakes-per-row.mjs").PullRequest, rowRepo: string, gh: (args: string[]) => any }} input */
function pullEventsOf({ pull, rowRepo, gh }) {
  const events = readGithubEvents({ rows: [], prs: [pull.number], repo: pull.repo, gh });
  return pull.repo === rowRepo ? events : events.map((event) => ({ ...event, repo: pull.repo.split("/")[1] }));
}

/**
 * Read what `pending` names of one pull request and the rows it closes, until the budget is spent. A subject whose reading the budget cut off is NOT stored (its events come back only
 * from a whole reading); what finished before it is. Returns what is still pending, which is non-empty only when the budget stopped it.
 * @param {{ pull: import("../wakes-per-row.mjs").PullRequest, pending: { pull: boolean, rows: number[] }, rowRepo: string, gh: (args: string[]) => any }} input
 */
function readPull({ pull, pending, rowRepo, gh }) {
  /** @type {import("./store.mjs").TraceEvent[]} */
  const events = [];
  const left = { ...pending };
  try {
    if (left.pull) {
      events.push(...pullEventsOf({ pull, rowRepo, gh }));
      left.pull = false;
    }
    if (left.rows.length > 0) {
      events.push(...readGithubEvents({ rows: left.rows, prs: [], repo: rowRepo, gh }));
      left.rows = [];
    }
  } catch (error) {
    if (!isSpent(error)) throw error;
  }
  return { events, left };
}

/**
 * What the aggregate reads of GitHub: for the merged rows, their own events (the claim, which gives the wall-clock) and those of the pull requests that closed them. OLDEST MERGE
 * FIRST, and it STOPS when `gh` (budgeted: see `budgetedGh`) refuses a call: a backfill of three weeks is about nine thousand REST calls, and the pool is the whole org's. A merged pull
 * request and a closed row do not change, so what the store already holds of one is not read again: a second run continues where the first stopped. What was not read is
 * returned, so a week that depends on it is marked PARTIAL.
 * @param {{ pulls: import("../wakes-per-row.mjs").PullRequest[], rowRepo: string, held: import("./store.mjs").TraceEvent[], gh: (args: string[]) => any }} input
 */
export function githubEventsOfMerged({ pulls, rowRepo, held, gh }) {
  const merged = new Set(held.filter((event) => event.kind === "merged" && event.pr !== null).map((event) => `${event.repo ?? "primary"}#${event.pr}`));
  const closed = new Set(held.filter((event) => event.kind === "closed" && event.row !== null).map((event) => event.row));
  /** @type {import("./store.mjs").TraceEvent[]} */
  const events = [];
  /** @type {number[]} */
  const unreadRows = [];
  let stopped = false;
  for (const pull of [...pulls].sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt))) {
    const closes = rowsClosedBy(pull.body ?? "", rowRepo);
    let left = { pull: !merged.has(`${pull.repo === rowRepo ? "primary" : pull.repo.split("/")[1]}#${pull.number}`), rows: closes.filter((row) => !closed.has(row)) };
    if (!stopped) {
      const read = readPull({ pull, pending: left, rowRepo, gh });
      events.push(...read.events);
      left = read.left;
      stopped = left.pull || left.rows.length > 0;
    }
    if (left.pull || left.rows.length > 0) unreadRows.push(...closes);
  }
  return { events, unreadRows };
}

/** wakes-per-row's reading of each week, from the same pulls, so its counts are the ones the aggregate compares its own with. @param {{ starts: number[], pulls: import("../wakes-per-row.mjs").PullRequest[], rowRepo: string, claims: Map<number, number>, ledger: import("../wakes-per-row.mjs").LedgerEntry[], cache: string }} input */
function wakesPerRowByWeek({ starts, pulls, rowRepo, claims, ledger, cache }) {
  const transcripts = readTranscripts(join(homedir(), ".claude", "projects"), starts[0]);
  const instances = readInstances(cache);
  const claimedAt = new Map([...claims].map(([row, at]) => [row, /** @type {number | null} */ (at)]));
  const readings = new Map(starts.map((start) => [start, measure({ window: { from: start, to: start + WEEK_DAYS * MS_PER_DAY }, pulls, transcripts, ledger, instances, claimedAt, rowRepo }).rows]));
  return { readings, unreadable: transcripts.flatMap((transcript) => (transcript.ok ? [] : [transcript.file])) };
}

async function mainAggregate() {
  const { since, store: storePath, json, budget } = parseAggregateArgs(process.argv.slice(2));
  const { homeProjectDeclaration } = await import("../project-config.mjs");
  const declaration = homeProjectDeclaration();
  const rowRepo = declaration.tracker[0].repo;
  const cache = join(homedir(), ".cache", "a11ign");
  const now = Date.now();
  const ledger = parseLedger(readFileSync(join(cache, "wake-ledger"), "utf8"));
  const { store, report: ingested } = ingestTranscripts({ root: join(homedir(), ".claude", "projects"), codexRoot: join(homedir(), ".codex", "sessions"), since, ledger, rowRepo, storePath, ghLedgers: ghLedgerFiles(), now });
  const gh = budgetedGh({ gh: ghApi, budget });
  const { pulls, openRows } = readListings({ repos: declaration.code.map((code) => code.repo), rowRepo, window: { from: since, to: now }, gh, budget });
  const { events: seen, unreadRows } = githubEventsOfMerged({ pulls, rowRepo, held: store.events, gh });
  const github = { calls: gh.calls, read: seen.length, added: appendToStore(store, seen).added };
  const starts = Array.from({ length: Math.floor((weekStart(now) - since) / (WEEK_DAYS * MS_PER_DAY)) + 1 }, (_, week) => since + week * WEEK_DAYS * MS_PER_DAY);
  const { readings, unreadable } = wakesPerRowByWeek({ starts, pulls, rowRepo, claims: claimsOf(store.events), ledger, cache });
  const held = { from: ingested.firstRunSince, basis: `the ingest state's first run, ${new Date(ingested.firstRunAt).toISOString()}, over transcripts modified after that time` };
  const result = aggregate({ events: store.events, pulls, rowRepo, now, since, held, readings, unreadable: [...new Set([...ingested.failed, ...unreadable])], unreadRows, openRows });
  console.log(json ? JSON.stringify(result, null, 2) : renderAggregate(result, { ingestFooter: ["", ...ingestLines(ingested), `GitHub: ${github.calls} REST calls (gh api, budget ${budget}); ${github.read} events read, ${github.added} new to the store; rows whose GitHub events are not yet read: ${unreadRows.length}`, NOT_HELD] }));
}

async function main() {
  if (isAggregate(process.argv.slice(2))) return mainAggregate();
  const { number, since, store: storePath, json } = parseArgs(process.argv.slice(2));
  const { homeProjectDeclaration } = await import("../project-config.mjs");
  const rowRepo = homeProjectDeclaration().tracker[0].repo;
  const cache = join(homedir(), ".cache", "a11ign");
  const { store, report: ingested } = ingestTranscripts({ root: join(homedir(), ".claude", "projects"), codexRoot: join(homedir(), ".codex", "sessions"), since, ledger: parseLedger(readFileSync(join(cache, "wake-ledger"), "utf8")), rowRepo, storePath, ghLedgers: ghLedgerFiles() });
  const gh = countingGh(ghApi);
  const { rows, prs } = resolveSubject(number, rowRepo, gh);
  const seen = readGithubEvents({ rows, prs, repo: rowRepo, gh });
  const github = { calls: gh.calls, read: seen.length, added: appendToStore(store, seen).added };
  const events = eventsForRow(store.events, { rows, prs });
  console.log(json ? JSON.stringify({ number, rows, prs, github, events }, null, 2) : render({ number, rows, prs, events, ingest: ingested, github, held: store.events }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
