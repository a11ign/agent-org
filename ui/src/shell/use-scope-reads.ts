import { useCallback, useEffect, useRef, useState } from "react";
import { scopeToRead } from "../../../src/ticket-mode/assignee-filter.ts";
import type { Client } from "../api/client.ts";
import type { People, Ticket, TicketView } from "../api/types.ts";

/** What the Tickets page reads beyond the first list, as `ui.html` does: the tickets of the scopes chosen, who holds the rest, and the parents the tree nests under. */
export type ScopeReads = Readonly<{
  /** The tickets of the scopes read on demand so far, which join the first list. */
  extra: readonly TicketView[];
  /** The parents of the listed tickets that are not listed themselves, so the tree keeps a child under its epic whatever the scope. */
  parents: readonly Ticket[];
  /** Who holds the open tickets, for the Assignee counts of an instance that reads scopes on demand; null until read, and on an instance that does not. */
  held: People | null;
  /** The scope being read now, or null. */
  reading: string | null;
  /** The scopes read so far. */
  read: ReadonlySet<string>;
  /** The scope that could not be read last and the server's sentence for it, or null. */
  refusal: Readonly<{ scope: string; sentence: string }> | null;
  /** Reads the tickets of `scope`, a page at a time, when this instance reads scopes on demand and does not hold them yet. */
  readScope: (scope: string) => void;
}>;

/**
 * Reads the pages of `scope` one after another, handing each to `onPage`, which answers whether to go on (it does not once the page that asked has gone). Resolves to the server's
 * sentence when a page is refused, and to null when the last one has been read or the reading was stopped.
 */
async function readPages(client: Client, scope: string, onPage: (tickets: readonly TicketView[]) => boolean): Promise<string | null> {
  let after: string | null = null;
  do {
    const page = await client.ticketsPage(scope, after);
    if (!page.ok) return page.refusal;
    if (!onPage(page.data.tickets)) return null;
    after = typeof page.data.next === "string" ? page.data.next : null;
  } while (after !== null);
  return null;
}

/**
 * The reads that follow the first list. `listed` is whether the first list has arrived: the parents and the people are read after it (the instance works the parents out from the
 * tickets it last listed) and after the first paint, so the list never waits on them. `onDemand` is the config's `scopes`. A read for a connection ends with the connection, which
 * remounts the caller, so a page of one instance never lands on another's view.
 */
export function useScopeReads(client: Client, { listed, onDemand }: Readonly<{ listed: boolean; onDemand: boolean }>): ScopeReads {
  const [extra, setExtra] = useState<readonly TicketView[]>([]);
  const [parents, setParents] = useState<readonly Ticket[]>([]);
  const [held, setHeld] = useState<People | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [read, setRead] = useState<ReadonlySet<string>>(new Set());
  const [refusal, setRefusal] = useState<ScopeReads["refusal"]>(null);
  const mounted = useRef(true);
  const busy = useRef<string | null>(null);
  const done = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const readParents = useCallback(async () => {
    const answer = await client.parents();
    if (mounted.current && answer.ok) setParents(answer.data);
  }, [client]);

  useEffect(() => {
    if (!listed) return;
    void readParents();
    if (!onDemand) return;
    void client.people().then((answer) => {
      if (mounted.current && answer.ok) setHeld(answer.data);
    });
  }, [client, listed, onDemand, readParents]);

  const readScope = useCallback((scope: string) => {
    const want = onDemand ? scopeToRead(scope, done.current) : null;
    if (want === null || busy.current === want) return;
    busy.current = want;
    setReading(want);
    setRefusal(null);
    void (async () => {
      const failure = await readPages(client, want, (tickets) => {
        if (mounted.current) setExtra((before) => [...before, ...tickets]);
        return mounted.current;
      });
      if (!mounted.current) return;
      if (failure === null) {
        done.current = new Set([...done.current, want]);
        setRead(done.current);
        await readParents();
      } else {
        setRefusal({ scope: want, sentence: failure });
      }
      busy.current = null;
      if (mounted.current) setReading(null);
    })();
  }, [client, onDemand, readParents]);

  return { extra, parents, held, reading, read, refusal, readScope };
}
