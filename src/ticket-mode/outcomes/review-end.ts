// @ts-check
// module: what a review adds to a run's outcome record (A11-430) -- the review, its verdict and the reviewer's tokens, once per review the reviewer posted
//
// A RUN'S RECORD IS WRITTEN AS EACH OF ITS ROUNDS ENDS (`round-end.ts`), and a reviewer reviews between rounds, often after the last one: the approval that ends a run's work comes after
// the round that pushed. So a review is added to the run when the board sees its verdict, and the run's whole record is appended again with it, the latest line being the record.

import { type Entry, type Queue, replace } from "../queue/queue-entries-and-outcomes.ts";
import { type OutcomeRecord, outcomeRecordOf, type OutcomeReview, type OutcomeRun } from "./outcome-record.ts";
import { outcomeSubjectOf } from "./round-end.ts";
import { roundTokens, type TranscriptRead } from "./round-tokens.ts";

/** The review the board saw: the pull request and head, its verdict and when GitHub says it was posted. */
export type SeenReview = Readonly<{ pr: string; head: string; verdict: string; posted: number }>;

/** Whether `run` already holds the review `seen` names: the same pull request, head and posting time. PURE. */
export const holdsReview = (run: OutcomeRun, { pr, head, posted }: SeenReview): boolean =>
  (run.reviews ?? []).some((review) => review.pr === pr && review.head === head && review.posted === posted);

/** Where the reviewer's turns for the next review of `pr` begin: when the run's latest review of it was recorded, else when the run began. PURE. */
export const reviewTurnsAfter = (run: OutcomeRun, pr: string): number => (run.reviews ?? []).filter((review) => review.pr === pr).at(-1)?.at ?? run.since;

/**
 * `entry`'s run with the review `seen` added, and its outcome record as it stands after it, or null when the run has no record yet (no round of it has ended) or holds this review already.
 * The review's tokens are the reviewer's turns `read` holds after {@link reviewTurnsAfter}. PURE.
 */
export function reviewEndOf(entry: Entry, seen: SeenReview, read: TranscriptRead, now: number): Readonly<{ outcomeRun: OutcomeRun; record: OutcomeRecord }> | null {
  const run = entry.outcomeRun;
  if (run === undefined || holdsReview(run, seen)) return null;
  // Counted from the run as it is now, not as it was when the sessions were read: a review of the same pull request recorded meanwhile owns the turns before it.
  const spent = "turns" in read ? { tokens: roundTokens(read.turns, reviewTurnsAfter(run, seen.pr)) } : { unread: read.unreadable };
  const review: OutcomeReview = { ...seen, at: now, ...spent };
  const outcomeRun: OutcomeRun = { ...run, reviews: [...(run.reviews ?? []), review] };
  return { outcomeRun, record: outcomeRecordOf(outcomeSubjectOf(entry), outcomeRun) };
}

/** `queue` with `key`'s run as its outcome record now stands: a review of its pull request was added after its round ended. PURE. */
export const recordOutcomeRun = (queue: Queue, key: string, outcomeRun: OutcomeRun): Queue => replace(queue, key, (entry) => ({ ...entry, outcomeRun }));
