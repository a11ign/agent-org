// @ts-check
// module: telling a run that crashed on a transient network error, which the board starts again by itself after a back-off, from any other crash (A11-345) -- PURE
//
// WHY. On 2026-10-27 A11-343 and A11-344 each crashed with `fetch failed` a few minutes after they started, in a burst of them, and stayed crashed until the chairman's session retried them: each held up a fix a Needs-you card was waiting on.
// A11-304 retries the tracker write a run's result makes; this is a run that crashes during its start.

import { isTransient } from "./attach-retry.ts";

/** How many times the board starts a run again by itself after it crashed on a transient error: the run then reads Failed, with its reason. */
export const CRASH_RETRIES = 2;

/** How long the board waits after the first crash, and after the second, before it starts the run again, in milliseconds: 30 s, then 2 min. */
const FIRST_WAIT_MS = 30_000;
const SECOND_WAIT_MS = 120_000;
const CRASH_WAITS_MS: readonly number[] = [FIRST_WAIT_MS, SECOND_WAIT_MS];

/** How long the board waits after each crash past the retry cap before it may start the run again, in milliseconds: 10 min, 30 min, then 2 h for every crash after (A11-399). A11-231's three crashes spanned 2 h 16 min, so the 30 s and 2 min waits are too short to outlast an outage. */
const RECOVERY_WAITS_MS: readonly number[] = [600_000, 1_800_000, 7_200_000];

/** How many times the board starts a run again by itself once its retries are used, in any {@link RECOVERY_WINDOW_MS}. */
export const RECOVERY_RESTARTS = 3;

/** The rolling window the {@link RECOVERY_RESTARTS} are counted in, in milliseconds: 24 h. A rolling window has no burst around midnight UTC. */
export const RECOVERY_WINDOW_MS = 86_400_000;

/** What marks a run that crashed on a transient error after its retries were used as one the board starts again once its network calls succeed (A11-399): the earliest time it may start (the pool's clock), and when the board started it again within the window. */
export type CrashRecovery = Readonly<{ notBefore?: number; restarts: readonly number[] }>;

/**
 * Where a run's automatic retries stand (`Entry.crashRetry`): how many the board has made or scheduled, and, while one is scheduled, the time (the pool's clock) it may start. Once the retries are used, a transient crash
 * carries a `recovery` with `notBefore` set, and only that mark makes the run eligible for {@link recoveryDue}: `count` alone is also left by a crash for another reason.
 */
export type CrashRetry = Readonly<{ count: number; retryAt?: number; recovery?: CrashRecovery }>;

/** The code carried by the error under `err` (`TypeError("fetch failed")` puts the network's reason in its `cause`): `ECONNRESET`, `UND_ERR_SOCKET` and the like; undefined when `err` has no such cause. An error's own `code` is not read: it is the message's. PURE. */
export function causeCodeOf(err: unknown): string | undefined {
  const code = ((err as { cause?: unknown } | null | undefined)?.cause as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/** The restarts of `recovery` that are still inside the window at `now`. PURE. */
export const recentRestarts = (recovery: CrashRecovery | undefined, now: number): readonly number[] => (recovery?.restarts ?? []).filter((at) => at > now - RECOVERY_WINDOW_MS);

/** The recovery a transient crash at `now` leaves: it may start again after the back-off the restarts of the window set. PURE. */
function recoveryAfter(prior: CrashRecovery | undefined, now: number): CrashRecovery {
  const restarts = recentRestarts(prior, now);
  return { notBefore: now + RECOVERY_WAITS_MS[Math.min(restarts.length, RECOVERY_WAITS_MS.length - 1)], restarts };
}

/**
 * Where a run's retries stand after it crashed on `err` at `now`, given where they stood (`prior`). A transient error ({@link isTransient}: `fetch failed`, a reset, a timeout, a DNS failure, an undici socket error, a 5xx) with a retry left
 * schedules the next one after its back-off. A transient one once {@link CRASH_RETRIES} are used carries a recovery ({@link CrashRecovery}), which the board starts it again on once its network calls succeed. Any other error schedules
 * nothing: the run stays crashed. Undefined when the run has had no retry and gets none. PURE.
 */
export function crashRetryAfter(err: unknown, prior: CrashRetry | undefined, now: number): CrashRetry | undefined {
  const count = prior?.count ?? 0;
  if (!isTransient(err)) return prior === undefined ? undefined : { count };
  if (count >= CRASH_RETRIES) return { count, recovery: recoveryAfter(prior?.recovery, now) };
  return { count: count + 1, retryAt: now + CRASH_WAITS_MS[count] };
}

/** Whether a crashed run's scheduled retry is due at `now`. PURE. */
export const retryDue = (retry: CrashRetry, now: number): boolean => retry.retryAt !== undefined && retry.retryAt <= now;

/** Whether a crashed run's recovery has passed its earliest start at `now`. PURE. */
export const recoveryDue = (retry: CrashRetry, now: number): boolean => retry.recovery?.notBefore !== undefined && retry.recovery.notBefore <= now;

/** The time the day's bound next leaves a restart free: undefined when one is free at `now`, else when the oldest restart in the window ages out. PURE. */
export function restartFreeAt(recovery: CrashRecovery | undefined, now: number): number | undefined {
  const restarts = recentRestarts(recovery, now);
  return restarts.length < RECOVERY_RESTARTS ? undefined : Math.min(...restarts) + RECOVERY_WINDOW_MS;
}
