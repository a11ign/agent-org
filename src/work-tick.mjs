#!/usr/bin/env node
// @ts-check
// command: work-tick -- one tick of the org: ask work-gate, hand the orders to wake. Runs on a timer.
//
// THIS EXISTS BECAUSE A SHELL PIPE GETS THE ONE CASE WRONG THAT MATTERS.
// `work-gate.mjs | wake.mjs` looks like the whole job and is a silent-failure machine: the gate writes
// NOTHING to stdout when it cannot read GitHub and exits `CANNOT_ASK` (2), so `wake` reads an empty stdin,
// finds no orders, and exits QUIET. A refused read would report as a quiet org -- the exact reading both
// of those files spend a paragraph refusing to allow. `sh` keeps only the LAST exit status, so the gate's
// 2 is gone before anything could act on it, and `pipefail` is not portable to the `sh` pnpm runs scripts
// with.
//
// So the tick is a program: it reads the gate's exit code, and a gate that could not ask stops the tick
// rather than feeding its silence forward as an answer.
//
// THE TICK IS CHEAP ON PURPOSE. Two `gh` calls, no model. That is the whole point of #912 -- the clock was
// never the defect, the defect was that the clock woke a MODEL. Run this as often as the rate limit allows;
// it costs nothing when the org is quiet, which is most of the time.
//
// ... AND "CHEAP" IS A CLAIM THE TICK NOW CARRIES THE EVIDENCE FOR (a11ign/a11ign#3566). Two to ten minutes of wall clock was measured on 2026-10-04
// and nobody could say whether it was the host or the children, so every tick appends one `tick-cost` line: wall and CPU per phase, children's CPU
// included, and the commands started, by name.
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { refuseUnknownFlags } from "./lib/cli-flags.mjs";
import { completionPath, writeCompletion } from "./lib/tick-completion.mjs";
import { toolVersionLine } from "./lib/tool-version.mjs";
import { clearOwnMarker, deliverTickOrders, killedTickOrders, readKilledTick, slowThresholdSeconds, slowTickOrders, tickMarkerPath,
  writeStartMarker } from "./work-tick-health.mjs";
import { CENSUS_ENV, childrenCpuMs, installSpawnCensus, readCensus, summariseCensus } from "./lib/spawn-census.mjs";

// Where the reader now lives (the census times each spawn's CPU with it); the tick's tests and callers still import it from here.
export { childrenCpuMs };
// THE ONE THING THIS FILE ASKS THAT IS NOT ABOUT DELIVERY. A session herdr reports as `blocked` is
// stopped on a question nobody will answer, and `wake.mjs`'s `WAKEABLE` is `idle`/`done` -- so it is
// never offered another cause and never mentioned anywhere. It has to be reported from HERE rather than
// from `wake`, because `afterGate` returns `deliver: false` on a QUIET gate and `wake` is then never
// run at all -- which is exactly the state it was found in: a quiet queue and a session stuck behind a
// menu since nobody knows when.
import { readAgents, blockedSessions, readHandoffs, handoffQueuePath, ledgerPathFrom, tearDownSpares,
  tearDownReviewers, recoverNow, startAbsentSeats, checkChairmanPath }
  from "./wake.mjs";

/**
 * `0` the tick completed (quiet or delivered); `1` orders had nowhere to go; `2` a read was refused; `70` it CRASHED (#3038).
 *
 * `CRASH` is `src/lib/crash-exit.mjs`'s code, and is the one the unit does NOT declare a success. It is a code of its own because `node`
 * exits `1` on any uncaught exception and `1` is ATTENTION here, so a crash used to read as "orders had nowhere to go".
 */
export const EXIT = { QUIET: 0, ATTENTION: 1, CANNOT_ASK: 2, CRASH: 70 };

/**
 * THE PRELOAD EVERY CHILD THE TICK STARTS RUNS UNDER, whatever started the tick. `work-gate` exits `1` for "found work" (`GATE.WORK`), so a
 * gate that threw would be read as a busy org whose orders were handed to `wake` with nothing on stdin, and `wake` exits `1` for ATTENTION.
 * The unit's own `--import` covers the tick itself and cannot reach a child, so the tick passes it down.
 */
