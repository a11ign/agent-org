// @ts-check
// module: what a run records of a person's answer written into its ticket (A11-250) -- PURE
//
// THE RUN'S OWN COPY OF THE TICKET MOVES ON WITH THE WRITE. The board wrote the answer into the ticket's description and sends the run that same text, so the run is briefed against the description that holds it:
// the reviewer's brief reads `ticket.description` (`briefOf`), and a planning run that waited on a question stamps its plan with `briefedAgainst`. Left old, a review after the answer would be briefed without
// the decision, and a plan made with it would be read as stale and planned a second time (A11-167).
import type { TicketRead } from "../ticket-read.ts";
import type { AutoAnswer } from "./auto-answer-record.ts";
import { replace, type Queue } from "./queue-entries-and-outcomes.ts";
import { logEvent, shortReason } from "./run-log.ts";

/** Record that ticket `key`'s description is now `read`, in the run's copy of the ticket. A key not on the queue changes nothing. */
export function recordAnswer(queue: Queue, key: string, read: TicketRead): Queue {
  return replace(queue, key, (entry) => ({ ...entry, ticket: { ...entry.ticket, description: read.description } }));
}

/**
 * Record `read` as the text the run is briefed against, for a run that was briefed with the text the board added its entry to. A run briefed with an older text is not moved, so an edit a person made meanwhile is
 * still seen as a change to the run, along with the entry.
 */
export function moveBriefing(queue: Queue, key: string, read: TicketRead): Queue {
  return replace(queue, key, (entry) => ({ ...entry, briefedAgainst: read }));
}

/** Log, once the run has been told, that a person answered it through the answer route. */
export const logAnswered = (queue: Queue, key: string, now: number): Queue => logEvent(queue, key, now, { kind: "answered", by: "answer" });

/** Record that the answerer answered ticket `key`'s question (A11-438), and log it, which counts it in the day's tally apart from a person's answers. A key not on the queue changes nothing. PURE. */
export function recordAutoAnswer(queue: Queue, key: string, answered: AutoAnswer): Queue {
  if (!queue.entries.some((entry) => entry.ticket.key === key)) return queue;
  // The agent was idle when it was told: until it is seen working on the answer, an idle pane with no new outcome is not a run that stopped (`stoppedWithNoOutcome`).
  const recorded = replace(queue, key, (entry) => ({ ...entry, autoAnswer: answered, seenWorking: false }));
  return logEvent(recorded, key, answered.at, { kind: "auto-answered", answer: shortReason(answered.answer) ?? answered.answer, confidence: answered.confidence, sources: answered.sources.map(({ label }) => label) });
}

/**
 * Record that a person answered ticket `key`'s run at `now` while it held an automatic answer that is still open (A11-438): `overruled` when their answer replaces it, `closed` when they answered a later question
 * instead, after which it can no longer be overruled. A run with no open automatic answer is not changed. PURE.
 */
export function recordPersonAfterAuto(queue: Queue, key: string, now: number, how: "overruled" | "closed"): Queue {
  return replace(queue, key, (entry) => {
    const answered = entry.autoAnswer;
    if (answered === undefined || answered.overruledAt !== undefined || answered.closedAt !== undefined) return entry;
    return { ...entry, autoAnswer: { ...answered, ...(how === "overruled" ? { overruledAt: now } : { closedAt: now }) } };
  });
}
