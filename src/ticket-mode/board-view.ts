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
}>;

/**
 * A ticket in the Pick list's tree, with the tickets under it. A node with tickets under it is a parent: its checkbox picks them, and it is not
 * picked itself. A `context` node is a parent that is not the person's, shown only for its children.
 */
export type TicketNode<T extends ViewTicket = ViewTicket> = Readonly<{ ticket: T; children: readonly TicketNode<T>[]; context?: boolean }>;

/** The fields of a queue entry the board reads. */
export type ViewEntry = Readonly<{
  ticket: Readonly<{ key: string }>; phase: string; outcome?: Readonly<{ kind: string; prs?: readonly Readonly<{ url: string }>[] }>; waiting?: boolean;
  trackerState?: string; pullStates?: Readonly<Record<string, string>>; queuedAt?: number; startedAt?: number; finishedAt?: number; workspace?: string;
  pane?: string; blockers?: readonly ViewBlocker[];
}>;

/** A ticket that blocks a queued one: its key, and its state's type and name in the tracker. */
export type ViewBlocker = Readonly<{ key: string; state: string; status: string }>;

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

/** The tickets a worker can be given: every one that no other ticket sits under. An epic is not work for a worker. */
export function workItems<T extends ViewTicket>(tickets: readonly T[]): T[] {
  const parents = new Set(tickets.flatMap((t) => (t.parent ? [t.parent] : [])));
  return tickets.filter((t) => !parents.has(t.key));
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

/** A ticket can be selected when it is not on the queue already. */
export const selectable = (ticket: ViewTicket, entries: readonly ViewEntry[]): boolean => !entries.some((e) => e.ticket.key === ticket.key);

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
export type RunStatus = "needs-you" | "working" | "blocked" | "queued" | "awaiting-review" | "completed" | "failed" | "cancelled";

/** Every status, in the order the filters list them: what needs a person first, what is settled last. */
export const RUN_STATUSES: readonly Readonly<{ status: RunStatus; label: string }>[] = [
  { status: "needs-you", label: "Needs you" },
  { status: "working", label: "In progress" },
  { status: "blocked", label: "Blocked" },
  { status: "queued", label: "Queued" },
  { status: "awaiting-review", label: "Awaiting review" },
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
 * the queue itself, once its run is completed, which its pull requests merging is enough for. A canceled or duplicate blocker never lets go: the
 * work it promised will not come, so a person decides. Waiting is not on order: an unblocked run queued later starts first.
 */
export function waitsOn(entry: ViewEntry, entries: readonly ViewEntry[]): ViewBlocker[] {
  return (entry.blockers ?? []).filter((blocker) => {
    if (blocker.state === "completed") return false;
    const run = entries.find((e) => e.ticket.key === blocker.key);
    return run === undefined || run.phase !== "finished" || runStatus(run) !== "completed";
  });
}

/**
 * A run's status. A queued run is blocked while a ticket that blocks it is not done (`entries` is the whole queue, for {@link waitsOn}). The
 * tracker's word wins once the run has finished: a ticket it completed is done and one it canceled is cancelled, whatever the run ended in. Then
 * its pull requests: Linear completes a ticket on a merge only where its team's workflow says so, so a run whose pull requests merged is done
 * even while its ticket is still in progress. Before either, the outcome decides.
 */
export function runStatus(entry: ViewEntry, entries: readonly ViewEntry[] = []): RunStatus {
  if (entry.phase === "queued") return waitsOn(entry, entries).length > 0 ? "blocked" : "queued";
  if (entry.phase !== "finished") return entry.waiting ? "needs-you" : "working";
  if (entry.trackerState === "completed") return "completed";
  if (entry.trackerState === "canceled" || entry.trackerState === "duplicate") return "cancelled";
  const kind = entry.outcome?.kind ?? "";
  if (kind === "draft-pr") return settledByPulls(entry) ?? "awaiting-review";
  if (HANDED_BACK.has(kind)) return "needs-you";
  return kind === "stopped" ? "cancelled" : "failed";
}

/** How many runs have each status. */
export function statusCounts(entries: readonly ViewEntry[]): Map<RunStatus, number> {
  const counts = new Map<RunStatus, number>(RUN_STATUSES.map(({ status }) => [status, 0]));
  for (const status of entries.map((entry) => runStatus(entry, entries))) counts.set(status, (counts.get(status) ?? 0) + 1);
  return counts;
}

/** The runs a filter shows (every run for `null`), the most recently active first, as GitHub lists its runs. */
export function runsShown<T extends ViewEntry>(entries: readonly T[], filter: RunStatus | null): T[] {
  const latest = (entry: ViewEntry) => entry.finishedAt ?? entry.startedAt ?? entry.queuedAt ?? 0;
  return entries.filter((entry) => filter === null || runStatus(entry, entries) === filter).sort((a, b) => latest(b) - latest(a));
}

/** A parked run: a finished one that kept its herdr workspace, so a person can still answer its agent there. It holds no slot. */
export const isParked = (entry: ViewEntry): boolean => entry.phase === "finished" && entry.workspace !== undefined;

/** What a person can do to a run from the board. */
export type RunAction = "remove" | "stop" | "retry" | "close";

/**
 * The actions a run offers. A queued run can be removed and a live one stopped. A finished run that kept its workspace (parked) can be closed,
 * and only once it is closed can it be retried. A draft pull request and a completed ticket are results, so they are not retried.
 */
export function runActions(entry: ViewEntry): RunAction[] {
  if (entry.phase === "queued") return ["remove"];
  if (entry.phase !== "finished") return ["stop"];
  if (isParked(entry)) return ["close"];
  return entry.outcome === undefined || entry.outcome.kind === "draft-pr" || runStatus(entry) === "completed" ? [] : ["retry"];
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

/** The Queue button's words for `count` selected tickets. */
export const queueLabel = (count: number): string => (count === 0 ? "Select tickets to queue" : `Queue ${count} ticket${count === 1 ? "" : "s"}`);
