import type { MergedStep } from "./plan-steps.ts";
import type { QueueHead } from "./queue-head.ts";
import type { BlockerPullDeclared, PartialOverruled, PullDeclared } from "./pull-declared.ts";
import type { CiView } from "./ci-note.ts";

export type ViewTicket = Readonly<{
  key: string; title: string; status: string; statusOrder: number; priority: number; project: string | null; parent?: string | null; uploads?: readonly string[];
  /** The keys of its open sub-issues, as the tracker last read them: see `source.ts`. */
  children?: readonly string[];
  /** The state another instance holds it in, when this instance holds no run for it (A11-144): the server sets it (`pick-taken.ts`); absent otherwise. */
  taken?: string;
  /** Why it cannot be queued yet: an open decision, or a screen's behaviour not grilled. The server sets it (`open-decisions.ts`); absent when it can be queued. */
  needsDecision?: Readonly<{ kind: string; reason: string }>;
}>;

/**
 * A ticket in the Pick list's tree, with the tickets under it. A node with tickets under it is a parent: its checkbox picks them, and it is not
 * picked itself. A `context` node is a parent that is not the person's, shown only for its children.
 */
export type TicketNode<T extends ViewTicket = ViewTicket> = Readonly<{ ticket: T; children: readonly TicketNode<T>[]; context?: boolean }>;

/** An event a worker declared it waits on (A11-245), as the board reads it: a ticket by its key and a pull request by its address name a ticket's run; a fleet job, a CI run and an ask for the person's session name none. */
type ViewWait = Readonly<{ kind: "ticket"; key: string }> | Readonly<{ kind: "pullRequest"; url: string }> | Readonly<{ kind: "fleetJob" | "ciRun" | "session" }>;

