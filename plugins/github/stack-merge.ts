// module: the stack merge of a stacked pull request, as the board reads it and asks for it (contract 1.16, A11-238)
//
// GITHUB REFUSES AUTO-MERGE AND A PLAIN MERGE FOR A PULL REQUEST IN A STACK, and the arm bot merges one with the stack merge instead (`auto-arm.yml`, job `arm-approved`), with its own minted token: the one identity the repository grants a merge. THE BOARD NEVER MERGES. It reads
// here whether a pull request is in a stack and what the arm bot left on it, and it asks the arm bot to look at it again, which is a dispatch of the arm bot's own job: that job re-reads the pull request and trusts nothing the dispatch says.
// Every call goes through the `gh` it is handed, which is the instance's, with the workers' account.
import type { StackMergeFacts, StackMergeRequest } from "../../src/plugins/contracts/code-host.ts";
import { GhFailure, type Gh } from "./gh.ts";
import { pullOf } from "./pull-feedback.ts";
import { armedNodeOf } from "./rows/armed-state.ts";

/** The API version the `stack` field of a pull request is sent under (GitHub's stacked-pull-request docs). */
export const STACK_API_VERSION = "2026-03-10";

/** What the first line of the arm bot's refusal comment begins with: the comment is found, and its head read, by it. `auto-arm.yml` writes it. */
export const REFUSAL_MARKER = "<!-- agent-org:stack-merge ";

/** The workflow whose `arm-approved` job merges, and the branch it runs from (the one its token policy admits). */
const ARM_WORKFLOW = "auto-arm.yml";
const ARM_REF = "main";

/** The words before GitHub's reason in the refusal comment. */
const REFUSAL_LEAD = /^GitHub refused the stack merge of #\d+:\s*/;

/** The head and the reason of one refusal comment, as `auto-arm.yml` writes it: the marker line with the head, then the sentence with GitHub's reason. Null for a comment that carries no head. PURE. */
export function refusalOf(body: string): { head: string; reason: string } | null {
  const [marker, ...rest] = body.split("\n");
  const head = /^<!-- agent-org:stack-merge head=([0-9a-f]+) -->\s*$/.exec(marker)?.[1];
  if (head === undefined) return null;
  const reason = rest.join("\n").trim().replace(REFUSAL_LEAD, "").trim();
  return { head, reason: reason === "" ? "no reason given" : reason };
}

/** The newest refusal comment on the pull request, or null when the arm bot left none. THROWS when the comments cannot be read. */
function newestRefusal(repo: string, number: number, gh: Gh): { head: string; reason: string } | null {
  const lines = gh(["api", "--paginate", `repos/${repo}/issues/${number}/comments`, "--jq", `.[] | select(.body | startswith(${JSON.stringify(REFUSAL_MARKER)})) | .body | tojson`])
    .split("\n").filter((line) => line.trim() !== "");
  // The comments come oldest first, and the arm bot edits its own in place, so the last marker is the one that stands; one that does not parse is no refusal.
  return lines.length === 0 ? null : refusalOf(JSON.parse(lines[lines.length - 1]));
}

/** The pull request as GitHub's REST answer gives it, narrowed to what is read here. */
type PullAnswer = { stack?: { number?: unknown } | null; base?: { ref?: unknown; repo?: { default_branch?: unknown } | null }; head?: { sha?: unknown } };

/**
 * What the pull request at `url` is, as the stack merge sees it, or `null` for "could not ask": an address that is not a GitHub pull request, a refused read, and an answer that names no base, default branch or head. Null is never "not in a stack".
 * A pull request that is not in a stack, or that is merged already, is answered with the facts that decide that, and nothing more is read of it: its queue seat and comments are only asked of a stacked pull request that is still open.
 */
export function stackMergeFactsOf(url: string, gh: Gh): StackMergeFacts | null {
  const pull = pullOf(url);
  if (pull === null) return null;
  const repo = `${pull.owner}/${pull.repo}`;
  try {
    const answer: PullAnswer & { merged?: unknown } = JSON.parse(gh(["api", "-H", `X-GitHub-Api-Version: ${STACK_API_VERSION}`, `repos/${repo}/pulls/${pull.number}`]));
    const base = answer.base?.ref;
    const defaultBranch = answer.base?.repo?.default_branch;
    const head = answer.head?.sha;
    if (typeof base !== "string" || typeof defaultBranch !== "string" || typeof head !== "string") return null;
    const stacked = answer.stack?.number != null;
    const facts = { stacked, base, defaultBranch, head };
    if (answer.merged === true) return { ...facts, settled: "merged", refusal: null };
    if (!stacked) return { ...facts, settled: null, refusal: null };
    const queued = armedNodeOf({ number: pull.number, repo, run: gh });
    if (queued === null) return null;
    if (queued.merged === true) return { ...facts, settled: "merged", refusal: null };
    const settled = queued.mergeQueueEntry != null || queued.autoMergeRequest != null ? "queued" : null;
    return { ...facts, settled, refusal: newestRefusal(repo, pull.number, gh) };
  } catch (error) {
    void error; // an unreadable pull request is "could not ask", and the board asks again on its next sweep
    return null;
  }
}

/** The first line `gh` printed on stderr, which is GitHub's reason, or the error's own message when it printed none. */
function reasonOf(err: unknown): string {
  const printed = err instanceof GhFailure ? err.stderr : String((err as Error)?.message ?? err);
  return printed.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "GitHub gave no reason";
}

/** Asks the arm bot to merge the pull request: a dispatch of `arm-approved`, which merges nothing itself. THROWS, with GitHub's first line, when the dispatch is refused. */
export function requestStackMerge({ repo, number }: StackMergeRequest, gh: Gh): void {
  try {
    gh(["workflow", "run", ARM_WORKFLOW, "--repo", repo, "--ref", ARM_REF, "-f", `pr=${number}`]);
  } catch (err) {
    throw new Error(reasonOf(err));
  }
}
