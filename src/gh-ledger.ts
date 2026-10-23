// @ts-check
// THE READER OF THE `gh` CALL LEDGER (#3466) -- a module with almost nothing to import, since it is run by hand on a host
// where nothing else is wanted: node's own, `api-pool.ts` (a leaf) and `ticket-port/core-pool-probe.ts`, which asks the code host for the core pool's probe only when a refusal is diagnosed.
//
// `plugins/github/wrapper/gh` WRITES the ledger (one TAB-separated line per call, shell, so a call pays no node start-up and the wrapper has
// no dependency on where this checkout lives); this file only READS it and answers the question #3448 could not: WHICH
// caller spends a pool. `gh api rate_limit` shows how much is left and is a broken gauge (#1967); it never says who spent it.
//
// (#4898) IT ALSO OWNS THE QUEUE BESIDE THE LEDGER: a WRITE that GitHub refused for a rate limit is held by `plugins/github/wrapper/gh` in
// `<config dir>/refused-queue` and made by the gate after the reset (`ghQueueTick`, below), and a pool that passes 70% of its
// hour leaves a ledger incident naming the callers that spent it (`poolAlarms`). The wrapper writes the files and this file
// reads, retries and clears them, the same split the ledger has.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { GRAPHQL_POOL_PROBE, poolFromHeaders } from "./api-pool.ts";
import { corePoolProbe } from "./ticket-port/core-pool-probe.ts";

/**
 * `sessionId` is the 9th field, the id of the session that made the call (`plugins/github/wrapper/gh`, #3589); a line from before it has 8 fields and NO `sessionId` key, so it reads to the same entry it always did.
 * `cache` is the 10th field, raw: `-` for a call the read cache did not look at, the verdict for a read it did (`verdictOf`), and NO key on a line from before it.
 * (agent-org#1395) `used` and `reset` are the 11th and 12th: the pool's own counter after the call (`X-Ratelimit-Used`, `X-Ratelimit-Reset` as an epoch), and NO key on a
 * line that did not read it. `settled` is set by `settle`, never by a parse: `read` says `cost` is what the pool's counter moved over this call and was read, `shared`
 * that `cost` is this call's share of a movement that covered several, which is an inference. `unplaced` is a movement no call in the ledger accounts for.
 * (agent-org#1420) `moved` is set by `settle` on the reading that closed a movement: the whole of what the counter moved since its window's last reading, placed or not,
 * which is what the hourly rollup keeps as the hour's counter.
 */
export type LedgerEntry = {time: string, account: string, resource: string, cost: number | null, status: number, command: string, query?: string, workspace: string, caller: string, sessionId?: string, cache?: string, used?: number, reset?: number, settled?: "read" | "shared", unplaced?: number, moved?: number};

const FIELDS = 8;
const NO_SESSION = "-";
const DEFAULT_TOP = 15;
const HOUR_CHARS = "2026-10-08T13".length;
const HOUR_MS = 3_600_000;
const PERCENT = 100;
const SCRIPT_NAME = /([^/\s]+\.(?:mjs|cjs|js|ts|sh|py))\b/;
/** A unit's node is started with a preload (`--import file:///.../crash-exit.ts /.../work-gate.ts`, or `--import=./src/lib/crash-exit.ts src/work-tick.ts`): its argument is a module, never the unit, and was 2,756 of one ledger's 7,510 calls (#3590). */
const PRELOAD = /--import(?:=|\s+)\S+/g;
/** The shell Claude Code runs a Bash tool call in: `zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-<ms>-<id>.sh ...`. */
const HARNESS_SHELL = /\/shell-snapshots\/snapshot-/;
/** What a session's shell is called: its snapshot file, `snapshot-zsh-<ms>-<id>.sh`, is one per session process and says nothing of what ran (#3590). */
export const SESSION_SHELL = "(a session's shell)";

/** (agent-org#1618) `plugins/github/wrapper/gh` widens the command of an `api graphql` call with the name of the read (`api graphql repository.issue.closedByPullRequestsReferences`); a line from before it says `api graphql` and no more. */
const GRAPHQL_QUERY = /^api graphql (\S+)$/;

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
  // Everything after the 9th field is the 10th, so a tab inside it leaves a field `verdictOf` refuses rather than shifting the ones before it. A line of
  // (agent-org#1395) twelve or more fields ends in the pool's counter, so those two are taken off the end first.
  const COUNTER = /^(\d+|-)$/; // `-` is a call that could not say, and still marks the two fields as the counter's
  const shaped = f.length >= FIELDS + 4 && COUNTER.test(f[f.length - 2]) && COUNTER.test(f[f.length - 1]);
  const counted = shaped && /^\d+$/.test(f[f.length - 2]) && /^\d+$/.test(f[f.length - 1]);
  const cache = f.length > FIELDS + 1 ? f.slice(FIELDS + 1, shaped ? -2 : undefined).join("\t") : undefined;
  const query = GRAPHQL_QUERY.exec(f[5])?.[1];
  return { time: f[0], account: f[1], resource: f[2], cost: f[3] === "" ? null : Number(f[3]), status,
    command: f[5], ...(query === undefined ? {} : { query }), workspace: f[6], caller: f[FIELDS - 1], ...(sessionId === NO_SESSION || sessionId === "" ? {} : { sessionId }),
    ...(cache === undefined ? {} : { cache }),
    ...(counted ? { used: Number(f[f.length - 2]), reset: Number(f[f.length - 1]) } : {}) };
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

/** @returns {number} the points a RESPONSE or the pool's counter said this call spent; a share of a movement that covered several calls is not read */
const readCost = (e: LedgerEntry) => (e.settled === "shared" ? 0 : e.cost ?? 0);

/**
 * (agent-org#1395) THE POOL'S OWN COUNTER, PUT BACK ON THE CALLS THAT MOVED IT. Measured 2026-10-13: a pool that went from full to 5 of 5000 in an hour had 1,557
 * ledger lines, none with a `cost`, so each read as the one-point floor and the ledger explained 30% of it. `plugins/github/wrapper/gh` now writes the pool's counter beside every
 * `api graphql` call, and the counter's movement between two readings IS the points spent between them, by whoever, so this gives each reading the movement since
 * the one before it (`settled: "read"`), and shares a movement that covered readings it could not make (a `pr list`, whose response head the wrapper does not
 * ask for) across those calls and the reading that closed it (`settled: "shared"`, an inference and said as one). Per account, in time order; a counter that
 * went BACK within one reset window is two calls answered out of order, and moves nothing.
 *
 * THE FIRST READING OF A RESET WINDOW IS A BASELINE, never a movement: a ledger is trimmed, so the first line it holds may be the window's four-hundredth call, and
 * giving it the whole counter would charge a handful of calls with an hour. A line whose response carried its own `cost` keeps it and is taken out of the movement.
 * What a movement holds beyond that and has no call to go to is `unplaced`, on the reading that closed it: spend by a holder of the token that is not in the
 * ledger, which is the one thing a counter shows and a ledger line cannot.
 * @param {LedgerEntry[]} entries @returns {LedgerEntry[]} the same lines in the same order; the argument is not changed
 */
