// @ts-check
// module: telling a write of a run's result to the tracker that failed for a while, which the board tries again, from one that cannot succeed, which goes to a person (A11-304) -- PURE

import { isTransient, MS_PER_SECOND, withCause } from "./attach-retry.ts";

const MS_PER_MINUTE = 60 * MS_PER_SECOND;

/** How long a result write may keep failing for the tracker's own reasons (the network, a 5xx, a 429) before a person is asked: an hour from the first failure. */
export const WRITE_GIVE_UP_MS = 60 * MS_PER_MINUTE;

/** How long the board waits after the first, second, third and later failed tries before the next one, in milliseconds: 5 s, 30 s, 2 min, 5 min, then 10 min until {@link WRITE_GIVE_UP_MS} has passed. */
const WRITE_WAITS_MS: readonly number[] = [5 * MS_PER_SECOND, 30 * MS_PER_SECOND, 2 * MS_PER_MINUTE, 5 * MS_PER_MINUTE, 10 * MS_PER_MINUTE];

const TOO_MANY_REQUESTS = 429;

/** The card's note while the board waits to try a result write again. */
export const WRITE_RETRY_NOTE = "recording the result in the tracker (retrying)";

/** Where a run's result write stands after a failure worth trying again, by herdr name: the tries that failed, when the first failed, and the time (the pool's clock) the next may start. */
export type WriteRetry = Readonly<{ failures: number; firstAt: number; nextAt: number }>;

const isRateLimit = (err: unknown): boolean => withCause(err).some((one) => (one as { status?: unknown } | null | undefined)?.status === TOO_MANY_REQUESTS);

/**
 * Whether a result write that threw `err` may succeed if it is tried again as it is: a failure of the network (`fetch failed`, a timeout, a reset), a 5xx the tracker answered with, or a 429. Anything else is the tracker refusing the
 * request itself (a 4xx, a validation error, a GraphQL error on a 200) and cannot succeed. It reads the error's type, its `code` and its numeric `status`, never its message. PURE.
 */
export const isRetryableWrite = (err: unknown): boolean => isTransient(err) || isRateLimit(err);

/** How long to wait before the try that follows the `failures`th failed one. PURE. */
export const writeWait = (failures: number): number => WRITE_WAITS_MS[Math.min(failures, WRITE_WAITS_MS.length) - 1];
