// @ts-check
// module: the note an approved pull request that nothing merges leaves on its run (A11-291)
//
// AN APPROVED, GREEN PULL REQUEST THAT SITS OUT OF THE MERGE QUEUE FOR AN HOUR, OR THAT INSTALLS A REPOSITORY'S FIRST MERGE FLOW, NEEDS A PERSON. The pool's watch works out the note (`board-view/not-merging.ts`, `mergeNote`) and lands it here as the run's
// `mergeNote`, which `runStatus` reads as Needs you and the card's reason line shows. It is a NOTE and not a hand-back (`handedBack`): the run's work is unchanged, so the board still watches its pull request, answers feedback on it and offers
// Approve and Publish, as it does for a reviewer herdr refused (A11-241, `queue-reviewer-refusal.ts`).
import { find, replace, type Queue } from "./queue-entries-and-outcomes.ts";
import { logEvent, shortReason } from "./run-log.ts";
import { WAITS_ON_REVIEW, workStatus } from "../board-view/pull-status-and-notes.ts";

/**
 * The board's note on a finished run whose pull request is approved and green and that nothing merges: it becomes the run's `mergeNote`, which reads Needs you, and a null note (the pull request is queued, merged, moved on or no longer ready) clears it,
 * whatever phase the run is in. It is written only over a run that waits on a review or a merge, as the reviewer's refusal is: one that reads Needs you for its own reason, one that failed or concluded, and one that is over keep their own words.
 * Needs you is logged once, for a note that is new. PURE.
 */
export function recordMergeNote(queue: Queue, key: string, note: string | null, now?: number): Queue {
  const before = find(queue, key);
  if (before === undefined) return queue;
  // Taken off whatever the run is doing: a run in a round when its note went away would otherwise read Needs you again when it finishes.
  if (note === null) return before.mergeNote === undefined ? queue : replace(queue, key, ({ mergeNote: _cleared, ...rest }) => rest);
  if (before.phase !== "finished" || before.mergeNote === note || !WAITS_ON_REVIEW.has(workStatus(before))) return queue;
  return logEvent(replace(queue, key, (entry) => ({ ...entry, mergeNote: note })), key, now, { kind: "needs-you", reason: shortReason(note) ?? note });
}
