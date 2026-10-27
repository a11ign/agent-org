// @ts-check
// module: a run that crashed on a transient network error is started again by the board, after a back-off, twice at most (A11-345)

import { MS_PER_SECOND } from "./attach-retry.ts";
import { CRASH_RETRIES, crashRetryAfter, retryDue } from "./crash-retry.ts";
import { type Entry, find, replace, retry, type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { finish } from "./queue/queue-transitions.ts";
import { type PoolContext } from "./pool-context.ts";
import { crashed, log, messageOf, update } from "./pool-state.ts";

/**
 * Ticket `key` ends `crashed` at `now` on `err`, and, when `err` is a transient network error with a retry left, its entry carries the retry the board will make once the back-off has passed ({@link retryCrashed}).
 * A crash for any other reason, a transient one after the retries are used, and one of a run no longer starting carry none and read Failed with their reason. PURE.
 */
export function finishCrashed(queue: Queue, key: string, err: unknown, now: number): Queue {
  const entry = find(queue, key);
  // Only a run still starting is started again: one a person stopped, a drain queued again or a pane already opened is not the start that failed (and an opened pane would get a second workspace).
  const next = entry?.phase === "starting" ? crashRetryAfter(err, entry.crashRetry, now) : undefined;
  const ended = finish(queue, key, crashed(err), now);
  return next === undefined ? ended : replace(ended, key, (entry) => ({ ...entry, crashRetry: next }));
}

/** End each of `keys` crashed on `err`, and say in the board's log why, and whether the board will try again. */
export function endCrashed(ctx: PoolContext, keys: readonly string[], err: unknown): void {
  const at = ctx.now();
  update(ctx, (queue) => keys.reduce((next, key) => finishCrashed(next, key, err, at), queue));
  for (const key of keys) {
    const { crashRetry } = find(ctx.store.get(), key) ?? {};
    const again = crashRetry?.retryAt === undefined ? "not trying again" : `trying again ${crashRetry.count} of ${CRASH_RETRIES} in ${Math.round((crashRetry.retryAt - at) / MS_PER_SECOND)} s`;
    log(`${key} crashed: ${messageOf(err).split("\n")[0]} (${again})`);
  }
}

/** Whether a run ended crashed and has a retry scheduled whose back-off has passed at `now`. PURE. */
const isCrashRetryDue = ({ phase, outcome, crashRetry }: Entry, now: number): boolean =>
  phase === "finished" && outcome?.kind === "crashed" && crashRetry !== undefined && retryDue(crashRetry, now);

/**
 * Queue again each crashed run whose back-off has passed, as a person's Retry does, and log the retry on the run's log. The queued run keeps the count of its retries, so a third transient crash is not retried. A run a person has
 * dismissed, removed or retried since has no retry left to make. Called each pass, before the fill that starts it.
 */
export function retryCrashed(ctx: PoolContext): void {
  const { now, store } = ctx;
  const due = store.get().entries.flatMap((entry) => (isCrashRetryDue(entry, now()) ? [{ key: entry.ticket.key, count: entry.crashRetry!.count }] : []));
  for (const { key, count } of due) {
    update(ctx, (queue) => {
      const queued = retry(queue, key, now(), "crash-retry");
      // A run `retry` leaves as it is would be asked again every pass: it keeps its count and loses the time.
      return replace(queued, key, (entry) => ({ ...entry, crashRetry: { count } }));
    });
    log(`${key} is queued again after its crash on a network error (retry ${count} of ${CRASH_RETRIES})`);
  }
}
