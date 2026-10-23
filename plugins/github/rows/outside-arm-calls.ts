// agent-org#1573: THE TWO `gh` CALLS BEHIND THE OUTSIDE HOME OF ARMING, as arguments built here and run through an injected `run` (`gh`, as the caller hands it in).
// This file names no `gh` and spawns nothing, and it is in the GitHub plugin, the one place `gh-call-ratchet.test.ts` lets a call shape be, which a baselined file such as `auto-arm-sweep.ts` may not gain.

import type { RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";

/** The fields {@link outsideArmListArgs} reads: every one the verdict decides on except the armed state, which `gh pr list` has no field for. */
const LIST_FIELDS = "number,state,isDraft,baseRefName,isCrossRepository,reviewDecision,labels";

/** The arguments that list `repo`'s open pull requests, at most `limit`, with the fields the outside verdict needs. */
export const outsideArmListArgs = (repo: string, limit: number): string[] => ["pr", "list", "--repo", repo, "--state", "open", "--limit", String(limit), "--json", LIST_FIELDS];

/** The write that readies an approved draft, or with `undo` puts it back to a draft (agent-org#1628). A refused `run` THROWS, and the caller decides what the throw means. */
export function readyPullRequest({ number, repo, run, undo = false }: { number: number; repo: string; run: RowsRun; undo?: boolean }): void {
  run(["pr", "ready", String(number), "--repo", repo, ...(undo ? ["--undo"] : [])]);
}
