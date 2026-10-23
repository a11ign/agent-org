// a11ign#5109: what the merge guard's Tests-first rule reads off a pull request and the rows it closes.
// The operation lives in the GitHub plugin (`plugins/github/rows/tests-first-reads.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegate } from "../plugins/rows.ts";
export type { TestsFirstFacts } from "../plugins/contracts/code-host-rows.ts";

export const testsFirstReadsOf = delegate("testsFirstReadsOf");
