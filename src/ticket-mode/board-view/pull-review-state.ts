// @ts-check
// module: a pull request's review state, as the board words it -- what the pool read about its reviewer at its current head (PURE)
//
// THE WORDS ARE THE BOARD'S ONE PICTURE OF A PULL REQUEST'S REVIEW (A11-119). The pool reads each open pull request on the server's sweep and keeps what
// it read as a `PullRead`; this turns that into the line the run row and the "Pull requests" section show. It imports nothing: the pool calls it, and the
// page only prints the text it returns.

/** A verdict word the reviewer's reviews carry: its approval, its requested changes, or a review a person dismissed. */
export type ReviewWord = "approved" | "changes requested" | "dismissed";

/**
 * What the pool read about one open pull request at its current head: the head, whether its checks have settled green, whether a reviewer is live for
 * that head, the verdict the reviewer posted on that head, the newest verdict on an earlier head, why the last start was refused (null when it was not), and
 * the verdict that is not on the pull request, as the pool says it (null when none), and the expired claim this instance took over on this head, as the pool
 * says it (absent when it took none, A11-149).
 */
export type PullRead = Readonly<{
  head: string;
  settled: boolean;
  reviewing: boolean;
  verdict: ReviewWord | null;
  earlier: Readonly<{ head: string; word: ReviewWord }> | null;
  refusal: string | null;
  unposted: string | null;
  tookOver?: string;
}>;

/** The first eight characters of a commit, as the board shows one. */
export const shortHead = (head: string): string => head.slice(0, 8);

/**
 * The line a pull request's review state reads as. `null` read is a pull request whose state could not be read. In order: a reviewer live for the head is
 * `reviewing`, and says the claim it took over, if it took one; a verdict on the head is its word; a newest `changes requested` on an earlier head says the
 * new head is not reviewed yet; checks not settled say so; a refused start says why; otherwise the head is awaiting review.
 */
export function pullReviewText(read: PullRead | null): string {
  if (read === null) return "review state not read";
  if (read.reviewing) return read.tookOver === undefined ? "reviewing" : `reviewing (${read.tookOver})`;
  if (read.verdict !== null) return read.verdict === "changes requested" ? `changes requested at ${shortHead(read.head)}` : `${read.verdict} at ${shortHead(read.head)}`;
  if (read.earlier?.word === "changes requested") return `changes requested at ${shortHead(read.earlier.head)}, new head ${shortHead(read.head)} not yet reviewed`;
  if (!read.settled) return `waiting for checks at ${shortHead(read.head)}`;
  if (read.refusal !== null) return `not reviewed: ${read.refusal}`;
  return `awaiting review at ${shortHead(read.head)}`;
}