export function settle(entries: LedgerEntry[]): LedgerEntry[] {
  const out = entries.map((e) => ({ ...e }));
  const byAccount: Map<string, number[]> = new Map();
  out.forEach((e, i) => {
    if (e.settled !== undefined || !e.resource.startsWith("graphql")) return;
    byAccount.set(e.account, [...(byAccount.get(e.account) ?? []), i]);
  });
  for (const indices of byAccount.values()) {
    indices.sort((a, b) => Date.parse(out[a].time) - Date.parse(out[b].time) || a - b);
    // One baseline PER RESET WINDOW, not per account: a token's window resets on its own clock, and one account (`app:scheduler`) runs several
    // at once (2026-10-15 16Z: four reset epochs in one hour, 123 switches among 776 readings). A single baseline restarted on every switch,
    // so most readings were baselines and read as floor (#1482).
    const before: Map<number, number> = new Map();
    // A counter-less line is waiting for a share in EVERY window that has its baseline by the time it appears: its window is not known, so the first
    // reading that brackets it claims it, and no other window's reading takes it again. A window's baseline clears only that window's list; clearing one
    // gap for all windows lost a line between two readings of one window whenever another window's baseline came between them (agent-org#1500 review).
    const pending: Map<number, number[]> = new Map();
    const claimed = new Set<number>();
    for (const i of indices) {
      const e = out[i];
      if (e.used === undefined || e.reset === undefined) {
        for (const list of pending.values()) list.push(i);
        continue;
      }
      const last = before.get(e.reset);
      before.set(e.reset, Math.max(last ?? 0, e.used));
      const gap = (pending.get(e.reset) ?? []).filter((j) => !claimed.has(j));
      pending.set(e.reset, []);
      if (last === undefined) continue; // the baseline: this line and what led up to it stay at their floor
      gap.forEach((j) => claimed.add(j));
      const moved = Math.max(0, e.used - last);
      e.moved = moved;
      const unknown = [...gap, i].filter((j) => out[j].cost === null);
      const left = Math.max(0, moved - [...gap, i].reduce((sum, j) => sum + (out[j].cost ?? 0), 0));
      if (unknown.length === 0) {
        if (left > 0) e.unplaced = left;
      } else {
        const share = Math.floor(left / unknown.length);
        const extra = left - share * unknown.length;
        // the closing reading takes the remainder first: it is the one call whose own movement is in the figure
        const order = [i, ...gap].filter((j) => out[j].cost === null);
        order.forEach((j, n) => {
          out[j].cost = share + (n < extra ? 1 : 0);
          out[j].settled = unknown.length === 1 ? "read" : "shared";
        });
      }
    }
  }
  return out;
}

/** Counts one ledger call into a row of `topCallers` or `topQueries`. */
function countCall(row: { calls: number; points: number; measured: number; failed: number; }, e: LedgerEntry): void {
  row.calls += 1;
  row.points += points(e);
  row.measured += readCost(e);
  row.failed += e.status === 0 ? 0 : 1;
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
    countCall(row, e);
    byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => b.points - a.points || b.calls - a.calls).slice(0, limit);
}

/**
 * The report a person reads. Names the window it covers, because a ledger is bounded and a reading with no window is not one.
 * @param {LedgerEntry[]} entries @param {{account?: string, resource?: string, limit?: number}} [where]
 */
export function renderReport(entries: LedgerEntry[], where: { account?: string; resource?: string; limit?: number; } = {}) {
  const rows = topCallers(settle(entries), where);
  if (entries.length === 0) return "gh ledger: no calls recorded\n";
  const span = `${entries[0].time} .. ${entries[entries.length - 1].time}`;
  const head = `gh ledger: ${entries.length} calls, ${span}${where.account ? `, account ${where.account}` : ""}\n`;
  const table = rows.map((r) =>
    `${String(r.points).padStart(7)} pts (${String(r.measured).padStart(6)} read)  ${String(r.calls).padStart(6)} calls  ` +
    `${String(r.failed).padStart(4)} failed  ${r.caller}  [${r.command}]`);
  return `${head}${table.join("\n")}\n`;
}

/** What a graphql call is called when its line names no read: written by a `plugins/github/wrapper/gh` from before the name was kept, or a call whose body was not in its arguments. Never given a guess. */
export const UNNAMED_QUERY = "(query not named)";

/**
 * (agent-org#1618) WHICH READ SPENT IT: the graphql calls grouped by the read they made (`LedgerEntry.query`), whoever the caller, ranked by points. `calls` and `points` are the
 * same figures `topCallers` gives (`settle`d, with the one-point floor for a call nobody read); a call whose line names no read is `UNNAMED_QUERY`, so a table that
 * does not add up to the pool says so in a row and not in a footnote. Only `api graphql` calls carry a name; `resource` defaults to graphql for that reason.
 * @param {LedgerEntry[]} entries @param {{account?: string, resource?: string, limit?: number, since?: number, until?: number}} [where] `since`/`until` bound the window in epoch ms
 */
export function topQueries(entries: LedgerEntry[], { account, resource = "graphql", limit = DEFAULT_TOP, since = -Infinity, until = Infinity }: { account?: string; resource?: string; limit?: number; since?: number; until?: number; } = {}) {
  const byQuery: Map<string, { query: string; calls: number; points: number; measured: number; failed: number; }> = new Map();
  for (const e of settle(entries)) {
    const at = Date.parse(e.time);
    if (at < since || at > until) continue;
    if (account !== undefined && e.account !== account) continue;
    if (e.resource.replace(/\?$/, "") !== resource || !e.command.startsWith("api graphql")) continue;
    const query = e.query ?? UNNAMED_QUERY;
    const row = byQuery.get(query) ?? { query, calls: 0, points: 0, measured: 0, failed: 0 };
    countCall(row, e);
    byQuery.set(query, row);
  }
  return [...byQuery.values()].sort((a, b) => b.points - a.points || b.calls - a.calls || a.query.localeCompare(b.query)).slice(0, limit);
}

/** @param {ReturnType<typeof topQueries>} rows @param {{account?: string, since?: number, until?: number}} [where] */
export function renderByQuery(rows: ReturnType<typeof topQueries>, where: { account?: string; since?: number; until?: number; } = {}): string {
  const window = `${where.since === undefined || where.since === -Infinity ? "the start of the ledger" : new Date(where.since).toISOString()} .. ${where.until === undefined || where.until === Infinity ? "its end" : new Date(where.until).toISOString()}`;
  if (rows.length === 0) return `gh ledger by query: no graphql calls in ${window}${where.account ? `, account ${where.account}` : ""}\n`;
  const total = rows.reduce((sum, r) => sum + r.points, 0);
  const calls = rows.reduce((sum, r) => sum + r.calls, 0);
  const head = `gh ledger by query: ${calls} graphql calls, ${total} points in ${window}${where.account ? `, account ${where.account}` : ""}\n`;
  const table = rows.map((r) => `${String(r.points).padStart(7)} pts (${String(r.measured).padStart(6)} read)  ${String(r.calls).padStart(6)} calls  ${String(r.failed).padStart(4)} failed  ${r.query}`);
  return `${head}${table.join("\n")}\n`;
}

/**
 * (#4148) THE HOURLY ROLLUP BESIDE THE LEDGER. The ledger keeps its newest half past 2 MiB (70 minutes of the busy afternoon this was written in), so `plugins/github/wrapper/gh` counts what
 * a trim is about to drop into `<ledger>.hourly` first: TAB lines of hour (`2026-10-08T13`), account, resource, calls, points READ, floor points and, 7th, the caller SCRIPT
 * (a11ign/a11ign#4148 residual: without it a per-caller reading existed only for the 80 minutes the raw ledger holds) and, 8th, what the pool's counter moved (agent-org#1420, `HourRow.moved`). A six-field line is one written before the caller was
 * kept: it is read as it always was and its calls have no caller to name. A reading for an hour is the two files added, and they never overlap, because a line is dropped from
 * the ledger in the same step that puts it in the rollup.
 * @param {string} ledgerPath
 */
export const rollupPathOf = (ledgerPath: string) => `${ledgerPath}.hourly`;

/**
 * `caller` is the script that made the calls; it is absent on a row written before the rollup kept one, whose calls have no caller to name.
 * (agent-org#1420) `moved` is the 8th field: what the pool's own counter moved over the readings in this row, placed on a call or not, so an hour trimmed out of the ledger
 * is read as the counter saw it and not as its floor. It is absent on a row written before it was kept, and on one no counter reading closed a movement in.
 */
type HourRow = {hour: string, account: string, resource: string, calls: number, read: number, floor: number, caller?: string, moved?: number};

/** @param {string} text @returns {HourRow[]} a line that is not six to eight fields with numbers is skipped, as a half ledger line is */
export function parseRollup(text: string): HourRow[] {
  const rows: HourRow[] = [];
  for (const line of text.split("\n")) {
    const f = line.split("\t");
    const [calls, read, floor, moved] = [Number(f[3]), Number(f[4]), Number(f[5]), f.length === 8 ? Number(f[7]) : 0];
    const isHourRow = f.length >= 6 && f.length <= 8 && /^\d{4}-\d\d-\d\dT\d\d$/.test(f[0]) && [calls, read, floor, moved].every(Number.isFinite);
    if (isHourRow) {
      rows.push({ hour: f[0], account: f[1], resource: f[2], calls, read, floor, ...(f[6] ? { caller: f[6] } : {}), ...(moved > 0 ? { moved } : {}) });
    }
  }
  return rows;
}

