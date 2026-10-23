// agent-org#1369: the label write of an outside-idle triage row.
// The operation lives in the GitHub plugin (`plugins/github/rows/outside-idle-writes.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegate } from "../plugins/rows.ts";

export const ensureTriageLabel = delegate("ensureTriageLabel");
