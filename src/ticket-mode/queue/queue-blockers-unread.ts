// @ts-check
// module: why a queued run's blockers could not be read (A11-359) -- the hold that lets the runs beside it start

import type { Queue } from "./queue-entries-and-outcomes.ts";

/**
 * Record why the tracker could not say which tickets block each queued run (A11-359), so the board says why it waits. Only a run whose blockers have never been read is held by it: one that has a read keeps it as the last
 * good one and stays as it was, and is asked again with the next refresh.
 */
export function recordBlockersFailure(queue: Queue, failures: ReadonlyMap<string, string>): Queue {
  return { ...queue, entries: queue.entries.map((entry) => {
    const reason = failures.get(entry.ticket.key);
    return entry.phase === "queued" && entry.blockers === undefined && reason !== undefined ? { ...entry, blockersFailure: reason } : entry;
  }) };
}