/** @param {LedgerEntry} e @returns {HourRow} one call as the row it adds to its hour */
const hourRowOf = (e: LedgerEntry): HourRow => ({ hour: e.time.slice(0, HOUR_CHARS), account: e.account, resource: e.resource.replace(/\?$/, ""), calls: 1, read: readCost(e), floor: points(e), caller: callerScript(e.caller), ...(e.moved ? { moved: e.moved } : {}) });

/** The rollup's rows and the ledger's lines, as the one kind of row they are, for one account's one resource if named. */
const hourRows = (entries: LedgerEntry[], rollup: HourRow[], { account, resource }: { account?: string; resource?: string; }): HourRow[] =>
  [...rollup, ...settle(entries).map(hourRowOf)].filter((r) => (account === undefined || r.account === account) && (resource === undefined || r.resource === resource));

/**
 * One reading per UTC hour for one account's one resource: the calls, the points the responses REPORTED (`read`) and the floor, which adds one point for every
 * graphql call that did not report (`points`). The ledger's lines and the rollup's rows are the same quantity in two forms, so they are added, never chosen between.
 * @param {LedgerEntry[]} entries @param {HourRow[]} rollup
 * @param {{account?: string, resource?: string}} [where]
 * (agent-org#1420) `moved` is what the pool's own counter moved over the hour, present only for an hour a counter reading closed a movement in: a floor is not called a measurement.
 * @returns {{hour: string, calls: number, read: number, floor: number, moved?: number}[]} oldest hour first
 */
export function perHour(entries: LedgerEntry[], rollup: HourRow[], { account, resource }: { account?: string; resource?: string; } = {}): { hour: string; calls: number; read: number; floor: number; moved?: number; }[] {
  const byHour: Map<string, { hour: string; calls: number; read: number; floor: number; moved?: number; }> = new Map();
  for (const r of hourRows(entries, rollup, { account, resource })) {
    const row = byHour.get(r.hour) ?? { hour: r.hour, calls: 0, read: 0, floor: 0 };
    row.calls += r.calls;
    row.read += r.read;
    row.floor += r.floor;
    if (r.moved !== undefined) row.moved = (row.moved ?? 0) + r.moved;
    byHour.set(r.hour, row);
  }
  return [...byHour.values()].sort((a, b) => a.hour.localeCompare(b.hour));
}

/** What the calls of an hour that no caller is recorded for are called: a rollup row from before the caller was kept, which is never given a guess. */
export const NO_CALLER = "(caller not recorded)";

type HourCallers = { hour: string; callers: { caller: string; calls: number; read: number; floor: number }[] };

/**
 * WHO SPENT EACH HOUR: per UTC hour, the `limit` callers with the most floor points, from the same two files `perHour` adds. A caller is the script (`callerScript`),
 * so the ledger's lines and the rollup's rows land in one bucket; a row with no caller is `NO_CALLER` and is never folded into a script it may not belong to.
 * @param {LedgerEntry[]} entries @param {HourRow[]} rollup
 * @param {{account?: string, resource?: string, limit?: number}} [where]
 * @returns {HourCallers[]} oldest hour first
 */
export function perHourCallers(entries: LedgerEntry[], rollup: HourRow[], { account, resource, limit = DEFAULT_TOP }: { account?: string; resource?: string; limit?: number; } = {}): HourCallers[] {
  const byKey: Map<string, { hour: string; caller: string; calls: number; read: number; floor: number }> = new Map();
  for (const r of hourRows(entries, rollup, { account, resource })) {
    const caller = r.caller ?? NO_CALLER;
    const row = byKey.get(`${r.hour}\t${caller}`) ?? { hour: r.hour, caller, calls: 0, read: 0, floor: 0 };
    row.calls += r.calls;
    row.read += r.read;
    row.floor += r.floor;
    byKey.set(`${r.hour}\t${caller}`, row);
  }
  const byHour: Map<string, HourCallers["callers"]> = new Map();
  for (const { hour, ...reading } of byKey.values()) byHour.set(hour, [...(byHour.get(hour) ?? []), reading]);
  return [...byHour].sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, callers]) => ({ hour, callers: callers.sort((a, b) => b.floor - a.floor || b.calls - a.calls || a.caller.localeCompare(b.caller)).slice(0, limit) }));
}

/**
 * @param {ReturnType<typeof perHour>} hours @param {HourCallers[]} [callers] when given (`--top`), each hour's line is followed by its top callers
 * @returns {string} one line per hour; a ledger and a rollup with nothing for the account say so, never print an empty reading
 */
export function renderPerHour(hours: ReturnType<typeof perHour>, callers?: HourCallers[]): string {
  if (hours.length === 0) return "gh ledger: no calls recorded for that account and resource\n";
  const lines = hours.flatMap((h) => [
    `${h.hour}Z  ${String(h.calls).padStart(6)} calls  ${String(h.read).padStart(6)} points read  ${String(h.floor).padStart(6)} floor points`
      + (h.moved === undefined ? "" : `  ${String(h.moved).padStart(6)} moved by the pool's counter`),
    ...(callers?.find((c) => c.hour === h.hour)?.callers ?? []).map((c) =>
      `    ${String(c.floor).padStart(6)} floor points (${String(c.read).padStart(6)} read)  ${String(c.calls).padStart(6)} calls  ${c.caller}`),
  ]);
  return `${lines.join("\n")}\n`;
}

/**
 * (#4148) WHO SPENT THE LAST HOUR: the caller with the most points in the window ending at `now`, as the line `api-pool-low` quotes. Names the SCRIPT, never the
 * pid; a window with no points says so rather than naming a caller of nothing.
 * @param {LedgerEntry[]} entries @param {{account?: string, resource?: string, now?: number, windowMs?: number}} [where]
 * (agent-org#1395) `counted` is how `total` was arrived at when the pool's counter was read for any line in the window (`settle`): the points the counter said a call
 * spent (`read`), the points shared between calls it could not be read for (`shared`), the floor of the calls after the last reading (`floor`), and the movement no
 * call accounts for (`unplaced`). It is absent for a window with no counter reading, which is a floor and says so.
 * @returns {{caller: string, command: string, points: number, share: number, total: number, counted?: {read: number, shared: number, floor: number, unplaced: number}} | null}
 */
export function topSpender(entries: LedgerEntry[], { account, resource = "graphql", now = Date.now(), windowMs = HOUR_MS }: { account?: string; resource?: string; now?: number; windowMs?: number; } = {}): { caller: string; command: string; points: number; share: number; total: number; counted?: { read: number; shared: number; floor: number; unplaced: number; }; } | null {
  const inWindow = settle(entries).filter((e) => {
    const at = Date.parse(e.time);
    return at > now - windowMs && at <= now;
  });
  const total = topCallers(inWindow, { account, resource, limit: Number.MAX_SAFE_INTEGER }).reduce((sum, r) => sum + r.points, 0);
  const [top] = topCallers(inWindow, { account, resource, limit: 1 });
  if (top === undefined || top.points === 0) return null;
  const spent = inWindow.filter((e) => (account === undefined || e.account === account) && e.resource.replace(/\?$/, "") === resource);
  // a window with any line that carries the pool's counter is a counted one, even when no line in it needed settling: what the counter moved past the calls is `unplaced`
  const counted = spent.some((e) => e.settled !== undefined || e.used !== undefined)
    ? spent.reduce((sum, e) => ({
      read: sum.read + (e.settled === "read" || (e.settled === undefined && e.cost !== null) ? points(e) : 0),
      shared: sum.shared + (e.settled === "shared" ? points(e) : 0),
      floor: sum.floor + (e.settled === undefined && e.cost === null ? points(e) : 0),
      unplaced: sum.unplaced + (e.unplaced ?? 0),
    }), { read: 0, shared: 0, floor: 0, unplaced: 0 })
    : undefined;
  return { caller: top.caller, command: top.command, points: top.points, share: top.points / total, total, ...(counted === undefined ? {} : { counted }) };
}

const APP_LOGIN = /^(.+)\[bot\]$/;

/** @param {string} login @returns {boolean} an App installation's login (`<slug>[bot]`), which no ledger line is written under */
export const isAppLogin = (login: string): boolean => APP_LOGIN.test(login);

