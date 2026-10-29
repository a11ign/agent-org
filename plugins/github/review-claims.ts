// module: the review claim -- a commit status on a pull request's head that says which instance is reviewing it (A11-149), read and written through GitHub (A11-160)
//
// Moved out of `ticket-port/review-claim.ts` (`claimEntriesOf`, `writeClaimStatus`). THE PROTOCOL STAYS CORE'S (`claimHead` over a `read` and a `write`, which decides who holds a head); the calls that back
// the two are here. A claim is a status under the context `agent-org/review`, which the verdict door writes the verdict over once the review posts: ONE SPELLING WITH `reviewer/pr-review-verdict.sh`
// (`CLAIM_CONTEXT`), which `review-claims.test.ts` holds to this file.
import type { ReviewClaimRead, ReviewClaimWrite } from "../../src/plugins/contracts/code-host.ts";
import type { AsyncGh } from "./gh.ts";
import { GhFailure } from "./gh.ts";

/** The commit status context a claim is written under, and the one the door writes the verdict to. */
export const REVIEW_CLAIM_CONTEXT = "agent-org/review";

const firstLineOf = (text: string): string => text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";

/**
 * Why a `gh` call failed (A11-172): the first line `gh` printed on stderr, which is GitHub's own reason (`gh: Resource not accessible by integration (HTTP 403)`), and only when it printed none the
 * first line of the error's message (`Command failed: gh api ...`, which names the command and tells a reader nothing of why).
 */
export function reasonOf(err: unknown): string {
  const printed = err instanceof GhFailure ? firstLineOf(err.stderr) : "";
  return printed !== "" ? printed : firstLineOf(String((err as Error)?.message ?? err));
}

/**
 * The claim entries of `head` in `repository` under the claim's context. A read GitHub did not answer is `unreadable`, with its reason.
 *
 * THE READ IS NEVER CACHED (A11-172). The claim is written by another account than the one that reads it (the reviewer App writes, the scheduler App reads), and the `gh` wrapper's read cache is one
 * store per account, which a write by another account does not drop: a cached read straight after the write lists the head as it was before the claim. `-H` makes the wrapper class the call `neutral`,
 * which it neither serves from its store nor stores, and GitHub takes `Cache-Control: no-cache` as an ordinary request header.
 */
export async function readReviewClaims(repository: string, head: string, gh: AsyncGh): Promise<ReviewClaimRead> {
  try {
    // Read as one tab-separated line per status, so a page of statuses reads as lines and no page is joined to the next.
    const lines = (await gh(["api", "--paginate", "-H", "Cache-Control: no-cache", `repos/${repository}/commits/${head}/statuses?per_page=100`, "--jq", `.[] | select(.context == "${REVIEW_CLAIM_CONTEXT}") | [.id, .created_at, .description] | @tsv`]))
      .split("\n").filter((line) => line !== "");
    return {
      entries: lines.map((line) => {
        const [id, created, ...description] = line.split("\t");
        return { id: Number(id), description: description.join("\t"), created: Date.parse(created) };
      }),
    };
  } catch (err) {
    return { unreadable: reasonOf(err) };
  }
}

/** Writes a status under the claim's context on `head`, state `success`: the state says nothing, the description says whose and when. Answers why GitHub refused, or null once it is written. */
export async function writeReviewClaim({ repository, head, description }: ReviewClaimWrite, gh: AsyncGh): Promise<string | null> {
  try {
    await gh(["api", "--method", "POST", `repos/${repository}/statuses/${head}`, "--silent", "-f", "state=success", "-f", `context=${REVIEW_CLAIM_CONTEXT}`, "-f", `description=${description}`]);
    return null;
  } catch (err) {
    return reasonOf(err);
  }
}
