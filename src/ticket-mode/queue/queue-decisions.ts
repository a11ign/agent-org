// @ts-check
// module: the round the board starts when a finished run's ticket gains Decisions, and the mark it leaves while none has started (A11-305) -- PURE
//
// A DECISION A PERSON ADDS WHILE A RUN'S PULL REQUESTS ARE OPEN IS WORK FOR THEM, WHETHER OR NOT ANYONE PRESSES RESPOND. The pool reads the ticket's text for every finished run with an open pull request (`followTicketTexts`); when its Decisions gain lines the
// run was not briefed with, it queues a review round that resumes the worker, and the round's brief opens with them. The round counts toward no cap: a person wrote the change, and the cap is for review findings. A run Respond could not act on, one whose workspace
// is open, and one that ended on draft pull requests (which a person approves, and whose round then opens with the same lines) is not given a round; it is marked, so the first-merge-flow card does not call a pull request that is about to change a pull request for a person to merge.
import { openPulls } from "../board-view/view-types-and-filters.ts";
import { isParked } from "../board-view/pull-status-and-notes.ts";
import { find, replace, reviewRound, type Entry, type Queue } from "./queue-entries-and-outcomes.ts";
import { respondRefusal } from "./queue-respond-refusal.ts";
import { logEvent, shortReason } from "./run-log.ts";

/** Why the board starts no round for `entry` on a change of the Decisions, or null when it may: Respond could not act on it, its workspace is open, or it waits for a person to approve its drafts. PURE. */
function roundRefusal(entry: Entry | undefined, key: string): string | null {
  const refusal = respondRefusal(key, entry, []);
  if (refusal !== null || entry === undefined) return refusal ?? `${key} is not on the board`;
  if (isParked(entry)) return `${key}'s workspace is open`;
  return entry.outcome?.kind === "draft-pr" ? `${key}'s pull requests are drafts a person approves` : null;
}

/** Whether two lists hold the same lines. PURE. */
const sameLines = (a: readonly string[] | undefined, b: readonly string[]): boolean => a !== undefined && a.length === b.length && a.every((line, at) => line === b[at]);

/**
 * The ticket's Decisions gained `added` lines the finished run was not briefed with: the ticket goes back on the queue, at the end, as a review round that resumes the same worker and answers them (A11-305). The round keeps the run's count of the board's own
 * rounds as it is. A run the board cannot start a round for (see {@link roundRefusal}) is marked with the lines instead, which the first-merge-flow card reads. PURE.
 */
export function decisionsRound(queue: Queue, key: string, added: readonly string[], now: number): Queue {
  const entry = find(queue, key);
  if (entry === undefined || entry.phase !== "finished") return queue;
  if (roundRefusal(entry, key) !== null) return replace(queue, key, (e) => (sameLines(e.decisionsPending?.added, added) ? e : { ...e, decisionsPending: { at: e.decisionsPending?.at ?? now, added } }));
  const round: Entry = { ...reviewRound(entry, openPulls(entry), now), decisions: true, ...(entry.rounds === undefined ? {} : { rounds: entry.rounds }) };
  const queued = { ...queue, entries: [...queue.entries.filter((e) => e.ticket.key !== key), round] };
  return logEvent(queued, key, now, { kind: "round", cause: "decisions", reason: shortReason(added[0] ?? "") });
}

/** The mark of a change of the Decisions no round has answered goes: the ticket reads as the run was briefed with again, or the run is no longer finished (A11-305). */
export function clearDecisionsPending(queue: Queue, key: string): Queue {
  return find(queue, key)?.decisionsPending === undefined ? queue : replace(queue, key, ({ decisionsPending: _cleared, ...rest }) => rest);
}
