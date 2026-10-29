// @ts-check
// module: the round cap's route to the planner, and a run's wait on another ticket (A11-343) -- PURE
//
// THE ROUND CAP IS NOT ON THE ESCALATION LIST. When a run's pull requests used up the board's own rounds (`MAX_FEEDBACK_ROUNDS`) the board used to hand the run to a person (`handedBack`, Needs you), whose Respond only asked the worker the same question
// again (A11-291: a pull request whose only red check was a failure its ticket's Decisions already called another ticket's). Now the run goes to the PLANNER, as a stand-off does (A11-290): a review round that starts as the planner, which reads the rounds, the
// ticket's Decisions and the open blockers and decides one of three things. It records a Decision and the board starts ONE more round of the worker with it (`round`); it marks the run as waiting on a named ticket (`waiting`), which reads "Waiting on A11-xxx"
// and starts a round again when that ticket's pull request merges; or it escalates, with a `needs-human` outcome that names an item of the escalation list, which is the only way to a person. The worker's round that the planner starts counts toward no cap,
// as a stand-off's rounds do: it answers the planner's decision, and the planner is asked again only when the feedback comes again.
import { openPulls } from "../board-view/view-types-and-filters.ts";
import { workStatus } from "../board-view/pull-status-and-notes.ts";
import { find, replace, reviewRound, type Entry, type Queue } from "./queue-entries-and-outcomes.ts";
import { logEvent, shortReason } from "./run-log.ts";
import type { ConflictOn } from "./queue-conflict-rounds.ts";

/** What the planner decided about a run at the round cap (A11-343): `round` records a Decision (`reason`, in words) and starts one more round with it; `waiting` marks the run as waiting on the ticket `ticket`. */
export type CapDecision = Readonly<{ decision: "round"; reason: string } | { decision: "waiting"; ticket: string; reason: string }>;

/** Set on the review round that starts as the planner for a run at its cap (A11-343): the feedback that reached the cap, which the planner decides on and the worker's round answers after it. */
export type CapRound = Readonly<{ latest: string }>;

/** Set on a finished run that waits on another ticket (A11-343): the ticket, why, and when the board marked it. The run reads Waiting, and a round starts when the ticket's pull request merges. */
export type TicketWait = Readonly<{ key: string; reason: string; since: number }>;

/**
 * How the board answers a trigger for a round (A11-343). `planner`: this machine has a planner, so a run that used up its rounds goes to the planner, which is not a person, and not to Needs you. `uncounted`: the feedback answers nothing but a check that the
 * ticket's Decisions call unrelated or that the board already reran and found red again, so the round is not one of the board's own and the cap does not apply to it. `conflictOnly` (A11-374): the feedback answers nothing but these pull requests' conflicts with their base, which
 * is no review, so the round counts toward no cap unless the base has not moved since the last one (`conflictRoundLeft`).
 */
export type RoundOptions = Readonly<{ planner?: boolean; uncounted?: boolean; conflictOnly?: ConflictOn }>;

/** The most times the board asks the planner about one run at its round cap and lets it start one more round (A11-343): past it the planner may only mark the run as waiting on a ticket, or escalate. */
export const MAX_CAP_PLANS = 3;

/** The ticket keys the board reads: a team prefix, a dash and a number. */
const TICKET_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

/** Whether `text` names a ticket as the tracker keys one. PURE. */
export const isTicketKey = (text: string): boolean => TICKET_KEY.test(text);

/** Whether `entry` is the planner's round at the round cap: a review round that starts as the planner. PURE. */
export const isCapPlanner = (entry: Entry): boolean => entry.capRound !== undefined && entry.review !== undefined;

/** `queue` with `round` at its end, in place of the run's entry: a round goes to the back of the queue. PURE. */
const queuedLast = (queue: Queue, round: Entry): Queue => ({ ...queue, entries: [...queue.entries.filter((each) => each.ticket.key !== round.ticket.key), round] });

/**
 * A finished run at its cap is routed to the planner (A11-343): a review round of the same pull requests that carries the feedback that reached the cap, counts toward no cap (`rounds` is carried as it is), and starts as the planner and not as the
 * worker resumed. The run's log says so, and no Needs-you note is written. PURE.
 */
