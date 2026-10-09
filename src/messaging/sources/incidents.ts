// THE INCIDENT SOURCES (a11ign/a11ign#2904, row 5 of 13; design #2899): what has BROKEN, as opposed to what has stopped (`stall.ts`).
//
//   incident:trunk-red       the newest verdict on `main` (trunk.yml) is a failure
//   incident:gate-crash      the work-tick unit failed, or no tick has COMPLETED for 3 intervals (the tick's own completion record, #3040)
//   incident:fleet-down      a worker has been non-ready past fleet-watch's own threshold, from the state fleet-watch already writes
//   incident:ci-permission   a workflow's newest run carries a `Resource not accessible` annotation
//
// **AN INCIDENT REACHES THE CHAIRMAN ONLY IF IT IS STILL THERE 30 MINUTES LATER**, and that is the CORE's rule (`holdDownMs` for kind
// `incident`), not this file's. THIS FILE'S PART IS `firstSeenAt`: the moment the condition BEGAN, derived from what the read holds
// (the failing run's own time, the failed unit's own timestamp), never "now". A source that stamped its events with the time it looked
// would restart the 30 minutes on every tick, and nothing would ever be sent. Going green returns the same key with `resolved: true`,
// which is what lets the core send its ONE "cleared" and no more.
//
// A LEAF AND INJECTED, as `stall.ts` is, and the same rule about a failed read: `cannot-ask`, no event, never a false clear.

import { TICK_INTERVAL_MS, instant, observe, requireReader, span, withMeaning } from "./stall.ts";
import type { FixRowReader, Observation } from "./stall.ts";

const MINUTE_MS = 60_000;
const SHA_LENGTH = 7;
const MAX_NAMED = 5;
/** The annotation GitHub writes when a workflow's token lacks a permission, as the row names it. */
export const PERMISSION_ANNOTATION = /Resource not accessible/i;

export const DEFAULT_INCIDENT_CONFIG = Object.freeze({
  /** A tick record older than this many ticks means the gate is not running (the row's 3). */
  gateStaleTicks: 3,
  tickIntervalMs: TICK_INTERVAL_MS,
  /** Non-ready this long is fleet-watch's own definition of overdue (`DEFAULT_THRESHOLD_MS` there), so this is not a second opinion. */
  fleetThresholdMs: 10 * MINUTE_MS,
  /** A fleet-watch file older than this is not a reading of the fleet. */
  fleetStateMaxAgeMs: 30 * MINUTE_MS,
});

/**
 * The run's time as the condition's start: when it CONCLUDED if it says so (a red run is red from the moment it fails, not from the
 * moment the push started it).
 */
function concludedAt(run: Record<string, any>): number {
  return instant(run.updated_at ?? run.created_at, "run.updated_at");
}

/** Newest first, whatever order the reader returned. */
function newestFirst(runs: Record<string, any>[]): Record<string, any>[] {
  if (!Array.isArray(runs)) throw new TypeError("runs: an array is required");
  return [...runs].sort((a, b) => concludedAt(b) - concludedAt(a));
}

/**
 * The runs from the newest back, while each one is bad. `runs` is newest first.
 */
function currentStreak(runs: Record<string, any>[], isBad: (run: Record<string, any>) => boolean) {
  const streak = [];
  for (const run of runs) {
    if (!isBad(run)) break;
    streak.push(run);
  }
  return streak;
}

/**
 * `main` is red when the newest run that said `success` or `failure` said `failure`. A cancelled, skipped or still-running run says
 * nothing about `main` and is looked through (`trunk-red.ts`'s rule, restated because a leaf cannot import it). No verdict at all is no
 * event: there is nothing to say and nothing to clear.
 *
 * `runs` is the runs of `trunk.yml` on `main`, any order.
 */
export function trunkRedEvents(runs: Record<string, any>[], now: number): Record<string, unknown>[] {
  const verdicts = newestFirst(runs).filter((run) => run.status === "completed" && ["success", "failure"].includes(run.conclusion));
  if (verdicts.length === 0) return [];
  const base = { key: "incident:trunk-red", kind: "incident", severity: "critical" };
  if (verdicts[0].conclusion === "success") {
    return [{ ...base, firstSeenAt: now, text: "main is green again.", links: [verdicts[0].html_url].filter(Boolean), resolved: true }];
  }
  const streak = currentStreak(verdicts, (run) => run.conclusion === "failure");
  const since = concludedAt(streak[streak.length - 1]);
  const newest = streak[0];
  return [{ ...base, firstSeenAt: since, resolved: false, links: [newest.html_url].filter(Boolean),
    text: `main is red: trunk.yml failed at ${String(newest.head_sha ?? "an unknown commit").slice(0, SHA_LENGTH)}, red for ${span(now - since)}.` }];
}

