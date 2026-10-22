import { isParked } from "./pull-status-and-notes.ts";
import { type ViewEntry } from "./view-types-and-filters.ts";

/**
 * The line a batch planner's ticket shows while its agent waits for a person in the batch's one terminal (parked, or in a Talk session): the tickets that share that pane now, as
 * "Planned together with A, B, C: answer in the batch's terminal". Tickets of the batch that were planned and left it need no answer, so they are not named. Null for a run that
 * is not in a batch, holds no pane, or is not waiting for a person (A11-171). PURE.
 */
export function sharedRunNote(entry: ViewEntry, entries: readonly ViewEntry[]): string | null {
  const waits = isParked(entry) || entry.talk === true;
  if (entry.batch === undefined || entry.workspace === undefined || !waits) return null;
  const others = entries.filter((other) => other.batch === entry.batch && other.workspace === entry.workspace && other.ticket.key !== entry.ticket.key).map((other) => other.ticket.key);
  return others.length === 0 ? null : `Planned together with ${others.join(", ")}: answer in the batch's terminal`;
}

/**
 * The name of the browser tab a run's terminal opens in: the same for every card of a batch, which share one pane, and for every press of Talk on a card, so the second
 * press finds the first tab and its pane rather than opening another (A11-171). PURE.
 */
export const terminalTab = (entry: ViewEntry): string => `terminal-${entry.batch ?? entry.ticket.key}`;