/**
 * (#4916) THE NAME A POOL'S LOGIN IS LEDGERED UNDER. An account's calls are written under its own login, but `plugins/github/wrapper/gh` writes an App's under `app:<role>`
 * (the role's token, not a name GitHub gave it), so the login a pool's headers report (`a11ign-scheduler[bot]`) never equals a ledger account and every
 * App pool read as spent by nobody. `appRoles` is the roles `host.json` declares as `github-apps`. THE DECLARATION HOLDS NO SLUG (only `appId`, `keyPath`
 * and `installationId`), so the slug is matched to the role it names: the slug IS the role, or ends `-<role>` (`a11ign-scheduler` for `scheduler`).
 * @param {string} login @param {readonly string[]} appRoles
 * @returns {string | null} the ledger account; `null` for an App no declared role owns, which is an unknown and never "nobody spent it"
 */
export function ledgerAccountOf(login: string, appRoles: readonly string[]): string | null {
  const slug = APP_LOGIN.exec(login)?.[1];
  if (slug === undefined) return login;
  const owner = appRoles.find((role) => slug === role || slug.endsWith(`-${role}`));
  return owner === undefined ? null : `app:${owner}`;
}

/** @param {readonly string[]} paths @param {(path: string) => string} read @returns {{entries: LedgerEntry[], unread: string[]}} each distinct path once, so a ledger named twice is not counted twice */
function readLedgers(paths: readonly string[], read: (path: string) => string): { entries: LedgerEntry[]; unread: string[]; } {
  const entries: LedgerEntry[] = [];
  const unread: string[] = [];
  for (const path of new Set(paths)) {
    try {
      entries.push(...parseLedger(read(path)));
    } catch {
      unread.push(path); // named in the sentence, so the reader knows which directory the reading is short of
    }
  }
  return { entries, unread };
}

/** `used` is the pool's own used points (`limit - remaining`, agent-org#1420), when the caller has them; the sentence states them beside the ledger's total. */
type SpenderQuestion = { ledgers: readonly string[]; login: string; appRoles?: readonly string[]; now?: number; read?: (path: string) => string; used?: number };

/** Under this share of the pool's used points the ledger is said to be short of the spender (agent-org#1420). */
const ACCOUNTED_FLOOR = 0.9;

/**
 * (agent-org#1420) THE LEDGER'S TOTAL BESIDE THE POOL'S OWN COUNT: `used` is what the pool says it spent, `total` what the ledger accounts for, and the share is stated rather
 * than left to a reader to compute. Under 90% the sentence says the rest was spent by calls this ledger does not hold. The last hour of the ledger is not the pool's
 * window, so a share over 100% is possible and is printed as it is. Nothing is said for a pool with no used points: `used` of 0 is no divisor.
 * @param {number} total @param {number | undefined} used @returns {string} empty, or `; the pool's own used points are N and the ledger accounts for P% of them ...`
 */
function usedClause(total: number, used: number | undefined): string {
  if (used === undefined || !(used > 0)) return "";
  const share = total / used;
  return `; the pool's own used points are ${used} and the ledger accounts for ${Math.round(share * PERCENT)}% of them`
    + `${share < ACCOUNTED_FLOOR ? `, under ${Math.round(ACCOUNTED_FLOOR * PERCENT)}%, so ${used - total} points were spent by calls this ledger does not hold` : ""}`;
}

/**
 * (#4916) The sentence `api-pool-low` appends for ONE pool's login, read from EVERY ledger the identity's calls may be written to (the workers', the leads' and the
 * reviewer's config directories each hold their own, and a role's calls land in the directory of whichever session made them). "No graphql point is recorded" is
 * said ONLY when every ledger named was read; one that could not be makes the reading UNREADABLE, since an unread directory may hold the spend. `null` is "no ledger
 * could be read at all", which the caller words.
 * @param {SpenderQuestion} question
 */
export function spenderPhraseFor({ ledgers, login, appRoles = [], now = Date.now(), read = (path) => readFileSync(path, "utf8"), used }: SpenderQuestion): string | null {
  const account = ledgerAccountOf(login, appRoles);
  if (account === null) return `${login} is an App no declared role owns (declared: ${appRoles.join(", ") || "none"}), so its spender is UNREADABLE`;
  const { entries, unread } = readLedgers(ledgers, read);
  if (unread.length === new Set(ledgers).size) return null; // an absent ledger is "could not read", which the caller words; there is nothing to guess at
  const as = account === login ? "" : `, read from ${account} ledger lines`;
  const top = topSpender(entries, { account, now });
  if (top === null) {
    return unread.length === 0 ? `no graphql point is recorded for ${login} in the last hour`
      : `no graphql point is recorded for ${login} in the ledgers that were read, and ${unread.join(", ")} could not be read, so the spender is UNREADABLE`;
  }
  const short = unread.length === 0 ? "" : ` (${unread.join(", ")} could not be read, so this is a floor)`;
  // A window the pool's counter was read in is not a floor: its total is the counter's movement, and the sentence says what of it was read, what shared, and what no call holds.
  const basis = top.counted === undefined ? `${top.total} floor points`
    : `${top.total} points by the pool's own counter: ${top.counted.read} read off it, ${top.counted.shared} shared between calls it was not read for, ${top.counted.floor} floor`
      + `${top.counted.unplaced > 0 ? `, and ${top.counted.unplaced} more that no ledgered call accounts for` : ""}`;
  return `${login}'s last hour (${basis}${as}${usedClause(top.total, used)}): top caller ${top.caller} [${top.command}], ${top.points} points (${Math.round(top.share * PERCENT)}%)${short}`;
}

/**
 * The sentence `api-pool-low` appends: who spent the account's last hour, from the ledger beside the config the call ran under. A ledger that is absent or unreadable is
 * `null`, not a guess: the caller leaves the detail as it was. ONE ledger and an ordinary account; `spenderPhraseFor` is the form that reads an App.
 * @param {string} ledgerPath @param {string} account @param {number} [now]
 * @param {(path: string) => string} [read]
 */
export function spenderPhrase(ledgerPath: string, account: string, now: number = Date.now(), read: (path: string) => string = (path) => readFileSync(path, "utf8")) {
  return spenderPhraseFor({ ledgers: [ledgerPath], login: account, now, read });
}

// --- #4898: A RATE LIMIT NEVER STOPS A SESSION -- THE REFUSED-CALL QUEUE -------------------------------------------------
//
// 2026-10-10: `pr:open` was refused with `GraphQL: API rate limit already exceeded` after every check had passed, and the worker
// stopped and asked a human to rerun it. A refused WRITE has changed nothing on GitHub, so it is safe to make again later; this is
// the reader, retrier and clearer of the files `plugins/github/wrapper/gh` leaves for it. Per entry, in `<config dir>/refused-queue/`:
//   `<id>.argv`      the call's arguments, NUL-separated (a body holds newlines, so no line format can carry it)
//   `<id>.stdin`     what the call read on stdin, when it read any
//   `<id>.fileN`     a copy of each `--body-file`/`--input` the arguments named: the caller's scratch file is gone by the retry
//   `<id>.then.N`    a follow-up call, NUL-separated, made only when this one succeeded (`pr:open`'s arm and label)
//   `<id>.meta`      `key<TAB>value` lines, written LAST and renamed into place, so an entry without one is a torn write and is skipped
// A READ is never queued: its answer is wanted now, and a refused read passes through as it always did.

/** The exit status `plugins/github/wrapper/gh` returns for a call it has queued: "held, not sent", which is neither success nor failure (EX_TEMPFAIL). */
export const QUEUED_EXIT = 75;
export const QUEUE_DIR = "refused-queue";
const RETRY_BASE_SECONDS = 120;
const RETRY_CAP_SECONDS = 3600;
const MAX_QUEUED_AGE_MS = 6 * HOUR_MS;
const MAX_RETRIES_PER_TICK = 10;
const RETRY_TIMEOUT_MS = 60_000;
/** A user's primary pool, GraphQL and REST each, per hour. A GitHub App's is larger (a floor of 5,000 that scales with the installation), so for an `app:<role>` this under-states the limit and the alarm fires EARLY, never late. */
export const POOL_POINTS = 5000;
export const ALARM_FRACTION = 0.7;
const ALARM_COMMAND = "pool-70pct";
const TOP_IN_ALARM = 3;

type RefusalKind = "primary" | "secondary";

/** `plugins/github/wrapper/gh` greps the same two phrases lists (`rate_limit_kind`); `gh-ledger.test.ts` feeds both the same fixtures so they cannot drift apart unseen. */
const SECONDARY_REFUSAL = /secondary rate limit|abuse detection|submitted too quickly/i;
const PRIMARY_REFUSAL = /api rate limit (?:already )?exceeded|rate limit exceeded|HTTP 429/i;

