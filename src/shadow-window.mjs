#!/usr/bin/env node
// @ts-check
// command: shadow-window -- ONE tick of the candidate gate beside the live one, over a copy of the state, appended to a diff record
// Row #2846 (the split, child 5d of #69): the program ADR 0040 decision 5 (1) describes and `shadow-gate.mjs` (child 4)
// only gave the instrument for. One invocation is ONE tick; running it every two minutes for 1,440 ticks is a host
// arrangement asked of `ceo` on #2623 and is NOT started by this file.
//
// ROW #2867 (child 5f) ADDS THE WINDOW AROUND THAT TICK, and only when `--window-timer=<unit>` is given (the unit's ExecStart gives it):
//   `--arm`         creates `<liveDir>/shadow-window-open`, whose CONTENT is T0 and T-end, once, after checking the candidate's import
//                   closure is byte-identical to this checkout's (`ceo`'s rule on #2867: not corresponding means not armed);
//   a windowed tick is DORMANT with no marker (installing the units starts nothing), counts recorded ticks, and ENDS ITSELF at 1,440
//                   of them or at T0 plus 52 hours, whichever comes first: it appends a `stop` row, disables its own timer and removes the marker;
//   a GAP or a REFUSAL is a row in the record naming the time and the cause, never a silence. Whether a gap resets the 1,440 is the close
//                   row's to say from the record (decision 5), so this counts every recorded tick and decides nothing about gaps.
//
// THE LIVE SIDE IS RECORDED, NOT RECOMPUTED (`product-manager`'s ruling on #2846, 2026-10-01). `work-gate.mjs`'s `main()`
// has no seam to take its reads from outside and WRITES state when run (`claimStallTick`), so #2849 makes the live tick
// leave `<stateDir>/shadow-reads/<tickUtcMs>.json` = `{ tick, args, orders }` while `<stateDir>/shadow-window-open`
// exists: `args` is the exact object `decide` was called with and `orders` is `decide`'s raw return. This file runs
// only the CANDIDATE over `args` and diffs its orders against the recorded ones -- which also removes `decide`'s own
// `Date.now()` skew, so a difference here is the code and never the clock.
//
// WHAT IT WRITES, EXHAUSTIVELY: the COPY directory (emptied and refilled from the live one at the start of every
// invocation, so the candidate reads what the live gate read) and ONE appended line of the diff record (a windowed run may append a gap
// or refusal row first). Never a state file or the handoff queue; the live directory is read and never written -- EXCEPT the window's
// marker, which `--arm` creates and the window's own end removes, and which nothing else here touches. The record path and the
// copy path are both refused when they resolve inside the live directory, because either would be a write there.
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync }
  from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve, isAbsolute, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { diffOrders, refuseLiveStateDir, LIVE_STATE_DIR } from "./shadow-gate.mjs";
import { SHADOW_WINDOW_MARKER, parseShadowRecord } from "./shadow-reads.mjs";
import { localImports } from "./lib/local-import-closure.mjs";
import { sandboxGitEnv } from "./lib/git-env.mjs";
import { SHADOW_COPY_MARKER, SHADOW_STATE_DIR_ENV } from "./host-config.mjs";
import { flagValue, refuseUnknownFlags } from "./lib/cli-flags.mjs";

/** `0` a tick was recorded, or there was none to record; `2` a path was refused or an input could not be read. */
export const EXIT = { OK: 0, REFUSED: 2 };

/** Where #2849's live tick leaves the reads, and the file inside the COPY that says the runner made that directory. */
export const READS_DIR = "shadow-reads";
export const COPY_MARKER = SHADOW_COPY_MARKER;
/** Handed to the candidate so one that reads local state can read the COPY; `decide` has no parameter for it. The gate honours it in `host-config.mjs`'s `stateEntryPath`. */
export const STATE_DIR_ENV = SHADOW_STATE_DIR_ENV;

