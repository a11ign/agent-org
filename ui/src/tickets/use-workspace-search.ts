import { useEffect, useState } from "react";
import type { Client } from "../api/client.ts";
import type { TicketView } from "../api/types.ts";

// THE SEARCH REACHES THE WHOLE WORKSPACE (A11-378). The search box filters the list as it always did, and on an instance whose tracker searches it also asks the tracker for the open tickets
// that match, whoever holds them and whatever their project, so a ticket that is not the person's and not in the project shown is found too. It asks once the person has stopped typing.

/** How long the search waits after the last key before it asks the tracker, in ms. */
export const SEARCH_WAIT_MS = 300;
/** The fewest characters a search asks the tracker for: one character matches most of a workspace. */
export const SEARCH_MIN_CHARS = 2;

/** What the search found: the matches, whether it is still asking, and the server's sentence when it could not. */
export type WorkspaceSearch = Readonly<{ results: readonly TicketView[]; searching: boolean; refusal: string | null }>;

const NOTHING: WorkspaceSearch = { results: [], searching: false, refusal: null };

/** The tracker's matches for `text`, asked `SEARCH_WAIT_MS` after it last changed; nothing for `null` (a tracker that cannot search) or a text shorter than `SEARCH_MIN_CHARS`. */
export function useWorkspaceSearch(client: Client, text: string | null): WorkspaceSearch {
  const [found, setFound] = useState<WorkspaceSearch & Readonly<{ term: string }>>({ ...NOTHING, term: "" });
  const term = text?.trim() ?? "";
  const asking = term.length >= SEARCH_MIN_CHARS;
  useEffect(() => {
    if (!asking) return undefined;
    const stop = new AbortController();
    const timer = setTimeout(() => {
      void client.search(term, stop.signal).then((answer) => {
        if (!stop.signal.aborted) setFound(answer.ok ? { term, results: answer.data, searching: false, refusal: null } : { term, results: [], searching: false, refusal: answer.refusal });
      });
    }, SEARCH_WAIT_MS);
    return () => {
      clearTimeout(timer);
      stop.abort();
    };
  }, [client, term, asking]);
  if (!asking) return NOTHING;
  return found.term === term ? { results: found.results, searching: false, refusal: found.refusal } : { ...NOTHING, searching: true };
}