/**
 * @param poolLeft the refused pool's `x-ratelimit-remaining`, read the same way `plugins/github/wrapper/gh` reads it (`pool_probe`), or null when no head said
 * @returns {"primary" | "secondary" | null} what kind of rate limit `gh`'s stderr reports, or null: any other failure is NOT retried.
 * (#1518) an hourly phrase with calls left in its pool is a per-minute refusal, so it is secondary; a pool at zero is primary.
 */
export function refusalKind(stderr: string, poolLeft: number | null = null): RefusalKind | null {
  if (SECONDARY_REFUSAL.test(stderr)) return "secondary";
  if (!PRIMARY_REFUSAL.test(stderr)) return null;
  return poolLeft !== null && poolLeft > 0 ? "secondary" : "primary";
}

export type QueuedCall = {
  id: string; dir: string; argv: string[]; then: string[][]; queuedAtS: number; resetAtS: number; attempts: number;
  kind: RefusalKind; resource: string; cwd: string; workspace: string; session: string;
};

const NONE = "-";

/** @param {string} text @returns {Record<string, string>} the `key<TAB>value` lines of a `.meta` file */
function metaOf(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab > 0) fields[line.slice(0, tab)] = line.slice(tab + 1);
  }
  return fields;
}

/** @param {string} text @returns {string[]} NUL-separated arguments; the last NUL ends the final argument and starts none */
const argvOf = (text: string): string[] => (text === "" ? [] : text.replace(/\0$/, "").split("\0"));

/** The `then` files of one entry, in the order they were attached. */
function followUpsOf(dir: string, id: string): string[][] {
  const prefix = `${id}.then.`;
  return readdirSync(dir).filter((name) => name.startsWith(prefix))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)))
    .map((name) => argvOf(readFileSync(join(dir, name), "utf8")));
}

/** @returns {QueuedCall | null} null for an entry that is not whole (no argv, or a number that is not one): skipped, never guessed at */
function readEntry(dir: string, id: string): QueuedCall | null {
  const argvPath = join(dir, `${id}.argv`);
  if (!existsSync(argvPath)) return null;
  const meta = metaOf(readFileSync(join(dir, `${id}.meta`), "utf8"));
  const [queuedAtS, resetAtS, attempts] = [Number(meta.queuedAt), Number(meta.resetAt), Number(meta.attempts ?? 0)];
  if (![queuedAtS, resetAtS, attempts].every(Number.isFinite)) return null;
  const argv = argvOf(readFileSync(argvPath, "utf8"));
  if (argv.length === 0) return null;
  return { id, dir, argv, then: followUpsOf(dir, id), queuedAtS, resetAtS, attempts,
    kind: meta.kind === "secondary" ? "secondary" : "primary", resource: meta.resource ?? NONE, cwd: meta.cwd ?? "",
    workspace: meta.workspace ?? NONE, session: meta.session ?? NONE };
}

/** @returns {QueuedCall[]} every whole entry of a queue directory, oldest first; an absent directory is an empty queue */
export function readQueue(dir: string): QueuedCall[] {
  if (!existsSync(dir)) return [];
  const calls: QueuedCall[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".meta"))) {
    const call = readEntry(dir, name.slice(0, -".meta".length));
    if (call !== null) calls.push(call);
  }
  return calls.sort((a, b) => a.queuedAtS - b.queuedAtS || a.id.localeCompare(b.id));
}

/** @returns {QueuedCall[]} the entries whose reset has passed at `nowMs`: the gate asks nothing of GitHub to find them */
export const dueCalls = (calls: QueuedCall[], nowMs: number): QueuedCall[] => calls.filter((c) => c.resetAtS * 1000 <= nowMs);

/**
 * Attach follow-up calls to a queued one: they run after it succeeds, in order, and never when it did not (`pr:open`'s arm and label
 * of a PR that does not exist yet). A follow-up that fails is reported and does not stop the ones after it.
 * @param {{ dir: string, id: string }} entry @param {string[][]} steps
 */
export function attachFollowUps({ dir, id }: { dir: string; id: string; }, steps: string[][]) {
  steps.forEach((step, n) => writeFileSync(join(dir, `${id}.then.${n + 1}`), step.map((a) => `${a}\0`).join("")));
}

const filesOf = (dir: string, id: string) => readdirSync(dir).filter((name) => name.startsWith(`${id}.`));

/** An entry leaves the queue by name, whole: every file of it goes, the `.meta` first so a half-removed one is never read as an entry. */
function removeEntry(dir: string, id: string) {
  rmSync(join(dir, `${id}.meta`), { force: true });
  for (const name of filesOf(dir, id)) rmSync(join(dir, name), { force: true });
}

/** A call that will not be made is KEPT, in `failed/` with the reason beside it: a write a person may still want to read, and never one made on a guess. */
function failEntry(call: QueuedCall, reason: string) {
  const failed = join(call.dir, "failed");
  mkdirSync(failed, { recursive: true });
  writeFileSync(join(failed, `${call.id}.why`), `${reason}\n`);
  for (const name of filesOf(call.dir, call.id).filter((n) => !n.endsWith(".meta"))) renameSync(join(call.dir, name), join(failed, name));
  removeEntry(call.dir, call.id);
}

/** Rewrites the meta of a call that was refused again: a later reset and one more attempt; the temp file is renamed into place. */
function requeue(call: QueuedCall, resetAtS: number) {
  const meta = { queuedAt: call.queuedAtS, resetAt: resetAtS, attempts: call.attempts + 1, kind: call.kind, resource: call.resource, cwd: call.cwd, workspace: call.workspace, session: call.session };
  const text = Object.entries(meta).map(([k, v]) => `${k}\t${String(v).replace(/[\t\n]/g, " ")}\n`).join("");
  writeFileSync(join(call.dir, `${call.id}.meta.tmp`), text);
  renameSync(join(call.dir, `${call.id}.meta.tmp`), join(call.dir, `${call.id}.meta`));
}

type RunResult = { status: number | null; stderr: string; stdout?: string };
export type RunQueued = (call: QueuedCall, argv: string[]) => RunResult;
/** (#1518) The refused pool's `x-ratelimit-remaining` for a call's account, or null when there is no answer. {@link poolLeftOfQueued} reads it through the run that makes the call, so the probe goes as the same account. */
type PoolLeftOf = (call: QueuedCall, stderr: string) => number | null;
const NO_READING: PoolLeftOf = () => null;
type RetryEvent = "completed" | "requeued" | "failed";
type RetryOutcome = { id: string; command: string; event: RetryEvent; detail: string };

const firstLine = (text: string) => (text.split("\n").find((l) => l.trim() !== "") ?? "").trim().slice(0, 160);
const commandOf = (argv: string[]) => argv.slice(0, 2).join(" ");

/** Runs the follow-ups of a call that succeeded; each failure is named and the rest still run. @returns {string[]} the failures */
function runFollowUps(call: QueuedCall, run: RunQueued): string[] {
  const failures: string[] = [];
  for (const step of call.then) {
    const r = run(call, step);
    if (r.status !== 0) failures.push(`${commandOf(step)} (exit ${r.status ?? "none"}: ${firstLine(r.stderr)})`);
  }
  return failures;
}

