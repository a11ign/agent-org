// module: the GitHub reads behind the MERGE GUARD and the merge queue's dispatcher (A11-160, step 5; moved from `src/merge-guard.ts`, `src/merge-guard/lookups.ts`, `src/merge-guard/armed-race-rule.ts` and `src/merge-queue.ts`)
//
// The merge guard answers whether a pull request has actually been tested, by reading its check RUNS rather than `mergeStateStatus`. The RULES (what is red, what is stale, what an approval covers) are core's and
// are pure; what the guard ASKS OF GITHUB is here: the branch protection's required contexts, a commit's check runs, the tip of `main`, how far a head is behind it, the rows a pull request would close, the
// pull request's own fields and its outcome, and the open pull request of a branch. The merge queue's dispatcher reads the open pull requests, merges one, compares its branch with `main` and deletes it.
// Each takes the `run` its caller hands it and THROWS when `gh` refuses or the answer is not the shape: core's `lookup` turns a throw into `null`, which is "could not ask" and never "none".
import type { BranchPull, ClosingIssue, GuardCheckRun, GuardPullRead, OutcomeRead, QueuePull, RecentClosesPull, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";

/** The contexts branch protection requires of `main`, or `null` when the answer carries none (an unprotected branch is not "no required checks"). */
export function requiredContextsOf({ repo, run }: { repo: string; run: RowsRun }): string[] | null {
  const contexts = JSON.parse(run(["api", `repos/${repo}/branches/main`])).protection?.required_status_checks?.contexts;
  return Array.isArray(contexts) ? contexts : null;
}

/** The check runs of the commit `sha`, all pages. */
export function checkRunsOfCommit({ repo, sha, run }: { repo: string; sha: string; run: RowsRun }): GuardCheckRun[] {
  return JSON.parse(run(["api", `repos/${repo}/commits/${sha}/check-runs`, "--paginate"])).check_runs
    .map((checkRun: { id: number; name: string; status: string; conclusion: string | null; completed_at: string | null }) => (
      { id: checkRun.id, name: checkRun.name, status: checkRun.status, conclusion: checkRun.conclusion, completedAt: checkRun.completed_at }));
}

/** When the tip of `main` was committed, as GitHub prints it, or `null` for an empty answer. */
export function mainTipDateOf({ repo, run }: { repo: string; run: RowsRun }): string | null {
  return run(["api", `repos/${repo}/commits/main`, "--jq", ".commit.committer.date"]).trim() || null;
}

/** How many commits of `main` the commit `head` does not contain, or `null` when the answer carries no number. */
export function behindByOf({ repo, head, run }: { repo: string; head: string; run: RowsRun }): number | null {
  const value = JSON.parse(run(["api", `repos/${repo}/compare/main...${head}`])).behind_by;
  return typeof value === "number" ? value : null;
}

/** The rows pull request `number` of `repo` would close, as GitHub resolves its closing references, each with its labels. */
export function closingIssuesOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): ClosingIssue[] {
  const [owner, name] = repo.split("/");
  const query = "query($owner:String!,$name:String!,$number:Int!){"
    + "repository(owner:$owner,name:$name){pullRequest(number:$number){"
    + "closingIssuesReferences(first:20){nodes{number title repository{nameWithOwner} labels(first:20){nodes{name}}}}}}}";
  const data = JSON.parse(run(["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`]));
  return data.data.repository.pullRequest.closingIssuesReferences.nodes.map(
    (issue: { number: number; title: string; repository?: { nameWithOwner: string }; labels: { nodes: { name: string }[] } }) => ({
      number: issue.number, repo: issue.repository?.nameWithOwner, title: issue.title, labels: issue.labels.nodes.map((label) => label.name),
    }));
}

/** How many of the newest pull requests {@link recentClosesPrsOf} reads. */
const RECENT_CLOSES_PRS = 30;

/** The newest open and merged pull requests of `repo`, each with its body and the rows GitHub resolves it as closing: what a `Closes` mismatch check compares. */
export function recentClosesPrsOf({ repo, run }: { repo: string; run: RowsRun }): RecentClosesPull[] {
  const [owner, name] = repo.split("/");
  const query = "query($owner:String!,$name:String!,$count:Int!){"
    + "repository(owner:$owner,name:$name){pullRequests(states:[OPEN,MERGED],first:$count,"
    + "orderBy:{field:CREATED_AT,direction:DESC}){nodes{number body "
    + "closingIssuesReferences(first:20){nodes{number}}}}}}";
  const data = JSON.parse(run(["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `count=${RECENT_CLOSES_PRS}`]));
  return data.data.repository.pullRequests.nodes.map(
    (pull: { number: number; body: string | null; closingIssuesReferences: { nodes: { number: number }[] } }) => ({
      number: pull.number, body: pull.body ?? "", resolved: pull.closingIssuesReferences.nodes.map((issue) => issue.number),
    }));
}

/** The names of a pull request's labels as its answer carries them, leaving out a name that is not a string; `null` when the answer carries no list. */
const labelNamesOf = (labels: unknown): string[] | null => (Array.isArray(labels)
  ? labels.map((label: { name?: unknown }) => label?.name).filter((name: unknown): name is string => typeof name === "string")
  : null);

/** The names of a pull request's labels when EVERY name is a string, else `null`: a label list that cannot be read whole is no list, because a hold may be among the names left out. */
const wholeLabelNamesOf = (labels: unknown): string[] | null => {
  if (!Array.isArray(labels)) return null;
  const names = labels.map((label: { name?: unknown }) => label?.name);
  return names.every((name: unknown) => typeof name === "string") ? (names as string[]) : null;
};

/**
 * Pull request `number` of `repo` as the guard's readiness check reads it: the fields the rules decide on, its labels (`null` when the answer carries no list), its body and its author.
 * The state is GitHub's own word for it (`OPEN`).
 */
export function pullForGuard({ repo, number, run }: { repo: string; number: number; run: RowsRun }): GuardPullRead {
  const pr = JSON.parse(run(["pr", "view", String(number), "--repo", repo, "--json", "number,state,baseRefName,headRefOid,headRefName,labels,body,author"]));
  return { pr: { number: pr.number, state: pr.state, baseRefName: pr.baseRefName, headRefOid: pr.headRefOid, headRefName: pr.headRefName },
    prLabels: labelNamesOf(pr.labels), body: pr.body ?? "", author: pr.author?.login ?? null };
}

/**
 * Pull request `number` of `repo` as the CI gate reads it, from the REST pull (the gate runs against its own commit, where the pull request may be a merge ref): the fields the rules decide on, its
 * labels (`null` when the answer carries no list, or a name that is not a string), its body and its author. The state is the REST word for it (`open`).
 */
export function pullForCiGate({ repo, number, run }: { repo: string; number: number; run: RowsRun }): GuardPullRead {
  const raw = JSON.parse(run(["api", `repos/${repo}/pulls/${number}`]));
  return { pr: { number: raw.number, state: raw.state, baseRefName: raw.base?.ref, headRefOid: raw.head?.sha, headRefName: raw.head?.ref },
    prLabels: wholeLabelNamesOf(raw.labels), body: raw.body ?? "", author: raw.user?.login ?? null };
}

/** Pull request `number` of `repo`'s state, when it merged and when it closed: what a verdict is reconciled against. */
export function pullOutcomeOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): OutcomeRead {
  const pr = JSON.parse(run(["pr", "view", String(number), "--repo", repo, "--json", "state,mergedAt,closedAt"]));
  return { state: pr.state, mergedAt: pr.mergedAt ?? null, closedAt: pr.closedAt ?? null };
}

/** The open pull requests whose head branch is `branch`, each with whether auto-merge is requested on it. `reviewDecision` is `null` when the answer carries no such field, and `""` when it is empty. */
export function openPullsOfBranch({ repo, branch, run }: { repo: string; branch: string; run: RowsRun }): BranchPull[] {
  const pulls = JSON.parse(run(["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,autoMergeRequest,headRefOid,reviewDecision"]));
  return pulls.map((pull: { number: number; autoMergeRequest?: unknown; headRefOid: string; reviewDecision?: string | null }) => (
    { number: pull.number, armed: pull.autoMergeRequest != null, headRefOid: pull.headRefOid, reviewDecision: "reviewDecision" in pull ? (pull.reviewDecision ?? "") : null }));
}

// --- the merge queue's dispatcher ----------------------------------------------------------------------------------------------------

const QUEUE_FIELDS = "number,title,headRefName,mergeable,mergeStateStatus,isDraft,statusCheckRollup";

/** The open pull requests of the repository the working directory belongs to, with what the dispatcher decides readiness on. THROWS when the read is refused or the answer is not JSON. */
export function openPullsForQueue({ run }: { run: RowsRun }): QueuePull[] {
  return JSON.parse(run(["pr", "list", "--state", "open", "--json", QUEUE_FIELDS]));
}

/** The write: merges pull request `number` (merge commit) and answers what was printed. A refused merge THROWS. */
export function mergeQueuedPull({ number, run }: { number: number; run: RowsRun }): string {
  return run(["pr", "merge", String(number), "--merge"]);
}

/** How far `branch` is ahead of `main`, with the commits it carries: what a merge left behind. THROWS when the read is refused or is not JSON. */
export function compareWithMain({ repo, branch, run }: { repo: string; branch: string; run: RowsRun }): { ahead_by?: number; commits?: { sha: string; commit?: { message?: string } }[] } {
  return JSON.parse(run(["api", `repos/${repo}/compare/main...${branch}`]));
}

/** The write: deletes the branch `branch`. A refused delete THROWS. */
export function deleteBranchOf({ repo, branch, run }: { repo: string; branch: string; run: RowsRun }): void {
  run(["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${branch}`]);
}
