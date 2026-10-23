// agent-org#1167: a repository's open pull requests with the fields the prune's open-PR hold reads.
// The operation lives in the GitHub plugin (`plugins/github/rows/open-pull-heads.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegate } from "../plugins/rows.ts";
export type { OpenPullHead, OpenPullHeads } from "../plugins/contracts/code-host-rows.ts";

export const readOpenPullHeads = delegate("readOpenPullHeads");
