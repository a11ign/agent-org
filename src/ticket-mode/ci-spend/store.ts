// module: what the board keeps of each ticket's CI (A11-261, `Queue.ciSpend`) -- the workflow runs read from its branch, whether it was warned, and how far it has been held -- PURE
//
// KEPT ON THE QUEUE BY TICKET, beside the run log (ADR 0013), because a ticket's pushes outlive any one run of it: a run that is dropped or retried keeps its ticket's total. A COMPLETED RUN IS SETTLED: its jobs are kept, and it is never
// asked about again. The tickets that left the queue keep their record up to {@link GONE_TICKETS_MAX}, as the run log keeps its.
import type { BranchCiRun } from "../../plugins/contracts/code-host.ts";
import type { Queue } from "../queue/queue-entries-and-outcomes.ts";

/** The most tickets kept that are no longer on the queue (dismissed or removed): the ones read most recently. */
export const GONE_TICKETS_MAX = 50;

/**
 * What the board holds of one ticket's CI: the workflow runs of its branch by run id (every repository the ticket is worked in; a run id is unique across them), when it was last read, the total weighted minutes it was warned at (`warned`), and the
 * multiple of its budget it was last held at (`held`, 2 for the first hold at twice the budget).
 */
export type TicketCi = Readonly<{ runs: Readonly<Record<string, BranchCiRun>>; readAt: number; warned?: number; held?: number }>;

/**
 * Why a queued run is held back, and for how long: the reason the card and the next round's brief give (`reason`), when it was held (`at`), and how many passes of the board have gone by (`passes`). Once {@link HOLD_PASSES} have, the hold
 * is `released` and the run may start; the reason stays for its brief. A fresh hold has had none.
 */
export type CiHold = Readonly<{ reason: string; at: number; passes: number; released?: true }>;

/** The board's passes a hold lasts: it is set between two passes, so the first it sees is a part of one at most, and the second is a whole one in which the run does not start. */
export const HOLD_PASSES = 2;

/** The runs of ticket `key`, as the board last read them; none for a ticket it has not read. PURE. */
export const runsOf = (queue: Queue, key: string): readonly BranchCiRun[] => Object.values(queue.ciSpend?.[key]?.runs ?? {});

/** The ids of the ticket's runs that are settled: completed, with their jobs held. These are never asked for again. PURE. */
export const settledIds = (queue: Queue, key: string): ReadonlySet<number> =>
  new Set(runsOf(queue, key).filter((run) => run.status === "completed").map((run) => run.id));

/**
 * `read` merged into what the board holds of the ticket's runs: a run read with its jobs replaces what was held; a run read as settled (no jobs, and still completed) keeps the jobs held; a settled run that is no longer completed
 * (a re-run began) keeps its old jobs but is asked for again next time, since the new attempt's jobs are not read. A run the read no longer lists stays. PURE.
 */
export function mergedRuns(held: Readonly<Record<string, BranchCiRun>>, read: readonly BranchCiRun[]): Record<string, BranchCiRun> {
  const merged = { ...held };
  for (const run of read) {
    const before = held[run.id];
    const unread = before !== undefined && before.status === "completed" && run.jobs.length === 0;
    merged[run.id] = unread ? { ...before, status: run.status } : run;
  }
  return merged;
}

/** Record `read` as the ticket's runs, merged with what is held, at `now`. Written even when nothing changed but the time: callers compare before they update. PURE. */
export function recordRuns(queue: Queue, key: string, read: readonly BranchCiRun[], now: number): Queue {
  const held = queue.ciSpend?.[key];
  const next: TicketCi = { ...held, runs: mergedRuns(held?.runs ?? {}, read), readAt: now };
  return { ...queue, ciSpend: withoutOldGone(queue, { ...queue.ciSpend, [key]: next }) };
}

/** Record that the ticket was warned at `weighted` minutes, or held at `multiple` times its budget (with the warning, if it had none). PURE. */
export function recordBudgetStep(queue: Queue, key: string, step: Readonly<{ warned: number; held?: number }>): Queue {
  const held = queue.ciSpend?.[key];
  if (held === undefined) return queue;
  return { ...queue, ciSpend: { ...queue.ciSpend, [key]: { ...held, warned: held.warned ?? step.warned, ...(step.held === undefined ? {} : { held: step.held }) } } };
}

/** The records with those of tickets no longer on the queue cut to the {@link GONE_TICKETS_MAX} read most recently. PURE. */
function withoutOldGone(queue: Queue, records: Readonly<Record<string, TicketCi>>): Readonly<Record<string, TicketCi>> {
  const onQueue = new Set(queue.entries.map((entry) => entry.ticket.key));
  const gone = Object.keys(records).filter((key) => !onQueue.has(key));
  if (gone.length <= GONE_TICKETS_MAX) return records;
  const dropped = new Set(gone.map((key, order) => ({ key, order })).sort((a, b) => records[b.key]!.readAt - records[a.key]!.readAt || b.order - a.order).slice(GONE_TICKETS_MAX).map(({ key }) => key));
  return Object.fromEntries(Object.entries(records).filter(([key]) => !dropped.has(key)));
}
