// @ts-check
// module: the code host contract suite's checks of the readouts section of `rows` (A11-160, step 9)
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { RowsReadouts } from "../contracts/code-host-rows-readouts.ts";
import { type Conditional, expect } from "./suite.ts";
import { refused, throws, withRunRows, type Subject } from "./rows-support.ts";

/** The operations of this section, each a function of the rows. */
export const READOUTS_OPERATIONS = [
  "treeFilesOf", "workflowDefinitionOf", "rawFileTextOf", "scheduledRunsOf", "reportCommentBodiesOf", "publishedReleasesOf", "pathCommitsPageOf", "commitFilesOf", "commitPullsOf",
  "pullDepthFactsOf", "pullFilenamesPageOf", "restRowBodyOf", "commitAssociatedPullsOf", "pullFilenamesOf", "openPullHeadRefsOf", "issueProjectionOf", "rowTimelineEventsOf", "conditionalProbeOf",
] as const satisfies readonly (keyof RowsReadouts & keyof CodeHostRows)[];

/** The checks of this section: a refused read throws or answers null, a refused write throws. Each is `withRunRows(...)` or `withRows(...)` of `rows-support.ts`. */
export const READOUTS_CHECKS: Readonly<Record<string, Conditional<Subject>>> = {
  "a read the rows could not make for the read-only reporters throws, never an empty answer": withRunRows("no refused read is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const reads: Record<string, () => unknown> = {
      treeFilesOf: () => rows.treeFilesOf({ repo, run: refused }), workflowDefinitionOf: () => rows.workflowDefinitionOf({ repo, workflow: "w.yml", run: refused }),
      rawFileTextOf: () => rows.rawFileTextOf({ repo, path: "p", run: refused }), scheduledRunsOf: () => rows.scheduledRunsOf({ repo, workflow: "w.yml", perPage: 10, run: refused }),
      reportCommentBodiesOf: () => rows.reportCommentBodiesOf({ repo, issue: 1, perPage: 10, since: null, run: refused }), publishedReleasesOf: () => rows.publishedReleasesOf({ repo, window: 10, run: refused }),
      pathCommitsPageOf: () => rows.pathCommitsPageOf({ repo, path: "src/", page: 1, perPage: 10, since: null, run: refused }), commitFilesOf: () => rows.commitFilesOf({ repo, sha: "a", run: refused }),
      commitPullsOf: () => rows.commitPullsOf({ repo, sha: "a", run: refused }), pullDepthFactsOf: () => rows.pullDepthFactsOf({ repo, number: 1, run: refused }),
      pullFilenamesPageOf: () => rows.pullFilenamesPageOf({ repo, number: 1, perPage: 10, run: refused }), restRowBodyOf: () => rows.restRowBodyOf({ repo, number: 1, run: refused }),
      commitAssociatedPullsOf: () => rows.commitAssociatedPullsOf({ repo, sha: "a", run: refused }), pullFilenamesOf: () => rows.pullFilenamesOf({ repo, number: 1, run: refused }),
      openPullHeadRefsOf: () => rows.openPullHeadRefsOf({ repo, run: refused }), issueProjectionOf: () => rows.issueProjectionOf({ repo, run: refused }),
      rowTimelineEventsOf: () => rows.rowTimelineEventsOf({ repo, number: 1, run: refused }),
    };
    for (const [name, read] of Object.entries(reads)) expect(throws(read), `${name} must throw when the read is refused: a read that could not be made is never an empty answer`);
  }),
};
