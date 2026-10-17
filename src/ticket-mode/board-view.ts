// @ts-check
// module: the ticket board page's logic -- which tickets show, how they group, what can be selected, what status a run has -- as pure functions
//
// WRITTEN HERE, IN TYPESCRIPT, SO ITS TESTS RUN IT, AND SENT TO THE BROWSER WITH THE TYPES STRIPPED (`server.ts` serves it as `/board-view.js`
// through Node's own `stripTypeScriptTypes`). The page (`ui.html`) only draws what these functions return and wires the clicks. So it imports
// nothing and uses no Node API: it must run as it is in a browser.
//
// A RULE THE PAGE AND THE POOL BOTH APPLY IS DEFINED HERE ONCE. Which outcomes hand a ticket back (`HANDED_BACK`) and what a parked run is
// (`isParked`) decide what the board shows and what the pool does, so `queue.ts` and `pool.ts` import them from here rather than restating them.

/** The fields of a ticket the board shows. */
export type ViewTicket = Readonly<{
  key: string; title: string; status: string; statusOrder: number; priority: number; project: string | null; parent?: string | null; uploads?: readonly string[];
  /** The keys of its open sub-issues, as the tracker last read them: see `source.ts`. */
  children?: readonly string[];
}>;

/**
 * A ticket in the Pick list's tree, with the tickets under it. A node with tickets under it is a parent: its checkbox picks them, and it is not
 * picked itself. A `context` node is a parent that is not the person's, shown only for its children.
 */
export type TicketNode<T extends ViewTicket = ViewTicket> = Readonly<{ ticket: T; children: readonly TicketNode<T>[]; context?: boolean }>;

/** The fields of a queue entry the board reads. */
export type ViewEntry = Readonly<{
  ticket: Readonly<{ key: string }>; phase: string; outcome?: Readonly<{ kind: string; prs?: readonly PullRef[] }>; waiting?: boolean;
  trackerState?: string; pullStates?: Readonly<Record<string, string>>; queuedAt?: number; startedAt?: number; finishedAt?: number; workspace?: string;
  pane?: string; blockers?: readonly ViewBlocker[]; model?: string; effort?: string;
  /** Set while the ticket still needs its plan: the model and effort its planning run uses. */
  plan?: Readonly<{ model: string; effort: string }>;
  /** Its plan was written by a planning run, not agreed with a person. */
  planned?: boolean;
  /** Set on a review run: the pull requests a person approved. */
  review?: readonly PullRef[];
  /** The repository its batch's planner said its work lands in, or null when it named none. */
  plannedRepo?: string | null;
  /** The batch the run is planned in, or unset for a ticket planned alone: the tickets of one batch are one run. */
  batch?: string;
  /** The repository-prefixed paths its plan says its work touches, as last read: unset until read, empty when the plan declares none. */
  paths?: readonly string[];
  /** The files each open pull request of the run changes, by URL, as the last watch read them, in the repository the pull request is in. */
  pullFiles?: Readonly<Record<string, readonly string[]>>;
  /** The tickets of its batch its planner said it waits on to merge, rather than stacking on: the keys of its blockers that must merge first. */
  waitMerged?: readonly string[];
  /** Set once a publish run posted its pull requests: the first message's web address, or null when it gave none. */
  published?: Readonly<{ link: string | null }>;
  /** Set when the board stopped answering new feedback on its own and handed the run to a person: why. */
  handedBack?: string;
  /** Set while a running run's worker last said its own background work is still running: its reason, and whether it has stalled. */
  working?: Readonly<{ reason: string; stalled?: boolean }>;
}>;

/** A pull request as a run records it: its web address, and the repository it is in, which is the name `clones` gives it. */
export type PullRef = Readonly<{ url: string; repo?: string }>;

/**
 * A ticket that blocks a queued one: its key, its state's type and name in the tracker, and, where the tracker gave them, its branch and the state
 * of each pull request it links, by URL.
 */
export type ViewBlocker = Readonly<{ key: string; state: string; status: string; branch?: string; pulls?: Readonly<Record<string, string>> }>;

/** Where a browser keeps the view's settings between visits; `localStorage` in the page. */
export type Storage = Readonly<{ getItem(name: string): string | null; setItem(name: string, value: string): void }>;

/** The project chip a ticket with no project falls under. */
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

