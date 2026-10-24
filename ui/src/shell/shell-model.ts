// module: what the sidebar shows, worked out from what the shell has read -- the connection pill, the counts, the projects and the goals -- as pure functions
//
// THE RULES ARE TODAY'S (`ui.html`): which tickets show is the default Assignee scope (`assignee-filter.ts`), the projects are `projectCounts` over them, the chosen project is
// `chosenProject`, and a goal is a label of the `Goal` group. They are used here, never restated.
import { defaultScope, inScope } from "../../../src/ticket-mode/assignee-filter.ts";
import type { PollState, PollView } from "../api/use-poll.ts";
import type { ConfigView, QueueView, Ticket, TicketView } from "../api/types.ts";

export type Pill = Readonly<{ tone: "connected" | "unreachable"; label: string }>;

/**
 * The connection pill for the queue poll's state. Unreachable is only for an SSH connection its proxy cannot reach (the poll's `unreachable`); every other state is
 * Connected, `loading` and `error` included, as the boards draw them (BRIEF: "Unreachable applies only to SSH remote connections"). PURE.
 */
export function pillOf(state: PollState): Pill {
  return state === "unreachable" ? { tone: "unreachable", label: "Unreachable · retrying" } : { tone: "connected", label: "Connected" };
}

/** How many runs are running now: the Runs badge. A run is running while its `phase` is `running`. PURE. */
export const runningCount = (queue: QueueView): number => queue.entries.filter((entry) => entry.phase === "running").length;

/** The Assignee scope the list shows: the one chosen, else the setting's default (`defaultScope`). An instance that names no viewer lists as it did, whatever the scope. PURE. */
export const scopeOf = (config: ConfigView | null, chosen: string | null): string => chosen ?? defaultScope(config?.pickDefault ?? "you", config?.viewer ?? null);

/**
 * The tickets in the Assignee scope, as `ui.html`'s `inView` applies it. An instance that names no viewer (an older one) lists as it did, so every ticket shows; so does a page whose
 * config could not be read. `scope` is the one chosen, else the setting's default. PURE.
 */
export function ticketsInScope(tickets: readonly TicketView[], config: ConfigView | null, scope: string = scopeOf(config, null)): TicketView[] {
  if (config === null || config.viewer === undefined) return [...tickets];
  return tickets.filter((ticket) => inScope(ticket, scope, config.viewer));
}

/** The tickets the first read gave and the pages of the scopes read since, once each by key. PURE. */
export function mergedTickets(first: readonly TicketView[], extra: readonly TicketView[]): TicketView[] {
  const seen = new Set(first.map(({ key }) => key));
  const added = extra.filter(({ key }) => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...first, ...added];
}

/** What the Tickets read has beyond its first answer: the scope chosen, the tickets of the scopes read on demand, the scope being read now, and why the last such read failed. */
export type ScopedReads = Readonly<{ scope: string | null; extra: readonly TicketView[]; reading: string | null; refusal: string | null }>;

/**
 * The Tickets read as the shell shows it: only the tickets in the chosen Assignee scope, which needs the config; so until the config has answered the tickets are still `loading`, and a
 * config that cannot be read is the page's failure (`ui.html` reports it the same way), with nothing shown until it can. A read that came back with tickets none of which are in scope
 * is `empty` ("Nothing is assigned to you"), except while that scope is still being read, which is `loading`. A tickets failure keeps the last good tickets, and so does a scope that could
 * not be read (`refusal`), which is an `error` in the server's own words. PURE.
 */
export function ticketsView(tickets: PollView<TicketView[]>, config: PollView<ConfigView>, { scope = null, extra = [], reading = null, refusal = null }: Partial<ScopedReads> = {}): PollView<TicketView[]> {
  if (config.data === null && (config.state === "error" || config.state === "unreachable")) return { state: config.state, data: null, refusal: config.refusal };
  if (tickets.state === "loading" || (config.state === "loading" && tickets.data !== null)) return { state: "loading", data: null, refusal: null };
  const shown = scopeOf(config.data, scope);
  const data = tickets.data === null ? null : ticketsInScope(mergedTickets(tickets.data, extra), config.data, shown);
  if (data?.length === 0 && reading === shown) return { state: "loading", data: null, refusal: null };
  if (refusal !== null && (tickets.state === "ready" || tickets.state === "empty")) return { state: "error", data, refusal };
  const state = tickets.state === "ready" || tickets.state === "empty" ? (data?.length === 0 ? "empty" : "ready") : tickets.state;
  return { state, data, refusal: tickets.refusal };
}

/**
 * The tickets the tree may nest under: a ticket outside the scope that a ticket in it hangs from is shown as context, so the child keeps its place, and so is each parent the instance
 * names (`/api/parents`). On an instance that names no viewer there is no scope to be outside of. PURE.
 */
export function contextParentsOf(all: readonly TicketView[], parents: readonly Ticket[], config: ConfigView | null, scope: string): TicketView[] {
  const outside = config === null || config.viewer === undefined ? [] : all.filter((ticket) => !inScope(ticket, scope, config.viewer));
  return [...outside, ...parents];
}

/** What a goal entry of the sidebar stands for. The ids are opaque: a label is never mistaken for "All goals" or "(no Goal)". */
export type GoalEntry = Readonly<{ id: string; label: string; count: number }>;

export const ALL_GOALS_ID = "all";
export const NO_GOAL_ID = "none";
export const ALL_GOALS_LABEL = "All goals";
export const NO_GOAL_LABEL = "(no Goal)";
const namedGoalId = (name: string): string => `goal:${name}`;

const goalsOfTicket = (ticket: TicketView): string[] => [...new Set((ticket.labels ?? []).filter(({ group }) => group === "Goal").map(({ name }) => name))];

/**
 * The sidebar's Goals: "All goals" with the total, then each `Goal`-group label the tickets carry by how many have it (most first, then by name), and "(no Goal)" last when a
 * ticket has none. A ticket with two goals is counted under each. With no tickets the list is "All goals" at 0. PURE.
 */
export function goalEntries(tickets: readonly TicketView[]): GoalEntry[] {
  const counts = new Map<string, number>();
  let without = 0;
  for (const ticket of tickets) {
    const goals = goalsOfTicket(ticket);
    if (goals.length === 0) without += 1;
    for (const name of goals) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const named = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ id: namedGoalId(name), label: name, count }));
  return [{ id: ALL_GOALS_ID, label: ALL_GOALS_LABEL, count: tickets.length }, ...named, ...(without === 0 ? [] : [{ id: NO_GOAL_ID, label: NO_GOAL_LABEL, count: without }])];
}

/** The goal shown: the one chosen while the entries hold it, else All goals. PURE. */
export const goalShown = (entries: readonly GoalEntry[], chosen: string): string => (entries.some(({ id }) => id === chosen) ? chosen : ALL_GOALS_ID);

/** The tickets that have the goal an entry stands for, so the Tickets list (A11-196) filters by what the sidebar shows. PURE. */
export function ticketsOfGoal(tickets: readonly TicketView[], goal: string): TicketView[] {
  if (goal === ALL_GOALS_ID) return [...tickets];
  if (goal === NO_GOAL_ID) return tickets.filter((ticket) => goalsOfTicket(ticket).length === 0);
  return tickets.filter((ticket) => goalsOfTicket(ticket).some((name) => namedGoalId(name) === goal));
}
