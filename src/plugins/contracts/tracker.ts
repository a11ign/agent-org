// @ts-check
// module: the tracker contract, version 1.1 -- ticket mode's `TicketSource`, and what a new-ticket run needs of the tracker (A11-158, A11-159)
//
// A TYPE FILE, WITH TWO CONSTANTS: it imports nothing, so a plugin that implements it reaches no file of core. `TicketSource` is what the Linear plugin's `linearSource`
// implements (`plugins/linear/linear.ts`), and NOT `TicketPort` of `src/ticket-port/port.ts`, which is the row-mode gate's tracker of GitHub issues.
// `src/ticket-mode/source.ts` re-exports every name here, so no caller changed when the contract moved.
//
// 1.1 (A11-159) ADDS `TrackerWriting`, which a tracker plugin declares in its manifest (`agentOrg.tooling.writer`): the tools a new-ticket run files with, what the hook refuses of
// them, how a created ticket's key is read from a tool's answer, the priority numbers and the tools the writer reads duplicates with. It is manifest data and not code, because the
// PreToolUse hook is a process started for every tool call and must not import a plugin to answer one (the hook reads it from the registry).

/** The tracker contract's version, `<major>.<minor>`: a minor only adds, and a major breaks (`src/plugins/version.ts`). */
export const TRACKER_CONTRACT_VERSION = "1.1";

/**
 * A label on a ticket, and the GROUP it belongs to: the label above it, where the tracker nests labels, or `null` for a label that stands alone.
 * Linear calls a group a parent label, and keeps its child labels exclusive, so a ticket has at most one label of each group; the board relies
 * on nothing of that, and filters a ticket with two as having both.
 */
export type TicketLabel = Readonly<{ name: string; group: string | null }>;

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
  /** The state's type as the tracker names it, such as `started` for In Progress: absent from a source that does not read it (A11-144). */
  statusType?: string;
  statusOrder: number;
  team: string;
  project: string | null;
  /** 0 is none, 1 is the most urgent. */
  priority: number;
  /** The key of the ticket this one is part of, whose plan may bind it, or `null`. */
  parent: string | null;
  /**
   * The summary of its project as the tracker holds it, where a repository's address is written (`github.com/<owner>/<repo>`, see `project-repo.ts`).
   * Absent from a ticket stored on the queue before it was read, and from a source that does not read projects, which leaves every run to name its own.
   */
  projectSummary?: string | null;
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
  /**
   * Its labels, each with its group, for the Pick view's label filters. Read in the same request as the ticket, never one request per ticket.
   * Absent from a ticket stored on the queue before they were read, and from a source that does not read them, which leaves the Pick view with
   * no label rows: a tracker without labels needs nothing here.
   */
  labels?: readonly TicketLabel[];
  /**
   * The person the ticket is assigned to, or `null` for a ticket nobody has been given. The Pick view's Assignee filter reads it. Absent from a
   * ticket stored on the queue before it was read, and from a source that does not read assignees, which leaves the Pick view with no Assignee row.
   */
  assignee?: Assignee | null;
}>;

/** A person in the tracker, as a ticket names them: the id that tells two people with one name apart, and the name shown. */
export type Assignee = Readonly<{ id: string; name: string }>;

/** A pull request's state as the tracker last saw it. A draft, or one in review, is `open`. */
export type PullState = "open" | "merged" | "closed";

/**
 * The two words a tracker reads in a pull request's body to link it to a ticket: `closing`, which completes the ticket when the pull request merges,
 * and `nonClosing`, which only links it. Linear reads `Closes` as the first and `Refs` as the second.
 */
export type Keywords = Readonly<{ closing: string; nonClosing: string }>;

/** The words a tracker reads in a pull request's body when it declares none: `Closes` completes the ticket on merge and `Refs` only links it. */
export const DEFAULT_KEYWORDS: Keywords = Object.freeze({ closing: "Closes", nonClosing: "Refs" });

