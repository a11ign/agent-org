// @ts-check
// A LEAF, like `claim-stall.ts`: `node:*` only, so `work-tick.ts` takes it without a cycle and a test imports it without a gate.
//
// A TICK THAT IS SLOW IS RECORDED, A TICK THAT IS KILLED TELLS `ceo` (a11ign/a11ign#3567; agent-org#1208 split the two). On 2026-10-04 a tick ran 10 min
// 13 s and was killed by `TimeoutStartSec`, and the only trace was a journal line nobody reads. The signal has two halves, because a tick that is killed
// cannot report itself from inside:
//
//   SLOW    the tick that finishes over {@link TICK_SLOW_SECONDS} reads its own `tick-cost` line and EDITS ONE STANDING COMMENT with the last 24 h of
//           ticks (their p50/p95 wall and the slow ones in a table). It wakes nobody: six wakes in 45 minutes was spend on something `ceo` cannot act
//           on turn by turn (chairman, a11ign#928), and `ceo` reads the trend daily. A write that is refused is retried by the next tick and said by
//           `org-health`; it never becomes a wake per overrun.
//   KILLED  every tick leaves a START MARKER and clears it when its process ends by itself. A marker still there when the next tick starts was
//           left by a process that was signalled (the timeout, a restart), so the NEXT tick reads it and wakes `ceo`. It left no cost line and so no
//           trend, which is why it is the half that still wakes.
//
// WHY A MARKER AND NOT `OnFailure=` (the row allows either, if the choice is said). `OnFailure=` reports without waiting for a tick, which is the
// one thing it has over a marker, and it costs a second unit in `host/` on every host, a unit that has to reach `ceo` by itself with no ledger and
// no `wake`. The marker reuses the delivery that already exists (`wake` and its ledger, keyed on `causeKey`) and needs nothing installed. THE GAP,
// stated: a kill during `ExecStartPre` (`pnpm run primary:update`) happens before this process exists, so no marker was written and the next tick
// cannot see it; the unit's own failure is read by `incident:gate-crash`.
//
// ONE REPORT PER KILLED TICK, BY CONSTRUCTION. The order is keyed on the tick's start time, which `wake`'s ledger already refuses to deliver twice, and
// the marker is replaced by the tick that reads it, so a second reader finds a marker it did not write only if another tick was killed.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

/** Over this many seconds from the unit starting to the tick ending, the tick is slow. The row names it; 180 is three timer intervals' worth of nobody looking. */
export const TICK_SLOW_SECONDS = 180;

/**
 * The cause the killed-tick order carries. The order spells it as a LITERAL (`cause: "tick-overran"`) because `worker-profile.test.ts` finds the causes a file
 * emits by that text, and a constant it cannot read. A slow tick carries no order (agent-org#1208), so `TICK_KILLED` is the cause's one subject that wakes.
 */
export const TICK_OVERRAN = "tick-overran";
export const TICK_KILLED = "tick-killed";

/** The marker beside the ledger and the cost file, so one directory holds the tick's runtime state. */
export const TICK_MARKER_FILE = "tick-running.json";
/** The record's own state, beside the same ledger: the standing comment's id, and whether the last write was refused. */
export const TICK_RECORD_FILE = "tick-record.json";
/** The first line of the one standing comment, so the tick finds it again after its cached id is lost. A line of its own that nothing else writes. */
export const TICK_RECORD_MARKER = "<!-- tick-record: agent-org#1208 -->";
/** The project declaration's key under `units` (beside `traceWeeklyIssue`): the issue number of the standing row, in the FIRST declared tracker's repository. */
export const TICK_RECORD_ISSUE_KEY = "tickRecordIssue";
/** The window the record's p50/p95 and table cover: the chairman's two health signals are daily. */
export const TICK_RECORD_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Slow ticks the table shows, newest first; the count of the rest is said, so a bad day cannot grow the comment past GitHub's body limit. */
export const TICK_RECORD_TABLE_ROWS = 30;

const MS_PER_SECOND = 1000;
const WALL_DECIMALS = 1;

/** @param {string} ledgerPath @returns {string} */
export function tickMarkerPath(ledgerPath: string): string {
  return join(dirname(ledgerPath), TICK_MARKER_FILE);
}

