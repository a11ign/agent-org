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
  /**
   * The keys of its sub-issues that are still open: not completed, canceled or a duplicate. A ticket with one is a PARENT, an epic with nothing
   * of its own to build, so it is never queued itself: the board offers to queue these instead (A11-76). Read in the same request as the
   * ticket, never one request per ticket. Once every sub-issue is done or canceled it is empty, and the ticket is an ordinary one again. Absent
   * from a ticket stored on the queue before they were read, and from a source that does not read them, which leaves every ticket ordinary.
   */
  children?: readonly string[];
  /**
   * The names of the files uploaded to it, as the tracker titles them. A link to elsewhere, such as a pull request, is not one. Absent from a
   * ticket stored on the queue before they were read, and from a source that does not read them.
   */
  uploads?: readonly string[];
}>;

/** A pull request's state as the tracker last saw it. A draft, or one in review, is `open`. */
export type PullState = "open" | "merged" | "closed";

/**
 * A ticket that blocks another, as the tracker last saw it: its state's type and name, the branch it links pull requests by, and the state of each
 * pull request it links, by URL. `branch` is absent from a blocker read before it was recorded.
 */
export type Blocker = Readonly<{ key: string; state: string; status: string; branch?: string; pulls: Readonly<Record<string, PullState>> }>;

export interface TicketSource {
  /**
   * Every unfinished ticket the Pick view lists: by default those assigned to the person whose key this is, or, where the host file's
   * `tickets.pick` names a team or a project, every one of that team or project, whoever it is assigned to. Throws when the tracker cannot be asked.
   */
  assigned(): Promise<readonly Ticket[]>;
  /**
   * The name of the person whose key this is, for the Pick view to say whose tickets it found none of. A source without it is named as "you".
   * Throws when the tracker cannot be asked.
   */
  viewer?(): Promise<string>;
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
  /**
   * The tickets that block each key's ticket, by key, as the tracker records "blocked by". A key the tracker has no ticket for is left out. A
   * source without it never holds a queued run back. Throws when the tracker cannot be asked.
   */
  blockers?(keys: readonly string[]): Promise<ReadonlyMap<string, readonly Blocker[]>>;
  /**
   * Attach a planning run's files to the ticket, each titled with its file name, and move the ticket to the state named `state` when it has not
   * started and its team has a state of that name. Teams name their states differently, so one without it keeps the ticket's state, and the
   * returned note says so; it is null when nothing was left undone. A file already attached under its name is not attached again, so an attempt
   * that was cut off can be repeated. A source without it takes no plans, so the board offers no planning. Throws when the tracker refuses.
   */
  attachPlan?(key: string, files: readonly string[], state: string | null): Promise<string | null>;
  /**
   * Move the ticket to the state named `state` as a worker starts implementing it, when it has not started yet. A ticket already started, or
   * finished, is left where it is. A team with no state of that name keeps the ticket's state, and the returned note says so; it is null
   * otherwise. A source without it moves nothing. Throws when the tracker refuses.
   */
  moveToWorkingState?(key: string, state: string): Promise<string | null>;
  /**
   * Record in the tracker that each of `blockerKeys` blocks the ticket `key`, as "blocked by" reads it back. A relation the tracker already has
   * is not made again, so an attempt that was cut off can be repeated. A source without it records no order. Throws when the tracker refuses.
   */
  addBlockers?(key: string, blockerKeys: readonly string[]): Promise<void>;
}
