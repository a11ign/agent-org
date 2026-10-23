// #5039: a tracker's rows by label, read without search.
// The operation lives in the GitHub plugin (`plugins/github/rows/rows-by-label.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegates } from "../plugins/rows.ts";
export type { LabelledRead, ClaimedRow } from "../plugins/contracts/code-host-rows.ts";

export const { forgetRefusedReads, isRowsByLabelRead, readUnlessRefused, readRowsByLabel, readClaimedRows } = delegates("forgetRefusedReads", "isRowsByLabelRead", "readUnlessRefused", "readRowsByLabel", "readClaimedRows");
