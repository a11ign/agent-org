// @ts-check
// THE READER OF THE `gh` CALL LEDGER (#3466) -- a LEAF module: no import but node's own, since it is run by hand on a host
// where nothing else is wanted.
//
// `host/gh` WRITES the ledger (one TAB-separated line per call, shell, so a call pays no node start-up and the wrapper has
// no dependency on where this checkout lives); this file only READS it and answers the question #3448 could not: WHICH
// caller spends a pool. `gh api rate_limit` shows how much is left and is a broken gauge (#1967); it never says who spent it.

import { readFileSync } from "node:fs";

/**
 * @typedef {{time: string, account: string, resource: string, cost: number | null, status: number,
 *            command: string, workspace: string, caller: string, sessionId?: string}} LedgerEntry `sessionId` is the 9th field, the id of the session that made
 *            the call (`host/gh`, #3589); a line from before it has 8 fields and NO `sessionId` key, so it reads to the same entry it always did
 */

const FIELDS = 8;
const NO_SESSION = "-";
const DEFAULT_TOP = 15;
const SCRIPT_NAME = /([^/\s]+\.(?:mjs|cjs|js|ts|sh|py))\b/;

/**
 * One ledger line, or null for a line that is not one (a half line left by a trim or a crash is skipped, never guessed at).
 * @param {string} line @returns {LedgerEntry | null}
 */
export function parseLine(line) {
  const f = line.split("\t");
  if (f.length < FIELDS || !/^\d{4}-\d\d-\d\dT/.test(f[0])) return null;
  const status = Number(f[4]);
  if (!Number.isInteger(status)) return null;
  const sessionId = f.length > FIELDS ? f[FIELDS] : NO_SESSION;
  return { time: f[0], account: f[1], resource: f[2], cost: f[3] === "" ? null : Number(f[3]), status,
    command: f[5], workspace: f[6], caller: f[FIELDS - 1], ...(sessionId === NO_SESSION || sessionId === "" ? {} : { sessionId }) };
}

/** @param {string} text @returns {LedgerEntry[]} */
export function parseLedger(text) {
  return text.split("\n").map(parseLine).filter((e) => e !== null);
}

/**
 * The script a call came from, read off the calling process's command line (`node /x/src/work-gate.mjs --json` ->
 * `work-gate.mjs`); a caller that is no script (a shell, `herdr`) is named by its first word.
 * @param {string} caller
 */
export function callerScript(caller) {
  return caller.match(SCRIPT_NAME)?.[1] ?? (caller.trim().split(/\s+/)[0] || "unknown");
}

/**
 * A call's points: the cost the response carried, else ONE for a call known (`graphql`) or inferred (`graphql?`) to spend
 * the GRAPHQL pool, else none. An empty cost is "at least one point", never zero, so the floor under-reads and never over-reads.
 * @param {LedgerEntry} e
 */
function points(e) {
  if (e.cost !== null) return e.cost;
  return e.resource.startsWith("graphql") ? 1 : 0;
}

/**
 * The callers ranked by points, within one account (and one resource, if named).
 * `measured` counts the points a response REPORTED, and `points` adds the one-point floor for every call that did not, so a
 * caller whose number is mostly floor can be told from one whose number was read.
 * @param {LedgerEntry[]} entries
 * @param {{account?: string, resource?: string, limit?: number}} [where]
 */
export function topCallers(entries, { account, resource, limit = DEFAULT_TOP } = {}) {
  /** @type {Map<string, {caller: string, command: string, calls: number, points: number, measured: number, failed: number}>} */
  const byKey = new Map();
  for (const e of entries) {
    if (account !== undefined && e.account !== account) continue;
    if (resource !== undefined && e.resource.replace(/\?$/, "") !== resource) continue;
    const caller = callerScript(e.caller);
    const key = `${caller}\t${e.command}`;
    const row = byKey.get(key) ?? { caller, command: e.command, calls: 0, points: 0, measured: 0, failed: 0 };
    row.calls += 1;
    row.points += points(e);
    row.measured += e.cost ?? 0;
    row.failed += e.status === 0 ? 0 : 1;
    byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => b.points - a.points || b.calls - a.calls).slice(0, limit);
}

/**
 * The report a person reads. Names the window it covers, because a ledger is bounded and a reading with no window is not one.
 * @param {LedgerEntry[]} entries @param {{account?: string, resource?: string, limit?: number}} [where]
 */
export function renderReport(entries, where = {}) {
  const rows = topCallers(entries, where);
  if (entries.length === 0) return "gh ledger: no calls recorded\n";
  const span = `${entries[0].time} .. ${entries[entries.length - 1].time}`;
  const head = `gh ledger: ${entries.length} calls, ${span}${where.account ? `, account ${where.account}` : ""}\n`;
  const table = rows.map((r) =>
    `${String(r.points).padStart(7)} pts (${String(r.measured).padStart(6)} read)  ${String(r.calls).padStart(6)} calls  ` +
    `${String(r.failed).padStart(4)} failed  ${r.caller}  [${r.command}]`);
  return `${head}${table.join("\n")}\n`;
}

/** @param {string[]} argv */
function cliOptions(argv) {
  /** @type {{file?: string, account?: string, resource?: string, limit?: number}} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--account") out.account = argv[++i];
    else if (argv[i] === "--resource") out.resource = argv[++i];
    else if (argv[i] === "--top") out.limit = Number(argv[++i]);
    else out.file = argv[i];
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { file, ...where } = cliOptions(process.argv.slice(2));
  if (file === undefined) {
    console.error("usage: node src/gh-ledger.mjs <path to gh-calls.tsv> [--account <login>] [--resource graphql|core] [--top <n>]");
    process.exit(2);
  }
  process.stdout.write(renderReport(parseLedger(readFileSync(file, "utf8")), where));
}
