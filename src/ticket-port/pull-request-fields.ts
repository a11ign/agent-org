// agent-org#1396: one pull request's named fields.
// The operation lives in the GitHub plugin (`plugins/github/rows/pull-request-fields.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegate } from "../plugins/rows.ts";

export const pullRequestFieldsOf = delegate("pullRequestFieldsOf");
