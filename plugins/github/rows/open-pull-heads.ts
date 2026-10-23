// agent-org#1167: a repository's open pull requests with the fields the prune's open-PR hold reads (number, url, head branch, labels), read through
// an injected `run` (`gh`, as the caller hands it in). This file spawns nothing: `index.test.ts` holds this folder to
// that, and the spawn stays with whoever owns the runner (`defaultGh` in `worktree-removal.ts`).

import type { OpenPullHeads, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";

/**
 * THE OPEN PULL REQUESTS of `repo`, or why they could not be read: a refused `run`, an answer that is not a list, and a list that fills
 * `limit` (a full page may be cut short, so it is refused rather than trusted).
 */
export function readOpenPullHeads(repo: string, run: RowsRun, limit: number): OpenPullHeads {
  let parsed: unknown;
  try {
    parsed = JSON.parse(run(["pr", "list", "--repo", repo, "--state", "open", "--limit", String(limit), "--json", "number,url,headRefName,labels"]));
  } catch (error) {
    return { read: false, reason: `the open pull request listing failed: ${String((error as Error).message).split("\n")[0]}` };
  }
  if (!Array.isArray(parsed)) return { read: false, reason: "the open pull request listing did not return a list" };
  if (parsed.length >= limit) return { read: false, reason: `there are ${limit} or more open pull requests, the listing limit` };
  const rows = parsed as { number: number, url: string, headRefName: string, labels?: { name: string; }[] }[];
  return { read: true, pulls: rows.map((row) => ({ number: row.number, url: row.url, headRefName: row.headRefName, labels: (row.labels ?? []).map((label) => label.name) })) };
}
