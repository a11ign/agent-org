// module: what the Tickets page shows, worked out from what the shell has read and what the person chose -- the sections, their counts, the Assignee segments, the filter menus and the
// queue options -- as pure functions
//
// THE RULES ARE TODAY'S (`ui.html`'s Pick tab): which tickets show, how they group, what can be picked and what a filter keeps are `board-view.ts`, `assignee-filter.ts` and
// `label-filters.ts`. They are imported here, never restated.
import { inScope, scopeChips, scopeEmptyText, scopeToRead, scopeWord, YOU, type ScopeChip } from "../../../src/ticket-mode/assignee-filter.ts";
import { PRIORITY_NAMES, selectable, type TicketNode, flatten, groupByStatus, parentKeys, planCounts, priorityCounts, visibleTickets, type PlanChoice } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import { batchChoice, isDefaultBatch, unplannedCount } from "../../../src/ticket-mode/board-view/pull-status-and-notes.ts";
import { clearedRow, labelRows, withLabels, type LabelRow } from "../../../src/ticket-mode/label-filters.ts";
import type { ConfigView, QueueView, TicketView } from "../api/types.ts";
import { ticketsOfGoal } from "../shell/shell-model.ts";

/** The label group the sidebar's Goals choose, which the label filters leave out. */
export const GOAL_GROUP = "Goal";

/** The words a segment of the Assignee group reads for the signed-in person's own tickets, as the boards word it. */
export const MINE = "Mine";

/** What the person has chosen to narrow the list by. An empty set, an empty search or no plan choice keeps every ticket. */
export type Filters = Readonly<{
  search: string;
  priorities: ReadonlySet<number>;
  plan: PlanChoice | null;
  labels: ReadonlySet<string>;
  /** The sidebar's Goal choice: an id from `shell-model.ts`. */
  goal: string;
}>;

/** The pattern a plan's name matches (the host file's `tickets.plan`), or null when the board looks for none. */
export const planPatternOf = (config: ConfigView | null): RegExp | null => (config?.plan ? new RegExp(config.plan) : null);

/** The label choices that are the page's to apply: a choice of the `Goal` group is the sidebar's, and no control here shows it. PURE. */
export const labelChoicesOf = (chosen: ReadonlySet<string>): Set<string> => clearedRow(chosen, GOAL_GROUP);

/**
 * The tickets the filters keep, of the chosen project in the chosen scope. The search, the priorities and the plan are `visibleTickets`' (which keeps an epic above a ticket that
 * meets them), the labels are `withLabels`' over the project's label rows and the wider list's, and the goal is the sidebar's. PURE.
 */
export function shownTickets(projectTickets: readonly TicketView[], universe: readonly TicketView[], filters: Filters, plan: RegExp | null): TicketView[] {
  const planFilter = plan !== null && filters.plan !== null ? { pattern: plan, choice: filters.plan } : null;
  const kept = visibleTickets(ticketsOfGoal(projectTickets, filters.goal), { search: filters.search, plan: planFilter, priorities: filters.priorities });
  return withLabels(kept, labelChoicesOf(filters.labels), projectTickets, universe);
}

/** One status of the list: its tickets as a tree, how many the filters keep and how many the project holds in the status. */
export type Section = Readonly<{ status: string; nodes: readonly TicketNode<TicketView>[]; shown: number; total: number }>;

/**
 * The sections: one per status the project has tickets in, in the Pick list's order, each with the tickets the filters keep (none is a section that reads "No tickets match this
 * filter") and the number the project holds in it. A status only the filtered tickets have, which a ticket whose parent the filters dropped can make, follows them. PURE.
 */
export function sectionsOf(all: readonly TicketView[], kept: readonly TicketView[], context: readonly TicketView[]): Section[] {
  const keptByStatus = new Map(groupByStatus(kept, context));
  const held = groupByStatus(all, context);
  const statuses = [...held.map(([status]) => status), ...[...keptByStatus.keys()].filter((status) => !held.some(([other]) => other === status))];
  return statuses.map((status) => {
    const nodes = keptByStatus.get(status) ?? [];
    const shown = flatten(nodes).length;
    return { status, nodes, shown, total: Math.max(shown, flatten(held.find(([other]) => other === status)?.[1] ?? []).length) };
  });
}

/** The tickets a person can pick in a section: shown, and not a parent, not held, not taken, and not on the queue already. PURE. */
export const pickableIn = (section: Section, queue: QueueView | null): TicketView[] => flatten(section.nodes).filter((ticket) => selectable(ticket, queue?.entries ?? []));

/** The key of every parent in the sections, at any depth. PURE. */
export const parentsOf = (sections: readonly Section[]): string[] => sections.flatMap((section) => parentKeys(section.nodes));

/** Whether every section is open and every parent in them, which is when the header's button reads "Collapse all". PURE. */
export const everythingOpen = (sections: readonly Section[], open: ReadonlySet<string>, openParents: ReadonlySet<string>): boolean =>
  sections.length > 0 && sections.every(({ status }) => open.has(status)) && parentsOf(sections).every((key) => openParents.has(key));

