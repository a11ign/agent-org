// @ts-check
// module: when a queued run began to wait on the ticket it waits on (A11-298) -- the record `longWaits` reads. PURE.
import { waitTarget } from "../board-view/long-waits.ts";
import type { Queue } from "./queue-entries-and-outcomes.ts";

/**
 * The queue with each queued run's `waitSince` as of `now`: a run that waits on a ticket keeps the time it began to wait on that one, a run that now waits on another ticket begins again, and a run that waits on
 * nothing, or is not queued, has none. The same queue, not a copy, when nothing changed, so a pass that finds the same waits writes nothing. PURE.
 */
export function recordWaits(queue: Queue, now: number): Queue {
  let changed = false;
  const entries = queue.entries.map((entry) => {
    const on = waitTarget(entry, queue.entries)?.key;
    if (on === entry.waitSince?.on) return entry;
    changed = true;
    const { waitSince: _ended, ...rest } = entry;
    return on === undefined ? rest : { ...rest, waitSince: { on, since: now } };
  });
  return changed ? { ...queue, entries } : queue;
}