/** One due call, made once. A refusal for a rate limit is waited out again; any OTHER failure ends it, since the same call would fail the same way. */
function attemptCall(call: QueuedCall, { nowMs, run, poolLeftOf }: { nowMs: number; run: RunQueued; poolLeftOf: PoolLeftOf; }): RetryOutcome {
  const command = commandOf(call.argv);
  if (nowMs - call.queuedAtS * 1000 > MAX_QUEUED_AGE_MS) {
    failEntry(call, `queued ${new Date(call.queuedAtS * 1000).toISOString()}, more than ${MAX_QUEUED_AGE_MS / HOUR_MS} hours before this retry: a write that old is not made on a guess`);
    return { id: call.id, command, event: "failed", detail: "too old to make" };
  }
  const r = run(call, call.argv);
  if (r.status === 0) {
    const failures = runFollowUps(call, run);
    removeEntry(call.dir, call.id);
    return { id: call.id, command, event: "completed", detail: failures.length === 0 ? `after ${call.attempts + 1} attempt(s)` : `after ${call.attempts + 1} attempt(s); follow-up(s) FAILED: ${failures.join("; ")}` };
  }
  if (r.status !== null && refusalKind(r.stderr) !== null) {
    // (#1518) FILED AS THE POOL READS NOW, as `plugins/github/wrapper/gh` files it: an hourly phrase with calls left is secondary. The pool is read only for an hourly phrase.
    const kind = refusalKind(r.stderr, SECONDARY_REFUSAL.test(r.stderr) ? null : poolLeftOf(call, r.stderr)) ?? call.kind;
    const wait = Math.min(RETRY_CAP_SECONDS, RETRY_BASE_SECONDS * 2 ** (call.attempts + 1));
    requeue({ ...call, kind }, Math.floor(nowMs / 1000) + wait);
    return { id: call.id, command, event: "requeued", detail: `refused again (${firstLine(r.stderr)}); next attempt in ${wait}s` };
  }
  const why = r.status === null ? `no exit status (${firstLine(r.stderr) || "timed out or was killed"}): it may have been sent, so it is not made again` : `exit ${r.status}: ${firstLine(r.stderr)}`;
  failEntry(call, why);
  return { id: call.id, command, event: "failed", detail: why };
}

/**
 * THE GATE'S RETRY: every call whose reset has passed, oldest first, at most `limit` per tick. Nothing here asks GitHub whether the limit
 * is over; the call itself is the question, and a refusal costs nothing.
 * @param {string} dir a queue directory @param {{ nowMs: number, run: RunQueued, limit?: number }} deps
 */
export function retryDue(dir: string, { nowMs, run, poolLeftOf = NO_READING, limit = MAX_RETRIES_PER_TICK }: { nowMs: number; run: RunQueued; poolLeftOf?: PoolLeftOf; limit?: number; }): RetryOutcome[] {
  return dueCalls(readQueue(dir), nowMs).slice(0, limit).map((call) => attemptCall(call, { nowMs, run, poolLeftOf }));
}

/** The real run: `gh` as the account whose queue this is, from the directory it was asked in, with its stdin, as its session and workspace (so a comment carries the role that wrote it). */
export const spawnQueued: RunQueued = (call, argv) => {
  if (call.cwd !== "" && !existsSync(call.cwd)) return { status: 1, stderr: `the directory the call was made from is gone: ${call.cwd}` };
  const stdinPath = join(call.dir, `${call.id}.stdin`);
  const env: NodeJS.ProcessEnv = { ...process.env, GH_CONFIG_DIR: dirname(call.dir), A11Y_GH_QUEUE_RETRY: "1" };
  if (call.workspace !== NONE) env.HERDR_WORKSPACE_ID = call.workspace;
  if (call.session !== NONE) env.CLAUDE_CODE_SESSION_ID = call.session;
  if (call.argv[0] === "pr" && call.argv[1] === "create") env.A11Y_PR_OPEN = "1"; // only `pr:open` queues a create
  const r = spawnSync("gh", argv, { cwd: call.cwd === "" ? undefined : call.cwd, env, encoding: "utf8", timeout: RETRY_TIMEOUT_MS, input: existsSync(stdinPath) ? readFileSync(stdinPath) : "" });
  return { status: r.status, stderr: `${r.stderr ?? ""}${r.error ? String(r.error.message) : ""}`, stdout: r.stdout ?? "" };
};

/**
 * The probe for the pool a refusal names, or `null` when it cannot be had: the core pool's probe is the code host's (`corePoolProbe`), and a code host that cannot be loaded is no answer, which the queue
 * retry reads as it reads a pool that gave none, and never as a reason to stop retrying what GitHub refused.
 */
function probeFor(stderr: string): string[] | null {
  if (/graphql/i.test(stderr)) return [...GRAPHQL_POOL_PROBE];
  try {
    return [...corePoolProbe()];
  } catch {
    return null;
  }
}

/**
 * (#1518) THE REFUSED POOL'S `x-ratelimit-remaining`, read the way `plugins/github/wrapper/gh` reads it: the GraphQL probe for a refusal that names GraphQL, else the core one,
 * sent THROUGH `run`, so it goes as the call's own account (`spawnQueued` sets its config dir). `null` when there is no answer. The probe is sent through the
 * caller's runner and not spawned here, so this file keeps its one spawn site (the ratchet, #826).
 */
export function poolLeftOfQueued(run: RunQueued): PoolLeftOf {
  return (call, stderr) => {
    const probe = probeFor(stderr);
    return probe === null ? null : poolFromHeaders(probe, (args) => run(call, args).stdout ?? "")?.remaining ?? null;
  };
}

// --- #4898: THE 70% BUDGET ALARM -- which pool is nearly spent, and by whom, BEFORE it refuses -------------------------------

/** @returns {"graphql" | "core" | null} the pool a ledger line spent: `graphql?` is a graphql call inferred from its command family; a cache hit, an incident and a queue event spend none */
function poolOf(e: LedgerEntry): "graphql" | "core" | null {
  const resource = e.resource.replace(/\?$/, "");
  return resource === "graphql" || resource === "core" ? resource : null;
}

/** A call's points against its pool: the cost the response carried, else ONE (a REST call is one; a GraphQL call with no `rateLimit` is its floor). A conditional request that answered 304 costs none and is counted as one, so a REST reading is an upper bound. */
const spend = (e: LedgerEntry) => (poolOf(e) === null ? 0 : e.cost ?? 1);

type PoolAlarm = { account: string; resource: "graphql" | "core"; used: number; limit: number; fraction: number; top: { caller: string; command: string; points: number }[] };

/**
 * THE POOLS THAT PASSED `fraction` OF THEIR LIMIT in the hour ending at `now`, one per account and resource, each with its top callers.
 * The window is the last 60 minutes, not the pool's own (GitHub starts a user's hour at that user's first call and the ledger cannot
 * see it), so a reading can include points from before the reset: the alarm errs early, which is the side an alarm should err on.
 * @param {LedgerEntry[]} entries @param {{ nowMs?: number, limit?: number, fraction?: number }} [where]
 */
export function poolAlarms(entries: LedgerEntry[], { nowMs = Date.now(), limit = POOL_POINTS, fraction = ALARM_FRACTION }: { nowMs?: number; limit?: number; fraction?: number; } = {}): PoolAlarm[] {
  const pools = new Map<string, { account: string; resource: "graphql" | "core"; used: number; byCaller: Map<string, { caller: string; command: string; points: number }> }>();
  for (const e of entries) {
    const at = Date.parse(e.time);
    const resource = poolOf(e);
    if (resource === null || !(at > nowMs - HOUR_MS && at <= nowMs)) continue;
    const pool = pools.get(`${e.account}\t${resource}`) ?? { account: e.account, resource, used: 0, byCaller: new Map() };
    const caller = callerScript(e.caller);
    const row = pool.byCaller.get(`${caller}\t${e.command}`) ?? { caller, command: e.command, points: 0 };
    row.points += spend(e);
    pool.used += spend(e);
    pool.byCaller.set(`${caller}\t${e.command}`, row);
    pools.set(`${e.account}\t${resource}`, pool);
  }
  return [...pools.values()].filter((p) => p.used >= limit * fraction)
    .map((p) => ({ account: p.account, resource: p.resource, used: p.used, limit, fraction: p.used / limit,
      top: [...p.byCaller.values()].sort((a, b) => b.points - a.points).slice(0, TOP_IN_ALARM) }))
    .sort((a, b) => `${a.account}/${a.resource}`.localeCompare(`${b.account}/${b.resource}`));
}

const isoOf = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const alarmCommand = (resource: string) => `${ALARM_COMMAND} ${resource}`;

/** The incident as ONE ledger line: resource `incident` (it spends no point), the pool in the command, and the callers in the caller field. */
export function alarmLine(alarm: PoolAlarm, nowMs: number): string {
  const callers = alarm.top.map((t) => `${t.caller} [${t.command}] ${t.points}`).join("; ");
  const said = `${alarm.used}/${alarm.limit} ${alarm.resource} points (${Math.round(alarm.fraction * PERCENT)}%) in the last hour; top callers: ${callers}`;
  return [isoOf(nowMs), alarm.account, "incident", "", "0", alarmCommand(alarm.resource), NONE, said.replace(/[\t\n]/g, " "), NONE].join("\t");
}

