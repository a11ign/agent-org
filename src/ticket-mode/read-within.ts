// @ts-check
// module: a read cut off after a time (A11-364) -- the board never waits on the tracker, the code host or a remote for longer than its limit

/**
 * The answer of `read()`, or a rejection saying `what` did not answer within `ms`. A read that outlives the limit is not cancelled (a promise cannot be): its late answer, or failure, is dropped, and nothing
 * waits on it. The timer is cleared either way, so a read that answers holds the process for no longer than it took.
 */
export function within<T>(read: () => Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s`)), ms);
    const settle = <A extends unknown[]>(done: (...args: A) => void) => (...args: A): void => { clearTimeout(timer); done(...args); };
    try {
      read().then(settle(resolve), settle(reject));
    } catch (err) {
      settle(reject)(err);
    }
  });
}
