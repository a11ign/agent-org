// no-token: none -- queues built with the board's own transitions
// module: a ticket whose step 1 pull request is open and in no entry, for the tests of the pull requests the board keeps (A11-286)
import { emptyQueue } from "./queue.ts";
import { enqueue, find, replace, type Entry, type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { queueNextStep } from "./queue/queue-next-step.ts";
import { finish, markRunning, markStarting } from "./queue/queue-transitions.ts";
import type { Ticket } from "./source.ts";

/** A ticket of the tracker, by key. */
export const ticketOf = (key: string): Ticket => ({ key, title: key, description: "", url: `https://linear.app/x/${key}`, branch: `${key.toLowerCase()}-work`, status: "Backlog", statusOrder: 0, team: "A11", project: null, priority: 0 }) as Ticket;

/** `key` queued, started, and run to the end of `outcome` at `at`. */
export function finishedWith(key: string, outcome: Parameters<typeof finish>[2], at: number, queue: Queue = emptyQueue(3)): Queue {
  const queued = enqueue(queue, [ticketOf(key)], { model: "sonnet", effort: "high" }, 0);
  return finish(markRunning(markStarting(queued, key, 1), key, "w1", "w1:p1"), key, outcome, at);
}

/** `key` finished on step 1's pull request `url` (a ready pull request, partial) and then queued for its next step: the entry holds no pull request, and the run log holds the one it opened. `more` is set on the queued entry. */
export function nextStepQueued(key: string, url: string, now: number, more: Partial<Entry> = {}): Queue {
  const finished = finishedWith(key, { kind: "ready-pr", prs: [{ repo: url.split("/")[4] ?? "", url }], partial: "step 2 of 2" }, now - 10);
  const queued = queueNextStep(finished, key, { step: 1, of: 2, prs: [url] }, now - 5);
  return replace(queued, key, (entry) => ({ ...entry, ...more }));
}

/** The entry of `key`. */
export const entryOf = (queue: Queue, key: string): Entry => find(queue, key)!;
