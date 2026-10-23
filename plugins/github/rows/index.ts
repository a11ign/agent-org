// module: the GitHub plugin's `rows` -- row mode's GitHub operations, behind the code host contract's optional group (A11-160, step 4)
//
// Each operation is a function of one of the files beside this one, which are the files `src/ticket-port/` held before row mode's GitHub calls moved here. THEY ARE MOVED, NOT REWRITTEN: an operation
// takes the `run` its caller hands it (the contract's head says why), reads GitHub's answer as it always did, and throws or answers `null` as it always did. What core owns that they read (the project's
// labels and board, how a row's waits and GitHub's rate-limit answers are read, the error a window throws) is `helpers`, asked when an operation needs it: a host with no project declaration builds a
// code host that has never been asked for a row.
import type { BatchAnswer, BatchCall, CodeHostRows, GateRunOptions, AimedRun, RowsHelpers, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import { githubTicketAdapter, OPEN_ITEMS_QUERY, TRACKER } from "./adapter.ts";
import { closedClaimedRowsOf, closedRowsCarryingLabels } from "./gate-closed-reads.ts";
import { actionsJobOf, checkRunSummariesAt, commitShasOf, compareDiffOf, failingCheckNamesAt, jobsOfMergeGroupRun, labelNamesWithPrefix, mainTipOf, mergeGroupRunsOf, newestMergedPulls, openPullListArgs, openRowsOf, pullFileNamesOf, pullsOfBranch, readRequiredContexts } from "./gate-pull-reads.ts";
import { closedPullsPage, incidentItemOf, issueEventsPage, labeledEventTimesOf, newestCommentsOf, newestLabellerOf, recentlyClosedRowsOf, commentActivityOf, rowBodyOf, rowForPromotion, rowStateAndNewestComment, rowTimelineOf, tagExistsOn, unlabeledEventsOf, waitRefOf } from "./gate-row-reads.ts";
import { addLabelToRow, addLabelToRowByApi, addRowToProject, commentBodiesOfRow, commentOnRow, ensureLabel, fileLabelledRow, markPullReady, removeLabelFromRow, setProjectStatus, setRowBody } from "./gate-row-writes.ts";
import { approvalFactsOf, latestApprovals } from "./approval-reads.ts";
import { armedFromApi, armedNodeOf, armedQueryArgs, armedReason, ejectionQueryArgs, queueEjectionOf, readQueueEjection } from "./armed-state.ts";
import { addLabelsToPull, armedReasonOf, armMergeOf, armPullAuto, commentOnPull, dequeueByHandCommand, jumpToFront, labelsOfRow, openBlockersOf, openBlockersOfRow, pullStateOf, readPullComments, readPullForArming, readQueueSeat, settledReason, trunkRunsPage } from "./arming.ts";
import { createRow, editComment, keyedCommentsOf, mergedWindowOf, openPullsOf as openPullFieldsOf, postRowComment, reviewsOf } from "./approved-unqueued-reads.ts";
import { disableAutoMergeOf, readDisarmSeat } from "./auto-merge-disarm.ts";
import { boardFiledRow } from "./board-filed-row.ts";
import { briefChairmanOnPull } from "./chairman-brief.ts";
import { behindByOf, checkRunsOfCommit, closingIssuesOf, compareWithMain, deleteBranchOf, mainTipDateOf, mergeQueuedPull, openPullsForQueue, openPullsOfBranch, pullForCiGate, pullForGuard, pullOutcomeOf, recentClosesPrsOf, requiredContextsOf } from "./merge-guard-reads.ts";
import { checkRunsOfHead, failedLogOfRun, headOfChange, jobsOfRun, redRunOfHead, rerunFailedJobsOf, stateOfRow, workflowRunsOf } from "./ci-reads.ts";
import { closeRowWithComment } from "./close-row.ts";
import { commentsSince } from "./comments-since.ts";
import { conditionalGetArgs, pullViewArgs } from "./conditional-reads.ts";
import { CORE_POOL_PROBE } from "./core-pool-probe.ts";
import { addedFilesTextOf, branchRefTextOf, defaultBranchFileTextOf, fileAtTextOf, pullTextOf } from "./deliberate-refusal-reads.ts";
import { commentOnIssue } from "./issue-comment.ts";
import { openIncidentsOf } from "./open-incidents.ts";
import { readOpenPullHeads } from "./open-pull-heads.ts";
import { openPullsOf as openPullBodiesOf } from "./open-pulls.ts";
import { outsideArmListArgs, readyPullRequest } from "./outside-arm-calls.ts";
import { ensureTriageLabel } from "./outside-idle-writes.ts";
import { boardItemOf, isIssueOnBoard, PROJECT_ITEMS_PAGE } from "./project-membership.ts";
import { pullRequestFieldsOf } from "./pull-request-fields.ts";
import { dequeuePullRequestOf, mergeGroupRunCountOf, queueEntriesOf } from "./queue-entry-reads.ts";
import { closeIncident, closedIncidentsOf, createIncident, jobLogOf } from "./release-incidents.ts";
import { forgetRefusedReads, isRowsByLabelRead, readClaimedRows, readRowsByLabel, readUnlessRefused } from "./rows-by-label.ts";
import { asListJson, foldPage, isSinceRead, parsePage, readMergedPullRequests, readRowsSince, SINCE_PAGE_SIZE, sincePageArgs } from "./rows-since.ts";
import { isArmedPull, isCrossRepositoryPull, isMergedPull, openPullRequestsQueryArgs, readOpenPullNodes, readOutsideArmListed, readSweepFacts } from "./sweep-reads.ts";
import { testsFirstReadsOf } from "./tests-first-reads.ts";

/** The values of the rows, and the operations that read the project's declaration: what core hands over as `helpers`, asked when an operation needs it. */
function projectRows(helpers: () => RowsHelpers): Pick<CodeHostRows, "acts" | "tracker" | "sincePageSize" | "projectItemsPage" | "openItemsQuery" | "corePoolProbe" | "ticketAdapter" | "boardFiledRow" | "isIssueOnBoard" | "boardItemOf"> {
  return {
    acts: "through-run",
    tracker: TRACKER,
    sincePageSize: SINCE_PAGE_SIZE,
    projectItemsPage: PROJECT_ITEMS_PAGE,
    openItemsQuery: OPEN_ITEMS_QUERY,
    corePoolProbe: CORE_POOL_PROBE,
    ticketAdapter: (options) => githubTicketAdapter(options, helpers()),
    boardFiledRow: (request) => boardFiledRow(request, helpers().homeTracker()),
    isIssueOnBoard: (issueNumber, { read, tracker }) => isIssueOnBoard(issueNumber, { read, tracker: tracker ?? helpers().homeTracker() }),
    boardItemOf,
  };
}

/** The reads and writes of pull requests, checks, comments, incidents and the merge queue, which read nothing of core's. */
const pullRequestRows = {
  latestApprovals, keyedCommentsOf, postRowComment, createRow, editComment, reviewsOf, mergedWindowOf, openPullFieldsOf, briefChairmanOnPull,
  headOfChange, checkRunsOfHead, workflowRunsOf, jobsOfRun, failedLogOfRun, stateOfRow, redRunOfHead, rerunFailedJobsOf, closeRowWithComment, commentsSince, conditionalGetArgs, pullViewArgs,
  pullTextOf, branchRefTextOf, addedFilesTextOf, fileAtTextOf, defaultBranchFileTextOf, commentOnIssue, openIncidentsOf, readOpenPullHeads, openPullBodiesOf, outsideArmListArgs,
  ensureTriageLabel, pullRequestFieldsOf, queueEntriesOf, mergeGroupRunCountOf, jobLogOf, closedIncidentsOf, createIncident, closeIncident,
  isRowsByLabelRead, forgetRefusedReads, isSinceRead, parsePage, sincePageArgs, asListJson,
};

/** The reads of rows by label and of windows of rows, which read GitHub's rate-limit answers and the claim label, and throw core's error for a window too long. */
function listRows(helpers: () => RowsHelpers): Pick<CodeHostRows, "readUnlessRefused" | "readRowsByLabel" | "readClaimedRows" | "foldPage" | "readRowsSince" | "readMergedPullRequests"> {
  const sincing = () => ({ pool: helpers().pool, WindowCutShort: helpers().WindowCutShort });
  return {
    readUnlessRefused: (request) => readUnlessRefused({ ...request, pool: helpers().pool }),
    readRowsByLabel: (ask) => readRowsByLabel(ask, helpers().pool),
    readClaimedRows: (request) => readClaimedRows(request, { pool: helpers().pool, claimLabel: helpers().claimLabel }),
    foldPage: (request) => foldPage(request, helpers().WindowCutShort),
    readRowsSince: (request) => readRowsSince(request, sincing()),
    readMergedPullRequests: (request) => readMergedPullRequests(request, sincing()),
  };
}

/**
 * The runners the plugin gives an operation whose caller hands none: `own` runs `gh` as the process's account, and `queue` runs it with the git environment variables a hook sets taken off (the merge queue's
 * dispatcher is started from a worktree, where they would aim `gh` at the wrong repository).
 */
export type RowsRunners = Readonly<{
  own: RowsRun; queue: RowsRun;
  /** The work gate's executor's process (`gateRun`), and a batch of calls started at once (`runTogether`): absent, an operation that asks for one is refused. */
  gate?: (options: GateRunOptions) => AimedRun;
  together?: (request: { calls: BatchCall[]; env: NodeJS.ProcessEnv; callMs: number; graceMs: number; maxBuffer: number }) => BatchAnswer[];
}>;

const NO_RUNNER: RowsRun = () => {
  throw new Error("this code host's rows were built with no runner of their own, so an operation whose caller hands none cannot run");
};

const NO_RUNNERS: RowsRunners = { own: NO_RUNNER, queue: NO_RUNNER };

const NO_BATCH = (): never => {
  throw new Error("this code host's rows were built with no runner of their own, so a batch of calls cannot run");
};

/** An operation with a `run` in its request, made to use `own` when the caller hands none. */
const withOwnRun = <Request extends { run: RowsRun }, Result>(operation: (request: Request) => Result, own: RowsRun) =>
  (request: Omit<Request, "run"> & { run?: RowsRun }): Result => operation({ ...request, run: request.run ?? own } as Request);

/** The operations a moved caller reaches without a `run` of its own, and the 1.7 ones among them that took one. */
function movedCallers(helpers: () => RowsHelpers, { own, queue }: RowsRunners): Omit<CodeHostRows, keyof ReturnType<typeof projectRows> | keyof typeof pullRequestRows | keyof ReturnType<typeof listRows> | keyof typeof gateRows | "gateRun" | "runTogether" | "recentlyClosedRowsOf" | "closedRowsCarryingLabels"> {
  return {
    ownRun: own,
    armedQueryArgs, armedFromApi, armedReason, ejectionQueryArgs, queueEjectionOf, openBlockersOf, settledReason, dequeueByHandCommand, openPullRequestsQueryArgs,
    armedNodeOf: withOwnRun(armedNodeOf, own), armedReasonOf: withOwnRun(armedReasonOf, own), readQueueEjection: withOwnRun(readQueueEjection, own),
    openBlockersOfRow: withOwnRun(openBlockersOfRow, own), labelsOfRow: withOwnRun(labelsOfRow, own), readPullComments: withOwnRun(readPullComments, own), commentOnPull: withOwnRun(commentOnPull, own),
    addLabelsToPull: withOwnRun(addLabelsToPull, own), readPullForArming: withOwnRun(readPullForArming, own), pullStateOf: withOwnRun(pullStateOf, own), armPullAuto: withOwnRun(armPullAuto, own),
    armMergeOf: (request, seams) => armMergeOf({ ...request, run: request.run ?? own }, seams), trunkRunsPage: withOwnRun(trunkRunsPage, own),
    readQueueSeat: withOwnRun(readQueueSeat, own), jumpToFront: withOwnRun(jumpToFront, own),
    graphqlPoolOf: (run = own) => helpers().pool.fromResponse(helpers().pool.rawResponse(helpers().pool.probe, run)),
    readOpenPullNodes: withOwnRun(readOpenPullNodes, own), isMergedPull: withOwnRun(isMergedPull, own), isArmedPull: withOwnRun(isArmedPull, own), readSweepFacts: withOwnRun(readSweepFacts, own),
    isCrossRepositoryPull: withOwnRun(isCrossRepositoryPull, own), readOutsideArmListed: withOwnRun(readOutsideArmListed, own),
    requiredContextsOf: withOwnRun(requiredContextsOf, own), checkRunsOfCommit: withOwnRun(checkRunsOfCommit, own), mainTipDateOf: withOwnRun(mainTipDateOf, own), behindByOf: withOwnRun(behindByOf, own),
    closingIssuesOf: withOwnRun(closingIssuesOf, own), recentClosesPrsOf: withOwnRun(recentClosesPrsOf, own), pullForGuard: withOwnRun(pullForGuard, own), pullForCiGate: withOwnRun(pullForCiGate, own),
    pullOutcomeOf: withOwnRun(pullOutcomeOf, own), openPullsOfBranch: withOwnRun(openPullsOfBranch, own),
    openPullsForQueue: (request = {}) => openPullsForQueue({ run: request.run ?? queue }), mergeQueuedPull: withOwnRun(mergeQueuedPull, queue), compareWithMain: withOwnRun(compareWithMain, queue), deleteBranchOf: withOwnRun(deleteBranchOf, queue),
    approvalFactsOf: (pull, run = own) => approvalFactsOf(pull, run), readDisarmSeat: withOwnRun(readDisarmSeat, own), disableAutoMergeOf: withOwnRun(disableAutoMergeOf, own), readyPullRequest: withOwnRun(readyPullRequest, own),
    dequeuePullRequestOf: withOwnRun(dequeuePullRequestOf, own), testsFirstReadsOf: (request, run = own) => testsFirstReadsOf(request, run),
  };
}

/** The reads and writes of the work gate (contract 1.9), which read nothing of core's: each takes the `run` the gate hands it. */
const gateRows = {
  unlabeledEventsOf, labeledEventTimesOf, newestLabellerOf, commentActivityOf, rowTimelineOf, waitRefOf, incidentItemOf, rowBodyOf, rowStateAndNewestComment, rowForPromotion, issueEventsPage, closedPullsPage, tagExistsOn, newestCommentsOf,
  commentOnRow, commentBodiesOfRow, addLabelToRow, removeLabelFromRow, setRowBody, ensureLabel, fileLabelledRow, addLabelToRowByApi, markPullReady, addRowToProject, setProjectStatus,
  readRequiredContexts, mainTipOf, pullsOfBranch, newestMergedPulls, openPullListArgs, pullFileNamesOf, commitShasOf, compareDiffOf, failingCheckNamesAt, checkRunSummariesAt, mergeGroupRunsOf, jobsOfMergeGroupRun, actionsJobOf, openRowsOf, labelNamesWithPrefix, closedClaimedRowsOf,
};

/** The gate's operations that read the tick's refusal memory (which reads GitHub's rate-limit answers, core's) and the gate's executor's process. */
function gateRowsOf(helpers: () => RowsHelpers, { gate, together }: RowsRunners): Pick<CodeHostRows, "gateRun" | "runTogether" | "recentlyClosedRowsOf" | "closedRowsCarryingLabels"> {
  return {
    gateRun: gate ?? (() => NO_RUNNER),
    runTogether: together ?? NO_BATCH,
    recentlyClosedRowsOf: (request) => recentlyClosedRowsOf(request, helpers().pool),
    closedRowsCarryingLabels: (request) => closedRowsCarryingLabels(request, helpers().pool),
  };
}

/** The GitHub code host's `rows`. `helpers` is what core owns of row mode, asked when an operation needs it; `runners` are the plugin's own, for the operations whose caller hands none. */
export function createRows(helpers: () => RowsHelpers, runners: RowsRunners = NO_RUNNERS): CodeHostRows {
  return { ...projectRows(helpers), ...pullRequestRows, ...listRows(helpers), ...movedCallers(helpers, runners), ...gateRows, ...gateRowsOf(helpers, runners) };
}
