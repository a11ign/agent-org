#!/usr/bin/env node
// @ts-check
// command: ticket:watchdog -- restarts the instance when it is stalled, from outside its event loop (A11-363)
//
// ON 2026-10-27 THE BOARD WAS RESTARTED BY HAND THREE TIMES. Each time its queued runs had stopped starting while slots were free, and its API took minutes to answer. This is the detector that was a person: a systemd timer (a
// launchd interval job on macOS) runs it every minute as a process of its own, so a board whose loop is held cannot hold it. It asks the instance's `GET /api/health` and restarts the instance when
//   - queued runs could start (startable entries, free slots) and nothing has started for 10 minutes (`NO_START_MS`);
//   - no `fill()` pass has completed for 5 minutes (`NO_FILL_MS`);
//   - `/api/health` has not answered for 30 s (`NO_ANSWER_MS`).
// A restart is logged with its reason, counted in `watchdog.json` (`watchdog-record.ts`), and more than DEFECT_RESTARTS in an hour makes the board ask for one defect ticket for that hour (`watchdog-defect.ts`).
//
// THE FIGURES IT READS ARE AS OLD AS THE BOARD'S LAST SNAPSHOT. A held board thread stops posting snapshots, so the figures freeze at the moment it was held; their age (`boardSnapshotAgeMs`) is added to every
// time-since figure, and a board that stalls therefore reads as one whose time-since figures keep growing. An instance younger than a trigger's limit is never restarted for it: a figure with no pass yet is as old as the instance (`uptimeMs`).
//
// A STOPPED INSTANCE IS NOT A STALLED ONE. A service `agent-org stop` stopped, or one a person never started, is left alone. A restart keeps the runs running: the workers live in herdr's own service, and the instance takes
// back every pane herdr lists when it starts (`pool-readopt.ts`); a restart waits while a run is still starting (its agent is not open yet), up to STARTING_GRACE_MS.
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { uptime } from "node:os";
import type { HealthFigures } from "./health-figures.ts";
import { DEFECT_RESTARTS, hourOf, readRecord, restartsInHour, setUnreadableAside, watchdogPath, withRestart, writeRecord, type WatchdogReason, type WatchdogRecord, type WatchdogRestart, emptyRecord } from "./watchdog-record.ts";

/** Queued runs could start and nothing has started for this long, in ms. */
export const NO_START_MS = 10 * 60_000;
/** No `fill()` pass has completed for this long, in ms. */
export const NO_FILL_MS = 5 * 60_000;
/** `/api/health` has not answered for this long, in ms. */
export const NO_ANSWER_MS = 30_000;
/** A restart is held back while a run has been starting for less than this, in ms: its agent is not open yet, so a restart in that moment finds nothing of it in herdr. */
export const STARTING_GRACE_MS = 2 * 60_000;
/** A unit that became active less than this long ago, in ms, is still starting: the instance reconciles with herdr before it listens. */
export const ACTIVE_GRACE_MS = 2 * 60_000;
/** How long the watchdog waits for `/api/health`, in ms. */
export const PROBE_MS = NO_ANSWER_MS;

/** What `/api/health` answered, as far as the watchdog reads it. */
export type HealthAnswer = Readonly<{ boardSnapshotAgeMs: number; figures: HealthFigures | null }>;

export type Probe = Readonly<{ kind: "answered"; health: HealthAnswer }> | Readonly<{ kind: "unanswered"; why: string }>;

/** What the watchdog saw this minute. `activeForMs` is how long the instance's unit has been active, null when it is not running. */
export type Observation = Readonly<{ probe: Probe; probedAt: number; now: number; unansweredSince: number | null; activeForMs: number | null }>;

export type Verdict =
  | Readonly<{ act: "none"; unansweredSince: number | null; note: string }>
  | Readonly<{ act: "restart"; reason: WatchdogReason; detail: string }>;

const seconds = (ms: number): string => `${Math.round(ms / 1000)} s`;
const minutes = (ms: number): string => `${(ms / 60_000).toFixed(1)} min`;
const leave = (note: string, unansweredSince: number | null = null): Verdict => ({ act: "none", unansweredSince, note });

