import type { ReadinessView, TicketView } from "../api/types.ts";

/** The button a low score offers. */
export const IMPROVE = "Improve with the writer";
export const IMPROVE_TITLE = "Open the New ticket dialog with this ticket and its reasons filled in: the writer adds what the ticket is missing";

/** The pill's words: "Readiness 35". PURE. */
export const readinessLabel = (view: Extract<ReadinessView, { state: "scored" }>): string => `Readiness ${view.score}`;

/** The pill's title: the score out of 100 and its reasons, or that nothing is missing. PURE. */
export function readinessTitle(view: Extract<ReadinessView, { state: "scored" }>): string {
  const reasons = view.reasons.length === 0 ? "Nothing is missing." : view.reasons.join(" ");
  return `Readiness ${view.score} of 100, scored by a model on its acceptance criteria, scope and repository. ${reasons}`;
}

/**
 * The New ticket request "Improve with the writer" opens with: the ticket, its score and its reasons, and that it is the ticket to improve, not a new one to file. The person reads it and sends
 * it, or changes it first. PURE.
 */
export function improveRequest(ticket: Pick<TicketView, "key" | "title">, view: Extract<ReadinessView, { state: "scored" }>): string {
  const reasons = view.reasons.length === 0 ? "" : ` What it is missing: ${view.reasons.join(" ")}`;
  return `Improve ${ticket.key} (${ticket.title}) in place: edit its description, and file no new ticket. Its readiness score is ${view.score} of 100.${reasons}`;
}