/** One segment of the Assignee group. The count is only the pressed segment's, as the boards draw it; `undefined` while that scope is still being read. */
export type Segment = Readonly<{ scope: string; text: string; pressed: boolean; count: number | undefined }>;

/** What the Assignee segments are made from. */
export type SegmentSource = Readonly<{
  /** The chosen project's tickets whatever the scope (every ticket when no project is chosen), which each segment counts. */
  projectTickets: readonly TicketView[];
  all: readonly TicketView[];
  scope: string;
  config: ConfigView;
  held: Parameters<typeof scopeChips>[3];
  scopesRead: ReadonlySet<string>;
}>;

/** The scope chips `assignee-filter.ts` makes, for the signed-in person's own tickets, other people and the rest. PURE. */
export const chipsOf = ({ projectTickets, all, scope, config, held }: SegmentSource): ScopeChip[] => scopeChips(projectTickets, scope, config.viewer ?? null, held, all);

/** Whether the page holds the tickets of `scope`: on an instance that reads scopes on demand, a scope not read yet has no count to show. PURE. */
const counted = (scope: string, config: ConfigView, scopesRead: ReadonlySet<string>): boolean => config.scopes !== true || scopeToRead(scope, scopesRead) === null;

/** The Assignee group's segments, in order: Mine, then Anyone, Unassigned and each other person by name; only the pressed one has its count. PURE. */
export function segmentsOf(source: SegmentSource): Segment[] {
  const { projectTickets, config, scopesRead } = source;
  return chipsOf(source).map(({ scope, text, pressed }) => ({
    scope, pressed, text: scope === YOU ? MINE : text,
    count: pressed && counted(scope, config, scopesRead) ? projectTickets.filter((ticket) => inScope(ticket, scope, config.viewer ?? null)).length : undefined,
  }));
}

/** What the tickets in the scope are called: "assigned to you", "unassigned", "assigned to <name>", or what the instance calls them all ("open"). An instance that names no assignees words it as it always has. PURE. */
export function scopeWords(source: SegmentSource): string {
  const { config, scope } = source;
  return config.viewer === undefined ? (config.pick ?? "assigned to you") : scopeWord(scope, chipsOf(source), config.pickOpen ?? "open");
}

/** The header's count: how many tickets the project holds in the scope, and what they are. PURE. */
export const countText = (tickets: number, source: SegmentSource): string => `${tickets} ${scopeWords(source)}`;

/** The words under the board's empty title, for the signed-in person's own tickets. */
export const NOTHING_ASSIGNED_TEXT = "Describe what you need and the ticket writer will file it. Or look at tickets assigned to anyone, or to no one.";

/** What the instance says when it lists no ticket at all and has not said why, which `ui.html` says the same. */
export const NO_TICKETS_TEXT = "No open tickets to list.";

/** The empty panel: its title and sentence, and whether it offers the board's buttons (New ticket, and Show anyone's tickets). `text` is null while the instance's sentence is being read. */
export type EmptyPanel = Readonly<{ title: string; text: string | null; offersActions: boolean }>;

/**
 * What the page says when the chosen scope holds no ticket. The board draws it for the signed-in person's own tickets, with its sentence and buttons. An instance that lists no ticket at
 * all says why in its own words (`instanceText`, from `/api/pick`), and another scope that holds none says whose it asked for and where the others are (`scopeEmptyText`); neither has
 * buttons. The title is "Nothing is" and what the tickets are called. PURE.
 */
export function emptyPanelOf(source: SegmentSource, instanceText: string | null): EmptyPanel {
  const title = `Nothing is ${scopeWords(source)}`;
  const viewer = source.config.viewer ?? null;
  if (source.all.length === 0) return { title, text: instanceText, offersActions: false };
  if (source.scope === YOU && viewer !== null) return { title, text: NOTHING_ASSIGNED_TEXT, offersActions: true };
  return { title, text: scopeEmptyText(source.scope, viewer) ?? NO_TICKETS_TEXT, offersActions: false };
}

/** An item of a filter menu: what it reads, how many tickets have it (none for "All"), and whether it is chosen. */
export type MenuItem = Readonly<{ id: string; text: string; count?: number; chosen: boolean }>;

/** A filter's dashed button and its menu: `label` is the filter's name, `name` what its button reads (the label, then what is chosen). `multiple` menus choose several items at once; the others, one. */
export type Menu = Readonly<{ id: string; label: string; name: string; multiple: boolean; items: readonly MenuItem[] }>;

/** The id of a menu's "All" item, which clears the filter. */
export const ALL_ITEM = "all";

const buttonName = (name: string, chosen: readonly string[]): string => (chosen.length === 0 ? name : `${name}: ${chosen.join(", ")}`);

