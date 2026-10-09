// @ts-check
// THE READER OF THE `gh` CALL LEDGER (#3466) -- a LEAF module: no import but node's own, since it is run by hand on a host
// where nothing else is wanted.
//
// `host/gh` WRITES the ledger (one TAB-separated line per call, shell, so a call pays no node start-up and the wrapper has
// no dependency on where this checkout lives); this file only READS it and answers the question #3448 could not: WHICH
// caller spends a pool. `gh api rate_limit` shows how much is left and is a broken gauge (#1967); it never says who spent it.

import { existsSync, readFileSync } from "node:fs";

/**
 * `sessionId` is the 9th field, the id of the session that made the call (`host/gh`, #3589); a line from before it has 8 fields and NO `sessionId` key, so it reads to the same entry it always did
 */
export type LedgerEntry = {time: string, account: string, resource: string, cost: number | null, status: number, command: string, workspace: string, caller: string, sessionId?: string};

const FIELDS = 8;
const NO_SESSION = "-";
const DEFAULT_TOP = 15;
const HOUR_CHARS = "2026-10-08T13".length;
const HOUR_MS = 3_600_000;
const PERCENT = 100;
const SCRIPT_NAME = /([^/\s]+\.(?:mjs|cjs|js|ts|sh|py))\b/;
/** A unit's node is started with a preload (`--import file:///.../crash-exit.mjs /.../work-gate.ts`, or `--import=./src/lib/crash-exit.mjs src/work-tick.ts`): its argument is a module, never the unit, and was 2,756 of one ledger's 7,510 calls (#3590). */
const PRELOAD = /--import(?:=|\s+)\S+/g;
/** The shell Claude Code runs a Bash tool call in: `zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-<ms>-<id>.sh ...`. */
const HARNESS_SHELL = /\/shell-snapshots\/snapshot-/;
/** What a session's shell is called: its snapshot file, `snapshot-zsh-<ms>-<id>.sh`, is one per session process and says nothing of what ran (#3590). */
export const SESSION_SHELL = "(a session's shell)";

/**
 * One ledger line, or null for a line that is not one (a half line left by a trim or a crash is skipped, never guessed at).
 * @param {string} line @returns {LedgerEntry | null}
 */
export function parseLine(line: string): LedgerEntry | null {
  const f = line.split("\t");
  if (f.length < FIELDS || !/^\d{4}-\d\d-\d\dT/.test(f[0])) return null;
  const status = Number(f[4]);
  if (!Number.isInteger(status)) return null;
  const sessionId = f.length > FIELDS ? f[FIELDS] : NO_SESSION;
  return { time: f[0], account: f[1], resource: f[2], cost: f[3] === "" ? null : Number(f[3]), status,
    command: f[5], workspace: f[6], caller: f[FIELDS - 1], ...(sessionId === NO_SESSION || sessionId === "" ? {} : { sessionId }) };
}

/** @param {string} text @returns {LedgerEntry[]} */
export function parseLedger(text: string): LedgerEntry[] {
  return text.split("\n").map(parseLine).filter((e) => e !== null);
}

/**
 * The script a call came from, read off the calling process's command line (`node /x/src/work-gate.ts --json` ->
 * `work-gate.ts`), past any `--import` preload; a session's shell is `SESSION_SHELL`, and any other caller that is no script
 * (`herdr`) is named by its first word.
 * @param {string} caller
 */
export function callerScript(caller: string) {
  if (HARNESS_SHELL.test(caller)) return SESSION_SHELL;
  const unit = caller.replace(PRELOAD, "");
  return unit.match(SCRIPT_NAME)?.[1] ?? (unit.trim().split(/\s+/)[0] || "unknown");
}

/**
 * A call's points: the cost the response carried, else ONE for a call known (`graphql`) or inferred (`graphql?`) to spend
 * the GRAPHQL pool, else none. An empty cost is "at least one point", never zero, so the floor under-reads and never over-reads.
 * @param {LedgerEntry} e
 */
