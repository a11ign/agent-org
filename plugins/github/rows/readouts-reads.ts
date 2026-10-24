// module: the GitHub reads of the read-only reporters -- the blast-radius gate, the CI-health liveness, release-behind-main, the review depth, the commit-liveness watchdog, the lane authorship check and the branch
// inventory (A11-160, step 9; moved from `src/blast-radius.ts`, `src/ci-health-liveness.ts`, `src/release-behind-main.ts`, `src/review-depth.ts`, `src/workflow-run-liveness.ts`, `src/lane-ownership.ts` and
// `src/branch-inventory-report.ts`)
//
// Each takes the `run` its caller hands it, builds the argument list the caller built, in the same order, and THROWS when `gh` refuses or answers what is not JSON: what a caller does with a refusal (CANNOT TELL, unknown,
// null) stays in core. This file spawns nothing.
import type { RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import type {
  AssociatedPull, CommitFile, CommitPull, ProjectedIssue, PathCommit, PublishedRelease, PullDepthFacts, TimelineEvent, WorkflowDefinition,
} from "../../../src/plugins/contracts/code-host-rows-readouts.ts";

const RAW = ["-H", "Accept: application/vnd.github.raw"];

/** The lines `gh api --jq` printed that hold anything. */
const linesOf = (out: string): string[] => out.split("\n").filter(Boolean);

/** A projection that must be a list: the words `what` names it by say which read did not answer one. */
function jsonList(text: string, what: string): any[] {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`${what} did not answer a list`);
  return parsed;
}

// --- the blast-radius gate ------------------------------------------------------------------------------------------------------------

/** Every blob of the default branch's recursive tree. GitHub's own `truncated` flag fails the read (the jq errors) rather than undercounting a tree it cut short. */
export function treeFilesOf({ repo, run }: { repo: string; run: RowsRun }): string[] {
  const jq = 'if .truncated then error("tree truncated") else .tree[] | select(.type == "blob") | .path end';
  return linesOf(run(["api", `repos/${repo}/git/trees/HEAD?recursive=1`, "--jq", jq]));
}

// --- the CI-health liveness -----------------------------------------------------------------------------------------------------------

export function workflowDefinitionOf({ repo, workflow, run }: { repo: string; workflow: string; run: RowsRun }): WorkflowDefinition | null {
  return JSON.parse(run(["api", `repos/${repo}/actions/workflows/${workflow}`]));
}

export function rawFileTextOf({ repo, path, run }: { repo: string; path: string; run: RowsRun }): string {
  return run(["api", `repos/${repo}/contents/${path}`, ...RAW]);
}

/** The runs a `schedule` started: `event=schedule` is what tells a run the cron made from one somebody dispatched. */
export function scheduledRunsOf({ repo, workflow, perPage, run }: { repo: string; workflow: string; perPage: number; run: RowsRun }) {
  return JSON.parse(run(["api", `repos/${repo}/actions/workflows/${workflow}/runs?event=schedule&per_page=${perPage}`])).workflow_runs;
}

/** Every page of the row's comments, as `--paginate --slurp` prints them (an array of pages), flattened to their bodies. */
export function reportCommentBodiesOf({ repo, issue, perPage, since, run }: { repo: string; issue: number; perPage: number; since: string | null; run: RowsRun }): string[] {
  return JSON.parse(run(["api", "--paginate", "--slurp", `repos/${repo}/issues/${issue}/comments?per_page=${perPage}${since ? `&since=${since}` : ""}`])).flat().map((c: { body: string }) => c.body);
}

// --- release-behind-main --------------------------------------------------------------------------------------------------------------

/** The releases that are not drafts, with their tag and publish time: the projection is GitHub's, `-f per_page` is a GET parameter (`--method GET`). */
export function publishedReleasesOf({ repo, window, run }: { repo: string; window: number; run: RowsRun }): PublishedRelease[] {
  return jsonList(run(["api", "--method", "GET", `repos/${repo}/releases`, "-f", `per_page=${window}`, "--jq", "[.[] | select(.draft | not) | {tag: .tag_name, at: .published_at}]"]), `${repo} releases`);
}

/** One page of the commits of `main` under `path`; a commit's `parents` is how many it has, so a caller can leave a merge commit out. */
export function pathCommitsPageOf({ repo, path, page, perPage, since, run }: { repo: string; path: string; page: number; perPage: number; since: string | null; run: RowsRun }): PathCommit[] {
  return jsonList(run(["api", "--method", "GET", `repos/${repo}/commits`, "-f", "sha=main", "-f", `path=${path}`, "-f", `per_page=${perPage}`, "-f", `page=${page}`,
    ...(since === null ? [] : ["-f", `since=${since}`]),
    "--jq", "[.[] | {sha, at: .commit.committer.date, parents: (.parents | length)}]"]), `${repo} commits under ${path}`);
}