/** The fields of a queue entry the board reads. */
export type ViewEntry = Readonly<{
  ticket: Readonly<{ key: string; url?: string }>; phase: string; outcome?: Readonly<{ kind: string; prs?: readonly PullRef[]; edit?: ViewEdit; reason?: string; where?: string; unreadable?: boolean }>; waiting?: boolean;
  /** What the first line of the dialog a waiting run sits on says, when the pool could read one (A11-174). */
  prompt?: string;
  /** A Claude Code safety prompt the pool answered No to on this run, the command it asked about (A11-174) and the subagent that raised it, absent for the main agent (A11-209). */
  declined?: Readonly<{ command: string; agent?: string }>;
  trackerState?: string; pullStates?: Readonly<Record<string, string>>; queuedAt?: number; startedAt?: number; finishedAt?: number; workspace?: string;
  pane?: string; blockers?: readonly ViewBlocker[]; model?: string; effort?: string;
  /** Why the plan of a queued run could not be downloaded, which holds it back (A11-125). */
  pathsFailure?: string;
  /** The version of agent-org the run was started on, and, when a breaking update stopped it and queued it again, when and for which release (A11-169). */
  toolVersion?: string;
  stoppedForUpdate?: Readonly<{ at: number; target: string }>;
  /** Set when its worker declared a wait on other tickets and the board stopped the run and queued it again behind them (A11-272): the tickets, and the state last read of each the tracker does not list as a blocker yet. */
  stoppedForBlocker?: Readonly<{ at: number; keys: readonly string[]; states?: Readonly<Record<string, string>> }>;
  /** Set on a run the board holds for its ticket's CI spend (A11-261): why, and `released` once it has been held through two passes of the board. A queued run is a wait on the card until then. */
  ciHold?: Readonly<{ reason: string; released?: true }>;
  /** What the run's and the ticket's pushes cost in CI, as the server reads it from the workflow runs of the ticket's branch (A11-261). Absent until the board has read a run. */
  ci?: CiView;
  /** The board's last resume prompt to a running run (A11-279): when, after a restart or an idle spell since `idleSince`, and herdr's refusal when it would not take it. */
  resume?: Readonly<{ at: number; after: "restart" | "idle"; idleSince?: number; refused?: string; environment?: "restored" | "missing" }>;
  /** Set on a queued round or talk session held back by the working agent of an earlier session: what it waits for (A11-154). */
  sessionWait?: string;
  /** Set on a round or talk session started after the board closed the leftover of an earlier session beside it: what it closed (A11-154). */
  sessionNote?: string;
  /** Set when a person started the run past the overlap it was Blocked on: the run it overlapped, and where (A11-125). */
  overlapOverride?: Readonly<{ holder: string; pull: string | null; path: string | null; at: number }>;
  /** The repositories the run has made worktrees in, once it has made any. */
  repos?: readonly string[];
  /** Set while the ticket still needs its plan: the model and effort its planning run uses. */
  plan?: Readonly<{ model: string; effort: string }>;
  /** Its plan was written by a planning run, not agreed with a person. */
  planned?: boolean;
  /** Set on a queued or planning run whose plan is stale: the description it was planned against and the one the ticket has now (A11-167). */
  ticketChange?: Readonly<{ at: number; from: string; to: string }>;
  /** The changes to its ticket's description sent to the live worker, in order (A11-167). */
  ticketChanges?: readonly Readonly<{ at: number; from: string; to: string }>[];
  /** What the planner of this queued run was given from its blockers' merged pull requests, by the pull request's address (A11-167). */
  learned?: Readonly<Record<string, Readonly<{ key: string; number: number; file: string }>>>;
  /** Set on a review run: the pull requests a person approved. */
  review?: readonly PullRef[];
  /** The run of a batch planner's tickets that its tickets share: one session, one terminal (A11-171). */
  batch?: string;
  /** The finished run a talk session resumes, which the session replaced on the board: a blocker's talk session is judged by it, not as more work on the ticket (A11-206). */
  talkFrom?: Omit<ViewEntry, "talkFrom">;
  /** What each merged pull request of this queued run's blockers declared of its blocker's ticket in its body, by the pull request's address, once the sweep read it (A11-206). */
  blockersDeclared?: Readonly<Record<string, BlockerPullDeclared>>;
  /** A person opened this run's saved session to talk to its agent: the run is Talking while that session is live or waiting for them (A11-171). */
  talk?: boolean;
  /** What remains of the ticket, when the worker declared its pull requests partial: the run's merge does not finish the ticket (A11-92, A11-168). */
  partial?: string;
  /** What the run's merged pull requests declared of the ticket in their bodies, recorded once they are read (A11-181): see {@link PullDeclared}. Unset until read. */
  declared?: PullDeclared;
  /** Set when the merged pull request's declaration overruled the outcome's `partial`: the card names both and the board followed the pull request (A11-181). */
  partialOverruled?: PartialOverruled;
  /** The plan steps of this ticket whose pull requests merged, in order, with the pull requests that finished each: the run is the next step (A11-168). */
  steps?: readonly MergedStep[];
  /** Set when a person moved the ticket to its completed state while the run's work was partial: the person's move wins and the run reads Completed (A11-178). */
  completedBy?: "person";
  /** Why the board could not put back a ticket the tracker's integration completed while the run's work was partial: the card flags the run (A11-178). */
  reopenFailure?: string;
  /** The After-merge lines of the ticket's Done-when, listed once its pull requests merged, each with who runs it (A11-173). Unset until listed; empty is never recorded. */
  afterMerge?: readonly AfterMergeLine[];
  /** How many numbered steps the ticket's plan has, read once from the plan file when a partial pull request merged without saying (A11-173). 0 when the plan has none. */
  planSteps?: number;
  /** The repository its batch's planner said its work lands in, or null when it named none. */
  plannedRepo?: string | null;
  /** The repository its project names, or null when it names none: what a run without a planned repository stacks in (see `repoOf`). */
  projectRepo?: string | null;
  /** The repository-prefixed paths its plan says its work touches, as last read: unset until read, empty when the plan declares none. */
  paths?: readonly string[];
  /** The paths each step section of its plan lists, by step number, when the plan has step sections that list any (A11-175): see `currentStepPaths`. */
  stepPaths?: Readonly<Record<string, readonly string[]>>;
  /**
   * The files each open pull request of the run changes, by URL, as the last watch read them, in the repository the pull request is in. An empty
   * name in a list marks a list cut short: the files past the ones listed are unknown and hold nothing, see {@link footprintOf}.
   */
  pullFiles?: Readonly<Record<string, readonly string[]>>;
  /** The tickets of its batch its planner said it waits on to merge, rather than stacking on: the keys of its blockers that must merge first. */
  waitMerged?: readonly string[];
  /** Set once a publish run posted its pull requests: when, and the first message's web address, or null when it gave none. */
  published?: Readonly<{ link: string | null; at?: number }>;
  /** Where the run ran, recorded when it started (A11-219): see `runTimeline`, which words the run's start from it. */
  worker?: Readonly<{ instance: string }>;
  /** Set when the board stopped answering new feedback on its own and handed the run to a person: why. */
  handedBack?: string;
  /**
   * Set while a running run's worker last said its own background work is still running: its reason, and whether it has stalled, and why (A11-85).
   * `at` is when it said so, `waiting` that the board reads the run as waiting on background work, `waitingOn` the job it named, `until` when it expects the wait to end (A11-236), and `waitText` what the board last read of the events it declared it waits on (A11-245).
   */
  working?: Readonly<{ reason: string; at?: number; stalled?: boolean; stallReason?: string; waiting?: boolean; waitingOn?: string; until?: number; waitText?: string; waits?: readonly ViewWait[] }>;
  /** Set while a reviewer's verdict on one of the run's pull requests is not posted, and the reason it is not (A11-83). */
  verdictNotPosted?: string;
  /** Set while herdr has refused twice, for the same reason, to start the reviewer of one of the run's pull requests: the pull request and herdr's reason (A11-241). */
  reviewerRefused?: string;
  /** Set while a stacked pull request of the run needs its base said: by URL, what is needed (A11-106). */
  retargets?: Readonly<Record<string, string>>;
  /** The blocker branch a run was branched from, and what agent-org has done to keep it on that branch (A11-116). */
  stackBase?: StackBaseRecord;
  /** What the board did about the red checks of each open pull request, by URL: the head it was at, and the line the card shows when the checks were rerun or are named for a person (A11-154). */
  checkHeads?: Readonly<Record<string, CheckHead>>;
  /** What the board did about the merge queue's removals of each open pull request, by URL: the head they were at, and the line the card shows (A11-264). */
  queueHeads?: Readonly<Record<string, QueueHead>>;
  /** The commit each open pull request of the run was at when it ended, by URL: what its question or work was about (A11-153). Unset until read. */
  outcomeHeads?: Readonly<Record<string, string>>;
  /** The open pull requests a `needs-human` run ended with changes requested at their head, by URL, with that head: what it stopped on, so a review lifted at that head clears it (A11-258). Unset when none was blocked, or the end could not read them. */
  outcomeBlocks?: Readonly<Record<string, string>>;
  /** Each open pull request's head now, and whether the newest verdict on it is an approval, by URL, as the last watch read them (A11-153). */
  pullHeads?: Readonly<Record<string, PullHead>>;
}>;

