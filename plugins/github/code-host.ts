// module: the GitHub code host -- the reads ticket mode makes of a pull request, the sweep that retargets a stacked one, the checks' logs and reruns, the review claim and the verdict door (A11-160)
//
// ONE `gh` RUNNER (`gh.ts`) serves every operation, so this file is the one place a call to GitHub is made on ticket mode's behalf. The reads answer `null` for "could not ask", never
// for "there is none", as the contract says.
//
// THE CODE HOST PORT'S OPERATIONS ARE NOT MADE YET, and say so rather than guess: nothing in ticket mode calls them. `readChange` answers `null` ("could not ask": a caller that
// acts on it acts on a guess, so none does), `requestReview` and `armMerge` throw, which the port defines as "the request could not be made", and `subscribe` hands back its
// canceller and delivers nothing: a subscriber is told to read again, and every reader here polls (a later step of A11-160 gives `armMerge` its real implementation, with the merge's calls).
import { fileURLToPath } from "node:url";
import type { ChangeRef, CodeHost, VerdictDoor } from "../../src/plugins/contracts/code-host.ts";
import type { PluginDeps } from "../../src/plugins/manifest.ts";
import { readCheckLog, rerunFailedChecks } from "./check-runs.ts";
import { ghRunner } from "./gh.ts";
import { openPullUrlsOf } from "./open-pulls.ts";
import { readOwnLogin, readPullFeedback } from "./pull-feedback.ts";
import { readMergedFindings } from "./merged-findings.ts";
import { readReplies } from "./replies.ts";
import { readReviewClaims, writeReviewClaim } from "./review-claims.ts";
import { readPullState, readReviewState } from "./reviews.ts";
import { sweepRetargets } from "./stack-retarget.ts";
import { createWrapper } from "./wrapper.ts";

/** The verdict door and the program that installs it, shipped beside this file. */
const VERDICT_DOOR: VerdictDoor = {
  source: fileURLToPath(new URL("./reviewer/pr-review-verdict.sh", import.meta.url)),
  installer: fileURLToPath(new URL("./reviewer/install-reviewer-bin.sh", import.meta.url)),
};

const notYet = (operation: string, ref: ChangeRef): never => {
  throw new Error(`the GitHub plugin does not ${operation} yet (${ref.id})`);
};

/** The GitHub code host, reading and moving pull requests through the plugin's `gh`. */
export function createCodeHost(deps: PluginDeps): CodeHost {
  const gh = ghRunner(deps);
  return {
    readOwnLogin: () => readOwnLogin(gh),
    readPullFeedback: (url, self, alsoIgnore) => readPullFeedback(url, self, gh, deps.policy, alsoIgnore),
    readReplies: (url, request) => readReplies(url, request, gh),
    readReviewState: (url) => readReviewState(url, gh, deps.policy),
    readPullState: (url) => readPullState(url, gh),
    readMergedFindings: (url) => readMergedFindings(url, gh),
    openPullUrlsOf: (repository) => openPullUrlsOf(repository, gh),
    sweepRetargets: (sweep) => sweepRetargets({ ...sweep, gh }),
    readCheckLog: (detailsUrl) => readCheckLog(detailsUrl, gh, deps.log),
    rerunFailedChecks: (detailsUrls) => rerunFailedChecks(detailsUrls, gh),
    readReviewClaims: (repository, head) => readReviewClaims(repository, head, gh),
    // The claim is written as the reviewer role: the environment it is given (the account folder and token the reviewer acts with) is laid over this process's for the one call.
    writeReviewClaim: (write) => writeReviewClaim(write, ghRunner(deps, write.environment)),
    verdictDoor: VERDICT_DOOR,
    readChange: () => null,
    requestReview: (ref) => notYet("request a review", ref),
    armMerge: (ref) => notYet("arm a merge", ref),
    subscribe: () => () => undefined,
    wrapper: createWrapper(deps),
  };
}
