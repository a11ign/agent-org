// @ts-check
// module: a bound on a wait -- a promise that does not settle in time becomes a refusal that names it (A11-225)
//
// AN AWAIT NOTHING CAN SETTLE ENDS THE PROCESS SILENTLY: with no handle left the event loop empties, and Node exits 13 with only "Detected unsettled top-level await". The timer here is NOT
// `unref`'d, on purpose: it is the handle that keeps the loop alive, so a promise nothing can settle becomes a message after `ms` and not a silent exit.

export const MS_PER_SECOND = 1000;

/** What `withinTime` rejects with, so a caller can turn it into its own kind of refusal. */
export class TimeLimitError extends Error {}

/**
 * `promise`, or a rejection `` `<what>` did not finish within <n>s `` when `ms` passes first. The timer is cleared as soon as `promise` settles, so a settled wait leaves nothing behind.
 * @param what the step, as the message names it
 */
export function withinTime<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeLimitError(`\`${what}\` did not finish within ${ms / MS_PER_SECOND}s`)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}