/** @param {string} ledgerPath @returns {string} */
export function tickRecordPath(ledgerPath: string): string {
  return join(dirname(ledgerPath), TICK_RECORD_FILE);
}

/**
 * The threshold in force: the constant, unless `A11Y_TICK_SLOW_SECONDS` names another positive number. The override is the TEST'S seam -- a test cannot
 * wait three minutes -- and nothing in `host/` sets it.
 * @param {NodeJS.ProcessEnv} [env] @returns {number}
 */
export function slowThresholdSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const named = Number(env.A11Y_TICK_SLOW_SECONDS);
  return Number.isFinite(named) && named > 0 ? named : TICK_SLOW_SECONDS;
}

export type TickOrder = { session: string, cause: string, subject: string, discriminator: string, prompt: string, causeKey: string };
export type Marker = { at: number, pid: number | null, unreadable: boolean, phase: string | null, phaseAt: number | null };

// ---- THE START MARKER ------------------------------------------------------------------------------------------------------------------------

/**
 * Written whole through a rename, so a reader sees the marker before a phase boundary or after it and never half of one (agent-org#1542).
 * @param {string} path @param {{ at: number, pid: number, phase?: string, phaseAt?: number }} marker
 */
export function writeStartMarker(path: string, marker: { at: number; pid: number; phase?: string; phaseAt?: number; }) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(marker)}\n`);
  renameSync(temporary, path);
}

/**
 * The tick's phase boundaries, written into its start marker (agent-org#1542): each call replaces the marker with the same start and the phase begun
 * now, so a killed tick's reader can say where it sat. NEVER THROWS: a marker that cannot be written does not fail the tick, and the first refusal is
 * said once, because a tick that recorded no phase is one whose killed wake will say so.
 * @param {string} path @param {{ at: number, pid: number }} start @param {(text: string) => void} [say] @returns {(phase: string) => void}
 */
export function phaseMarker(path: string, start: { at: number; pid: number; }, say: (text: string) => void = (text) => process.stderr.write(text)) {
  let said = false;
  return (phase: string) => {
    try {
      writeStartMarker(path, { ...start, phase, phaseAt: Date.now() });
    } catch (err) {
      if (said) return;
      said = true;
      say(`TICK PHASE NOT RECORDED at ${path}: ${String((err as Error)?.message ?? err).split("\n")[0]}. A killed tick will not say which phase it was in.\n`);
    }
  };
}

/**
 * Clears the marker only if THIS process wrote it: a tick run by hand beside the timer's must not clear the timer's, and a marker replaced by a later
 * tick is that tick's. Idempotent, and a marker that is gone or unreadable is left to the reader of it.
 * @param {string} path @param {number} pid
 */
export function clearOwnMarker(path: string, pid: number) {
  if (readMarker(path)?.pid === pid) rmSync(path, { force: true });
}

/**
 * The marker, or `null` when there is none. A file that is THERE and cannot be parsed is a marker too, with `unreadable` set and the file's own
 * modification time as its `at`: absence of a reading is not absence of a killed tick, and a tick killed mid-write is exactly the one that leaves one.
 * Any other failure to read (a permission, a directory in its place) throws, and the caller says so.
 * @param {string} path @returns {Marker | null}
 */
export function readMarker(path: string): Marker | null {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const { at, pid, phase, phaseAt } = JSON.parse(text);
    if (Number.isFinite(at) && Number.isInteger(pid)) {
      // A marker an older tick wrote has no phase, and one whose phase is not a name and a time names none: the pair or nothing.
      const named = typeof phase === "string" && Number.isFinite(phaseAt);
      return { at, pid, unreadable: false, phase: named ? phase : null, phaseAt: named ? phaseAt : null };
    }
  } catch {
    // Falls through to the same answer a parseable file with the wrong fields gets: a marker whose author is unknown.
  }
  return { at: statSync(path).mtimeMs, pid: null, unreadable: true, phase: null, phaseAt: null };
}

/** @param {number} pid @returns {boolean} */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The marker a DEAD tick left, or `null`. A marker whose process is still alive is a tick running beside this one (one started by hand), not a killed
 * one, and is not reported. The cost of the liveness test, stated: a pid reused by an unrelated process within the interval hides one killed tick.
 * @param {string} path @param {{ alive?: (pid: number) => boolean }} [sources] @returns {Marker | null}
 */
export function readKilledTick(path: string, { alive = processAlive }: { alive?: (pid: number) => boolean; } = {}): Marker | null {
  const marker = readMarker(path);
  if (marker === null) return null;
  return marker.pid !== null && alive(marker.pid) ? null : marker;
}

// ---- THE TWO ORDERS --------------------------------------------------------------------------------------------------------------------------

const seconds = (ms: number) => (ms / MS_PER_SECOND).toFixed(WALL_DECIMALS);

/** A span as the wake reads it: `8 m 31 s`, or `40 s` under a minute, in whole seconds. */
const elapsed = (ms: number) => {
  const total = Math.round(ms / MS_PER_SECOND);
  return total >= 60 ? `${Math.floor(total / 60)} m ${total % 60} s` : `${total} s`;
};

/** @param {number} ms */
const clock = (ms: number) => new Date(ms).toISOString();

// ---- THE RECORD (agent-org#1208) -------------------------------------------------------------------------------------------------------------

/** The part of a `tick-cost` line the record reads. */
export type CostLine = { at: number; wallMs: number; prestartMs?: number | null; cpuMs: { self: number; children: number }; phases: Record<string, { wallMs: number; cpuMs?: number }> };

/** One slow tick as the table shows it: `startedAt` is when the unit's process began, `wallMs` includes `ExecStartPre`. */
export type SlowTick = { startedAt: number; wallMs: number; cpuMs: number; phase: string; phaseWallMs: number; phaseCpuMs: number | null };
export type TickRecord = { ticks: number; p50Ms: number | null; p95Ms: number | null; slow: SlowTick[] };

/** The wall the limit is judged on: the UNIT's, from systemd starting it to this process ending (`prestartMs` is `ExecStartPre`, which `TimeoutStartSec` counts). */
const wallOf = (line: CostLine) => line.wallMs + (line.prestartMs ?? 0);

/** Over the limit, not at it. @param {CostLine} line @param {number} thresholdSeconds */
export function isSlowTick(line: CostLine, thresholdSeconds: number = TICK_SLOW_SECONDS): boolean {
  return wallOf(line) > thresholdSeconds * MS_PER_SECOND;
}

/**
 * Nearest-rank percentile of an ASCENDING list: the smallest value with at least `p` percent of the list at or below it. `null` for an empty list, never 0.
 * @param {number[]} ascending @param {number} p 0..100
 */
export function percentile(ascending: number[], p: number): number | null {
  if (ascending.length === 0) return null;
  return ascending[Math.max(0, Math.ceil((p / 100) * ascending.length) - 1)];
}

/**
 * The cost file's lines that are cost lines. A line that does not parse or lacks the fields is skipped: the file is cut to its newest half past a size, so its
 * first line may be a fragment, and a record that threw on it would be unwritten for as long as the fragment stayed.
 * @param {string} text @returns {CostLine[]}
 */
export function parseCostLines(text: string): CostLine[] {
  const lines: CostLine[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const line = JSON.parse(raw);
      if (Number.isFinite(line?.at) && Number.isFinite(line?.wallMs) && line.cpuMs && typeof line.phases === "object") lines.push(line);
    } catch {
      // not a cost line
    }
  }
  return lines;
}

/**
 * THE RECORD OF THE WINDOW ENDING AT `now`: every tick of the cost file inside it for the p50/p95 wall (all ticks, so a slow one is read against the ones that were
 * not), and the ones over the limit for the table. `current` is this tick's own line, which the file may not hold if appending it failed, and is not counted twice.
 * @param {CostLine[]} lines @param {{ now: number, thresholdSeconds?: number, current?: CostLine | null }} at @returns {TickRecord}
 */
export function tickRecordOf(lines: CostLine[], { now, thresholdSeconds = TICK_SLOW_SECONDS, current = null }: { now: number; thresholdSeconds?: number; current?: CostLine | null; }): TickRecord {
  const seen = new Set<number>();
  const inWindow = [...lines, ...(current === null ? [] : [current])]
    .filter((line) => now - line.at <= TICK_RECORD_WINDOW_MS && !seen.has(line.at) && seen.add(line.at))
    .sort((a, b) => b.at - a.at);
  const walls = inWindow.map(wallOf).sort((a, b) => a - b);
  const slow = inWindow.filter((line) => isSlowTick(line, thresholdSeconds)).map((line): SlowTick => {
    const [phase, took] = Object.entries(line.phases).reduce((longest, entry) => (entry[1].wallMs > longest[1].wallMs ? entry : longest), ["(none)", { wallMs: 0 } as { wallMs: number; cpuMs?: number }]);
    return { startedAt: Math.round(line.at - line.wallMs), wallMs: wallOf(line), cpuMs: line.cpuMs.self + line.cpuMs.children, phase, phaseWallMs: took.wallMs, phaseCpuMs: took.cpuMs ?? null };
  });
  return { ticks: inWindow.length, p50Ms: percentile(walls, 50), p95Ms: percentile(walls, 95), slow };
}

/**
 * The standing comment's whole body. It is replaced, never appended to, so the row holds one comment however many ticks overran; the p50/p95 are over every tick
 * of the window and say so, and a `null` is "no tick", not a zero.
 * @param {TickRecord} record @param {{ now: number, thresholdSeconds?: number, costPath: string }} where @returns {string}
 */
export function renderTickRecord(record: TickRecord, { now, thresholdSeconds = TICK_SLOW_SECONDS, costPath }: { now: number; thresholdSeconds?: number; costPath: string; }): string {
  const shown = record.slow.slice(0, TICK_RECORD_TABLE_ROWS);
  const secs = (ms: number | null) => (ms === null ? "n/a" : seconds(ms));
  return [
    TICK_RECORD_MARKER,
    `**Tick record** (agent-org#1208), updated ${clock(now)}. One comment, edited in place by the tick; a slow tick wakes no session, and a KILLED tick still does (\`tick-overran\`).`,
    "",
    `Last 24 h, read from \`${costPath}\`: **${record.ticks}** ticks, wall **p50 ${secs(record.p50Ms)} s, p95 ${secs(record.p95Ms)} s** (every tick, nearest rank, \`ExecStartPre\` included); `
      + `**${record.slow.length}** over the ${thresholdSeconds} s limit.`,
    "",
    ...(shown.length === 0 ? ["No tick in the window was over the limit."] : [
      "| started (UTC) | wall s | CPU s | longest phase | phase wall s | phase CPU s |",
      "| --- | ---: | ---: | --- | ---: | ---: |",
      ...shown.map((tick) => `| ${clock(tick.startedAt)} | ${seconds(tick.wallMs)} | ${seconds(tick.cpuMs)} | \`${tick.phase}\` | ${seconds(tick.phaseWallMs)} | ${secs(tick.phaseCpuMs)} |`),
      ...(record.slow.length > shown.length ? ["", `…and ${record.slow.length - shown.length} older slow ticks in the window.`] : []),
    ]),
    "",
  ].join("\n");
}