/** What a stall of the figures costs the restart: the runs still starting, which it waits for. PURE. */
function startingHold({ runs }: HealthFigures, age: number): string | null {
  if (runs.starting === 0 || runs.oldestStartingMs === null || runs.oldestStartingMs + age >= STARTING_GRACE_MS) return null;
  return `${runs.starting} run${runs.starting === 1 ? " is" : "s are"} still starting`;
}

/** The restart the figures call for, or none. PURE. */
function judgeFigures(health: HealthAnswer & { figures: HealthFigures }): Verdict {
  const { figures, boardSnapshotAgeMs: age } = health;
  const fillAge = (figures.fill.sinceLastCompletedMs ?? figures.uptimeMs) + age;
  const startAge = Math.min(figures.runs.sinceLastStartMs ?? Infinity, figures.uptimeMs) + age;
  const reason = fillAge > NO_FILL_MS ? "no-fill" as const : figures.runs.startable > 0 && figures.runs.freeSlots > 0 && startAge > NO_START_MS ? "no-start" as const : null;
  if (reason === null) return leave("healthy");
  const holding = startingHold(figures, age);
  if (holding !== null) return leave(`would restart (${reason}), but ${holding}`);
  if (reason === "no-fill") {
    const early = figures.fill.lastEarlyReturn;
    return { act: "restart", reason, detail: `no fill() pass has completed for ${minutes(fillAge)}${early === null ? "" : `; the last returned early: ${early.reason}`}` };
  }
  return { act: "restart", reason, detail: `${figures.runs.startable} queued run${figures.runs.startable === 1 ? "" : "s"} could start, ${figures.runs.freeSlots} slot${figures.runs.freeSlots === 1 ? " is" : "s are"} free, and nothing has started for ${minutes(startAge)}` };
}

/** What to do about what was seen. PURE. */
export function decide({ probe, probedAt, now, unansweredSince, activeForMs }: Observation): Verdict {
  if (activeForMs === null) return leave("the instance is not running, so there is nothing to restart");
  if (probe.kind === "unanswered") {
    if (activeForMs < ACTIVE_GRACE_MS) return leave(`the instance became active ${seconds(activeForMs)} ago and is still starting (${probe.why})`);
    const since = unansweredSince ?? probedAt;
    if (now - since < NO_ANSWER_MS) return leave(`/api/health did not answer (${probe.why}); asked again next time`, since);
    return { act: "restart", reason: "no-answer", detail: `/api/health has not answered for ${seconds(now - since)} (${probe.why})` };
  }
  if (probe.health.figures === null) return leave("the instance answers and has posted no figures yet");
  return judgeFigures({ ...probe.health, figures: probe.health.figures });
}

/** The restarts that make a defect: a count in the hour `at` is in. PURE. */
export const restartsThisHour = (record: WatchdogRecord, at: number): number => restartsInHour(record, hourOf(at)).length;

export type WatchdogDeps = Readonly<{
  now: () => number;
  /** Asks `/api/health`, waiting at most PROBE_MS; never throws. */
  probe: () => Promise<Probe>;
  /** How long the instance's unit has been active, in ms, or null when it is not running. */
  activeForMs: () => number | null;
  /** Restarts the instance's service. THROWS when the manager refuses. */
  restart: () => void;
  recordPath: string;
  log: (line: string) => void;
}>;

/**
 * The record on disk. One that cannot be read is NOT written over: it is set aside beside itself and said as an error, and the watchdog starts a record of its own, since its job is the restart. What it held is kept for
 * a person, and the board's header and `doctor` say a record could not be read until a new one has a restart in it.
 */
function recordOf({ recordPath, now, log }: Pick<WatchdogDeps, "recordPath" | "now" | "log">): WatchdogRecord {
  try {
    return readRecord(recordPath);
  } catch (err) {
    const aside = setUnreadableAside(recordPath, now());
    log(`ERROR watchdog: ${String((err as Error)?.message ?? err).split("\n")[0]}; ${aside === null ? "it could not be moved aside either" : `it is kept as ${aside}`}, and restarts are counted from none`);
    return emptyRecord();
  }
}

