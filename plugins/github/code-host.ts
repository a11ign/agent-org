// module: the GitHub code host -- the reads ticket mode makes of a pull request, the sweep that retargets a stacked one, the checks' logs and reruns, the review claim and the verdict door (A11-160)
//
// ONE `gh` RUNNER (`gh.ts`) serves every operation, so this file is the one place a call to GitHub is made on ticket mode's behalf. The reads answer `null` for "could not ask", never
// for "there is none", as the contract says.
//
// THE CODE HOST PORT'S OPERATIONS ARE NOT ALL MADE YET, and say so rather than guess: nothing in ticket mode calls them. `readChange` answers `null` ("could not ask": a caller that
// acts on it acts on a guess, so none does), `requestReview` throws, which the port defines as "the request could not be made", and `subscribe` hands back its canceller and delivers
// nothing: a subscriber is told to read again, and every reader here polls. `armMerge` is real since step 5: it arms the merge and reads the pull request back.
import { fileURLToPath } from "node:url";
import type { ChangeRef, CodeHost, VerdictDoor } from "../../src/plugins/contracts/code-host.ts";
import type { PluginDeps } from "../../src/plugins/manifest.ts";
import { readCiRun } from "./ci-run.ts";
import { readBranchCi } from "./ci-spend.ts";
import { readCheckLog, rerunFailedChecks } from "./check-runs.ts";
import { readDefaultBranchRed } from "./default-branch-checks.ts";
import { ghRunner } from "./gh.ts";
import { openPullUrlsOf } from "./open-pulls.ts";
import { createRepositories } from "./repositories.ts";
import { readOwnLogin, readPullFeedback } from "./pull-feedback.ts";
import { readClosedWork } from "./closed-work.ts";
import { holdPullRequest, readQueueFailure, releasePullRequest } from "./merge-queue.ts";
import { readMergedFindings } from "./merged-findings.ts";
import { repoCloneArgs, repoViewArgs } from "./repo-args.ts";
import { readReplies } from "./replies.ts";
import { pullsNaming } from "./ticket-pulls.ts";
import { openDependencyPulls } from "./dependency-pulls.ts";
import { readReviewClaims, writeReviewClaim } from "./review-claims.ts";
import { readPullState, readReviewState } from "./reviews.ts";
import { requestStackMerge, stackMergeFactsOf } from "./stack-merge.ts";
import { sweepRetargets } from "./stack-retarget.ts";
import { updateBranch } from "./update-branch.ts";
import { closePull } from "./close-pull.ts";
import { armedReasonOf, armMergeOf, type ArmMergeSeams } from "./rows/arming.ts";
import { createRows, type RowsRunners } from "./rows/index.ts";
import { gateRunner, runGhTogether } from "./rows/gate-runner.ts";
import { answeringRunnerWith, asyncRunnerWith, runnerWith } from "./rows/runners.ts";
import { createWrapper } from "./wrapper.ts";

/** The verdict door and the program that installs it, shipped beside this file. */
const VERDICT_DOOR: VerdictDoor = {
  source: fileURLToPath(new URL("./reviewer/pr-review-verdict.sh", import.meta.url)),
  installer: fileURLToPath(new URL("./reviewer/install-reviewer-bin.sh", import.meta.url)),
};

const notYet = (operation: string, ref: ChangeRef): never => {
  throw new Error(`the GitHub plugin does not ${operation} yet (${ref.id})`);
};

/** A change's address as the port spells it, `owner/name#number`. */
function pullOf(ref: ChangeRef): { repo: string; number: string } {
  const at = ref.id.lastIndexOf("#");
  if (at <= 0 || at === ref.id.length - 1) throw new Error(`a change of the GitHub plugin is addressed owner/name#number, not ${ref.id}`);
  return { repo: ref.id.slice(0, at), number: ref.id.slice(at + 1) };
}

/**
 * The runners row mode's operations use when their caller hands none, and the work gate's executor's process. The first two let `gh`'s stderr through to this process's own, as `execFileSync` did for the callers that moved; the queue's takes the git
 * variables a hook sets off the environment of each call (the dispatcher is started from a worktree), the ones that are set when the call is made.
 */