// ---- THE COUNTS (agent-org#1208 done-when 5) --------------------------------------------------------------------------------------------------

/** The cost file beside the wake ledger: one line per tick. `work-tick.ts` writes it and re-exports this name; the readers below take it from here, a leaf. */
export const TICK_COST_FILE = "tick-cost.jsonl";

/** The subject a `tick-overran` wake carried before the slow case was recorded and not delivered: only the ledger's own old lines still say it. */
const LEGACY_SLOW_SUBJECT = "tick-slow";

/** `tick-overran` wakes in the window by the case they were for: `slow` reads 0 once the slow case is recorded, `killed` is the one case that still wakes. */
export type OverranWakes = { slow: number; killed: number };

/** The two figures the chairman named (a11ign#928), over the record's window: the tick wall p50/p95 and `tick-overran` wakes per day. `wakes` is `null` when no ledger was read. */
export type TickHealth = { windowMs: number; ticks: number; p50Ms: number | null; p95Ms: number | null; slow: number; thresholdSeconds: number; wakes: OverranWakes | null };

/**
 * `tick-overran` wakes in the window, from the wake ledger's text (`<epoch ms>\t<causeKey>\t...`, the key being `<session>/<cause>/<subject>-<time>`). A line that is not
 * one is skipped. @param {string} ledgerText @param {{ now: number, windowMs?: number }} window @returns {OverranWakes}
 */
