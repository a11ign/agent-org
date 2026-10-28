// module: how many of the code host's reads a sweep has in flight at once (A11-356)
//
// THE CODE HOST'S READS ANSWER A PROMISE, so a sweep that reads thirty pull requests could start thirty `gh` processes at once, where it started them one after another and held the loop for each. A sweep reads them through
// here: at most {@link READS_AT_ONCE} at a time, and the answers in the order of the items, so what a sweep does with them does not depend on which answered first.

/** The most reads one sweep has in flight: enough that the sweep is not the sum of its reads, few enough that GitHub's rate limits and the host's process table are not the sweep's to find. */
export const READS_AT_ONCE = 4;

/** `read` of each of `items`, at most `limit` at a time, the answers in the order of `items`. A read that rejects rejects the whole, after the reads in flight have settled. */
export async function readEach<T, R>(items: readonly T[], read: (item: T, at: number) => Promise<R>, limit: number = READS_AT_ONCE): Promise<R[]> {
  const answers = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const at = next++;
      answers[at] = await read(items[at], at);
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));
  const refused = settled.find((each): each is PromiseRejectedResult => each.status === "rejected");
  if (refused !== undefined) throw refused.reason;
  return answers;
}

/**
 * `run`, unless a run started through the same `running` is still under way for `owner`: then that one's promise, so a sweep that is called again while it waits on the code host (by its own timer, or by the watch that calls it first)
 * joins the one in progress and does not make a second pass over the same pull requests beside it.
 */
export function joinRunning(running: WeakMap<object, Promise<void>>, owner: object, run: () => Promise<void>): Promise<void> {
  const under = running.get(owner);
  if (under !== undefined) return under;
  const mine = run();
  running.set(owner, mine);
  const done = () => { if (running.get(owner) === mine) running.delete(owner); };
  mine.then(done, done);
  return mine;
}
