// agent-org#1573: THE TWO `gh` CALLS BEHIND THE OUTSIDE HOME OF ARMING, as arguments built here and run through an injected `run` (`gh`, as the caller hands it in).
// This file names no `gh` and spawns nothing, and it is under `src/ticket-port/` because `gh-call-ratchet.test.ts` refuses a new call shape in a baselined file such as `auto-arm-sweep.ts`.

/** The fields {@link outsideArmListArgs} reads: every one the verdict decides on except the armed state, which `gh pr list` has no field for. */
const LIST_FIELDS = "number,state,isDraft,baseRefName,isCrossRepository,reviewDecision,labels";

/** The arguments that list `repo`'s open pull requests, at most `limit`, with the fields the outside verdict needs. */
export const outsideArmListArgs = (repo: string, limit: number): string[] => ["pr", "list", "--repo", repo, "--state", "open", "--limit", String(limit), "--json", LIST_FIELDS];

/** The write that readies an approved draft. A refused `run` THROWS, and the caller decides what the throw means. */
export function readyPullRequest({ number, repo, run }: { number: number; repo: string; run: (args: string[]) => string }): void {
  run(["pr", "ready", String(number), "--repo", repo]);
}
