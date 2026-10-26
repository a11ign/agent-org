// @ts-check
// module: a review round that answers a pull request still open (A11-298) -- PURE
//
// Split from `pull-status-and-notes.ts`, whose public API is at the 50 members a module may export: `waitsOn` there lets such a round start whatever its ticket's blockers are. Like the rest of `board-view/`, it is sent
// to the browser as one script with its relative imports dropped.
import { openPulls, type ViewEntry } from "./view-types-and-filters.ts";

/**
 * Whether a run is a review round on a pull request that is open: it answers the pull requests it names (`review`), at least one is open as last read, and it is no talk session, which is a person's. A pull request
 * that exists needs none of its ticket's blockers finished, since the work is already done and a reviewer asked for more of it (A11-298). PURE.
 */
export const isRoundOnOpenPull = (entry: ViewEntry): boolean => entry.review !== undefined && entry.talk !== true && openPulls(entry).length > 0;
