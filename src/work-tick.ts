#!/usr/bin/env node
// @ts-check
// command: work-tick -- one tick of the org: ask work-gate, hand the orders to wake. Runs on a timer.
//
// THIS EXISTS BECAUSE A SHELL PIPE GETS THE ONE CASE WRONG THAT MATTERS.
// `work-gate.ts | wake.ts` looks like the whole job and is a silent-failure machine: the gate writes
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
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { refuseUnknownFlags } from "./lib/cli-flags.ts";
import { tellBlocked, BLOCKED_TOLD_FILE } from "./worker-state.ts";
import { EVENT_QUEUE_ENTRY, homeHostConfig, stateEntryPath, type HostConfig } from "./host-config.ts";
import { ackThrough, changedRepos, readNewEvents, scopesOf, type Scope } from "./event-queue.ts";
import { dueRepos, readDueIndex } from "./due-index.ts";
import { writeTickScopes } from "./tick-scopes.ts";
import { defaultRun, promptOrQueue, STANCE, EXIT as PROMPT_EXIT } from "./prompt-session.ts";
import { PANE_DIALOG_RAISED_FILE, raisePaneDialogs, readRaised, writeRaised } from "./pane-dialog.ts";
import { HOME_CHECKOUT, PROJECT_DECLARATION_PATH, homeProjectDeclaration } from "./project-config.ts";
import { BACKLOG_LABEL, LANE_PREFIX, OUT_OF_RELEASE_LABEL } from "./project-vocabulary.ts";
import { completionPath, writeCompletion } from "./lib/tick-completion.ts";
import { toolVersionLine } from "./lib/tool-version.ts";
import { refreshTickSnapshot, type TickEvents } from "./tick-snapshot.ts";
import { TICK_COST_FILE, TICK_RECORD_MARKER, TICK_RECORD_ROW_TITLE, clearOwnMarker, deliverTickOrders, killedTickOrders, phaseMarker, readKilledTick, readTickRecordState, recordSlowTick, slowThresholdSeconds,
  standingRowFor, tickMarkerPath, tickRecordPath, tickRecordRowBody, writeStartMarker, type RecordIo } from "./work-tick-health.ts";
import { createRow, editComment, keyedCommentsOf, postRowComment } from "./ticket-port/approved-unqueued-reads.ts";
import type { RowsRun } from "./plugins/contracts/code-host-rows.ts";
import { rows } from "./plugins/rows.ts";
import { CENSUS_ENV, GATE_SPANS_ENV, childrenCpuMs, installSpawnCensus, largestSpans, readCensus, readGateSpans, setCensusPhase, summariseCensus } from "./lib/spawn-census.ts";

// Where the reader now lives (the census times each spawn's CPU with it); the tick's tests and callers still import it from here.
export { childrenCpuMs };
// THE ONE THING THIS FILE ASKS THAT IS NOT ABOUT DELIVERY. A session herdr reports as `blocked` is
// stopped on a question nobody will answer, and `wake.ts`'s `WAKEABLE` is `idle`/`done` -- so it is
// never offered another cause and never mentioned anywhere. It has to be reported from HERE rather than
// from `wake`, because `afterGate` returns `deliver: false` on a QUIET gate and `wake` is then never
// run at all -- which is exactly the state it was found in: a quiet queue and a session stuck behind a
// menu since nobody knows when.
import { herdrAgentName, readAgents } from "./herdr-agents.ts";
import { readHandoffs, handoffQueuePath, ledgerPathFrom, tearDownReviewers } from "./wake/seat-reset.ts";
import { tearDownSpares, recoverNow } from "./wake/ci-class-and-spares.ts";
import { startAbsentSeats, checkChairmanPath } from "./wake/release-line-and-seats.ts";
import { paneReader } from "./wake/exit-and-limits.ts";

/**
 * `0` the tick completed (quiet or delivered); `1` orders had nowhere to go; `2` a read was refused; `70` it CRASHED (#3038).
 *
 * `CRASH` is `src/lib/crash-exit.ts`'s code, and is the one the unit does NOT declare a success. It is a code of its own because `node`
 * exits `1` on any uncaught exception and `1` is ATTENTION here, so a crash used to read as "orders had nowhere to go".
 */
export const EXIT = { QUIET: 0, ATTENTION: 1, CANNOT_ASK: 2, CRASH: 70 };

/**
 * THE PRELOAD EVERY CHILD THE TICK STARTS RUNS UNDER, whatever started the tick. `work-gate` exits `1` for "found work" (`GATE.WORK`), so a
 * gate that threw would be read as a busy org whose orders were handed to `wake` with nothing on stdin, and `wake` exits `1` for ATTENTION.
 * The unit's own `--import` covers the tick itself and cannot reach a child, so the tick passes it down.
 */
const CRASH_PRELOAD = ["--import", new URL("./lib/crash-exit.ts", import.meta.url).href];

/** work-gate's own contract, named here so the mapping below reads as a mapping and not as magic numbers. */
export const GATE = { QUIET: 0, WORK: 1, CANNOT_ASK: 2, PARTIAL: 3, PACED: 4 };

/**
 * THE GATE'S WALL BUDGET, in ms (a11ign/agent-org#1080). The gate was spawned with no deadline, so one slow read spent the unit's whole `TimeoutStartSec`
 * and the tick yielded nothing: no `GATE` line, no orders, and no way to say which read it was in. Measured wall was 77-193 s over the ticks that read it;
 * five minutes is well above that and well under the unit's 600 s.
 */
export const GATE_BUDGET_MS = 300_000;
/**
 * What the unit's `TimeoutStartSec` still leaves beside the gate's budget: the steps before the gate (seats, the chairman's path, the snapshot) and the
 * wake after it, which has no bound of its own. The test that pins it reads `TimeoutStartSec` from `host/work-tick.service.in`.
 */
export const WAKE_ROOM_MS = 240_000;

/**
 * What the tick should do next, given how the gate exited.
 *
 * `PARTIAL` (3) PROCEEDS, and that is the interesting one. `PACED` (4) is its twin for a gate whose only unread lanes were skipped by design, and proceeds too. The gate reports PARTIAL when one lane answered
 * and the other did not: the orders it printed are real and worth delivering, and the unread lane is
 * reported rather than waited for. Holding real work back because a different queue was unreachable would
 * be the quiet-org reading in the other direction.
 *
 * A QUIET GATE IS NOT AN IDLE TICK WHEN SOMEBODY HAS QUEUED AN ORDER (#1966). `prompt-session.ts` leaves
 * an order it could not deliver in a queue `wake.ts` delivers from -- and the case that queue exists for
 * is a reviewer who is busy REVIEWING, which is very often a tick with nothing else outstanding. Exiting
 * here on the gate's code alone would have held that order back exactly when it was the only work there
 * was, and the author would have been told it was queued by something that then never ran.
 *
 * @param {number} code
 * @param {{ queued?: number }} [waiting] how many authored orders are waiting in the handoff queue
 * @returns {{ deliver: boolean, exit?: number, why?: string }}
 */
