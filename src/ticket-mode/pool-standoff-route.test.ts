// no-token: gh -- the code host, the reviewer, herdr and the clock are all injected fakes; nothing is spawned
// module: a stand-off is routed once for each head (A11-290) -- to the planner when the worker's reply disputes a decision, else to the worker
import { test } from "node:test";
import assert from "node:assert/strict";
import { logOf } from "./queue/run-log.ts";
import { clock, MINUTE, PLANNER, refusedFile, settled, standoffRun } from "./pool-standoff-fixture.ts";

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

const CHANGED = "Fix the toast.\n\n## Decisions (the chairman, 2026-10-26)\n\n* The 200 KB limit is dropped: the entry point is 300 KB, so the limit is 400 KB.\n\n## Done-when\n\n- the toast reads right\n";

test("A11-290: a re-review that stays not convinced after the ticket's Decisions changed goes to the planner at once, with the changed Decision quoted, whatever the worker replied", async () => {
  const { pool, entry, decide, refuseRereview } = await standoffRun({ tickets: PLANNER, descriptions: { "NBF-1": "Fix the toast.\n\n## Done-when\n\n- the toast reads right\n" } });
  decide(CHANGED);
  refuseRereview(refusedFile("not convinced", "The decision is not present in the ticket's explicit Decisions, and the bundle is 340 KB."));
  clock.ms += MINUTE;
  assert.match(entry().standoff?.decisions ?? "", /the limit is 400 KB/, "the changed Decision is kept with the stand-off");
  pool.watchFeedback();
  assert.equal(entry().standoff?.stage, "planner", "no 30 minutes, no worker first");
  assert.match(entry().feedback ?? "", /The ticket's Decisions changed before this re-review, which had them in its prompt, and it still stayed not convinced\./);
  assert.match(entry().feedback ?? "", /> \* The 200 KB limit is dropped: the entry point is 300 KB, so the limit is 400 KB\./, "quoted as the ticket words it");
  assert.match(entry().feedback ?? "", /is not present in the ticket's explicit Decisions/, "with the re-reviewer's denial");
  assert.match(entry().feedback ?? "", /you cannot change one/, "and the planner is told a person's Decision is not its to change");
  await settled();
});

test("A11-290: a re-review summoned by a reply alone, and one after Decisions changed on a machine with no planner, are not sent to the planner", async () => {
  const reply = await openStandoff("Fixed in the description.", { tickets: PLANNER });
  assert.equal(reply.entry().standoff?.decisions, null);
  reply.pool.watchFeedback();
  assert.equal(reply.entry().standoff?.stage, "worker");
  await settled();
  const bare = await standoffRun({ descriptions: { "NBF-1": "Fix the toast.\n" } });
  bare.decide(CHANGED);
  bare.refuseRereview();
  clock.ms += MINUTE;
  bare.pool.watchFeedback();
  assert.equal(bare.entry().standoff?.stage, "worker", "there is no planner to ask");
  await settled();
});

test("A11-290: other feedback on the run is answered first, and the stand-off is routed when that round has ended", async () => {
  const { pool, pull, entry, fixture, url } = await openStandoff("Fixed in the description.", { tickets: PLANNER });
  pull.feedback = { feedbackAt: clock.ms + MINUTE, authors: ["a-person"] };
  pool.watchFeedback();
  assert.equal(entry().standoff?.stage, "open", "a person's comment is a round of its own");
  assert.match(entry().feedback ?? "", /New review feedback on/);
  fixture.store.set({ ...fixture.store.get(), entries: [{ ...entry(), phase: "finished", finishedAt: clock.ms + 2 * MINUTE, outcome: { kind: "reviewed", prs: [{ repo: "nbl-ui-netbox", url }] } }] });
  pull.feedback = {};
  pool.watchFeedback();
  assert.equal(entry().standoff?.stage, "worker");
  await settled();
});
