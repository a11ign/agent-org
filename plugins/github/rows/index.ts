// module: the GitHub plugin's `rows` -- row mode's GitHub operations, behind the code host contract's optional group (A11-160, step 4)
//
// Each operation is a function of one of the files beside this one, which are the files `src/ticket-port/` held before row mode's GitHub calls moved here. THEY ARE MOVED, NOT REWRITTEN: an operation
// takes the `run` its caller hands it (the contract's head says why), reads GitHub's answer as it always did, and throws or answers `null` as it always did. What core owns that they read (the project's
// labels and board, how a row's waits and GitHub's rate-limit answers are read, the error a window throws) is `helpers`, asked when an operation needs it: a host with no project declaration builds a
// code host that has never been asked for a row.
import type { CodeHostRows, RowsHelpers } from "../../../src/plugins/contracts/code-host-rows.ts";
import { githubTicketAdapter, OPEN_ITEMS_QUERY, TRACKER } from "./adapter.ts";
import { approvalFactsOf, latestApprovals } from "./approval-reads.ts";
import { createRow, editComment, keyedCommentsOf, mergedWindowOf, openPullsOf as openPullFieldsOf, postRowComment, reviewsOf } from "./approved-unqueued-reads.ts";
import { disableAutoMergeOf, readDisarmSeat } from "./auto-merge-disarm.ts";
import { boardFiledRow } from "./board-filed-row.ts";
import { briefChairmanOnPull } from "./chairman-brief.ts";
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
import { repoCloneArgs, repoViewArgs } from "./repo-args.ts";
import { forgetRefusedReads, isRowsByLabelRead, readClaimedRows, readRowsByLabel, readUnlessRefused } from "./rows-by-label.ts";
import { asListJson, foldPage, isSinceRead, parsePage, readMergedPullRequests, readRowsSince, SINCE_PAGE_SIZE, sincePageArgs } from "./rows-since.ts";
import { testsFirstReadsOf } from "./tests-first-reads.ts";

/** The values of the rows, and the operations that read the project's declaration: what core hands over as `helpers`, asked when an operation needs it. */
function projectRows(helpers: () => RowsHelpers): Pick<CodeHostRows, "tracker" | "sincePageSize" | "projectItemsPage" | "openItemsQuery" | "corePoolProbe" | "ticketAdapter" | "boardFiledRow" | "isIssueOnBoard" | "boardItemOf"> {
  return {
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
  latestApprovals, approvalFactsOf, keyedCommentsOf, postRowComment, createRow, editComment, reviewsOf, mergedWindowOf, openPullFieldsOf, readDisarmSeat, disableAutoMergeOf, briefChairmanOnPull,
  headOfChange, checkRunsOfHead, workflowRunsOf, jobsOfRun, failedLogOfRun, stateOfRow, redRunOfHead, rerunFailedJobsOf, closeRowWithComment, commentsSince, conditionalGetArgs, pullViewArgs,
  pullTextOf, branchRefTextOf, addedFilesTextOf, fileAtTextOf, defaultBranchFileTextOf, commentOnIssue, openIncidentsOf, readOpenPullHeads, openPullBodiesOf, outsideArmListArgs, readyPullRequest,
  ensureTriageLabel, pullRequestFieldsOf, queueEntriesOf, mergeGroupRunCountOf, dequeuePullRequestOf, jobLogOf, closedIncidentsOf, createIncident, closeIncident, repoViewArgs, repoCloneArgs,
  testsFirstReadsOf, isRowsByLabelRead, forgetRefusedReads, isSinceRead, parsePage, sincePageArgs, asListJson,
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

/** The GitHub code host's `rows`. `helpers` is what core owns of row mode, asked when an operation needs it. */
export function createRows(helpers: () => RowsHelpers): CodeHostRows {
  return { ...projectRows(helpers), ...pullRequestRows, ...listRows(helpers) };
}