/** A line of a ticket's After-merge section, and who runs it, or null when the line names no one (A11-173). */
export type AfterMergeLine = Readonly<{ line: string; owner: string | null }>;

/**
 * A pull request's head commit, and whether a reviewer other than the workers' account has approved it at that commit, as the last watch read them (A11-153). The rest is what the same read said
 * of the pull request's readiness to merge at that head (A11-179), each field absent until a watch has read it, and when the code host does not say it: `review` is `approved` only when the
 * newest verdict on the head approves and GitHub's own review decision does not still ask for a review or for changes, `changes-requested` when either says changes, and `none` otherwise;
 * `red` is the required checks failing, and `pending` the required checks still running, and `mergeable` that GitHub says it merges cleanly (A11-258; `UNKNOWN`, still being computed, is not mergeable). `blockedSince` is when the board first read the pull request changes-requested at this head, kept while the head and the block
 * stay (A11-213): the stale-block flag counts from it.
 */
export type PullHead = Readonly<{ head: string; approved: boolean; review?: "approved" | "none" | "changes-requested"; red?: readonly string[]; pending?: readonly string[]; mergeable?: boolean; blockedSince?: number }>;

/**
 * What the board did about the red checks on one pull request at one head (A11-154): a fix round was started for them (`round`), the checks that failed for an
 * infrastructure reason were rerun (`rerun`), or they failed again on that head after their rerun and are named for a person (`named`). `note` is the line the
 * card shows for the last two. `not-ours` (A11-179) is a head whose red checks are all ones the run cannot mend, because they fail on the default branch or on pull requests that touch none of the
 * run's files: no round is started and nothing is rerun, `notOurs` names them, each with the ticket that owns it or null, and the record is made again on every watch, so it lasts only as long as the checks are red elsewhere.
 * `waitingOnMain` (A11-215) is which of `notOurs` were red on the default branch when the record was made: the checks the pull request waits on main to mend. When main reports them all passing the board brings the pull request up to date with main
 * and records `updated`, a head it did that from, whose `note` the card keeps showing until the new head's checks have run.
 */
