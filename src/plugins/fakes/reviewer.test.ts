// no-token: none -- the fake reviewer starts nothing: a reviewer is a record of a head
import { test } from "node:test";
import assert from "node:assert/strict";
import { runReviewerConformance } from "../conformance/reviewer.ts";
import { ContractError } from "../conformance/suite.ts";
import type { Reviewer } from "../contracts/reviewer.ts";
import { createFakeReviewer } from "./reviewer.ts";

const probe = { ref: { pr: "https://github.com/owner/repo/pull/7", head: "abc123" } };

test("the fake reviewer passes the reviewer contract suite, and the checks that ran are the ones asserted", async () => {
  const { passed, skipped } = await runReviewerConformance(createFakeReviewer(), probe);
  assert.deepEqual(passed, [
    "shape", "load resolves and refusal says why it cannot start, or null", "live is false before a reviewer is started", "settled is gone when there is no reviewer for the head",
    "start answers a label, or a refusal naming why", "verdictFileOf is a path or null", "repostVerdict and reprompt answer, and never throw for a refusal",
    "close answers closed, gone or busy, or a refusal", "retire answers retired, or a refusal, and lists the pull request no more",
  ]);
  assert.deepEqual(skipped, []);
});

test("a reviewer whose host refuses must refuse start, and the fake does", async () => {
  const fake = createFakeReviewer("codex is not logged in");
  await runReviewerConformance(fake, probe);
  assert.equal(fake.started.length, 0, "a refused host starts nothing");
  const silent: Reviewer = { ...fake, start: () => ({ label: "started anyway" }) };
  await assert.rejects(runReviewerConformance(silent, probe), (error: unknown) => error instanceof ContractError && error.concern === "reviewer"
    && error.failures.map(({ check }) => check).join() === "start answers a label, or a refusal naming why");
});

test("a reviewer that says it is live for a head it was never started for fails by name", async () => {
  const fake = createFakeReviewer();
  const eager: Reviewer = { ...fake, live: () => true };
  await assert.rejects(runReviewerConformance(eager, probe), (error: unknown) => error instanceof ContractError
    && error.failures[0].check === "live is false before a reviewer is started");
});

test("the fake closes a reviewer only once its turn has ended, and busy before", async () => {
  const fake = createFakeReviewer();
  await fake.load();
  assert.deepEqual(fake.start(probe.ref), { label: "fake-reviewer-1" });
  assert.deepEqual(fake.close(probe.ref), { state: "busy" });
  fake.wrote(probe.ref, "/tmp/verdict.md");
  assert.equal(fake.verdictFileOf(probe.ref), "/tmp/verdict.md");
  assert.deepEqual(fake.close(probe.ref), { state: "closed" });
  assert.equal(fake.live(probe.ref), false);
});
