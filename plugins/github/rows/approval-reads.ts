// a11ign#5038: what the merge guard's approval rule reads off a pull request -- its reviews, and the commits since each approval -- through an injected
// `run` (`gh`, as the caller hands it in). This file names no `gh` and spawns nothing: `index.test.ts` holds this folder to that, and the
// spawn stays with whoever owns the runner.
import type { ApprovalFacts, ApprovalReview as Review, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";

/** The state each reviewer's NEWEST opinionated review leaves them in: only APPROVED survives as an approval. */
export function latestApprovals(reviews: Review[]): Review[] {
  const opinions = reviews
    .filter((r) => ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state))
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  const latest = new Map<string, Review>();
  for (const review of opinions) latest.set(review.reviewer, review);
  return [...latest.values()].filter((r) => r.state === "APPROVED");
}


/**
 * WHAT `approvalHeadReasons` NEEDS for pull request `number` of `repo`, or `null` for "could not ask": a refused `run` or an answer that does not
 * parse. `null` is never "covered", and never "no approvals".
 */
export function approvalFactsOf(
  { repo, number, head }: { repo: string; number: number; head: string; }, run: RowsRun,
): ApprovalFacts | null {
  try {
    const lines = (out: string) => out.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const reviews: Review[] = lines(run(["api", `repos/${repo}/pulls/${number}/reviews`, "--paginate", "--jq",
      ".[] | {reviewer: .user.login, state, commitId: .commit_id, submittedAt: .submitted_at}"]));
    const commitsOf = (range: string) => lines(run(["api", `repos/${repo}/compare/${range}`, "--paginate",
      "--jq", "{status, commits: [.commits[] | {sha, parents: [.parents[].sha]}]}"]));
    const ownShas = commitsOf(`main...${head}`).flatMap((page) => page.commits.map((c: { sha: string; }) => c.sha));
    const approvals = latestApprovals(reviews).map((review) => {
      const pages = commitsOf(`${review.commitId}...${head}`);
      const ancestor = ["ahead", "identical"].includes(pages[0]?.status);
      return { reviewer: review.reviewer, commitId: review.commitId,
        sinceApproval: ancestor ? pages.flatMap((page) => page.commits) : null };
    });
    return { ownShas, approvals };
  } catch (error) {
    void error; // an unread review list is "cannot say", which the gate reports as CANNOT_ASK
    return null;
  }
}