/** Each priority that a ticket a worker can be given has, most urgent first and none last, with how many have it. */
export function priorityCounts(tickets: readonly ViewTicket[]): [number, number][] {
  const work = workItems(tickets);
  return PRIORITY_ORDER.map((p): [number, number] => [p, work.filter((t) => t.priority === p).length]).filter(([, n]) => n > 0);
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

/** A ticket can be selected when it is not on the queue already, and is not a parent: the queue refuses one (`queue.ts`'s `refuseParents`). */
export const selectable = (ticket: ViewTicket, entries: readonly ViewEntry[]): boolean =>
  !isParentTicket(ticket) && !entries.some((e) => e.ticket.key === ticket.key);

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
  "needs-you" | "working" | "planning" | "reviewing" | "blocked" | "queued" | "awaiting-review" | "ready-to-merge" | "publishing" | "published" | "checked"
  | "completed" | "failed" | "cancelled";

/** Every status, in the order the filters list them: what needs a person first, what is settled last. */
export const RUN_STATUSES: readonly Readonly<{ status: RunStatus; label: string }>[] = [
  { status: "needs-you", label: "Needs you" },
  { status: "working", label: "In progress" },
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
 * Outcomes after which the run needs nothing more: the worker checked the ticket and found nothing to change (`checked`), or a planning run
 * wrote its plan (`planned`). Nobody answers such a run, so the pool closes its workspace as soon as the outcome is recorded, and it is not
 * retried. Unlike {@link HANDED_BACK}, it never reads as Needs you.
 */
export const CONCLUDED: ReadonlySet<string> = new Set(["checked", "planned"]);

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

/**
 * A finished run's status from its pull requests alone, once each has merged or closed: completed when any merged, cancelled when every one
 * closed unmerged. `null` while one is still open, and for a run with none.
 */
export function settledByPulls(entry: ViewEntry): RunStatus | null {
  const states = (entry.outcome?.prs ?? []).map(({ url }) => entry.pullStates?.[url]);
  if (states.length === 0 || !states.every((state) => state === "merged" || state === "closed")) return null;
  return states.includes("merged") ? "completed" : "cancelled";
}

/**
 * The blockers still holding a queued run back, given every run on the queue. A blocker lets go once the tracker completes it, or, when it is on
 * the queue itself, once its run is completed, which its pull requests merging is enough for. A blocker the planner said to wait on to merge
 * (`waitMerged`) also lets go once its pull requests have merged ({@link pullsMerged}). A canceled or duplicate blocker never lets go: the
 * work it promised will not come, so a person decides. Waiting is not on order: an unblocked run queued later starts first. A blocker the run can
 * be stacked on ({@link stackedOn}) does not hold it back.
 */
export function waitsOn(entry: ViewEntry, entries: readonly ViewEntry[]): ViewBlocker[] {
  return (entry.blockers ?? []).filter((blocker) => !isDoneFor(entry, blocker, entries) && stackPullOf(entry, blocker) === null);
}

/** Whether the planner said the run waits for this blocker to merge, rather than stacking on it: its key is in the run's `waitMerged`. */
const waitsToMerge = (entry: ViewEntry, blocker: ViewBlocker): boolean => (entry.waitMerged ?? []).includes(blocker.key);

/** Whether a blocker is done: the tracker completed it, or its run on the queue is Completed. */
function isDone(blocker: ViewBlocker, entries: readonly ViewEntry[]): boolean {
  if (blocker.state === "completed") return true;
  const run = entries.find((e) => e.ticket.key === blocker.key);
  return run !== undefined && run.phase === "finished" && runStatus(run) === "completed";
}

/**
 * Whether a blocker's pull requests have merged: at least one has, and none is still open. Linear completes a ticket on a merge only where its
 * team's workflow says so, so a run the planner held until the merge must not wait on the tracker's word alone. A canceled or duplicate blocker
 * never lets go, whatever its pull requests did.
 */
function pullsMerged(blocker: ViewBlocker): boolean {
  if (blocker.state === "canceled" || blocker.state === "duplicate") return false;
  const states = Object.values(blocker.pulls ?? {});
  return states.includes("merged") && !states.includes("open");
}

/** Whether a blocker is done for a run: {@link isDone}, and, for one the run waits on to merge, once its pull requests have merged ({@link pullsMerged}). */
const isDoneFor = (entry: ViewEntry, blocker: ViewBlocker, entries: readonly ViewEntry[]): boolean =>
  isDone(blocker, entries) || (waitsToMerge(entry, blocker) && pullsMerged(blocker));

/** The repository and number of a GitHub pull request, from its URL's `/<owner>/<repo>/pull/<n>`, or null for any other URL. PURE. */
function parsePull(url: string): Readonly<{ repo: string; number: string }> | null {
  const match = /^https:\/\/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)\/?$/.exec(url);
  return match === null ? null : { repo: match[1], number: match[2] };
}

/** The repository a GitHub pull request is in, or null for a URL that is not one. */
export const repoOfPull = (url: string): string | null => parsePull(url)?.repo ?? null;

/**
 * The URL of a blocker's open pull request (a draft is open) in `repo`, or null when it has none there, or no repository is named. A canceled or
 * duplicate blocker has none to stack on, because the work it promised will not come, and nor has one whose branch is unknown.
 */
function stackPull(blocker: ViewBlocker, repo: string | null | undefined): string | null {
  if (!blocker.branch || blocker.state === "canceled" || blocker.state === "duplicate") return null;
  return Object.entries(blocker.pulls ?? {}).find(([url, state]) => state === "open" && repoOfPull(url) === repo)?.[0] ?? null;
}

/** The open pull request a run of `entry` can stack on for `blocker`: none when the planner said to wait for the blocker to merge. */
const stackPullOf = (entry: ViewEntry, blocker: ViewBlocker): string | null =>
  waitsToMerge(entry, blocker) ? null : stackPull(blocker, entry.plannedRepo);

/** A blocker a run starts on top of: its key, its open pull request, the repository that is in, which is the run's, and its branch. */
export type StackBase = Readonly<{ key: string; url: string; repo: string; branch: string }>;

/**
 * The blockers a run starts on top of rather than waits for. A blocker not yet done is one when the run's planner placed its work in a
 * repository where the blocker has an open pull request: the run branches from the blocker's branch, and its pull request is stacked on the
 * blocker's. A blocker the planner said to wait on to merge is never one. A run with no planned repository stacks on nothing, and a finished run
 * is stacked on nothing any more.
 */
export function stackedOn(entry: ViewEntry, entries: readonly ViewEntry[]): StackBase[] {
  const repo = entry.plannedRepo;
  if (entry.phase === "finished" || !repo) return [];
  return (entry.blockers ?? []).flatMap((blocker) => {
    const url = isDoneFor(entry, blocker, entries) ? null : stackPullOf(entry, blocker);
    return url === null || !blocker.branch ? [] : [{ key: blocker.key, url, repo, branch: blocker.branch }];
  });
}

/** What the board says about a run stacked on its blockers, such as "Stacked on NBF-1 #12". */
export const stackNote = (bases: readonly StackBase[]): string => `Stacked on ${bases.map(({ key, url }) => `${key} #${parsePull(url)?.number ?? url}`).join(", ")}`;

/**
 * What the board says about a queued run held back, or null when none holds it: until its blockers merge, such as "Waits for NBF-1 to merge", or
 * for a path another run holds, such as "Waits on NBF-1 #12: both touch pool.ts".
 */
export function waitNote(entry: ViewEntry, entries: readonly ViewEntry[]): string | null {
  const keys = waitsOn(entry, entries).filter((blocker) => waitsToMerge(entry, blocker)).map(({ key }) => key);
  if (keys.length > 0) return `Waits for ${keys.join(", ")} to merge`;
  const overlap = overlapWait(entry, entries);
  return overlap === null ? null : `Waits on ${overlap.key}${overlap.pull === null ? "" : ` #${overlap.pull}`}: both touch ${overlap.path}`;
}

/** Split a repository-prefixed path, `<repo>:<path>`, into its repository and its path within it. PURE. */
const repoPath = (path: string): [string, string] => {
  const cut = path.indexOf(":");
  return [path.slice(0, cut), path.slice(cut + 1)];
};

/**
 * Whether two repository-prefixed paths touch the same files: they are in one repository, and are equal, or one is a directory (its path ends in
 * `/`) that holds the other. Sibling directories, and a file and a directory it is not in, do not overlap. PURE.
 */
export function pathsOverlap(a: string, b: string): boolean {
  const [repoA, pathA] = repoPath(a);
  const [repoB, pathB] = repoPath(b);
  if (repoA !== repoB) return false;
  return pathA === pathB || (pathA.endsWith("/") && pathB.startsWith(pathA)) || (pathB.endsWith("/") && pathA.startsWith(pathB));
}

/**
 * A run's footprint: the paths its plan says its work touches, and the files each of its open pull requests changes, each in the repository that
 * pull request is in. PURE.
 */
export function footprintOf(entry: ViewEntry): string[] {
  const changed = openPulls(entry).flatMap(({ url, repo }) => (repo === undefined ? [] : (entry.pullFiles?.[url] ?? []).map((file) => `${repo}:${file}`)));
  return [...(entry.paths ?? []), ...changed];
}

/** The tracker's states that end a ticket's work: a run on such a ticket is done, or was dropped, and holds nothing once it is not live. */
const ENDED_TICKETS: ReadonlySet<string> = new Set(["completed", "canceled", "duplicate"]);

/**
 * Whether a run holds its footprint against the runs queued behind it: it is live, or it has a pull request still open and its ticket has not
 * ended. That is a finished run, a draft too, or a queued review round, which keeps the pull requests it continues.
 */
const holds = (entry: ViewEntry): boolean => {
  if (entry.phase === "starting" || entry.phase === "running") return true;
  const pullsOpen = entry.phase === "finished" || entry.review !== undefined;
  return pullsOpen && openPulls(entry).length > 0 && !ENDED_TICKETS.has(entry.trackerState ?? "");
};

/**
 * Whether a holder is exempt from a queued run: one of its own blockers, or a run that is blocked by it. Those are sequenced on purpose
 * (`waitsOn`, `stackedOn`), so they are never held against each other.
 */
const exempt = (entry: ViewEntry, other: ViewEntry): boolean =>
  (entry.blockers ?? []).some(({ key }) => key === other.ticket.key) || (other.blockers ?? []).some(({ key }) => key === entry.ticket.key);

/** The run a queued run waits on for a shared path: its key, the number of its first open pull request when it has one, and the path both touch. */
export type OverlapWait = Readonly<{ key: string; pull: string | null; path: string }>;

/**
 * Why a queued run waits, for a path it shares with a run already held in its repository (see {@link holds}), or null when it waits on none. A
 * run is not held by one that is its own batch's, nor by one of whose blockers it is or that is one of its blockers, since those are sequenced on
 * purpose (`waitsOn`, `stackedOn`). A review round, a conflict round and a planning run are never held, and nor is a run with no paths declared.
 * `entries` is the whole queue, or the queue with the runs a pass has just chosen counted as starting, so a batch of starts keeps to one another. PURE.
 */
export function overlapWait(entry: ViewEntry, entries: readonly ViewEntry[]): OverlapWait | null {
  const mine = entry.paths ?? [];
  if (entry.phase !== "queued" || entry.plan !== undefined || entry.review !== undefined || mine.length === 0) return null;
  for (const other of entries) {
    if (other.ticket.key === entry.ticket.key || !holds(other) || (entry.batch !== undefined && other.batch === entry.batch) || exempt(entry, other)) continue;
    const held = footprintOf(other);
    const path = mine.find((own) => held.some((theirs) => pathsOverlap(own, theirs)));
    if (path !== undefined) return { key: other.ticket.key, pull: parsePull(openPulls(other)[0]?.url ?? "")?.number ?? null, path: repoPath(path)[1] };
  }
  return null;
}

/**
 * A run's status. A queued run is blocked while a ticket that blocks it is not done, and cannot be stacked on (`entries` is the whole queue, for {@link waitsOn}),
 * or while it waits on a path another run holds ({@link overlapWait}). The
 * tracker's word wins once the run has finished: a ticket it completed is done and one it canceled is cancelled, whatever the run ended in. Then
 * its pull requests: Linear completes a ticket on a merge only where its team's workflow says so, so a run whose pull requests merged is done
 * even while its ticket is still in progress. Before either, the outcome decides. It never answers Publishing: that is {@link shownStatus}'s.
 */
export function runStatus(entry: ViewEntry, entries: readonly ViewEntry[] = []): RunStatus {
  if (entry.phase === "queued") return waitsOn(entry, entries).length > 0 || overlapWait(entry, entries) !== null ? "blocked" : "queued";
  if (entry.phase !== "finished") return entry.waiting ? "needs-you" : entry.plan ? "planning" : entry.review ? "reviewing" : "working";
  if (entry.trackerState === "completed") return "completed";
  if (entry.trackerState === "canceled" || entry.trackerState === "duplicate") return "cancelled";
  const kind = entry.outcome?.kind ?? "";
  if (kind === "draft-pr" || kind === "ready-pr") return settledByPulls(entry) ?? "awaiting-review";
  if (kind === "reviewed") return settledByPulls(entry) ?? (entry.handedBack !== undefined ? "needs-you" : entry.published ? "published" : "ready-to-merge");
  if (HANDED_BACK.has(kind)) return "needs-you";
  if (kind === "checked") return "checked";
  return kind === "stopped" ? "cancelled" : "failed";
}

/**
 * The note a running run shows from its worker's `working` outcome: its reason, which says what of its own is still running, or, once its agent
 * has sat idle with no newer outcome for `tickets.stallMinutes`, that it has stalled, with that reason. Null for any other run. The run's status
 * stays In progress either way: nothing is asked of a person, and a stalled run is only flagged so it is not forgotten.
 */
export function workingNote(entry: ViewEntry): Readonly<{ text: string; stalled: boolean }> | null {
  const note = entry.working;
  if (entry.phase !== "running" || note === undefined) return null;
  return note.stalled === true
    ? { text: `Stalled: idle with no newer outcome since it said: ${note.reason}`, stalled: true }
    : { text: note.reason, stalled: false };
}

/**
 * The status the board shows for a run: its {@link runStatus}, except that a run Ready to merge is Publishing while the board's `publish` run is
 * posting it. The pool, and what a run offers or is watched for, go by `runStatus`, which still calls that run Ready to merge.
 */
export function shownStatus(entry: ViewEntry, publish: ViewPublish | undefined, entries: readonly ViewEntry[] = []): RunStatus {
  const status = runStatus(entry, entries);
  return status === "ready-to-merge" && isBeingPublished(entry, publish) ? "publishing" : status;
}

/** How many runs have each status, as the board shows them. */
export function statusCounts(entries: readonly ViewEntry[], publish?: ViewPublish): Map<RunStatus, number> {
  const counts = new Map<RunStatus, number>(RUN_STATUSES.map(({ status }) => [status, 0]));
  for (const status of entries.map((entry) => shownStatus(entry, publish, entries))) counts.set(status, (counts.get(status) ?? 0) + 1);
  return counts;
}

/** The runs a filter shows (every run for `null`), the most recently active first, as GitHub lists its runs. */
export function runsShown<T extends ViewEntry>(entries: readonly T[], filter: RunStatus | null, publish?: ViewPublish): T[] {
  const latest = (entry: ViewEntry) => entry.finishedAt ?? entry.startedAt ?? entry.queuedAt ?? 0;
  return entries.filter((entry) => filter === null || shownStatus(entry, publish, entries) === filter).sort((a, b) => latest(b) - latest(a));
}

/** A parked run: a finished one that kept its herdr workspace, so a person can still answer its agent there. It holds no slot. */
export const isParked = (entry: ViewEntry): boolean => entry.phase === "finished" && entry.workspace !== undefined;

/** What a person can do to a run from the board. */
export type RunAction = "remove" | "stop" | "retry" | "close" | "approve" | "respond" | "dismiss";

/** Why a person presses Approve, shown as its tooltip: the drafts are reviewed. */
export const APPROVE_TITLE = "Drafts reviewed and approved: mark the pull requests ready, then see them through their checks and review";

/** Why a person presses Respond to review, shown as its tooltip: the pull requests are ready, and have feedback to answer. */
export const RESPOND_TITLE = "Answer the feedback on these ready pull requests now: their reviews, comments and failing checks";

/** Why a person presses Dismiss, shown as its tooltip: only the board's record goes. */
export const DISMISS_TITLE = "Take this run off the board, closing its workspace if it is open. The ticket, its branch and its pull requests are left as they are";

/**
 * The actions a run offers. A queued run can be removed and a live one stopped. A finished run that kept its workspace (parked) can be closed,
 * and only once it is closed can it be retried. Pull requests are results, and are not retried, and nor is a run that concluded with nothing more
 * to do ({@link CONCLUDED}). Drafts awaiting review offer Approve, which marks them ready. Ready ones (Ready to merge, Published, or handed back
 * after the board's own rounds) offer Respond to review, which answers their feedback now. EVERY FINISHED RUN OFFERS DISMISS, last, a parked one
 * too, so no run stays on the board for ever: it takes the run off the board and closes its workspace if one is open. A run the publish run under
 * way is posting is the exception: `queue.ts`'s `dismiss` keeps it until it has posted, so it is not offered there either.
 */
export function runActions(entry: ViewEntry, publish?: ViewPublish): RunAction[] {
  if (entry.phase === "queued") return ["remove"];
  if (entry.phase !== "finished") return ["stop"];
  const dismiss: RunAction[] = isBeingPublished(entry, publish) ? [] : ["dismiss"];
  if (isParked(entry)) return ["close", ...dismiss];
  const status = runStatus(entry);
  if (status === "awaiting-review" && entry.outcome?.kind === "draft-pr") return ["approve", ...dismiss];
  if (status === "ready-to-merge" || status === "published" || (status === "needs-you" && entry.handedBack !== undefined)) return ["respond", ...dismiss];
  const kind = entry.outcome?.kind;
  const done = kind === undefined || RESULT_KINDS.has(kind) || CONCLUDED.has(kind) || status === "completed";
  return [...(done ? [] : ["retry" as const]), ...dismiss];
}

/**
 * Whether the board watches a run's pull requests for new feedback: it is Ready to merge or Published, or a ready-pr run waiting for review
 * (opened ready on a machine with `tickets.drafts: false`, with no Approve to come). It holds no workspace, and has a pull request still open.
 * Merged or closed pull requests are never watched.
 */
export function isWatched(entry: ViewEntry): boolean {
  const status = runStatus(entry);
  const waitingReady = status === "awaiting-review" && entry.outcome?.kind === "ready-pr";
  return (status === "ready-to-merge" || status === "published" || waitingReady) && !isParked(entry) && openPulls(entry).length > 0;
}

/** The fields of the board's publish run that the page reads: its workspace and pane are set once it runs, and dropped when it ends. */
export type ViewPublish = Readonly<{ keys: readonly string[]; phase: string; failure?: string; workspace?: string; pane?: string }>;

/** Whether the publish run is still to finish: queued, starting or running. */
export const isPublishing = (publish: ViewPublish | undefined): boolean => publish !== undefined && publish.phase !== "finished";

/** Whether the publish run still to finish is the one posting this run's pull requests. */
export const isBeingPublished = (entry: ViewEntry, publish: ViewPublish | undefined): boolean =>
  isPublishing(publish) && publish?.keys.includes(entry.ticket.key) === true;

/**
 * A run can be ticked for Publish only once it is Ready to merge: a person approved its pull requests and they passed their review and checks.
 * A published run, a parked one, and one the publish run in progress holds are not.
 */
export const publishable = (entry: ViewEntry, publish?: ViewPublish): boolean =>
  runStatus(entry) === "ready-to-merge" && !isParked(entry) && !isBeingPublished(entry, publish);

/** The Publish button's words for `count` ticked runs. */
export const publishLabel = (count: number): string => `Publish selected (${count})`;

/** What the Board says about the last publish run: that it is under way, or why it failed. Null once it published, and when there is none. */
export function publishNote(publish: ViewPublish | undefined): string | null {
  if (publish === undefined) return null;
  const runs = `${publish.keys.length} run${publish.keys.length === 1 ? "" : "s"}`;
  if (isPublishing(publish)) return `Publishing ${runs}`;
  return publish.failure === undefined ? null : `Publishing ${runs} failed: ${publish.failure}`;
}

/**
 * The web address of a run's live terminal: `template` (the host file's `tickets.terminal`) with the run's `{workspace}`, `{pane}` and `{key}`
 * filled in, each encoded for a URL. Null when the machine serves no terminal or the run holds no pane.
 */
export function terminalLink(template: string | null, entry: ViewEntry): string | null {
  if (template === null || entry.workspace === undefined || entry.pane === undefined) return null;
  const values: Readonly<Record<string, string>> = { workspace: entry.workspace, pane: entry.pane, key: entry.ticket.key };
  return template.replace(/\{(workspace|pane|key)\}/g, (_, name: string) => encodeURIComponent(values[name]));
}

/**
 * The web address of the publish run's terminal, which every run that shows Publishing links on its own row: `terminalLink` with the publish
 * run's workspace and pane in place of the run's own. Null for any other run, and while the publish run has no pane yet.
 */
export const publishTerminalLink = (template: string | null, entry: ViewEntry, publish: ViewPublish | undefined): string | null =>
  shownStatus(entry, publish) === "publishing" ? terminalLink(template, { ...entry, workspace: publish?.workspace, pane: publish?.pane }) : null;

type Choice = Readonly<{ model: string; effort: string }>;

/** The model and effort the tickets queued next run with: the default, with the parts chosen for this batch in its place. */
export const batchChoice = (defaults: Choice, batch: Partial<Choice>): Choice => ({ ...defaults, ...batch });

/**
 * The parts of `chosen` that differ from the default, which is all a batch keeps. A part chosen equal to the default is dropped, so the batch
 * follows the default there when the default changes.
 */
export const batchOverride = (defaults: Choice, chosen: Choice): Partial<Choice> => ({
  ...(chosen.model === defaults.model ? {} : { model: chosen.model }),
  ...(chosen.effort === defaults.effort ? {} : { effort: chosen.effort }),
});

/** Whether a batch runs on the default, having chosen nothing of its own. */
export const isDefaultBatch = (batch: Partial<Choice>): boolean => Object.keys(batch).length === 0;

/** What the Pick footer says beside the batch's model and effort. */
export const batchNote = (defaults: Choice, batch: Partial<Choice>): string =>
  isDefaultBatch(batch) ? "The default" : `These tickets only. The default is ${defaults.model} at ${defaults.effort} effort`;

/** What the Board says about how many workers run at once. */
export const workersLabel = (max: number): string => `Up to ${max} worker${max === 1 ? "" : "s"} at once`;

/** The Queue button's words for `count` selected tickets, `planning` of which are planned first. */
export function queueLabel(count: number, planning = 0): string {
  if (count === 0) return "Select tickets to queue";
  const queue = `Queue ${count} ticket${count === 1 ? "" : "s"}`;
  if (planning === 0) return queue;
  const which = planning < count ? String(planning) : count === 1 ? "it" : "all";
  return `${queue}, planning ${which} first`;
}

/** How many of `tickets` have no plan of their own, so would be planned first. */
export const unplannedCount = (tickets: readonly ViewTicket[], plan: RegExp): number => tickets.filter((t) => !hasPlan(t, plan)).length;

/**
 * The model and effort a run uses, as its row names them: a ticket still to be planned names its planning run's too, and one worked from a
 * planning run's plan says so, since nobody agreed that plan.
 */
export function runChoiceLabel(entry: ViewEntry): string {
  const run = `${entry.model}/${entry.effort}`;
  if (entry.plan) return `plan on ${entry.plan.model}/${entry.plan.effort}, then ${run}`;
  return entry.planned ? `${run} on an unattended plan` : run;
}

/** `url` when it is an http or https address, and "" otherwise, so a link a remote board sends can never run script in this page. */
export const safeHref = (url: unknown): string => (typeof url === "string" && /^https?:\/\//i.test(url) ? url : "");

/** An instance the header's switcher offers: its connection's name, and how it is reached. */
export type ViewConnection = Readonly<{ name: string; kind: "local" | "ssh" | "https" }>;

/** The connection to show: the one this browser remembers while it is still listed, this machine's otherwise, then the first, and null with none. */
export function chosenConnection(connections: readonly ViewConnection[], remembered: string | null): ViewConnection | null {
  return connections.find((c) => c.name === remembered) ?? connections.find((c) => c.kind === "local") ?? connections[0] ?? null;
}

/** Where a connection's API is: under `/c/<connection>`, which the page's service passes on to that instance. */
export const apiBase = (connection: ViewConnection | null): string => (connection === null ? "" : `/c/${encodeURIComponent(connection.name)}`);

/** What the switcher calls a connection. */
export const connectionLabel = (connection: ViewConnection): string => (connection.kind === "local" ? `${connection.name} (this machine)` : connection.name);
