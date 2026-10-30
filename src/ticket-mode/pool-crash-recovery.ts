// @ts-check
// module: a run that crashed on transient network errors past its retries is started again once the board's own network calls succeed (A11-399)
//
// WHY. A11-345 starts a crashed run again twice, after 30 s and 2 min, and the third transient crash ended it for good: on 2026-10-28 A11-231 used its retries inside an outage, stayed crashed after the network came back, and held A11-232 behind it
// for two days. A run that crashed on nothing but network errors has no reason of its own to stay stopped. `finishCrashed` marks it (`CrashRetry.recovery`); this pass starts it again.

import { networkUpSince } from "./call-outcomes.ts";
import { RECOVERY_RESTARTS, recentRestarts, recoveryDue, restartFreeAt } from "./crash-retry.ts";
import { type Entry, replace, retry, SETTLED } from "./queue/queue-entries-and-outcomes.ts";
import { retryRefusal } from "./queue/queue-retry-refusal.ts";
import { type PoolContext } from "./pool-context.ts";
import { log, update } from "./pool-state.ts";

/** Whether a run ended crashed with a recovery whose earliest start has passed at `now`, the day's bound leaves it a restart, and its ticket is not completed or closed in the tracker. PURE. */
const isRecoveryDue = ({ phase, outcome, crashRetry, trackerState }: Entry, now: number): boolean =>
  phase === "finished" && outcome?.kind === "crashed" && !SETTLED.has(trackerState ?? "") && crashRetry !== undefined && recoveryDue(crashRetry, now) && restartFreeAt(crashRetry.recovery, now) === undefined;

/**
 * Queue again each crashed run whose recovery is due, as a person's Retry does, once the board's own calls to Linear and GitHub work again after the run's crash (`networkUpSince`), and log it on the run's log. The queued run keeps its
 * count and the restarts of the window, and carries no earliest start, so a further transient crash waits for the next back-off. A run whose ticket was completed or closed meanwhile, or that a person has retried, dismissed or removed
 * since, is left as it is. Called each pass, after `retryCrashed` and before the fill that starts the run.
 */
export function recoverCrashed(ctx: PoolContext): void {
  const { now, store, calls } = ctx;
  const canStart = (entry: Entry): boolean => isRecoveryDue(entry, now()) && retryRefusal(entry) === null && networkUpSince(calls, entry.finishedAt ?? Number.POSITIVE_INFINITY);
  const due = store.get().entries.flatMap((entry) => (canStart(entry) ? [{ key: entry.ticket.key, retries: entry.crashRetry! }] : []));
  for (const { key, retries } of due) {
    const at = now();
    const restarts = [...recentRestarts(retries.recovery, at), at];
    update(ctx, (queue) => replace(retry(queue, key, at, "network-recovered"), key, (entry) => ({ ...entry, crashRetry: { count: retries.count, recovery: { restarts } } })));
    log(`${key} is queued again now its network calls succeed (restart ${restarts.length} of ${RECOVERY_RESTARTS} in 24 h)`);
  }
}
