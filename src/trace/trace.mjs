#!/usr/bin/env node
// @ts-check
// command: trace -- every model turn, wake and GitHub event of one row, in order (a11ign/a11ign#3494, first and second slices).
//
// `agent-org trace -- <row-or-pr> [--since <ISO>] [--store <path>] [--json 1]`
//
// It does three things in order: INGEST the Claude transcripts and the wake ledger, INGEST what GitHub saw of the row and its pull requests (`github-events.mjs`),
// then PRINT the events about the row. Each ingest appends only the events the store does not have, so running it twice, or for two rows, adds nothing the first did
// not. What the store does NOT hold is named in the footer of every report so the absence is not read as "nothing happened": the `gh` call ledger, deferral spans,
// and Codex reviewer turns.
//
// GITHUB IS READ THROUGH `gh api` ONLY (the REST pool), to learn which rows a pull request closes and which pull requests close a row, and then for the events
// themselves. The calls are counted and the report says how many were made.
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseLedger, rowsClosedBy } from "../wakes-per-row.mjs";
import { countingGh, readGithubEvents } from "./github-events.mjs";
import { fingerprint, HEAD_BYTES, loadState, planRead, saveState, stateFileFor } from "./ingest-state.mjs";
import { appendToStore, DEFINITIONS, eventsForRow, eventsOfTranscript, openStore, readStore } from "./store.mjs";

/** @typedef {import("./ingest-state.mjs").FileState} FileState
 * @typedef {import("./ingest-state.mjs").IngestState} IngestState
 * @typedef {import("./ingest-state.mjs").Carry} Carry */

const DEFAULT_SINCE_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const GH_MAX_BUFFER = 64 * 1024 * 1024;
const SEARCH_PAGE = 100;
const COST_DECIMALS = 4;
const SHORT_SHA = 7;

/** What this slice does not hold. Printed under every report. */
export const NOT_HELD = "NOT IN THIS STORE YET: the gh call ledger, the gate's deferral spans, Codex reviewer turns.";

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
  return { number, since, store: flags.store ?? join(homedir(), ".cache", "a11ign", "trace", "events.ndjson"), json: flags.json === "1" };
}

/**
 * @typedef {{ read: number, unchanged: number, bytesRead: number, unreadableLines: number, failed: string[], reread: string[], heldBack: number, added: number,
 *   coldStart: string | null, firstRunAt: number, firstRunSince: number }} IngestReport
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

/** @param {string} root @param {number} since @returns {{ file: string, stat: import("node:fs").Stats }[]} the transcripts modified since `since`; a file that vanishes mid-listing is not one */
function transcriptsSince(root, since) {
  /** @type {{ file: string, stat: import("node:fs").Stats }[]} */
  const found = [];
  for (const dir of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    for (const name of readdirSync(join(root, dir.name)).filter((file) => file.endsWith(".jsonl"))) {
      const file = join(root, dir.name, name);
      const stat = statSync(file);
      if (stat.mtimeMs >= since) found.push({ file, stat });
    }
  }
  return found;
}

/**
 * Read one transcript from where the state says to, and say what the state becomes: `null` when nothing is to be read. A transcript the state cannot be trusted for
 * is read from byte 0 and `reread` says why.
 * @param {{ file: string, stat: { size: number, mtimeMs: number }, entry: FileState | undefined, ledger: import("../wakes-per-row.mjs").LedgerEntry[], rowRepo: string,
 *   now: number }} input @param {{ bytes: number }} meter
 */
