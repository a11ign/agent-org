// module: the GitHub code host -- the reads ticket mode makes of a pull request, the sweep that retargets a stacked one, the checks' logs and reruns, the review claim and the verdict door (A11-160)
//
// ONE `gh` RUNNER (`gh.ts`) serves every operation, so this file is the one place a call to GitHub is made on ticket mode's behalf. EVERY PULL REQUEST THE SWEEPS READ COMES FROM ONE SNAPSHOT PER REPOSITORY (`pull-snapshot.ts`, A11-365), shared by every reader and dropped by
// every write; the REST reads that repeat are conditional (`conditional-reads.ts`); and every `gh` started is counted (`call-counter.ts`), which `readCallCounts` serves to `/api/health`. The reads answer `null` for "could not ask", never
// for "there is none", as the contract says.
//
// THE CODE HOST PORT'S OPERATIONS ARE NOT ALL MADE YET, and say so rather than guess: nothing in ticket mode calls them. `readChange` answers `null` ("could not ask": a caller that
// acts on it acts on a guess, so none does), `requestReview` throws, which the port defines as "the request could not be made", and `subscribe` hands back its canceller and delivers
// nothing: a subscriber is told to read again, and every reader here polls. `armMerge` is real since step 5: it arms the merge and reads the pull request back.
import { fileURLToPath } from "node:url";
import type { ChangeRef, CodeHost, VerdictDoor } from "../../src/plugins/contracts/code-host.ts";
import type { PluginDeps } from "../../src/plugins/manifest.ts";
import { createCallCounter, countingDeps } from "./call-counter.ts";
import { readCiRun } from "./ci-run.ts";
import { conditionalReads } from "./conditional-reads.ts";
import { createPullSnapshots } from "./pull-snapshot.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { readBranchCi } from "./ci-spend.ts";
import { readCheckLog, rerunFailedChecks, runsOf } from "./check-runs.ts";
import { readDefaultBranchRed } from "./default-branch-checks.ts";
import { asyncGhRunner, ghRunner } from "./gh.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { openPullUrlsOf } from "./open-pulls.ts";
import { createRepositories } from "./repositories.ts";
import { pullOf as pullAt, readOwnLoginAsync, readPullFeedback } from "./pull-feedback.ts";
import { readClosedWork } from "./closed-work.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { readMergeFlow } from "./merge-flow.ts";
import { holdPullRequest, readQueueFailure, releasePullRequest } from "./merge-queue.ts";
import { readMergedFindings } from "./merged-findings.ts";
import { repoCloneArgs, repoViewArgs } from "./repo-args.ts";
import { rerunRuns } from "./rerun-runs.ts";
import { readReplies } from "./replies.ts";
import { createReviewReads } from "./reviews.ts";
import { pullsNaming } from "./ticket-pulls.ts";
import { openDependencyPulls } from "./dependency-pulls.ts";
import { readReviewClaims, writeReviewClaim } from "./review-claims.ts";
import { requestStackMerge, stackMergeFactsOf } from "./stack-merge.ts";
import { sweepRetargets, sweepRetargetsAsync } from "./stack-retarget.ts";
import { updateBranch } from "./update-branch.ts";
import { closePull, commentOnPull } from "./close-pull.ts";
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

/** The two ways a write is run: it drops what was read of the `repositories` it touched, however it ended, so the next read of them is a fresh one. `writingAsync` is for a write that answers a promise (A11-282). */
function invalidatingWrites(snapshots: Pick<ReturnType<typeof createPullSnapshots>, "invalidate">) {
  const drop = (repositories: readonly string[]): void => { for (const repository of repositories) snapshots.invalidate(repository); };
  return {
    writing: <T>(repositories: readonly string[], write: () => T): T => {
      try {
        return write();
      } finally {
        drop(repositories);
      }
    },
    writingAsync: async <T>(repositories: readonly string[], write: () => Promise<T>): Promise<T> => {
      try {
        return await write();
      } finally {
        drop(repositories);
      }
    },
  };
}

/**
 * The GitHub code host, reading and moving pull requests through the plugin's `gh`. `settle` is how `armMerge` waits for a pull request that may have settled (a test gives none to wait for).
 * THE READS THE INSTANCE'S LOOP MAKES ON A SWEEP RUN THROUGH `deps.execAsync` (A11-356, contract 2.0), so the loop goes on while GitHub answers; `now` is the clock the shared answers are kept by.
 */