export function overranWakesOf(ledgerText: string, { now, windowMs = TICK_RECORD_WINDOW_MS }: { now: number; windowMs?: number; }): OverranWakes {
  const wakes: OverranWakes = { slow: 0, killed: 0 };
  for (const raw of ledgerText.split("\n")) {
    const [stamp, key] = raw.split("\t");
    const at = Number(stamp);
    if (!key || !Number.isFinite(at) || now - at > windowMs || at > now) continue;
    const [, cause, subject = ""] = key.split("/");
    if (cause !== TICK_OVERRAN) continue;
    if (subject.startsWith(TICK_KILLED)) wakes.killed += 1;
    else if (subject.startsWith(LEGACY_SLOW_SUBJECT)) wakes.slow += 1;
  }
  return wakes;
}

/**
 * THE ONE READING BOTH READERS SHARE: `org-health` and the weekly report call this over the same cost file the record's table is drawn from, so the p50/p95 they print are the
 * record's and not a second measurement. `ledgerText` is `null` when the ledger could not be read, which is "not read" and never a zero.
 * @param {{ costText: string, ledgerText: string | null, now: number, thresholdSeconds?: number }} input @returns {TickHealth}
 */
export function tickHealthOf({ costText, ledgerText, now, thresholdSeconds = TICK_SLOW_SECONDS }: { costText: string; ledgerText: string | null; now: number; thresholdSeconds?: number; }): TickHealth {
  const record = tickRecordOf(parseCostLines(costText), { now, thresholdSeconds });
  return { windowMs: TICK_RECORD_WINDOW_MS, ticks: record.ticks, p50Ms: record.p50Ms, p95Ms: record.p95Ms, slow: record.slow.length, thresholdSeconds,
    wakes: ledgerText === null ? null : overranWakesOf(ledgerText, { now }) };
}

