// module: what the "Search tickets" palette shows (A11-387) -- the tracker's matches with the queue's runs merged in, ranked, highlighted and labelled. PURE.
//
// THE TRACKER FINDS OPEN TICKETS ONLY (`/api/search`), so the palette also matches each run in the queue by its key and title: a run whose ticket the tracker no longer lists (Ready to merge,
// Completed) is found too. A run's list entry carries only its ticket's key, title and url (`ListTicket` in `queue-view.ts`), so a run-only match takes its project, goal and owner from the
// tickets the shell has read when it can, and otherwise draws its key, title and run status alone.
import { projectOf, RUN_STATUSES } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import { shownStatus } from "../../../src/ticket-mode/board-view/pull-status-and-notes.ts";
import { ownerName } from "../../../src/ticket-mode/assignee-filter.ts";
import type { QueueListEntry, QueueView, TicketView } from "../api/types.ts";
import { STATUS_TONE } from "../runs/icons.tsx";
import { runsHref } from "../shell/routes.ts";

/** What a row needs of an open ticket, and all a remembered one keeps: enough to draw it again and to open it on the Tickets page. */
export type OpenTicket = Pick<TicketView, "key" | "title" | "project" | "assignee" | "labels" | "status" | "statusType" | "statusOrder" | "priority">;

/** One row of the palette: a ticket by its key and title, the open ticket when one is known (it can be opened on Tickets), and its run in the queue when it has one. */
export type Match = Readonly<{ key: string; title: string; ticket: OpenTicket | null; run: QueueListEntry | null }>;

/** Where a run's own page is. */
export const runHref = (key: string): string => `${runsHref}/${encodeURIComponent(key)}`;

const holds = (text: string, query: string): boolean => text.toLowerCase().includes(query);

/** The goals a ticket carries, by the Goal label group, as the Tickets rows show them. */
export const goalsOf = (ticket: OpenTicket): string[] => (ticket.labels ?? []).filter(({ group }) => group === "Goal").map(({ name }) => name);

/** The line under a row's title: "project · goal · owner", with no goal part for a ticket that has none; null when the open ticket is not known. */
export function metaOf(ticket: OpenTicket | null): string | null {
  if (ticket === null) return null;
  const goals = goalsOf(ticket);
  return [projectOf(ticket), ...(goals.length === 0 ? [] : [goals.join(", ")]), ownerName(ticket)].join(" · ");
}

/** How well a row matches, best first: by its key, by its title, by its project, goal or owner, or only for a reason the tracker knows (its description, say). */
const RANK = { key: 3, title: 2, meta: 1, tracker: 0 } as const;

function rankOf(match: Match, query: string): number {
  if (holds(match.key, query)) return RANK.key;
  if (holds(match.title, query)) return RANK.title;
  return holds(metaOf(match.ticket) ?? "", query) ? RANK.meta : RANK.tracker;
}

/** The first run the queue holds for each ticket, by key. */
function runsByKey(queue: QueueView | null): ReadonlyMap<string, QueueListEntry> {
  const runs = new Map<string, QueueListEntry>();
  for (const entry of queue?.entries ?? []) if (!runs.has(entry.ticket.key)) runs.set(entry.ticket.key, entry);
  return runs;
}

/**
 * The rows for `text`: the tracker's matches, each with its run when it has one, then the runs the tracker did not return whose key or title holds `text`, each once. They are ranked by
 * key, then title, then project, goal or owner; within a rank the tracker's order is kept, followed by the run-only matches in queue order. `known` are the tickets the shell has read,
 * which a run-only match takes its fields from.
 */
export function matchesOf({ found, queue, known, text }: Readonly<{ found: readonly TicketView[]; queue: QueueView | null; known: readonly TicketView[]; text: string }>): Match[] {
  const query = text.trim().toLowerCase();
  const runs = runsByKey(queue);
  const tracker = found.map((ticket): Match => ({ key: ticket.key, title: ticket.title, ticket, run: runs.get(ticket.key) ?? null }));
  const listed = new Set(found.map(({ key }) => key));
  const runOnly = [...runs.values()]
    .filter(({ ticket }) => !listed.has(ticket.key) && (holds(ticket.key, query) || holds(ticket.title, query)))
    .map((run): Match => ({ key: run.ticket.key, title: run.ticket.title, ticket: known.find(({ key }) => key === run.ticket.key) ?? null, run }));
  return [...tracker, ...runOnly].map((match) => ({ match, rank: rankOf(match, query) })).sort((a, b) => b.rank - a.rank).map(({ match }) => match);
}

/** A remembered row, drawn again with its run as the queue holds it now. */
export const withRun = (match: Match, queue: QueueView | null): Match => ({ ...match, run: runsByKey(queue).get(match.key) ?? null });

/** One stretch of a text, and whether it is the part the query matched. */
export type Part = Readonly<{ text: string; hit: boolean }>;

/** `text` cut where `query` occurs, ignoring case, so the matched stretches can be highlighted. */
export function partsOf(text: string, query: string): Part[] {
  const wanted = query.trim().toLowerCase();
  if (wanted === "") return [{ text, hit: false }];
  const parts: Part[] = [];
  const lower = text.toLowerCase();
  let from = 0;
  for (let at = lower.indexOf(wanted); at !== -1; at = lower.indexOf(wanted, from)) {
    if (at > from) parts.push({ text: text.slice(from, at), hit: false });
    parts.push({ text: text.slice(at, at + wanted.length), hit: true });
    from = at + wanted.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), hit: false });
  return parts;
}

/** The colour of a tracker status by its type, as the boards draw them: started in amber, completed in green, the rest muted. */
const TRACKER_TONE: Readonly<Record<string, string>> = { started: "tone-warn", completed: "tone-success", unstarted: "tone-quiet" };

/** A row's status and its colour class: its run's status as the Runs page shows it, else the tracker's status. */
export function statusOf(match: Match, queue: QueueView | null): Readonly<{ label: string; tone: string }> {
  if (match.run !== null) {
    const status = shownStatus(match.run, queue?.publish, queue?.entries ?? []);
    return { label: RUN_STATUSES.find((known) => known.status === status)?.label ?? status, tone: STATUS_TONE[status] };
  }
  return { label: match.ticket?.status ?? "", tone: TRACKER_TONE[match.ticket?.statusType ?? ""] ?? "tone-muted" };
}

/** What the line above the list says of the results. */
export function countText(state: Readonly<{ query: string; searching: boolean; refused: boolean; count: number; minChars: number }>): string {
  const { query, searching, refused, count, minChars } = state;
  if (query === "") return "Press a key to search";
  if (query.length < minChars) return "Keep typing to search";
  if (searching) return "Searching…";
  if (refused) return "";
  if (count === 0) return "No matches";
  return `${count} ${count === 1 ? "ticket" : "tickets"}`;
}

/** What the palette says when nothing matches, and in place of Recently opened before anything was opened from it. */
export const SEARCH_HINT = "Search covers every project, goal and person. Try the ticket key, or a word from its title.";

/** The title of the empty result. */
export const noMatchText = (query: string): string => `No tickets match "${query.trim()}"`;
