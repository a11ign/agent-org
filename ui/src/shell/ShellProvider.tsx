import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { People } from "../api/types.ts";
import { chosenConnection } from "../../../src/ticket-mode/board-view.ts";
import { chosenProject, inProject, projectCounts } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import { queueIsEmpty } from "../api/emptiness.ts";
import { createClient, type Client } from "../api/client.ts";
import type { Fetch } from "../api/request.ts";
import { readCached, writeCached } from "../api/session-cache.ts";
import type { ConfigView, ConnectionsView, QueueView, TicketView, ViewConnection } from "../api/types.ts";
import { POLL_MS } from "../api/poll-schedule.ts";
import { usePoll, type PollView } from "../api/use-poll.ts";
import type { LifecycleView } from "../lifecycle/Lifecycle.tsx";
import { ALL_GOALS_ID, contextParentsOf, goalEntries, goalShown, mergedTickets, runningCount, scopeOf, ticketsView, isLive, unreachableOf, type GoalEntry } from "./shell-model.ts";
import { useReachability } from "./use-reachability.ts";
import { useScopeReads } from "./use-scope-reads.ts";
import { NO_UPDATE, type UpdateView } from "../updating/update-model.ts";
import { useUpdate } from "../updating/use-update.ts";
import { browserStorage, CONNECTION_MEMORY, PROJECT_MEMORY, recalled, remembered } from "./storage.ts";

/** Everything the sidebar reads, once, so a page reuses it and never reads it again. */
export type ShellValue = Readonly<{
  /** False until the connections are known: `/api/connections` has answered, or the tab kept its last answer (A11-270). */
  connectionsReady: boolean;
  connections: readonly ViewConnection[];
  /** The reads of the instance shown: what a page calls to change something (queue a ticket, start a Grill) and to read what the shell does not. */
  client: Client;
  /** The instance the whole UI is showing: null while the list is not read, and when it is empty (the reads then go to `/api/*` at the root). */
  connection: ViewConnection | null;
  /** Why the connections file was refused, in the service's own sentence, or null. */
  connectionsRefusal: string | null;
  switchConnection: (name: string) => void;
  retryConnections: () => void;
  /** `/api/queue`, polled every 5s: the Runs badge, the connection pill and the Runs and Run detail pages. */
  queue: LifecycleView<QueueView>;
  /** Whether the page is in the middle of an `agent-org update` (A11-217): `updating` while the queue poll fails with a reason to think so, `back` once the instance answers on the new version, else `none`. */
  update: UpdateView;
  /** The backend's sentence while the connection is an SSH remote that cannot be reached (the queue poll, which drives the pill, or the tickets read is `unreachable`), else null. A local connection's failure is never this. */
  unreachable: string | null;
  /** True once the connection has been unreachable and is reached again, until the connection is switched. */
  reconnected: boolean;
  /** "Check now": reads again at once and starts the backoff over, for the queue and for each read made once that has not answered. When the queue answers, the tickets are read again. */
  checkNow: () => void;
  /** `/api/config`, read once per connection: null until it has answered. The Tickets page reads what the instance can do from it. */
  config: ConfigView | null;
  /** `/api/tickets`, read once per connection and shown as the chosen Assignee scope: the Tickets count, the projects and the goals, and the Tickets page. */
  tickets: LifecycleView<TicketView[]>;
  /** The Assignee scope shown: the one chosen, else the setting's default. */
  scope: string;
  /** Chooses an Assignee scope, and reads its tickets when this instance reads scopes on demand and does not hold them yet. */
  chooseScope: (scope: string) => void;
  /** The scope being read now, or null. */
  readingScope: string | null;
  /** The scopes this instance has read on demand so far. */
  scopesRead: ReadonlySet<string>;
  /** Who holds the open tickets, for the Assignee counts; null until read and on an instance that lists everything at once. */
  held: People | null;
  /** Every ticket read, whatever the scope: what the Assignee counts and the label filters are made from. */
  allTickets: readonly TicketView[];
  /** The tickets and parents outside the scope that the tree nests a listed ticket under. */
  contextParents: readonly TicketView[];
  runningRuns: number | null;
  /** The chosen project's tickets, which the Tickets nav item counts; null while the tickets load. */
  ticketCount: number | null;
  projects: readonly (readonly [string, number])[];
  project: string | null;
  chooseProject: (name: string) => void;
  goals: readonly GoalEntry[];
  goal: string;
  chooseGoal: (id: string) => void;
  /** The chosen project's tickets: the list the Tickets page (A11-196) filters by the goal. */
  projectTickets: readonly TicketView[];
}>;

const noop = () => undefined;
const LOADING_VIEW = { state: "loading", data: null, refusal: null, cached: false, refresh: noop } as const;

