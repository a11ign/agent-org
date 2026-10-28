// @ts-check
// module: why a run cannot be retried (A11-355) -- PURE
//
// Only a finished run is retried, and not one whose outcome is its result (its pull requests would only be made again), nor one that concluded with nothing more to do (`checked`), nor a parked run until its workspace is closed:
// a second workspace would take the same herdr name. `retry` acts on none of them, and a caller that answers a person says why instead of answering as if the retry had been made (it answered 200 over an unchanged run).
import { CONCLUDED, RESULT_KINDS } from "../board-view/view-types-and-filters.ts";
import { isParked } from "../board-view/pull-status-and-notes.ts";
import type { Entry } from "./queue-entries-and-outcomes.ts";

/** Why `entry` cannot be retried, or null when it can. PURE. */
export function retryRefusal(entry: Entry): string | null {
  const { key } = entry.ticket;
  const kind = entry.outcome?.kind ?? "";
  if (entry.phase !== "finished") return `${key} is ${entry.phase === "queued" ? "queued" : "still running"}, not finished`;
  if (RESULT_KINDS.has(kind)) return `${key} ended with its result, ${kind}: retried, it would only make its pull requests again`;
  if (CONCLUDED.has(kind)) return `${key} concluded (${kind}) with nothing more to do`;
  if (isParked(entry)) return `${key} still holds its workspace: close it first`;
  return null;
}
