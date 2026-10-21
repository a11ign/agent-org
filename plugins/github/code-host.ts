// module: the GitHub code host -- the seven reads ticket mode makes of a pull request, and the sweep that retargets a stacked one (A11-160)
//
// ONE `gh` RUNNER (`gh.ts`) serves every operation, so this file is the one place a call to GitHub is made on ticket mode's behalf. The reads answer `null` for "could not ask", never
// for "there is none", as the contract says.
//
// THE CODE HOST PORT'S OPERATIONS ARE NOT MADE YET, and say so rather than guess: nothing in ticket mode calls them. `readChange` answers `null` ("could not ask": a caller that
// acts on it acts on a guess, so none does), `requestReview` and `armMerge` throw, which the port defines as "the request could not be made", and `subscribe` hands back its
// canceller and delivers nothing: a subscriber is told to read again, and every reader here polls (a later step of A11-160 gives `armMerge` its real implementation, with the merge's calls).
import type { ChangeRef, CodeHost } from "../../src/plugins/contracts/code-host.ts";
import type { PluginDeps } from "../../src/plugins/manifest.ts";
import { ghRunner } from "./gh.ts";
import { openPullUrlsOf } from "./open-pulls.ts";
import { readOwnLogin, readPullFeedback } from "./pull-feedback.ts";
import { readReplies } from "./replies.ts";
import { readPullState, readReviewState } from "./reviews.ts";
import { sweepRetargets } from "./stack-retarget.ts";
import { createWrapper } from "./wrapper.ts";

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
    openPullUrlsOf: (repository) => openPullUrlsOf(repository, gh),
    sweepRetargets: (sweep) => sweepRetargets({ ...sweep, gh }),
    readChange: () => null,
    requestReview: (ref) => notYet("request a review", ref),
    armMerge: (ref) => notYet("arm a merge", ref),
    subscribe: () => () => undefined,
    wrapper: createWrapper(deps),
  };
}