/** The shell as it is before anything is read: nothing chosen, everything loading. */
const LOADING_SHELL: ShellValue = {
  connectionsReady: false, client: createClient(null), connections: [], connection: null, connectionsRefusal: null, switchConnection: noop, retryConnections: noop,
  queue: LOADING_VIEW, update: NO_UPDATE, unreachable: null, reconnected: false, checkNow: noop, config: null, tickets: LOADING_VIEW, scope: scopeOf(null, null), chooseScope: noop, readingScope: null, scopesRead: new Set(), held: null, allTickets: [], contextParents: [],
  runningRuns: null, ticketCount: null, projects: [], project: null, chooseProject: noop, goals: [], goal: ALL_GOALS_ID, chooseGoal: noop, projectTickets: [],
};

const ShellContext = createContext<ShellValue>(LOADING_SHELL);

/** The shell's reads, for the sidebar and the page inside it. */
export const useShell = (): ShellValue => useContext(ShellContext);

type Listing = Readonly<{ connections: readonly ViewConnection[]; refusal: string | null }>;

const NO_CONNECTIONS: Listing = { connections: [], refusal: null };

const listingOf = (view: ConnectionsView): Listing => ({ connections: view.connections, refusal: view.refusal });

/**
 * `/api/connections`, read once (and again on `retry`). It starts from the list the tab kept (A11-270), so a page after the first has its connection at once and its reads need not wait for
 * this one. A first read that fails leaves an empty list, as `ui.html` does: this is the only case under `pnpm ui:dev`. A read that fails after a list is held keeps that list, so the
 * sentence the person is trying to fix is not cleared by the failure.
 * THE KEPT LIST IS TAKEN UP AFTER HYDRATION, before the browser paints: the island's first render must be the page's static HTML, which was built with nothing kept, or React throws that
 * HTML away (error #418). Everything that reads a kept answer of its own sits beneath the list, so it is mounted afresh then, not hydrated.
 */
function useListing(fetchWith: Fetch | undefined): Readonly<{ listing: Listing | null; retry: () => void }> {
  const client = useMemo(() => createClient(null, fetchWith === undefined ? {} : { fetch: fetchWith }), [fetchWith]);
  const [listing, setListing] = useState<Listing | null>(null);
  useLayoutEffect(() => {
    const kept = readCached<ConnectionsView>(null, client.connections.path);
    if (kept !== null) setListing((before) => before ?? listingOf(kept.data));
  }, [client]);
  // Drawn from a list: the static HTML `Shell.astro` held back for a tab that kept one can be shown, before the browser paints this.
  useLayoutEffect(() => {
    if (listing !== null) delete document.documentElement.dataset.kept;
  }, [listing]);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const reading = new AbortController();
    void client.connections(reading.signal).then((answer) => {
      if (reading.signal.aborted) return;
      if (answer.ok) writeCached(null, client.connections.path, answer.data);
      setListing((before) => (answer.ok ? listingOf(answer.data) : (before ?? NO_CONNECTIONS)));
    });
    return () => reading.abort();
  }, [client, attempt]);
  return { listing, retry: () => setAttempt((count) => count + 1) };
}

/** The instance the page opens on: a link's `?connection=` (A11-129), else the one this browser remembers. `chosenConnection` then falls back to this machine's. */
const nameToOpenOn = (storage: Storage | null): string | null => new URLSearchParams(globalThis.location?.search ?? "").get("connection") ?? recalled(storage, CONNECTION_MEMORY);

type Chosen = Readonly<{
  /** What a Back does to move on, for a test: the page reloads itself by default (see `useUpdate`). */
  reload?: () => void;
  listing: Listing;
  connection: ViewConnection | null;
  switchConnection: (name: string) => void;
  retryConnections: () => void;
  fetchWith: Fetch | undefined;
  children: ReactNode;
}>;