// --- #1517: THE SESSION ALARM -- which session spends a burst, named BEFORE the pool is near its line ----------------------

/** A session that spends more than this many points in ten minutes is named (agent-org#1517). A manager's drain was a burst the hour's 70% line saw too late. */
const SESSION_POINTS = 500;
const SESSION_WINDOW_MS = 10 * 60_000;
const SESSION_ALARM_COMMAND = "session-500-10min";

type SessionAlarm = { account: string; session: string; used: number; endedAt: string; top: { caller: string; command: string; points: number }[] };

/**
 * THE SESSIONS THAT SPENT MORE THAN `limit` POINTS IN SOME TEN-MINUTE WINDOW of the last hour, one per account and session, with the top callers of
 * that window. A line is counted at its settled cost (`settle`): a priced call is its movement off the pool's counter, and a line with no counter is its
 * floor of one. A line with no session (`-`, from before the session was kept) is no session and is counted nowhere here.
 * The window is the ten minutes ending at a line's own time, `(end - window, end]`. Exactly `limit` is not over it.
 * @param {LedgerEntry[]} entries @param {{ nowMs?: number, limit?: number, windowMs?: number }} [where]
 */
export function sessionAlarms(entries: LedgerEntry[], { nowMs = Date.now(), limit = SESSION_POINTS, windowMs = SESSION_WINDOW_MS }: { nowMs?: number; limit?: number; windowMs?: number; } = {}): SessionAlarm[] {
  const sessions = new Map<string, { account: string; session: string; events: { at: number; caller: string; command: string; points: number }[] }>();
  for (const e of settle(entries)) {
    const at = Date.parse(e.time);
    const isWithinHour = at > nowMs - HOUR_MS && at <= nowMs;
    if (!e.sessionId || poolOf(e) === null || !isWithinHour) continue;
    const key = `${e.account}\t${e.sessionId}`;
    const session = sessions.get(key) ?? { account: e.account, session: e.sessionId, events: [] };
    session.events.push({ at, caller: callerScript(e.caller), command: e.command, points: spend(e) });
    sessions.set(key, session);
  }
  const alarms: SessionAlarm[] = [];
  for (const { account, session, events } of sessions.values()) {
    events.sort((a, b) => a.at - b.at);
    let first = 0;
    let sum = 0;
    let worst: SessionAlarm | null = null;
    for (let last = 0; last < events.length; last += 1) {
      sum += events[last].points;
      while (events[first].at <= events[last].at - windowMs) sum -= events[first++].points;
      if (sum > limit && (worst === null || sum > worst.used)) {
        const byCaller = new Map<string, { caller: string; command: string; points: number }>();
        for (const e of events.slice(first, last + 1)) {
          const row = byCaller.get(`${e.caller}\t${e.command}`) ?? { caller: e.caller, command: e.command, points: 0 };
          row.points += e.points;
          byCaller.set(`${e.caller}\t${e.command}`, row);
        }
        worst = { account, session, used: sum, endedAt: isoOf(events[last].at), top: [...byCaller.values()].sort((a, b) => b.points - a.points).slice(0, TOP_IN_ALARM) };
      }
    }
    if (worst !== null) alarms.push(worst);
  }
  return alarms.sort((a, b) => `${a.account}/${a.session}`.localeCompare(`${b.account}/${b.session}`));
}

/** The session alarm as ONE ledger line: resource `incident`, the command names the rule, the session in the session column, and the callers in the caller field. */
function sessionAlarmLine(alarm: SessionAlarm, nowMs: number): string {
  const callers = alarm.top.map((t) => `${t.caller} [${t.command}] ${t.points}`).join("; ");
  const said = `session ${alarm.session} spent ${alarm.used} points in the ten minutes ending ${alarm.endedAt} (more than ${SESSION_POINTS}); top callers: ${callers}`;
  return [isoOf(nowMs), alarm.account, "incident", "", "0", SESSION_ALARM_COMMAND, NONE, said.replace(/[\t\n]/g, " "), alarm.session].join("\t");
}

/**
 * Appends one incident line per pool past the line, and one per session past `SESSION_POINTS` in a ten-minute window, at most once an hour per pool
 * and per session: the ledger already holds the last one, so the check reads the ledger and no state file is kept. A ledger that is not there is
 * nothing to alarm on.
 * @param {string} ledgerPath @param {number} nowMs @returns {string[]} the lines written
 */
export function recordPoolAlarms(ledgerPath: string, nowMs: number): string[] {
  if (!existsSync(ledgerPath)) return [];
  const entries = parseLedger(readFileSync(ledgerPath, "utf8"));
  const recently = (a: PoolAlarm) => entries.some((e) => e.resource === "incident" && e.account === a.account && e.command === alarmCommand(a.resource) && Date.parse(e.time) > nowMs - HOUR_MS);
  const sessionRecently = (a: SessionAlarm) => entries.some((e) => e.resource === "incident" && e.account === a.account && e.sessionId === a.session && e.command === SESSION_ALARM_COMMAND && Date.parse(e.time) > nowMs - HOUR_MS);
  const lines = [
    ...poolAlarms(entries, { nowMs }).filter((a) => !recently(a)).map((a) => alarmLine(a, nowMs)),
    ...sessionAlarms(entries, { nowMs }).filter((a) => !sessionRecently(a)).map((a) => sessionAlarmLine(a, nowMs)),
  ];
  if (lines.length > 0) appendFileSync(ledgerPath, `${lines.join("\n")}\n`);
  return lines;
}

// --- #4898: THE GATE'S TICK -- retry what is due, then read the budget ---------------------------------------------------------

/** The account config directories whose ledgers and queues the gate reads. NEVER the person's `~/.config/gh`: the gate does not act as the human, so it retries no call there. */
const accountDirs = (home: string = homedir()) => [join(home, "workers", "gh"), join(home, "leads", "gh")];

/**
 * ONCE PER TICK: make every queued call whose reset has passed, write the 70% incident for any pool past it. Returns the lines for the tick log, none when nothing
 * was queued and nothing alarmed. A queue that cannot be read is said, never skipped silently, and the ledger and the other account are still read.
 * @param {{ home?: string, nowMs?: number, run?: RunQueued, poolLeftOf?: PoolLeftOf }} [deps]
 */
export function ghQueueTick({ home = process.env.A11Y_GH_QUEUE_HOME ?? homedir(), nowMs = Date.now(), run = spawnQueued, poolLeftOf = poolLeftOfQueued(run) }: { home?: string; nowMs?: number; run?: RunQueued; poolLeftOf?: PoolLeftOf; } = {}): string[] {
  if (process.env.A11Y_GH_QUEUE === "off") return [];
  const said: string[] = [];
  for (const dir of [...accountDirs(home), join(home, ".config", "gh")]) {
    const isAccount = accountDirs(home).includes(dir);
    try {
      if (isAccount) {
        for (const o of retryDue(join(dir, QUEUE_DIR), { nowMs, run, poolLeftOf })) said.push(`gh-queue: ${o.event} ${o.id} [${o.command}] in ${dir}: ${o.detail}`);
      }
      for (const line of recordPoolAlarms(join(dir, "gh-calls.tsv"), nowMs)) said.push(`gh-queue: pool alarm in ${dir}: ${line.split("\t")[7]}`);
    } catch (error) {
      said.push(`gh-queue: could not read ${dir}: ${String((error as Error)?.message ?? error).split("\n")[0]}`);
    }
  }
  return said;
}

// --- #4148 residual (agent-org#742): WHICH READS MISS, AND WHY -----------------------------------------------------------------
//
// `plugins/github/wrapper/gh` ends a read's ledger line with the read cache's verdict: `<hit|miss>-<why>:<argv digest>:<key digest>:<repository slug>`
// (`-` for a call the cache did not look at). The argument digest says "the same question", so a group of reads with one caller,
// subcommand, repository and digest is one question asked again. A HIT's line says `cache` (it spent no pool), so it is counted with
// the group its call made: it is in scope under `--resource` only when a call of that group spent the pool named.

/** The 10th field: the verdict's grammar. A tab inside it, or any other shape, is refused rather than read. */
const VERDICT = /^(hit|miss)-([a-z-]+):([0-9a-f]+):([0-9a-f]+):([A-Za-z0-9._-]+)$/;

/** What the cache said about one read: a hit, or a miss and the `why` `read_cache_fresh` gave. */
type Verdict = { outcome: "hit" | "miss"; why: string; argv: string; repository: string };