export type CheckHead = Readonly<{ head: string; step: "round" | "rerun" | "named" | "not-ours" | "updated"; note?: string; notOurs?: Readonly<Record<string, string | null>>; waitingOnMain?: readonly string[] }>;

/**
 * The branch a run was branched from: the blocker's key, the repository and branch, the commit it has the blocker's branch merged in up to (`sha`), and what
 * agent-org did since. `seen` is the head the blocker's branch moved to, while it is not merged in yet; `merged` is the last merge (from the old head to the
 * new); `conflict` is a merge that conflicted against that head, and its files: nothing is merged against that head again, and `capped` is the board's round cap
 * when the board's rounds were used up before the conflict was resolved. `rebased` and `failed` are what the rebase this replaced wrote: a record that holds
 * them is read as a merge, and is written as one the next time it changes.
 */
export type StackBaseRecord = Readonly<{
  key: string; repo: string; branch: string; sha: string;
  seen?: string;
  merged?: Readonly<{ from: string; to: string; at: number }>;
  conflict?: Readonly<{ head: string; files: readonly string[]; capped?: number }>;
  rebased?: Readonly<{ from: string; to: string; at: number }>;
  failed?: Readonly<{ head: string; reason: string }>;
}>;

/** A worker's proposed edit to its ticket's text, as a run records it (A11-91): only whether it is there matters to the board. */
export type ViewEdit = Readonly<{ title?: string; description?: string; why: string; base?: Readonly<{ title: string; description: string }> }>;

/** A pull request as a run records it: its web address, and the repository it is in, which is the name `clones` gives it. */
export type PullRef = Readonly<{ url: string; repo?: string }>;

/**
 * A ticket that blocks a queued one: its key, its state's type and name in the tracker, and, where the tracker gave them, its branch and the state
 * of each pull request it links, by URL.
 */
export type ViewBlocker = Readonly<{ key: string; state: string; status: string; branch?: string; head?: string; pulls?: Readonly<Record<string, string>> }>;

/** Where a browser keeps the view's settings between visits; `localStorage` in the page. */
export type Storage = Readonly<{ getItem(name: string): string | null; setItem(name: string, value: string): void }>;

/** The project a ticket with no project falls under. */
export const NO_PROJECT = "(no project)";

export const projectOf = (ticket: ViewTicket): string => ticket.project ?? NO_PROJECT;

/**
 * A ticket has a plan when a file uploaded to it has a name `plan` matches: the host file's `tickets.plan`. A ticket whose uploads were not read
 * has none, so a source that does not read them leaves every ticket unplanned.
 */
export const hasPlan = (ticket: ViewTicket, plan: RegExp): boolean => (ticket.uploads ?? []).some((name) => plan.test(name));

