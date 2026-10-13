// @ts-check
// module: the tracker ticket mode reads -- one interface, so a second tracker is one new file and no change to the board or the pool
//
// BESIDE THE TICKET PORT, NOT INSIDE IT. `src/ticket-port/port.ts` serves the gate: every read there is synchronous because the gate is, and a fifth
// operation or an asynchronous adapter is a ruling for `ceo` (its header). Ticket mode is not the gate. It needs two reads and a download, all
// asynchronous over HTTP, so it states its own small contract here rather than stretching the port's. Linear (`linear.ts`) is the first source.

/** One ticket as the board shows it and a worker is briefed with it. */
export type Ticket = Readonly<{
  /** The tracker's identifier, e.g. `NBF-1270`. */
  key: string;
  title: string;
  /** Markdown, as the tracker stores it. */
  description: string;
  url: string;
  /** The branch the tracker links a pull request by. */
  branch: string;
  /** The status's name and its position in the team's workflow, for grouping the board the way the tracker does. */
  status: string;
  statusOrder: number;
  team: string;
  project: string | null;
  /** 0 is none, 1 is the most urgent. */
  priority: number;
  /** The key of the ticket this one is part of, whose plan may bind it, or `null`. */
  parent: string | null;
}>;

/** A pull request's state as the tracker last saw it. A draft, or one in review, is `open`. */
export type PullState = "open" | "merged" | "closed";

export interface TicketSource {
  /** Every unfinished ticket assigned to the person whose key this is. Throws when the tracker cannot be asked. */
  assigned(): Promise<readonly Ticket[]>;
  /** One ticket by key, or `null` when the tracker has none by that key. Throws when the tracker cannot be asked. */
  read(key: string): Promise<Ticket | null>;
  /**
   * Fetch the files the ticket's description links to, and the files attached to it, into `dir`, returning their paths. Short-lived links make this
   * a step of preparing a worker.
   */
  download(ticket: Ticket, dir: string): Promise<readonly string[]>;
  /**
   * Each key's state TYPE in the tracker (`completed`, `canceled`, `started`, ...), for the keys the tracker knows. A ticket completed or canceled
   * settles its run, whatever the run ended in. A source without it never settles a run from its ticket. Throws when the tracker cannot be asked.
   */
  stateTypes?(keys: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /**
   * The state of every pull request each key's ticket links, by key and then by the pull request's URL. A merged pull request can sit on a
   * ticket that is still in progress, because Linear completes a ticket on a merge only where its team's workflow says so. A source without it
   * leaves a run to its ticket's state. Throws when the tracker cannot be asked.
   */
  pullStates?(keys: readonly string[]): Promise<ReadonlyMap<string, Readonly<Record<string, PullState>>>>;
}
