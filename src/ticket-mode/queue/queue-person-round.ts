// @ts-check
// module: the events of a person's word that queued a round (A11-219) -- PURE
import { runStatus } from "../board-view/pull-status-and-notes.ts";
import type { Entry, Queue } from "./queue-entries-and-outcomes.ts";
import { logEvent, type RoundCause } from "./run-log.ts";

/** The ways a person's word queues a round: Respond, approving draft pull requests, and talking to the run. Each names the round it queues. */
const PERSON_ROUND = { respond: "asked", approve: "approved", talk: "talk" } as const satisfies Record<string, RoundCause>;

/**
 * The events for a person's word that queued a round for `before`, the run as it was: that a person answered it, when it read Needs you, and then the round, with `reason` the conflict it answers, if any (A11-219).
 * `queued` is the queue with the round already in it. PURE.
 */
export function loggedPersonRound(queued: Queue, before: Entry, by: keyof typeof PERSON_ROUND, now: number, reason: string | null): Queue {
  const key = before.ticket.key;
  const answered = runStatus(before) === "needs-you" ? logEvent(queued, key, now, { kind: "answered", by }) : queued;
  return logEvent(answered, key, now, { kind: "round", cause: PERSON_ROUND[by], reason });
}
