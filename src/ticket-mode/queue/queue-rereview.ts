// @ts-check
// module: the round a re-review of a blocked head takes from a run (A11-235) -- one of the board's own rounds, with no worker queued for it
//
// A finding answered without a commit (a description edit, or a reply) earns the reviewer another look at the same head. That look is how the board answers the answer, so it counts as one of the
// board's own rounds, as the worker's round for a new finding would: a dispute, where the reviewer keeps blocking and the worker keeps answering, then ends at `MAX_FEEDBACK_ROUNDS` and not never.
import { replace, type Queue } from "./queue-entries-and-outcomes.ts";
import { MAX_FEEDBACK_ROUNDS } from "./queue-transitions.ts";

/**
 * A re-review of a finished run's blocked head was started: it counts as one of the board's own rounds (`rounds` goes up by one), and no worker is queued, since the worker already answered. The caller
 * has checked `roundsLeft` first. A run that is not finished is left alone: its round is still under way. PURE.
 */
export const countRereview = (queue: Queue, key: string): Queue =>
  replace(queue, key, (entry) => (entry.phase === "finished" ? { ...entry, rounds: (entry.rounds ?? 0) + 1 } : entry));

/**
 * A re-review is due and the finished run has no round left: the run is handed to a person, as a capped feedback round does, naming `answered`, the block that was answered; the caller starts no reviewer.
 * A run that is already handed back is left as it is, so a sweep that finds the same answer again says nothing more. PURE.
 */
export function handBackRereview(queue: Queue, key: string, answered: string): Queue {
  return replace(queue, key, (entry) => {
    if (entry.phase !== "finished" || entry.handedBack !== undefined) return entry;
    return { ...entry, handedBack: `The pull requests keep getting feedback: the board answered ${entry.rounds ?? MAX_FEEDBACK_ROUNDS} rounds on its own and stopped. Respond to review starts another. The latest: ${answered}` };
  });
}
