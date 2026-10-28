// no-token: gh -- the wait and the clock are injected; nothing is spawned
// A11-363: an instance that is stopping waits for the runs that are still starting, so a restart finds their agents in herdr and queues none of them again
import { test } from "node:test";
import assert from "node:assert/strict";
import { STARTS_POLL_MS, STARTS_WAIT_MS, untilNoneStarting } from "./shutdown-wait.ts";

/** A clock that moves only when the test's wait does, and the counts of starting runs it is given in turn (the last repeats). */
function over(counts: number[]) {
  let clock = 0;
  const waits: number[] = [];
  let looked = 0;
  return { waits, looked: () => looked, run: () => untilNoneStarting({ starting: () => { looked += 1; return counts[Math.min(looked - 1, counts.length - 1)]!; }, wait: async (ms) => { waits.push(ms); clock += ms; }, now: () => clock }) };
}

test("with no run starting it does not wait at all", async () => {
  const wait = over([0]);
  assert.equal(await wait.run(), 0);
  assert.deepEqual(wait.waits, []);
});

test("it waits, looking every poll, until the last run has finished starting, and answers 0", async () => {
  const wait = over([2, 2, 1, 0]);
  assert.equal(await wait.run(), 0);
  assert.deepEqual(wait.waits, [STARTS_POLL_MS, STARTS_POLL_MS, STARTS_POLL_MS]);
});

test("a run that never finishes starting is waited for no longer than the limit, and the answer is how many were still starting", async () => {
  const wait = over([1]);
  assert.equal(await wait.run(), 1);
  assert.equal(wait.waits.reduce((sum, ms) => sum + ms, 0), STARTS_WAIT_MS);
});
