// agent-org#992: the code host's CI, read through the caller's own runner.
// The operation lives in the GitHub plugin (`plugins/github/rows/ci-reads.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegates } from "../plugins/rows.ts";
export type { CiJob, RedRun } from "../plugins/contracts/code-host-rows.ts";

export const { headOfChange, checkRunsOfHead, workflowRunsOf, jobsOfRun, failedLogOfRun, stateOfRow, redRunOfHead, rerunFailedJobsOf } = delegates("headOfChange", "checkRunsOfHead", "workflowRunsOf", "jobsOfRun", "failedLogOfRun", "stateOfRow", "redRunOfHead", "rerunFailedJobsOf");

// Whether a check is the roll-up `gate` is core's (ticket mode asks it of a red check), and its file is `newest-check-run.ts`.
export { isRollUpCheck } from "../newest-check-run.ts";
