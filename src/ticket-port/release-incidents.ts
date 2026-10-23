// agent-org#887: the GitHub calls behind a failed release's incident.
// The operation lives in the GitHub plugin (`plugins/github/rows/release-incidents.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegates } from "../plugins/rows.ts";
export type { ClosedIncidentRead } from "../plugins/contracts/code-host-rows.ts";

export const { jobLogOf, closedIncidentsOf, createIncident, closeIncident } = delegates("jobLogOf", "closedIncidentsOf", "createIncident", "closeIncident");