/** Which tickets the plan filter keeps: those with a plan of their own, or those without one. */
export type PlanChoice = "with" | "without";

/** The plan filter in force: the pattern a plan's name matches, and which tickets to keep. */
export type PlanFilter = Readonly<{ pattern: RegExp; choice: PlanChoice }>;

/** The plan filter remembered in the browser, or null, meaning every ticket, for anything else it holds. */
export function planChoiceOf(remembered: ReadonlySet<string>): PlanChoice | null {
  const [choice] = remembered;
  return choice === "with" || choice === "without" ? choice : null;
}

/** How many open sub-issues the tracker says the ticket has, whether or not any of them is in the list. */
export const openChildCount = (ticket: ViewTicket): number => ticket.children?.length ?? 0;

/**
 * A ticket the tracker says has open sub-issues: an epic, with nothing of its own to build. It is never queued itself, so it has no checkbox of
 * its own, and the board offers {@link QUEUE_CHILDREN} instead. Its sub-issues need not be in the list: an epic assigned to the person whose
 * parts are someone else's, or another team's, is still an epic, and a worker given one ends in Needs you with nothing to do (A11-76). One whose
 * sub-issues are all done or canceled has none open, and is an ordinary ticket again.
 */
export const isParentTicket = (ticket: ViewTicket): boolean => openChildCount(ticket) > 0;

/** The button a parent offers in place of queueing it, and what it does. */
export const QUEUE_CHILDREN = "Queue its children";
export const QUEUE_CHILDREN_TITLE = "Queue this ticket's open sub-issues, in the order their blocking relations give, or by identifier where they give none";

/** What a parent's row says of its open sub-issues. PURE. */
export const childrenNote = (ticket: ViewTicket): string => {
  const n = openChildCount(ticket);
  return `Parent · ${n} open sub-issue${n === 1 ? "" : "s"}`;
};

/** The tickets a worker can be given: every one that no other ticket sits under, and none the tracker says has open sub-issues. An epic is not work for a worker. */
export function workItems<T extends ViewTicket>(tickets: readonly T[]): T[] {
  const parents = new Set(tickets.flatMap((t) => (t.parent ? [t.parent] : [])));
  return tickets.filter((t) => !parents.has(t.key) && !isParentTicket(t));
}

/**
 * The keys of each ticket a worker can be given that `keep` is true for, and of every ticket above it, so it still shows under its epic. An epic
 * is kept only for what it holds: what `keep` says of the epic itself does not decide it.
 */
function keptWithAncestors(tickets: readonly ViewTicket[], keep: (ticket: ViewTicket) => boolean): Set<string> {
  const kept = new Set(workItems(tickets).filter(keep).map((t) => t.key));
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  for (const key of [...kept]) {
    for (let above = byKey.get(key)?.parent; above && byKey.has(above) && !kept.has(above); above = byKey.get(above)?.parent) kept.add(above);
  }
  return kept;
}

/** The Pick list's filters. An empty set, an empty search or no plan filter keeps every ticket. */
export type PickFilter = Readonly<{ projects?: ReadonlySet<string>; search?: string; plan?: PlanFilter | null; priorities?: ReadonlySet<number> }>;

/**
 * The tickets to show: in one of the chosen projects, matching every search word, and, for the plan and priority filters, the tickets that meet
 * both, with the epics above them. Both are judged on one ticket, so an epic is kept only for a ticket under it that meets both.
 */
export function visibleTickets<T extends ViewTicket>(tickets: readonly T[], { projects = new Set(), search = "", plan = null, priorities = new Set() }: PickFilter = {}): T[] {
  const words = search.trim().toLowerCase();
  const kept = plan === null && priorities.size === 0 ? null : keptWithAncestors(tickets, (t) =>
    (plan === null || hasPlan(t, plan.pattern) === (plan.choice === "with")) && (priorities.size === 0 || priorities.has(t.priority)));
  return tickets.filter((t) => (projects.size === 0 || projects.has(projectOf(t)))
    && (words === "" || `${t.key} ${t.title} ${t.project ?? ""}`.toLowerCase().includes(words))
    && (kept === null || kept.has(t.key)));
}

