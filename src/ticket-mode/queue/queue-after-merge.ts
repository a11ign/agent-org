// @ts-check
// module: the After-merge lines of a merged run's ticket, and when the board lists them (A11-173) -- PURE
import { runStatus } from "../board-view/pull-status-and-notes.ts";
import { settledByPulls } from "../board-view/pull-settled.ts";
import type { AfterMergeLine } from "../board-view/view-types-and-filters.ts";
import { afterMergeLines } from "../done-when.ts";
import { replace, type Entry, type Queue } from "./queue-entries-and-outcomes.ts";

/**
 * The finished runs whose After-merge lines the board lists and posts (A11-173), each with the lines: Completed, not declared partial, whose pull requests merged, whose
 * lines were not recorded yet, and whose ticket text has some. A run that ended on `done` with no pull request merged is not one: the worker verified every Done-when item. PURE.
 */
export function afterMergeDue(queue: Queue): { entry: Entry; lines: AfterMergeLine[] }[] {
  return queue.entries.flatMap((entry) => {
    const merged = entry.phase === "finished" && entry.partial === undefined && entry.afterMerge === undefined && runStatus(entry) === "completed" && settledByPulls(entry) === "completed";
    const lines = merged ? afterMergeLines(entry.ticket.description) : [];
    return lines.length === 0 ? [] : [{ entry, lines }];
  });
}

/** Record the After-merge lines the board listed for `key`'s run (A11-173): once recorded they are not posted again, and the board's list shows them until the run leaves. */
export const recordAfterMerge = (queue: Queue, key: string, afterMerge: readonly AfterMergeLine[]): Queue => replace(queue, key, (entry) => ({ ...entry, afterMerge }));

/** The runs whose listed After-merge lines are not posted as a comment on their ticket yet (A11-173). PURE. */
export const afterMergeUnposted = (queue: Queue): Entry[] => queue.entries.filter((entry) => entry.phase === "finished" && entry.afterMerge !== undefined && entry.afterMergePosted !== true);

/** Mark `key`'s After-merge comment posted, or about to be: a sweep that finds it marked leaves it, so it is never posted twice at once. */
export const markAfterMergePosted = (queue: Queue, key: string): Queue => replace(queue, key, (entry) => ({ ...entry, afterMergePosted: true }));

/** Mark `key`'s After-merge comment not posted, once the post failed, so the next sweep tries it again. */
export const markAfterMergeUnposted = (queue: Queue, key: string): Queue => replace(queue, key, ({ afterMergePosted: _failed, ...entry }) => entry);
