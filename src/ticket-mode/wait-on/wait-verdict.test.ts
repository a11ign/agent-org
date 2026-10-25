// no-token: none -- the verdict is pure
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CiRun } from "../../plugins/contracts/code-host.ts";
import { judgeWaits, lineOf } from "./wait-verdict.ts";
import type { JobFacts, Reading, Settled } from "./wait-types.ts";

const PULL = "https://github.com/a11ign/agent-org/pull/1872";
const job = (status: Settled, over: Partial<JobFacts> = {}): Reading => ({
  wait: { kind: "fleetJob", id: "fj-1" }, status,
  job: { state: status === "finished" ? "done" : status === "failed" ? "failed" : "running", reason: status === "failed" ? "box 14 went offline" : null, results: status === "finished" ? "/srv/fleet/jobs/fj-1" : null, progress: { done: 4, total: 6 }, estimatedFinish: null, ...over },
});
const ci = (status: Settled, over: Partial<CiRun> = {}): Reading => ({
  wait: { kind: "ciRun", repository: "a11ign/x", runId: 9 }, status,
  run: { status: status === "pending" ? "in_progress" : "completed", conclusion: status === "finished" ? "success" : status === "failed" ? "failure" : null, url: "https://github.com/a11ign/x/actions/runs/9", name: "ci", jobs: { done: 3, total: 5 }, ...over },
});
const pull = (status: Settled, state: "OPEN" | "MERGED" | "CLOSED", review: "APPROVED" | "CHANGES_REQUESTED" | null = null, until: "merged" | "reviewed" = "merged"): Reading => ({ wait: { kind: "pullRequest", url: PULL, until }, status, pull: { state, review } });
const ticket = (status: Settled, stateType: string): Reading => ({ wait: { kind: "ticket", key: "A11-243", until: "done" }, status, stateType });
const unreadable: Reading = { wait: { kind: "fleetJob", id: "fj-2" }, status: "unreadable", why: "fleet job status fj-2 did not answer in 30 s" };

test("A11-245: when every item has finished the wait is finished, and says what happened to each", () => {
  const verdict = judgeWaits([job("finished"), ci("finished"), pull("finished", "MERGED"), ticket("finished", "completed")]);
  assert.equal(verdict.outcome, "finished");
  assert.deepEqual(verdict.lines, [
    "fleet job fj-1 is done; its results are at /srv/fleet/jobs/fj-1 (fleet job fetch fj-1 --to <dir> copies them)",
    "CI run a11ign/x#9 (ci) concluded success: https://github.com/a11ign/x/actions/runs/9",
    `pull request ${PULL} was merged`, "ticket A11-243 is done",
  ]);
  assert.equal(verdict.ended.length, 4);
});

test("A11-245: while one item is still going the wait is pending, and the lines are the progress of the items still going", () => {
  const verdict = judgeWaits([job("pending"), ci("finished")]);
  assert.equal(verdict.outcome, "pending");
  assert.deepEqual(verdict.lines, ["fleet job fj-1 is running, 4 of 6 pages"]);
  assert.deepEqual(verdict.ended, [ci("finished").wait], "the finished run is the one that has ended");
});

test("A11-245: one failed item fails the wait at once, even with the others pending, and its reason comes first", () => {
  const verdict = judgeWaits([job("pending"), ci("failed")]);
  assert.equal(verdict.outcome, "failed");
  assert.equal(verdict.outcome === "failed" && verdict.reason, "CI run a11ign/x#9 (ci) concluded failure: https://github.com/a11ign/x/actions/runs/9");
  assert.equal(verdict.lines[0], verdict.outcome === "failed" ? verdict.reason : "");
  assert.equal(verdict.lines[1], "fleet job fj-1 is running, 4 of 6 pages");
});

test("A11-245: a failed fleet job is woken with the job service's reason, and a cancelled one says so", () => {
  const failed = judgeWaits([job("failed")]);
  assert.equal(failed.outcome === "failed" && failed.reason, "fleet job fj-1 failed: box 14 went offline");
  assert.equal(lineOf(job("failed", { state: "cancelled", reason: "the job was cancelled" })), "fleet job fj-1 was cancelled: the job was cancelled");
});

test("A11-245: an item that could not be read is pending, never a failure, and the line says it could not be read", () => {
  const verdict = judgeWaits([job("finished"), unreadable]);
  assert.equal(verdict.outcome, "pending");
  assert.deepEqual(verdict.lines, ["fleet job fj-2: the board could not read it (fleet job status fj-2 did not answer in 30 s)"]);
  assert.equal(judgeWaits([unreadable]).outcome, "pending");
});

test("A11-245: a wait with no items is pending, because none was declared", () => {
  assert.equal(judgeWaits([]).outcome, "pending");
});

test("A11-245: a pull request, a ticket and a CI run in each state read as a sentence naming the item and what happened", () => {
  assert.equal(lineOf(pull("failed", "CLOSED")), `pull request ${PULL} was closed without merging`);
  assert.equal(lineOf(pull("pending", "OPEN")), `pull request ${PULL} is still open`);
  assert.equal(lineOf(pull("pending", "OPEN", null, "reviewed")), `pull request ${PULL} is still open and has no review on its current head`);
  assert.equal(lineOf(pull("finished", "OPEN", "APPROVED", "reviewed")), `pull request ${PULL} has an approving review on its current head`);
  assert.equal(lineOf(pull("finished", "OPEN", "CHANGES_REQUESTED", "reviewed")), `pull request ${PULL} has a review asking for changes on its current head`);
  assert.equal(lineOf(ticket("failed", "canceled")), "ticket A11-243 is canceled");
  assert.equal(lineOf(ticket("pending", "started")), "ticket A11-243 is not done (started)");
  assert.match(lineOf(ci("pending", { status: "queued", jobs: null })), /^CI run a11ign\/x#9 \(ci\) is queued: /);
  assert.match(lineOf(ci("pending")), /is running, 3 of 5 jobs done:/);
  assert.match(lineOf(ci("failed", { conclusion: "timed_out" })), /concluded timed_out/);
});

test("A11-245: a finished job with no results location says nothing of one", () => {
  assert.equal(lineOf(job("finished", { results: null })), "fleet job fj-1 is done");
});
