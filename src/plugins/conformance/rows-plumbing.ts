// @ts-check
// module: the code host contract suite's checks of the plumbing section of `rows` (A11-160, step 9)
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { RowsPlumbing } from "../contracts/code-host-rows-plumbing.ts";
import { expect, type Conditional } from "./suite.ts";
import { refused, throws, withRows, withRunRows, type Subject } from "./rows-support.ts";

/** The operations of this section, each a function of the rows. */
export const PLUMBING_OPERATIONS = ["releasePublishedAtOf", "gatingCiRunOf", "ciRunLogOf", "restLabelNamesOf", "graphqlPoolProbeArgs", "answeringRunnerWith", "pullForReviewEvalOf", "rowForReviewEvalOf"] as const satisfies readonly (keyof RowsPlumbing & keyof CodeHostRows)[];

/** The checks of this section: a refused read throws or answers null, a refused write throws. Each is `withRunRows(...)` or `withRows(...)` of `rows-support.ts`. */
export const PLUMBING_CHECKS: Readonly<Record<string, Conditional<Subject>>> = {
  "a read the rows could not make for the tool-version agreement, the host check and the review eval throws, never an empty answer": withRunRows("no refused read is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const reads: Record<string, () => unknown> = {
      releasePublishedAtOf: () => rows.releasePublishedAtOf({ repo, tag: "v1.0.0", run: refused }), gatingCiRunOf: () => rows.gatingCiRunOf({ repo, run: refused }),
      ciRunLogOf: () => rows.ciRunLogOf({ repo, id: 1, run: refused }), restLabelNamesOf: () => rows.restLabelNamesOf({ repo, number: 1, run: refused }),
      pullForReviewEvalOf: () => rows.pullForReviewEvalOf({ repo, number: 1, run: refused }), rowForReviewEvalOf: () => rows.rowForReviewEvalOf({ repo, number: 1, run: refused }),
    };
    for (const [name, read] of Object.entries(reads)) expect(throws(read), `${name} must throw when the read is refused: a read that could not be made is never an empty answer`);
  }),
  "the GraphQL pool's probe is a list of arguments the caller sends through a runner of its own": withRows("the pool's probe is not asked", ({ rows }) => {
    const probe = rows.graphqlPoolProbeArgs();
    expect(Array.isArray(probe) && probe.length > 0 && probe.every((argument) => typeof argument === "string"), "graphqlPoolProbeArgs must be a list of arguments");
    expect(probe.join(" ") !== rows.corePoolProbe.join(" "), "graphqlPoolProbeArgs must be told from the core pool's probe: they read two pools");
  }),
};
