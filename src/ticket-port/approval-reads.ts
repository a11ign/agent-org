// a11ign#5038: what the merge guard's approval rule reads off a pull request -- its reviews, and the commits since each approval.
// The operation lives in the GitHub plugin (`plugins/github/rows/approval-reads.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegates } from "../plugins/rows.ts";
export type { ApprovalFacts } from "../plugins/contracts/code-host-rows.ts";

export const { latestApprovals, approvalFactsOf } = delegates("latestApprovals", "approvalFactsOf");
