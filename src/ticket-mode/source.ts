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
   * Each key's state TYPE in the tracker (`completed`, `canceled`, `started`, ...), for the keys the tracker knows. It is how the board learns a run's
   * pull requests landed: Linear's GitHub integration moves an issue to a completed state when its pull request merges. A source without it never
   * marks a run completed. Throws when the tracker cannot be asked.
   */
  stateTypes?(keys: readonly string[]): Promise<ReadonlyMap<string, string>>;
}
