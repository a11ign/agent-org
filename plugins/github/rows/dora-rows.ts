// module: the GitHub plugin's rows for the DORA reader (A11-160, step 8; moved from `src/dora.ts`)
//
// The reader decides what a release, a merge and a regression are; the commands that ask GitHub for them are here. Each takes the `run` the reader hands it (which carries the read budget and the bound on a call), builds the
// argument list the reader built, and THROWS when the read is refused or is not JSON.
import type { RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";

/** The commit a tag or sha names, as `<sha> <parent shas, comma-joined>`: one read that carries the parents too. */
export function commitAndParentsTextOf({ repo, ref, run }: { repo: string; ref: string; run: RowsRun }): string {
  return run(["api", `repos/${repo}/commits/${encodeURIComponent(ref)}`, "--jq", `[.sha, (.parents | map(.sha) | join(","))] | join(" ")`]);
}

/** Every release of `repo`, drafts included, flattened out of the pages. */
export function releasesOf({ repo, run }: { repo: string; run: RowsRun }): any[] {
  return JSON.parse(run(["api", `repos/${repo}/releases`, "--paginate", "--slurp"])).flat();
}

/** Whether `repo` has issues enabled: a repository that only holds code has none and can have none. */
export function hasIssuesEnabled({ repo, run }: { repo: string; run: RowsRun }): boolean {
  return JSON.parse(run(["repo", "view", repo, "--json", "hasIssuesEnabled"])).hasIssuesEnabled === true;
}

/** The pages of the comparison `base...head`: the status once, and the commits of `head` that `base` lacks. */
export function compareRangeOf({ repo, base, head, run }: { repo: string; base: string; head: string; run: RowsRun }): any[] {
  return JSON.parse(run(["api", `repos/${repo}/compare/${base}...${head}?per_page=100`, "--paginate", "--slurp"]));
}

/** The merge commit of pull request `number` of `repo` and when it merged. */
export function pullMergeOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): { mergeCommit?: { oid?: string } | null; mergedAt?: string | null } {
  return JSON.parse(run(["pr", "view", String(number), "-R", repo, "--json", "mergeCommit,mergedAt"]));
}

/** The operations of this group. */
export const doraRows = { commitAndParentsTextOf, releasesOf, hasIssuesEnabled, compareRangeOf, pullMergeOf };