/** The priorities a ticket writer's form may name, most urgent first. */
export const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * What a new-ticket run needs of the tracker (contract 1.1), declared by the plugin as manifest data (`agentOrg.tooling.writer`):
 * - `label`: how the tracker is named in the brief and in doctor's words, such as `Linear`;
 * - `createTool` and `attachTools`: the tool names a new-ticket run is granted, to file one ticket and attach its plan. No other tool of the tracker is granted;
 * - `filingTools`: a regular expression, anchored at both ends, over every tool name that files or attaches on any server of the tracker. A build worker is refused each by name;
 * - `refusedInputs`: an input the creation tool may not be called with, and the rest of the refusal's sentence (`<tool> <refusal>`);
 * - `attachTicketInput`: the input of an attach tool that names the ticket, which must be one the run created;
 * - `createdKey`: how a creation's answer names the ticket's key: the JSON field that wraps the ticket, if any, and the fields tried in order;
 * - `priorities`: the tracker's number for each priority the form names;
 * - `readTools`: the tool names a connector pattern must let through for the writer to check duplicates;
 * - `briefNote`: one sentence the brief adds about which server's tools to use.
 */
export type TrackerWriting = Readonly<{
  label: string;
  createTool: string;
  attachTools: readonly string[];
  filingTools: string;
  refusedInputs: readonly Readonly<{ input: string; refusal: string }>[];
  attachTicketInput: string;
  createdKey: Readonly<{ wrapper: string | null; fields: readonly string[] }>;
  priorities: Readonly<Record<Priority, number>>;
  readTools: readonly string[];
  briefNote: string;
}>;

/**
 * A ticket that blocks another, as the tracker last saw it: its state's type and name, the branch it links pull requests by, and the state of each
 * pull request it links, by URL. `branch` is absent from a blocker read before it was recorded. `head` is the commit that branch is at on the remote
 * of the repository the blocked run works in, which the pool reads (`git ls-remote`): absent when the branch is not pushed there, and it is what
 * makes a blocker stackable, since a pull request is not needed for that.
 */
export type Blocker = Readonly<{ key: string; state: string; status: string; branch?: string; head?: string; pulls: Readonly<Record<string, PullState>> }>;

/**
 * A state move the board made on a ticket, by the state NAMES the tracker shows: the state the ticket was in before, and the one it moved it to.
 * The board keeps it on the run, so it can put the ticket back.
 */
export type StateMove = Readonly<{ from: string; to: string }>;

/** Who holds the open tickets: each person with how many, how many nobody holds, and the total. Read with the assignee alone, so it is small. */
export type People = Readonly<{ people: readonly Readonly<{ id: string; name: string; count: number }>[]; unassigned: number; total: number }>;

/** One page of a scope's tickets, and the cursor of the page after it, or `null` at the end. */
export type ScopePage = Readonly<{ tickets: readonly Ticket[]; next: string | null }>;