export function afterGate(code: number, { queued = 0 }: { queued?: number; } = {}): { deliver: boolean; exit?: number; why?: string; } {
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
  // agent-org#1414: every unread lane was skipped BY DESIGN (pacing, or no event named it) and none was refused: a position reading, not a fault.
  if (code === GATE.PACED) return { deliver: true, why: "lane(s) skipped by pacing, none refused; see the gate's stderr" };
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
function queuedOrderCount(path: string): number {
  try {
    return readHandoffs(path).length;
  } catch (err) {
    process.stderr.write(`QUEUE UNREADABLE at ${path} `
      + `(${String((err as any)?.message ?? err).split("\n")[0].slice(0, 120)}). Any authored `
      + "order in it is NOT being counted; a quiet gate will not deliver it until this file is fixed.\n");
    return 0;
  }
}

// ---- THE COST OF A TICK (a11ign/a11ign#3566) ------------------------------------------------------------------------------------------------

/** One JSON object per tick, beside the wake ledger. NOT IN the ledger: that file is tab-separated deliveries, and a line of another shape is read as one. */
export { TICK_COST_FILE }; // named in `work-tick-health.ts` (a leaf), which the gate and the weekly report read the cost file through

/**
 * The file is cut to its newest half past this size, so the half must hold a day of ticks for the tick-wall readback (a11ign/agent-org#1210) to read
 * 24 hours. That reading had 410 ticks in 15.7 h, about 26 an hour and about 2.5 KiB each: a day is about 1.6 MiB, which the half of the old 2 MiB cap
 * (1 MiB) could not hold. At 4 MiB the half is 2 MiB, about 800 ticks and 30 hours at that rate.
 */
export const TICK_COST_BYTES = 4 * 1024 * 1024;

const MS_PER_SECOND = 1000;
const KB = 1024;
const MICROSECONDS_PER_MS = 1000;

/** @param {string} ledgerPath @returns {string} */
export function tickCostPath(ledgerPath: string): string {
  return join(dirname(ledgerPath), TICK_COST_FILE);
}

/** @returns {{ selfMs: number, childrenMs: number }} */
function readCpu(): { selfMs: number; childrenMs: number; } {
  const { user, system } = process.cpuUsage();
  return { selfMs: (user + system) / MICROSECONDS_PER_MS, childrenMs: childrenCpuMs() };
}

const round = (ms: number) => Math.round(ms);

/**
 * Times named steps of one tick, wall and CPU (children included), and reads the totals. Every source is a parameter so a test can run a tick of two
 * phases with numbers it states; the defaults are the real ones.
 *
 * `startup` is there from the start: it is node's boot and the imports (`wake.ts` is six thousand lines), which no step of `main()` can time.
 * `begun` is told each phase's name as it starts, before its wall is taken, so the start marker can name the phase a killed tick sat in (agent-org#1542).
 * @param {{ clock?: () => number, cpu?: () => { selfMs: number, childrenMs: number }, uptimeMs?: () => number, maxRssKb?: () => number, begun?: (name: string) => void }} [sources]
 */
export function createMeter({ clock = () => performance.now(), cpu = readCpu, uptimeMs = () => process.uptime() * MS_PER_SECOND,
  maxRssKb = () => process.resourceUsage().maxRSS, begun = () => {} }: { clock?: () => number; cpu?: () => { selfMs: number; childrenMs: number; }; uptimeMs?: () => number; maxRssKb?: () => number; begun?: (name: string) => void; } = {}) {
  const totalCpuMs = () => { const { selfMs, childrenMs } = cpu(); return selfMs + childrenMs; };
  const phases: Record<string, { wallMs: number; cpuMs?: number; }> = { startup: { wallMs: round(uptimeMs()), cpuMs: round(totalCpuMs()) } };
  return {
    /** @template T @param {string} name @param {() => T} step @returns {T} */
    phase<T>(name: string, step: () => T): T {
      begun(name);
      const [wallFrom, cpuFrom] = [clock(), totalCpuMs()];
      setCensusPhase(name);
      let result: T;
      try {
        result = step();
      } finally {
        setCensusPhase(undefined);
      }
      phases[name] = { wallMs: round(clock() - wallFrom), cpuMs: round(totalCpuMs() - cpuFrom) };
      return result;
    },
    /**
     * A phase some OTHER process timed and said, so there is a wall and no CPU: the field is absent, because an unknown CPU is not zero. It sits inside
     * the phase that relayed it, so it is read beside that one and never added to it.
     * @param {string} name @param {number} wallMs
     */
    note(name: string, wallMs: number) {
      phases[name] = { wallMs: round(wallMs) };
    },
    reading() {
      const { selfMs, childrenMs } = cpu();
      return { wallMs: round(uptimeMs()), cpuMs: { self: round(selfMs), children: round(childrenMs) }, maxRssKb: maxRssKb(), phases };
    },
  };
}

/** One `ExecStartPre` command of the unit and how long it ran: `wallMs` is `null` when its start or exit time cannot be read, which is not zero. */
export type PrestartStep = { command: string; wallMs: number | null };

/**
 * `systemctl --timestamp=us+utc` prints `Sun 2026-10-11 16:25:20.953680 UTC` (whole seconds without the fraction), the one form that is both
 * microsecond-exact and the same zone on every host; `[n/a]` and a missing field are `null`.
 * @param {string | undefined} text @returns {number | null} epoch milliseconds
 */
function parseSystemdTime(text: string | undefined): number | null {
  const parts = /(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?:\.(\d+))? UTC/.exec(text ?? "");
  if (!parts) return null;
  const whole = Date.parse(`${parts[1]}T${parts[2]}Z`);
  return Number.isFinite(whole) ? whole + Number(`0.${parts[3] ?? "0"}`) * MS_PER_SECOND : null;
}

/**
 * Each `ExecStartPre=` line of `systemctl show` (one per command, in the order they ran) as its command and wall. The line is
 * `{ path=... ; argv[]=<command> ; ignore_errors=yes ; start_time=[...] ; stop_time=[...] ; pid=... ; code=exited ; status=0 }`.
 * @param {string} shown @returns {PrestartStep[]}
 */
export function parsePrestartSteps(shown: string): PrestartStep[] {
  const field = /^(?:path|ignore_errors|start_time|stop_time|pid|code|status)=/;
  return shown.split("\n").filter((line) => line.startsWith("ExecStartPre=") && line.length > "ExecStartPre=".length).map((line) => {
    const items = line.slice("ExecStartPre=".length).replace(/^\{\s*/, "").replace(/\s*\}$/, "").split(" ; ");
    const at = Object.fromEntries(items.filter((item) => field.test(item)).map((item) => [item.slice(0, item.indexOf("=")), item.slice(item.indexOf("=") + 1).replace(/^\[(.*)\]$/, "$1")]));
    const from = items.findIndex((item) => item.startsWith("argv[]="));
    const stop = items.findIndex((item, index) => index > from && field.test(item));
    const command = from < 0 ? (at.path ?? "") : items.slice(from, stop < 0 ? undefined : stop).join(" ; ").slice("argv[]=".length);
    const [start, exit] = [parseSystemdTime(at.start_time), parseSystemdTime(at.stop_time)];
    return { command, wallMs: start !== null && exit !== null && exit >= start ? round(exit - start) : null };
  });
}

/**
 * What only systemd knows about this run: how long `ExecStartPre` took (the gap between the unit starting to activate and its main process being
 * forked, which no line of this file can time because it runs before this process exists), each of its commands' own wall (`prestartSteps`, so
 * `primary:update` and the tool update are told apart, #920) and the unit's peak memory, the figure the row's table quotes. `null` for all off
 * systemd or when the reading cannot be made, said on stderr: an unknown is not zero. A step whose start or exit time is not in the output has a `null` wall of its own.
 * @param {{ env?: NodeJS.ProcessEnv, readText?: (path: string) => string, run?: (file: string, args: string[]) => string }} [sources]
 * @returns {{ prestartMs: number | null, prestartSteps: PrestartStep[] | null, cgroupPeakKb: number | null }}
 */
export function readUnitFacts({ env = process.env, readText = (path) => readFileSync(path, "utf8"),
  run = (file, args) => execFileSync(file, args, { encoding: "utf8" }) }: { env?: NodeJS.ProcessEnv; readText?: (path: string) => string; run?: (file: string, args: string[]) => string; } = {}): { prestartMs: number | null; prestartSteps: PrestartStep[] | null; cgroupPeakKb: number | null; } {
  const unknown = { prestartMs: null, prestartSteps: null, cgroupPeakKb: null };
  if (!env.INVOCATION_ID) return unknown;
  try {
    const cgroup = readText("/proc/self/cgroup").split("\n").map((line) => line.split("::")[1]).find(Boolean) ?? "";
    const unit = basenameOf(cgroup);
    const shown = run("systemctl", ["--user", "--timestamp=us+utc", "show", unit, "--property=InactiveExitTimestampMonotonic", "--property=ExecMainStartTimestampMonotonic", "--property=ExecStartPre"]);
    const at = Object.fromEntries(shown.trim().split("\n").filter((line) => !line.startsWith("ExecStartPre=")).map((line) => line.split("=")));
    const prestartMs = (Number(at.ExecMainStartTimestampMonotonic) - Number(at.InactiveExitTimestampMonotonic)) / MICROSECONDS_PER_MS;
    const peakBytes = Number(readText(`/sys/fs/cgroup${cgroup}/memory.peak`));
    const steps = parsePrestartSteps(shown);
    return { prestartMs: Number.isFinite(prestartMs) ? round(prestartMs) : null, prestartSteps: steps, cgroupPeakKb: Number.isFinite(peakBytes) ? round(peakBytes / KB) : null };
  } catch (error) {
    process.stderr.write(`TICK COST: systemd's own figures could not be read (${String((error as any)?.message ?? error).split("\n")[0]}).\n`);
    return unknown;
  }
}

/** @param {string} path @returns {string} */
const basenameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * Appends one line, and cuts the file to its newest half past {@link TICK_COST_BYTES}, from a whole line (the cut lands mid-line, so the first
 * partial line is dropped) and by rename, so a reader never sees half a file.
 * @param {string} path @param {object} line
 */
export function appendTickCost(path: string, line: object) {
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
 * What one tick carries from its start to `finish`: where it records, the meter, how many wakes `wake` reported, and how to run `wake` for the two reports a tick makes about itself (`work-tick-health.ts`).
 */
export type Run = { recordPath: string, costPath: string, censusPath: string, gateSpansPath: string, markerPath: string, start: { at: number, pid: number }, wakeCommand: { node: string, args: string[] }, meter: ReturnType<typeof createMeter>, wakes: number, gateKilled: boolean };

/**
 * THE CENSUS STARTS HERE, before the first spawn, and reaches every process the tick starts two ways: this process is patched in place (it runs the
 * tear-downs itself), and `NODE_OPTIONS` preloads the patch into every `node` below it, the gate and the `node` the gate starts included. One file
 * per tick process, so a tick run by hand beside the timer's cannot read the other's commands.
 * @param {string} ledgerPath @param {string[]} wakeArgs the arguments that run `wake` as a child, after `node` @returns {Run}
 */
function startRun(ledgerPath: string, wakeArgs: string[]): Run {
  const censusPath = join(dirname(ledgerPath), `tick-census.${process.pid}.jsonl`);
  const preload = `--import=${new URL("./lib/spawn-census.ts", import.meta.url).href}`;
  process.env[CENSUS_ENV] = censusPath;
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, preload].filter(Boolean).join(" ");
  installSpawnCensus(censusPath);
  const gateSpansPath = join(dirname(ledgerPath), `tick-gate-spans.${process.pid}.jsonl`); // handed to the gate alone (`GATE_SPANS_ENV`), never put in this process's environment
  const markerPath = tickMarkerPath(ledgerPath);
  // The start the marker keeps for the whole run (agent-org#1542): every phase boundary rewrites the marker with this same start and the phase begun.
  const start = { at: Math.round(Date.now() - process.uptime() * MS_PER_SECOND), pid: process.pid };
  return { recordPath: completionPath(ledgerPath), costPath: tickCostPath(ledgerPath), censusPath, gateSpansPath, markerPath, start,
    wakeCommand: { node: process.execPath, args: wakeArgs }, meter: createMeter({ begun: phaseMarker(markerPath, start) }), wakes: 0, gateKilled: false };
}

/**
 * THE GATE'S FIVE LARGEST SPANS for the cost line (agent-org#1050), or `null` when the gate reported none: `[]` would say the gate was free. A gate
 * killed at its budget never ended the span it was in, which is the largest on the tick that matters, so its wall (the gate phase's, `killedWallMs`)
 * beyond the spans that did end is added as one span named for the last step that finished, with no CPU or `gh` count (unread, not zero).
 * @param {import("./lib/spawn-census.ts").GateSpan[] | null} spans @param {number | undefined} killedWallMs set only for a gate the tick killed
 */
export function gateSpansOf(spans: import("./lib/spawn-census.ts").GateSpan[] | null, killedWallMs?: number) {
  if (spans === null) return null;
  const unfinished = killedWallMs === undefined ? [] : [{ name: `unfinished after ${spans[spans.length - 1].name}`, wallMs: Math.max(0, Math.round(killedWallMs - spans.reduce((sum, span) => sum + span.wallMs, 0))), cpuMs: null, ghCalls: null }];
  return largestSpans([...spans, ...unfinished]);
}

/**
 * The line, as the tick stands when it is about to exit. The wall is read BEFORE systemd is asked anything, so asking is not charged to the tick.
 * @param {number} exit @param {Run} run
 */
function tickCostLine(exit: number, run: Run) {
  const reading = run.meter.reading();
  const { commands, ghRepos, subcommands, phaseCalls, slowest, hottest } = summariseCensus(readCensus(run.censusPath));
  const gateSpans = gateSpansOf(readGateSpans(run.gateSpansPath), run.gateKilled ? reading.phases.gate?.wallMs : undefined);
  return { v: 1, at: Date.now(), exit, load1: loadavg()[0], ...reading, ...readUnitFacts(), wakes: run.wakes, spawns: commands, ghRepos, subcommands, phaseCalls, slowest, hottest, gateSpans };
}

/**
 * Said on stderr and never thrown, like the completion record below: a tick that did its work must not become a failure because the file that
 * reports on its cost could not be written. The census file is removed either way. Returns the line, which is what "was this tick slow" reads, or
 * `null` when it could not be made: a tick whose cost cannot be read is not reported slow on a guess.
 * @param {number} exit @param {Run} run @returns {ReturnType<typeof tickCostLine> | null}
 */
function recordCost(exit: number, run: Run): ReturnType<typeof tickCostLine> | null {
  try {
    const line = tickCostLine(exit, run);
    appendTickCost(run.costPath, line);
    return line;
  } catch (err) {
    process.stderr.write(`TICK COST NOT RECORDED at ${run.costPath}: ${String((err as any)?.message ?? err)}.\n`);
    return null;
  } finally {
    rmSync(run.censusPath, { force: true });
    rmSync(run.gateSpansPath, { force: true });
  }
}

// ---- A TICK THAT REPORTS ITSELF (a11ign/a11ign#3567) -------------------------------------------------------------------------------------------

/**
 * AT THE START: read what a killed predecessor left, then leave a marker of our own, in that order. The marker is cleared by `exit`, which runs when
 * the process ends BY ITSELF, whatever the code, a crash included, and does not run when a signal ends it: a marker still standing is exactly a tick
 * that was killed. The report goes out here, before the gate, because a gate that is the slow part must not delay the news that it was.
 * @param {Run} run
 */
function beginTickHealth(run: Run) {
  try {
    const killed = readKilledTick(run.markerPath);
    writeStartMarker(run.markerPath, run.start);
    process.on("exit", () => clearOwnMarker(run.markerPath, process.pid));
    deliverTickOrders(killedTickOrders(killed, { foundAt: Date.now(), costPath: run.costPath }), run.wakeCommand);
  } catch (err) {
    process.stderr.write(`TICK HEALTH NOT RECORDED at ${run.markerPath}: ${String((err as any)?.message ?? err)}. A killed tick will not be reported.\n`);
  }
}

/**
 * AT THE END, after the cost line, which is what it reads. The marker is cleared FIRST: a tick killed while it reports must not be reported again as
 * killed by the next one, and one report per tick is the row's own rule. A SLOW tick is RECORDED on the standing row and wakes nobody (agent-org#1208); the
 * same call retries a record an earlier tick could not write. It never throws, and the file's own `recordSlowTick` says what was refused.
 * @param {ReturnType<typeof tickCostLine> | null} line @param {Run} run
 */
function reportIfSlow(line: ReturnType<typeof tickCostLine> | null, run: Run) {
  clearOwnMarker(run.markerPath, process.pid);
  recordSlowTick({ line, costText: readCostText(run.costPath), now: Date.now(), thresholdSeconds: slowThresholdSeconds(), costPath: run.costPath,
    statePath: tickRecordPath(run.markerPath), io: () => tickRecordIo(tickRecordPath(run.markerPath)) });
}

/** The cost file as text, or `""` when it cannot be read: the record then rests on this tick's own line, and says so by counting one tick. @param {string} path */
function readCostText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * THE TICK RECORD ROW IS CREATED ON THE BOARDING PATH (agent-org#1229, a11ign#5275). A bare `gh issue create` with `lane:ceo` alone never reached Project 1, and the
 * gate's `row-off-board` order then asked for a Status the sanctioned `row-file --board` refuses to give a standing record (no Region, Acceptance or Open-check). The
 * labels are what `row-file` writes for a Backlog row: the gate's `settleOffBoardRows` boards a row whose one state label names a Status, so this row is boarded at
 * Backlog by the next tick past the grace and no order is sent; `out-of-release` is its release declaration, and `lane:ceo` keeps it from being claimed as work.
 */
export const TICK_RECORD_ROW_LABELS: readonly string[] = [`${LANE_PREFIX}ceo`, BACKLOG_LABEL, OUT_OF_RELEASE_LABEL];

/** Create the tick's standing row in `repo` with {@link TICK_RECORD_ROW_LABELS}; answers its number. */
export function createTickRecordRow(repo: string, run: (args: string[]) => string): number {
  return createRow({ repo, title: TICK_RECORD_ROW_TITLE, labels: [...TICK_RECORD_ROW_LABELS], body: tickRecordRowBody(), run });
}

/**
 * The standing comment through the ticket port's argument builders and `ghRun`. The row is the declared `units.tickRecordIssue`, else the one this tick created before, else
 * one created NOW, once, `lane:ceo` and not `ready` so it is never offered as work (`standingRowFor`); it is never found by title. `{ refusal }` when it can be neither named
 * nor created, which is a refused write like any other (never a wake). Asked only when a write is due, so an ordinary tick reads and creates nothing.
 * @param {string} statePath @returns {RecordIo | { refusal: string }}
 */
function tickRecordIo(statePath: string): RecordIo | { refusal: string } {
  let declarationText: string;
  try {
    declarationText = readFileSync(join(HOME_CHECKOUT, PROJECT_DECLARATION_PATH), "utf8");
  } catch (err) {
    return { refusal: `the project declaration could not be read (${String((err as any)?.message ?? err).split("\n")[0]})` };
  }
  const run = (args: string[]) => ghRun()(args);
  const target = standingRowFor({ declarationText, state: readTickRecordState(statePath), statePath,
    create: (repo) => createTickRecordRow(repo, run) });
  if ("refusal" in target) return target;
  const { repo, issue } = target;
  return {
    find: () => keyedCommentsOf({ repo, row: issue, marker: TICK_RECORD_MARKER, since: "1970-01-01T00:00:00Z", run }).at(-1)?.id ?? null,
    post: (body) => { postRowComment({ repo, row: issue, body, run }); return null; },
    edit: (id, body) => editComment({ repo, id, body, run }),
  };
}

/**
 * The whole order lines of a gate that was killed at its budget (#1080). The gate prints one JSON line per order, so the segment after the last newline
 * is the one the kill cut (empty when the output ended on a newline); it is dropped, and so is any line that is not JSON.
 */
export function wholeOrderLines(printed: string): string[] {
  return printed.split("\n").slice(0, -1).filter((line) => {
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * The journal line for a gate that ran out of its budget (#1080): the read it was in and how many had finished, from this tick's census, and what the
 * tick did with what the gate printed. The census's gate reads are the ones with no `phase`: the tick's own spawns in a phase are the snapshot's, the
 * seats' and the gate's own spawn, which is written only when the kill returns. A synchronous read killed mid-call writes no census line at all, so
 * when none is on record the line says so rather than naming a read it cannot see.
 *
 * @param censusPath this tick's census file @param handed how many whole orders were kept for `wake`
 */
export function gateBudgetLine(censusPath: string, handed: number): string {
  let reads: string;
  try {
    if (existsSync(censusPath)) {
      const gateReads = readCensus(censusPath).filter((record) => (record as { phase?: string }).phase === undefined);
      const inFlight = gateReads.filter((record) => record.ms === null);
      const finished = gateReads.length - inFlight.length;
      const named = inFlight.length === 0 ? "no unfinished read on record (a synchronous read killed mid-call writes none)"
        : `in ${inFlight.map((record) => record.line).join("; ")}`;
      reads = `${named}, ${finished} reads finished`;
    }
    else reads = "no census file";
  } catch (error) {
    reads = `census unreadable (${(error as Error).message})`;
  }
  const outcome = handed > 0 ? `${handed} whole order(s) handed on to wake` : "no whole order printed, so CANNOT ASK and nothing was woken";
  return `GATE OUT OF BUDGET after ${GATE_BUDGET_MS / 1000} s: ${reads}. ${outcome}.`;
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
function finish(code: number, run: Run): never {
  if (code !== EXIT.CRASH) {
    const at = Date.now();
    try {
      writeCompletion(run.recordPath, { at, exit: code });
      writeHeartbeat(at);
    } catch (err) {
      process.stderr.write(`COMPLETION NOT RECORDED at ${run.recordPath}: ${String((err as any)?.message ?? err)}. incident:gate-crash will read this tick as not having completed.\n`);
    }
    reportIfSlow(recordCost(code, run), run);
  }
  process.exit(code);
}

/** The one GitHub object the last completion lives in (a11ign/a11ign#3880): a variable of EACH declared tracker's repository (#4080; the standing comment is the first's alone), because it is ONE value overwritten in place, where a comment stream grows. */
export const HEARTBEAT_VARIABLE = "GATE_LAST_TICK";
/**
 * ITS SIBLING FOR A READER WITH NO TOKEN (a11ign/a11ign#3896): the control plane's token has no scopes, and GitHub answers it `403` for an Actions variable
 * while it reads every public object of the repository. So the tick also EDITS one standing comment of the tracker repository, whose `updated_at` is the last
 * completion on GitHub's own clock. It is comment `HEARTBEAT_COMMENT_ID` on a11ign/a11ign#3880, a CLOSED issue, so the gate never offers it as a row (an open
 * unlabelled issue is a stall, #3212). Created by hand once, as the variable was, by `a11ign-ai-workers`: only a comment's author (or an admin) may edit it, and that
 * is the identity the work-tick unit's `GH_CONFIG_DIR` runs as. The tick only edits: a deleted comment fails loudly and is never recreated in a loop.
 */
export const HEARTBEAT_COMMENT_ID = 6026375754;
/** The first line of the comment body, so a reader (or a person) can tell the object from a stray comment. */
export const HEARTBEAT_COMMENT_MARKER = "<!-- gate-heartbeat -->";
const HEARTBEAT_TIMEOUT_MS = 30_000;

/**
 * The comment's body for one completion. It MUST differ on every tick: MEASURED 2026-10-06 on this very comment, an edit that changes nothing leaves
 * `updated_at` where it was, so a body that repeated would read as a gate that stopped. The epoch milliseconds are unique per completion; the ISO stamp is for a person.
 * @param {number} at epoch milliseconds @returns {string}
 */
export function heartbeatCommentBody(at: number): string {
  return `${HEARTBEAT_COMMENT_MARKER}\n${at} ${new Date(at).toISOString()}\n`;
}

/** @param {unknown} err @returns {string} what `gh` said, else the error's own message */
function whatGhSaid(err: unknown): string {
  return String((err as any)?.stderr ?? "").trim() || String((err as any)?.message ?? err);
}

/**
 * THE COMPLETION, WHERE SOMETHING OFF THIS HOST CAN READ IT (#3851, incident #3846 1c). `work-tick-completion.json` is a file on a machine that may be
 * frozen, so the control plane could not read it without an ssh into that machine. The value is the same epoch milliseconds the file holds, written
 * AFTER the file, and ONLY IF the file was written (a record that failed leaves the reader off this host with the stale value the file's reader has too), because the file is what `incident:gate-crash` reads on this host, and only from `finish`, so it means what the file means: a tick
 * that reached the end, not a tick that started.
 *
 * Two writes, each failing alone: the variable (the host's own readers) and the standing comment (the reader with no token, #3896). A write that fails is said on
 * stderr and changes nothing else, for the reason `finish` gives: the reader then sees a stale value, which is the outcome that counts. The variable must already
 * exist (`gh api -X POST repos/<repo>/actions/variables`) and so must the comment; a missing one fails here and says so.
 * @param {number} at epoch milliseconds
 * @param {() => readonly { repo: string }[]} [readTrackers] the declared trackers; a seam so a test needs no project declaration @returns {void}
 */
export function writeHeartbeat(at: number, readTrackers: () => readonly { repo: string; }[] = () => homeProjectDeclaration().tracker): void {
  let trackers: readonly { repo: string; }[];
  try {
    trackers = readTrackers();
  } catch (err) {
    process.stderr.write(`HEARTBEAT NOT WRITTEN to the tracker variable ${HEARTBEAT_VARIABLE}: ${whatGhSaid(err)}. A reader off this host will see the previous value.\n`);
    return;
  }
  // #4080: EVERY declared tracker's repository holds the variable, a refusal on one naming that repository and stopping no other write. The standing comment is
  // the FIRST tracker's alone: `HEARTBEAT_COMMENT_ID` is an object of that repository (a PATCH of it through another repository's path is a 404), and the one reader
  // of it (`gate-heartbeat.mjs` of the control repository) reads that one object, so a second comment would have no reader.
  trackers.forEach(({ repo }, index) => {
    writeHeartbeatVariable({ at, repo });
    if (index === 0) writeHeartbeatComment({ at, repo });
  });
}

/**
 * THE CODE HOST'S OWN RUNNER for the heartbeat's two writes and the tick record's reads and writes (agent-org#1208): the bound a call may take, and what it prints on stderr kept to the failure (a refusal throws with
 * `stderr` on the error, which `whatGhSaid` and `recordSlowTick` say). Asked when a call is made, so a tick that cannot reach the code host says so in the line of the write that needed it (A11-160, step 9).
 * @returns {(args: string[]) => string}
 */
function ghRun(): RowsRun {
  return rows().runnerWith({ timeoutMs: HEARTBEAT_TIMEOUT_MS, echo: false });
}

/** @param {{ at: number, repo: string }} write @returns {void} */
function writeHeartbeatVariable({ at, repo }: { at: number; repo: string; }): void {
  try {
    rows().writeHeartbeatVariable({ repo, variable: HEARTBEAT_VARIABLE, value: String(at), run: ghRun() });
  } catch (err) {
    process.stderr.write(`HEARTBEAT NOT WRITTEN to ${repo} variable ${HEARTBEAT_VARIABLE}: ${whatGhSaid(err)}. A reader off this host will see the previous value.\n`);
  }
}

/** @param {{ at: number, repo: string }} write @returns {void} */
function writeHeartbeatComment({ at, repo }: { at: number; repo: string; }): void {
  try {
    editComment({ repo, id: HEARTBEAT_COMMENT_ID, body: heartbeatCommentBody(at), run: ghRun() });
  } catch (err) {
    process.stderr.write(`HEARTBEAT COMMENT NOT WRITTEN to ${repo} comment ${HEARTBEAT_COMMENT_ID}: ${whatGhSaid(err)}. A reader with no token will see the previous value.\n`);
  }
}

/** The gate's line about GitHub's status page (`holdForIncidentNow`): all three states say the call's wall, `N ms`, and a read that never got one says `wall not read`. */
const GITHUB_STATUS_WALL = /^(?:github-status: operational \(call |github-status: UNKNOWN \(.*; |GITHUB INCIDENT: .* \(call )(\d+) ms\)/m;

/**
 * The wall of the gate's GitHub-status call, read from the stderr the tick relays (a11ign/a11ign#3730), so it is a phase of the line and nobody greps the
 * journal for it. `undefined` when the line is absent or has no number: the tick must not fail, nor claim a zero, for a line it could not read.
 * @param {string | null | undefined} gateStderr @returns {number | undefined}
 */
export function githubStatusWallMs(gateStderr: string | null | undefined): number | undefined {
  const wall = GITHUB_STATUS_WALL.exec(gateStderr ?? "")?.[1];
  return wall === undefined ? undefined : Number(wall);
}

/** The sender a pane-dialog order is attributed to: the tick is not a session, and an order with no sender is also recorded as an unidentified caller's. */
const PANE_DIALOG_SENDER = "work-tick";

/**
 * #463: EVERY LIVE SESSION'S PANE IS READ FOR A MENU OR DIALOG, and the first tick that sees one orders its owner (`dialogOwner`), once per dialog text. `DECISION` because an
 * incident is the order a deep queue must still accept (`deepQueueRefusal`) and a lead seat must not hold as an FYI. An order that was not accepted is not remembered, so the next
 * tick asks again; the memory is written after, and a memory that cannot be written is said and the tick goes on (a repeat order is a nuisance, a stopped tick is not).
 * @param {NonNullable<ReturnType<typeof readAgents>>} roster @param {string} ledgerPath
 */
function raiseDialogsNow(roster: NonNullable<ReturnType<typeof readAgents>>, ledgerPath: string) {
  const say = (line: string) => process.stderr.write(`${line}\n`);
  const path = stateEntryPath(PANE_DIALOG_RAISED_FILE);
  const memory = readRaised(path);
  const queue = handoffQueuePath(ledgerPath);
  const raising = raisePaneDialogs({ roster, memory, report: say, read: paneReader(defaultRun),
    order: (owner, text) => {
      const code = promptOrQueue({ run: defaultRun, label: owner, text, agents: roster, path: queue, stance: STANCE.DECISION, sender: PANE_DIALOG_SENDER });
      return code === PROMPT_EXIT.OK || code === PROMPT_EXIT.QUEUED;
    } });
  try {
    writeRaised(path, memory, raising.raised);
  } catch (err) {
    say(`PANE DIALOG memory could not be written at ${path} (${whatGhSaid(err)}); a dialog raised this tick is raised again next tick.`);
  }
  for (const { label, owner, dialog } of raising.sent) say(`PANE DIALOG ${label} -- raised to ${owner}: ${dialog.question} [${dialog.choices.join(" | ")}]`);
  if (raising.refused.length > 0) say(`PANE DIALOG ${raising.refused.join(", ")} -- the order was not accepted; tried again next tick.`);
}

/**
 * The three tear-downs and the blocked-session report, each one a phase. BEFORE the quiet exit, deliberately, all four: each is an event that
 * produces no order, so a quiet gate is the tick on which it most needs doing.
 * @param {NonNullable<ReturnType<typeof readAgents>>} roster @param {string} ledgerPath @param {Run["meter"]} meter
 */
function tidyRoster(roster: NonNullable<ReturnType<typeof readAgents>>, ledgerPath: string, meter: Run["meter"]) {
  // #460: A BLOCKED WORKER IS TOLD ONCE PER STALL to declare `blocked <row> <reason>` or decide and record why, and then it is no longer a line said every
  // tick (seven lines in fourteen minutes for `worker-4202`, 2026-10-09). What could not be told keeps the report it always had.
  const told = tellBlocked({ roster, path: stateEntryPath(BLOCKED_TOLD_FILE),
    send: (label, text) => { defaultRun(["--session", "org", "agent", "prompt", herdrAgentName(label), text]); },
    report: (line) => process.stderr.write(`${line}\n`) });
  if (told.sent.length > 0) process.stderr.write(`BLOCKED ${told.sent.join(", ")} -- told to declare \`worker:state blocked <row> <reason>\` or decide and record why (once per stall).\n`);
  const blocked = told.untold;
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
  // AND A PANE THAT SHOWS A MENU OR DIALOG (#463): after the tear-downs, so a session this tick ended is not read, and a phase of its own because it is one herdr read per session.
  meter.phase("paneDialogs", () => raiseDialogsNow(roster, ledgerPath));
}

/** The receiver writes its heartbeat every 30 s (`event-receiver.ts`); one older than this is a dead receiver, not a quiet queue (agent-org#981). */
export const HEARTBEAT_MAX_AGE_SECONDS = 120;

/** Seconds since the receiver's heartbeat file (`<queue>.alive`, an ISO time) was written, or null for none: absent, unparseable, or from the future, each of which cannot vouch for the receiver. */
function heartbeatAgeSeconds(path: string, nowMs: number): number | null {
  try {
    const at = Date.parse(readFileSync(path, "utf8").trim());
    return Number.isNaN(at) || at > nowMs ? null : Math.floor((nowMs - at) / 1000);
  } catch {
    return null;
  }
}

/** The scopes the tick hands the gate (`tick-scopes.ts`), named in `A11Y_TICK_SCOPES_FILE` only for a webhook tick that hand over one. */
export const TICK_SCOPES_ENTRY = "tick-scopes.json";
export const TICK_SCOPES_VARIABLE = "A11Y_TICK_SCOPES_FILE";
/** The due-index the gate writes (`due-index.ts`), and beside it the time the last webhook tick looked at it, in ms. */
export const DUE_INDEX_ENTRY = "due-index.json";
export const DUE_TICK_ENTRY = "due-index.last-tick";

/** The time the previous webhook tick looked at the due-index, or null for the first tick and for a file that is not a whole number of ms. Null counts every passed instant once: fail towards reading. */
function previousTickMs(host: HostConfig): number | null {
  try {
    const at = Number(readFileSync(stateEntryPath(DUE_TICK_ENTRY, { host, home: host.home }), "utf8").trim());
    return Number.isSafeInteger(at) ? at : null;
  } catch {
    return null;
  }
}

/** The declared repositories with a dated wait that came due since the previous tick. A corrupt index says nothing about what passed, so every declared repository is due. */
function dueRepositories({ host, repos, nowMs }: { host: HostConfig; repos: string[]; nowMs: number; }): string[] {
  const read = readDueIndex(stateEntryPath(DUE_INDEX_ENTRY, { host, home: host.home }));
  if (read.status === "corrupt") return repos;
  return dueRepos({ index: read.index, afterMs: previousTickMs(host), nowMs }).filter((repo) => repos.includes(repo));
}

/**
 * Writes the scopes and names the file in `env` for the gate. `null` scopes (not known) hand nothing over, so the gate reads whole. A failed write also leaves
 * the variable unset and says so, because the file it would leave is the previous tick's scopes. Returns a say fragment only on failure.
 */
function handOverScopes({ host, scopes, env }: { host: HostConfig; scopes: Scope[] | null; env: NodeJS.ProcessEnv; }): string | null {
  if (scopes === null) return null;
  const path = stateEntryPath(TICK_SCOPES_ENTRY, { host, home: host.home });
  try {
    writeTickScopes({ path, scopes });
  } catch (err) {
    return `SCOPES NOT HANDED (${whatGhSaid(err)}): the gate reads whole`;
  }
  env[TICK_SCOPES_VARIABLE] = path;
  return null;
}

/**
 * Keeps this tick's time for the next tick's due window. Called after the ack, and whether or not the ack moved the cursor: the repositories due in this tick are
 * already in its `changed` set. Returns a say fragment only on failure, which costs the next tick a re-look at this window (harmless).
 */
function recordTickTime({ host, nowMs }: { host: HostConfig; nowMs: number; }): string | null {
  const path = stateEntryPath(DUE_TICK_ENTRY, { host, home: host.home });
  const partial = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(partial, `${nowMs}\n`);
    renameSync(partial, path);
    return null;
  } catch (err) {
    return `DUE TICK NOT RECORDED (${whatGhSaid(err)}): the next tick looks at this window again`;
  }
}

/**
 * (agent-org#981) WHAT THE EVENT QUEUE SAYS THIS TICK, for a host whose `events.source` is `webhook`; null for `poll` or no block, which passes no `events` and is today's behaviour.
 * Events are read and handed over even when the receiver looks dead (the probes then cover them; the cursor still moves). An event that names no repository, or a queue line that did not
 * parse, cannot say WHICH repository moved, so it names all of them: fail towards reading. `ack` is for the caller to run only AFTER the generations are written (agent-org#979).
 * `scopes` is what the gate is told about (see `handOverScopes`); the repositories whose dated wait came due are added to `changed`.
 * @returns {{ events: TickEvents, say: string, ack: () => string | null, scopes: Scope[] | null } | null}
 */
export function eventsForTick({ host, repos, nowMs }: { host: HostConfig; repos: string[]; nowMs: number; }): { events: TickEvents; say: string; ack: () => string | null; scopes: Scope[] | null; } | null {
  const declared = host.events;
  if (declared === undefined || declared.source !== "webhook") return null;
  const queuePath = stateEntryPath(EVENT_QUEUE_ENTRY, { host, home: host.home });
  const cursorPath = `${queuePath}.cursor`;
  const age = heartbeatAgeSeconds(`${queuePath}.alive`, nowMs);
  const healthy = age !== null && age < HEARTBEAT_MAX_AGE_SECONDS;
  const reconcileEverySeconds = declared.reconcileMinutes * 60;
  const unhealthy = (why: string) => `EVENTS UNHEALTHY (${why}), probes run`;
  const heartbeat = age === null ? "heartbeat absent" : `heartbeat ${age}s`;
  let read;
  try {
    read = readNewEvents({ queuePath, cursorPath });
  } catch (err) {
    return { events: { changed: new Set(), healthy: false, reconcileEverySeconds }, say: unhealthy(`queue unreadable: ${whatGhSaid(err)}`), ack: () => null, scopes: null };
  }
  const everything = read.unreadable > 0 || read.events.some((event) => typeof event.repo !== "string" || event.repo === "");
  const due = dueRepositories({ host, repos, nowMs });
  const changed = new Set([...(everything ? repos : changedRepos(read.events)), ...due]);
  const stamps = read.events.map((event) => Date.parse(event.receivedAt)).filter((at) => !Number.isNaN(at));
  const waited = stamps.length === 0 ? "" : `, oldest event waited ${Math.max(0, Math.floor((nowMs - Math.min(...stamps)) / 1000))}s`;
  const count = read.events.length;
  const dueNote = due.length === 0 ? "" : `; due ${due.join(", ")}`;
  const eventsSay = count === 0 ? "EVENTS no events" : `EVENTS ${count} event${count === 1 ? "" : "s"}${waited}`;
  const say = (healthy ? eventsSay : unhealthy(heartbeat)) + dueNote;
  const consumed = count + read.unreadable > 0;
  const ack = () => {
    if (!consumed) return null;
    try {
      ackThrough({ cursorPath, through: read.through });
      return null;
    } catch (err) {
      return `EVENTS cursor not moved (${whatGhSaid(err)}): the events are read again next tick`; // generations are already written, so the snapshot stands; a re-bump is harmless
    }
  };
  // The scopes name the pull requests the events named, and they are trusted only from a live receiver that lost nothing: a dead one delivers no events, so
  // `[]` would tell the gate that nothing changed. `null` is "not known", and the gate reads whole.
  const scopes = healthy && !everything ? scopesOf(read.events) : null;
  return { events: { changed, healthy, reconcileEverySeconds }, say, ack, scopes };
}

/**
 * (#4148) THE TICK'S SNAPSHOT, refreshed once and BEFORE anything reads GitHub: one conditional REST probe pair per declared repository (a 304 costs no point), after which every
 * reader this tick starts is answered from the wrapper's store for a repository that did not change. `A11Y_TICK_SNAPSHOT` is set only when the refresh RAN, in this process's own
 * environment so the gate, wake and every child inherit it; a refresh that could not run unsets it, and every read then goes to GitHub as it did before this existed. Returns the one line the tick logs.
 * IN `webhook` MODE (agent-org#981) the event queue answers instead and a quiet tick makes no call; `source: "poll"` in `host.json` is the one-line revert, and a host that declares
 * none, or whose declaration cannot be read, polls.
 * @param {{ declaration?: () => import("./project-config.ts").ProjectDeclaration, configDir?: string | undefined, refresh?: typeof refreshTickSnapshot, env?: NodeJS.ProcessEnv, host?: () => HostConfig | undefined, nowMs?: number }} [deps]
 * @returns {string}
 */
export function refreshSnapshotOrSay({ declaration = homeProjectDeclaration, configDir = process.env.GH_CONFIG_DIR, refresh = refreshTickSnapshot, env = process.env, host = pollingHostOrUndefined, nowMs = Date.now() }: { declaration?: () => import("./project-config.ts").ProjectDeclaration; configDir?: string | undefined; refresh?: typeof refreshTickSnapshot; env?: NodeJS.ProcessEnv; host?: () => HostConfig | undefined; nowMs?: number; } = {}): string {
  delete env.A11Y_TICK_SNAPSHOT;
  delete env[TICK_SCOPES_VARIABLE];
  if (configDir === undefined || configDir === "") return "SNAPSHOT OFF: GH_CONFIG_DIR is unset, so there is no account store to hold one; every read goes to GitHub this tick.";
  try {
    const project = declaration();
    const repos = [...new Set([...project.tracker.map((t) => t.repo), ...project.code.map((c) => c.repo)])];
    const declaredHost = host();
    const tick = declaredHost === undefined ? null : eventsForTick({ host: declaredHost, repos, nowMs });
    const lines = tick === null ? refresh({ repos, homeRepo: project.repo, configDir }) : refresh({ repos, homeRepo: project.repo, configDir, nowMs, events: tick.events });
    env.A11Y_TICK_SNAPSHOT = "1";
    const notHanded = tick === null || declaredHost === undefined ? null : handOverScopes({ host: declaredHost, scopes: tick.scopes, env });
    const notAcked = tick?.ack() ?? null;
    const notRecorded = tick === null || declaredHost === undefined ? null : recordTickTime({ host: declaredHost, nowMs });
    const changed = lines.filter((line) => line.includes(": CHANGED"));
    const base = `SNAPSHOT ${repos.length} repositories, ${changed.length} changed${changed.length > 0 ? ` (${changed.map((line) => line.split(":")[0]).join(", ")})` : ""}`;
    return tick === null ? base : [base, tick.say, notHanded, notAcked, notRecorded].filter((part) => part !== null).join("; ");
  } catch (err) {
    return `SNAPSHOT NOT REFRESHED (${whatGhSaid(err)}): every read goes to GitHub this tick.`;
  }
}

/** The host's declaration, or undefined when it cannot be read: the tick then polls, as it did before a host could declare events. */
function pollingHostOrUndefined(): HostConfig | undefined {
  try {
    return homeHostConfig();
  } catch {
    return undefined;
  }
}

function main() {
  refuseUnknownFlags(["--ledger", "--roster"], {
    entry: import.meta.url, command: "node packages/agent-org/src/work-tick.ts",
  });
  const passthrough = process.argv.slice(2);
  const ledgerPath = ledgerPathFrom(passthrough);
  /** @param {string} name */
  const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));
  const run = startRun(ledgerPath, [...CRASH_PRELOAD, here("./wake.ts"), ...passthrough]);
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

  // THEN THE SNAPSHOT (#4148): after the seats and the chairman's path (they read nothing it would change), before the first read the gate or any child of it makes.
  process.stderr.write(`${meter.phase("snapshot", refreshSnapshotOrSay)}\n`);

  rmSync(run.gateSpansPath, { force: true }); // a file a killed tick of the same pid left would be read as this gate's spans
  const gate = meter.phase("gate", () => spawnSync(process.execPath, [...CRASH_PRELOAD, here("./work-gate.ts")],
    { encoding: "utf8", timeout: GATE_BUDGET_MS, killSignal: "SIGTERM", env: { ...process.env, [GATE_SPANS_ENV]: run.gateSpansPath } }));
  // A GATE KILLED AT ITS BUDGET IS ETIMEDOUT, NOT A GATE THAT COULD NOT RUN (#1080): the two read differently in the journal and in the next step.
  const overBudget = (gate.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  run.gateKilled = overBudget;
  if (gate.error && !overBudget) {
    process.stderr.write(`CANNOT ASK: could not run work-gate (${gate.error.message}).\n`);
    finish(EXIT.CANNOT_ASK, run);
  }
  if (gate.stderr) process.stderr.write(gate.stderr);
  const statusWallMs = githubStatusWallMs(gate.stderr);
  if (statusWallMs !== undefined) meter.note("github-status", statusWallMs);
  // WHAT A KILLED GATE PRINTED IS HANDED ON ONLY AS WHOLE ORDER LINES: the one the kill cut is not an order, and `wake` must not read half of one.
  const handed = overBudget ? wholeOrderLines(gate.stdout ?? "") : undefined;
  if (overBudget) process.stderr.write(`${gateBudgetLine(run.censusPath, handed?.length ?? 0)}\n`);

  // BEFORE THE QUIET EXIT, DELIBERATELY. A blocked session is most invisible precisely when the queue is
  // quiet -- there is no other output that tick, and nothing else looks at the roster.
  const roster = meter.phase("roster", readAgents);
  if (roster !== null) tidyRoster(roster, ledgerPath, meter);

  const queued = meter.phase("queue", () => queuedOrderCount(handoffQueuePath(ledgerPath)));
  // The budget line above already says what happened, so a budget stop does not repeat the gate's own reason (its PARTIAL reason names an unread lane).
  const next = handed !== undefined && handed.length === 0 ? { deliver: false, exit: EXIT.CANNOT_ASK }
    : afterGate(overBudget ? GATE.PARTIAL : gate.status ?? EXIT.CANNOT_ASK, { queued });
  if (next.why && !overBudget) process.stderr.write(`${next.why}\n`);
  if (!next.deliver) finish(next.exit ?? EXIT.CANNOT_ASK, run);

  const wake = meter.phase("wake", () => spawnSync(run.wakeCommand.node, run.wakeCommand.args,
    { encoding: "utf8", input: handed === undefined ? gate.stdout : handed.map((line) => `${line}\n`).join("") }));
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
