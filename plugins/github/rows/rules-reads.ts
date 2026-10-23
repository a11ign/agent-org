// module: the GitHub reads of the claim's rules -- B2 (a session's own rows and pull requests), B4 (the files other pull requests change), the blocked-by rule and the template check (A11-160, step 7; moved from `src/row-claim/`)
//
// The rules DECIDE (what a wait is, whether a pull request is healthy, which rows overlap); the command that asks and the reading of GitHub's answer are here. Each takes the `run` its caller hands it, builds the
// argument list the rule built, and THROWS when `gh` refuses or answers what is not JSON: the caller's `lookup` reads a throw as "could not ask", which is never an answer of its own.
import type { RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { OpenPullFiles, OpenPullReview, PullCommit, RowShapeFacts } from "../../../src/plugins/contracts/code-host-rows-facts.ts";

/** The row's `blockedBy` edge, as GitHub answers it. */
export function blockedByOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): { blockedBy?: { nodes?: { number?: number; state?: string }[] } } {
  return JSON.parse(run(["issue", "view", String(number), "--repo", repo, "--json", "blockedBy"]));
}

/** The row's body and labels, as GitHub answers them: the SAME argument list the claim's batched read sends, so one `gh issue view` serves both. */
export function bodyAndLabelsOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): { body?: string; labels?: unknown[] } {
  return JSON.parse(run(["issue", "view", String(number), "--repo", repo, "--json", "body,labels"]));
}

/**
 * What the claim's B2 reads of a held row beyond its closing pull request, in two calls on the one `run`: the body, the labels and the `blockedBy` edge (`waitingOn` reads all three off one object), then the
 * count of GitHub's own sub-issue link, which the filing of a sub-row creates and a label cannot stand in for.
 */
export function rowShapeFactsOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): RowShapeFacts {
  const view = JSON.parse(run(["issue", "view", String(number), "--repo", repo, "--json", "body,labels,blockedBy"]));
  const subs = JSON.parse(run(["api", `repos/${repo}/issues/${number}/sub_issues`]));
  return { body: view.body, labels: view.labels, blockedBy: view.blockedBy, subIssues: Array.isArray(subs) ? subs.length : 0 };
}

/** Whether the row carries `label`: ONE read. THROWS on a refusal rather than reading as "not labelled", which would re-post what the label announces. */
export function rowCarriesLabel({ repo, number, label, run }: { repo: string; number: number; label: string; run: RowsRun }): boolean {
  const parsed: { labels?: { name?: string }[] } = JSON.parse(run(["issue", "view", String(number), "--repo", repo, "--json", "labels"]));
  return (parsed.labels ?? []).some((entry) => entry?.name === label);
}

/**
 * The fields of an open pull request the review-health read decides on, and NEVER `commits` (#2316): `commits` nests a connection inside `reviews` inside a 200-row page, and GitHub refused the whole query
 * ("requesting up to 1,000,000 possible nodes which exceeds the maximum limit of 500,000"). The commits are read per pull request, and only where they are consulted ({@link commitsOfPull}).
 */
const REVIEW_FIELDS = "number,headRefOid,reviewDecision,reviews,author";

/** The newest `limit` open pull requests of `repo` with their reviews: one `pr list` over the whole queue. */
export function openPullReviewsOf({ repo, limit, run }: { repo: string; limit: number; run: RowsRun }): OpenPullReview[] {
  return JSON.parse(run(["pr", "list", "--repo", repo, "--state", "open", "--limit", String(limit), "--json", REVIEW_FIELDS]));
}

/** The commits of pull request `number`, or none when the answer carries no list. */
export function commitsOfPull({ repo, number, run }: { repo: string; number: number; run: RowsRun }): PullCommit[] {
  const parsed: { commits?: PullCommit[] } = JSON.parse(run(["pr", "view", String(number), "--repo", repo, "--json", "commits"]));
  return parsed.commits ?? [];
}

/** Every open pull request of `repo` with the files it changes, its body, labels and branch: ONE call whatever the number of pull requests (`pr list --json files` returns every diff in a single round trip). */
export function openPullsWithFilesOf({ repo, run }: { repo: string; run: RowsRun }): OpenPullFiles[] {
  return JSON.parse(run(["pr", "list", "--repo", repo, "--state", "open", "--json", "number,changedFiles,files,body,labels,headRefName"]));
}

/** EVERY file of one pull request, through REST's pages (the list above carries at most a hundred). */
export function pullFilePathsOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): string[] {
  return run(["api", "--paginate", `repos/${repo}/pulls/${number}/files?per_page=100`, "--jq", ".[].filename"]).split("\n").filter(Boolean);
}
