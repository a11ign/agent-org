// @ts-check
// module: a plan that names the tickets its work waits on (A11-272) -- the queue's record of them once the board has written them to the tracker
import { replace, type Queue } from "./queue-entries-and-outcomes.ts";

/**
 * The ticket `key` has been planned with the blockers `keys` written to the tracker (`pool-plan-blockers.ts`): its blockers are read again before it starts, because `fill` starts no run with unread blockers and the ones it
 * holds were read without the relation; and it waits for each of them to MERGE (`waitMerged`), not to stack on their open pull requests, because a step that needs another ticket's work needs it on the default branch. No keys changes nothing.
 * (`planDone` rebuilds the entry without a `waitMerged`, so the keys are the whole of it.) PURE.
 */
export function recordPlanBlockers(queue: Queue, key: string, keys: readonly string[]): Queue {
  if (keys.length === 0) return queue;
  return replace(queue, key, ({ blockers: _stale, ...entry }) => ({ ...entry, waitMerged: keys }));
}
