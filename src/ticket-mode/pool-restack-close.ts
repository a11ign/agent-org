// @ts-check
// module: closing a member of a stack that holds nothing of its own once the member below it merged and the default branch was merged into it (A11-248) -- the sweep's side of `stack-restack.ts`'s `emptyMember`
//
// IT RUNS FROM `restackMember` (`pool-tracker.ts`), on a sweep after the one that restacked the member, so the read of its files is never the one made in the same pass as the merge. `retargetStacked` stays the one writer of a finished run's per-URL
// notes: this returns the note and the caller records it. The close is the code host's optional `closePull` (contract 1.23), as the workers' account; a host without it gets a note that says the member is to be closed.
import { stackBlockersOf } from "./board-view/waits-on.ts";
import type { StackMergeFacts } from "../plugins/contracts/code-host.ts";
import type { PoolContext } from "./pool-context.ts";
import { settledByPulls } from "./board-view/pull-settled.ts";
import { askUpdate } from "./pool-checks.ts";
import { log, messageOf, update } from "./pool-state.ts";
import { moveOutcomeHeads } from "./queue/queue-pull-heads.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
import { closeComment, closeNote, emptyMember, holdsOwnFile, looksEmpty, isEmptyMemberNote, isRestackedNote, restackNote, type CloseOutcome, type RestackBelow, type RestackDone } from "./stack-restack.ts";

/** The feedback is read for its files and its head, which no account's own words change, so it names no account as the board's own. */
const NO_ACCOUNT = "";

export type CloseInput = Readonly<{ url: string; below: RestackBelow; done: RestackDone; read: Pick<StackMergeFacts, "base" | "defaultBranch" | "head" | "settled">; previousNote: string | undefined }>;

/**
 * What the board says of an open member it brought up to date on an earlier sweep, once it has read the member's files: that it was closed, that closing it failed (and is tried again), or that this code host cannot close it. A member with a file of its own is
 * remembered by head, so it is not read again at that head, and a member the board had said was empty that now holds a file of its own is back to "restacked". Null: nothing is decided, so its note stands. A member whose restack conflicted or was refused is never
 * looked at, nor one that is queued to merge, merged, or not based on the default branch, nor one another run is stacked on (closing it would leave that run's base dead). It is closed when a second read, on a later sweep, finds it empty at the same head. NEVER THROWS: a close the code host refuses is a note.
 */
export async function closeEmptyMember(ctx: PoolContext, entry: Entry, { url, below, done, previousNote, read }: CloseInput): Promise<string | null> {
  const { codeHost } = ctx;
  if (!isCandidate(previousNote) || !isOpenOnDefaultBranch(read) || done.ownChangesAt === read.head) return null;
  // The two reads this needs must be two reads: the code host shares one among a sweep's readers, and a sweep can follow the last one by less than that (A11-365).
  codeHost.refreshPull?.(url);
  const feedback = await codeHost.readPullFeedback(url, NO_ACCOUNT);
  if (feedback === null || feedback.state !== "open") return null;
  if (holdsOwnFile(feedback.files)) {
    remember(ctx, url, done, feedback.head, "ownChangesAt");
    return wasSaidEmpty(previousNote) ? restackNote({ url, defaultBranch: read.defaultBranch, below, outcome: { kind: "updated" } }) : null;
  }
  if (!feedback.filesComplete || feedback.head === null || hasMembersAbove(ctx, entry)) return null;
  if (restackHeadUnknown(done)) return confirmRestack(ctx, entry, { url, done, head: feedback.head });
  const observed = { files: feedback.files, filesComplete: feedback.filesComplete, head: feedback.head, done };
  if (!looksEmpty(observed)) return null;
  if (!emptyMember(observed)) {
    remember(ctx, url, done, feedback.head, "emptyAt");
    return null;
  }
  const note = closeNote({ url, below, outcome: closeOutcome(ctx, url, below) });
  if (note !== previousNote) log(`${entry.ticket.key}: ${note}`);
  return note;
}

/** Whether the head the restack was made at is not known (a restart lost it, and the note that says the member was restacked does not keep it), so no head read can be told from one that came before the restack. */
const restackHeadUnknown = (done: RestackDone): boolean => done.head === undefined && done.upToDate !== true;

/**
 * Asks the code host once whether the member's branch already has the default branch, which settles what a read of the head cannot: the answer is the host's own merge state, not a file list that may lag. Branch current (`up-to-date`): the head is
 * past the restack, and a later sweep reads the member's files. Merged in just now (`updated`): that is the restack, made at this head, and a later head is the one to read. Anything else (a conflict, a refusal) leaves the member as it was, for the watch and the next
 * sweep. Null: the note stands.
 */
function confirmRestack(ctx: PoolContext, entry: Entry, { url, done, head }: { url: string; done: RestackDone; head: string }): null {
  const result = askUpdate(ctx, url, head);
  if (result.kind === "up-to-date") ctx.restacked.set(url, { ...done, head, upToDate: true });
  if (result.kind === "updated") {
    ctx.restacked.set(url, { ...done, head });
    followHead(ctx, entry.ticket.key, url, head);
  }
  return null;
}

/** A merge pushed to a finished run's pull request moves its head: the head the run ended at moves with it, so the push is not read as a person's (A11-153). */
export function followHead(ctx: PoolContext, key: string, url: string, from: string): void {
  const to = ctx.codeHost.stackMergeFactsOf?.(url)?.head;
  if (to !== undefined && to !== from) update(ctx, (queue) => moveOutcomeHeads(queue, key, from, to));
}

/** Whether another run that is not settled is stacked on this run's branch: closing its pull request would strand that run on a base that never merges. */
const hasMembersAbove = (ctx: PoolContext, entry: Entry): boolean =>
  ctx.store.get().entries.some((other) => other.ticket.key !== entry.ticket.key && stackBlockersOf(other).some((blocker) => blocker.key === entry.ticket.key && blocker.branch) && settledByPulls(other) === null);

/** Whether the member is neither queued to merge nor merged, and is based on the default branch, which is where a restacked member is. */
const isOpenOnDefaultBranch = ({ settled, base, defaultBranch }: Pick<StackMergeFacts, "base" | "defaultBranch" | "settled">): boolean => settled === null && base === defaultBranch;

/** Remembers the head at which a read found a file of the member's own (`ownChangesAt`, so it is not read again at it) or none (`emptyAt`, which a second read must find again before the member is closed). A head the code host does not say is not remembered. */
function remember(ctx: PoolContext, url: string, done: RestackDone, head: string | null, what: "ownChangesAt" | "emptyAt"): void {
  if (head !== null) ctx.restacked.set(url, { ...done, [what]: head });
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
