// module: what the sidebar shows, worked out from what the shell has read -- the connection pill, the counts, the projects and the goals -- as pure functions
//
// THE RULES ARE TODAY'S (`ui.html`): which tickets show is the default Assignee scope (`assignee-filter.ts`), the projects are `projectCounts` over them, the chosen project is
// `chosenProject`, and a goal is a label of the `Goal` group. They are used here, never restated.
import { defaultScope, inScope } from "../../../src/ticket-mode/assignee-filter.ts";
import type { PollState, PollView } from "../api/use-poll.ts";
import type { ConfigView, QueueView, TicketView } from "../api/types.ts";

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

/**
 * The tickets the list starts on: the default Assignee scope, as `ui.html`'s `inView` applies it. An instance that names no viewer (an older one) lists as it did, so every
 * ticket shows; so does a page whose config could not be read. PURE.
 */
export function ticketsInScope(tickets: readonly TicketView[], config: ConfigView | null): TicketView[] {
  if (config === null || config.viewer === undefined) return [...tickets];
  const scope = defaultScope(config.pickDefault ?? "you", config.viewer);
  return tickets.filter((ticket) => inScope(ticket, scope, config.viewer));
}

/**
 * The Tickets read as the shell shows it: only the tickets in the default scope, which needs the config; so until the config has answered the tickets are still `loading`, and a
 * config that cannot be read is the page's failure (`ui.html` reports it the same way), with nothing shown until it can. A read that came back with tickets none of which are in scope
 * is `empty` ("Nothing is assigned to you"). A tickets failure keeps the last good tickets. PURE.
 */
export function ticketsView(tickets: PollView<TicketView[]>, config: PollView<ConfigView>): PollView<TicketView[]> {
  if (config.data === null && (config.state === "error" || config.state === "unreachable")) return { state: config.state, data: null, refusal: config.refusal };
  if (tickets.state === "loading" || (config.state === "loading" && tickets.data !== null)) return { state: "loading", data: null, refusal: null };
  const data = tickets.data === null ? null : ticketsInScope(tickets.data, config.data);
  const state = tickets.state === "ready" || tickets.state === "empty" ? (data?.length === 0 ? "empty" : "ready") : tickets.state;
  return { state, data, refusal: tickets.refusal };
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
