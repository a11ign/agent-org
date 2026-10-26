// @ts-check
// module: the open pull requests of a finished run that conflict with their base, as the watch last read them (A11-293) -- PURE
//
// A CONFLICT IS SAID WHATEVER THE RUN'S STATUS. The watch records `PullHead.conflict` for every pull request the host reads `CONFLICTING`, on every finished run it reads, so a run waiting on a person (Needs you) shows the conflict on its card
// and its Respond carries the conflict into the round. Before this a run handed to a person was not read for its conflict at all, and #1933 sat `CONFLICTING` for a day with nothing on its card (A11-293).
import { pullLabel } from "./pull-label.ts";
import { openPulls, type ViewEntry } from "./view-types-and-filters.ts";

/** An open pull request that conflicts with its base: its address and the branch it merges into, or null when the host did not say. */
export type ConflictingPull = Readonly<{ url: string; base: string | null }>;

/** The open pull requests of a finished run that the last watch read as conflicting. A run that has not finished is a worker's to answer, and a record from before its round would be stale. PURE. */
export function conflictingPulls(entry: ViewEntry): ConflictingPull[] {
  if (entry.phase !== "finished") return [];
  return openPulls(entry).flatMap(({ url }) => {
    const conflict = entry.pullHeads?.[url]?.conflict;
    return conflict === undefined ? [] : [{ url, base: conflict.base }];
  });
}

/**
 * The line the card shows for a finished run with a pull request that conflicts with its base, one clause for each, or null when none does: `a11ign/agent-org #1933 conflicts with main`. A pull request the run's `handedBack` text already names as a
 * conflict is left out, since the card says that text. The run's status does not change for it. PURE.
 */
export function conflictNote(entry: ViewEntry): string | null {
  const unsaid = conflictingPulls(entry).filter(({ url }) => !(entry.handedBack ?? "").includes(`${url} conflicts with`));
  return unsaid.length === 0 ? null : unsaid.map(({ url, base }) => `${pullLabel(url)} conflicts with ${base ?? "its base"}`).join("; ");
}
