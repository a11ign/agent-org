// @ts-check
// A LEAF, like `claim-stall.mjs`: `node:*` only, so `work-tick.mjs` takes it without a cycle and a test imports it without a gate.
//
// A TICK THAT IS SLOW, OR KILLED, TELLS `ceo` (a11ign/a11ign#3567). On 2026-10-04 a tick ran 10 min 13 s and was killed by `TimeoutStartSec`, and the
// only trace was a journal line nobody reads. The signal has two halves, because a tick that is killed cannot report itself from inside:
//
//   SLOW    the tick that finishes over {@link TICK_SLOW_SECONDS} reads its own `tick-cost` line and wakes `ceo` before it exits.
//   KILLED  every tick leaves a START MARKER and clears it when its process ends by itself. A marker still there when the next tick starts was
//           left by a process that was signalled (the timeout, a restart), so the NEXT tick reads it and wakes `ceo`.
//
// WHY A MARKER AND NOT `OnFailure=` (the row allows either, if the choice is said). `OnFailure=` reports without waiting for a tick, which is the
// one thing it has over a marker, and it costs a second unit in `host/` on every host, a unit that has to reach `ceo` by itself with no ledger and
// no `wake`. The marker reuses the delivery that already exists (`wake` and its ledger, keyed on `causeKey`) and needs nothing installed. THE GAP,
// stated: a kill during `ExecStartPre` (`pnpm run primary:update`) happens before this process exists, so no marker was written and the next tick
// cannot see it; the unit's own failure is read by `incident:gate-crash`.
//
// ONE REPORT PER TICK, BY CONSTRUCTION. Both orders are keyed on the tick's start time, which `wake`'s ledger already refuses to deliver twice, and
// the marker is replaced by the tick that reads it, so a second reader finds a marker it did not write only if another tick was killed.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

/** Over this many seconds from the unit starting to the tick ending, the tick is slow. The row names it; 180 is three timer intervals' worth of nobody looking. */
export const TICK_SLOW_SECONDS = 180;

/**
 * The cause both orders carry. One cause, two subjects: they go to the same reader and ask the same question, which phase to go and look at. The orders
 * spell it as a LITERAL (`cause: "tick-overran"`) because `worker-profile.test.ts` finds the causes a file emits by that text, and a constant it cannot read.
 */
export const TICK_OVERRAN = "tick-overran";
export const TICK_SLOW = "tick-slow";
export const TICK_KILLED = "tick-killed";

/** The marker beside the ledger and the cost file, so one directory holds the tick's runtime state. */
export const TICK_MARKER_FILE = "tick-running.json";

const MS_PER_SECOND = 1000;
const WALL_DECIMALS = 1;

/** @param {string} ledgerPath @returns {string} */
export function tickMarkerPath(ledgerPath) {
  return join(dirname(ledgerPath), TICK_MARKER_FILE);
}

/**
 * The threshold in force: the constant, unless `A11Y_TICK_SLOW_SECONDS` names another positive number. The override is the TEST'S seam -- a test cannot
 * wait three minutes -- and nothing in `host/` sets it.
 * @param {NodeJS.ProcessEnv} [env] @returns {number}
 */
export function slowThresholdSeconds(env = process.env) {
  const named = Number(env.A11Y_TICK_SLOW_SECONDS);
  return Number.isFinite(named) && named > 0 ? named : TICK_SLOW_SECONDS;
}

/**
 * @typedef {{ session: string, cause: string, subject: string, discriminator: string, prompt: string, causeKey: string }} TickOrder
 * @typedef {{ at: number, pid: number | null, unreadable: boolean }} Marker
 */

// ---- THE START MARKER ------------------------------------------------------------------------------------------------------------------------