/**
 * `failed` is the unit's own failed state and `failedAt` when it entered it; `lastRecordAt` is when a tick last COMPLETED (the record the tick writes at the
 *   end of `main()`), and `lastRunAt` when the unit last RAN, which a tick that died moves as well as one that finished
 */
export type GateUnitReading = { failed: boolean; failedAt?: number | string; lastRecordAt: number | string; lastRunAt: number | string };

/**
 * The gate crashing: the unit reads failed, or no tick has COMPLETED for N intervals. The second is the dead-man's switch, and it reads the completion
 * record and not the unit's own timestamp, which a crashed tick moves exactly as a good one (#3040). Either alone is enough, and the event's start is the
 * earlier of the two. The text says which kind of silence it is: ticks still starting and not finishing (a crash), or no tick starting at all.
 */
export function gateCrashEvents(unit: GateUnitReading, now: number, config: typeof DEFAULT_INCIDENT_CONFIG): Record<string, unknown>[] {
  if (unit === null || typeof unit !== "object" || typeof unit.failed !== "boolean") throw new TypeError("the unit reading needs a boolean `failed`");
  const lastRecordAt = instant(unit.lastRecordAt, "lastRecordAt");
  const lastRunAt = instant(unit.lastRunAt, "lastRunAt");
  const staleAfter = config.gateStaleTicks * config.tickIntervalMs;
  const reasons = [];
  if (unit.failed) reasons.push({ at: instant(unit.failedAt, "failedAt"), why: "the work-tick unit has failed" });
  if (now - lastRecordAt > staleAfter) {
    const completed = `the last tick that COMPLETED was at ${new Date(lastRecordAt).toISOString()} (${span(now - lastRecordAt)} ago)`;
    const since = now - lastRunAt <= staleAfter
      ? `ticks are still starting (the unit last ran ${span(now - lastRunAt)} ago) and not finishing, so they are crashing`
      : `the unit has not run since either (it last ran ${span(now - lastRunAt)} ago), so the timer is not firing`;
    reasons.push({ at: lastRecordAt + staleAfter, why: `${completed}, and ${since}` });
  }
  const base = { key: "incident:gate-crash", kind: "incident", severity: "critical", links: [] };
  if (reasons.length === 0) return [{ ...base, firstSeenAt: now, text: "The gate is ticking again.", resolved: true }];
  return [{ ...base, firstSeenAt: Math.min(...reasons.map((reason) => reason.at)), resolved: false,
    text: `The gate is down: ${reasons.map((reason) => reason.why).join(" and ")}.` }];
}

/** Worker name to the time it went non-ready, validated. */
function readFleetSince(reading: unknown, now: number, config: typeof DEFAULT_INCIDENT_CONFIG): Record<string, number> {
  const { state, writtenAt } = (reading ?? {}) as { state?: unknown; writtenAt?: unknown };
  if (state === null || typeof state !== "object" || Array.isArray(state)) throw new TypeError("the fleet-watch state must be an object of name to time");
  // Only when the reader knows when the file was written: a watcher that stopped leaves a clean-looking file, and a clean-looking file
  // is the false all-clear this module exists to refuse.
  if (writtenAt !== undefined && now - instant(writtenAt, "writtenAt") > config.fleetStateMaxAgeMs) {
    throw new RangeError(`the fleet-watch state was written ${span(now - instant(writtenAt, "writtenAt"))} ago`);
  }
  return Object.fromEntries(Object.entries(state).map(([name, since]) => [name, instant(since, `state.${name}`)]));
}

/**
 * Host or fleet down, as `fleet-watch` already decided it: workers non-ready since a time, the file it writes.
 */
