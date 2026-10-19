// @ts-check
// module: the Pick view's label filters -- one row of chips for each label group among the listed tickets, one for the labels in no group, and the filter they make
//
// A ROW FOR EACH GROUP, NAMED AFTER IT. A tracker that nests labels (Linear's label groups, whose child labels are exclusive) lets a person sort
// tickets on an axis of their own, such as a group called "Goal" whose labels name what each ticket is for. Nothing here knows any group's
// name: a row is made for whatever groups the listed tickets carry, and a list with no labels has no rows. The labels in no group share one
// row, "Labels", shown only when some ticket has one.
//
// IT WORKS AS THE PROJECTS ROW DOES. Each row has an All chip, which clears that row; its chips choose several at once, and a ticket shows when
// it has any of them; rows combine with AND, with each other and with the page's other filters. A row also offers the tickets with no label
// of it, "(no <group>)", when some have none, so the tickets still to be labelled can be found. Counts are over every listed ticket, as the
// project counts are.
//
// A CHOICE THAT NAMES NO CHIP IS IGNORED. The choices are remembered in the browser, and a label renamed or a list narrowed can leave one that
// no listed ticket carries. Applied, it would hide every ticket behind a row whose All chip still read as pressed; it filters nothing instead.
//
// SENT TO THE BROWSER AS IT IS, LIKE `board-view.ts`: `ui-server.ts` serves it as `/label-filters.js` with the types stripped. So it imports
// nothing and uses no Node API. PURE throughout.

/** A label on a ticket, and the group it belongs to, or `null` for a label in no group: see `source.ts`. */
export type ViewLabel = Readonly<{ name: string; group: string | null }>;

/** The part of a ticket these filters read. A ticket with no `labels`, as a source that reads none gives, has no label of any row. */
export type Labelled = Readonly<{ labels?: readonly ViewLabel[] }>;

/** The name of the row of labels that belong to no group. */
export const UNGROUPED = "Labels";

/** One chip of a row: a label, or `null` for "no label of this row", what it reads, how many listed tickets it matches, and whether it is chosen. */
export type LabelChip = Readonly<{ label: string | null; text: string; count: number; choice: string; pressed: boolean }>;

/** One row of chips: its group (`null` for the labels in no group), the name it is shown under, its chips, and whether All is pressed. */
export type LabelRow = Readonly<{ group: string | null; name: string; chips: readonly LabelChip[]; all: boolean }>;

/**
 * What a chosen chip is remembered as: its group and label, as JSON, so neither a group's nor a label's name can be mistaken for the other's
 * however it is spelled. `label` is `null` for the chip of the tickets with no label of the row.
 */
export const labelChoice = (group: string | null, label: string | null): string => JSON.stringify([group, label]);

/** The group a remembered choice belongs to, or `undefined` for a string that is not a choice. */
function choiceGroup(choice: string): string | null | undefined {
  try {
    const parsed: unknown = JSON.parse(choice);
    const isLabelPair = Array.isArray(parsed) && parsed.length === 2 && (parsed[0] === null || typeof parsed[0] === "string");
    return isLabelPair ? parsed[0] : undefined;
  } catch {
    return undefined;
  }
}

/** The ticket's labels of one row: those of the group, or, for `null`, those in no group. */
const labelsOf = (ticket: Labelled, group: string | null): string[] => (ticket.labels ?? []).filter((l) => l.group === group).map((l) => l.name);

/**
 * The label rows for the listed tickets and the remembered choices: a row for each group any ticket has a label of, by name, then the row of
 * labels in no group when there are any. A row's chips are its labels, most tickets first and then by name, then "(no <name>)" when some
 * tickets have none of them.
 */
export function labelRows(tickets: readonly Labelled[], chosen: ReadonlySet<string>): LabelRow[] {
  const groups = new Map<string | null, Map<string, number>>();
  for (const t of tickets) {
    // A ticket counts once for a label, however many times a tracker lists it.
    const seen = new Set<string>();
    for (const { name, group } of t.labels ?? []) {
      const counts = groups.get(group) ?? new Map<string, number>();
      groups.set(group, counts);
      if (seen.has(labelChoice(group, name))) continue;
      seen.add(labelChoice(group, name));
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const order = [...groups.keys()].sort((a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)));
  return order.map((group) => {
    const counts = groups.get(group) ?? new Map<string, number>();
    const name = group ?? UNGROUPED;
    const chip = (label: string | null, text: string, count: number): LabelChip => {
      const choice = labelChoice(group, label);
      return { label, text, count, choice, pressed: chosen.has(choice) };
    };
    const labels = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label, count]) => chip(label, label, count));
    const none = tickets.filter((t) => labelsOf(t, group).length === 0).length;
    const chips = none > 0 ? [...labels, chip(null, group === null ? "(no label)" : `(no ${name})`, none)] : labels;
    return { group, name, chips, all: !chips.some((c) => c.pressed) };
  });
}

/**
 * Whether a ticket meets every row with a chosen chip: it has one of that row's chosen labels, or, where "(no <name>)" is chosen, none of the
 * row's labels. `rows` are the rows `labelRows` made for the listed tickets, so a remembered choice that names no chip filters nothing.
 */
export function meetsLabels(ticket: Labelled, rows: readonly LabelRow[]): boolean {
  return rows.every((row) => {
    const pressed = row.chips.filter((c) => c.pressed);
    if (pressed.length === 0) return true;
    const has = labelsOf(ticket, row.group);
    return pressed.some((c) => (c.label === null ? has.length === 0 : has.includes(c.label)));
  });
}

/** The tickets that meet the label filters chosen, with the rows made from `listed`, every ticket the Pick view lists. */
export function withLabels<T extends Labelled>(tickets: readonly T[], chosen: ReadonlySet<string>, listed: readonly Labelled[] = tickets): T[] {
  const rows = labelRows(listed, chosen);
  return tickets.filter((t) => meetsLabels(t, rows));
}

/** The choices with every one of `group`'s row dropped: that row's All chip. The other rows' choices stay. */
export const clearedRow = (chosen: ReadonlySet<string>, group: string | null): Set<string> =>
  new Set([...chosen].filter((choice) => choiceGroup(choice) !== group));

/** The labels a ticket's row shows as tags: those in a group, by group and then by name. A label in no group is filtered by, but not tagged. */
export const groupTags = (ticket: Labelled): ViewLabel[] =>
  (ticket.labels ?? []).filter((l) => l.group !== null).sort((a, b) => (a.group ?? "").localeCompare(b.group ?? "") || a.name.localeCompare(b.name));
