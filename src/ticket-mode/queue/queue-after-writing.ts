// @ts-check
// module: queue after writing (A11-420) -- what a new-ticket request that asked "Queue them" queues its tickets on, and how that went. PURE.

/** What a request that asked "Queue them" queues its tickets on (A11-420): the saved choice's `model` and `effort` when it was made, and whether each is planned first. */
export type QueueAfter = Readonly<{ model: string; effort: string; plan: boolean }>;

/** How a run's queueing went (A11-420): how many tickets it queued, or the sentence that says why none was. */
export type AfterWriting = Readonly<{ queued: number } | { notQueued: string }>;

/** The record of a run whose tickets were filed and not queued, with `why` in the board's or the queue's own words (A11-420). PURE. */
export function notQueued(why: string): AfterWriting {
  return { notQueued: `Written, but not queued: ${why.trim().replace(/[.\s]+$/, "")}. They are in the backlog.` };
}
