// @ts-check
// module: the code host contract suite's checks of the queue section of `rows` (A11-160, step 9)
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { RowsQueue } from "../contracts/code-host-rows-queue.ts";
import { type Conditional, expect } from "./suite.ts";
import { refused, throws, withRunRows, type Subject } from "./rows-support.ts";

/** The operations of this section, each a function of the rows. */
export const QUEUE_OPERATIONS = ["mainShaOf", "checkRunTotalOf", "dispatchWorkflow", "checkoutWorkflowRunsOf", "openMainPullRollupsOf", "workflowRunsOnMain", "trunkRunsOf", "annotationsOfCheckRun", "originPullOfCommit",
  "openPullRowsOf", "pullQueueStatesOf", "checkRunBriefsOf", "apiBudgetOf"] as const satisfies readonly (keyof RowsQueue & keyof CodeHostRows)[];

/** The checks of this section: a refused read throws or answers null, a refused write throws. Each is `withRunRows(...)` or `withRows(...)` of `rows-support.ts`. */
export const QUEUE_CHECKS: Readonly<Record<string, Conditional<Subject>>> = {
  "a read the rows could not make for the trunk, the queue table and the red-trunk reading throws, never an empty answer": withRunRows("no refused read is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const reads: Record<string, () => unknown> = {
      mainShaOf: () => rows.mainShaOf({ repo, run: refused }), checkRunTotalOf: () => rows.checkRunTotalOf({ repo, sha: "a".repeat(40), run: refused }),
      checkoutWorkflowRunsOf: () => rows.checkoutWorkflowRunsOf({ workflow: "w.yml", limit: 10, run: refused }), openMainPullRollupsOf: () => rows.openMainPullRollupsOf({ repo, run: refused }),
      workflowRunsOnMain: () => rows.workflowRunsOnMain({ repo, workflow: "w.yml", perPage: 10, run: refused }), trunkRunsOf: () => rows.trunkRunsOf({ repo, workflow: "w.yml", eventFilter: null, run: refused }),
      annotationsOfCheckRun: () => rows.annotationsOfCheckRun({ repo, checkRunId: 1, run: refused }), originPullOfCommit: () => rows.originPullOfCommit({ repo, sha: "a".repeat(40), run: refused }),
      openPullRowsOf: () => rows.openPullRowsOf({ repo, run: refused }), pullQueueStatesOf: () => rows.pullQueueStatesOf({ repo, run: refused }),
      checkRunBriefsOf: () => rows.checkRunBriefsOf({ repo, sha: "a".repeat(40), run: refused }),
    };
    for (const [name, read] of Object.entries(reads)) expect(throws(read), `${name} must throw when the read is refused: a read that could not be made is never an empty answer`);
    expect(rows.apiBudgetOf({ repo, run: refused }) === null, "a budget that could not be read is null: null is never 'nothing is left'");
  }),
  "a write the rows could not make for the trunk sweep throws, so no caller reads it as done": withRunRows("no refused write is asked", ({ rows, probe }) => {
    expect(throws(() => rows.dispatchWorkflow({ repo: probe.repository, workflow: "w.yml", run: refused })), "dispatchWorkflow must throw when the dispatch is refused");
  }),
};
