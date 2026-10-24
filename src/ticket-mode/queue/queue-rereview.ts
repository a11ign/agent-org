// @ts-check
// module: the round a re-review of a blocked head takes from a run (A11-235) -- one of the board's own rounds, with no worker queued for it
//
// A finding answered without a commit (a description edit, or a reply) earns the reviewer another look at the same head. That look is how the board answers the answer, so it counts as one of the
// board's own rounds, as the worker's round for a new finding would: a dispute, where the reviewer keeps blocking and the worker keeps answering, then ends at `MAX_FEEDBACK_ROUNDS` and not never.
import { replace, type Entry, type Queue } from "./queue-entries-and-outcomes.ts";
import { MAX_FEEDBACK_ROUNDS, roundsLeft } from "./queue-transitions.ts";

/**
 * A re-review of a finished run's blocked head is started, or is due and the run has no round left: with a round left it counts as one (`rounds` goes up by one) and no worker is queued, since the
 * worker already answered. With none left the run is handed to a person, as a capped feedback round does, naming `answered`, the block that was answered; the caller starts no reviewer then. A run that
 * is already handed back is left as it is, so a sweep that finds the same answer again says nothing more. A run that is not finished is left alone: its round is still under way. PURE.
 */
export function rereviewRound(queue: Queue, key: string, answered: string): Queue {
  return replace(queue, key, (entry): Entry => {
    if (entry.phase !== "finished") return entry;
    if (roundsLeft(entry)) return { ...entry, rounds: (entry.rounds ?? 0) + 1 };
    if (entry.handedBack !== undefined) return entry;
    return { ...entry, handedBack: `The pull requests keep getting feedback: the board answered ${entry.rounds ?? MAX_FEEDBACK_ROUNDS} rounds on its own and stopped. Respond to review starts another. The latest: ${answered}` };
  });
}