/** Over the limit at the 95th percentile: more than one tick in twenty ran past it, which is a trend and no longer one slow tick. @param {TickHealth} health */
export function tickWallIsHigh(health: TickHealth): boolean {
  return health.p95Ms !== null && health.p95Ms > health.thresholdSeconds * MS_PER_SECOND;
}

/** The reading as one line. @param {TickHealth} health @returns {string} */
export function tickHealthLine(health: TickHealth): string {
  const secs = (ms: number | null) => (ms === null ? "n/a" : `${seconds(ms)} s`);
  const hours = health.windowMs / (60 * 60 * MS_PER_SECOND);
  const wakes = health.wakes === null ? "not read (the wake ledger could not be read)" : `slow ${health.wakes.slow}, killed ${health.wakes.killed}`;
  return `tick wall over ${health.ticks} tick${health.ticks === 1 ? "" : "s"} in ${hours} h: p50 ${secs(health.p50Ms)}, p95 ${secs(health.p95Ms)} (limit ${health.thresholdSeconds} s; ${health.slow} over it, `
    + `recorded on the standing row and waking nobody); tick-overran wakes per day: ${wakes}`;
}

// ---- THE RECORD'S STATE, AND ITS WRITE -------------------------------------------------------------------------------------------------------

/**
 * `commentId` is the standing comment once known; `unwritten` is set from the first refused write until one lands, with the reason; `row` is the standing row THE TICK
 * CREATED (done-when 2: created once and recorded, never found by title), kept here because the project declaration is another repository's file that no tick writes.
 */
export type TickRecordState = { commentId: number | null; row: number | null; unwritten: { since: number; why: string } | null };

/**
 * The state, or the empty one when there is no file. A file that is there and cannot be read is `unwritten` with that as the reason: absence of a reading is not a
 * written record, and the next tick rewrites the file whole.
 * @param {string} path @param {number} [now] @returns {TickRecordState}
 */
