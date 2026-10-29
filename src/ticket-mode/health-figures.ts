// @ts-check
// module: the rolling health figures `GET /api/health` serves and the watchdog and the board's header read (A11-363)
//
// ON 2026-10-27 THE ONLY DETECTOR OF A STALLED BOARD WAS THE CHAIRMAN. These are the numbers a detector reads, kept by the board itself so no one has to look at a log: how long the event loop waits (a minute and an hour), how many
// synchronous calls held it, how many calls to Linear and GitHub failed, how long it has been since a run started, how many queued runs could start and how many slots are free, and how long since a `fill()` pass last
// completed and why the last one gave up early.
//
// THE BOARD THREAD KEEPS THEM and posts them in its snapshot (`thread-messages.ts`); the request thread serves them. A figure that needs the queue is worked out from the queue (`runFiguresOf`, PURE) and from the pool's memory
// of its passes (`pool-figures.ts`); the loop, the holds and the calls are measured where they happen (`loop-delay.ts`, `blocking-ledger.ts`, `call-outcomes.ts`).
import { HOLD_MS } from "./blocking-ledger.ts";
import type { CallFigures } from "./call-outcomes.ts";
import type { LoopReading, LoopSpan } from "./loop-delay.ts";
import type { Queue } from "./queue/queue-entries-and-outcomes.ts";
import { slotsHeld } from "./queue/queue-transitions.ts";

/** A synchronous call that holds the loop this long, in ms, is a hold: the p99 the header warns at, so a hold is a call the warning would name. Defined beside the journal's line, which says every one (A11-282). */
export { HOLD_MS };
/** How far back the hold count looks, in ms. */
export const HOLD_WINDOW_MS = 3_600_000;

/** A loop delay over a stretch: p50 and p99 in ms. */
export type Percentiles = Readonly<{ p50Ms: number; p99Ms: number }>;

/** What the pool remembers of its `fill()` passes, in memory. */
export type FillState = {
  /** When the last pass ran to its end, or null before the first one has since this instance started. */
  completedAt: number | null;
  /** Why the latest pass returned early, and when, or null when the latest pass ran to its end. */
  early: Readonly<{ reason: string; at: number }> | null;
  /** Why the board is deliberately starting nothing (an update draining, a preflight failing), or null. A restart does not mend it. */
  holding: string | null;
  /** When a run was last recorded as starting by this instance, or null. */
  lastStartAt: number | null;
  /** Whether the instance has been told to stop: it starts nothing while it waits for the runs that are starting. */
  stopping: boolean;
  /** The queued runs the latest pass held for what the board knows of their blockers or plan, with the reason the board shows on their cards (A11-364). */
  held: readonly HeldRun[];
};

/** A queued run held for a read: its key, and why (`blockers unread: <error>, retrying at 22:05Z`). */
export type HeldRun = Readonly<{ key: string; reason: string }>;

export const newFillState = (): FillState => ({ completedAt: null, early: null, holding: null, lastStartAt: null, stopping: false, held: [] });

export type FillFigures = Readonly<{
  /** Ms since the last completed pass, or null when none has completed since this instance started (`uptimeMs` is then how long it has gone without one). */
  sinceLastCompletedMs: number | null;
  /** The reason the latest pass returned early and how long ago, or null when it did not. */
  lastEarlyReturn: Readonly<{ reason: string; agoMs: number }> | null;
  /** The queued runs the latest pass held because their blockers or plan are unread or too old, and why (A11-364): the runs a read holds, which no other run waits for. */
  held: readonly HeldRun[];
}>;

export type RunFigures = Readonly<{
  /** Ms since a run last started (the queue's latest start), or null when none ever has. */
  sinceLastStartMs: number | null;
  /** Queued entries a pass would start now, and 0 while the board deliberately starts nothing (`holding`). */
  startable: number;
  /** Slots no live run holds. */
  freeSlots: number;
  /** Runs whose agent is not open yet, and how long the oldest has been starting: a restart in that moment finds nothing of them in herdr. */
  starting: number;
  oldestStartingMs: number | null;
  /** Why the board starts nothing on purpose, or null. */
  holding: string | null;
}>;

export type PoolFigures = Readonly<{ runs: RunFigures; fill: FillFigures }>;

/** Everything `/api/health` serves besides the raw loop readings. `at` is when it was worked out, in ms since the epoch; `uptimeMs` is how long this instance has run. */
export type HealthFigures = Readonly<{
  at: number;
  uptimeMs: number;
  loop: Readonly<{ lastMinute: Percentiles; lastHour: Percentiles }>;
  syncHolds: Readonly<{ lastHour: number; holdMs: number }>;
  calls: CallFigures;
  runs: RunFigures;
  fill: FillFigures;
}>;

/** What the loop, the holds and the calls gave: the part of the figures the board thread measures itself. */
export type MeasuredFigures = Readonly<{ loop: LoopReading; hour: LoopSpan; holds: number; calls: CallFigures }>;

/** The figures of what was measured, what the pool remembers and the queue, at `now`. PURE. */
export function healthFigures(measured: MeasuredFigures, pool: PoolFigures, startedAt: number, now: number): HealthFigures {
  const { loop, hour } = measured;
  return { at: now, uptimeMs: Math.max(0, now - startedAt), loop: { lastMinute: { p50Ms: loop.p50Ms, p99Ms: loop.p99Ms }, lastHour: { p50Ms: hour.p50Ms, p99Ms: hour.p99Ms } },
    syncHolds: { lastHour: measured.holds, holdMs: HOLD_MS }, calls: measured.calls, runs: pool.runs, fill: pool.fill };
}

const sinceOrNull = (at: number | undefined | null, now: number): number | null => (at === undefined || at === null ? null : Math.max(0, now - at));

/**
 * The run figures of a queue at `now`: the latest start any entry records (or `lastStartAt`, a start this instance made that the queue has since dropped, such as a run queued again), `startable` entries as many as the
 * pass would start (`startableNow`), the free slots, and the runs still starting. `holding` zeroes `startable`: a board that starts nothing on purpose has nothing a restart would start. PURE.
 */
export function runFiguresOf(queue: Queue, startable: number, holding: string | null, lastStartAt: number | null, now: number): RunFigures {
  const started = queue.entries.map((entry) => entry.startedAt).filter((at): at is number => at !== undefined);
  const latest = Math.max(lastStartAt ?? -Infinity, ...started);
  const startingSince = queue.entries.filter((entry) => entry.phase === "starting" && entry.startedAt !== undefined).map((entry) => entry.startedAt as number);
  const starting = new Set(queue.entries.filter((entry) => entry.phase === "starting").map((entry) => entry.batch ?? entry.ticket.key)).size;
  return { sinceLastStartMs: Number.isFinite(latest) ? Math.max(0, now - latest) : null, startable: holding === null ? startable : 0, freeSlots: Math.max(0, queue.max - slotsHeld(queue)), starting,
    oldestStartingMs: startingSince.length === 0 ? null : Math.max(0, now - Math.min(...startingSince)), holding };
}

/** The fill figures of the pool's memory at `now`. PURE. */
export function fillFiguresOf(state: FillState, now: number): FillFigures {
  return { sinceLastCompletedMs: sinceOrNull(state.completedAt, now), lastEarlyReturn: state.early === null ? null : { reason: state.early.reason, agoMs: Math.max(0, now - state.early.at) }, held: state.held };
}
