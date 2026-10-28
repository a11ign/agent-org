// no-token: gh -- the code host, the reviewer, herdr and the clock are all injected fakes; nothing is spawned
// module: the feedback watch acts on a run as the queue holds it after its reads, not as it was when they began (A11-356) -- the code host's reads take time
import { test } from "node:test";
import assert from "node:assert/strict";
import { MINUTE, settled, standoffRun } from "./pool-standoff-fixture.ts";

/** A finished run over a pull request that has new review feedback, on a paused queue so a round the watch queues stays queued for the test to read. `during` runs while the feedback is being read. */
async function runWithFeedback(during: (run: Awaited<ReturnType<typeof standoffRun>>) => void, reading: "readPullFeedback" | "readReviewState" = "readPullFeedback") {
  const run = await standoffRun();
  run.pull.feedback = { authors: ["alice"], feedbackAt: 35 * MINUTE };
  run.fixture.store.set({ ...run.fixture.store.get(), paused: true });
  const read = run.host[reading].bind(run.host) as (...args: unknown[]) => Promise<unknown>;
  (run.host as unknown as Record<string, unknown>)[reading] = async (...args: unknown[]): Promise<unknown> => {
    const answer = await read(...args);
    during(run);
    return answer;
  };
  return run;
}

test("A11-356: a run with new review feedback is handed a round by the watch (the control of the next test)", async () => {
  const run = await runWithFeedback(() => undefined);
  await run.pool.watchFeedback();
  assert.equal(run.entry().phase, "queued");
  assert.match(run.entry().feedback ?? "", /New review feedback/);
  assert.notEqual(run.entry().pullFiles, undefined, "and records the files of its pull requests");
  await settled();
});

const startRunning = ({ fixture, entry }: Awaited<ReturnType<typeof standoffRun>>) => fixture.store.set({ ...fixture.store.get(), entries: [{ ...entry(), phase: "running" }] });

test("A11-356: a run that is no longer finished when its feedback has been read is not handed a round from what was read", async () => {
  const run = await runWithFeedback(startRunning);
  await run.pool.watchFeedback();
  assert.equal(run.entry().phase, "running", "the watch left the run it found running");
  assert.equal(run.entry().feedback, undefined, "and queued no round for it");
  assert.equal(run.entry().pullFiles, undefined, "nor recorded the files read before it started");
  await settled();
});

test("A11-356: a run that is no longer finished when its reviewer has been looked at is not handed a round from what the watch read before", async () => {
  const run = await runWithFeedback(startRunning, "readReviewState");
  await run.pool.watchFeedback();
  assert.equal(run.entry().phase, "running");
  assert.equal(run.entry().feedback, undefined);
  await settled();
});

/** A finished run over a pull request that is behind its base, with nothing else to answer: the watch brings it up to date. */
async function behindRun(during: (run: Awaited<ReturnType<typeof standoffRun>>) => void) {
  const run = await runWithFeedback(during, "readReviewState");
  run.pull.feedback = { behind: true };
  return run;
}

test("A11-356: a run that is behind its base has the base merged into its pull request by the watch (the control of the next test)", async () => {
  const run = await behindRun(() => undefined);
  await run.pool.watchFeedback();
  assert.equal(run.host.branchUpdates.asked.length, 1);
  await settled();
});

test("A11-356: a run whose worker started while the watch looked at its reviewer has no base merged into the branch the worker is editing", async () => {
  const run = await behindRun(startRunning);
  await run.pool.watchFeedback();
  assert.deepEqual(run.host.branchUpdates.asked, []);
  await settled();
});
