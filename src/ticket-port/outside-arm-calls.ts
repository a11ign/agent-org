// agent-org#1573: the two calls behind the outside home of arming.
// The operation lives in the GitHub plugin (`plugins/github/rows/outside-arm-calls.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegates } from "../plugins/rows.ts";

export const { outsideArmListArgs, readyPullRequest } = delegates("outsideArmListArgs", "readyPullRequest");