/** The reads of one connection. It is keyed by the connection, so a switch drops every read and every choice made on the other instance. */
function ConnectionReads({ listing, connection, switchConnection, retryConnections, fetchWith, reload, children }: Chosen) {
  const client = useMemo(() => createClient(connection, fetchWith === undefined ? {} : { fetch: fetchWith }), [connection, fetchWith]);
  const config = usePoll<ConfigView>(client.config, { connection, repeat: false, isEmpty: () => false });
  // While the Updating screen shows, the queue is tried every POLL_MS and not on the backoff up to 60 s, so the page is back within one poll of the instance (A11-217).
  const updating = useRef(false);
  const queue = usePoll<QueueView>(client.queue, { connection, isEmpty: queueIsEmpty, maxWaitMs: () => (updating.current ? POLL_MS : Infinity) });
  // A queue the tab kept is not this page's read: the Updating screen starts from what the instance itself answers here, as before the tab kept anything (A11-270).
  const update = useUpdate(queue.cached ? { state: queue.state, data: null } : queue, reload);
  useEffect(() => {
    updating.current = update.kind === "updating";
  }, [update.kind]);
  const ticketsRead = usePoll<TicketView[]>(client.tickets, { connection, repeat: false });
  const storage = browserStorage();
  const [rememberedProject, setRememberedProject] = useState(() => recalled(storage, PROJECT_MEMORY));
  const [goalChoice, setGoalChoice] = useState(ALL_GOALS_ID);

  // What is read beside the tickets waits for a read that answered: the last known data an unreachable connection shows is not a reason to ask for more of it, and the reads would not be made again on recovery.
  // Nor are the tickets and the config the tab kept (A11-270): the instance works the parents out from the tickets it last listed, so they are asked once it has listed them again.
  const fresh = (read: PollView<unknown>): boolean => isLive(read.state) && !read.cached;
  const reads = useScopeReads(client, { listed: fresh(ticketsRead), onDemand: fresh(config) && config.data?.scopes === true });
  const [scopeChoice, setScopeChoice] = useState<string | null>(null);
  const scope = scopeOf(config.data, scopeChoice);

  const tickets = {
    ...ticketsView(ticketsRead, config, { scope: scopeChoice, extra: reads.extra, reading: reads.reading, refusal: reads.refusal?.scope === scope ? reads.refusal.sentence : null }),
    refresh: () => {
      ticketsRead.refresh();
      config.refresh();
      reads.readScope(scope);
    },
  };
  const unreachable = unreachableOf(connection, [queue, ticketsRead, config]);
  const { reconnected } = useReachability(unreachable, tickets.refresh);
  const checkNow = () => {
    queue.refresh();
    for (const read of [config, ticketsRead]) if (!isLive(read.state)) read.refresh();
  };
  const allTickets = mergedTickets(ticketsRead.data ?? [], reads.extra);
  const projects = projectCounts(tickets.data ?? []);
  const project = chosenProject(projects, rememberedProject);
  const projectTickets = inProject(tickets.data ?? [], project);
  const goals = goalEntries(projectTickets);
  const value: ShellValue = {
    connectionsReady: true, client, connections: listing.connections, connection, connectionsRefusal: listing.refusal, switchConnection, retryConnections,
    queue, update, unreachable, reconnected, checkNow, config: config.data, tickets, scope, held: reads.held, allTickets, readingScope: reads.reading, scopesRead: reads.read,
    chooseScope: (next) => {
      setScopeChoice(next);
      reads.readScope(next);
    },
    contextParents: contextParentsOf(allTickets, reads.parents, config.data, scope), runningRuns: queue.data === null ? null : runningCount(queue.data), ticketCount: tickets.data === null ? null : projectTickets.length,
    projects, project,
    chooseProject: (name) => {
      setRememberedProject(name);
      remembered(storage, PROJECT_MEMORY, name);
    },
    goals, goal: goalShown(goals, goalChoice), chooseGoal: setGoalChoice, projectTickets,
  };
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

/**
 * The shell's data. It reads the connections once; the instance shown is `?connection=`, else the one remembered, else this machine's (`chosenConnection`), and a switch
 * remembers the choice and gives every read a new client for that instance, which starts them again from what the tab kept of that instance, else from `loading`. `fetchWith` and `reload` are for a test; the page uses the browser's.
 */
export function ShellProvider({ fetchWith, reload, children }: Readonly<{ fetchWith?: Fetch; reload?: () => void; children: ReactNode }>) {
  const { listing, retry } = useListing(fetchWith);
  const storage = browserStorage();
  const [name, setName] = useState<string | null>(() => nameToOpenOn(storage));
  const chosen = listing === null ? null : chosenConnection(listing.connections, name);
  // One object per instance: the fresh list that follows the kept one names the same connection, and a new object would give every read a new client and start them again.
  const connection = useMemo(() => chosen, [chosen?.kind, chosen?.name]);
  // A link names the instance for one page, and every page is a page load now: what it names is remembered, so the next page (a click on Runs, say) opens on it too, as the old one-page board stayed on it.
  useEffect(() => {
    const linked = new URLSearchParams(globalThis.location?.search ?? "").get("connection");
    if (listing !== null && linked !== null && listing.connections.some((candidate) => candidate.name === linked)) remembered(storage, CONNECTION_MEMORY, linked);
  }, [listing, storage]);
  if (listing === null) return <ShellContext.Provider value={LOADING_SHELL}>{children}</ShellContext.Provider>;
  const switchConnection = (next: string) => {
    if (!listing.connections.some((candidate) => candidate.name === next)) return;
    setName(next);
    remembered(storage, CONNECTION_MEMORY, next);
  };
  return (
    <ConnectionReads key={connection?.name ?? ""} listing={listing} connection={connection} switchConnection={switchConnection} retryConnections={retry} fetchWith={fetchWith} {...(reload === undefined ? {} : { reload })}>
      {children}
    </ConnectionReads>
  );
}
