// @ts-check
// module: what the board recorded of a finished run's pull requests removed from the merge queue (A11-264)
import type { QueueHead } from "../board-view/queue-head.ts";
import { replace, type Queue } from "./queue-entries-and-outcomes.ts";

/**
 * Record what the board did about the merge queue's removals of a finished run's pull requests (`heads`, by URL, the whole record as the entry should hold it): written when no round is queued for it, and before the round that is, while the run is still
 * finished. Kept with the run through a review round (`carriedFields`), so the removal a round answers is not answered again by the watch that finds the round's push has not landed yet. PURE.
 */
export function recordQueueHeads(queue: Queue, key: string, heads: Readonly<Record<string, QueueHead>>): Queue {
  return replace(queue, key, (entry) => (entry.phase === "finished" ? { ...entry, queueHeads: heads } : entry));
}
