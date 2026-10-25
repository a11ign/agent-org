// no-token: none -- pure functions over a queue built with the board's own transitions
// module: the pull requests the board opened for a ticket and has not seen settle (A11-286)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost, fakePullUrl } from "../plugins/fakes/code-host.ts";
import { boardPullsOf, keptPullsOf, unwatchedPullsOf } from "./kept-pulls.ts";
import { pullReviewsOf } from "./pool-reviewers.ts";
import type { PoolContext } from "./pool-context.ts";
import type { PullRead } from "./board-view/pull-review-state.ts";
import { finishedWith, ticketOf } from "./kept-pulls-fixture.ts";
import { emptyQueue } from "./queue.ts";
import { enqueue, find, remove, retry, type Entry, type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { queueNextStep } from "./queue/queue-next-step.ts";
import { finish, markRunning, markStarting, recordPullStates } from "./queue/queue-transitions.ts";

const NOW = 1_000;
const NONE: ReadonlySet<string> = new Set();
const STEP_ONE = fakePullUrl("a11ign/agent-org", 1921);
const OTHER = fakePullUrl("a11ign/control", 7);
const urls = (pulls: readonly { url: string }[]): string[] => pulls.map(({ url }) => url);

/** A11-1 queued, run, and finished on a ready pull request, #1921: step 1 of its plan, partial. */
const stepOneFinished = (): Queue => finishedWith("A11-1", { kind: "ready-pr", prs: [{ repo: "agent-org", url: STEP_ONE }] }, NOW);

test("A11-286: a step's pull request is kept while the next step is queued, and while it runs", () => {
  const finished = stepOneFinished();
  const queued = queueNextStep(finished, "A11-1", { step: 1, of: 2, prs: [STEP_ONE] }, NOW + 1);
  assert.deepEqual(find(queued, "A11-1")?.phase, "queued", "the next step replaced the finished run");
  assert.equal(find(queued, "A11-1")?.outcome, undefined, "and it holds no pull request of its own");
  assert.deepEqual(urls(keptPullsOf(queued, "A11-1", NONE)), [STEP_ONE]);
  assert.deepEqual(keptPullsOf(queued, "A11-1", NONE)[0], { repo: "agent-org", url: STEP_ONE }, "the repository is the name the pull request's address carries");
  const running = markRunning(markStarting(queued, "A11-1", NOW + 2), "A11-1", "w1", "w1:p1");
  assert.deepEqual(urls(keptPullsOf(running, "A11-1", NONE)), [STEP_ONE], "and the run in its workspace keeps it");
  assert.deepEqual(urls(unwatchedPullsOf(running, find(running, "A11-1")!, NONE)), [STEP_ONE], "no finished run's watch reads it");
});

test("A11-286: a re-queue keeps the ticket's pull requests: Remove then Queue, a retry, and a run that ended needs-human", () => {
  const finished = stepOneFinished();
  const needsHuman = finish(finished, "A11-1", { kind: "needs-human", reason: "which colour?", escalation: "reserved" }, NOW + 1);
  assert.deepEqual(urls(keptPullsOf(needsHuman, "A11-1", NONE)), [STEP_ONE], "a run that ended needs-human keeps the pull request an earlier outcome opened");
  assert.deepEqual(urls(unwatchedPullsOf(needsHuman, find(needsHuman, "A11-1")!, NONE)), [STEP_ONE], "though its outcome names none, so the watch of a finished run does not read it");

  const retried = retry(needsHuman, "A11-1", NOW + 2);
  assert.deepEqual([find(retried, "A11-1")?.phase, find(retried, "A11-1")?.outcome], ["queued", undefined]);
  assert.deepEqual(urls(keptPullsOf(retried, "A11-1", NONE)), [STEP_ONE], "a retry keeps it");

  const removed = remove(retried, "A11-1", NOW + 3);
  assert.equal(find(removed, "A11-1"), undefined, "Remove takes the entry off");
  const again = enqueue(removed, [ticketOf("A11-1")], { model: "sonnet", effort: "high" }, NOW + 4);
  assert.deepEqual(urls(keptPullsOf(again, "A11-1", NONE)), [STEP_ONE], "and a new Queue of the ticket is watched for it again, as a11ign/agent-org#1921 was not");
});

test("A11-286: a merged event, the entry's pull request states and a read that found it settled each drop a pull request", () => {
  const finished = stepOneFinished();
  const queued = queueNextStep(finished, "A11-1", { step: 1, of: 2, prs: [STEP_ONE] }, NOW + 1);
  assert.deepEqual(urls(keptPullsOf(queued, "A11-1", new Set([STEP_ONE]))), [], "a read of the code host found it merged or closed");
  assert.deepEqual(urls(keptPullsOf(queued, "A11-1", new Set([OTHER]))), [STEP_ONE], "another pull request's settling leaves it");

  const logged = recordPullStates(finished, new Map([["A11-1", { [STEP_ONE]: "merged" as const }]]), NOW + 2);
  assert.deepEqual(urls(keptPullsOf(logged, "A11-1", NONE)), [], "a merge the tracker's read saw is logged, and the entry's state says merged");
  const states = { ...logged, entries: logged.entries.map((entry): Entry => ({ ...entry, pullStates: { [STEP_ONE]: "closed" } })), runLog: {} };
  assert.deepEqual(urls(keptPullsOf(states, "A11-1", NONE)), [], "the entry's own state says closed");
});

test("A11-286: each pull request is kept once, whether the entry holds it, the log opened it, or both", () => {
  const finished = stepOneFinished();
  assert.deepEqual(urls(keptPullsOf(finished, "A11-1", NONE)), [STEP_ONE], "held by the outcome and opened in the log, kept once");
  const second = finish(finished, "A11-1", { kind: "ready-pr", prs: [{ repo: "control", url: OTHER }] }, NOW + 1);
  assert.deepEqual(urls(keptPullsOf(second, "A11-1", NONE)).sort(), [OTHER, STEP_ONE].sort(), "the later outcome's pull request and the earlier one both");
  assert.deepEqual(urls(unwatchedPullsOf(second, find(second, "A11-1")!, NONE)), [STEP_ONE], "the watch of a finished run reads the pull request its outcome names, and no other");
});

test("A11-286: the board's pulls map lists every kept pull request of every ticket on the queue, each once, and none of a ticket that is off it", () => {
  const first = queueNextStep(stepOneFinished(), "A11-1", { step: 1, of: 2, prs: [STEP_ONE] }, NOW + 1);
  const second = enqueue(first, [ticketOf("A11-2")], { model: "sonnet", effort: "high" }, NOW + 2);
  const withOther = finish(second, "A11-2", { kind: "ready-pr", prs: [{ repo: "control", url: OTHER }] }, NOW + 3);
  assert.deepEqual(urls(boardPullsOf(withOther, NONE)).sort(), [OTHER, STEP_ONE].sort());
  assert.deepEqual(urls(boardPullsOf(withOther, new Set([OTHER]))), [STEP_ONE], "a settled one is left out");
  assert.deepEqual(urls(boardPullsOf(emptyQueue(3), NONE)), []);
});

test("A11-286: the pulls map lists the kept pull requests in all three reviewer states, a pull request no run holds included", () => {
  const queue = queueNextStep(stepOneFinished(), "A11-1", { step: 1, of: 2, prs: [STEP_ONE] }, NOW + 1);
  const mapOf = (reviewerState: PoolContext["reviewerState"], pullReads: Map<string, PullRead> = new Map()) =>
    pullReviewsOf({ reviewerState, store: { get: () => queue }, settledPulls: NONE, pullReads, offPulls: new Set<string>() } as unknown as PoolContext);
  assert.deepEqual(mapOf("none"), { [STEP_ONE]: "awaiting your review" });
  assert.deepEqual(mapOf("off-required"), { [STEP_ONE]: "waiting on the reviewer (off)" });
  assert.deepEqual(mapOf("on"), { [STEP_ONE]: "not read yet" }, "the reviewer has not read it, and the map still lists it");
  const read = { head: "h", verdict: "approved" } as unknown as PullRead;
  assert.notEqual(mapOf("on", new Map([[STEP_ONE, read]]))[STEP_ONE], "not read yet", "a pull request the reviewer has read reads as its review does");
});
