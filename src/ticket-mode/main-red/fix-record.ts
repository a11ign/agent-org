// @ts-check
// module: the fix ticket the board files for a check red on main (A11-428) -- the key it is recorded under, and which record is the check's current one
//
// ONE FIX TICKET FOR EACH REPOSITORY AND CHECK. The request is recorded in the dependency sweep's file (`dependency-tickets.json`, `dependency-updates/filed.ts`) under `main-red:<owner/name>:<check>`, so the sweep that
// already asks the writer for the board's own tickets asks for it, settles it, queues the one ticket it made and asks again after a run that made none. A key there is never asked for again, so a check that goes red on main
// again after its fix merged is recorded under the next key of a chain: `<key> after <the merged fix>`. The check's current record is the first of the chain whose fix has not merged.
import { openPulls, pullsOf } from "../board-view/view-types-and-filters.ts";
import type { Entry as DependencyEntry } from "../dependency-updates/filed.ts";
import type { Queue } from "../queue/queue-entries-and-outcomes.ts";

/** The key the first fix ticket for `check` in `repository` (`owner/name`) is recorded under. PURE. */
export const fixKey = (repository: string, check: string): string => `main-red:${repository}:${check}`;

/** The key of the fix after `ticket`, the fix recorded under `key`, merged. PURE. */
const nextKey = (key: string, ticket: string): string => `${key} after ${ticket}`;

/** Where the check's fix stands: the key its current record is under, and that record, or undefined when nothing was asked for under it yet; and the last fix of the chain that merged, or null when none has. */
export type CurrentFix = Readonly<{ key: string; entry: DependencyEntry | undefined; lastMerged: string | null }>;

/**
 * The current record of the fix for `check` in `repository`: the first key of its chain whose record is not a filed ticket that merged. `merged` says whether a ticket's pull request merged. The chain is never longer than the
 * records there are, so a record that names itself ends it. PURE.
 */
export function currentFix(tickets: Readonly<Record<string, DependencyEntry>>, repository: string, check: string, merged: (ticket: string) => boolean): CurrentFix {
  let key = fixKey(repository, check);
  let lastMerged: string | null = null;
  for (let link = 0; link <= Object.keys(tickets).length; link++) {
    const entry = tickets[key];
    if (entry?.state !== "filed" || !merged(entry.ticket)) return { key, entry, lastMerged };
    lastMerged = entry.ticket;
    key = nextKey(key, entry.ticket);
  }
  return { key, entry: tickets[key], lastMerged };
}

/**
 * Whether the board's run of `ticket` has its pull requests merged: it has some, none of them is still open, and one merged, as last read. A ticket the queue does not hold is not known to have merged, so a fix a person
 * took off the board leaves the pull requests it holds held, naming it. PURE.
 */
export function fixMergedOn(queue: Queue, ticket: string): boolean {
  return queue.entries.some((entry) => entry.ticket.key === ticket && openPulls(entry).length === 0 && pullsOf(entry).some(({ url }) => entry.pullStates?.[url] === "merged"));
}
