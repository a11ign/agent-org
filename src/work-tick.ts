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
import { TSX_IMPORT } from "./tsx-import.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { refuseUnknownFlags } from "./lib/cli-flags.mjs";
import { homeProjectDeclaration } from "./project-config.ts";
import { completionPath, writeCompletion } from "./lib/tick-completion.mjs";
import { toolVersionLine } from "./lib/tool-version.mjs";
import { refreshTickSnapshot } from "./tick-snapshot.ts";
import { clearOwnMarker, deliverTickOrders, killedTickOrders, readKilledTick, slowThresholdSeconds, slowTickOrders, tickMarkerPath,
  writeStartMarker } from "./work-tick-health.ts";
import { CENSUS_ENV, childrenCpuMs, installSpawnCensus, readCensus, setCensusPhase, summariseCensus } from "./lib/spawn-census.mjs";

// Where the reader now lives (the census times each spawn's CPU with it); the tick's tests and callers still import it from here.
export { childrenCpuMs };
// THE ONE THING THIS FILE ASKS THAT IS NOT ABOUT DELIVERY. A session herdr reports as `blocked` is
// stopped on a question nobody will answer, and `wake.ts`'s `WAKEABLE` is `idle`/`done` -- so it is
// never offered another cause and never mentioned anywhere. It has to be reported from HERE rather than
// from `wake`, because `afterGate` returns `deliver: false` on a QUIET gate and `wake` is then never
// run at all -- which is exactly the state it was found in: a quiet queue and a session stuck behind a
// menu since nobody knows when.
import { readAgents, blockedSessions, readHandoffs, handoffQueuePath, ledgerPathFrom, tearDownSpares,
  tearDownReviewers, recoverNow, startAbsentSeats, checkChairmanPath }
  from "./wake.ts";

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
const CRASH_PRELOAD = ["--import", new URL("./lib/crash-exit.mjs", import.meta.url).href, ...TSX_IMPORT];

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
 * @param {{ clock?: () => number, cpu?: () => { selfMs: number, childrenMs: number }, uptimeMs?: () => number, maxRssKb?: () => number }} [sources]
 */
