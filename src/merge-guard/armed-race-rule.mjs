#!/usr/bin/env node
// @ts-check
// RULE: WOULD PUSHING TO THIS BRANCH RIGHT NOW RACE A MERGE THAT CAN COMPLETE UNDERNEATH IT? -- #386.
//
// Is `branchName`'s open PR armed with auto-merge AND already green? Pushing a follow-up commit to a
// branch in that state races a merge that can complete in the window between the commit and the push --
// measured three times in one evening, each time the commit landed stranded on a branch GitHub had
// already merged, findable by nothing (`branches:stranded` correctly excludes a merged branch).
//
// `null` on ANY failure -- no PR, `gh` missing or unauthenticated, a network error -- same convention as
// every other lookup here. The caller decides what null means; for this one specifically it must mean
// ALLOW, loudly, never refuse (see `racesAnArmedMerge`'s own comment).
//
// GREEN IS ANSWERED THE SAME WAY `merge-guard.mjs`'s `facts()`/`mergeReadiness` ANSWER IT --
// `lookupRequiredContexts()` + `lookupCheckRuns()` fed to `checkReasons()` (`checks-rule.mjs`), empty
// reasons meaning nothing is missing, unfinished or failing -- never a second, independently-invented
// reading of "green" off `statusCheckRollup`. That field is GitHub's own rolled-up combined-status object,
// a different aggregation from the check-runs this file already reads and already distrusts
// `mergeStateStatus` for the identical reason; a first draft of this function read `statusCheckRollup`
// directly and it read `FAILURE` on a real, live PR (#359) at the same moment `gh pr checks` -- a
// different command, reading check-runs -- showed the `gate` job PASSING on that PR's latest run.
// Whichever is right, reading two sources and trusting the one nothing else in this file has ever vouched
// for is exactly the "two spellings of is this PR green" shape this issue's own acceptance names -- so
// this reuses the reading `mergeReadiness` already trusts. `green: null` (armed, but green-ness itself
// could not be determined) is folded into "does not race" by `racesAnArmedMerge`, the same fail-open
// direction as the top-level `null`.
//
// `behindBy`, #442: the race this guards against can only happen while the merge can actually FIRE, and
// under strict branch protection (restored 02:15Z) a merge cannot fire while the head is behind `main`'s
// tip -- so a PR that is armed, green AND behind is not a race, it is the FROZEN state #442 exists to
// unfreeze. Read via `repos/.../compare/main...<oid>`'s `behind_by`, the identical ancestry fact
// `ancestry-rule.mjs` already reads for -- never `mergeStateStatus`, for the reason at the top of
// `merge-guard.mjs`. Only asked when green: an armed-but-not-green PR never races (see `racesAnArmedMerge`
// below), so a behind-by lookup there would be a round trip for a value nothing reads. `null` (could not
// determine) folds into "does not race" the same fail-open direction as everything else here.
import { REPO } from "../../../../scripts/repo-identity.mjs";
import { checkReasons } from "./checks-rule.mjs";
import { gh, lookup, lookupRequiredContexts, lookupCheckRuns } from "./lookups.mjs";

/**
 * #1408: `run`, `requiredContexts` and `checkRuns` are the real lookups unless a caller injects them -- the test does, so
 * a local suite never asks GitHub, and an ARMED PR's path is driven rather than assumed. The defaults are exercised only
 * by `merge-guard.mjs`'s own call, through the real pre-push hook; if that wiring broke, the hook's armed-PR refusal
 * (or its absence) is where it would show.
 * @param {string} branchName
 * @param {{ run?: typeof gh, requiredContexts?: typeof lookupRequiredContexts, checkRuns?: typeof lookupCheckRuns }} [deps]
 * @returns {{ number: number | null, armed: boolean, green: boolean | null, behindBy: number | null } | null}
 */
export function lookupArmedPrStatus(branchName,
  { run = gh, requiredContexts = lookupRequiredContexts, checkRuns = lookupCheckRuns } = {}) {
  return lookup(() => {
    const prs = JSON.parse(run(["pr", "list", "--repo", REPO, "--head", branchName, "--state", "open",
      "--json", "number,autoMergeRequest,headRefOid"]));
    if (prs.length === 0) return { number: null, armed: false, green: false, behindBy: null };
    const pr = prs[0];
    const armed = pr.autoMergeRequest != null;
    if (!armed) return { number: pr.number, armed: false, green: false, behindBy: null };
    const required = requiredContexts();
    const runs = checkRuns(pr.headRefOid);
    if (required === null || runs === null) {
      return { number: pr.number, armed: true, green: null, behindBy: null };
    }
    const reasons = checkReasons({ headRefOid: pr.headRefOid }, required, runs);
    const green = reasons.length === 0;
    const behindBy = green ? lookup(() => {
      const value = JSON.parse(run(["api", `repos/${REPO}/compare/main...${pr.headRefOid}`])).behind_by;
      return typeof value === "number" ? value : null;
    }) : null;
    return { number: pr.number, armed: true, green, behindBy };
  });
}

/**
 * Should THIS push be refused because it would race a merge that could complete underneath it? Armed,
 * already-green AND up-to-date with `main` refuses -- everything else is the sanctioned route and must
 * stay silent: no PR yet (the first push is how one gets opened), a PR whose gate is FAILURE or still
 * PENDING (pushing before green is normal), `green: null` (armed, but could not confirm green), armed +
 * green + BEHIND (#442, below), and top-level `null` (could not ask at all).
 *
 * #442: ARMED + GREEN + BEHIND ALLOWS, and this is the one case that changed. Strict branch protection
 * (restored 02:15Z) blocks a merge from completing while the head is behind `main`'s tip -- so a merge
 * this push could race CANNOT FIRE, and the premise this rule was built on (a push might lose a race to a
 * merge that lands underneath it) is simply false here. Refusing anyway froze every PR that went green and
 * then fell behind -- which under strict protection is the NORMAL state, since every merge to `main` puts
 * every other open PR behind again -- with the sync that would un-freeze it refused by the very rule whose
 * premise had moved. `behindBy === 0` is the up-to-date case (#386's real one, unchanged); anything else --
 * a positive count, or `null` because it could not be determined -- does not race.
 *
 * FAILS OPEN, DELIBERATELY, and this is the opposite of `merge-guard.mjs`'s own "could not ask is not
 * clean" rule elsewhere: that rule protects a VERDICT about evidence; this protects a developer's ability
 * to push at all. A convenience guard against a race is not a correctness gate, and a hook that blocks
 * work when the network is down or `gh` is unauthenticated gets deleted within a day (CLAUDE.md already
 * records `A11Y_SKIP_VERIFY=1` reached for six times in one evening for exactly that reason).
 *
 * @param {{ armed: boolean, green: boolean | null, behindBy?: number | null } | null} status
 * @returns {boolean}
 */
export function racesAnArmedMerge(status) {
  if (!status) return false;
  if (!(status.armed && status.green === true)) return false;
  return status.behindBy === 0;
}