function rowsRunners(deps: PluginDeps): RowsRunners {
  const echo = deps.log;
  return {
    own: ghRunner(deps, {}, { echo }),
    queue: ghRunner(deps, {}, { echo, withoutEnv: () => Object.keys(deps.env).filter((name) => name.startsWith("GIT_")) }),
    within: (timeoutMs, options) => ghRunner(deps, {}, { echo, timeoutMs, ...(options?.withoutGitEnv ? { withoutEnv: () => Object.keys(deps.env).filter((name) => name.startsWith("GIT_")) } : {}) }),
    gate: (options) => gateRunner(deps, options),
    together: (request) => runGhTogether(deps, request),
    with: (request) => runnerWith(deps, request),
    withAsync: (request) => asyncRunnerWith(deps, request),
    withAnswer: (request) => answeringRunnerWith(deps, request),
  };
}

/** The GitHub code host, reading and moving pull requests through the plugin's `gh`. `settle` is how `armMerge` waits for a pull request that may have settled (a test gives none to wait for). */
export function createCodeHost(deps: PluginDeps, settle: ArmMergeSeams = {}): CodeHost {
  const gh = ghRunner(deps);
  return {
    repoViewArgs,
    repoCloneArgs,
    readOwnLogin: () => readOwnLogin(gh),
    readPullFeedback: (url, self, alsoIgnore) => readPullFeedback(url, self, gh, deps.policy, alsoIgnore),
    readQueueFailure: (url, groupCommit) => readQueueFailure(url, groupCommit, gh),
    holdFromQueue: (url, on) => (on ? holdPullRequest(url, gh) : releasePullRequest(url, gh)),
    readDefaultBranchRed: (repository) => readDefaultBranchRed(repository, gh, deps.policy),
    readReplies: (url, request) => readReplies(url, request, gh),
    readReviewState: (url) => readReviewState(url, gh, deps.policy),
    readPullState: (url) => readPullState(url, gh),
    readMergedFindings: (url) => readMergedFindings(url, gh),
    readClosedWork: (url) => readClosedWork(url, gh),
    openPullUrlsOf: (repository) => openPullUrlsOf(repository, gh),
    pullsNaming: (key, repositories) => pullsNaming(key, repositories, gh),
    openDependencyPulls: (repository) => openDependencyPulls(repository, gh),
    sweepRetargets: (sweep) => sweepRetargets({ ...sweep, gh }),
    stackMergeFactsOf: (url) => stackMergeFactsOf(url, gh),
    requestStackMerge: (request) => requestStackMerge(request, gh),
    readCiRun: (repository, runId) => readCiRun(repository, runId, gh),
    readBranchCi: (repository, branch, settled) => readBranchCi(repository, branch, settled, gh),
    readCheckLog: (detailsUrl) => readCheckLog(detailsUrl, gh, deps.log),
    rerunFailedChecks: (detailsUrls) => rerunFailedChecks(detailsUrls, gh),
    updateBranch: (url, expectedHead) => updateBranch(url, expectedHead, gh),
    closePull: (url, comment) => closePull(url, comment, gh),
    readReviewClaims: (repository, head) => readReviewClaims(repository, head, gh),
    // The claim is written as the reviewer role: the environment it is given (the account folder and token the reviewer acts with) is laid over this process's for the one call.
    writeReviewClaim: (write) => writeReviewClaim(write, ghRunner(deps, write.environment)),
    verdictDoor: VERDICT_DOOR,
    readChange: () => null,
    requestReview: (ref) => notYet("request a review", ref),
    // The arm, then the pull request read back: an arm that exited well is not "armed" (#1022), and a pull request that merged or was queued meanwhile has nothing left to arm and reads as armed.
    armMerge: (ref) => {
      const { repo, number } = pullOf(ref);
      armMergeOf({ repo, number, run: gh }, settle);
      return armedReasonOf({ repo, number, run: gh }) !== null;
    },
    subscribe: () => () => undefined,
    wrapper: createWrapper(deps),
    repositories: createRepositories(deps),
    rows: createRows(deps.rows, rowsRunners(deps)),
  };
}
