// module: which tickets the Pick view shows as taken by another instance (A11-144, A11-143 Decision 10) -- PURE
//
// A ticket is TAKEN when this instance holds no run for it, in any phase of its queue, and the tracker shows it in work another instance started or
// planned: a state in `tickets.providers.tracker.takenStates`, or a state of the started type (In Progress and its kin). A taken ticket is shown with its
// state, cannot be selected, and a queue route refuses it, so two instances never start one ticket.
//
// THE RULE IS APPROXIMATE, AND THE PLAN SAYS SO: this instance cannot yet name the instance that holds a ticket (A11-149 gives it a name), so a ticket
// planned by hand, or one this instance left In Progress with no run, is taken too. `takenStates` is how a machine removes a state from the rule.

/** The tracker's type for a state work has started in: In Progress and the states like it. */
const STARTED = "started";

/**
 * The state a ticket is taken in, or null when the tracker shows it in no taken state. The caller answers first whether this instance holds a run for it,
 * which makes it not taken whatever its state. The state's name is what the page says, so a person sees which state holds the ticket.
 */
export function takenState(ticket: Readonly<{ status: string; statusType?: string }>, takenStates: readonly string[]): string | null {
  return takenStates.includes(ticket.status) || ticket.statusType === STARTED ? ticket.status : null;
}

/** The sentence a queue route refuses a taken ticket with: the ticket, its state, and why it cannot be queued here. */
export function takenRefusal(key: string, state: string): string {
  return `${key} is ${state} in the tracker and this instance has no run for it, so another instance holds it`;
}

/**
 * The states a machine takes as holding a ticket when `tickets.providers.tracker.takenStates` names none: the working state and the planned state it
 * sets, each where it sets one.
 */
export function defaultTakenStates(working: unknown, planned: unknown): readonly string[] {
  return [working, planned].flatMap((name) => (typeof name === "string" && name.trim() !== "" ? [name.trim()] : []));
}