export function readTickRecordState(path: string, now: number = Date.now()): TickRecordState {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { commentId: null, row: null, unwritten: null };
    return { commentId: null, row: null, unwritten: { since: now, why: `the record state at ${path} could not be read (${String((error as Error).message).split("\n")[0]})` } };
  }
  try {
    const { commentId, row, unwritten } = JSON.parse(text);
    return {
      commentId: Number.isInteger(commentId) ? commentId : null,
      row: Number.isInteger(row) && row > 0 ? row : null,
      unwritten: unwritten && Number.isFinite(unwritten.since) && typeof unwritten.why === "string" ? { since: unwritten.since, why: unwritten.why } : null,
    };
  } catch {
    return { commentId: null, row: null, unwritten: { since: now, why: `the record state at ${path} is not valid JSON` } };
  }
}

/** Written whole through a rename, so a tick killed mid-write leaves the old state and never half of one. @param {string} path @param {TickRecordState} state */
export function writeTickRecordState(path: string, state: TickRecordState) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`);
  renameSync(temporary, path);
}

/**
 * THE ONE LINE `org-health` carries while the record is unwritten, or `null` when it is written (or has never been due). `since` is the first refused write.
 * @param {TickRecordState} state @param {number} now @returns {string | null}
 */
export function tickRecordUnwrittenLine(state: TickRecordState, now: number): string | null {
  if (state.unwritten === null) return null;
  const minutes = Math.max(0, Math.round((now - state.unwritten.since) / (60 * MS_PER_SECOND)));
  return `the tick record is unwritten since ${clock(state.unwritten.since)} (${minutes} min): ${state.unwritten.why}. Slow ticks are not being recorded and wake nobody.`;
}

/**
 * The standing row, from the project declaration's text: `units.tickRecordIssue` in the FIRST declared tracker's repository (the heartbeat's own rule: one object,
 * one repository). Never searched for by title. A declared row wins; otherwise the row this tick tool created before (`created`, from the state file); otherwise
 * `issue` is `null`, which is "none yet, create it once". A reason, and never a default, when the declaration cannot be read or names no tracker.
 * @param {string} text @param {number | null} [created] @returns {{ repo: string, issue: number | null } | { refusal: string }}
 */
export function tickRecordTargetFrom(text: string, created: number | null = null): { repo: string; issue: number | null } | { refusal: string } {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { refusal: "the project declaration is not valid JSON" };
  }
  const repo = Array.isArray(parsed?.tracker) ? parsed.tracker[0]?.repo : undefined;
  if (typeof repo !== "string" || repo === "") return { refusal: "the project declaration names no tracker repository" };
  const issue = parsed?.units?.[TICK_RECORD_ISSUE_KEY];
  if (issue !== undefined && !(Number.isInteger(issue) && issue > 0)) return { refusal: `the project declaration's units.${TICK_RECORD_ISSUE_KEY} is not a positive integer` };
  return { repo, issue: issue ?? created };
}

/** The title and the body the standing row is created with: the marker is not in it (the marker is the COMMENT's), and the body says how to name it in the declaration. */
export const TICK_RECORD_ROW_TITLE = "Tick record: slow ticks and the tick wall p50/p95 (standing row, written by the tick)";
export function tickRecordRowBody(): string {
  return "The work tick records a tick that ran past its limit HERE, as ONE comment it edits in place (a marker line, then the rolling 24 h table and the p50/p95 tick wall), "
    + "and wakes no session for it (agent-org#1208, chairman a11ign#928). A tick that was KILLED still wakes `ceo`: it left no cost line, so there is nothing to record.\n\n"
    + `This row was created once by the tick and its number is kept in the tick's state. To name it in the project declaration, set \`units.${TICK_RECORD_ISSUE_KEY}\` in `
    + "`.agent-org/project.json` to this number; a declared row wins over the kept one. It is created for the ceo lane and not marked ready, so it is not offered as work.";
}

/**
 * THE STANDING ROW, NAMED OR CREATED ONCE (done-when 2). The declaration's row wins; else the one this tool created before; else `create` runs ONCE and the new number is
 * written to the state file BEFORE anything else is done with it, so a later failure cannot make the next tick create a second row. Never a title search. A create that
 * fails is a refusal like any refused write (unwritten, retried by the next tick, never a wake).
 * @param {{ declarationText: string, state: TickRecordState, statePath: string, create: (repo: string) => number, now?: number }} input
 * @returns {{ repo: string, issue: number } | { refusal: string }}
 */
