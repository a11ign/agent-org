// a11ign#5528, agent-org#1538: the chairman's brief on a pull request whose failing check says `Cleared-by: human`.
// The operation lives in the GitHub plugin (`plugins/github/rows/chairman-brief.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegate } from "../plugins/rows.ts";

export const briefChairmanOnPull = delegate("briefChairmanOnPull");
