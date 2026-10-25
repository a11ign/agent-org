// @ts-check
// module: the tickets a run waits on (A11-272) -- its blockers, the tickets its stopped run is queued behind, and the tickets and pull requests its worker declared a wait on, followed through the tickets those wait on
//
// One set of edge rules, shared by the overlap hold (a run never holds its files against a ticket it waits on, `overlap-hold.ts`) and the queue's hold of a stopped run (`waitsOn`). A fleet job and a CI run belong to
// no ticket on the board, so they add no edge. PURE. Like the rest of `board-view/`, it is sent to the browser as one script with its relative imports dropped.
import { openPulls, type ViewBlocker, type ViewEntry } from "./view-types-and-filters.ts";

/**
 * A run's blockers: those the tracker last listed, then each ticket its stopped run is queued behind (`stoppedForBlocker`) that the list does not name yet, with the tracker's state last read of it ("unknown" before
 * any read). The board records the relation in the tracker as it stops the run, but the list is read later, and a tracker may not record it at all, so the stop's own record holds the run meanwhile. PURE.
 */
export function blockersOf(entry: ViewEntry): readonly ViewBlocker[] {
  const states = entry.stoppedForBlocker?.states;
  return [...(entry.blockers ?? []), ...unlistedStops(entry).map((key) => ({ key, state: states?.[key] ?? "unknown", status: "" }))];
}

/** The tickets a stopped run is queued behind that its blockers, as the tracker last listed them, do not name. PURE. */
export const unlistedStops = (entry: ViewEntry): string[] =>
  (entry.stoppedForBlocker?.keys ?? []).filter((key) => !(entry.blockers ?? []).some((blocker) => blocker.key === key));

/** The keys of the tickets whose runs on the board have the pull request `url` open. PURE. */
const pullOwners = (url: string, entries: readonly ViewEntry[]): string[] =>
  entries.filter((other) => openPulls(other).some((pull) => pull.url === url)).map(({ ticket }) => ticket.key);

/** The tickets a run waits on directly: its blockers ({@link blockersOf}), and, while it is live, each ticket its worker declared a wait on and each ticket whose run has a pull request it declared a wait on. PURE. */
function directWaits(entry: ViewEntry, entries: readonly ViewEntry[]): string[] {
  const blockers = blockersOf(entry).map(({ key }) => key);
  if (entry.phase !== "starting" && entry.phase !== "running") return blockers;
  const declared = (entry.working?.waits ?? []).flatMap((wait) => {
    if (wait.kind === "ticket") return [wait.key];
    return wait.kind === "pullRequest" ? pullOwners(wait.url, entries) : [];
  });
  return [...blockers, ...declared];
}

/** Every ticket a run waits on, directly ({@link directWaits}) or through the tickets those wait on, each once, and never its own. PURE. */
export function waitedOn(entry: ViewEntry, entries: readonly ViewEntry[]): ReadonlySet<string> {
  const found = new Set<string>();
  const toFollow = directWaits(entry, entries);
  for (let key = toFollow.pop(); key !== undefined; key = toFollow.pop()) {
    if (key === entry.ticket.key || found.has(key)) continue;
    found.add(key);
    for (const run of entries.filter((other) => other.ticket.key === key)) toFollow.push(...directWaits(run, entries));
  }
  return found;
}
