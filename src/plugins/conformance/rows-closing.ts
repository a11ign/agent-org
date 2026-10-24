// @ts-check
// module: the code host contract suite's checks of the closing section of `rows` (A11-160, step 9)
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { RowsClosing } from "../contracts/code-host-rows-closing.ts";
import type { Conditional } from "./suite.ts";
import { expect } from "./suite.ts";
import { refused, throws, withRunRows, type Subject } from "./rows-support.ts";

/** The operations of this section, each a function of the rows. */
export const CLOSING_OPERATIONS = [
  "rateLimitDumpOf", "closeCompletedRow", "rowNumberStateAndLabelsOf", "rowStateAndLabelsOf", "commentsOfRowIn", "declaredRowOf", "declaredBuildRowOf", "buildRowOf", "mergedPullClosingOf",
  "closingRowsOfMergedPull", "fileRowInMilestone", "addBlockedByEdge", "addSubIssueTo", "closedRowPageOf", "claimedRowsWithComments", "headBranchAndForkOf", "consumerFileTextOf", "rowWithCommentsOf",
] as const satisfies readonly (keyof RowsClosing & keyof CodeHostRows)[];

/** The checks of this section: a refused read throws or answers null, a refused write throws. Each is `withRunRows(...)` or `withRows(...)` of `rows-support.ts`. */
export const CLOSING_CHECKS: Readonly<Record<string, Conditional<Subject>>> = {
  "a read the rows could not make for the close of a merged pull request throws, never an empty answer": withRunRows("no refused read is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const reads: Record<string, () => unknown> = {
      rateLimitDumpOf: () => rows.rateLimitDumpOf({ run: refused }), rowNumberStateAndLabelsOf: () => rows.rowNumberStateAndLabelsOf({ repo, number: 1, run: refused }),
      declaredRowOf: () => rows.declaredRowOf({ repo, number: 1, run: refused }), declaredBuildRowOf: () => rows.declaredBuildRowOf({ repo, number: 1, run: refused }),
      buildRowOf: () => rows.buildRowOf({ repo, number: 1, run: refused }), mergedPullClosingOf: () => rows.mergedPullClosingOf({ repo, number: "1", run: refused }),
      closingRowsOfMergedPull: () => rows.closingRowsOfMergedPull({ repo, number: 1, run: refused }),
      closedRowPageOf: () => rows.closedRowPageOf({ owner: "o", name: "r", after: null, projectNumber: 1, run: refused }),
    };
    for (const [name, read] of Object.entries(reads)) expect(throws(read), `${name} must throw when the read is refused: a read that could not be made is never an empty answer`);
  }),
  "a read the rows could not make for the checks on a row's claim throws, never an empty answer": withRunRows("no refused read is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const reads: Record<string, () => unknown> = {
      rowStateAndLabelsOf: () => rows.rowStateAndLabelsOf({ repo, number: 1, run: refused }), commentsOfRowIn: () => rows.commentsOfRowIn({ repo, number: 1, run: refused }),
      claimedRowsWithComments: () => rows.claimedRowsWithComments({ repo, label: "x", count: 10, window: 10, run: refused }), headBranchAndForkOf: () => rows.headBranchAndForkOf({ repo, number: 1, run: refused }),
      consumerFileTextOf: () => rows.consumerFileTextOf({ repo, path: "a.json", run: refused }), rowWithCommentsOf: () => rows.rowWithCommentsOf({ repo, number: 1, run: refused }),
    };
    for (const [name, read] of Object.entries(reads)) expect(throws(read), `${name} must throw when the read is refused: a read that could not be made is never an empty answer`);
  }),
  "a write the rows could not make for the close of a merged pull request throws, so no caller reads it as done": withRunRows("no refused write is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const writes: Record<string, () => unknown> = {
      closeCompletedRow: () => rows.closeCompletedRow({ repo, row: 1, comment: "done", run: refused }), addBlockedByEdge: () => rows.addBlockedByEdge({ repo, row: 2, blocker: 1, run: refused }),
      addSubIssueTo: () => rows.addSubIssueTo({ repo, parent: 1, child: 2, run: refused }),
      fileRowInMilestone: () => rows.fileRowInMilestone({ repo, title: "t", body: "b", labels: [], milestone: null, run: refused }),
    };
    for (const [name, write] of Object.entries(writes)) expect(throws(write), `${name} must throw when the write is refused`);
    expect(throws(() => rows.fileRowInMilestone({ repo, title: "t", body: "b", labels: [], milestone: null, run: () => "created, and no address printed" })), "a row filed that printed no address must throw: a row filed and not numbered would be filed again");
  }),
};
