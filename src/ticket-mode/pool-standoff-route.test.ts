// no-token: gh -- the code host, the reviewer, herdr and the clock are all injected fakes; nothing is spawned
// module: a stand-off is routed once for each head (A11-290) -- to the planner when the worker's reply disputes a decision, else to the worker
import { test } from "node:test";
import assert from "node:assert/strict";
import { logOf } from "./queue/run-log.ts";
import { clock, MINUTE, PLANNER, settled, standoffRun } from "./pool-standoff-fixture.ts";

const DECISIONS = "## Decisions (the chairman's session, 2026-10-26)\n\n- The bundle stays under 200 KB, whatever the plan says about it.\n";

/** A run whose stand-off is open: the worker replied with `text`, the re-review ran and the door refused it. */
async function openStandoff(text: string, over: Parameters<typeof standoffRun>[0] = {}) {
  const run = await standoffRun(over);
  run.startRereview(text);
  run.refuseRereview();
  clock.ms += MINUTE;
  return run;
}

test("A11-290: a reply that disputes no decision sends the stand-off to the worker, with the re-reviewer's reasons, and charges no round", async () => {
  const { fixture, pool, entry, url } = await openStandoff("Fixed in the description: the measurement is redone.", { tickets: PLANNER });
  const rounds = entry().rounds ?? 0;
  pool.watchFeedback();
  const queued = entry();
  assert.equal(queued.phase, "queued");
  assert.equal(queued.standoff?.stage, "worker");
  assert.deepEqual(queued.review?.map((pull) => pull.url), [url], "the same worker's pull requests");
  assert.match(queued.feedback ?? "", /is still not convinced/);
  assert.match(queued.feedback ?? "", /340 KB/, "the re-reviewer's reasons are carried");
  assert.match(queued.feedback ?? "", /Fixed in the description: the measurement is redone\./, "and the worker's own reply");
  assert.equal(queued.rounds ?? 0, rounds, "a stand-off round counts toward no cap");
  const events = logOf(fixture.store.get(), "NBF-1");
  assert.ok(events.some((event) => event.kind === "round" && event.cause === "standoff-worker"));
  assert.ok(events.some((event) => event.kind === "standoff" && event.step === "worker"));
  await settled();
});

test("A11-290: a reply that says the plan cannot be met, or quotes a decision, goes to the planner first", async () => {
  for (const text of ["Plan cannot be met: the plan's 200 KB limit is below the entry point's 300 KB.", "The ticket says: The bundle stays under 200 KB, whatever the plan says about it. Mine is 340 KB."]) {
    const { pool, entry } = await openStandoff(text, { tickets: PLANNER, descriptions: { "NBF-1": DECISIONS } });
    pool.watchFeedback();
    assert.equal(entry().standoff?.stage, "planner", text);
    assert.equal(entry().phase, "queued");
    await settled();
  }
});

test("A11-290: with no planner on the machine a disputed decision goes to the worker, and a stand-off is routed once for each head", async () => {
  const { pool, entry, fixture } = await openStandoff("Plan cannot be met: the limit.");
  pool.watchFeedback();
  assert.equal(entry().standoff?.stage, "worker");
  // The worker's round ended with no change at the head: the stand-off is done, and is not routed again.
  fixture.store.set({ ...fixture.store.get(), entries: [{ ...entry(), phase: "finished", standoff: { ...entry().standoff!, stage: "done" } }] });
  pool.watchFeedback();
  assert.equal(entry().phase, "finished");
  await settled();
});
