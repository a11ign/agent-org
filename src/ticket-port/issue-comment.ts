// agent-org#1577: the comment an org report leaves on a standing issue.
// The operation lives in the GitHub plugin (`plugins/github/rows/issue-comment.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegate } from "../plugins/rows.ts";

export const commentOnIssue = delegate("commentOnIssue");
