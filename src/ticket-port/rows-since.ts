// #5076: a tracker's issues or pull requests since a time, read without search.
// The operation lives in the GitHub plugin (`plugins/github/rows/rows-since.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegates, rows } from "../plugins/rows.ts";
export type { SinceRead, Page } from "../plugins/contracts/code-host-rows.ts";

export const { sincePageArgs, isSinceRead, parsePage, foldPage, readRowsSince, asListJson, readMergedPullRequests } = delegates("sincePageArgs", "isSinceRead", "parsePage", "foldPage", "readRowsSince", "asListJson", "readMergedPullRequests");

export { WindowCutShort } from "./window-cut-short.ts";

/** How many rows a connection page holds, which a caller sizing a window by pages needs: the code host's. */
export const sincePageSize = (): number => rows().sincePageSize;
