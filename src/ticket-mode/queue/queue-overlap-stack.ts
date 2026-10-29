// @ts-check
// module: the queue's records for a run that overlaps another (A11-374) -- the run it is stacked on, the Region of its ticket and the branch a run has pushed -- PURE
//
// OVERLAP MEANS STACK, NOT WAIT. `nextStarts` decides which run a queued run is stacked on (`overlapStackOf`) from what the queue holds alone, and these transitions keep what that decision reads: the paths its ticket's Region names (a queued
// run with no plan and no pull request claims them), the commit a live run's branch is at once it pushed it (the branch a queued run builds on while that run has no pull request), and the stack itself, which is recorded as the run starts
// and goes once the run below it is done.
import { ENDED_TICKETS } from "../board-view/overlap-hold.ts";
import type { OverlapStackRecord } from "../board-view/overlap-stack.ts";
import { pullsOf } from "../board-view/view-types-and-filters.ts";
import { replace, type Entry, type Queue } from "./queue-entries-and-outcomes.ts";

/** The same lists, by their words: a list is no change when it names the same paths in the same order. */
export const sameList = (a: readonly string[] | undefined, b: readonly string[]): boolean => a !== undefined && a.length === b.length && a.every((path, at) => path === b[at]);

/** Record the paths ticket `key`'s Region names (`regionClaimsOf`). Nothing is written when the run holds them already. PURE. */
export function recordRegionPaths(queue: Queue, key: string, paths: readonly string[]): Queue {
  return replace(queue, key, (entry) => (sameList(entry.regionPaths, paths) ? entry : { ...entry, regionPaths: paths }));
}

/** Record the commit each live run's own branch is at on the remote of its repository, by ticket key (A11-374), for the runs given. A run that is no longer live keeps what it has. PURE. */
export function recordPushedHeads(queue: Queue, pushed: ReadonlyMap<string, Readonly<{ repo: string; head: string }>>): Queue {
  return { ...queue, entries: queue.entries.map((entry) => {
    const found = pushed.get(entry.ticket.key);
    return found === undefined || (entry.pushed?.repo === found.repo && entry.pushed.head === found.head) ? entry : { ...entry, pushed: found };
  }) };
}

/** Record the run `key` is stacked on because their files overlap, before its worker is prepared: its brief reads it (`stackedOn`). PURE. */
export function recordOverlapStack(queue: Queue, key: string, stack: OverlapStackRecord): Queue {
  return replace(queue, key, (entry) => ({ ...entry, overlapStack: stack }));
}

/**
 * Whether the work the run below is stacked on is over: its ticket has ended, every pull request it has is merged or closed (and it has one), or its run is gone from the queue. PURE.
 */
function isSettled(stack: OverlapStackRecord, below: Entry | undefined): boolean {
  if (below === undefined || ENDED_TICKETS.has(below.trackerState ?? "")) return true;
  const pulls = pullsOf(below);
  return pulls.length > 0 && pulls.every(({ url }) => below.pullStates?.[url] === "merged" || below.pullStates?.[url] === "closed");
}

/**
 * The queue with the overlap stacks cleared of the queued runs whose base's work is over ({@link isSettled}): such a run is decided again from what it overlaps now. A run that has started keeps its stack, as it keeps its listed blockers, since the restack (A11-248)
 * finds the branch it was stacked on by it, and reads the base's pull requests for whether they have merged (`stackBlockersOf`). The queue itself when none is cleared. PURE.
 */
export function dropSettledOverlapStacks(queue: Queue): Queue {
  const settled = queue.entries.filter((entry) => entry.phase === "queued" && entry.overlapStack !== undefined && isSettled(entry.overlapStack, queue.entries.find((each) => each.ticket.key === entry.overlapStack?.key)));
  if (settled.length === 0) return queue;
  return { ...queue, entries: queue.entries.map((entry) => (settled.includes(entry) ? withoutStack(entry) : entry)) };
}

/** The run without its overlap stack. */
const withoutStack = ({ overlapStack: _settled, ...entry }: Entry): Entry => entry;