export function createCodeHost(rawDeps: PluginDeps, settle: ArmMergeSeams = {}, now: () => number = Date.now): CodeHost {
  const counter = createCallCounter({ now, log: rawDeps.log });
  const deps = countingDeps(rawDeps, counter);
  const gh = ghRunner(deps);
  const ghAsync = asyncGhRunner(deps);
  const restAsync = conditionalReads(ghAsync, counter);
  const snapshots = createPullSnapshots({ gh: ghAsync, now });
  const reviews = createReviewReads({ snapshots, now });
  /** The account `gh` acts as does not change while the board runs, so a login that was read is kept. */
  let ownLogin: string | null = null;
  /** The repository (`owner/name`) of the pull request at `url`, or none for an address that is no pull request. */
  const repositoriesOf = (url: string): string[] => { const pull = pullAt(url); return pull === null ? [] : [`${pull.owner}/${pull.repo}`]; };
  const { writing, writingAsync } = invalidatingWrites(snapshots);
  /** The repositories of the runs the addresses of failing checks name: a rerun changes the checks of the heads it reruns. */
  const rerunRepositories = (detailsUrls: readonly string[]): string[] => runsOf(detailsUrls).map(({ repo }) => repo);
  return {
    repoViewArgs,
    repoCloneArgs,
    readOwnLogin: async () => (ownLogin ??= await readOwnLoginAsync(ghAsync)),
    readPullFeedback: (url, self, alsoIgnore) => readPullFeedback(url, self, snapshots, deps.policy, alsoIgnore),
    readQueueFailure: (url, groupCommit) => readQueueFailure(url, groupCommit, gh),
    holdFromQueue: (url, on) => writing(repositoriesOf(url), () => (on ? holdPullRequest(url, gh) : releasePullRequest(url, gh))),
    readDefaultBranchRed: (repository) => readDefaultBranchRed(repository, gh, deps.policy),
    readMergeFlow: (repository) => readMergeFlow(repository, gh),
    readReplies: (url, request) => readReplies(url, request, snapshots),
    readReviewState: (url, options) => reviews.state(url, deps.policy, options),
    peekReviewState: (url) => reviews.peek(url),
    readPullState: (url) => reviews.pullState(url),
    readMergedFindings: (url) => readMergedFindings(url, snapshots, restAsync),
    readClosedWork: (url) => readClosedWork(url, gh),
    openPullUrlsOf: (repository) => openPullUrlsOf(repository, snapshots),
    pullsNaming: (key, repositories) => pullsNaming(key, repositories, gh),
    openDependencyPulls: (repository) => openDependencyPulls(repository, snapshots),
    sweepRetargets: (sweep) => writing(sweep.urls.flatMap(repositoriesOf), () => sweepRetargets({ ...sweep, gh })),
    sweepRetargetsAsync: (sweep) => writingAsync(sweep.urls.flatMap(repositoriesOf), () => sweepRetargetsAsync(sweep, ghAsync)),
    stackMergeFactsOf: (url) => stackMergeFactsOf(url, gh),
    requestStackMerge: (request) => writing([request.repo], () => requestStackMerge(request, gh)),
    readCiRun: (repository, runId) => readCiRun(repository, runId, gh),
    readBranchCi: (repository, branch, settled) => readBranchCi(repository, branch, settled, restAsync),
    readCheckLog: (detailsUrl) => readCheckLog(detailsUrl, gh, deps.log),
    rerunFailedChecks: (detailsUrls) => writing(rerunRepositories(detailsUrls), () => rerunFailedChecks(detailsUrls, gh)),
    rerunRuns: (detailsUrls) => writing(rerunRepositories(detailsUrls), () => rerunRuns(detailsUrls, gh)),
    updateBranch: (url, expectedHead) => writing(repositoriesOf(url), () => updateBranch(url, expectedHead, gh)),
    closePull: (url, comment) => writing(repositoriesOf(url), () => closePull(url, comment, gh)),
    commentOnPull: (url, comment) => writing(repositoriesOf(url), () => commentOnPull(url, comment, gh)),
    readReviewClaims: (repository, head) => readReviewClaims(repository, head, gh),
    // The claim is written as the reviewer role: the environment it is given (the account folder and token the reviewer acts with) is laid over this process's for the one call.
    // The claim is a commit status the rollup lists, green and not required: it changes no check a reader judges, so the snapshot is kept.
    writeReviewClaim: (write) => writeReviewClaim(write, ghRunner(deps, write.environment)),
    verdictDoor: VERDICT_DOOR,
    readChange: () => null,
    requestReview: (ref) => notYet("request a review", ref),
    // The arm, then the pull request read back: an arm that exited well is not "armed" (#1022), and a pull request that merged or was queued meanwhile has nothing left to arm and reads as armed.
    armMerge: (ref) => {
      const { repo, number } = pullOf(ref);
      return writing([repo], () => {
        armMergeOf({ repo, number, run: gh }, settle);
        return armedReasonOf({ repo, number, run: gh }) !== null;
      });
    },
    subscribe: () => () => undefined,
    readCallCounts: () => counter.read(),
    refreshPull: (url) => writing(repositoriesOf(url), () => undefined),
    wrapper: createWrapper(deps),
    repositories: createRepositories(deps),
    rows: createRows(deps.rows, rowsRunners(deps)),
  };
}
