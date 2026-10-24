import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { chosenConnection } from "../../../src/ticket-mode/board-view.ts";
import { chosenProject, inProject, projectCounts } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import { queueIsEmpty } from "../api/emptiness.ts";
import { createClient } from "../api/client.ts";
import type { Fetch } from "../api/request.ts";
import type { ConfigView, QueueView, TicketView, ViewConnection } from "../api/types.ts";
import { usePoll } from "../api/use-poll.ts";
import type { LifecycleView } from "../lifecycle/Lifecycle.tsx";
import { ALL_GOALS_ID, goalEntries, goalShown, runningCount, ticketsView, type GoalEntry } from "./shell-model.ts";
import { browserStorage, CONNECTION_MEMORY, PROJECT_MEMORY, recalled, remembered } from "./storage.ts";

/** Everything the sidebar reads, once, so a page reuses it and never reads it again. */
export type ShellValue = Readonly<{
  /** False until `/api/connections` has answered. */
  connectionsReady: boolean;
  connections: readonly ViewConnection[];
  /** The instance the whole UI is showing: null while the list is not read, and when it is empty (the reads then go to `/api/*` at the root). */
  connection: ViewConnection | null;
  /** Why the connections file was refused, in the service's own sentence, or null. */
  connectionsRefusal: string | null;
  switchConnection: (name: string) => void;
  retryConnections: () => void;
  /** `/api/queue`, polled every 5s: the Runs badge, the connection pill and the Runs and Run detail pages. */
  queue: LifecycleView<QueueView>;
  /** `/api/tickets`, read once per connection and shown as the default Assignee scope: the Tickets count, the projects and the goals, and the Tickets page. */
  tickets: LifecycleView<TicketView[]>;
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
const LOADING_VIEW = { state: "loading", data: null, refusal: null, refresh: noop } as const;

/** The shell as it is before anything is read: nothing chosen, everything loading. */
const LOADING_SHELL: ShellValue = {
  connectionsReady: false, connections: [], connection: null, connectionsRefusal: null, switchConnection: noop, retryConnections: noop,
  queue: LOADING_VIEW, tickets: LOADING_VIEW, runningRuns: null, ticketCount: null,
  projects: [], project: null, chooseProject: noop, goals: [], goal: ALL_GOALS_ID, chooseGoal: noop, projectTickets: [],
};

const ShellContext = createContext<ShellValue>(LOADING_SHELL);

/** The shell's reads, for the sidebar and the page inside it. */
export const useShell = (): ShellValue => useContext(ShellContext);

type Listing = Readonly<{ connections: readonly ViewConnection[]; refusal: string | null }>;

/** `/api/connections`, read once (and again on `retry`). A read that fails leaves an empty list, as `ui.html` does: this is the only case under `pnpm ui:dev`. */
function useListing(fetchWith: Fetch | undefined): Readonly<{ listing: Listing | null; retry: () => void }> {
  const [listing, setListing] = useState<Listing | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const reading = new AbortController();
    void createClient(null, fetchWith === undefined ? {} : { fetch: fetchWith }).connections(reading.signal).then((answer) => {
      if (!reading.signal.aborted) setListing(answer.ok ? { connections: answer.data.connections, refusal: answer.data.refusal } : { connections: [], refusal: null });
    });
    return () => reading.abort();
  }, [fetchWith, attempt]);
  return { listing, retry: () => setAttempt((count) => count + 1) };
}

/** The instance the page opens on: a link's `?connection=` (A11-129), else the one this browser remembers. `chosenConnection` then falls back to this machine's. */
const nameToOpenOn = (storage: Storage | null): string | null => new URLSearchParams(globalThis.location?.search ?? "").get("connection") ?? recalled(storage, CONNECTION_MEMORY);

type Chosen = Readonly<{
  listing: Listing;
  connection: ViewConnection | null;
  switchConnection: (name: string) => void;
  retryConnections: () => void;
  fetchWith: Fetch | undefined;
  children: ReactNode;
}>;

/** The reads of one connection. It is keyed by the connection, so a switch drops every read and every choice made on the other instance. */
function ConnectionReads({ listing, connection, switchConnection, retryConnections, fetchWith, children }: Chosen) {
  const client = useMemo(() => createClient(connection, fetchWith === undefined ? {} : { fetch: fetchWith }), [connection, fetchWith]);
  const config = usePoll<ConfigView>(client.config, { connection, repeat: false, isEmpty: () => false });
  const queue = usePoll<QueueView>(client.queue, { connection, isEmpty: queueIsEmpty });
  const ticketsRead = usePoll<TicketView[]>(client.tickets, { connection, repeat: false });
  const storage = browserStorage();
  const [rememberedProject, setRememberedProject] = useState(() => recalled(storage, PROJECT_MEMORY));
  const [goalChoice, setGoalChoice] = useState(ALL_GOALS_ID);

  const tickets = { ...ticketsView(ticketsRead, config), refresh: ticketsRead.refresh };
  const projects = projectCounts(tickets.data ?? []);
  const project = chosenProject(projects, rememberedProject);
  const projectTickets = inProject(tickets.data ?? [], project);
  const goals = goalEntries(projectTickets);
  const loadingTickets = tickets.state === "loading";

  const value: ShellValue = {
    connectionsReady: true, connections: listing.connections, connection, connectionsRefusal: listing.refusal, switchConnection, retryConnections,
    queue, tickets, runningRuns: queue.data === null ? null : runningCount(queue.data), ticketCount: loadingTickets ? null : projectTickets.length,
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
 * remembers the choice and gives every read a new client for that instance, which starts them again from `loading`. `fetchWith` is for a test; the page uses the browser's.
 */
export function ShellProvider({ fetchWith, children }: Readonly<{ fetchWith?: Fetch; children: ReactNode }>) {
  const { listing, retry } = useListing(fetchWith);
  const storage = browserStorage();
  const [name, setName] = useState<string | null>(() => nameToOpenOn(storage));
  const connection = useMemo(() => (listing === null ? null : chosenConnection(listing.connections, name)), [listing, name]);
  if (listing === null) return <ShellContext.Provider value={LOADING_SHELL}>{children}</ShellContext.Provider>;
  const switchConnection = (next: string) => {
    if (!listing.connections.some((candidate) => candidate.name === next)) return;
    setName(next);
    remembered(storage, CONNECTION_MEMORY, next);
  };
  return (
    <ConnectionReads key={connection?.name ?? ""} listing={listing} connection={connection} switchConnection={switchConnection} retryConnections={retry} fetchWith={fetchWith}>
      {children}
    </ConnectionReads>
  );
}