function readTranscript({ file, stat, entry, ledger, rowRepo, now }, meter) {
  const headMatches = () => !entry || fingerprint(readRange(file, 0, entry.headBytes, meter)) === entry.headHash;
  const plan = planRead({ entry, stat, now, headMatches });
  if (plan.action === "skip") return null;
  const readFrom = (/** @type {number} */ start, /** @type {Carry | null} */ carry) => {
    const bytes = readRange(file, start, stat.size, meter);
    return { bytes, start, result: eventsOfTranscript({ text: bytes.toString("utf8"), file, ledger, rowRepo, carry, now }) };
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
 * @param {{ root: string, since: number, ledger: import("../wakes-per-row.mjs").LedgerEntry[], rowRepo: string, store: ReturnType<typeof openStore>, state: IngestState,
 *   coldStart?: string | null, now?: number }} input
 * @returns {IngestReport & { state: IngestState }}
 */
export function ingest({ root, since, ledger, rowRepo, store, state, coldStart = null, now = Date.now() }) {
  const meter = { bytes: 0 };
  const files = { ...state.files };
  /** @type {import("./store.mjs").TraceEvent[]} */
  const batch = [];
  /** @type {string[]} */
  const failed = [];
  /** @type {string[]} */
  const reread = [];
  const counts = { read: 0, unchanged: 0, unreadableLines: 0, heldBack: 0 };
  for (const { file, stat } of transcriptsSince(root, since)) {
    try {
      const done = readTranscript({ file, stat, entry: state.files[file], ledger, rowRepo, now }, meter);
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
    } catch (cause) {
      failed.push(`${file}: ${/** @type {Error} */ (cause).message}`);
    }
  }
  const { added } = appendToStore(store, batch);
  return { ...counts, bytesRead: meter.bytes, failed, reread, added, coldStart, firstRunAt: state.firstRunAt, firstRunSince: state.firstRunSince, state: { ...state, files } };
}

/**
 * One run's transcript half: open the store (the one read of it), load the state, ingest, and save the state once the events are in. The state is saved even when a
 * file failed, because the files that did not fail were read.
 * @param {{ root: string, since: number, ledger: import("../wakes-per-row.mjs").LedgerEntry[], rowRepo: string, storePath: string, now?: number }} input
 * @param {(path: string) => import("./store.mjs").TraceEvent[]} [readEvents] a parameter so a test can count the reads of the store
 */
export function ingestTranscripts({ root, since, ledger, rowRepo, storePath, now = Date.now() }, readEvents = readStore) {
  const store = openStore(storePath, readEvents);
  const statePath = stateFileFor(storePath);
  const { state, coldStart } = loadState({ statePath, storePath, now, since });
  const { state: next, ...report } = ingest({ root, since, ledger, rowRepo, store, state, coldStart, now });
  saveState(statePath, { ...next, storeBytes: existsSync(storePath) ? statSync(storePath).size : 0 });
  return { store, report };
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

/** The transcript half of the footer: what this run read, and from when the state holds the transcripts, so an absence before that is not read as "nothing happened". @param {IngestReport} ingested */
function ingestLines(ingested) {
  const iso = (/** @type {number} */ ms) => new Date(ms).toISOString().slice(0, "YYYY-MM-DDTHH:MM".length);
  const lines = [`ingested ${ingested.read} transcripts (${ingested.bytesRead} bytes read; ${ingested.unchanged} unchanged since the last run); ${ingested.unreadableLines} unreadable lines; `
    + `${ingested.failed.length} files failed${ingested.failed.map((f) => `\n  ${f}`).join("")}`];
  if (ingested.coldStart) lines.push(`COLD START (every transcript in the window read from its first byte): ${ingested.coldStart}`);
  for (const reason of ingested.reread) lines.push(`read again from byte 0: ${reason}`);
  if (ingested.heldBack > 0) lines.push(`${ingested.heldBack} messages written in the last 5 minutes are held back to the next run (a message may still be gaining blocks, and its turn is built from the last)`);
  lines.push(`TRANSCRIPT STATE: holds each transcript from the run that first read it, the first run being ${iso(ingested.firstRunAt)}Z over transcripts modified after ${iso(ingested.firstRunSince)}Z. `
    + "A transcript is read from its first byte then, but one last modified before that window is not in the store: absence before it is not \"nothing happened\".");
  return lines;
}

/**
 * The report for one row's events, as text.
 * @param {{ number: number, rows: number[], prs: number[], events: import("./store.mjs").TraceEvent[], ingest?: IngestReport,
 *   github?: { calls: number, read: number, added: number } }} input
 */
export function render({ number, rows, prs, events, ingest: ingested, github }) {
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
  if (ingested) out.push(...ingestLines(ingested));
  if (github) out.push(`GitHub: ${github.calls} REST calls (gh api); ${github.read} events read, ${github.added} new to the store`);
  out.push(NOT_HELD, "", ...DEFINITIONS);
  return out.join("\n");
}

async function main() {
  const { number, since, store: storePath, json } = parseArgs(process.argv.slice(2));
  const { homeProjectDeclaration } = await import("../project-config.mjs");
  const rowRepo = homeProjectDeclaration().tracker[0].repo;
  const cache = join(homedir(), ".cache", "a11ign");
  const { store, report: ingested } = ingestTranscripts({ root: join(homedir(), ".claude", "projects"), since, ledger: parseLedger(readFileSync(join(cache, "wake-ledger"), "utf8")), rowRepo, storePath });
  const gh = countingGh(ghApi);
  const { rows, prs } = resolveSubject(number, rowRepo, gh);
  const seen = readGithubEvents({ rows, prs, repo: rowRepo, gh });
  const github = { calls: gh.calls, read: seen.length, added: appendToStore(store, seen).added };
  const events = eventsForRow(store.events, { rows, prs });
  console.log(json ? JSON.stringify({ number, rows, prs, github, events }, null, 2) : render({ number, rows, prs, events, ingest: ingested, github }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
