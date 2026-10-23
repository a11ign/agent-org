// agent-org#893: the reads and writes of the daily approved-unqueued reading.
// The operation lives in the GitHub plugin (`plugins/github/rows/approved-unqueued-reads.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegates } from "../plugins/rows.ts";
export type { KeyedComment, RestReview } from "../plugins/contracts/code-host-rows.ts";

export const { keyedCommentsOf, postRowComment, createRow, editComment, reviewsOf, mergedWindowOf, openPullFieldsOf: openPullsOf } = delegates("keyedCommentsOf", "postRowComment", "createRow", "editComment", "reviewsOf", "mergedWindowOf", "openPullFieldsOf");