export function createMeter({ clock = () => performance.now(), cpu = readCpu, uptimeMs = () => process.uptime() * MS_PER_SECOND,
  maxRssKb = () => process.resourceUsage().maxRSS }: { clock?: () => number; cpu?: () => { selfMs: number; childrenMs: number; }; uptimeMs?: () => number; maxRssKb?: () => number; } = {}) {
  const totalCpuMs = () => { const { selfMs, childrenMs } = cpu(); return selfMs + childrenMs; };
  const phases: Record<string, { wallMs: number; cpuMs?: number; }> = { startup: { wallMs: round(uptimeMs()), cpuMs: round(totalCpuMs()) } };
  return {
    /** @template T @param {string} name @param {() => T} step @returns {T} */
    phase<T>(name: string, step: () => T): T {
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

/**
 * What only systemd knows about this run: how long `ExecStartPre` took (the gap between the unit starting to activate and its main process being
 * forked, which no line of this file can time because it runs before this process exists) and the unit's peak memory, the figure the row's table
 * quotes. `null` for both off systemd or when either cannot be read, said on stderr: an unknown is not zero.
 * @param {{ env?: NodeJS.ProcessEnv, readText?: (path: string) => string, run?: (file: string, args: string[]) => string }} [sources]
 * @returns {{ prestartMs: number | null, cgroupPeakKb: number | null }}
 */
export function readUnitFacts({ env = process.env, readText = (path) => readFileSync(path, "utf8"),
  run = (file, args) => execFileSync(file, args, { encoding: "utf8" }) }: { env?: NodeJS.ProcessEnv; readText?: (path: string) => string; run?: (file: string, args: string[]) => string; } = {}): { prestartMs: number | null; cgroupPeakKb: number | null; } {
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
export type Run = { recordPath: string, costPath: string, censusPath: string, markerPath: string, wakeCommand: { node: string, args: string[] }, meter: ReturnType<typeof createMeter>, wakes: number };

/**
 * THE CENSUS STARTS HERE, before the first spawn, and reaches every process the tick starts two ways: this process is patched in place (it runs the
 * tear-downs itself), and `NODE_OPTIONS` preloads the patch into every `node` below it, the gate and the `node` the gate starts included. One file
 * per tick process, so a tick run by hand beside the timer's cannot read the other's commands.
 * @param {string} ledgerPath @param {string[]} wakeArgs the arguments that run `wake` as a child, after `node` @returns {Run}
 */
function startRun(ledgerPath: string, wakeArgs: string[]): Run {
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
function tickCostLine(exit: number, run: Run) {
  const reading = run.meter.reading();
  const { commands, ghRepos, subcommands, phaseCalls, slowest, hottest } = summariseCensus(readCensus(run.censusPath));
  return { v: 1, at: Date.now(), exit, load1: loadavg()[0], ...reading, ...readUnitFacts(), wakes: run.wakes, spawns: commands, ghRepos, subcommands, phaseCalls, slowest, hottest };
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
    writeStartMarker(run.markerPath, { at: Math.round(Date.now() - process.uptime() * MS_PER_SECOND), pid: process.pid });
    process.on("exit", () => clearOwnMarker(run.markerPath, process.pid));
    deliverTickOrders(killedTickOrders(killed, { foundAt: Date.now(), costPath: run.costPath }), run.wakeCommand);
  } catch (err) {
    process.stderr.write(`TICK HEALTH NOT RECORDED at ${run.markerPath}: ${String((err as any)?.message ?? err)}. A killed tick will not be reported.\n`);
  }
}

/**
 * AT THE END, after the cost line, which is what it reads. The marker is cleared FIRST: a tick killed while it reports must not be reported again as
 * killed by the next one, and one report per tick is the row's own rule.
 * @param {ReturnType<typeof tickCostLine> | null} line @param {Run} run
 */
function reportIfSlow(line: ReturnType<typeof tickCostLine> | null, run: Run) {
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
 * @param {number} at epoch milliseconds @param {(file: string, args: string[], options: object) => unknown} [run]
 * @param {() => readonly { repo: string }[]} [readTrackers] the declared trackers; a seam so a test needs no project declaration @returns {void}
 */
export function writeHeartbeat(at: number, run: (file: string, args: string[], options: object) => unknown = execFileSync, readTrackers: () => readonly { repo: string; }[] = () => homeProjectDeclaration().tracker): void {
  let trackers: readonly { repo: string; }[];
  try {
    trackers = readTrackers();
  } catch (err) {
    process.stderr.write(`HEARTBEAT NOT WRITTEN to the tracker variable ${HEARTBEAT_VARIABLE}: ${whatGhSaid(err)}. A reader off this host will see the previous value.\n`);
    return;
  }
  const options = { stdio: ["ignore", "ignore", "pipe"], timeout: HEARTBEAT_TIMEOUT_MS };
  // #4080: EVERY declared tracker's repository holds the variable, a refusal on one naming that repository and stopping no other write. The standing comment is
  // the FIRST tracker's alone: `HEARTBEAT_COMMENT_ID` is an object of that repository (a PATCH of it through another repository's path is a 404), and the one reader
  // of it (`gate-heartbeat.mjs` of the control repository) reads that one object, so a second comment would have no reader.
  trackers.forEach(({ repo }, index) => {
    writeHeartbeatVariable({ at, repo, run, options });
    if (index === 0) writeHeartbeatComment({ at, repo, run, options });
  });
}

/** @param {{ at: number, repo: string, run: (file: string, args: string[], options: object) => unknown, options: object }} write @returns {void} */
function writeHeartbeatVariable({ at, repo, run, options }: { at: number; repo: string; run: (file: string, args: string[], options: object) => unknown; options: object; }): void {
  try {
    run("gh", ["api", "-X", "PATCH", `repos/${repo}/actions/variables/${HEARTBEAT_VARIABLE}`, "-f", `value=${at}`], options);
  } catch (err) {
    process.stderr.write(`HEARTBEAT NOT WRITTEN to ${repo} variable ${HEARTBEAT_VARIABLE}: ${whatGhSaid(err)}. A reader off this host will see the previous value.\n`);
  }
}

/** @param {{ at: number, repo: string, run: (file: string, args: string[], options: object) => unknown, options: object }} write @returns {void} */
function writeHeartbeatComment({ at, repo, run, options }: { at: number; repo: string; run: (file: string, args: string[], options: object) => unknown; options: object; }): void {
  try {
    run("gh", ["api", "-X", "PATCH", `repos/${repo}/issues/comments/${HEARTBEAT_COMMENT_ID}`, "-f", `body=${heartbeatCommentBody(at)}`], options);
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

/**
 * The three tear-downs and the blocked-session report, each one a phase. BEFORE the quiet exit, deliberately, all four: each is an event that
 * produces no order, so a quiet gate is the tick on which it most needs doing.
 * @param {NonNullable<ReturnType<typeof readAgents>>} roster @param {string} ledgerPath @param {Run["meter"]} meter
 */
function tidyRoster(roster: NonNullable<ReturnType<typeof readAgents>>, ledgerPath: string, meter: Run["meter"]) {
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

/**
 * (#4148) THE TICK'S SNAPSHOT, refreshed once and BEFORE anything reads GitHub: one conditional REST probe pair per declared repository (a 304 costs no point), after which every
 * reader this tick starts is answered from the wrapper's store for a repository that did not change. `A11Y_TICK_SNAPSHOT` is set only when the refresh RAN, in this process's own
 * environment so the gate, wake and every child inherit it; a refresh that could not run unsets it, and every read then goes to GitHub as it did before this existed. Returns the one line the tick logs.
 * @param {{ declaration?: () => import("./project-config.ts").ProjectDeclaration, configDir?: string | undefined, refresh?: typeof refreshTickSnapshot, env?: NodeJS.ProcessEnv }} [deps]
 * @returns {string}
 */
export function refreshSnapshotOrSay({ declaration = homeProjectDeclaration, configDir = process.env.GH_CONFIG_DIR, refresh = refreshTickSnapshot, env = process.env }: { declaration?: () => import("./project-config.ts").ProjectDeclaration; configDir?: string | undefined; refresh?: typeof refreshTickSnapshot; env?: NodeJS.ProcessEnv; } = {}): string {
  delete env.A11Y_TICK_SNAPSHOT;
  if (configDir === undefined || configDir === "") return "SNAPSHOT OFF: GH_CONFIG_DIR is unset, so there is no account store to hold one; every read goes to GitHub this tick.";
  try {
    const project = declaration();
    const repos = [...new Set([...project.tracker.map((t) => t.repo), ...project.code.map((c) => c.repo)])];
    const lines = refresh({ repos, homeRepo: project.repo, configDir });
    env.A11Y_TICK_SNAPSHOT = "1";
    const changed = lines.filter((line) => line.includes(": CHANGED"));
    return `SNAPSHOT ${repos.length} repositories, ${changed.length} changed${changed.length > 0 ? ` (${changed.map((line) => line.split(":")[0]).join(", ")})` : ""}`;
  } catch (err) {
    return `SNAPSHOT NOT REFRESHED (${whatGhSaid(err)}): every read goes to GitHub this tick.`;
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

  const gate = meter.phase("gate", () => spawnSync(process.execPath, [...CRASH_PRELOAD, here("./work-gate.ts")], { encoding: "utf8" }));
  if (gate.error) {
    process.stderr.write(`CANNOT ASK: could not run work-gate (${gate.error.message}).\n`);
    finish(EXIT.CANNOT_ASK, run);
  }
  if (gate.stderr) process.stderr.write(gate.stderr);
  const statusWallMs = githubStatusWallMs(gate.stderr);
  if (statusWallMs !== undefined) meter.note("github-status", statusWallMs);

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
