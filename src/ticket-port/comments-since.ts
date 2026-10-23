// a11ign#5117: a tracker's issue comments since a moment.
// The operation lives in the GitHub plugin (`plugins/github/rows/comments-since.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegate } from "../plugins/rows.ts";
export type { CommentRead } from "../plugins/contracts/code-host-rows.ts";

export const commentsSince = delegate("commentsSince");
