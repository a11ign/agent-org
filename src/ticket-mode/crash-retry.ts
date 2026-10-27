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

/** Where a run's automatic retries stand (`Entry.crashRetry`): how many the board has made or scheduled, and, while one is scheduled, the time (the pool's clock) it may start. */
export type CrashRetry = Readonly<{ count: number; retryAt?: number }>;

/** The code carried by the error under `err` (`TypeError("fetch failed")` puts the network's reason in its `cause`): `ECONNRESET`, `UND_ERR_SOCKET` and the like; undefined when `err` has no such cause. An error's own `code` is not read: it is the message's. PURE. */
export function causeCodeOf(err: unknown): string | undefined {
  const code = ((err as { cause?: unknown } | null | undefined)?.cause as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Where a run's retries stand after it crashed on `err` at `now`, given where they stood (`prior`). A transient error ({@link isTransient}: `fetch failed`, a reset, a timeout, a DNS failure, an undici socket error, a 5xx) with a retry left
 * schedules the next one after its back-off. Any other error, and a transient one once {@link CRASH_RETRIES} are used, schedules none: the run stays crashed. Undefined when the run has had no retry and gets none. PURE.
 */
export function crashRetryAfter(err: unknown, prior: CrashRetry | undefined, now: number): CrashRetry | undefined {
  const count = prior?.count ?? 0;
  if (!isTransient(err) || count >= CRASH_RETRIES) return prior === undefined ? undefined : { count };
  return { count: count + 1, retryAt: now + CRASH_WAITS_MS[count] };
}

/** Whether a crashed run's scheduled retry is due at `now`. PURE. */
export const retryDue = (retry: CrashRetry, now: number): boolean => retry.retryAt !== undefined && retry.retryAt <= now;