export function standingRowFor({ declarationText, state, statePath, create, now = Date.now() }:
  { declarationText: string; state: TickRecordState; statePath: string; create: (repo: string) => number; now?: number }): { repo: string; issue: number } | { refusal: string } {
  const target = tickRecordTargetFrom(declarationText, state.row);
  if ("refusal" in target) return target;
  if (target.issue !== null) return { repo: target.repo, issue: target.issue };
  let issue: number;
  try {
    issue = create(target.repo);
  } catch (error) {
    return { refusal: `the standing row could not be created in ${target.repo} (${String((error as any)?.stderr ?? "").trim().split("\n")[0] || String((error as Error)?.message ?? error).split("\n")[0]})` };
  }
  try {
    writeTickRecordState(statePath, { ...state, row: issue });
  } catch (error) {
    process.stderr.write(`TICK RECORD ROW #${issue} CREATED IN ${target.repo} BUT NOT KEPT at ${statePath}: ${String((error as Error).message).split("\n")[0]}. Declare units.${TICK_RECORD_ISSUE_KEY}: ${issue} in the project declaration, or the next tick creates another.\n`);
  }
  return { repo: target.repo, issue };
}

/** The standing comment, as the tick reaches it: injected, because this file names no `gh` (`gh-call-ratchet.test.ts`). `find` and `post` answer the comment's id, or `null` when unread. */
export type RecordIo = { find: () => number | null; post: (body: string) => number | null; edit: (id: number, body: string) => void };

export type RecordOutcome = "not-due" | "written" | "unwritten";

/**
 * THE SLOW TICK'S RECORD, AND THE RETRY OF ONE THAT FAILED. Due when this tick is slow, or when an earlier write is still unwritten (so a refused write is retried by
 * the very next tick, slow or not). A fast tick with nothing owed writes nothing, so the row is touched only when there is something to say.
 *
 * A REFUSED WRITE IS A STATE AND NEVER A WAKE: it sets `unwritten` in the state file, `org-health` reads it (`tickRecordUnwrittenLine`), and the next tick tries again. The
 * fallback this replaced, an order to `ceo` per overrun, is what the row removed. NEVER THROWS: a tick that did its work must not become a failure because its record
 * could not be written. `io` is `{ refusal }` when the standing row can be neither named nor created, which is a refused write like any other.
 *
 * @param {{ line: CostLine | null, costText: string, now: number, thresholdSeconds?: number, costPath: string, statePath: string, io: RecordIo | { refusal: string }, say?: (text: string) => void }} tick
 * @returns {RecordOutcome}
 */
export function recordSlowTick({ line, costText, now, thresholdSeconds = TICK_SLOW_SECONDS, costPath, statePath, io, say = (text) => process.stderr.write(text) }:
  { line: CostLine | null; costText: string; now: number; thresholdSeconds?: number; costPath: string; statePath: string; io: RecordIo | { refusal: string } | (() => RecordIo | { refusal: string }); say?: (text: string) => void }): RecordOutcome {
  const state = readTickRecordState(statePath, now);
  const slow = line !== null && isSlowTick(line, thresholdSeconds);
  if (!slow && state.unwritten === null) return "not-due";
  const refuse = (why: string, { forgetId = false }: { forgetId?: boolean; } = {}): RecordOutcome => {
    const next: TickRecordState = { commentId: forgetId ? null : state.commentId, row: readTickRecordState(statePath, now).row, unwritten: { since: state.unwritten?.since ?? now, why } };
    try {
      writeTickRecordState(statePath, next);
    } catch (error) {
      say(`TICK RECORD STATE NOT WRITTEN at ${statePath}: ${String((error as Error).message).split("\n")[0]}.\n`);
    }
    say(`TICK RECORD NOT WRITTEN (${why}); the next tick retries it and org-health says so. No session is woken for a slow tick.\n`);
    return "unwritten";
  };
  // `io` may be a function so that an ordinary tick, which owes nothing, does not read the declaration or create a row: it is asked here, past the due check.
  const target = typeof io === "function" ? io() : io;
  if ("refusal" in target) return refuse(target.refusal);
  try {
    const body = renderTickRecord(tickRecordOf(parseCostLines(costText), { now, thresholdSeconds, current: line }), { now, thresholdSeconds, costPath });
    let id = state.commentId ?? target.find();
    if (id === null) id = target.post(body);
    else target.edit(id, body);
    try {
      writeTickRecordState(statePath, { commentId: id, row: readTickRecordState(statePath, now).row, unwritten: null });
    } catch (error) {
      say(`TICK RECORD STATE NOT WRITTEN at ${statePath}: ${String((error as Error).message).split("\n")[0]}. The record itself is written.\n`);
    }
    return "written";
  } catch (error) {
    // A cached id that no longer takes an edit (the comment was deleted) is forgotten, so the retry finds or posts the comment again.
    return refuse(String((error as any)?.stderr ?? "").trim().split("\n")[0] || String((error as Error)?.message ?? error).split("\n")[0], { forgetId: true });
  }
}

