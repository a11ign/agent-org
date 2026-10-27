// no-token: none -- the reads are stand-in promises; nothing here runs gh
import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedReads } from "./shared-reads.ts";

/** A read that counts how often it is made and answers when `release` is called, so a test can ask again while it is in flight. */
function slow<T>(answer: T) {
  const made = { count: 0 };
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { made, release: () => release(), read: async (): Promise<T> => { made.count += 1; await gate; return answer; } };
}

test("A11-356: two callers that ask for the same key while it is in flight share one read", async () => {
  const { made, read, release } = slow("answer");
  const shared = sharedReads({ ttlMs: 1000, now: () => 0 });
  const both = Promise.all([shared("a", read), shared("a", read)]);
  release();
  assert.deepEqual(await both, ["answer", "answer"]);
  assert.equal(made.count, 1);
});

test("A11-356: an answer is shared until the bound passes after it settled, and a read is made again after it", async () => {
  let clock = 0;
  let count = 0;
  const shared = sharedReads({ ttlMs: 1000, now: () => clock });
  const read = async () => ++count;
  assert.equal(await shared("a", read), 1);
  clock = 999;
  assert.equal(await shared("a", read), 1, "within the bound, the answer of the first ask");
  clock = 1000;
  assert.equal(await shared("a", read), 2, "at the bound, a new read");
});

test("A11-356: the bound runs from when the read settled, not from when it was asked", async () => {
  let clock = 0;
  let count = 0;
  const shared = sharedReads({ ttlMs: 1000, now: () => clock });
  const read = async () => { clock += 900; return ++count; };
  assert.equal(await shared("a", read), 1);
  clock += 900;
  assert.equal(await shared("a", read), 1, "900 ms after it settled, though 1800 after it was asked");
});

test("A11-356: a read that failed is not kept: the next ask makes it again, and the callers in flight see the failure", async () => {
  const shared = sharedReads({ ttlMs: 1000, now: () => 0 });
  let count = 0;
  const read = async () => { count += 1; if (count === 1) throw new Error("gh is down"); return "back"; };
  await assert.rejects(shared("a", read), /gh is down/);
  assert.equal(await shared("a", read), "back");
  assert.equal(count, 2);
});

test("A11-356: a null answer is \"could not ask\", so it is not kept: the next ask reads again, though callers in flight share it", async () => {
  const shared = sharedReads({ ttlMs: 1000, now: () => 0 });
  let count = 0;
  const read = async () => { count += 1; return null; };
  await Promise.all([shared("a", read), shared("a", read)]);
  assert.equal(count, 1, "the two callers in flight share one read");
  await shared("a", read);
  assert.equal(count, 2);
});

test("A11-356: forget drops what is kept under the keys that begin with the prefix, and no other", async () => {
  const shared = sharedReads({ ttlMs: 1000, now: () => 0 });
  const counts = { a: 0, b: 0 };
  await shared("list x", async () => ++counts.a);
  await shared("view y", async () => ++counts.b);
  shared.forget("list ");
  assert.equal(await shared("list x", async () => ++counts.a), 2, "read again");
  assert.equal(await shared("view y", async () => ++counts.b), 1, "kept");
});

test("A11-356: different keys are different reads", async () => {
  const shared = sharedReads({ ttlMs: 1000, now: () => 0 });
  assert.deepEqual(await Promise.all([shared("a", async () => 1), shared("b", async () => 2)]), [1, 2]);
});
