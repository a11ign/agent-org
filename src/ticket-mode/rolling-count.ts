// @ts-check
// module: a count over the last `windowMs`, kept in one-minute buckets (A11-363) -- the board's health figures that are "per hour"
//
// A BUCKET IS A MINUTE, so an hour is at most 61 numbers however many events it holds. An event is counted in the bucket of the minute it happened in, and a bucket is dropped once its whole minute is older than the window,
// so the count can run up to a minute long: a figure that says "the last hour" is at most an hour and a minute.

/** How long one bucket covers, in ms. */
export const BUCKET_MS = 60_000;

export type RollingCount = Readonly<{
  /** Counts `times` events now. */
  add: (times?: number) => void;
  /** The events counted within the window. */
  total: () => number;
}>;

/** A count over the last `windowMs` as `now` says, in ms since the epoch. */
export function rollingCount(windowMs: number, now: () => number = Date.now): RollingCount {
  const buckets = new Map<number, number>();
  const prune = (at: number): void => {
    for (const start of buckets.keys()) if (start + BUCKET_MS <= at - windowMs) buckets.delete(start);
  };
  return {
    add: (times = 1) => {
      const at = now();
      const start = Math.floor(at / BUCKET_MS) * BUCKET_MS;
      buckets.set(start, (buckets.get(start) ?? 0) + times);
      prune(at);
    },
    total: () => {
      prune(now());
      let sum = 0;
      for (const count of buckets.values()) sum += count;
      return sum;
    },
  };
}
