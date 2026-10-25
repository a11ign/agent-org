// @ts-check
// module: closing a member of a stack that holds nothing of its own once the member below it merged and the default branch was merged into it (A11-248) -- the sweep's side of `stack-restack.ts`'s `emptyMember`
//
// IT RUNS FROM `restackMember` (`pool-tracker.ts`), on a sweep after the one that restacked the member, so the read of its files is never the one made in the same pass as the merge. `retargetStacked` stays the one writer of a finished run's per-URL
// notes: this returns the note and the caller records it. The close is the code host's optional `closePull` (contract 1.23), as the workers' account; a host without it gets a note that says the member is to be closed.
import type { StackMergeFacts } from "../plugins/contracts/code-host.ts";
import type { PoolContext } from "./pool-context.ts";
import { log, messageOf } from "./pool-state.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
import { closeComment, closeNote, emptyMember, holdsOwnFile, isEmptyMemberNote, isRestackedNote, restackNote, type CloseOutcome, type RestackBelow, type RestackDone } from "./stack-restack.ts";

/** The feedback is read for its files and its head, which no account's own words change, so it names no account as the board's own. */
const NO_ACCOUNT = "";

export type CloseInput = Readonly<{ url: string; below: RestackBelow; done: RestackDone; read: Pick<StackMergeFacts, "base" | "defaultBranch" | "head" | "settled">; previousNote: string | undefined }>;

/**
 * What the board says of an open member it brought up to date on an earlier sweep, once it has read the member's files: that it was closed, that closing it failed (and is tried again), or that this code host cannot close it. A member with a file of its own is
 * remembered by head, so it is not read again at that head, and a member the board had said was empty that now holds a file of its own is back to "restacked". Null: nothing is decided, so its note stands. A member whose restack conflicted or was refused is never
 * looked at, nor one that is queued to merge, merged, or not based on the default branch. NEVER THROWS: a close the code host refuses is a note.
 */
export function closeEmptyMember(ctx: PoolContext, entry: Entry, { url, below, done, previousNote, read }: CloseInput): string | null {
  const { codeHost } = ctx;
  if (!isCandidate(previousNote) || !isOpenOnDefaultBranch(read) || done.ownChangesAt === read.head) return null;
  const feedback = codeHost.readPullFeedback(url, NO_ACCOUNT);
  if (feedback === null || feedback.state !== "open") return null;
  if (holdsOwnFile(feedback.files)) {
    rememberOwnChanges(ctx, url, done, feedback.head);
    return wasSaidEmpty(previousNote) ? restackNote({ url, defaultBranch: read.defaultBranch, below, outcome: { kind: "updated" } }) : null;
  }
  if (!emptyMember({ files: feedback.files, filesComplete: feedback.filesComplete, head: feedback.head, done })) return null;
  const note = closeNote({ url, below, outcome: closeOutcome(ctx, url, below) });
  if (note !== previousNote) log(`${entry.ticket.key}: ${note}`);
  return note;
}

/** Whether the member is neither queued to merge nor merged, and is based on the default branch, which is where a restacked member is. */
const isOpenOnDefaultBranch = ({ settled, base, defaultBranch }: Pick<StackMergeFacts, "base" | "defaultBranch" | "settled">): boolean => settled === null && base === defaultBranch;

/** Remembers the head at which a file of the member's own was read, so the member is not read again at it. A head the code host does not say is not remembered. */
function rememberOwnChanges(ctx: PoolContext, url: string, done: RestackDone, head: string | null): void {
  if (head !== null) ctx.restacked.set(url, { ...done, ownChangesAt: head });
}

/** Whether the member's note says it holds nothing of its own and is not closed yet. */
const wasSaidEmpty = (note: string | undefined): boolean => note !== undefined && isEmptyMemberNote(note);

/** Whether the note a member has is one the board has reason to look at its files for: it was restacked, or it is empty and not closed yet. */
const isCandidate = (note: string | undefined): boolean => note !== undefined && (isRestackedNote(note) || isEmptyMemberNote(note));

/** Closes the member with the board's comment, if the code host can, and says what came of it. */
function closeOutcome(ctx: PoolContext, url: string, below: RestackBelow): CloseOutcome {
  const { closePull } = ctx.codeHost;
  if (closePull === undefined) return { kind: "unsupported" };
  try {
    closePull.call(ctx.codeHost, url, closeComment(url, below));
    return { kind: "closed" };
  } catch (err) {
    return { kind: "refused", reason: messageOf(err) };
  }
}
