// @ts-check
// module: the round a re-review of a blocked head takes from a run (A11-235) -- one of the board's own rounds, with no worker queued for it
//
// A finding answered without a commit (a description edit, or a reply) earns the reviewer another look at the same head. That look is how the board answers the answer, so it counts as one of the
// board's own rounds, as the worker's round for a new finding would: a dispute, where the reviewer keeps blocking and the worker keeps answering, then ends at `MAX_FEEDBACK_ROUNDS` and not never.
//
// A BODY FIX IS RE-REVIEWED WHATEVER STATE THE RUN IS IN (A11-274). The look waits only for a worker that is working now, so the reviewer never reads a body the worker is still editing: a finished run, parked or not, and
// a running one sitting on a dialog or idle on a `working` note, are all looked at again. A body change answers the block at once, except for a run the block starts a worker round for (watched, or in the round the block
// queued), where A11-235's rule stands.
import { type Entry, find, replace, type Queue } from "./queue-entries-and-outcomes.ts";
import { logEvent, shortReason } from "./run-log.ts";
import { MAX_FEEDBACK_ROUNDS, roundsLeft } from "./queue-transitions.ts";
import { capPlannerRound, type RoundOptions } from "./queue-cap.ts";
import { isWatched } from "../board-view/pull-status-and-notes.ts";

/** Whether a running run's agent is not working now: it sits on a dialog or a prompt (`waiting`), or idle on a `working` note. PURE. */
const idleWhileRunning = (entry: Entry): boolean => entry.phase === "running" && (entry.waiting === true || entry.working?.idleSince !== undefined);

/**
 * Whether a run that holds a blocked pull request may be asked for a re-review now: its worker is not working, and the planner has not set it waiting on another ticket (A11-343). A finished run, in any outcome, is asked
 * unless it was handed back for want of a round (A11-235); a running one
 * on a dialog or idle on a `working` note only while it has a round left, since a hand-back is a finished run's and the end of the run would drop it (a run with none waits for its end, and is handed back then). A queued or
 * starting run, and a running one last seen working, wait for a sweep that finds it stopped. PURE.
 */
export const mayRereview = (entry: Entry): boolean =>
  entry.waitingOnTicket === undefined && (entry.phase === "finished" ? entry.handedBack === undefined || roundsLeft(entry) : idleWhileRunning(entry) && roundsLeft(entry));

/**
 * Whether the block starts a worker round that answers it: the run is watched, so the block queues it a feedback round (`isWatched`), or it is in a round queued since the block was posted, which is that round under way. PURE.
 */
const roundAnswers = (entry: Entry, block: Readonly<{ at: number }>): boolean =>
  isWatched(entry) || (entry.phase !== "finished" && entry.review !== undefined && entry.queuedAt >= block.at);

/**
 * The description lines that changed, as an answer to `block`, of a pull request `entry` holds (none: no run holds it, and every change counts). For a run the block starts a worker round for ({@link roundAnswers}), only once that
 * round has ended after the block was posted: a description edited while the reviewer was still reading was not made in answer to it, and the worker's round is what answers it (A11-235). Any other run gets no round
 * for the block, so its `finishedAt` never moves past it, and every change since the head's last look counts (A11-274). PURE.
 */
export function bodyAnswersBlock<Line>(entry: Entry | undefined, block: Readonly<{ at: number }>, changed: readonly Line[]): readonly Line[] {
  if (entry === undefined || !roundAnswers(entry, block)) return changed;
  return (entry.finishedAt ?? 0) > block.at ? changed : [];
}

/**
 * A re-review of a run's blocked head was started: it counts as one of the board's own rounds (`rounds` goes up by one), and no worker is queued, since the worker already answered. The caller
 * has checked `roundsLeft` first. A run that {@link mayRereview} does not admit is left alone: its worker is still at work. PURE.
 */
export function countRereview(queue: Queue, key: string, now?: number, answered?: string): Queue {
  const before = find(queue, key);
  if (before === undefined || !mayRereview(before)) return queue;
  const counted = replace(queue, key, (entry) => ({ ...entry, rounds: (entry.rounds ?? 0) + 1 }));
  // The round is logged with how the block was answered, when it was counted (A11-219).
  return logEvent(counted, key, now, { kind: "round", cause: "rereview", reason: answered === undefined ? null : shortReason(answered) });
}

/**
 * A re-review is due and the finished run has no round left: the run is handed to a person, as a capped feedback round does, naming `answered`, the block that was answered; the caller starts no reviewer.
 * A run that is already handed back is left as it is, so a sweep that finds the same answer again says nothing more. A run that is not finished is left alone too: the end of the run drops a hand-back, and
 * {@link mayRereview} keeps a running one with no round left waiting for its end. PURE.
 */
export function handBackRereview(queue: Queue, key: string, answered: string, now?: number, options: RoundOptions = {}): Queue {
  const entry = find(queue, key);
  if (entry === undefined || entry.phase !== "finished" || entry.handedBack !== undefined) return queue;
  // The cap is not on the escalation list: on a machine with a planner a watched run goes to it, and not to a person (A11-343).
  if (options.planner === true && now !== undefined && isWatched(entry)) return capPlannerRound(queue, entry, answered, now);
  const handedBack = `The pull requests keep getting feedback: the board answered ${entry.rounds ?? MAX_FEEDBACK_ROUNDS} rounds on its own and stopped. Respond to review starts another. The latest: ${answered}`;
  const handed = replace(queue, key, (held) => ({ ...held, handedBack }));
  return logEvent(handed, key, now, { kind: "needs-you", reason: shortReason(handedBack) ?? handedBack });
}