const SELF = fileURLToPath(import.meta.url);
/** The tool this runner runs from (its `src/..`), wherever it is checked out: `--arm` compares the candidate against it. Not imported from `host-units.mjs`, whose closure needs git history. */
const TOOL_ROOT = resolve(dirname(SELF), "..");
/** A candidate that has not answered in this long is recorded as failed; it must not hold the next tick's turn. */
const CANDIDATE_TIMEOUT_MS = 120_000;
const CANDIDATE_MAX_BUFFER = 32 * 1024 * 1024;
const STDERR_TAIL_CHARS = 2000;

/** @param {string} path the path's real location, or its plain resolution when it does not exist yet */
function realOrResolved(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** @param {string} child @param {string} parent */
function isInside(child, parent) {
  const rel = relative(realOrResolved(parent), realOrResolved(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Every refusal this invocation can make, made BEFORE a single read of the live directory.
 * @param {{ liveDir: string, copyDir: string, recordPath: string }} paths
 */
export function refuseBeforeReading({ liveDir, copyDir, recordPath }) {
  refuseLiveStateDir(copyDir, { liveStateDir: liveDir });
  if (isInside(copyDir, liveDir)) throw new Error(`REFUSING: the copy ${copyDir} is inside the live state directory ${liveDir}; refilling it would write there.`);
  if (isInside(recordPath, liveDir)) throw new Error(`REFUSING: the diff record ${recordPath} is inside the live state directory ${liveDir}; appending to it would write there.`);
}

/**
 * Empty `copyDir` and refill it from `liveDir`, so the candidate reads what the live gate read. Refuses a non-empty
 * directory this runner did not make: emptying one it did not make is how a mistyped path deletes somebody's files.
 * `dereference` so a symlink in the live directory becomes bytes, never a way back to a live file.
 * @param {{ liveDir: string, copyDir: string }} paths
 */
export function refreshCopy({ liveDir, copyDir }) {
  mkdirSync(copyDir, { recursive: true });
  const held = readdirSync(copyDir);
  if (held.length > 0 && !held.includes(COPY_MARKER)) {
    throw new Error(`REFUSING: ${copyDir} is not empty and was not made by this runner (no ${COPY_MARKER}); it will not be emptied.`);
  }
  for (const name of held) rmSync(join(copyDir, name), { recursive: true, force: true });
  for (const name of readdirSync(liveDir)) {
    if (name !== READS_DIR) cpSync(join(liveDir, name), join(copyDir, name), { recursive: true, dereference: true });
  }
  writeFileSync(join(copyDir, COPY_MARKER), "made by shadow-window.mjs; emptied and refilled from the live directory every tick\n");
}

/**
 * Every row of the diff record, in file order. A line that is not JSON REFUSES, naming its number: the record is the window's evidence, and
 * a reader that skipped a line it could not parse would count fewer ticks than were recorded and say nothing.
 * @param {string} recordPath @returns {any[]}
 */
export function readRecordRows(recordPath) {
  if (!existsSync(recordPath)) return [];
  return readFileSync(recordPath, "utf8").split("\n").flatMap((line, index) => {
    if (line.trim() === "") return [];
    try {
      return [JSON.parse(line)];
    } catch (cause) {
      throw new Error(`REFUSING: line ${index + 1} of the diff record ${recordPath} is not JSON, so the ticks recorded cannot be counted`, { cause });
    }
  });
}

/** A TICK row is the one a tick wrote, which has no `kind`; a window row (`gap`, `refused`, `stop`) names its kind. Rows written before #2867 are all ticks. @param {any} row */
export const isTickRow = (row) => row.kind === undefined;

/**
 * DISTINCT ticks recorded, so a row written twice would still count once. `t0Ms` leaves out a tick that began BEFORE the window opened: the live
 * tap's directory can hold a file from an earlier marker, which the first armed run recorded as tick 1 (2026-10-01, #2867).
 * @param {any[]} rows @param {number} [t0Ms]
 * @returns {number}
 */
export const ticksRecorded = (rows, t0Ms = 0) => new Set(rows.filter((row) => isTickRow(row) && row.tickMs >= t0Ms).map((row) => row.tickMs)).size;

/**
 * The record's last TICK row at or after `t0Ms`, which is where the next tick starts. `null` for a record with no tick yet.
 * @param {string} recordPath @param {number} [t0Ms] @returns {{ tickMs: number, bootId: string | null } | null}
 */
export function lastRecorded(recordPath, t0Ms = 0) {
  const ticks = readRecordRows(recordPath).filter((row) => isTickRow(row) && row.tickMs >= t0Ms);
  if (ticks.length === 0) return null;
  const { tickMs, bootId } = ticks[ticks.length - 1];
  return { tickMs, bootId: bootId ?? null };
}

/**
 * The OLDEST tick file newer than the last one recorded, or `null`. Ordered by the number in its name (the tick's UTC
 * milliseconds), never by directory order or mtime. `notBefore` (the window's T0) skips a file from a tick that began before the window: it is
 * not one of its 1,440, and taking it would also record the hours up to T0 as a gap that never happened.
 * @param {{ liveDir: string, after: number | null, notBefore?: number }} where @returns {{ tickMs: number, path: string } | null}
 */
export function nextTickFile({ liveDir, after, notBefore = 0 }) {
  const dir = join(liveDir, READS_DIR);
  if (!existsSync(dir)) return null;
  const found = readdirSync(dir).map((name) => ({ name, tickMs: Number(name.replace(/\.json$/, "")) }))
    .filter(({ name, tickMs }) => name.endsWith(".json") && Number.isSafeInteger(tickMs) && tickMs >= notBefore && (after === null || tickMs > after))
    .sort((a, b) => a.tickMs - b.tickMs);
  return found.length === 0 ? null : { tickMs: found[0].tickMs, path: join(dir, found[0].name) };
}

/** The live tick's cadence (#2849: "one hour at two minutes"); a tick id is its UTC milliseconds, so ticks are counted by it. */
export const TICK_INTERVAL_MS = 120_000;

/**
 * Ticks that never reached a file between the last recorded one and this one, so "1,440 consecutive ticks" is
 * computable from the record. #2849 names a tick by its UTC milliseconds, not by a counter, so a miss is read off the
 * elapsed time: rounded to whole intervals, which absorbs a timer's seconds of jitter. `null` when nothing is missing.
 * @param {number | null} previousMs @param {number} tickMs
 * @returns {{ missing: number, firstMissingUtc: string } | null}
 */
export function gapBetween(previousMs, tickMs) {
  if (previousMs === null) return null;
  const missing = Math.round((tickMs - previousMs) / TICK_INTERVAL_MS) - 1;
  return missing < 1 ? null : { missing, firstMissingUtc: new Date(previousMs + TICK_INTERVAL_MS).toISOString() };
}

/**
 * The candidate's side of the child process: `decide(args)` from the candidate's own module, orders as JSON on stdout.
 * A child, so a candidate that exits non-zero, throws or hangs is an observation and not a crash of the runner.
 * The revive happens HERE and not in `shadowTick`: `args` crosses the process boundary as JSON, which would flatten a revived Map back to `{}`.
 * The parent leaves the tap's `$type` tags as plain objects, so they cross unchanged and `parseShadowRecord` (one reviver, #2858) restores them.
 * @param {string} modulePath
 */
async function runAsCandidateChild(modulePath) {
  const args = parseShadowRecord(readFileSync(0, "utf8"));
  const { decide } = await import(pathToFileURL(resolve(modulePath)).href);
  process.stdout.write(JSON.stringify(decide(args)));
}

/**
 * Run the candidate gate over one tick's `args`, with the COPY as the state it may read.
 * @param {{ module: string, args: unknown, copyDir: string }} job
 * @returns {{ exit: number | null, orders: any[] | null, error: string | null }}
 */
export function runCandidate({ module, args, copyDir }) {
  const run = spawnSync(process.execPath, [SELF, "--candidate-child", `--module=${module}`], {
    input: JSON.stringify(args), encoding: "utf8", timeout: CANDIDATE_TIMEOUT_MS, maxBuffer: CANDIDATE_MAX_BUFFER,
    env: { ...process.env, [STATE_DIR_ENV]: copyDir },
  });
  if (run.status !== 0) {
    const how = run.error?.message ?? (run.signal ? `killed by ${run.signal}` : "");
    return { exit: run.status, orders: null, error: `${how} ${(run.stderr ?? "").slice(-STDERR_TAIL_CHARS)}`.trim() };
  }
  try {
    const orders = JSON.parse(run.stdout);
    if (Array.isArray(orders)) return { exit: 0, orders, error: null };
  } catch { /* falls through to the one report below, which names what was wrong */ }
  return { exit: 0, orders: null, error: "exit 0 but stdout was not a JSON array of orders" };
}

/** @param {any[]} orders @returns {string[]} the distinct causes that fired, for the window's seven-day coverage rule */
const causesOf = (orders) => [...new Set(orders.map((o) => String(o?.cause ?? "")))].sort();

/**
 * A candidate that did not answer is ONE difference naming how it ended, not one per live order: nothing was said, so
 * there is nothing to line up against.
 * @param {{ exit: number | null, orders: any[] | null, error: string | null }} candidate
 */
function candidateFailure({ exit, error }) {
  return { causeKey: `candidate-exit:${exit ?? "none"}`, live: null, candidate: null, exit, error };
}

/**
 * `bootId` is carried only by a WINDOWED run (the field is absent otherwise), so a later gap can be told apart as a host restart.
 * @param {{ tickMs: number, tick: number | null, live: any[], candidate: ReturnType<typeof runCandidate>,
 *   gapBefore: ReturnType<typeof gapBetween>, now: Date, bootId?: string | null }} facts
 */
export function buildRecord({ tickMs, tick, live, candidate, gapBefore, now, bootId }) {
  const answered = candidate.orders !== null;
  return {
    tick, tickMs, utc: new Date(tickMs).toISOString(), recordedAt: now.toISOString(), gapBefore,
    ...(bootId === undefined ? {} : { bootId }),
    live, candidate: candidate.orders, candidateExit: candidate.exit,
    differences: answered ? diffOrders(live, /** @type {any[]} */ (candidate.orders)) : [candidateFailure(candidate)],
    causes: { live: causesOf(live), candidate: answered ? causesOf(/** @type {any[]} */ (candidate.orders)) : null },
  };
}

/**
 * ONE tick: refuse, refresh the copy, take the oldest unrecorded tick, run the candidate over it, append one line.
 * `windowed` (the unit's run) adds a boot id to the line and, when ticks are missing before this one, a gap row BEFORE it, and its `t0Ms` keeps a
 * tick from before the window out of both the choice of the next tick and the gap arithmetic.
 * @param {{ liveDir?: string, copyDir: string, recordPath: string, candidate: string, now?: Date,
 *   windowed?: { bootId: string | null, t0Ms: number } }} job
 * @returns {{ status: "QUIET" | "RECORDED", record?: ReturnType<typeof buildRecord> }}
 */
export function shadowTick({ liveDir = LIVE_STATE_DIR, copyDir, recordPath, candidate, now = new Date(), windowed }) {
  refuseBeforeReading({ liveDir, copyDir, recordPath });
  const last = lastRecorded(recordPath, windowed?.t0Ms);
  const next = nextTickFile({ liveDir, after: last?.tickMs ?? null, notBefore: windowed?.t0Ms });
  if (next === null) return { status: "QUIET" };
  refreshCopy({ liveDir, copyDir });
  const { tick, args, orders } = JSON.parse(readFileSync(next.path, "utf8"));
  const answer = runCandidate({ module: candidate, args, copyDir });
  const gapBefore = gapBetween(last?.tickMs ?? null, next.tickMs);
  const record = buildRecord({ tickMs: next.tickMs, tick: Number.isInteger(tick) ? tick : null, live: orders, candidate: answer, gapBefore, now,
    ...(windowed === undefined ? {} : { bootId: windowed.bootId }) });
  mkdirSync(dirname(recordPath), { recursive: true });
  if (windowed !== undefined && gapBefore !== null && last !== null) {
    appendRow(recordPath, gapRow({ gap: gapBefore, tickMs: next.tickMs, last, rows: readRecordRows(recordPath), now, bootId: windowed.bootId }));
  }
  appendRow(recordPath, record);
  return { status: "RECORDED", record };
}

/** @param {string} recordPath @param {object} row */
function appendRow(recordPath, row) {
  appendFileSync(recordPath, `${JSON.stringify(row)}\n`);
}

// --- #2867: THE WINDOW AROUND THE TICK ---------------------------------------------------------------------------------------------

/** ADR 0040 decision 5 (1): 1,440 ticks, which is 48 hours at the live two-minute tick. */
export const WINDOW_TICKS = 1440;
/** The wall-clock stop, whichever comes first: T0 plus 52 hours, four more than the 1,440 ticks need, so a few missed ticks do not end it early. */
const HOUR_MS = 3_600_000;
export const HARD_STOP_HOURS = 52;
export const HARD_STOP_MS = HARD_STOP_HOURS * HOUR_MS;

/** The host's boot id, which changes when the host restarted; `null` where it cannot be read, which is never read as "the same boot". */
export function currentBootId() {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * What the marker says: T0, and the two ends derived from it. The marker is `{ schema, t0, tEnd, hardStop, ... }`; one with no readable T0 REFUSES,
 * because a marker made by `touch` opens the live gate's tap and leaves the runner with no clock to stop by.
 * @param {string} liveDir @returns {{ t0: string, tEnd: string, hardStop: string } | null} `null` when there is no marker: the window is not open
 */
export function readWindowMarker(liveDir) {
  const path = join(liveDir, SHADOW_WINDOW_MARKER);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  /** @type {any} */
  let marker;
  try {
    marker = JSON.parse(text);
  } catch (cause) {
    throw new Error(`REFUSING: ${path} exists but is not JSON, so the window has no T0 to stop by; \`--arm\` writes it, nothing else should`, { cause });
  }
  if (typeof marker?.t0 !== "string" || Number.isNaN(Date.parse(marker.t0))) {
    throw new Error(`REFUSING: ${path} carries no T0 (a UTC timestamp in \`t0\`), so the window has no clock to stop by`);
  }
  return { t0: marker.t0, tEnd: String(marker.tEnd), hardStop: String(marker.hardStop) };
}

/**
 * WHETHER THE WINDOW HAS ENDED and which stop fired: `count` at 1,440 recorded ticks, `wall-clock` at T0 plus 52 hours. `null` while it runs.
 * @param {{ ticks: number, t0Ms: number, now: Date }} facts @returns {"count" | "wall-clock" | null}
 */
export function stopReason({ ticks, t0Ms, now }) {
  if (ticks >= WINDOW_TICKS) return "count";
  return now.getTime() >= t0Ms + HARD_STOP_MS ? "wall-clock" : null;
}

/**
 * A GAP ROW: ticks the record never saw, with the time and the CAUSES THE RUNNER CAN KNOW. `runner-refused` is a `refused` row after the last
 * tick; `host-restarted` is a boot id that differs from the last tick's; otherwise `no-tap-file`, which is the honest remainder -- the live tick
 * left no reads for those ticks (it did not run, or its tap failed), or this runner was away so long the tap's hour of files was pruned. Not told
 * apart, and not guessed at.
 * @param {{ gap: NonNullable<ReturnType<typeof gapBetween>>, tickMs: number, last: { tickMs: number, bootId: string | null },
 *   rows: any[], now: Date, bootId: string | null }} facts
 */
export function gapRow({ gap, tickMs, last, rows, now, bootId }) {
  const causes = [];
  if (rows.some((row) => row.kind === "refused" && Date.parse(row.at) > last.tickMs)) causes.push("runner-refused");
  if (bootId !== null && last.bootId !== null && bootId !== last.bootId) causes.push("host-restarted");
  if (causes.length === 0) causes.push("no-tap-file");
  return { kind: "gap", at: now.toISOString(), missing: gap.missing, firstMissingUtc: gap.firstMissingUtc,
    lastMissingUtc: new Date(tickMs - TICK_INTERVAL_MS).toISOString(), causes };
}

/** Stop `unit` and keep it stopped: the same command any session may run to stop the window (#2867 done-when 6). @param {string} unit */
function disableTimerNow(unit) {
  execFileSync("/usr/bin/systemctl", ["--user", "disable", "--now", unit], { stdio: ["ignore", "inherit", "inherit"] });
}

/**
 * ONE WINDOWED TICK: dormant with no marker, ended once a stop row exists, otherwise one tick of the candidate, and the stop fires here.
 * A refusal inside the tick is a `refused` row (time and cause) before it is rethrown, so the unit fails visibly AND the record has the hole.
 * The paths are refused first and BEFORE any row, because a record inside the live directory is not a place to write one.
 * @param {{ liveDir?: string, copyDir: string, recordPath: string, candidate: string, timerUnit: string, now?: Date,
 *   bootId?: string | null, disableTimer?: (unit: string) => void }} job
 * @returns {{ status: "NOT-OPEN" | "ENDED" | "STOPPED" | "QUIET" | "RECORDED", cause?: string, record?: ReturnType<typeof buildRecord>, ticks?: number }}
 */
export function windowTick({ liveDir = LIVE_STATE_DIR, copyDir, recordPath, candidate, timerUnit, now = new Date(), bootId = currentBootId(),
  disableTimer = disableTimerNow }) {
  refuseBeforeReading({ liveDir, copyDir, recordPath });
  const marker = readWindowMarker(liveDir);
  if (marker === null) return { status: "NOT-OPEN" };
  const ended = readRecordRows(recordPath).find((row) => row.kind === "stop");
  if (ended !== undefined) {
    endWindow({ liveDir, timerUnit, disableTimer });
    return { status: "ENDED", cause: ended.cause, ticks: ended.ticks };
  }
  const t0Ms = Date.parse(marker.t0);
  const ticks = ticksRecorded(readRecordRows(recordPath), t0Ms);
  const before = stopReason({ ticks, t0Ms, now });
  if (before !== null) return stopWindow({ cause: before, ticks, recordPath, liveDir, timerUnit, now, disableTimer });
  const result = tickOrRecordRefusal({ liveDir, copyDir, recordPath, candidate, now, bootId, t0Ms });
  const after = ticksRecorded(readRecordRows(recordPath), t0Ms);
  const reason = stopReason({ ticks: after, t0Ms, now });
  if (reason !== null && result.status === "RECORDED") return { ...stopWindow({ cause: reason, ticks: after, recordPath, liveDir, timerUnit, now, disableTimer }), record: result.record };
  return { ...result, ticks: after };
}

/** @param {Parameters<typeof shadowTick>[0] & { bootId: string | null, t0Ms: number }} job */
function tickOrRecordRefusal({ bootId, t0Ms, ...job }) {
  try {
    return shadowTick({ ...job, windowed: { bootId, t0Ms } });
  } catch (error) {
    const cause = /** @type {Error} */ (error).message;
    try {
      mkdirSync(dirname(job.recordPath), { recursive: true });
      appendRow(job.recordPath, { kind: "refused", at: (job.now ?? new Date()).toISOString(), cause });
    } catch (appendError) {
      process.stderr.write(`could not record the refusal either: ${/** @type {Error} */ (appendError).message}\n`);
    }
    throw error;
  }
}

/**
 * The stop row first, so the record says why it ended even if the two steps after it fail; then the end itself.
 * @param {{ cause: "count" | "wall-clock", ticks: number, recordPath: string, liveDir: string, timerUnit: string, now: Date, disableTimer: (unit: string) => void }} stop
 * @returns {{ status: "STOPPED", cause: string, ticks: number }}
 */
function stopWindow({ cause, ticks, recordPath, liveDir, timerUnit, now, disableTimer }) {
  appendRow(recordPath, { kind: "stop", cause, ticks, at: now.toISOString() });
  endWindow({ liveDir, timerUnit, disableTimer });
  return { status: "STOPPED", cause, ticks };
}

/**
 * THE TIMER FIRST, THEN THE MARKER: a failed `disable` leaves the marker and a stop row, which the next invocation reads as `ENDED` and retries,
 * where the other order would leave an enabled timer on a window nothing could find open. Removing the marker is what turns the live gate's tap off.
 * @param {{ liveDir: string, timerUnit: string, disableTimer: (unit: string) => void }} end
 */
function endWindow({ liveDir, timerUnit, disableTimer }) {
  disableTimer(timerUnit);
  rmSync(join(liveDir, SHADOW_WINDOW_MARKER), { force: true });
}

// --- #2867: ARMING -- the one act that creates the marker --------------------------------------------------------------------------

/** @param {string} root @returns {string | null} the checkout's HEAD, or null when it cannot be read */
function headOf(root) {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Every file the candidate's entry reaches by relative import, itself included. @param {string} entry @returns {string[]} */
export function candidateClosure(entry) {
  const seen = new Set([resolve(entry)]);
  const queue = [resolve(entry)];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    for (const next of localImports(file)) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return [...seen].sort();
}

/**
 * THE CORRESPONDENCE `ceo` ruled on #2867: the candidate checkout's package root (its `src/..`) against the tool this runner runs from (its own
 * `src/..`, #3098: in the monorepo that is `packages/agent-org`, standalone it is the checkout itself), file by file over the candidate gate's import
 * closure. A candidate file that differs or is absent here is NAMED; an empty list is the only "corresponds".
 * @param {{ candidate: string, toolRoot: string }} where @returns {{ files: number, differing: string[] }}
 */
export function closureCorrespondence({ candidate, toolRoot }) {
  const candidateRoot = dirname(dirname(resolve(candidate)));
  const files = candidateClosure(candidate);
  const differing = files.filter((file) => {
    const mine = join(toolRoot, relative(candidateRoot, file));
    return !existsSync(mine) || readFileSync(mine, "utf8") !== readFileSync(file, "utf8");
  }).map((file) => relative(candidateRoot, file).split(sep).join("/"));
  return { files: files.length, differing };
}

/**
 * ARM THE WINDOW, ONCE: create the marker whose content is T0, and nothing else. REFUSES an armed window (naming its T0), a record that already
 * holds rows (a stopped window's record is evidence, so move it aside), a copy or record inside the live directory, and a candidate whose closure
 * does not match this tool's. Atomic (a temp name, then `rename`), so the live tap never sees half a marker.
 * @param {{ liveDir?: string, copyDir: string, recordPath: string, candidate: string, toolRoot?: string, now?: Date, headOf?: (root: string) => string | null }} job
 */
export function armWindow({ liveDir = LIVE_STATE_DIR, copyDir, recordPath, candidate, toolRoot = TOOL_ROOT, now = new Date(), headOf: head = headOf }) {
  refuseBeforeReading({ liveDir, copyDir, recordPath });
  const armed = readWindowMarker(liveDir);
  if (armed !== null) throw new Error(`REFUSING: the window is already armed (T0 ${armed.t0}); it is armed once, and a stop declares it not-started before a new T0.`);
  if (readRecordRows(recordPath).length > 0) throw new Error(`REFUSING: the diff record ${recordPath} already holds rows; a stopped window's record is evidence, so move it aside before a new T0.`);
  const { files, differing } = closureCorrespondence({ candidate, toolRoot });
  if (differing.length > 0) {
    throw new Error(`REFUSING: the candidate does not correspond to this checkout; ${differing.length} of ${files} files in its import closure differ or are absent: ${differing.join(", ")}`);
  }
  const commits = { candidate: head(dirname(dirname(resolve(candidate)))), tool: head(toolRoot) };
  if (commits.candidate === null || commits.tool === null) {
    throw new Error(`REFUSING: the ${commits.candidate === null ? "candidate checkout" : "tool checkout"} has no readable HEAD, and the arming comment names the pair of commits.`);
  }
  const t0 = now.toISOString();
  const marker = { schema: 1, t0, tEnd: new Date(now.getTime() + WINDOW_TICKS * TICK_INTERVAL_MS).toISOString(),
    hardStop: new Date(now.getTime() + HARD_STOP_MS).toISOString(), tickLimit: WINDOW_TICKS,
    candidate: { module: resolve(candidate), commit: commits.candidate }, tool: { root: toolRoot, commit: commits.tool } };
  const temp = join(liveDir, `.${SHADOW_WINDOW_MARKER}.tmp`);
  writeFileSync(temp, `${JSON.stringify(marker, null, 2)}\n`);
  renameSync(temp, join(liveDir, SHADOW_WINDOW_MARKER));
  return { ...marker, files };
}

/** @param {ReturnType<typeof windowTick>} result */
function windowReport({ status, cause, record, ticks }) {
  if (status === "NOT-OPEN") return "NOT-OPEN: no window marker, so nothing is recorded\n";
  if (status === "ENDED" || status === "STOPPED") return `${status}: the window ended (${cause}) at ${ticks} recorded tick(s); the timer is disabled and the marker removed\n`;
  return status === "QUIET" ? "QUIET: no tick newer than the record\n" : `RECORDED tick ${record?.tick} (${record?.utc}): ${record?.differences.length} difference(s); ${ticks} of ${WINDOW_TICKS}\n`;
}

/** @param {ReturnType<typeof armWindow>} armed @param {string | undefined} timer */
function armReport({ t0, tEnd, hardStop, candidate, tool, files }, timer) {
  return [`ARMED: the shadow window's marker is created (the live gate's tap is on)`,
    `T0:        ${t0}`, `T-end:     ${tEnd}  (T0 + ${WINDOW_TICKS} ticks at two minutes)`, `Hard stop: ${hardStop}  (T0 + 52 hours, whichever comes first)`,
    `Candidate: ${candidate.commit} (${candidate.module})`, `Tool:      ${tool.commit} (${tool.root})`,
    `Closure:   ${files} files, byte-identical`,
    ...(timer === undefined ? [] : [`Stop:      systemctl --user disable --now ${timer}`])].join("\n") + "\n";
}

async function main() {
  const known = ["--live-dir=", "--copy-dir=", "--record=", "--candidate=", "--candidate-child", "--module=", "--window-timer=", "--arm"];
  refuseUnknownFlags(known, { entry: import.meta.url, command: "node packages/agent-org/src/shadow-window.mjs" });
  const argv = process.argv.slice(2);
  if (argv.includes("--candidate-child")) return runAsCandidateChild(String(flagValue(argv, "module")));
  const copyDir = flagValue(argv, "copy-dir"), recordPath = flagValue(argv, "record"), candidate = flagValue(argv, "candidate");
  if (!copyDir || !recordPath || !candidate) {
    process.stderr.write("usage: shadow-window.mjs --copy-dir=<dir> --record=<file.jsonl> --candidate=<module exporting decide> [--live-dir=<dir>] [--window-timer=<unit> | --arm]\n");
    process.exit(EXIT.REFUSED);
  }
  const liveDir = flagValue(argv, "live-dir"), timerUnit = flagValue(argv, "window-timer");
  try {
    if (argv.includes("--arm")) return void process.stdout.write(armReport(armWindow({ liveDir, copyDir, recordPath, candidate }), timerUnit));
    if (timerUnit) return void process.stdout.write(windowReport(windowTick({ liveDir, copyDir, recordPath, candidate, timerUnit })));
    const { status, record } = shadowTick({ liveDir, copyDir, recordPath, candidate });
    process.stdout.write(status === "QUIET" ? "QUIET: no tick newer than the record\n"
      : `RECORDED tick ${record?.tick} (${record?.utc}): ${record?.differences.length} difference(s)\n`);
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n`);
    process.exit(EXIT.REFUSED);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) await main();
