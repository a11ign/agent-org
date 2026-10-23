// #5405: the Project-membership read a machine-filed row's retry needs.
// The operation lives in the GitHub plugin (`plugins/github/rows/project-membership.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegates, rows } from "../plugins/row-mode.ts";
export type { ReadGh } from "../plugins/contracts/code-host-rows.ts";

export const { isIssueOnBoard, boardItemOf } = delegates("isIssueOnBoard", "boardItemOf");

/** How many project items a page of an issue's board membership holds. */
export const projectItemsPage = (): number => rows().projectItemsPage;
