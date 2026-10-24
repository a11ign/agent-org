// module: the GitHub plugin's rows for the audit section of the contract (A11-160, step 9; moved from the callers named in each operation's comment)
//
// Each operation builds the argument list its caller built and reads GitHub's answer as the caller did, and THROWS when `gh` refuses: what a caller does with a refusal stays in core. Every operation runs on the `run` its
// caller hands it (the audit's runner with the git variables off, the gate's metered one, the tick's bounded one): none of these callers lets the code host choose.
import type { CodeHostRows, RowsHelpers } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { RowsAudit } from "../../../src/plugins/contracts/code-host-rows-audit.ts";
import type { RowsRunners } from "./index.ts";
import {
  blockedByAddedAtOf, closedAtOf, closingIssueReferencesOf, closingReferencesOf, issueListingOf, latestReopenedAtOf, mergedClosersOf, milestoneDescriptionOf, newestCommentAtOf, newestLabeledAtOf, pullListingOf,
  reportedOpenIssueNumbersOf, rowLabelsAndStateOf, stockTimelineEventsOf, writeHeartbeatVariable,
} from "./audit-reads.ts";

/** The operations of this section. */
export type AuditRows = Pick<CodeHostRows, keyof RowsAudit>;

export function auditRowsOf(_runners: RowsRunners, _helpers: () => RowsHelpers): AuditRows {
  return {
    reportedOpenIssueNumbersOf, issueListingOf, pullListingOf, closingReferencesOf, latestReopenedAtOf, closingIssueReferencesOf, newestLabeledAtOf, newestCommentAtOf, milestoneDescriptionOf, blockedByAddedAtOf,
    stockTimelineEventsOf, rowLabelsAndStateOf, mergedClosersOf, closedAtOf, writeHeartbeatVariable,
  };
}
