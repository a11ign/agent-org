// agent-org#923: a repository's open pull requests.
// The operation lives in the GitHub plugin (`plugins/github/rows/open-pulls.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegate } from "../plugins/rows.ts";
export type { OpenPullRead } from "../plugins/contracts/code-host-rows.ts";

export const openPullsOf = delegate("openPullBodiesOf");
