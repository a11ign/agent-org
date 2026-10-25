// @ts-check
// module: the note a reviewer stopped on a dialog leaves on its run (A11-221)
//
// THE STALE-BLOCK NOTE'S RULES (A11-213), FOR A REVIEWER THAT WAITS ON A PERSON: the note is the run's `handedBack`, which reads Needs you.
import { isReviewerDialogNote } from "../board-view/reviewer-dialog-note.ts";
import { type Queue } from "./queue-entries-and-outcomes.ts";
import { recordHandedBackNote } from "./queue-pull-heads.ts";

/**
 * The board's note on a finished run whose pull request has a reviewer stopped on a dialog it cannot answer (`reviewerDialogNote`): it becomes the run's `handedBack`, which reads Needs you, and a null note (the next look
 * found no dialog) clears a `handedBack` this wrote, recognised by its sentence form. It never replaces another `handedBack`, and it is written only over a run that waits on a review or a merge: one that reads Needs you for
 * its own reason, one that failed or concluded, and one that is over keep their own words. PURE.
 */
export const recordReviewerDialog = (queue: Queue, key: string, note: string | null, now?: number): Queue => recordHandedBackNote(queue, key, note, isReviewerDialogNote, now);
