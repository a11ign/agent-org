// module: the GitHub plugin's rows for the classes section of the contract (A11-160, step 9; moved from the callers named in each operation's comment)
//
// Each operation builds the argument list its caller built and reads GitHub's answer as the caller did, and THROWS when `gh` refuses: what a caller does with a refusal stays in core. `run` is the caller's executor,
// which every operation of this section takes.
import type { CodeHostRows, RowsHelpers } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { AnsweringRun, RunnerRequest } from "../../../src/plugins/contracts/code-host-rows-facts.ts";
import type { RowsClasses } from "../../../src/plugins/contracts/code-host-rows-classes.ts";
import type { RowsRunners } from "./index.ts";
import { changedFilesPageOf, fileSharedFailureRow, jobFailedStepOf, jobLogTextOf, jobOfCheckUrl, openPullBehindBy, pullMergedAtOf, recentRunsOf, redCheckOf, sharedFailureRowsOf, updatePullBranch } from "./class-ci-reads.ts";
import { closedClassRowsOf, closedRowsTitledOf, labelledRowsOf, mainCommitLoginsSince, mergedPullsSince, openRowsCarryingLabel } from "./class-row-reads.ts";
import { commentBodyOf, commentOnCheckoutRowByInput, postMarkedIssueComment } from "./class-comment-ops.ts";
import { readRowsByLabel } from "./rows-by-label.ts";
import { readMergedPullRequests } from "./rows-since.ts";

/** The operations of this section. */
export type ClassesRows = Pick<CodeHostRows, keyof RowsClasses>;

export function classesRowsOf(runners: RowsRunners, helpers: () => RowsHelpers): ClassesRows {
  const byLabel: Parameters<typeof sharedFailureRowsOf>[0] = (ask) => readRowsByLabel(ask, helpers().pool);
  const answering = (request: RunnerRequest): AnsweringRun => {
    if (runners.withAnswer === undefined) throw new Error("this code host's rows were built with no runner of their own, so a runner with a policy cannot be made");
    return runners.withAnswer(request);
  };
  const sincing = () => ({ pool: helpers().pool, WindowCutShort: helpers().WindowCutShort });
  return {
    redCheckOf, recentRunsOf, jobOfCheckUrl, jobFailedStepOf, jobLogTextOf, changedFilesPageOf, pullMergedAtOf, openPullBehindBy, updatePullBranch, fileSharedFailureRow,
    sharedFailureRowsOf: (request) => sharedFailureRowsOf(byLabel, request),
    closedClassRowsOf, closedRowsTitledOf, labelledRowsOf: (request) => labelledRowsOf(byLabel, request),
    mainCommitLoginsSince, mergedPullsSince: (request) => mergedPullsSince((ask) => readMergedPullRequests(ask, sincing()), request),
    postMarkedIssueComment, commentBodyOf, openRowsCarryingLabel,
    commentOnCheckoutRowByInput: ({ number, body, cwd, timeoutMs }) => commentOnCheckoutRowByInput({ number, body, run: answering({ cwd, timeoutMs, echo: false }) }),
  };
}
