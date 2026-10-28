// @ts-check
// module: the queue's transitions for the reads a start is decided on (A11-364) -- which runs are due a read, and the failure of one

import { blockersStale, pathsUnread } from "./start-reads.ts";
import type { Entry, Queue } from "./queue-entries-and-outcomes.ts";

/** Record why the tracker could not say which tickets block each of `keys`, and when the board asks again (A11-364). The blockers a run already has are kept: the run is held by them only once they are too old to start on. */
export function recordBlockersFailure(queue: Queue, keys: readonly string[], error: string, retryAt: number): Queue {
  return { ...queue, entries: queue.entries.map((entry) => (entry.phase === "queued" && keys.includes(entry.ticket.key) ? { ...entry, blockersFailure: { error, retryAt } } : entry)) };
}

/** The keys of queued runs whose blockers are to be read now (A11-364): never read, or too old to start on, and not waiting out the retry after a failed read. PURE. */
export const dueBlockerKeys = (queue: Queue, now: number): string[] =>
  queue.entries.filter((entry) => entry.phase === "queued" && (entry.blockers === undefined || blockersStale(entry, now)) && (entry.blockersFailure?.retryAt ?? 0) <= now).map((entry) => entry.ticket.key);

/** The queued runs whose plan paths are to be read now (A11-364): never read, and not waiting out the retry after a failed read. PURE. */
export const duePaths = (queue: Queue, now: number): Entry[] => queue.entries.filter((entry) => pathsUnread(entry) && (entry.pathsRetryAt ?? 0) <= now);
