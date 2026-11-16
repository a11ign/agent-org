// @ts-check
// module: telling a plan attach that hit a network or server failure, which the board tries again, from a refusal, which goes to a person (A11-216)

export const MS_PER_SECOND = 1_000;

/** How many times the board asks the tracker to attach a plan before a transient failure goes to a person: the first try and three retries. */
export const ATTACH_TRIES = 4;

/** How long the board waits after the first, second and third failed try before the next one, in milliseconds: 5 s, 30 s and 2 min. */
export const ATTACH_WAITS_MS: readonly number[] = [5 * MS_PER_SECOND, 30 * MS_PER_SECOND, 120 * MS_PER_SECOND];

/**
 * Whether a plan attach that threw `err` is worth trying again as it is: what the outside client's one rule calls transient (`outside-client.ts`, A11-436): a failure of the network (`fetch failed`, a timeout, a
 * reset or an undici socket error), a 5xx the tracker answered with, or a tracker its breaker holds off. Anything else is a refusal (a 4xx, a validation error, a GraphQL error on a 200) and goes to a person at once.
 */
export { isTransient, withCause } from "./outside-client.ts";