/** The tracker's priorities, most urgent first and none last, by number and by the name Linear gives each: 1 is the most urgent, and 0 is none. */
const PRIORITIES: readonly (readonly [number, string])[] = [[1, "Urgent"], [2, "High"], [3, "Medium"], [4, "Low"], [0, "No priority"]];
export const PRIORITY_NAMES: Readonly<Record<number, string>> = Object.fromEntries(PRIORITIES);
const PRIORITY_ORDER = PRIORITIES.map(([priority]) => priority);

/**
 * Each priority that a ticket a worker can be given has, most urgent first and none last, with how many have it. A chosen priority is kept, at 0,
 * when none of these tickets has it, so a choice made in one project still reads on the next.
 */
export function priorityCounts(tickets: readonly ViewTicket[], chosen: ReadonlySet<number> = new Set()): [number, number][] {
  const work = workItems(tickets);
  return PRIORITY_ORDER.map((p): [number, number] => [p, work.filter((t) => t.priority === p).length]).filter(([p, n]) => n > 0 || chosen.has(p));
}

/** The priority filter remembered in the browser, as numbers, dropping anything that is not a priority. */
export const prioritiesOf = (remembered: ReadonlySet<string>): Set<number> =>
  new Set([...remembered].filter((value) => /^\d$/.test(value)).map(Number).filter((p) => PRIORITY_ORDER.includes(p)));

/** How many of the tickets a worker can be given have a plan of their own, and how many have none. */
export function planCounts(tickets: readonly ViewTicket[], plan: RegExp): Readonly<{ with: number; without: number }> {
  const work = workItems(tickets);
  const planned = work.filter((t) => hasPlan(t, plan)).length;
  return { with: planned, without: work.length - planned };
}

/**
 * What the board says about a ticket with no plan of its own, and whether its parent's plan covers it: a worker is briefed with its parent's
 * plan as well as its own. Null when the ticket has a plan. `tickets` is every ticket the board knows, parents included.
 */
export function missingPlan(ticket: ViewTicket, plan: RegExp, tickets: readonly ViewTicket[]): Readonly<{ note: string; covered: boolean }> | null {
  if (hasPlan(ticket, plan)) return null;
  const parent = tickets.find((t) => t.key === ticket.parent);
  if (parent !== undefined && hasPlan(parent, plan)) return { note: `No plan of its own. A worker reads its parent ${parent.key}'s plan.`, covered: true };
  return { note: "No plan attached. Attach one before a worker starts this.", covered: false };
}

