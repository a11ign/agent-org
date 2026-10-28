// no-token: gh -- the code host, the reviewer, herdr and the clock are all injected fakes; nothing is spawned
// module: a pull request is looked at by one sweep at a time (A11-356) -- the code host's reads answer a promise, so the sweeps that start reviewers are no longer atomic
import { test } from "node:test";
import assert from "node:assert/strict";
import { joinRunning } from "./pool-reads.ts";
import { settled, standoffRun } from "./pool-standoff-fixture.ts";

test("A11-356: two sweeps that look at a blocked head the same moment start one re-review, not two", async () => {
  const { pool, reviewer, reply } = await standoffRun();
  const before = reviewer.started.length;
  reply("Fixed in the description: the measurement is redone.");
  await Promise.all([pool.reviewNewHeads(), pool.reviewNewHeads(), pool.watchFeedback()]);
  assert.equal(reviewer.started.length - before, 1, "the reply answered the block once, and one reviewer was started for it");
  await settled();
});

test("A11-356: a sweep called while it is under way joins the one under way, and a sweep called after it has settled runs again", async () => {
  const running = new WeakMap<object, Promise<void>>();
  const owner = {};
  let passes = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pass = async () => { passes += 1; await gate; };
  const first = joinRunning(running, owner, pass);
  const second = joinRunning(running, owner, pass);
  assert.equal(second, first);
  release();
  await Promise.all([first, second]);
  assert.equal(passes, 1);
  await joinRunning(running, owner, async () => { passes += 1; });
  assert.equal(passes, 2);
});

test("A11-356: a sweep that failed does not stop the next one from running", async () => {
  const running = new WeakMap<object, Promise<void>>();
  const owner = {};
  await assert.rejects(joinRunning(running, owner, async () => { throw new Error("gh is down"); }), /gh is down/);
  let ran = false;
  await joinRunning(running, owner, async () => { ran = true; });
  assert.equal(ran, true);
});
