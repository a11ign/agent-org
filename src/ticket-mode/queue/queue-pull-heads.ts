// @ts-check
// module: the heads of a finished run's pull requests, as the pool records them (A11-153), and the note a stale block leaves on the run (A11-213)
//
// WHAT A `needs-human` RUN'S PULL REQUEST WAS AT WHEN IT ENDED, AND WHAT IT IS AT NOW, IS HOW THE BOARD TELLS THAT ITS QUESTION WAS ANSWERED (`pull-answer.ts`).
import { runStatus } from "../board-view/pull-status-and-notes.ts";
import { isStaleBlockNote } from "../board-view/stale-block.ts";
import type { PullHead } from "../board-view/view-types-and-filters.ts";
import { replace, type Queue } from "./queue-entries-and-outcomes.ts";

/** Record the commit each open pull request of a finished run was at when it ended, by URL (A11-153). Kept on top of what is there, so a URL not read keeps its head. */
export function recordOutcomeHeads(queue: Queue, key: string, heads: Readonly<Record<string, string>>): Queue {
  return replace(queue, key, (entry) => (entry.phase === "finished" ? { ...entry, outcomeHeads: { ...entry.outcomeHeads, ...heads } } : entry));
}

/**
 * Agent-org pushed a merge to a finished run's branch, moving it from `from` to `to`: each outcome head at `from` moves with it. That push is not a person's
 * answer, so it must not read as one (A11-153). An outcome head at another commit was already moved on by someone else, and stays. PURE.
 */
export function moveOutcomeHeads(queue: Queue, key: string, from: string, to: string): Queue {
  return replace(queue, key, (entry) => {
    if (entry.outcomeHeads === undefined) return entry;
    return { ...entry, outcomeHeads: Object.fromEntries(Object.entries(entry.outcomeHeads).map(([url, head]) => [url, head === from ? to : head])) };
  });
}

/** Record each open pull request's head now and whether it is approved there, by URL, as the watch read them (A11-153). */
export function recordPullHeads(queue: Queue, key: string, heads: Readonly<Record<string, PullHead>>): Queue {
  return replace(queue, key, (entry) => (entry.phase === "finished" ? { ...entry, pullHeads: heads } : entry));
}

/** The statuses that already ask a person, or need none: a stale-block note is not written over them (A11-213). */
const NEEDS_NO_NOTE: ReadonlySet<string> = new Set(["needs-you", "completed", "cancelled"]);

/**
 * The board's note on a finished run whose pull request has sat changes requested with no new push and no run (A11-213, {@link staleBlockNote}): it becomes the run's `handedBack`, which reads Needs you and which
 * Respond to review acts on, and a null note (a push, an approval, a round) clears a `handedBack` this wrote, recognised by its sentence form as a conflict's is. It never replaces another `handedBack`, and it
 * is not written over a run that already reads Needs you for its own reason (a disputed review the worker handed back, say) or that is over, since the worker's words are the better reason. PURE.
 */
export function recordStaleBlock(queue: Queue, key: string, note: string | null): Queue {
  return replace(queue, key, (entry) => {
    if (entry.phase !== "finished") return entry;
    if (note === null) {
      const { handedBack: _cleared, ...rest } = entry;
      return isStaleBlockNote(entry.handedBack) ? rest : entry;
    }
    const other = entry.handedBack !== undefined && !isStaleBlockNote(entry.handedBack);
    const { handedBack: _own, ...without } = entry;
    if (other || NEEDS_NO_NOTE.has(runStatus(without))) return entry;
    return { ...entry, handedBack: note };
  });
}
