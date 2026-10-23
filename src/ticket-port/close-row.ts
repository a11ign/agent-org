// agent-org#1536: the write that closes a row on a worker's own reading.
// The operation lives in the GitHub plugin (`plugins/github/rows/close-row.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegate } from "../plugins/rows.ts";

export const closeRowWithComment = delegate("closeRowWithComment");
