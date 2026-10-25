// @ts-check
// module: the heads of a finished run's pull requests, as the pool records them (A11-153), and the note a stale block leaves on the run (A11-213)
//
// WHAT A `needs-human` RUN'S PULL REQUEST WAS AT WHEN IT ENDED, AND WHAT IT IS AT NOW, IS HOW THE BOARD TELLS THAT ITS QUESTION WAS ANSWERED (`pull-answer.ts`).
import { WAITS_ON_REVIEW, workStatus } from "../board-view/pull-status-and-notes.ts";
import { isStaleBlockNote } from "../board-view/stale-block.ts";
import type { PullHead } from "../board-view/view-types-and-filters.ts";
import { find, replace, type Queue } from "./queue-entries-and-outcomes.ts";
import { logEvent, logOf, shortReason, type RunEvent } from "./run-log.ts";

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
export function recordPullHeads(queue: Queue, key: string, heads: Readonly<Record<string, PullHead>>, now?: number): Queue {
  const recorded = replace(queue, key, (entry) => (entry.phase === "finished" ? { ...entry, pullHeads: heads } : entry));
  if (find(queue, key)?.phase !== "finished") return recorded;
  // A verdict is logged when a pull request's head or its review differs from the last one logged for it (A11-219): the watch reads the same heads on every pass.
  return Object.entries(heads).reduce<Queue>((next, [url, { head, review }]) => {
    const verdict = review === "approved" || review === "changes-requested" ? review : null;
    return verdict === null || sameVerdict(lastVerdict(next, key, url), head, verdict) ? next : logEvent(next, key, now, { kind: "verdict", url, head, review: verdict });
  }, recorded);
}

/** The newest verdict logged for pull request `url` of ticket `key`, or undefined when none was. */
const lastVerdict = (queue: Queue, key: string, url: string): Extract<RunEvent, { kind: "verdict" }> | undefined =>
  logOf(queue, key).findLast((event): event is Extract<RunEvent, { kind: "verdict" }> => event.kind === "verdict" && event.url === url);

const sameVerdict = (last: Extract<RunEvent, { kind: "verdict" }> | undefined, head: string, review: string): boolean => last?.head === head && last.review === review;

/**
 * The board's note on a finished run whose pull request has sat changes requested with no new push and no run (A11-213, {@link staleBlockNote}): it becomes the run's `handedBack`, which reads Needs you and which
 * Respond to review acts on, and a null note (a push, an approval, a round) clears a `handedBack` this wrote, recognised by its sentence form as a conflict's is. It never replaces another `handedBack`, and it
 * is written only over a run that waits on a review or a merge ({@link WAITS_ON_REVIEW}): one that reads Needs you for its own reason (a disputed review the worker handed back), one that failed or concluded, and one that is over keep their own words. PURE.
 */
export const recordStaleBlock = (queue: Queue, key: string, note: string | null, now?: number): Queue => recordHandedBackNote(queue, key, note, isStaleBlockNote, now);

/**
 * A board note written as a finished run's `handedBack` and recognised by its sentence form (`isOwn`): a null note clears a `handedBack` that is this note and no other, and a note is written only over a run that waits on a
 * review or a merge ({@link WAITS_ON_REVIEW}) and has no `handedBack` of another kind. Needs you is logged once, for the note that is new (A11-219). PURE.
 */
export function recordHandedBackNote(queue: Queue, key: string, note: string | null, isOwn: (text: string | undefined) => boolean, now?: number): Queue {
  const noted = withNote(queue, key, note, isOwn);
  return note !== null && find(noted, key)?.handedBack === note && find(queue, key)?.handedBack !== note ? logEvent(noted, key, now, { kind: "needs-you", reason: shortReason(note) ?? note }) : noted;
}

/** The queue with the `note` written over the run, or cleared by `null`: see {@link recordHandedBackNote}. PURE. */
function withNote(queue: Queue, key: string, note: string | null, isOwn: (text: string | undefined) => boolean): Queue {
  return replace(queue, key, (entry) => {
    if (entry.phase !== "finished") return entry;
    if (note === null) {
      const { handedBack: _cleared, ...rest } = entry;
      return isOwn(entry.handedBack) ? rest : entry;
    }
    const other = entry.handedBack !== undefined && !isOwn(entry.handedBack);
    const { handedBack: _own, ...without } = entry;
    if (other || !WAITS_ON_REVIEW.has(workStatus(without))) return entry;
    return { ...entry, handedBack: note };
  });
}
