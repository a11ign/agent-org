// @ts-check
// module: the code host contract suite's checks of the audit section of `rows` (A11-160, step 9)
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { RowsAudit } from "../contracts/code-host-rows-audit.ts";
import { expect } from "./suite.ts";
import type { Conditional } from "./suite.ts";
import { refused, throws, withRunRows } from "./rows-support.ts";
import type { Subject } from "./rows-support.ts";

/** The operations of this section, each a function of the rows. */
export const AUDIT_OPERATIONS = [
  "reportedOpenIssueNumbersOf", "issueListingOf", "pullListingOf", "closingReferencesOf", "latestReopenedAtOf", "closingIssueReferencesOf", "newestLabeledAtOf", "newestCommentAtOf", "milestoneDescriptionOf",
  "blockedByAddedAtOf", "stockTimelineEventsOf", "rowLabelsAndStateOf", "mergedClosersOf", "closedAtOf", "writeHeartbeatVariable",
] as const satisfies readonly (keyof RowsAudit & keyof CodeHostRows)[];

/** The checks of this section: a refused read throws or answers null, a refused write throws. Each is `withRunRows(...)` or `withRows(...)` of `rows-support.ts`. */
export const AUDIT_CHECKS: Readonly<Record<string, Conditional<Subject>>> = {
  "a read the rows could not make for the audit, the retro's stock count and the un-park throws, never an empty answer": withRunRows("no refused read is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const reads: Record<string, () => unknown> = {
      reportedOpenIssueNumbersOf: () => rows.reportedOpenIssueNumbersOf({ repo, run: refused }),
      issueListingOf: () => rows.issueListingOf({ repo, state: "open", limit: 10, fields: ["number"], what: "open issues", run: refused }),
      pullListingOf: () => rows.pullListingOf({ repo, state: "open", limit: 10, fields: ["number"], what: "open PRs", run: refused }),
      closingReferencesOf: () => rows.closingReferencesOf({ repo, numbers: [1], run: refused }), latestReopenedAtOf: () => rows.latestReopenedAtOf({ repo, numbers: [1], run: refused }),
      closingIssueReferencesOf: () => rows.closingIssueReferencesOf({ repo, numbers: [1], run: refused }),
      newestLabeledAtOf: () => rows.newestLabeledAtOf({ repo, number: 1, label: "x", run: refused }), newestCommentAtOf: () => rows.newestCommentAtOf({ repo, number: 1, run: refused }),
      milestoneDescriptionOf: () => rows.milestoneDescriptionOf({ repo, title: "m", run: refused }), blockedByAddedAtOf: () => rows.blockedByAddedAtOf({ repo, holder: 1, blocker: 2, run: refused }),
      stockTimelineEventsOf: () => rows.stockTimelineEventsOf({ repo, number: 1, run: refused }), rowLabelsAndStateOf: () => rows.rowLabelsAndStateOf({ repo, number: 1, run: refused }),
      mergedClosersOf: () => rows.mergedClosersOf({ repo, number: 1, run: refused }), closedAtOf: () => rows.closedAtOf({ repo, number: 1, run: refused }),
    };
    for (const [name, read] of Object.entries(reads)) expect(throws(read), `${name} must throw when the read is refused: a read that could not be made is never an empty answer`);
  }),
  "a write the rows could not make for the tick's heartbeat throws, so no caller reads it as done": withRunRows("no refused write is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    expect(throws(() => rows.writeHeartbeatVariable({ repo, variable: "X", value: "1", run: refused })), "a heartbeat that was refused must throw");
  }),
};