export interface TicketSource {
  /**
   * Every unfinished ticket the Pick view lists, each with its assignee: the key's own, or, where the host file's `tickets.pick` names a team or a
   * project, every one of that team or project. Whom to show is the Pick view's choice: a source that also reads `people()` and `scoped()` is asked for
   * the other people's tickets one scope at a time, and one that does not lists everything it has here. Throws when the tracker cannot be asked.
   */
  assigned(): Promise<readonly Ticket[]>;
  /**
   * The name of the person whose key this is, for the Pick view to say whose tickets it found none of. A source without it is named as "you".
   * Throws when the tracker cannot be asked.
   */
  viewer?(): Promise<string>;
  /**
   * The person whose key this is, by id and name, for the Pick view's Assignee filter. The board asks once and keeps the answer, so a source need not
   * cache it. Throws when the tracker cannot be asked, and the Pick view then lists every ticket, as a source without it does.
   */
  me?(): Promise<Assignee>;
  /**
   * Who holds the open tickets, for the Assignee row's counts when `assigned()` lists only the key's own. Throws when the tracker cannot be asked.
   * A source without it lists everything it has in `assigned()`.
   */
  people?(): Promise<People>;
  /**
   * One page of the open tickets of a scope the Assignee row can choose: a person's id, `"unassigned"`, or `"anyone"`, each page starting after the cursor
   * the page before it gave (`null` for the first). Paged because Anyone and Unassigned can hold thousands. Throws when the tracker cannot be asked.
   */
  scoped?(scope: string, after: string | null): Promise<ScopePage>;
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
   * The summary of each key's project, as the tracker holds it now, for the keys whose ticket has a project. A repository is named there, so a
   * queued run's repository is read from it (`project-repo.ts`). A key with no project is left out. A source without it leaves each run to the
   * summary its ticket was queued with. Throws when the tracker cannot be asked.
   */
  projectSummaries?(keys: readonly string[]): Promise<ReadonlyMap<string, string | null>>;
  /**
   * Attach a planning run's files to the ticket, each titled with its file name, and move the ticket to the state named `state` when it has not
   * started and its team has a state of that name. Teams name their states differently, so one without it keeps the ticket's state, and the
   * returned note says so; it is null when nothing was left undone. A file already attached under its name is not attached again, so an attempt
   * that was cut off can be repeated. A source without it takes no plans, so the board offers no planning. Throws when the tracker refuses.
   */
  attachPlan?(key: string, files: readonly string[], state: string | null): Promise<string | null>;
  /**
   * Move the ticket to the state named `state` as a worker starts implementing it, when it has not started yet. A ticket already started, or
   * finished, is left where it is, and `moved` is null. When it moves, `moved` is the state it was in and the one it is in now, so the board can
   * put it back. A team with no state of that name keeps the ticket's state, and the returned note says so; the note is null otherwise. A source
   * without it moves nothing. Throws when the tracker refuses.
   */
  moveToWorkingState?(key: string, state: string): Promise<Readonly<{ moved: StateMove | null; note: string | null }>>;
  /**
   * Put a ticket the board moved back in the state it was in, `move.from`, but only while it is still in `move.to`: a person who has moved it
   * since has moved it on, and it is left alone. A team that no longer has the state `move.from` keeps the ticket's state, and the returned note
   * says so; the note is null otherwise. A source without it cannot undo a move. Throws when the tracker refuses.
   */
  restoreState?(key: string, move: StateMove): Promise<string | null>;
  /**
   * Record in the tracker that each of `blockerKeys` blocks the ticket `key`, as "blocked by" reads it back. A relation the tracker already has
   * is not made again, so an attempt that was cut off can be repeated. A source without it records no order. Throws when the tracker refuses.
   */
  addBlockers?(key: string, blockerKeys: readonly string[]): Promise<void>;
  /**
   * The words the tracker reads a pull request's body by. A source without them is read by {@link DEFAULT_KEYWORDS}, so the brief and `pr:open` name
   * the same words the tracker does.
   */
  keywords?: Keywords;
  /**
   * Complete a ticket the tracker has not finished: move the ticket to its team's completed state and post `comment` on it. Used once a pull request of
   * the run that worked it merged and its body did not complete it, and once a worker's `done` verified every Done-when item (A11-91). A ticket already
   * completed, canceled or a duplicate is left alone, with no comment, so a call that races the tracker's own completion does nothing. A team with no
   * completed state keeps the ticket where it is, and the returned note says so; it is null otherwise. A source without it leaves completion to the
   * tracker. Throws when the tracker refuses.
   */
  complete?(key: string, comment: string): Promise<string | null>;
  /**
   * Write a ticket's title and description, the fields given and no others, once a person has applied a worker's proposed edit to it (A11-91). A
   * source without it cannot apply one. Throws when the tracker refuses.
   */
  updateTicketText?(key: string, text: Readonly<{ title?: string; description?: string }>): Promise<void>;
}