/** @param {string} path @param {{ at: number, pid: number }} marker */
export function writeStartMarker(path, marker) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(marker)}\n`);
}

/**
 * Clears the marker only if THIS process wrote it: a tick run by hand beside the timer's must not clear the timer's, and a marker replaced by a later
 * tick is that tick's. Idempotent, and a marker that is gone or unreadable is left to the reader of it.
 * @param {string} path @param {number} pid
 */
export function clearOwnMarker(path, pid) {
  if (readMarker(path)?.pid === pid) rmSync(path, { force: true });
}

/**
 * The marker, or `null` when there is none. A file that is THERE and cannot be parsed is a marker too, with `unreadable` set and the file's own
 * modification time as its `at`: absence of a reading is not absence of a killed tick, and a tick killed mid-write is exactly the one that leaves one.
 * Any other failure to read (a permission, a directory in its place) throws, and the caller says so.
 * @param {string} path @returns {Marker | null}
 */
export function readMarker(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null;
    throw error;
  }
  try {
    const { at, pid } = JSON.parse(text);
    if (Number.isFinite(at) && Number.isInteger(pid)) return { at, pid, unreadable: false };
  } catch {
    // Falls through to the same answer a parseable file with the wrong fields gets: a marker whose author is unknown.
  }
  return { at: statSync(path).mtimeMs, pid: null, unreadable: true };
}

/** @param {number} pid @returns {boolean} */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

/**
 * The marker a DEAD tick left, or `null`. A marker whose process is still alive is a tick running beside this one (one started by hand), not a killed
 * one, and is not reported. The cost of the liveness test, stated: a pid reused by an unrelated process within the interval hides one killed tick.
 * @param {string} path @param {{ alive?: (pid: number) => boolean }} [sources] @returns {Marker | null}
 */
export function readKilledTick(path, { alive = processAlive } = {}) {
  const marker = readMarker(path);
  if (marker === null) return null;
  return marker.pid !== null && alive(marker.pid) ? null : marker;
}

// ---- THE TWO ORDERS --------------------------------------------------------------------------------------------------------------------------

const seconds = (/** @type {number} */ ms) => (ms / MS_PER_SECOND).toFixed(WALL_DECIMALS);

/** @param {number} ms */
const clock = (ms) => new Date(ms).toISOString();

/**
 * The order for a tick that finished slow, or none. The wall is the UNIT's, from systemd starting it to this process ending (`prestartMs` is
 * `ExecStartPre`, which `TimeoutStartSec` also counts), and CPU is the tick's own plus every child's. `line` is the `tick-cost` line, so the order says
 * nothing the file does not.
 *
 * @param {{ at: number, wallMs: number, prestartMs?: number | null, cpuMs: { self: number, children: number }, phases: Record<string, { wallMs: number, cpuMs: number }> }} line
 * @param {{ thresholdSeconds?: number, costPath: string }} where
 * @returns {TickOrder[]}
 */
export function slowTickOrders(line, { thresholdSeconds = TICK_SLOW_SECONDS, costPath }) {
  const wallMs = line.wallMs + (line.prestartMs ?? 0);
  if (wallMs <= thresholdSeconds * MS_PER_SECOND) return [];
  const startedAt = Math.round(line.at - line.wallMs);
  const [phase, took] = Object.entries(line.phases).reduce((longest, entry) => (entry[1].wallMs > longest[1].wallMs ? entry : longest));
  return [{
    session: "ceo", cause: "tick-overran", subject: TICK_SLOW, discriminator: String(startedAt),
    prompt: `A TICK TOOK ${seconds(wallMs)} s (the limit is ${thresholdSeconds} s) and finished. It started at ${clock(startedAt)}.\n`
      + `Wall ${seconds(wallMs)} s${line.prestartMs ? `, of which ${seconds(line.prestartMs)} s was \`ExecStartPre\`` : ""}; CPU ${seconds(line.cpuMs.self + line.cpuMs.children)} s `
      + `(${seconds(line.cpuMs.self)} s its own, ${seconds(line.cpuMs.children)} s its children's). The phase that took longest: \`${phase}\`, ${seconds(took.wallMs)} s wall, `
      + `${seconds(took.cpuMs)} s CPU.\n`
      + `The rest is the last line of \`${costPath}\` (\`tail -n 1 ${costPath}\`): every phase, the commands the tick started and the 5 slowest and hottest command lines. `
      + "Wall far above CPU is waiting; CPU near wall is work.",
    causeKey: `ceo/${TICK_OVERRAN}/${TICK_SLOW}-${startedAt}`,
  }];
}

/**
 * The order for a tick that never finished, or none. `foundAt` is when the tick that read the marker began, so the time the dead tick ran is an UPPER
 * bound (it ended no later than this); the unit's `TimeoutStartSec` is the usual ender, and a killed tick writes no cost line, which is why the order
 * points at the lines before it.
 *
 * @param {Marker | null} marker @param {{ foundAt: number, costPath: string }} where @returns {TickOrder[]}
 */
export function killedTickOrders(marker, { foundAt, costPath }) {
  if (marker === null) return [];
  const startedAt = Math.round(marker.at);
  return [{
    session: "ceo", cause: "tick-overran", subject: TICK_KILLED, discriminator: String(startedAt),
    prompt: `A TICK WAS KILLED. The one that started at ${clock(startedAt)} never finished: its start marker was still there when the tick that started at `
      + `${clock(foundAt)} began, and a tick that ends by itself clears it. It ran at most ${seconds(foundAt - startedAt)} s (it ended before this one began); `
      + `\`TimeoutStartSec\` is the usual ender, then a restart${marker.unreadable ? ". THE MARKER WAS UNREADABLE, so that start time is the file's modification time" : ""}.\n`
      + `A killed tick writes no cost line, so look at the ones before it: \`tail -n 5 ${costPath}\` (phases, then the slowest and hottest command lines), `
      + "and at the unit's own journal for what it said last.",
    causeKey: `ceo/${TICK_OVERRAN}/${TICK_KILLED}-${startedAt}`,
  }];
}

// ---- DELIVERY --------------------------------------------------------------------------------------------------------------------------------

/**
 * Hands the orders to `wake` on its stdin, the way the gate does, so the delivery, the ledger and the once-only rule are `wake`'s and not a second copy.
 * NEVER THROWS and never changes the tick's exit: a report that cannot be delivered is said on stderr, and a tick that did its work must not become a
 * failure because the report on it could not go. Returns whether `wake` took the orders.
 *
 * @param {TickOrder[]} orders
 * @param {{ node: string, args: string[], spawn?: typeof spawnSync, say?: (text: string) => void }} wake
 * @returns {boolean}
 */
export function deliverTickOrders(orders, { node, args, spawn = spawnSync, say = (text) => process.stderr.write(text) }) {
  if (orders.length === 0) return false;
  const kinds = orders.map((order) => order.subject).join(", ");
  const ran = spawn(node, args, { encoding: "utf8", input: orders.map((order) => `${JSON.stringify(order)}\n`).join("") });
  if (ran.stdout) process.stdout.write(ran.stdout);
  if (ran.stderr) say(ran.stderr);
  const failed = ran.error?.message ?? (ran.status === 0 ? null : `it exited ${ran.status}: the order had nowhere to go`);
  if (failed !== null) say(`TICK HEALTH NOT DELIVERED (${kinds}): wake could not take it (${failed}).\n`);
  return failed === null;
}