export function fleetDownEvents(reading: { state: Record<string, number | string>; writtenAt?: number | string; }, now: number, config: typeof DEFAULT_INCIDENT_CONFIG): Record<string, unknown>[] {
  const since = readFleetSince(reading, now, config);
  const overdue = Object.entries(since).filter(([, at]) => now - at >= config.fleetThresholdMs).sort(([, a], [, b]) => a - b);
  const base = { key: "incident:fleet-down", kind: "incident", severity: "critical", links: [] };
  if (overdue.length === 0) return [{ ...base, firstSeenAt: now, text: "Every worker is ready again.", resolved: true }];
  const names = overdue.slice(0, MAX_NAMED).map(([name]) => name).join(", ");
  const more = overdue.length > MAX_NAMED ? ` and ${overdue.length - MAX_NAMED} more` : "";
  return [{ ...base, firstSeenAt: overdue[0][1] + config.fleetThresholdMs, resolved: false,
    text: `The fleet is down: ${overdue.length} worker${overdue.length === 1 ? "" : "s"} not ready for over ${span(config.fleetThresholdMs)} (${names}${more}).` }];
}

const hasPermissionAnnotation = (run: Record<string, any>): boolean =>
  Array.isArray(run.annotations) && run.annotations.some((note) => PERMISSION_ANNOTATION.test(String(note?.message ?? "")));

/**
 * CI that cannot do what it is for: a workflow whose NEWEST completed run carries a `Resource not accessible` annotation. Per
 * workflow, so a fixed workflow stops counting while a still-broken one keeps the incident open.
 *
 * `runs` is completed runs of any workflow, any order, each with its `annotations`.
 */
export function ciPermissionEvents(runs: Record<string, any>[], now: number): Record<string, unknown>[] {
  const completed = newestFirst(runs).filter((run) => run.status === "completed");
  const byWorkflow: Map<string, Record<string, any>[]> = new Map();
  for (const run of completed) byWorkflow.set(String(run.name), [...(byWorkflow.get(String(run.name)) ?? []), run]);
  const broken = [...byWorkflow.entries()]
    .map(([name, workflowRuns]) => ({ name, streak: currentStreak(workflowRuns, hasPermissionAnnotation) }))
    .filter(({ streak }) => streak.length > 0);
  const base = { key: "incident:ci-permission", kind: "incident", severity: "warning" };
  if (broken.length === 0) {
    return completed.length === 0 ? [] : [{ ...base, firstSeenAt: now, text: "CI permission failures have stopped.", links: [], resolved: true }];
  }
  const since = Math.min(...broken.map(({ streak }) => concludedAt(streak[streak.length - 1])));
  return [{ ...base, firstSeenAt: since, resolved: false, links: broken.map(({ streak }) => streak[0].html_url).filter(Boolean).slice(0, MAX_NAMED),
    text: `CI is refused a permission (\`Resource not accessible\`) in ${broken.map(({ name }) => name).join(", ")}, since ${span(now - since)} ago.` }];
}

/** The four incident kinds, each independently able to fail to ask. */
export async function observeIncidents({ now, config: overrides = {}, log = console.error, readers }: {
        now: () => number; config?: Partial<typeof DEFAULT_INCIDENT_CONFIG>; log?: (line: string) => void;
        readers: {
            readTrunkRuns?: Function; readGateUnit?: Function; readFleetState?: Function; readCiRuns?: Function;
            readFixRow?: FixRowReader;
            readEpisodeStart?: (key: string) => Promise<number | null> | number | null;
        };
    }): Promise<Observation> {
  const config = { ...DEFAULT_INCIDENT_CONFIG, ...overrides };
  const parts = await Promise.all([
    observe("incident:trunk-red", async () => withMeaning(trunkRedEvents(await requireReader(readers, "readTrunkRuns")(), now()), readers, log, now()), log),
    observe("incident:gate-crash", async () => withMeaning(gateCrashEvents(await requireReader(readers, "readGateUnit")(), now(), config), readers, log, now()), log),
    observe("incident:fleet-down", async () => withMeaning(fleetDownEvents(await requireReader(readers, "readFleetState")(), now(), config), readers, log, now()), log),
    observe("incident:ci-permission", async () => withMeaning(ciPermissionEvents(await requireReader(readers, "readCiRuns")(), now()), readers, log, now()), log),
  ]);
  return { events: parts.flatMap((part) => part.events), cannotAsk: parts.flatMap((part) => part.cannotAsk) };
}