/** One run of the watchdog: look, decide, and restart when it should. Returns what it decided. THROWS when the restart is refused (after saying so). */
export async function runWatchdog(deps: WatchdogDeps): Promise<Verdict> {
  const { now, recordPath, log } = deps;
  const record = recordOf(deps);
  const probedAt = now();
  const probe = await deps.probe();
  const verdict = decide({ probe, probedAt, now: now(), unansweredSince: record.unansweredSince, activeForMs: deps.activeForMs() });
  if (verdict.act === "none") {
    if (verdict.unansweredSince !== record.unansweredSince) writeRecord(recordPath, { ...record, unansweredSince: verdict.unansweredSince });
    if (verdict.note !== "healthy") log(`watchdog: no restart: ${verdict.note}`);
    return verdict;
  }
  const at = now();
  const restart: WatchdogRestart = { at, reason: verdict.reason, detail: verdict.detail };
  const next = withRestart(record, restart);
  const thisHour = restartsThisHour(next, at);
  log(`watchdog: restarting the instance (${verdict.reason}): ${verdict.detail}. Restart ${next.count} in all, ${thisHour} this hour`);
  try {
    deps.restart();
  } catch (err) {
    log(`ERROR watchdog: the restart was refused: ${String((err as Error)?.message ?? err)}`);
    throw err;
  }
  writeRecord(recordPath, next);
  if (thisHour > DEFECT_RESTARTS) log(`watchdog: ${thisHour} restarts this hour, so the board asks for a defect ticket for the hour`);
  return verdict;
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isNumberOrNull = (value: unknown): boolean => value === null || isNumber(value);
const isObject = <T extends object>(value: T | null | undefined): value is T => typeof value === "object" && value !== null;

/** Whether `value` has every figure `judgeFigures` reads, each a finite number (or null where the figure may be absent). PURE. */
export function isHealthFigures(value: unknown): value is HealthFigures {
  const figures = value as { uptimeMs?: unknown; fill?: { sinceLastCompletedMs?: unknown; lastEarlyReturn?: unknown } | null; runs?: Record<string, unknown> | null } | null;
  if (typeof figures !== "object" || figures === null || !isNumber(figures.uptimeMs)) return false;
  const { fill, runs } = figures;
  if (!isObject(fill) || !isObject(runs)) return false;
  if (!isNumberOrNull(fill.sinceLastCompletedMs) || fill.lastEarlyReturn === undefined) return false;
  return isNumberOrNull(runs.sinceLastStartMs) && isNumber(runs.startable) && isNumber(runs.freeSlots) && isNumber(runs.starting) && isNumberOrNull(runs.oldestStartingMs);
}

/** `/api/health` of the instance on `port`, waiting at most `timeoutMs`. Never throws. */
export async function probeHealth(port: number, timeoutMs: number = PROBE_MS, fetchImpl: typeof fetch = fetch): Promise<Probe> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { kind: "unanswered", why: `it answered ${response.status}` };
    const body = await response.json() as { boardSnapshotAgeMs?: unknown; figures?: unknown } | null;
    const figures = body?.figures ?? null;
    // Figures that are there but not figures are not an answer: read as healthy, they would hold back every restart (A11-363 review).
    if (figures !== null && !isHealthFigures(figures)) return { kind: "unanswered", why: "it answered with figures the watchdog cannot read" };
    // The figures are as old as the snapshot: figures with no readable age could be any age, and read as fresh they would hold back a restart. An instance from before the figures sends neither.
    const age = body?.boardSnapshotAgeMs;
    if (figures !== null && !isNumber(age)) return { kind: "unanswered", why: "it answered figures without a readable snapshot age" };
    return { kind: "answered", health: { boardSnapshotAgeMs: isNumber(age) ? age : 0, figures } };
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    return { kind: "unanswered", why: (err as Error)?.name === "TimeoutError" ? `no answer within ${seconds(timeoutMs)}` : `${cause ?? String((err as Error)?.message ?? err)}` };
  }
}

/** The command: `agent-org ticket:watchdog`. @returns the exit code */
export async function main(argv: string[]): Promise<number> {
  if (argv.length > 0) {
    process.stderr.write("usage: agent-org ticket:watchdog\n");
    return 2;
  }
  const [{ readTicketSettings }, service] = await Promise.all([import("./settings.ts"), import("../install/service.ts")]);
  const settings = readTicketSettings();
  const deps = service.defaultServiceDeps();
  const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  try {
    await runWatchdog({ now: Date.now, probe: () => probeHealth(settings.port), activeForMs: () => service.activeForMs("instance", deps, uptime() * 1000), restart: () => service.restartService("instance", deps),
      recordPath: watchdogPath(settings.stateDir), log });
    return 0;
  } catch {
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