const CRASH_PRELOAD = ["--import", new URL("./lib/crash-exit.mjs", import.meta.url).href];

/** work-gate's own contract, named here so the mapping below reads as a mapping and not as magic numbers. */
export const GATE = { QUIET: 0, WORK: 1, CANNOT_ASK: 2, PARTIAL: 3 };

/**
 * What the tick should do next, given how the gate exited.
 *
 * `PARTIAL` (3) PROCEEDS, and that is the interesting one. The gate reports PARTIAL when one lane answered
 * and the other did not: the orders it printed are real and worth delivering, and the unread lane is
 * reported rather than waited for. Holding real work back because a different queue was unreachable would
 * be the quiet-org reading in the other direction.
 *
 * A QUIET GATE IS NOT AN IDLE TICK WHEN SOMEBODY HAS QUEUED AN ORDER (#1966). `prompt-session.mjs` leaves
 * an order it could not deliver in a queue `wake.mjs` delivers from -- and the case that queue exists for
 * is a reviewer who is busy REVIEWING, which is very often a tick with nothing else outstanding. Exiting
 * here on the gate's code alone would have held that order back exactly when it was the only work there
 * was, and the author would have been told it was queued by something that then never ran.
 *
 * @param {number} code
 * @param {{ queued?: number }} [waiting] how many authored orders are waiting in the handoff queue
 * @returns {{ deliver: boolean, exit?: number, why?: string }}
 */
export function afterGate(code, { queued = 0 } = {}) {
  // BEFORE THE `WORK` BRANCH, which a crash used to land in: node's own exit for a throw is 1, and the preload moves it to 70.
  if (code === EXIT.CRASH) {
    return { deliver: false, exit: EXIT.CRASH,
      why: `work-gate CRASHED (exit ${code}; its stack is above) -- nothing was examined, so NOTHING was woken. This is not a quiet org and not a busy one.` };
  }
  if (code === GATE.QUIET) {
    if (queued === 0) return { deliver: false, exit: EXIT.QUIET };
    return { deliver: true,
      why: `the gate is quiet, but ${queued} authored order(s) are queued for delivery` };
  }
  if (code === GATE.WORK) return { deliver: true };
  if (code === GATE.PARTIAL) return { deliver: true, why: "one lane could not be read; see the gate's stderr" };
  return { deliver: false, exit: EXIT.CANNOT_ASK,
    why: `work-gate exited ${code} -- nothing was examined, so NOTHING was woken. This is not a quiet org.` };
}

/**
 * How many authored orders are waiting -- `0`, WITH A DIAGNOSTIC, when the queue cannot be read.
 *
 * THIS IS ASKED BEFORE THE GATE'S OWN ORDERS ARE DELIVERED, so a corrupt queue must not take the tick
 * down with it: `readHandoffs` throws on a malformed line (deliberately -- a skipped order is the defect
 * that queue exists to remove), and letting that throw here would stop real work over a bad line in a
 * file that has nothing to do with it. `wake` reads the same queue a moment later and reports the same
 * failure with the same throw, where it costs only the orders it is about.
 *
 * @param {string} path @returns {number}
 */
function queuedOrderCount(path) {
  try {
    return readHandoffs(path).length;
  } catch (err) {
    process.stderr.write(`QUEUE UNREADABLE at ${path} `
      + `(${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0].slice(0, 120)}). Any authored `
      + "order in it is NOT being counted; a quiet gate will not deliver it until this file is fixed.\n");
    return 0;
  }
}

// ---- THE COST OF A TICK (a11ign/a11ign#3566) ------------------------------------------------------------------------------------------------

/** One JSON object per tick, beside the wake ledger. NOT IN the ledger: that file is tab-separated deliveries, and a line of another shape is read as one. */
export const TICK_COST_FILE = "tick-cost.jsonl";

/**
 * The file is cut to its newest half past this size. A line is about a kilobyte and a tick runs every two minutes, so the cap holds about two days of
 * ticks -- enough to read three consecutive ones and a bad afternoon, and never a file nobody trims.
 */
