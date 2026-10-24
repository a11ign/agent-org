// @ts-check
// module: a reviewer stopped on a dialog nobody answers (PURE) -- the note the board shows when a pull request's reviewer waits on a dialog the board cannot answer (A11-221)
//
// A REVIEWER THAT HERDR SHOWS BLOCKED, ON A DIALOG THE BOARD MAY NOT ANSWER, IS WAITING ON A PERSON, AND NOTHING ELSE SAYS SO. The pool reads the dialog's first line into the pull request's `PullRead` (`dialog`), and the run that holds
// the pull request gets this note as its `handedBack`, as a stale block does (A11-213), so the board reads Needs you with the dialog's first line in its reason. The reviewer's workspace is left open: a person answers the dialog in herdr, and the
// note goes at the next look that finds none.
import { pullLabel } from "./pull-label.ts";
import type { PullRead } from "./pull-review-state.ts";
import { openPulls, type ViewEntry } from "./view-types-and-filters.ts";

/** How a reviewer-dialog note reads once written: the board recognises its own `handedBack` by this form, as it does a stale block's, and clears no other. */
export const REVIEWER_DIALOG_LINE = /the reviewer of .+ stopped on a dialog it cannot answer: ".*": a person answers it in herdr/;

/** Whether `text` is a reviewer-dialog note the board wrote. PURE. */
export const isReviewerDialogNote = (text: string | undefined): boolean => text !== undefined && REVIEWER_DIALOG_LINE.test(text);

/**
 * The note for a run whose open pull requests have a reviewer stopped on a dialog the board cannot answer: one sentence for each such pull request naming it and the dialog's first line, or null when none has. PURE.
 * `reads` is what the pool read of each pull request (`pullReads`); a pull request it has no read of has no dialog as far as anyone knows.
 */
export function reviewerDialogNote(entry: ViewEntry, reads: ReadonlyMap<string, PullRead>): string | null {
  const stopped = openPulls(entry).flatMap(({ url }) => {
    const dialog = reads.get(url)?.dialog;
    return dialog === undefined ? [] : [`the reviewer of ${pullLabel(url)} stopped on a dialog it cannot answer: "${dialog}": a person answers it in herdr`];
  });
  return stopped.length === 0 ? null : stopped.join("; ");
}
