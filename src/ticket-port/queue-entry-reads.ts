// agent-org#1195: the reads and the one write behind "a merge-queue entry with no run".
// The operation lives in the GitHub plugin (`plugins/github/rows/queue-entry-reads.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegates } from "../plugins/rows.ts";
export type { QueueEntry } from "../plugins/contracts/code-host-rows.ts";

export const { queueEntriesOf, mergeGroupRunCountOf, dequeuePullRequestOf } = delegates("queueEntriesOf", "mergeGroupRunCountOf", "dequeuePullRequestOf");
