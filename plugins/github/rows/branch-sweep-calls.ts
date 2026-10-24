// module: the GitHub operations the branch tools and the worker's `Stop` hook ask (A11-160, step 9; moved from `src/carry-branch.ts`, `src/stranded-branches.ts` and `src/worker-stop-hook.ts`)
//
// The tools DECIDE (which branch is stranded, which pull request is past the line, when a refusal is the hook's to make); what they ask of GitHub and how they read the answer is here. Each takes the runner its caller made
// with its policy (the git variables of a hook taken off, the leak guard, the bound) and THROWS when `gh` refuses. A listing whose answer is not a list THROWS, or is `{ unreadable }` with the caller's words.
import type { RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { HeadRefsPage, SweptPull } from "../../../src/plugins/contracts/code-host-rows-pullwork.ts";

export function openPullNumberOfBranch({ repo, branch, run }: { repo: string; branch: string; run: RowsRun }): number | null {
  const found: unknown = JSON.parse(run(["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number"]));
  if (!Array.isArray(found) || found.length === 0) return null;
  return (found[0] as { number: number }).number;
}

/**
 * One page of PR head refs, PROJECTED IN THE REQUEST. `--jq` runs server-side of this process, so the only thing crossing into node is the one field the check reads -- and it stays JSON rather than newline-delimited text so
 * that a MISSING ref arrives as `null` and can be refused. ASCENDING BY CREATION, which is not cosmetic: a PR opened while the walk is in flight shifts every later page of REST's newest-first default down by one.
 */
export function pullHeadRefsPageOf({ repo, page, pageSize, run }: { repo: string; page: number; pageSize: number; run: RowsRun }): HeadRefsPage {
  const raw = run(["api", `repos/${repo}/pulls?state=all&per_page=${pageSize}&sort=created&direction=asc&page=${page}`, "--jq", "[.[] | {ref: .head.ref}]"]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { unreadable: `gh's PR list (page ${page}) was not JSON -- refusing to guess. First 200 chars: ${raw.slice(0, 200)}` };
  }
  if (!Array.isArray(parsed)) return { unreadable: `gh's PR list (page ${page}) was not an array -- refusing to guess. Got: ${JSON.stringify(parsed).slice(0, 300)}` };
  const refs: string[] = [];
  for (const [i, row] of parsed.entries()) {
    const ref = (row as { ref?: unknown })?.ref;
    if (typeof ref !== "string") return { unreadable: `PR entry ${i} on page ${page} has no head ref -- refusing to guess. Got: ${JSON.stringify(row).slice(0, 200)}` };
    refs.push(ref);
  }
  return { refs };
}

/** `statusCheckRollup` is DELIBERATELY NOT ASKED for: it unions superseded check runs, so a pull request whose latest run succeeded reads as failing (#450). The pull request's own merge state is the bounded question. */
export function openPullsForSweep({ limit, run }: { limit: number; run: RowsRun }): SweptPull[] {
  const parsed = JSON.parse(run(["pr", "list", "--state", "open", "--limit", String(limit), "--json", "number,headRefName,createdAt,isDraft,labels,mergeStateStatus"]));
  if (!Array.isArray(parsed)) throw new Error("gh pr list did not return an array");
  return parsed;
}

export function commentOnCheckoutPull({ number, body, run }: { number: number; body: string; run: RowsRun }): void {
  run(["pr", "comment", String(number), "--body", body]);
}

/** `gh pr close` without `--delete-branch`, said out loud because the flag's absence is the whole safety property. */
export function closeCheckoutPull({ number, run }: { number: number; run: RowsRun }): void {
  run(["pr", "close", String(number)]);
}

export function pullsListedForStop({ repo, limit, run }: { repo: string; limit: number; run: RowsRun }): Record<string, any>[] {
  const listed = JSON.parse(run(["pr", "list", "--repo", repo, "--state", "all", "--limit", String(limit), "--json", "number,state,headRefName,title,labels,body"]));
  if (!Array.isArray(listed)) throw new Error("`gh pr list` did not print a list");
  return listed;
}