/** @returns {Verdict | null} null for a field that is not the wrapper's grammar: a line that cannot say is never given an answer */
export function verdictOf(cache: string): Verdict | null {
  const m = VERDICT.exec(cache);
  return m === null ? null : { outcome: m[1] === "hit" ? "hit" : "miss", why: m[2], argv: m[3], repository: m[5] };
}

/** The group of a line with no verdict to read: a line from before the 10th field, or one whose field is not the grammar. */
export const NO_VERDICT = "(no verdict)";
const NO_DIGEST = "-";

type ReadLine = { key: string; caller: string; command: string; repository: string; digest: string; resource: string; time: string; outcome: "hit" | "miss" | "unknown"; why: string };

/** @returns {ReadLine | null} null for a line that is not a read: an incident, or a call the cache did not look at (`-`), which is counted apart */
function readLineOf(e: LedgerEntry): ReadLine | null {
  if (e.resource === "incident" || e.cache === "-") return null;
  const caller = callerScript(e.caller);
  const resource = e.resource.replace(/\?$/, "");
  const v = e.cache === undefined ? null : verdictOf(e.cache);
  const repository = v?.repository ?? NO_VERDICT;
  const digest = v?.argv ?? NO_DIGEST;
  return { key: [caller, e.command, repository, digest].join("\t"), caller, command: e.command, repository, digest, resource, time: e.time,
    outcome: v?.outcome ?? "unknown", why: v?.why ?? NO_VERDICT };
}

type ReadGroup = { caller: string; command: string; repository: string; digest: string; calls: number; hits: number; unknown: number; misses: Record<string, number>; };
type ReadReport = { from: string; to: string; groups: ReadGroup[]; calls: number; hits: number; misses: number; unknown: number; uncached: number; };

const missesOf = (g: ReadGroup) => Object.values(g.misses).reduce((n, c) => n + c, 0);

/**
 * THE READS, GROUPED: by caller script, subcommand, repository and arguments' digest (the key's digest is left out on purpose, so "the same
 * question with M different keys" is one group). Per group: its calls, its hits and its misses by `why`. The busiest first, at most `limit`;
 * the totals are over all of them. Hits join to their group's calls (see the section note), and `resource` and `account` narrow the reads.
 * @param {LedgerEntry[]} entries @param {{account?: string, resource?: string, limit?: number}} [where]
 * @returns {ReadReport}
 */
export function readGroups(entries: LedgerEntry[], { account, resource, limit = DEFAULT_TOP }: { account?: string; resource?: string; limit?: number; } = {}): ReadReport {
  const own = entries.filter((e) => account === undefined || e.account === account);
  const onPool = (name: string) => resource === undefined || name === resource;
  const uncached = own.filter((e) => e.cache === "-" && onPool(e.resource.replace(/\?$/, ""))).length;
  const lines = own.map(readLineOf).filter((r): r is ReadLine => r !== null);
  const spent = new Set(lines.filter((r) => r.outcome !== "hit" && onPool(r.resource)).map((r) => r.key));
  const scoped = lines.filter((r) => (r.outcome === "hit" ? resource === undefined || spent.has(r.key) : onPool(r.resource)));

  const byKey: Map<string, ReadGroup> = new Map();
  for (const r of scoped) {
    const g = byKey.get(r.key) ?? { caller: r.caller, command: r.command, repository: r.repository, digest: r.digest, calls: 0, hits: 0, unknown: 0, misses: {} };
    g.calls += 1;
    if (r.outcome === "hit") g.hits += 1;
    else if (r.outcome === "unknown") g.unknown += 1;
    else g.misses[r.why] = (g.misses[r.why] ?? 0) + 1;
    byKey.set(r.key, g);
  }
  const all = [...byKey.values()].sort((a, b) => b.calls - a.calls || a.caller.localeCompare(b.caller) || a.command.localeCompare(b.command)
    || a.repository.localeCompare(b.repository) || a.digest.localeCompare(b.digest));
  const sum = (f: (g: ReadGroup) => number) => all.reduce((n, g) => n + f(g), 0);
  const times = scoped.map((r) => r.time).sort();
  return { from: times[0] ?? "", to: times[times.length - 1] ?? "", groups: all.slice(0, limit), calls: sum((g) => g.calls), hits: sum((g) => g.hits),
    misses: sum(missesOf), unknown: sum((g) => g.unknown), uncached };
}

/**
 * The report `--by-read` prints: a header naming the window, the totals and the calls the cache did not read, then one line per group with
 * its misses by why. A reading with no reads says so; it never prints an empty table.
 * @param {ReadReport} report @param {{account?: string, resource?: string}} [where]
 */
export function renderByRead(report: ReadReport, where: { account?: string; resource?: string; } = {}): string {
  const scope = `${where.account ? `, account ${where.account}` : ""}${where.resource ? `, resource ${where.resource}` : ""}`;
  const uncached = `${report.uncached} calls the cache did not look at`;
  if (report.calls === 0) return `gh ledger: no reads recorded${scope}; ${uncached}\n`;
  const head = `gh ledger reads: ${report.calls} reads, ${report.from} .. ${report.to}${scope}: ${report.hits} hits, ${report.misses} misses, ` +
    `${report.unknown} with no verdict; ${uncached}\n`;
  const rows = report.groups.map((g) => {
    const why = Object.entries(g.misses).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([w, n]) => `${w} ${n}`);
    if (g.unknown > 0) why.push(`${NO_VERDICT} ${g.unknown}`);
    return `${String(g.calls).padStart(6)} calls  ${String(g.hits).padStart(6)} hits  ${g.caller}  [${g.command}]  ${g.repository}  ${g.digest}  ` +
      (why.length === 0 ? "no miss" : `misses: ${why.join(", ")}`);
  });
  return `${head}${rows.join("\n")}\n`;
}

/** @param {string[]} argv */
function cliOptions(argv: string[]) {
  const out: { file?: string; account?: string; resource?: string; limit?: number; perHour?: boolean; byRead?: boolean; byQuery?: boolean; since?: number; until?: number; } = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--account") out.account = argv[++i];
    else if (argv[i] === "--resource") out.resource = argv[++i];
    else if (argv[i] === "--top") out.limit = Number(argv[++i]);
    else if (argv[i] === "--per-hour") out.perHour = true;
    else if (argv[i] === "--by-read") out.byRead = true;
    else if (argv[i] === "--by-query") out.byQuery = true;
    else if (argv[i] === "--since") out.since = Date.parse(argv[++i]);
    else if (argv[i] === "--until") out.until = Date.parse(argv[++i]);
    else out.file = argv[i];
  }
  return out;
}

/** @param {string} path @returns {string} "" for a file that is not there: a ledger with no rollup yet is a ledger */
const readIfThere = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

if (import.meta.url === `file://${process.argv[1]}`) {
  const { file, perHour: hourly, byRead, byQuery, since, until, ...where } = cliOptions(process.argv.slice(2));
  if (file === undefined) {
    console.error("usage: node src/gh-ledger.ts <path to gh-calls.tsv> [--account <login>] [--resource graphql|core] [--top <n>] [--per-hour] [--by-read] [--by-query [--since <iso>] [--until <iso>]]  (--by-query: the graphql calls grouped by the read they made; --per-hour --top <n>: each hour's top <n> callers; --by-read: the reads grouped by caller, subcommand, repository and digest, with their misses by why)");
    process.exit(2);
  }
  const entries = parseLedger(readFileSync(file, "utf8"));
  const rollup = parseRollup(readIfThere(rollupPathOf(file)));
  if ([since, until].some((t) => t !== undefined && Number.isNaN(t))) {
    console.error("gh-ledger: --since and --until take a time such as 2026-10-16T13:00:00Z");
    process.exit(2);
  }
  if (byQuery) {
    const window = { ...(since === undefined ? {} : { since }), ...(until === undefined ? {} : { until }) };
    process.stdout.write(renderByQuery(topQueries(entries, { ...where, ...window }), { account: where.account, ...window }));
  } else if (byRead) {
    process.stdout.write(renderByRead(readGroups(entries, where), where));
  } else {
    process.stdout.write(hourly
      ? renderPerHour(perHour(entries, rollup, where), where.limit === undefined ? undefined : perHourCallers(entries, rollup, where))
      : renderReport(entries, where));
  }
}
