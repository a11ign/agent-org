// agent-org#923: a repository's open pull requests, read through an injected `run` (`gh`, as the caller hands it in). This file names no `gh` and spawns nothing:
// `index.test.ts` holds this folder to that, and the spawn stays with whoever owns the runner.
/** The most `gh pr list` returns in one read. A list AT this length may be cut short, so it is no reading (`null`), never a complete list. */
export const OPEN_PULLS_LIMIT = 200;

import type { OpenPullRead, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";

/**
 * THE OPEN PULL REQUESTS OF `repo`, or `null` for "could not ask": a refused `run`, an answer that does not parse, and a list at `OPEN_PULLS_LIMIT`.
 * `null` is never "nothing is open" (#1286): a caller that refuses on an open pull request must not read a failed read as an empty list.
 */
export function openPullsOf(repo: string, run: RowsRun): OpenPullRead[] | null {
  try {
    const pulls: OpenPullRead[] = JSON.parse(run(["pr", "list", "--repo", repo, "--state", "open", "--limit", String(OPEN_PULLS_LIMIT), "--json", "number,body"]));
    if (!Array.isArray(pulls)) return null;
    return pulls.length < OPEN_PULLS_LIMIT ? pulls : null;
  } catch (error) {
    void error; // no list is "cannot say", which the caller refuses on
    return null;
  }
}
