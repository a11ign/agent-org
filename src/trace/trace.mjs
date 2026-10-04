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
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseLedger, rowsClosedBy } from "../wakes-per-row.mjs";
import { countingGh, readGithubEvents } from "./github-events.mjs";
import { appendEvents, DEFINITIONS, eventsForRow, eventsOfTranscript, readStore } from "./store.mjs";

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
 * Ingest every transcript modified since `since`. A file that cannot be read is listed, never skipped quietly.
 * @param {{ root: string, since: number, ledger: import("../wakes-per-row.mjs").LedgerEntry[], rowRepo: string, store: string }} input
 */
export function ingest({ root, since, ledger, rowRepo, store }) {
  let read = 0;
  let unreadableLines = 0;
  /** @type {string[]} */
  const failed = [];
  for (const dir of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    for (const name of readdirSync(join(root, dir.name)).filter((file) => file.endsWith(".jsonl"))) {
      const file = join(root, dir.name, name);
      if (statSync(file).mtimeMs < since) continue;
      try {
        const result = eventsOfTranscript({ text: readFileSync(file, "utf8"), file, ledger, rowRepo });
        appendEvents(store, result.events);
        unreadableLines += result.unreadable;
        read += 1;
      } catch (cause) {
        failed.push(`${file}: ${/** @type {Error} */ (cause).message}`);
      }
    }
  }
  return { read, unreadableLines, failed };
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

/**
 * The report for one row's events, as text.
 * @param {{ number: number, rows: number[], prs: number[], events: import("./store.mjs").TraceEvent[], ingest?: { read: number, unreadableLines: number, failed: string[] },
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
  if (ingested) {
    out.push(`ingested ${ingested.read} transcripts; ${ingested.unreadableLines} unreadable lines; ${ingested.failed.length} files failed${ingested.failed.map((f) => `\n  ${f}`).join("")}`);
  }
  if (github) out.push(`GitHub: ${github.calls} REST calls (gh api); ${github.read} events read, ${github.added} new to the store`);
  out.push(NOT_HELD, "", ...DEFINITIONS);
  return out.join("\n");
}

async function main() {
  const { number, since, store, json } = parseArgs(process.argv.slice(2));
  const { homeProjectDeclaration } = await import("../project-config.mjs");
  const rowRepo = homeProjectDeclaration().tracker[0].repo;
  const cache = join(homedir(), ".cache", "a11ign");
  const ingested = ingest({ root: join(homedir(), ".claude", "projects"), since, ledger: parseLedger(readFileSync(join(cache, "wake-ledger"), "utf8")), rowRepo, store });
  const gh = countingGh(ghApi);
  const { rows, prs } = resolveSubject(number, rowRepo, gh);
  const seen = readGithubEvents({ rows, prs, repo: rowRepo, gh });
  const github = { calls: gh.calls, read: seen.length, added: appendEvents(store, seen).added };
  const events = eventsForRow(readStore(store), { rows, prs });
  console.log(json ? JSON.stringify({ number, rows, prs, github, events }, null, 2) : render({ number, rows, prs, events, ingest: ingested, github }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
