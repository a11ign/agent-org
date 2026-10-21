// module: which tickets the Pick view shows as taken by another instance (A11-144, A11-143 Decision 10, A11-168) -- PURE
//
// A ticket is TAKEN when the tracker shows it in work (a state in `tickets.providers.tracker.takenStates`, or a state of the started type: In Progress and its kin)
// AND its latest claim names another instance (ADR A11-168-0001: a run writes `agent-org: claimed by <claimant>` on its ticket as it starts). A taken ticket is shown with its
// state, cannot be selected, and a queue route refuses it, so two instances never start one ticket.
//
// A TICKET THIS INSTANCE RAN IS NEVER TAKEN, whatever its state: its own claim names this instance, so a ticket left In Progress after a finished or dismissed run can be queued
// again. A ticket with no claim is not taken either: one moved to In Progress by hand, or by an instance older than the claim, has nobody to name. That is the cost of the rule,
// and the README says so. A ticket this instance holds a run for is not taken either, which the caller answers first, from its queue.

/** The tracker's type for a state work has started in: In Progress and the states like it. */
const STARTED = "started";

/** Whether the tracker shows the ticket in work another instance could hold: a state `takenStates` names, or one of the started type. A claim is read for such a ticket alone. */
export const inWork = (ticket: Readonly<{ status: string; statusType?: string }>, takenStates: readonly string[]): boolean =>
  takenStates.includes(ticket.status) || ticket.statusType === STARTED;

/**
 * The state a ticket is taken in, or null when it is not taken: it is in no taken state, or its latest claim (`claimant`, undefined for a ticket with none) is not another
 * instance's. `self` is this instance's own claimant name. The caller answers first whether this instance holds a run for it, which makes it not taken whatever its state.
 * The state's name is what the page says, so a person sees which state holds the ticket.
 */
export function takenState(ticket: Readonly<{ status: string; statusType?: string }>, takenStates: readonly string[], claimant: string | undefined, self: string): string | null {
  return inWork(ticket, takenStates) && claimant !== undefined && claimant !== self ? ticket.status : null;
}

/** The sentence a queue route refuses a taken ticket with: the ticket, its state, who claimed it, and why it cannot be queued here. */
export function takenRefusal(key: string, state: string, claimant: string): string {
  return `${key} is ${state} in the tracker and ${claimant} claimed it, so another instance holds it`;
}

/**
 * The states a machine takes as holding a ticket when `tickets.providers.tracker.takenStates` names none: the working state and the planned state it
 * sets, each where it sets one.
 */
export function defaultTakenStates(working: unknown, planned: unknown): readonly string[] {
  return [working, planned].flatMap((name) => (typeof name === "string" && name.trim() !== "" ? [name.trim()] : []));
}
