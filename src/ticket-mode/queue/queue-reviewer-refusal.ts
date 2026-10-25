// @ts-check
// module: the note herdr's repeated refusal to start a reviewer leaves on its run (A11-241)
//
// A START HERDR REFUSES IS TRIED AGAIN ON EVERY SWEEP, SO A REFUSAL THAT NEVER GOES AWAY WOULD LOOP WITHOUT ANYONE BEING ASKED. The pool counts herdr's refusals per `url@head` (`ReviewerMemory.refusals`); the
// second one for the same reason lands here as the run's `reviewerRefused`, which `runStatus` reads as Needs you and the card's reason line shows.
import { NOTEABLE } from "./queue-pull-heads.ts";
import { find, replace, type Queue } from "./queue-entries-and-outcomes.ts";
import { logEvent, shortReason } from "./run-log.ts";
import { runStatus } from "../board-view/pull-status-and-notes.ts";

/**
 * The board's note on a finished run whose pull request's reviewer herdr refused to start twice for the same reason: it becomes the run's `reviewerRefused`, which reads Needs you, and a null note (herdr started
 * it, or the head moved) clears it, whatever phase the run is in. It is written only over a run that waits on a review or a merge, as the reviewer's dialog note is: one that reads Needs you for its own reason, one that failed or concluded, and one
 * that is over keep their own words. Needs you is logged once, for a note that is new. PURE.
 */
export function recordReviewerRefusal(queue: Queue, key: string, note: string | null, now?: number): Queue {
  const before = find(queue, key);
  if (before === undefined) return queue;
  // Taken off whatever the run is doing: a run in a round when its refusal went away would otherwise read Needs you again when it finishes.
  if (note === null) return before.reviewerRefused === undefined ? queue : replace(queue, key, ({ reviewerRefused: _cleared, ...rest }) => rest);
  const { reviewerRefused: _own, ...without } = before;
  if (before.phase !== "finished" || before.reviewerRefused === note || !NOTEABLE.has(runStatus(without))) return queue;
  return logEvent(replace(queue, key, (entry) => ({ ...entry, reviewerRefused: note })), key, now, { kind: "needs-you", reason: shortReason(note) ?? note });
}
