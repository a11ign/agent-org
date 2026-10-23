// agent-org#1501: the five REST reads the host gate's receiving side of a11ign's `deliberateRefusals` job makes of one pull request.
// The operation lives in the GitHub plugin (`plugins/github/rows/deliberate-refusal-reads.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegates } from "../plugins/rows.ts";

export const { pullTextOf, branchRefTextOf, addedFilesTextOf, fileAtTextOf, defaultBranchFileTextOf } = delegates("pullTextOf", "branchRefTextOf", "addedFilesTextOf", "fileAtTextOf", "defaultBranchFileTextOf");