/** Each project and how many tickets it holds, most first, then by name. */
export function projectCounts(tickets: readonly ViewTicket[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const t of tickets) counts.set(projectOf(t), (counts.get(projectOf(t)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * The project the Pick list shows: the remembered one while `counts` (the projects the list holds, as `projectCounts` gives them) names it, else the
 * first of them, or null when it holds none. The fallback is not a choice to remember: only a click on a project saves one.
 */
export function chosenProject(counts: readonly (readonly [string, number])[], remembered: string | null): string | null {
  if (remembered !== null && counts.some(([name]) => name === remembered)) return remembered;
  return counts[0]?.[0] ?? null;
}

/** The tickets of one project, by {@link projectOf}: none when no project is chosen. */
export const inProject = <T extends ViewTicket>(tickets: readonly T[], project: string | null): T[] =>
  tickets.filter((t) => project !== null && projectOf(t) === project);

/** The Pick list's order: the workflow's, then by priority (urgent first, none last). */
const pickOrder = (a: ViewTicket, b: ViewTicket): number => {
  const rank = (p: number) => (p === 0 ? 5 : p);
  return a.statusOrder - b.statusOrder || rank(a.priority) - rank(b.priority);
};

/**
 * The tickets as a tree, its heads in the Pick list's order. A ticket whose parent is shown sits under that parent, whatever its own status, so
 * an epic reads with its parts. `parents` are tickets that are not the person's, such as an epic someone else owns: one with a shown ticket
 * under it heads that ticket as a context node. Any other ticket is a head of its own.
 */
export function ticketTree<T extends ViewTicket>(tickets: readonly T[], parents: readonly T[] = []): TicketNode<T>[] {
  const sorted = [...tickets].sort(pickOrder);
  const shown = new Set(sorted.map((t) => t.key));
  const node = (ticket: T): TicketNode<T> => ({ ticket, children: sorted.filter((t) => t.parent === ticket.key).map(node) });
  const roots = sorted.filter((t) => !t.parent || !shown.has(t.parent));
  const context = parents.filter((p) => !shown.has(p.key))
    .map((p): TicketNode<T> => ({ ticket: p, context: true, children: roots.filter((t) => t.parent === p.key).map(node) }))
    .filter((n) => n.children.length > 0);
  const underContext = new Set(context.flatMap((n) => n.children.map((c) => c.ticket.key)));
  return [...context, ...roots.filter((t) => !underContext.has(t.key)).map(node)].sort((a, b) => pickOrder(a.ticket, b.ticket));
}

/** The tree's heads grouped by their own status, in the Pick list's order. A ticket under a head shows in the head's group, whatever its status. */
export function groupByStatus<T extends ViewTicket>(tickets: readonly T[], parents: readonly T[] = []): [string, TicketNode<T>[]][] {
  const groups = new Map<string, TicketNode<T>[]>();
  for (const head of ticketTree(tickets, parents)) groups.set(head.ticket.status, [...(groups.get(head.ticket.status) ?? []), head]);
  return [...groups];
}

/**
 * The tickets a person can pick in a tree, in its order. Every parent is left out, the person's own and a context node alike, and the tickets
 * under it are in: an epic is not work for a worker, so picking a parent picks the tickets under it instead.
 */
export const flatten = <T extends ViewTicket>(nodes: readonly TicketNode<T>[]): T[] =>
  nodes.flatMap((n) => (n.children.length > 0 ? flatten(n.children) : n.context ? [] : [n.ticket]));

/** How many tickets a tree holds, at any depth. */
export const ticketCount = (nodes: readonly TicketNode[]): number => nodes.reduce((n, node) => n + 1 + ticketCount(node.children), 0);

/** The key of every parent in a tree, at any depth, each before the parents under it. */
export const parentKeys = (nodes: readonly TicketNode[]): string[] =>
  nodes.flatMap((n) => (n.children.length > 0 ? [n.ticket.key, ...parentKeys(n.children)] : []));

/**
 * A ticket can be selected when it is not on the queue already, is not a parent (the queue refuses one: `queue.ts`'s `refuseParents`), holds no open
 * decision (the queue refuses that too: `queue-entries-and-outcomes.ts`'s `refuseDecisions`), and is not taken by another instance (A11-144).
 */
export const selectable = (ticket: ViewTicket, entries: readonly ViewEntry[]): boolean =>
  !isParentTicket(ticket) && ticket.needsDecision === undefined && ticket.taken === undefined && !entries.some((e) => e.ticket.key === ticket.key);

/**
 * A parent's checkbox: the keys of the tickets under it, at any depth, that can still be picked, ticked when every one is selected and part
 * ticked when only some are. A parent with none left to pick has an empty `keys`, and its checkbox is disabled.
 */
export function parentTick(node: TicketNode, selected: ReadonlySet<string>, entries: readonly ViewEntry[]): Readonly<{ keys: string[]; checked: boolean; indeterminate: boolean }> {
  const keys = flatten(node.children).filter((t) => selectable(t, entries)).map((t) => t.key);
  const picked = keys.filter((key) => selected.has(key)).length;
  return { keys, checked: keys.length > 0 && picked === keys.length, indeterminate: picked > 0 && picked < keys.length };
}

/** `values` with `value` added, or taken out when it was there. A new set: the old one is left as it was. */
export function toggled<T>(values: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(values);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/** A remembered set, or an empty one when there is none or the browser refuses storage. */
export function recall(storage: Storage | null, name: string): Set<string> {
  try {
    const saved = JSON.parse(storage?.getItem(name) ?? "[]");
    return new Set(Array.isArray(saved) ? saved.map(String) : []);
  } catch {
    return new Set();
  }
}

/** Remember a set; a browser that refuses storage just forgets it. */
export function remember(storage: Storage | null, name: string, values: ReadonlySet<string>): void {
  try {
    storage?.setItem(name, JSON.stringify([...values]));
  } catch {
    // storage refused: the view works without it
  }
}

/** A run's status on the board, after GitHub's Actions runs: each has its own icon and filter. */
export type RunStatus =
  "needs-you" | "talking" | "working" | "waiting" | "planning" | "reviewing" | "blocked" | "queued" | "awaiting-review" | "ready-to-merge" | "publishing" | "published" | "checked"
  | "completed" | "failed" | "cancelled";

/** Every status, in the order the filters list them: what needs a person first, what is settled last. */
export const RUN_STATUSES: readonly Readonly<{ status: RunStatus; label: string }>[] = [
  { status: "needs-you", label: "Needs you" },
  { status: "talking", label: "Talking" },
  { status: "working", label: "In progress" },
  { status: "waiting", label: "Waiting" },
  { status: "planning", label: "Planning" },
  { status: "reviewing", label: "Reviewing" },
  { status: "blocked", label: "Blocked" },
  { status: "queued", label: "Queued" },
  { status: "awaiting-review", label: "Awaiting review" },
  { status: "ready-to-merge", label: "Ready to merge" },
  { status: "publishing", label: "Publishing" },
  { status: "published", label: "Published" },
  { status: "checked", label: "Checked" },
  { status: "completed", label: "Completed" },
  { status: "failed", label: "Failed" },
  { status: "cancelled", label: "Cancelled" },
];

/**
 * Outcomes that hand the ticket back to a person: the worker could not decide, the work belongs elsewhere, or it stopped without saying. The
 * board shows such a run as Needs you, and the pool parks it rather than closing its workspace, so the person can answer the agent there.
 */
export const HANDED_BACK: ReadonlySet<string> = new Set(["needs-human", "wrong-repo", "no-outcome"]);

/**
 * Outcomes after which the run needs nothing more: the worker checked the ticket and found nothing to change (`checked`), the worker verified the
 * ticket is finished and the board completed it (`done`, A11-91), or a planning run wrote its plan (`planned`). Nobody answers such a run, so the
 * pool closes its workspace as soon as the outcome is recorded, and it is not retried. Unlike {@link HANDED_BACK}, it never reads as Needs you.
 */
export const CONCLUDED: ReadonlySet<string> = new Set(["checked", "done", "planned"]);

/** Outcomes that are a run's result, pull requests to show for it: a draft one, or one a review run saw through its review. */
export const RESULT_KINDS: ReadonlySet<string> = new Set(["draft-pr", "ready-pr", "reviewed"]);

/** The pull requests a run is about: its result's, or, for a review run that has none yet, the ones the person approved. */
export function pullsOf<T extends Readonly<{ url: string }>>(entry: Readonly<{ outcome?: Readonly<{ kind: string; prs?: readonly T[] }>; review?: readonly T[] }>): readonly T[] {
  const { outcome } = entry;
  return outcome !== undefined && RESULT_KINDS.has(outcome.kind) ? (outcome.prs ?? []) : (entry.review ?? []);
}

/** The run's pull requests that are still open, as last read: neither merged nor closed. */
export function openPulls<T extends Readonly<{ url: string }>>(entry: Readonly<{ outcome?: Readonly<{ kind: string; prs?: readonly T[] }>; review?: readonly T[];
  pullStates?: Readonly<Record<string, string>> }>): T[] {
  return pullsOf(entry).filter(({ url }) => entry.pullStates?.[url] !== "merged" && entry.pullStates?.[url] !== "closed");
}