export const TICK_COST_BYTES = 2 * 1024 * 1024;

const MS_PER_SECOND = 1000;
const KB = 1024;
const MICROSECONDS_PER_MS = 1000;

/** @param {string} ledgerPath @returns {string} */
export function tickCostPath(ledgerPath) {
  return join(dirname(ledgerPath), TICK_COST_FILE);
}

/** @returns {{ selfMs: number, childrenMs: number }} */
function readCpu() {
  const { user, system } = process.cpuUsage();
  return { selfMs: (user + system) / MICROSECONDS_PER_MS, childrenMs: childrenCpuMs() };
}

const round = (/** @type {number} */ ms) => Math.round(ms);

/**
 * Times named steps of one tick, wall and CPU (children included), and reads the totals. Every source is a parameter so a test can run a tick of two
 * phases with numbers it states; the defaults are the real ones.
 *
 * `startup` is there from the start: it is node's boot and the imports (`wake.mjs` is six thousand lines), which no step of `main()` can time.
 * @param {{ clock?: () => number, cpu?: () => { selfMs: number, childrenMs: number }, uptimeMs?: () => number, maxRssKb?: () => number }} [sources]
 */
export function createMeter({ clock = () => performance.now(), cpu = readCpu, uptimeMs = () => process.uptime() * MS_PER_SECOND,
  maxRssKb = () => process.resourceUsage().maxRSS } = {}) {
  const totalCpuMs = () => { const { selfMs, childrenMs } = cpu(); return selfMs + childrenMs; };
  /** @type {Record<string, { wallMs: number, cpuMs: number }>} */
  const phases = { startup: { wallMs: round(uptimeMs()), cpuMs: round(totalCpuMs()) } };
  return {
    /** @template T @param {string} name @param {() => T} step @returns {T} */
    phase(name, step) {
      const [wallFrom, cpuFrom] = [clock(), totalCpuMs()];
      const result = step();
      phases[name] = { wallMs: round(clock() - wallFrom), cpuMs: round(totalCpuMs() - cpuFrom) };
      return result;
    },
    reading() {
      const { selfMs, childrenMs } = cpu();
      return { wallMs: round(uptimeMs()), cpuMs: { self: round(selfMs), children: round(childrenMs) }, maxRssKb: maxRssKb(), phases };
    },
  };
}

/**
 * What only systemd knows about this run: how long `ExecStartPre` took (the gap between the unit starting to activate and its main process being
 * forked, which no line of this file can time because it runs before this process exists) and the unit's peak memory, the figure the row's table
 * quotes. `null` for both off systemd or when either cannot be read, said on stderr: an unknown is not zero.
 * @param {{ env?: NodeJS.ProcessEnv, readText?: (path: string) => string, run?: (file: string, args: string[]) => string }} [sources]
 * @returns {{ prestartMs: number | null, cgroupPeakKb: number | null }}
 */
export function readUnitFacts({ env = process.env, readText = (path) => readFileSync(path, "utf8"),
  run = (file, args) => execFileSync(file, args, { encoding: "utf8" }) } = {}) {
  const unknown = { prestartMs: null, cgroupPeakKb: null };
  if (!env.INVOCATION_ID) return unknown;
  try {
    const cgroup = readText("/proc/self/cgroup").split("\n").map((line) => line.split("::")[1]).find(Boolean) ?? "";
    const unit = basenameOf(cgroup);
    const shown = run("systemctl", ["--user", "show", unit, "--property=InactiveExitTimestampMonotonic", "--property=ExecMainStartTimestampMonotonic"]);
    const at = Object.fromEntries(shown.trim().split("\n").map((line) => line.split("=")));
    const prestartMs = (Number(at.ExecMainStartTimestampMonotonic) - Number(at.InactiveExitTimestampMonotonic)) / MICROSECONDS_PER_MS;
    const peakBytes = Number(readText(`/sys/fs/cgroup${cgroup}/memory.peak`));
    return { prestartMs: Number.isFinite(prestartMs) ? round(prestartMs) : null, cgroupPeakKb: Number.isFinite(peakBytes) ? round(peakBytes / KB) : null };
  } catch (error) {
    process.stderr.write(`TICK COST: systemd's own figures could not be read (${String(/** @type {any} */ (error)?.message ?? error).split("\n")[0]}).\n`);
    return unknown;
  }
}

