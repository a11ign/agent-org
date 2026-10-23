// module: the GitHub plugin's rows for the org-health sweep readings and the retro (A11-160, step 8; moved from `src/org-health/sweep-readings.ts`, `src/org-retro/journal-stats-and-verdicts.ts` and `retro-window-and-journal-patterns.ts`)
//
// Each takes the `run` its caller hands it, builds the argument list the caller built, and reads GitHub's answer as the caller did. A read that failed THROWS (a refusal, or an answer that is not JSON where JSON is
// read): what a caller makes of it (`null`, a stated unknown, never an empty list) stays in core.
import type { RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";

/** One repository per line, tab-separated with its six permission flags: what the access reading parses. */
const TEAM_LISTING_JQ = ".[]|[.full_name,.permissions.admin,.permissions.maintain,.permissions.push,.permissions.triage,.permissions.pull]|@tsv";
const TEAM_PAGE_SIZE = 100;

/** The repositories a team reaches, with the level it reaches them at, every page. */
export function teamRepositoriesTextOf({ org, team, run }: { org: string; team: string; run: RowsRun }): string {
  return run(["api", `orgs/${org}/teams/${team}/repos?per_page=${TEAM_PAGE_SIZE}`, "--paginate", "--jq", TEAM_LISTING_JQ]);
}

/** The newest-UPDATED `window` closed pull requests of `repo`, of which the latest `merged_at` is printed raw (`null` for an empty list): merging updates the pull request, so every recent merge is among them. */
export function lastMergeTextOf({ repo, window, run }: { repo: string; window: number; run: RowsRun }): string {
  return run(["api", `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${window}`, "--jq", "[.[] | select(.merged_at != null) | .merged_at] | max"]);
}

/** The newest `window` runs of `release.yml` on `main`, as `{ id, event, status, conclusion, sha, createdAt, updatedAt, url }`. THROWS when the answer is refused or is not JSON. */
export function releaseRunsOf({ repo, window, run }: { repo: string; window: number; run: RowsRun }): any {
  return JSON.parse(run(["api", "--method", "GET", `repos/${repo}/actions/workflows/release.yml/runs`, "-f", "branch=main", "-f", `per_page=${window}`,
    "--jq", "[.workflow_runs[] | {id, event, status, conclusion, sha: .head_sha, createdAt: .created_at, updatedAt: .updated_at, url: .html_url}]"]));
}

/** The jobs of one run: `named` is `{ name, conclusion }` of each, `failed` is the failed ones with the steps that failed. THROWS when the answer is refused or is not JSON. */
export function releaseJobsOf({ repo, runId, window, shape, run }: { repo: string; runId: number; window: number; shape: "named" | "failed"; run: RowsRun }): any {
  const jq = shape === "named" ? "[.jobs[] | {name, conclusion}]" : "[.jobs[] | select(.conclusion == \"failure\") | {id, name, steps: [.steps[] | select(.conclusion == \"failure\") | .name]}]";
  return JSON.parse(run(["api", `repos/${repo}/actions/runs/${runId}/jobs?per_page=${window}`, "--jq", jq]));
}

/** The names of the files in `.changeset/` on `main`. THROWS when the answer is refused or is not JSON. */
export function changesetNamesOf({ repo, run }: { repo: string; run: RowsRun }): any {
  return JSON.parse(run(["api", `repos/${repo}/contents/.changeset?ref=main`, "--jq", "[.[].name]"]));
}

/** The newest `limit` open rows of `repo` with their number and labels. THROWS when the answer is refused or is not JSON. */
export function openRowLabelsOf({ repo, limit, run }: { repo: string; limit: number; run: RowsRun }): any[] {
  return JSON.parse(run(["issue", "list", "-R", repo, "--state", "open", "--limit", String(limit), "--json", "number,labels"]));
}

/** The newest `limit` open pull requests of `repo` with the number, body, branch and labels the rows-left-open reading names a row by. THROWS when the answer is refused or is not JSON. */
export function openPullsNamingRowsOf({ repo, limit, run }: { repo: string; limit: number; run: RowsRun }): any[] {
  return JSON.parse(run(["pr", "list", "-R", repo, "--state", "open", "--limit", String(limit), "--json", "number,body,headRefName,labels"]));
}

/** The operations of this group. */
export const healthRows = { teamRepositoriesTextOf, lastMergeTextOf, releaseRunsOf, releaseJobsOf, changesetNamesOf, openRowLabelsOf, openPullsNamingRowsOf };
