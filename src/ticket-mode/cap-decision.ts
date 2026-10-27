// @ts-check
// module: what the planner's round at the round cap decided (A11-343), read from the file it wrote -- PURE apart from the read the caller makes
import { isTicketKey, type CapDecision } from "./queue/queue-cap.ts";

/** The decision in `text`, the content of `cap-decision.json`, or the words that say why it is none. PURE. */
export function parseCapDecision(text: string, file: string): CapDecision | string {
  let parsed: { decision?: unknown; reason?: unknown; ticket?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return `${file} cannot be read as JSON`;
  }
  const { decision, reason, ticket } = parsed;
  if (decision !== "round" && decision !== "waiting") return `${file} needs decision: "round" or "waiting"`;
  if (typeof reason !== "string" || reason.trim() === "") return `${file} needs a reason, in words`;
  if (decision === "round") return { decision, reason: reason.trim() };
  if (typeof ticket !== "string" || !isTicketKey(ticket.trim())) return `${file} says waiting, and needs ticket: the key of the ticket to wait on, such as "A11-341"`;
  return { decision, ticket: ticket.trim(), reason: reason.trim() };
}