export function capPlannerRound(queue: Queue, entry: Entry, feedback: string, now: number): Queue {
  const round: Entry = { ...reviewRound(entry, openPulls(entry), now), feedback, rounds: entry.rounds ?? 0, capRound: { latest: feedback }, capPlans: (entry.capPlans ?? 0) + 1 };
  return logEvent(queuedLast(queue, round), entry.ticket.key, now, { kind: "round", cause: "cap-planner", reason: shortReason(feedback) });
}

/** The feedback of the worker's round that follows the planner's decision: what reached the cap, then what the planner decided. PURE. */
const afterDecision = (latest: string, reason: string): string =>
  `${latest}\n\nThe board's own rounds for this run had run out, so the planner decided before this round. It recorded this Decision:\n\n${reason.trim().split("\n").map((line) => `> ${line}`.trimEnd()).join("\n")}\n\nAnswer the feedback above with that Decision.`;

/**
 * The planner's round for a run at its cap ended having decided (A11-343), and the run has finished. `round`: the run goes back on the queue as one more round of the worker, which carries the feedback and the Decision, and counts toward no cap.
 * `waiting`: the run is marked as waiting on the ticket the planner named. Either way the planner's round is over. A run that is not the planner's round at its cap is left alone. PURE.
 */
export function capDecided(queue: Queue, key: string, decision: CapDecision, now: number): Queue {
  const entry = find(queue, key);
  const cap = entry?.capRound;
  if (entry === undefined || cap === undefined || entry.phase !== "finished") return queue;
  const { capRound: _decided, ...without } = entry;
  if (decision.decision === "waiting") {
    const waiting = replace(queue, key, () => ({ ...without, waitingOnTicket: { key: decision.ticket, reason: decision.reason, since: now } }));
    return logEvent(waiting, key, now, { kind: "cap", step: "waiting", detail: `${decision.ticket}: ${shortReason(decision.reason) ?? "no reason given"}` });
  }
  const round: Entry = { ...reviewRound(without, openPulls(without), now), feedback: afterDecision(cap.latest, decision.reason), rounds: entry.rounds ?? 0 };
  const decided = logEvent(queuedLast(queue, round), key, now, { kind: "cap", step: "decided", detail: shortReason(decision.reason) ?? "no reason given" });
  return logEvent(decided, key, now, { kind: "round", cause: "cap-round", reason: shortReason(cap.latest) });
}

/**
 * The ticket a run waits on has ended its part (A11-343): its pull request merged, or the tracker completed or canceled it (`why` says which). The wait is dropped and the run goes back on the queue as a round of the worker, which says what happened and
 * counts toward no cap. A run that does not wait on a ticket is left alone. PURE.
 */
export function ticketWaitEnded(queue: Queue, key: string, why: string, now: number): Queue {
  const entry = find(queue, key);
  const wait = entry?.waitingOnTicket;
  if (entry === undefined || wait === undefined || !isWaiting(entry)) return queue;
  const { waitingOnTicket: _ended, ...without } = entry;
  const feedback = `${wait.key} ${why}, and the board marked this run as waiting on it (${wait.reason.trim()}). Check the pull requests again: re-run what was red, and answer what is still open.`;
  const round: Entry = { ...reviewRound(without, openPulls(without), now), feedback, rounds: entry.rounds ?? 0 };
  const logged = logEvent(queuedLast(queue, round), key, now, { kind: "cap", step: "resumed", detail: `${wait.key} ${why}` });
  return logEvent(logged, key, now, { kind: "round", cause: "wait-ended", reason: shortReason(feedback) });
}

/** Whether `entry` is a finished run that reads Waiting: a run its tracker or its pull requests settled does not, whatever it was marked. PURE. */
const isWaiting = (entry: Entry): boolean => entry.phase === "finished" && workStatus(entry) === "waiting";

/** The finished runs that wait on a ticket (a run the tracker or its pull requests settled waits on none), with the ticket they wait on and since when. PURE. */
export const ticketWaits = (queue: Queue): readonly Readonly<{ key: string; on: string; since: number }>[] =>
  queue.entries.flatMap((entry) => (entry.waitingOnTicket !== undefined && isWaiting(entry) ? [{ key: entry.ticket.key, on: entry.waitingOnTicket.key, since: entry.waitingOnTicket.since }] : []));
