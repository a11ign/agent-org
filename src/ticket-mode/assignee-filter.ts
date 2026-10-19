// @ts-check
// module: the Pick view's Assignee filter -- whose tickets the list shows: the chips and their counts, the scope the list starts on, and the words that say which scope the count reads
//
// ONE LIST, FILTERED HERE. The server reads the key's own open tickets, or every open ticket of a team or a project, each with its assignee, and this module picks the ones in the chosen
// scope. The counts of every chip come from that same list, so choosing a person is never a request of its own.
//
// A SCOPE IS A WORD OR A PERSON. "you", "anyone" and "unassigned" are the three words; any other scope is the id of the person it shows. Linear's
// ids are not those words, so a scope cannot be mistaken for one.
//
// THE CHIPS ARE THE PEOPLE WITH A TICKET. The signed-in person, Anyone and Unassigned are always there, when the tracker can say who the person is;
// every other person is there only while they hold an open ticket, so the row lists no one who would show nothing.
//
// SENT TO THE BROWSER AS IT IS, LIKE `label-filters.ts`: `ui-server.ts` serves it as `/assignee-filter.js` with the types stripped. So it imports
// nothing and uses no Node API. PURE throughout.

/** A person in the tracker: the id that tells two people with one name apart, and the name shown. */
export type Person = Readonly<{ id: string; name: string }>;

/** The signed-in person, as `/api/config` names them: null when the tracker could not say. */
export type Viewer = Person | null;

/** The part of a ticket this module reads: its key, and its assignee, `null` for a ticket nobody has. Absent from a source that reads none. */
export type Owned = Readonly<{ key: string; assignee?: Person | null }>;

/** The sentence that names the setting widening the list, in the words the server's empty text and the page's empty text both use. */
export const PICK_SETTING = 'Set tickets.pick in the host file to { "team": "<key>" } or { "project": "<name>" } to list every open ticket of a team or project, whoever it is assigned to.';

/** The scope of the signed-in person's own tickets. */
export const YOU = "you";
/** The scope of every ticket the list holds. */
export const ANYONE = "anyone";
/** The scope of the tickets nobody has been given. */
export const UNASSIGNED = "unassigned";

/** One chip of the Assignee row: the scope it chooses, what it reads, how many listed tickets it matches, and whether it is chosen. */
export type ScopeChip = Readonly<{ scope: string; text: string; count: number; pressed: boolean }>;

/** What the Assignee row says when the tracker cannot say whose key the board reads with: why there is no chip for the person. */
export const NO_VIEWER = "Linear could not say whose key this board reads with, so the list starts on Anyone and there is no chip for your own tickets.";

/** The scope the list starts on: the setting's default, the signed-in person's tickets when the setting says so and the person is known, else Anyone. */
export function defaultScope(pickDefault: string, viewer: Viewer): string {
  return pickDefault === "you" && viewer !== null ? YOU : ANYONE;
}

/** Whether the ticket is in the chosen scope. A scope of the signed-in person matches nothing when the person is not known. */
export function inScope(ticket: Owned, scope: string, viewer: Viewer): boolean {
  if (scope === ANYONE) return true;
  if (scope === UNASSIGNED) return !ticket.assignee;
  if (scope === YOU) return viewer !== null && ticket.assignee?.id === viewer.id;
  return ticket.assignee?.id === scope;
}

/**
 * The chips of the Assignee row, in order: the signed-in person (with "(you)", when known), Anyone, Unassigned, then each other person with an open
 * ticket, by most tickets and then by name. Counts are over every listed ticket, as the Projects counts are.
 */
export function scopeChips(tickets: readonly Owned[], scope: string, viewer: Viewer): ScopeChip[] {
  const count = (value: string) => tickets.filter((t) => inScope(t, value, viewer)).length;
  const people = new Map<string, { name: string; count: number }>();
  for (const { assignee } of tickets) {
    if (!assignee || assignee.id === viewer?.id) continue;
    people.set(assignee.id, { name: assignee.name, count: (people.get(assignee.id)?.count ?? 0) + 1 });
  }
  const chip = (value: string, text: string, n: number): ScopeChip => ({ scope: value, text, count: n, pressed: scope === value });
  const others = [...people]
    .sort(([, a], [, b]) => b.count - a.count || a.name.localeCompare(b.name))
    .map(([id, person]) => chip(id, person.name, person.count));
  return [
    ...(viewer === null ? [] : [chip(YOU, `${viewer.name} (you)`, count(YOU))]),
    chip(ANYONE, "Anyone", tickets.length),
    chip(UNASSIGNED, "Unassigned", count(UNASSIGNED)),
    ...others,
  ];
}

/**
 * What the counter says the tickets are, after "<n> of <m>": "assigned to you", "unassigned", "assigned to <name>", or, for Anyone, `open`, which is
 * "open" or the tickets.pick canary ("open in team A11") the instance names.
 */
export function scopeWord(scope: string, chips: readonly ScopeChip[], open: string): string {
  if (scope === YOU) return "assigned to you";
  if (scope === UNASSIGNED) return "unassigned";
  const person = chips.find((chip) => chip.scope === scope);
  return scope === ANYONE || person === undefined ? open : `assigned to ${person.text}`;
}

/**
 * What the Pick view says when the chosen scope holds no ticket while the tracker holds others: who was asked for, where the other tickets are, and
 * the setting that widens the list. Null for Anyone, which holds every listed ticket, so only the other filters can empty it.
 */
export function scopeEmptyText(scope: string, viewer: Viewer): string | null {
  if (scope === YOU && viewer !== null) {
    return `No open tickets are assigned to ${viewer.name}, whose Linear key this board reads with. The Assignee row shows Anyone and Unassigned, and each other person with an open ticket. ${PICK_SETTING}`;
  }
  if (scope === UNASSIGNED) return "No open ticket is unassigned. The Assignee row shows Anyone, and each person with an open ticket.";
  return scope === ANYONE ? null : "No open tickets are assigned to that person. The Assignee row shows Anyone, and the people who have one.";
}

/** Whether a ticket's row names its owner: it does whenever the list is not the signed-in person's own, so no other person's ticket looks like the person's. */
export const showsOwner = (scope: string): boolean => scope !== YOU;

/** A ticket's owner as its row shows it: the person's name, or "Unassigned". */
export const ownerName = (ticket: Owned): string => (ticket.assignee ? ticket.assignee.name : "Unassigned");