export function commitFilesOf({ repo, sha, run }: { repo: string; sha: string; run: RowsRun }): CommitFile[] {
  return jsonList(run(["api", `repos/${repo}/commits/${sha}`, "--jq", "[.files[] | {filename, previous_filename}]"]), `${repo} commit ${sha}`);
}

export function commitPullsOf({ repo, sha, run }: { repo: string; sha: string; run: RowsRun }): CommitPull[] {
  return jsonList(run(["api", `repos/${repo}/commits/${sha}/pulls`, "--jq", "[.[] | {number, body}]"]), `${repo} pulls of ${sha}`);
}

// --- the review depth -----------------------------------------------------------------------------------------------------------------

export function pullDepthFactsOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): PullDepthFacts {
  const pull = JSON.parse(run(["api", `repos/${repo}/pulls/${number}`]));
  return { changedFiles: Number(pull.changed_files), additions: Number(pull.additions), deletions: Number(pull.deletions), title: String(pull.title ?? ""), body: String(pull.body ?? "") };
}

export function pullFilenamesPageOf({ repo, number, perPage, run }: { repo: string; number: number; perPage: number; run: RowsRun }): string[] {
  const files: { filename: string }[] = JSON.parse(run(["api", `repos/${repo}/pulls/${number}/files?per_page=${perPage}`]));
  return files.map((file) => file.filename);
}

export function restRowBodyOf({ repo, number, run }: { repo: string; number: number | string; run: RowsRun }): string {
  return String(JSON.parse(run(["api", `repos/${repo}/issues/${number}`])).body ?? "");
}

// --- the commit-liveness watchdog and the lane authorship check -----------------------------------------------------------------------

export function commitAssociatedPullsOf({ repo, sha, run }: { repo: string; sha: string; run: RowsRun }): AssociatedPull[] {
  return JSON.parse(run(["api", `repos/${repo}/commits/${sha}/pulls`])).map((p: { number: number; head: { sha: string } }) => ({ number: p.number, headRefOid: p.head.sha }));
}

/** Every file name of the pull request, through REST's pages. */
export function pullFilenamesOf({ repo, number, run }: { repo: string; number: number | string; run: RowsRun }): string[] {
  return linesOf(run(["api", "--paginate", `repos/${repo}/pulls/${number}/files`, "--jq", ".[].filename"]));
}

// --- the branch inventory -------------------------------------------------------------------------------------------------------------

export function openPullHeadRefsOf({ repo, run }: { repo: string; run: RowsRun }): string[] {
  return run(["api", `repos/${repo}/pulls?state=open&per_page=100`, "--paginate", "--jq", ".[].head.ref"]).split("\n").filter((ref) => ref.trim() !== "");
}

/**
 * The issues listing projected server-side-ish with `--jq`, because the raw listing is megabytes of issue BODIES and the process met it as `ENOBUFS`. One JSON object per line, four fields each. Pull requests are CARRIED
 * (`isPullRequest`), not filtered: a branch whose trailing number names a pull request must be reported as naming one.
 */
export function issueProjectionOf({ repo, run }: { repo: string; run: RowsRun }): ProjectedIssue[] {
  const projected = run(["api", `repos/${repo}/issues?state=all&per_page=100`, "--paginate", "--jq", '.[] | {number, state, isPullRequest: has("pull_request"), labels: [.labels[].name]}']);
  return projected.split("\n").filter((line) => line.trim() !== "").map((line) => {
    const issue = JSON.parse(line);
    return { ...issue, state: String(issue.state).toUpperCase() };
  });
}

export function rowTimelineEventsOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): TimelineEvent[] {
  return JSON.parse(run(["api", `repos/${repo}/issues/${number}/timeline`, "--paginate"]));
}

/** The operations of this file. */
export const readoutsReads = {
  treeFilesOf, workflowDefinitionOf, rawFileTextOf, scheduledRunsOf, reportCommentBodiesOf, publishedReleasesOf, pathCommitsPageOf, commitFilesOf, commitPullsOf,
  pullDepthFactsOf, pullFilenamesPageOf, restRowBodyOf, commitAssociatedPullsOf, pullFilenamesOf, openPullHeadRefsOf, issueProjectionOf, rowTimelineEventsOf,
};
