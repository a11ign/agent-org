// @ts-check
// module: reading what a run's merged pull requests declare of their ticket (A11-181)
//
// The board decides, after a pull request merges, whether the ticket is complete. The outcome's `partial` is the worker's account of that and can be wrong (A11-155's listed what was done), so
// the merged pull request's own body decides: `Closes <KEY>` completes the ticket, `Partial:` leaves it open. The grammar is `ticket-references.ts`'s; the choice among several bodies and what it does to the run
// is `queue/queue-declarations.ts`'s; this file asks the code host.
import { DEFAULT_KEYWORDS } from "./source.ts";
import { declarationOf } from "./ticket-references.ts";
import { declarationsDue, declare, mergedPullUrls, recordDeclared, type ReadDeclaration } from "./queue/queue-declarations.ts";
import { pullsOf } from "./board-view/view-types-and-filters.ts";
import { pullLabel } from "./board-view/pull-label.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
import { log, messageOf, update } from "./pool-state.ts";
import { type PoolContext } from "./pool-context.ts";
import type { MergedFindings } from "../plugins/contracts/code-host.ts";

/**
 * Read the bodies of the merged pull requests of each finished run whose bodies are not yet read, and record what they declare, once per run (A11-181). Run on every sweep after the pull requests' states are
 * read and before anything acts on a merge, so the same sweep acts on what the pull request said. A body the code host cannot read (null, or a refusal) records nothing: the run is asked again on the next
 * sweep, and a run whose outcome has `partial` is not acted on until then (`awaitingDeclaration`). A code host that cannot read a merged pull request at all records `none`, so the outcome stands.
 */
export function readPullDeclarations(ctx: PoolContext): void {
  const { codeHost, source, store } = ctx;
  const keywords = source.keywords ?? DEFAULT_KEYWORDS;
  for (const entry of declarationsDue(store.get())) {
    const key = entry.ticket.key;
    const read = codeHost.readMergedFindings === undefined ? [] : readBodies(entry, codeHost.readMergedFindings.bind(codeHost));
    if (read === null) continue;
    const declared = declare(read.map(({ url, body }): ReadDeclaration => ({ url, declaration: declarationOf(body, key, keywords) })), pullsOf(entry).length);
    update(ctx, (queue) => recordDeclared(queue, key, declared, keywords.closing));
    const overruled = store.get().entries.find((e) => e.ticket.key === key)?.partialOverruled;
    if (overruled !== undefined) log(`${key}: ${overruled.urls.map(pullLabel).join(", ")} said ${overruled.pull}, but its outcome said ${overruled.outcome === null ? "nothing remains" : `Partial: ${overruled.outcome}`}; the board followed the pull request`);
  }
}

/** The body of each merged pull request of `entry`, or null when any could not be read, which is asked again on the next sweep. */
function readBodies(entry: Entry, readFindings: (url: string) => MergedFindings | null): { url: string; body: string }[] | null {
  const read: { url: string; body: string }[] = [];
  for (const url of mergedPullUrls(entry)) {
    try {
      const found = readFindings(url);
      if (found === null) return null;
      read.push({ url, body: found.body });
    } catch (err) {
      log(`${entry.ticket.key}: what ${url} declared could not be read, and is asked again at the next refresh: ${messageOf(err)}`);
      return null;
    }
  }
  return read;
}