/** The Priority menu: All priorities, then each priority a ticket a worker can be given has, most urgent first, with how many; a chosen one with none reads 0. PURE. */
export function priorityMenu(projectTickets: readonly TicketView[], chosen: ReadonlySet<number>): Menu {
  const items = priorityCounts(projectTickets, chosen).map(([priority, count]): MenuItem => ({ id: String(priority), text: PRIORITY_NAMES[priority], count, chosen: chosen.has(priority) }));
  const names = items.filter((item) => item.chosen).map((item) => item.text);
  return { id: "priority", label: "Priority", name: buttonName("Priority", names), multiple: true, items: [{ id: ALL_ITEM, text: "All priorities", chosen: chosen.size === 0 }, ...items] };
}

const PLAN_CHOICES: readonly (readonly [PlanChoice, string])[] = [["with", "With a plan"], ["without", "Without a plan"]];

/** The Plan menu: All, With a plan and Without a plan, with how many tickets a worker can be given have a plan of their own. Null on a machine that names no plan pattern. PURE. */
export function planMenu(projectTickets: readonly TicketView[], pattern: RegExp | null, chosen: PlanChoice | null): Menu | null {
  if (pattern === null) return null;
  const counts = planCounts(projectTickets, pattern);
  const items = PLAN_CHOICES.map(([id, text]): MenuItem => ({ id, text, count: counts[id], chosen: chosen === id }));
  const names = items.filter((item) => item.chosen).map((item) => item.text);
  return { id: "plan", label: "Plan", name: buttonName("Plan", names), multiple: false, items: [{ id: ALL_ITEM, text: "All", chosen: chosen === null }, ...items] };
}

/** The id of a label menu. */
export const labelMenuId = (row: LabelRow): string => `labels:${JSON.stringify(row.group)}`;

/** One menu for each label group among the project's tickets except Goal, named after its group (the labels in no group are "Labels"). A chosen label that only the wider list has is kept, at 0. PURE. */
export function labelMenus(projectTickets: readonly TicketView[], universe: readonly TicketView[], chosen: ReadonlySet<string>): Menu[] {
  return labelRows(projectTickets, labelChoicesOf(chosen), universe)
    .filter((row) => row.group !== GOAL_GROUP)
    .map((row): Menu => {
      const items = row.chips.map((chip): MenuItem => ({ id: chip.choice, text: chip.text, count: chip.count, chosen: chip.pressed }));
      const names = items.filter((item) => item.chosen).map((item) => item.text);
      return { id: labelMenuId(row), label: row.name, name: buttonName(row.name, names), multiple: true, items: [{ id: ALL_ITEM, text: "All", chosen: row.all }, ...items] };
    });
}

/** The group of the label row a menu was made from, to clear that row: `undefined` for a menu that is not a label menu. PURE. */
export function groupOfMenu(id: string): string | null | undefined {
  if (!id.startsWith("labels:")) return undefined;
  const group: unknown = JSON.parse(id.slice("labels:".length));
  return typeof group === "string" ? group : null;
}

/** The queue options of one batch: the model and effort it runs on, and whether it is planned first. */
export type BatchOptions = Readonly<{ model: string; effort: string; plan: boolean }>;

/** What the queue options come to for the selected tickets. */
export type QueueOptions = Readonly<{
  /** Plan first is offered: a selected ticket has no plan of its own, and this machine plans. */
  planOffered: boolean;
  /** What the batch runs on and whether it is planned first, as Queue sends it. */
  batch: BatchOptions;
  /** The batch differs from the default: the Custom pill shows. */
  custom: boolean;
  /** The Custom pill's words after "Custom · ". */
  customLabel: string;
}>;

/** The model and effort the person chose for this batch, which are only the parts that differ from the default (`batchOverride`). */
export type BatchOverride = Readonly<{ model?: string; effort?: string }>;

/** What the person chose for the next batch: the parts of the model and effort that differ from the default, and whether Plan first is ticked. */
export type BatchChoice = Readonly<{ override: BatchOverride; planFirst: boolean }>;

/**
 * The queue options for `selected` tickets. Plan first is offered while a selected ticket has no plan of its own and the machine plans (`unplannedCount`), and the batch is planned when
 * it is offered and ticked. The Custom pill shows when the model or effort is not the default, or Plan first is offered and unticked. PURE.
 */
export function queueOptionsOf(config: ConfigView, selected: readonly TicketView[], { override, planFirst }: BatchChoice): QueueOptions {
  const pattern = planPatternOf(config);
  const planOffered = config.planner === true && pattern !== null && unplannedCount(selected, pattern) > 0;
  const { model, effort } = batchChoice(config.choice, override);
  const custom = !isDefaultBatch(override) || (planOffered && !planFirst);
  const planWords = planOffered ? (planFirst ? "Plan first · " : "No plan · ") : "";
  return { planOffered, batch: { model, effort, plan: planOffered && planFirst }, custom, customLabel: `${planWords}${model}/${effort}` };
}
