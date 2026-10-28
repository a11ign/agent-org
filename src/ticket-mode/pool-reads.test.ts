// no-token: none -- the reads are stand-in promises; nothing here runs gh
// module: how many of the code host's reads a sweep has in flight at once, and that it keeps the order of what it read (A11-356)
import { test } from "node:test";
import assert from "node:assert/strict";
import { READS_AT_ONCE, readEach } from "./pool-reads.ts";

/** Reads that finish in the reverse of the order they were asked, and count how many are in flight at the most. */
function reversing(total: number) {
  const gates: (() => void)[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  const read = async (item: number): Promise<string> => {
    inFlight += 1;
    mostInFlight = Math.max(mostInFlight, inFlight);
    await new Promise<void>((resolve) => { gates.push(resolve); });
    inFlight -= 1;
    return `answer ${item}`;
  };
  /** Lets every read that has started finish, newest first, until all `total` have. */
  const finishAll = async (): Promise<void> => {
    for (let finished = 0; finished < total; ) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      const open = gates.splice(0);
      for (const release of open.reverse()) { release(); finished += 1; }
    }
  };
  return { read, finishAll, mostInFlight: () => mostInFlight };
}

test("A11-356: no more than READS_AT_ONCE reads are in flight at once, however many items there are", async () => {
  const { read, finishAll, mostInFlight } = reversing(11);
  const all = readEach(Array.from({ length: 11 }, (_, at) => at), read);
  await finishAll();
  await all;
  assert.equal(mostInFlight(), READS_AT_ONCE);
  assert.equal(READS_AT_ONCE, 4);
});

test("A11-356: the answers are in the order of the items, whichever read finishes first", async () => {
  const items = ["a", "b", "c", "d", "e", "f"].map((_, at) => at);
  const { read, finishAll } = reversing(items.length);
  const all = readEach(items, read);
  await finishAll();
  assert.deepEqual(await all, items.map((item) => `answer ${item}`));
});

test("A11-356: fewer items than the limit are all read at once, and no items are no reads", async () => {
  const { read, finishAll, mostInFlight } = reversing(2);
  const all = readEach([0, 1], read);
  await finishAll();
  await all;
  assert.equal(mostInFlight(), 2);
  assert.deepEqual(await readEach([], read), []);
});

test("A11-356: a read that rejects rejects the whole, after the reads in flight have settled", async () => {
  let settledReads = 0;
  const read = async (item: number): Promise<number> => {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    settledReads += 1;
    if (item === 1) throw new Error("gh is down");
    return item;
  };
  await assert.rejects(readEach([0, 1, 2], read), /gh is down/);
  assert.ok(settledReads >= 3, "the other reads in flight finished before it rejected");
});
