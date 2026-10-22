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
 * says it (absent when it took none, A11-149). `rereview` is set while a re-review of the head is under way, asked by a reply to the reviewer's block with no new commit (A11-156). `unclaimed` is set
 * when the head's claim could not be written (A11-172): its `reason` is GitHub's, and `started` is whether the reviewer runs anyway (this instance is the only one seen) or none was started.
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
  rereview?: boolean;
  unclaimed?: Readonly<{ reason: string; started: boolean }>;
}>;

/** What each open pull request's line says on a machine where reviews are required and the reviewer is off (A11-161). */
export const REVIEWER_OFF_LINE = "waiting on the reviewer (off)";

/** What each of a run's open pull requests says on a machine that is not required to have a reviewer and has none: people review there (A11-161). */
export const AWAITING_PERSON_LINE = "awaiting your review";

/** The banner the board shows while reviews are required and the reviewer is off (A11-161). */
export const REVIEWER_OFF_BANNER = "Reviews are required and the reviewer is off";

/**
 * The banner the board shows, or null: only a machine where reviews are required and the reviewer is off has one (`off-required`, A11-161). Where they are not required and there is none
 * (`none`), nothing extra is shown anywhere. `reviewer` is `/api/config`'s `reviewer` state, absent from an instance that does not send it.
 */
export function reviewerBanner(reviewer: string | undefined): string | null {
  return reviewer === "off-required" ? REVIEWER_OFF_BANNER : null;
}

/** What a run that is Ready to merge says when its machine's publisher is installed and disabled (A11-161). */
export const PUBLISHING_OFF_LINE = "publishing off";

/**
 * The one line a run says about publishing: "publishing off" for a run that is Ready to merge on a machine whose publisher is installed and disabled (`off`). A machine with no publisher (`none`)
 * shows nothing extra, and one whose publisher is on has its Publish controls instead. `publisher` is `/api/config`'s `publisher` state.
 */
export function publishingOffLine(status: string, publisher: string | undefined): string | null {
  return publisher === "off" && status === "ready-to-merge" ? PUBLISHING_OFF_LINE : null;
}

/** The first eight characters of a commit, as the board shows one. */
export const shortHead = (head: string): string => head.slice(0, 8);

/**
 * The line a pull request's review state reads as. `null` read is a pull request whose state could not be read. In order: a re-review a reply asked for is
 * `re-review asked by reply` at the head, until it posts or ends (A11-156); a reviewer live for the head is `reviewing`, and says the claim it took over, if it took one, or that it runs without a claim (A11-172);
 * a start refused because the claim could not be written says `cannot claim for review: <reason>`, ahead of a verdict, so a re-review that cannot be claimed is seen too; a verdict on the head is its word; a newest `changes requested` on an earlier head says the
 * new head is not reviewed yet; checks not settled say so; a refused start says why; otherwise the head is awaiting review.
 */
export function pullReviewText(read: PullRead | null): string {
  if (read === null) return "review state not read";
  if (read.rereview === true) {
    const note = read.unclaimed?.started === true ? `reviewing without a claim: ${read.unclaimed.reason}` : read.tookOver;
    return note === undefined ? `re-review asked by reply at ${shortHead(read.head)}` : `re-review asked by reply at ${shortHead(read.head)} (${note})`;
  }
  if (read.reviewing && read.unclaimed?.started === true) return `reviewing without a claim: ${read.unclaimed.reason}`;
  if (read.reviewing) return read.tookOver === undefined ? "reviewing" : `reviewing (${read.tookOver})`;
  if (read.unclaimed?.started === false) return `cannot claim for review: ${read.unclaimed.reason}`;
  if (read.verdict !== null) return read.verdict === "changes requested" ? `changes requested at ${shortHead(read.head)}` : `${read.verdict} at ${shortHead(read.head)}`;
  if (read.earlier?.word === "changes requested") return `changes requested at ${shortHead(read.earlier.head)}, new head ${shortHead(read.head)} not yet reviewed`;
  if (!read.settled) return `waiting for checks at ${shortHead(read.head)}`;
  if (read.refusal !== null) return `not reviewed: ${read.refusal}`;
  return `awaiting review at ${shortHead(read.head)}`;
}

/**
 * The one line the board shows above its runs while some pull request cannot be claimed for review, or runs without a claim (A11-172), or null while none does. It is one line however many pull requests
 * are affected: the reasons are named once each and the pull requests counted. It is derived from what the pool read, so it lasts exactly as long as some pull request is in that state.
 */
export function claimWarning(reads: Iterable<PullRead>): string | null {
  const refused = new Map<string, number>();
  const alone = new Map<string, number>();
  for (const { unclaimed } of reads) {
    if (unclaimed === undefined) continue;
    const into = unclaimed.started ? alone : refused;
    into.set(unclaimed.reason, (into.get(unclaimed.reason) ?? 0) + 1);
  }
  const said = (reasons: Map<string, number>) => `${[...reasons.keys()].join("; ")} (${plural([...reasons.values()].reduce((sum, n) => sum + n, 0), "pull request")})`;
  const parts = [
    ...(refused.size === 0 ? [] : [`Reviews cannot be claimed on GitHub: ${said(refused)}.`]),
    ...(alone.size === 0 ? [] : [`Reviews start without a claim on GitHub: ${said(alone)}; no other instance is seen.`]),
  ];
  return parts.length === 0 ? null : `${parts.join(" ")} Run agent-org doctor.`;
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;