function points(e: LedgerEntry) {
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
export function topCallers(entries: LedgerEntry[], { account, resource, limit = DEFAULT_TOP }: { account?: string; resource?: string; limit?: number; } = {}) {
  const byKey: Map<string, { caller: string; command: string; calls: number; points: number; measured: number; failed: number; }> = new Map();
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
export function renderReport(entries: LedgerEntry[], where: { account?: string; resource?: string; limit?: number; } = {}) {
  const rows = topCallers(entries, where);
  if (entries.length === 0) return "gh ledger: no calls recorded\n";
  const span = `${entries[0].time} .. ${entries[entries.length - 1].time}`;
  const head = `gh ledger: ${entries.length} calls, ${span}${where.account ? `, account ${where.account}` : ""}\n`;
  const table = rows.map((r) =>
    `${String(r.points).padStart(7)} pts (${String(r.measured).padStart(6)} read)  ${String(r.calls).padStart(6)} calls  ` +
    `${String(r.failed).padStart(4)} failed  ${r.caller}  [${r.command}]`);
  return `${head}${table.join("\n")}\n`;
}

/**
 * (#4148) THE HOURLY ROLLUP BESIDE THE LEDGER. The ledger keeps its newest half past 2 MiB (70 minutes of the busy afternoon this was written in), so `host/gh` counts what
 * a trim is about to drop into `<ledger>.hourly` first: TAB lines of hour (`2026-10-08T13`), account, resource, calls, points READ, floor points. A reading for an hour is
 * the two files added, and they never overlap, because a line is dropped from the ledger in the same step that puts it in the rollup.
 * @param {string} ledgerPath
 */
export const rollupPathOf = (ledgerPath: string) => `${ledgerPath}.hourly`;

export type HourRow = {hour: string, account: string, resource: string, calls: number, read: number, floor: number};

/** @param {string} text @returns {HourRow[]} a line that is not six fields with numbers is skipped, as a half ledger line is */
export function parseRollup(text: string): HourRow[] {
  const rows: HourRow[] = [];
  for (const line of text.split("\n")) {
    const f = line.split("\t");
    const [calls, read, floor] = [Number(f[3]), Number(f[4]), Number(f[5])];
    if (f.length === 6 && /^\d{4}-\d\d-\d\dT\d\d$/.test(f[0]) && [calls, read, floor].every(Number.isFinite)) {
      rows.push({ hour: f[0], account: f[1], resource: f[2], calls, read, floor });
    }
  }
  return rows;
}

/** @param {LedgerEntry} e @returns {HourRow} one call as the row it adds to its hour */
const hourRowOf = (e: LedgerEntry): HourRow => ({ hour: e.time.slice(0, HOUR_CHARS), account: e.account, resource: e.resource.replace(/\?$/, ""), calls: 1, read: e.cost ?? 0, floor: points(e) });

/**
 * One reading per UTC hour for one account's one resource: the calls, the points the responses REPORTED (`read`) and the floor, which adds one point for every
 * graphql call that did not report (`points`). The ledger's lines and the rollup's rows are the same quantity in two forms, so they are added, never chosen between.
 * @param {LedgerEntry[]} entries @param {HourRow[]} rollup
 * @param {{account?: string, resource?: string}} [where]
 * @returns {{hour: string, calls: number, read: number, floor: number}[]} oldest hour first
 */
export function perHour(entries: LedgerEntry[], rollup: HourRow[], { account, resource }: { account?: string; resource?: string; } = {}): { hour: string; calls: number; read: number; floor: number; }[] {
  const byHour: Map<string, { hour: string; calls: number; read: number; floor: number; }> = new Map();
  for (const r of [...rollup, ...entries.map(hourRowOf)]) {
    if (account !== undefined && r.account !== account) continue;
    if (resource !== undefined && r.resource !== resource) continue;
    const row = byHour.get(r.hour) ?? { hour: r.hour, calls: 0, read: 0, floor: 0 };
    row.calls += r.calls;
    row.read += r.read;
    row.floor += r.floor;
    byHour.set(r.hour, row);
  }
  return [...byHour.values()].sort((a, b) => a.hour.localeCompare(b.hour));
}

/** @param {ReturnType<typeof perHour>} hours @returns {string} one line per hour; a ledger and a rollup with nothing for the account say so, never print an empty reading */
export function renderPerHour(hours: ReturnType<typeof perHour>): string {
  if (hours.length === 0) return "gh ledger: no calls recorded for that account and resource\n";
  return `${hours.map((h) => `${h.hour}Z  ${String(h.calls).padStart(6)} calls  ${String(h.read).padStart(6)} points read  ${String(h.floor).padStart(6)} floor points`).join("\n")}\n`;
}

/**
 * (#4148) WHO SPENT THE LAST HOUR: the caller with the most points in the window ending at `now`, as the line `api-pool-low` quotes. Names the SCRIPT, never the
 * pid; a window with no points says so rather than naming a caller of nothing.
 * @param {LedgerEntry[]} entries @param {{account?: string, resource?: string, now?: number, windowMs?: number}} [where]
 * @returns {{caller: string, command: string, points: number, share: number, total: number} | null}
 */
export function topSpender(entries: LedgerEntry[], { account, resource = "graphql", now = Date.now(), windowMs = HOUR_MS }: { account?: string; resource?: string; now?: number; windowMs?: number; } = {}): { caller: string; command: string; points: number; share: number; total: number; } | null {
  const inWindow = entries.filter((e) => {
    const at = Date.parse(e.time);
    return at > now - windowMs && at <= now;
  });
  const total = topCallers(inWindow, { account, resource, limit: Number.MAX_SAFE_INTEGER }).reduce((sum, r) => sum + r.points, 0);
  const [top] = topCallers(inWindow, { account, resource, limit: 1 });
  return top === undefined || top.points === 0 ? null : { caller: top.caller, command: top.command, points: top.points, share: top.points / total, total };
}

/**
 * The sentence `api-pool-low` appends: who spent the account's last hour, from the ledger beside the config the call ran under. A ledger that is absent or unreadable is
 * `null`, not a guess: the caller leaves the detail as it was.
 * @param {string} ledgerPath @param {string} account @param {number} [now]
 * @param {(path: string) => string} [read]
 */
export function spenderPhrase(ledgerPath: string, account: string, now: number = Date.now(), read: (path: string) => string = (path) => readFileSync(path, "utf8")) {
  let entries;
  try {
    entries = parseLedger(read(ledgerPath));
  } catch {
    return null; // an absent ledger is "could not read", which the caller words; there is nothing to guess at
  }
  const top = topSpender(entries, { account, now });
  if (top === null) return `no graphql point is recorded for ${account} in the last hour`;
  return `${account}'s last hour (${top.total} floor points): top caller ${top.caller} [${top.command}], ${top.points} points (${Math.round(top.share * PERCENT)}%)`;
}

/** @param {string[]} argv */
function cliOptions(argv: string[]) {
  const out: { file?: string; account?: string; resource?: string; limit?: number; perHour?: boolean; } = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--account") out.account = argv[++i];
    else if (argv[i] === "--resource") out.resource = argv[++i];
    else if (argv[i] === "--top") out.limit = Number(argv[++i]);
    else if (argv[i] === "--per-hour") out.perHour = true;
    else out.file = argv[i];
  }
  return out;
}

/** @param {string} path @returns {string} "" for a file that is not there: a ledger with no rollup yet is a ledger */
const readIfThere = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

if (import.meta.url === `file://${process.argv[1]}`) {
  const { file, perHour: hourly, ...where } = cliOptions(process.argv.slice(2));
  if (file === undefined) {
    console.error("usage: node --import tsx src/gh-ledger.ts <path to gh-calls.tsv> [--account <login>] [--resource graphql|core] [--top <n>] [--per-hour]");
    process.exit(2);
  }
  const entries = parseLedger(readFileSync(file, "utf8"));
  process.stdout.write(hourly
    ? renderPerHour(perHour(entries, parseRollup(readIfThere(rollupPathOf(file))), where))
    : renderReport(entries, where));
}