/**
 * The order for a tick that never finished, or none. `foundAt` is when the tick that read the marker began, so the time the dead tick ran is an UPPER
 * bound (it ended no later than this); the unit's `TimeoutStartSec` is the usual ender, and a killed tick writes no cost line, which is why the order
 * points at the lines before it.
 *
 * @param {Marker | null} marker @param {{ foundAt: number, costPath: string }} where @returns {TickOrder[]}
 */
export function killedTickOrders(marker: Marker | null, { foundAt, costPath }: { foundAt: number; costPath: string; }): TickOrder[] {
  if (marker === null) return [];
  const startedAt = Math.round(marker.at);
  // The phase first, when the marker names one (agent-org#1542): the journal of that phase is the reader's first read, and the cost lines of the ticks
  // before are the second, because a killed tick writes none of its own. The time in the phase is an upper bound, as the time in the tick is.
  const where = marker.phase !== null && marker.phaseAt !== null
    ? `It was in phase "${marker.phase}" for at most ${elapsed(foundAt - marker.phaseAt)} when it was killed (the last phase it began at ${clock(marker.phaseAt)}). `
      + "Read the unit's own journal from that time first: it says what the phase was waiting on. Then the cost lines before it, "
      + `\`tail -n 5 ${costPath}\` (phases, then the slowest and hottest command lines).`
    : "No phase was recorded, so the marker cannot say where it was killed. A killed tick writes no cost line, so look at the ones before it: "
      + `\`tail -n 5 ${costPath}\` (phases, then the slowest and hottest command lines), and at the unit's own journal for what it said last.`;
  return [{
    session: "ceo", cause: "tick-overran", subject: TICK_KILLED, discriminator: String(startedAt),
    prompt: `A TICK WAS KILLED. The one that started at ${clock(startedAt)} never finished: its start marker was still there when the tick that started at `
      + `${clock(foundAt)} began, and a tick that ends by itself clears it. It ran at most ${seconds(foundAt - startedAt)} s (it ended before this one began); `
      + `\`TimeoutStartSec\` is the usual ender, then a restart${marker.unreadable ? ". THE MARKER WAS UNREADABLE, so that start time is the file's modification time" : ""}.\n`
      + where,
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
export function deliverTickOrders(orders: TickOrder[], { node, args, spawn = spawnSync, say = (text) => process.stderr.write(text) }: { node: string; args: string[]; spawn?: typeof spawnSync; say?: (text: string) => void; }): boolean {
  if (orders.length === 0) return false;
  const kinds = orders.map((order) => order.subject).join(", ");
  const ran = spawn(node, args, { encoding: "utf8", input: orders.map((order) => `${JSON.stringify(order)}\n`).join("") });
  if (ran.stdout) process.stdout.write(ran.stdout);
  if (ran.stderr) say(ran.stderr);
  const failed = ran.error?.message ?? (ran.status === 0 ? null : `it exited ${ran.status}: the order had nowhere to go`);
  if (failed !== null) say(`TICK HEALTH NOT DELIVERED (${kinds}): wake could not take it (${failed}).\n`);
  return failed === null;
}