/** @param {string} path @returns {string} */
const basenameOf = (path) => path.slice(path.lastIndexOf("/") + 1);

/**
 * Appends one line, and cuts the file to its newest half past {@link TICK_COST_BYTES}, from a whole line (the cut lands mid-line, so the first
 * partial line is dropped) and by rename, so a reader never sees half a file.
 * @param {string} path @param {object} line
 */
export function appendTickCost(path, line) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(line)}\n`);
  if (statSync(path).size <= TICK_COST_BYTES) return;
  const text = readFileSync(path, "utf8");
  const newest = text.slice(-TICK_COST_BYTES / 2);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, newest.slice(newest.indexOf("\n") + 1));
  renameSync(temporary, path);
}

/**
 * What one tick carries from its start to `finish`: where it records, the meter, how many wakes `wake` reported, and how to run `wake` for the
 * two reports a tick makes about itself (`work-tick-health.mjs`).
 * @typedef {{ recordPath: string, costPath: string, censusPath: string, markerPath: string, wakeCommand: { node: string, args: string[] },
 *   meter: ReturnType<typeof createMeter>, wakes: number }} Run
 */

/**
 * THE CENSUS STARTS HERE, before the first spawn, and reaches every process the tick starts two ways: this process is patched in place (it runs the
 * tear-downs itself), and `NODE_OPTIONS` preloads the patch into every `node` below it, the gate and the `node` the gate starts included. One file
 * per tick process, so a tick run by hand beside the timer's cannot read the other's commands.
 * @param {string} ledgerPath @param {string[]} wakeArgs the arguments that run `wake` as a child, after `node` @returns {Run}
 */
function startRun(ledgerPath, wakeArgs) {
  const censusPath = join(dirname(ledgerPath), `tick-census.${process.pid}.jsonl`);
  const preload = `--import=${new URL("./lib/spawn-census.mjs", import.meta.url).href}`;
  process.env[CENSUS_ENV] = censusPath;
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, preload].filter(Boolean).join(" ");
  installSpawnCensus(censusPath);
  return { recordPath: completionPath(ledgerPath), costPath: tickCostPath(ledgerPath), censusPath, markerPath: tickMarkerPath(ledgerPath),
    wakeCommand: { node: process.execPath, args: wakeArgs }, meter: createMeter(), wakes: 0 };
}

/**
 * The line, as the tick stands when it is about to exit. The wall is read BEFORE systemd is asked anything, so asking is not charged to the tick.
 * @param {number} exit @param {Run} run
 */
function tickCostLine(exit, run) {
  const reading = run.meter.reading();
  const { commands, ghRepos, subcommands, slowest, hottest } = summariseCensus(readCensus(run.censusPath));
  return { v: 1, at: Date.now(), exit, load1: loadavg()[0], ...reading, ...readUnitFacts(), wakes: run.wakes, spawns: commands, ghRepos, subcommands, slowest, hottest };
}

/**
 * Said on stderr and never thrown, like the completion record below: a tick that did its work must not become a failure because the file that
 * reports on its cost could not be written. The census file is removed either way. Returns the line, which is what "was this tick slow" reads, or
 * `null` when it could not be made: a tick whose cost cannot be read is not reported slow on a guess.
 * @param {number} exit @param {Run} run @returns {ReturnType<typeof tickCostLine> | null}
 */
function recordCost(exit, run) {
  try {
    const line = tickCostLine(exit, run);
    appendTickCost(run.costPath, line);
    return line;
  } catch (err) {
    process.stderr.write(`TICK COST NOT RECORDED at ${run.costPath}: ${String(/** @type {any} */ (err)?.message ?? err)}.\n`);
    return null;
  } finally {
    rmSync(run.censusPath, { force: true });
  }
}

// ---- A TICK THAT REPORTS ITSELF (a11ign/a11ign#3567) -------------------------------------------------------------------------------------------

/**
 * AT THE START: read what a killed predecessor left, then leave a marker of our own, in that order. The marker is cleared by `exit`, which runs when
 * the process ends BY ITSELF, whatever the code, a crash included, and does not run when a signal ends it: a marker still standing is exactly a tick
 * that was killed. The report goes out here, before the gate, because a gate that is the slow part must not delay the news that it was.
 * @param {Run} run
 */
function beginTickHealth(run) {
  try {
    const killed = readKilledTick(run.markerPath);
    writeStartMarker(run.markerPath, { at: Math.round(Date.now() - process.uptime() * MS_PER_SECOND), pid: process.pid });
    process.on("exit", () => clearOwnMarker(run.markerPath, process.pid));
    deliverTickOrders(killedTickOrders(killed, { foundAt: Date.now(), costPath: run.costPath }), run.wakeCommand);
  } catch (err) {
    process.stderr.write(`TICK HEALTH NOT RECORDED at ${run.markerPath}: ${String(/** @type {any} */ (err)?.message ?? err)}. A killed tick will not be reported.\n`);
  }
}

/**
 * AT THE END, after the cost line, which is what it reads. The marker is cleared FIRST: a tick killed while it reports must not be reported again as
 * killed by the next one, and one report per tick is the row's own rule.
 * @param {ReturnType<typeof tickCostLine> | null} line @param {Run} run
 */
function reportIfSlow(line, run) {
  clearOwnMarker(run.markerPath, process.pid);
  if (line === null) return;
  deliverTickOrders(slowTickOrders(line, { thresholdSeconds: slowThresholdSeconds(), costPath: run.costPath }), run.wakeCommand);
}

/**
 * THE ONE WAY OUT OF `main()`, so that REACHING IT is what the completion record means (#3040). A tick that decided an exit -- quiet, orders with nowhere
 * to go, a refused read -- COMPLETED, and the organisation waiting is not the gate crashing, so every one of those is recorded. A tick that threw
 * never gets here (the preload exits it with `CRASH`), and a tick ending with `CRASH` because a child crashed is not recorded either.
 *
 * A record that cannot be written is said on stderr and does not change the exit: the watcher then reads a stale record and says so, which is the
 * outcome that counts, and a tick that did its work must not be turned into a failure by the file that reports on it. The cost line follows the
 * same two rules, and is written SECOND: the record is what an incident reads, the cost is what a person does.
 *
 * @param {number} code @param {Run} run @returns {never}
 */
function finish(code, run) {
  if (code !== EXIT.CRASH) {
    try {
      writeCompletion(run.recordPath, { at: Date.now(), exit: code });
    } catch (err) {
      process.stderr.write(`COMPLETION NOT RECORDED at ${run.recordPath}: ${String(/** @type {any} */ (err)?.message ?? err)}. incident:gate-crash will read this tick as not having completed.\n`);
    }
    reportIfSlow(recordCost(code, run), run);
  }
  process.exit(code);
}

/**
 * The three tear-downs and the blocked-session report, each one a phase. BEFORE the quiet exit, deliberately, all four: each is an event that
 * produces no order, so a quiet gate is the tick on which it most needs doing.
 * @param {NonNullable<ReturnType<typeof readAgents>>} roster @param {string} ledgerPath @param {Run["meter"]} meter
 */
function tidyRoster(roster, ledgerPath, meter) {
  const blocked = blockedSessions(roster);
  if (blocked.length > 0) {
    process.stderr.write(`BLOCKED ${blocked.join(", ")} -- stopped on a question nobody is going to `
      + "answer. A blocked session is NOT wakeable, so it takes no further cause until a human clears "
      + "it: read its pane (`herdr --session org agent read <name>`) and answer, or restart it.\n");
  }
  // A spawned engineer's row closing is an event that produces no order (#2323).
  meter.phase("tearDownSpares", () => tearDownSpares(roster, ledgerPath));
  // AND ITS SIBLING FOR REVIEWER INSTANCES (#2401): ended when their pull request merges or closes.
  meter.phase("tearDownReviewers", () => tearDownReviewers(roster, ledgerPath));
  // AND THE RECOVERY OF WORK A RESTART OR A KILL DROPPED (#2470): a pane whose last line reads `Interrupted`, and a delivery the ledger
  // recorded that never arrived. It QUEUES (a resume is an authored handoff), and the queue is what makes a quiet gate deliver.
  meter.phase("recover", () => recoverNow(roster, ledgerPath));
}

function main() {
  refuseUnknownFlags(["--ledger", "--roster"], {
    entry: import.meta.url, command: "node packages/agent-org/src/work-tick.mjs",
  });
  const passthrough = process.argv.slice(2);
  const ledgerPath = ledgerPathFrom(passthrough);
  /** @param {string} name */
  const here = (name) => fileURLToPath(new URL(name, import.meta.url));
  const run = startRun(ledgerPath, [...CRASH_PRELOAD, here("./wake.mjs"), ...passthrough]);
  beginTickHealth(run);
  const { meter } = run;
  // FIRST, BEFORE ANYTHING CAN DECIDE (#3443): the host runs one agent-org version and a journal read must say which made each decision. Read from the
  // checkout at this tick, never remembered; a checkout at no release says so rather than naming one.
  console.log(meter.phase("version", toolVersionLine));

  // THEN THE SEATS THE ROSTER MARKS PERSISTENT (#3539): the first tick after a release moves the tag reads THAT tag's roster and starts what it
  // names and is absent. Before the gate and before the quiet exit, because a seat nobody started is most invisible on the tick that has nothing else to say.
  for (const line of meter.phase("seats", () => startAbsentSeats())) process.stderr.write(`${line}\n`);

  // THEN THE CHAIRMAN'S PATH (#3540): the first tick after a release that touched the messaging code, the queue or the roster's readers sends one synthetic inbound through it. After the seats
  // step, so a liaison this tick just started is the seat the check meets; a no-op on every other tick. Its red reaches `ceo`'s queue (written here, so the gate below delivers it) and never the chairman.
  for (const line of meter.phase("chairmanPath", () => checkChairmanPath())) process.stderr.write(`${line}\n`);

  const gate = meter.phase("gate", () => spawnSync(process.execPath, [...CRASH_PRELOAD, here("./work-gate.mjs")], { encoding: "utf8" }));
  if (gate.error) {
    process.stderr.write(`CANNOT ASK: could not run work-gate (${gate.error.message}).\n`);
    finish(EXIT.CANNOT_ASK, run);
  }
  if (gate.stderr) process.stderr.write(gate.stderr);

  // BEFORE THE QUIET EXIT, DELIBERATELY. A blocked session is most invisible precisely when the queue is
  // quiet -- there is no other output that tick, and nothing else looks at the roster.
  const roster = meter.phase("roster", readAgents);
  if (roster !== null) tidyRoster(roster, ledgerPath, meter);

  const queued = meter.phase("queue", () => queuedOrderCount(handoffQueuePath(ledgerPath)));
  const next = afterGate(gate.status ?? EXIT.CANNOT_ASK, { queued });
  if (next.why) process.stderr.write(`${next.why}\n`);
  if (!next.deliver) finish(next.exit ?? EXIT.CANNOT_ASK, run);

  const wake = meter.phase("wake", () => spawnSync(run.wakeCommand.node, run.wakeCommand.args, { encoding: "utf8", input: gate.stdout }));
  if (wake.error) {
    process.stderr.write(`CANNOT ASK: could not run wake (${wake.error.message}). The gate found work and `
      + "it was NOT delivered.\n");
    finish(EXIT.CANNOT_ASK, run);
  }
  if (wake.stdout) process.stdout.write(wake.stdout);
  if (wake.stderr) process.stderr.write(wake.stderr);
  run.wakes = (wake.stdout ?? "").split("\n").filter((line) => line.startsWith("WOKE ")).length;
  if (wake.status === EXIT.CRASH) process.stderr.write("wake CRASHED (its stack is above): the orders the gate found were NOT delivered.\n");
  finish(wake.status ?? EXIT.CANNOT_ASK, run);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
