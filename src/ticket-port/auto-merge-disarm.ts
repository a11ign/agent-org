// agent-org#1278: the read and the write behind disarming a red leg's pull request.
// The operation lives in the GitHub plugin (`plugins/github/rows/auto-merge-disarm.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegates } from "../plugins/rows.ts";
export type { DisarmSeat } from "../plugins/contracts/code-host-rows.ts";

export const { readDisarmSeat, disableAutoMergeOf } = delegates("readDisarmSeat", "disableAutoMergeOf");
