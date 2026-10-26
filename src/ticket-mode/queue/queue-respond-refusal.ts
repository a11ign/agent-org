// @ts-check
// module: why a person's Respond cannot act on a finished run (A11-154) -- PURE, shared by Respond and by the round the board starts when a ticket's Decisions change (A11-305)
import { CONCLUDED, openPulls } from "../board-view/view-types-and-filters.ts";
import { SETTLED, type Entry, type PullRequest } from "./queue-entries-and-outcomes.ts";

/**
 * Why a person's Respond cannot act on `entry`, or null when it can (A11-154): the run is not on the board, is not finished, has a round queued already, its
 * tracker has completed or canceled the ticket, or it has no pull request open, on the board's record or on `found` (A11-240). A parked run is not refused here: the pool closes its workspace first. PURE.
 */
export function respondRefusal(key: string, entry: Entry | undefined, found: readonly PullRequest[]): string | null {
  if (entry === undefined) return `${key} is not on the board`;
  if (entry.phase === "queued" && entry.talk === true) return `a talk session is already queued for ${key}: a round would share its session`;
  if (entry.phase === "queued") return entry.review !== undefined ? `a round is already queued for ${key}` : `${key} has not run yet, so there is no pull request to answer`;
  if (entry.phase !== "finished") return `${key} is still running: Respond answers a run that has finished`;
  if (SETTLED.has(entry.trackerState ?? "")) return `${key}'s ticket is ${entry.trackerState === "completed" ? "completed" : "closed"} in the tracker, so there is nothing to respond to`;
  if (openPulls(entry).length === 0 && found.length === 0) return `${key} has no pull request open, so there is no feedback to answer`;
  const kind = entry.outcome?.kind ?? "";
  if (CONCLUDED.has(kind) || kind === "stopped") return `${key} ${kind === "stopped" ? "was stopped" : `concluded (${kind})`}: there is nothing for a worker to answer`;
  return null;
}
