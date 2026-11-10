// @ts-check
// module: what the watch reads of the board's fix tickets for checks red on main (A11-428) -- which fix owns a held check, and whether it merged
import { loadState } from "../dependency-updates/filed.ts";
import type { Queue } from "../queue/queue-entries-and-outcomes.ts";
import { currentFix, fixMergedOn } from "./fix-record.ts";

/** The board's fix for a held check: the ticket it filed, or a writer run asked for one that has not ended. */
export type FixOwner = Readonly<{ ticket: string } | { requested: true }>;

/**
 * One read of the board's fix tickets: the fix that owns a check in a repository (`owner/name`), or null when none is filed or being filed; the last fix of the check that merged, or null; and whether a ticket's pull
 * requests merged.
 */
export type FixReads = Readonly<{ ownerOf: (repository: string, check: string) => FixOwner | null; lastMerged: (repository: string, check: string) => string | null; merged: (ticket: string) => boolean }>;

/** No fix owns anything: what a board reads when its record cannot be read. */
const NONE: FixReads = { ownerOf: () => null, lastMerged: () => null, merged: () => false };

/**
 * The reads over the dependency sweep's record at `path` and the queue, made afresh at each call. A record that cannot be read owns nothing, so the held pull requests read as they did before A11-428, and `say` is told why,
 * once for each reason: the sweep that writes the file says so too, and asks for nothing until it is mended.
 */
export function fixReadsOf(path: string, queue: () => Queue, say: (line: string) => void): () => FixReads {
  const said = new Set<string>();
  return () => {
    let tickets;
    try {
      tickets = loadState(path).tickets;
    } catch (err) {
      const why = String((err as Error)?.message ?? err).split("\n")[0]!;
      if (!said.has(why)) say(`the board's fix tickets for checks red on main cannot be read (${why}), so a held pull request names none`);
      said.add(why);
      return NONE;
    }
    const current = queue();
    const merged = (ticket: string): boolean => fixMergedOn(current, ticket);
    return {
      merged,
      lastMerged: (repository, check) => currentFix(tickets, repository, check, merged).lastMerged,
      ownerOf: (repository, check) => {
        const { entry } = currentFix(tickets, repository, check, merged);
        if (entry?.state === "filed") return { ticket: entry.ticket };
        return entry?.state === "requested" ? { requested: true } : null;
      },
    };
  };
}
