// agent-org#943: a repository's open incident issues.
// The operation lives in the GitHub plugin (`plugins/github/rows/open-incidents.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegate } from "../plugins/rows.ts";
export type { OpenIncidentRead } from "../plugins/contracts/code-host-rows.ts";

export const openIncidentsOf = delegate("openIncidentsOf");
