// no-token: gh -- a pool over the caller's fakes; nothing is spawned
// module: a pool whose pass waits for the reads it began, for the tests of what a pass starts (A11-364)
//
// A PASS DECIDES FROM WHAT WAS LAST READ, and the reads of blockers, heads and plans are made beside it (`pool-start-reads.ts`). In production a read that ends wakes the pool, so the run it lets start starts at once. A test
// that asks "what does a tick start" waits for that: this pool's `tick` is the pass, then the reads it began, then the pass each woke. A test of the pass that does NOT wait uses `createPool` itself.
import { createPool, type PoolDeps, type QueueStore } from "./pool.ts";

/** Every pool this module made, so a test that waits for background work waits for the reads of all of them. */
const made: ReturnType<typeof createPool>[] = [];

/** A pool as `createPool` makes it, whose `tick` settles only after the reads it began have ended and the pass they woke has run. */
export function createSettledPool(store: QueueStore, deps: PoolDeps) {
  const pool = createPool(store, deps);
  made.push(pool);
  return { ...pool, tick: async (): Promise<void> => { await pool.tick(); await pool.startReadsSettled(); } };
}

/** Settles once the reads every pool made here began have ended, and the passes they woke have run. */
export async function readsSettled(): Promise<void> {
  for (const pool of made) await pool.startReadsSettled();
}
