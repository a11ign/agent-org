// @ts-check
// module: what a run's pull requests settle, and the tracker's completion of a ticket whose work they say is not done (A11-178) -- PURE
//
// Split from `pull-status-and-notes.ts`, whose public API is at the 50 members a module may export: `runStatus` reads both, and the card's reason line and the queue's next-step sweep read
// {@link completedEarly}. The page loads this folder as one script (`boardViewScript`), so a name is exported once, here.
import { pullsOf, type RunStatus, type ViewEntry } from "./view-types-and-filters.ts";

/**
 * A finished run's status from its pull requests alone, once each has merged or closed: completed when any merged, cancelled when every one
 * closed unmerged. `null` while one is still open, and for a run with none. The pull requests are the run's own ({@link pullsOf}), whatever its outcome
 * was: its result's, or the round's it answered. Never every pull request the ticket links, since an earlier run's merged one is not this run's work (A11-153).
 */
export function settledByPulls(entry: ViewEntry): RunStatus | null {
  const states = pullsOf(entry).map(({ url }) => entry.pullStates?.[url]);
  if (states.length === 0 || !states.every((state) => state === "merged" || state === "closed")) return null;
  return states.includes("merged") ? "completed" : "cancelled";
}

/**
 * Whether the tracker finished a ticket whose work is not finished (A11-178): the run is finished, the tracker reads Completed, and no person is known to have completed it, while the run's last merged
 * pull requests declared themselves partial (their bodies read, A11-181), or the run is a later plan step (`steps` is not empty) with pull requests of its own that have not all merged. The tracker's own integration does this on a merge
 * whose body carries a closing word beside the ticket's key, whatever else the body says; the board puts such a ticket back, and flags the run where it could not. A `Closes` merge, a run that never
 * declared `partial`, a run with no pull request of its own and a ticket a person completed are none of these. PURE.
 */
export function completedEarly(entry: ViewEntry): boolean {
  if (entry.phase !== "finished" || entry.trackerState !== "completed" || entry.completedBy === "person") return false;
  const settled = settledByPulls(entry);
  // Only on a `partial` the merged pull requests' bodies have been read against (A11-181): the outcome's words alone put A11-155 back after a `Closes` merge.
  const partialMerged = entry.partial !== undefined && entry.declared !== undefined && settled === "completed";
  const laterStepOpen = (entry.steps ?? []).length > 0 && pullsOf(entry).length > 0 && settled === null;
  return partialMerged || laterStepOpen;
}


/**
 * Whether a run's outcome declares `partial`, its pull requests merged, and the board has not yet read what their bodies declare (A11-181): the merged pull request's own `Closes` or `Partial:` decides over the
 * outcome's words, so nothing acts on `partial` until it has been read. A run with no `partial` does not wait. PURE.
 */
export const awaitingDeclaration = (entry: ViewEntry): boolean => entry.partial !== undefined && entry.declared === undefined && settledByPulls(entry) === "completed";
