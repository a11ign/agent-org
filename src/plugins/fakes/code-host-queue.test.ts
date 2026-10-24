// no-token: none -- the fake acts on a world held in memory; nothing here reaches GitHub
/**
 * A11-160 (step 9): THE FAKE CODE HOST'S OPERATIONS FOR THE QUEUE SECTION. Core's tests of the trunk sweep, the stalled-queue report, the org watch, the red-trunk reading and the queue table run on this fake, so these cases hold
 * what they rely on: the open pull requests are the world's, each read as the table reads it; a queue seat is the merge queue's entry for the pull request; a commit's check runs are seeded or those of the pull request whose
 * head it is; the runs of a workflow answer as seeded and a workflow the world was never told about answers GitHub's 404; a seeded `Error` is a refused read of just that one thing; and a dispatch records itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "./code-host.ts";
import type { FakeRowPull } from "./code-host-rows.ts";
import { notFound, trunkRunsKey } from "./code-host-queue.ts";

const refused = (): string => {
  throw new Error("the fake acts on its own state: no run is made");
};
const REPO = "o/r";

const pull = (number: number, over: Partial<FakeRowPull> = {}): FakeRowPull => ({ number, body: "", headRefName: `agent/p-${number}`, labels: [], isDraft: false, armed: false, merged: false, mergedAt: null,
  createdAt: "2026-10-01T00:00:00Z", comments: [], ...over });

test("the open pull requests are the world's, read as the table reads them: head, update time, draft flag, label names, auto-merge; a merged or closed one is left out", () => {
  const host = createFakeCodeHost();
  const { pulls } = host.rowsWorld;
  pulls.set(1, pull(1, { headRefOid: "a".repeat(40), updatedAt: "2026-10-02T00:00:00Z", labels: ["hold:ceo"], armed: true, isDraft: true }));
  pulls.set(2, pull(2));
  pulls.set(3, pull(3, { merged: true, mergedAt: "2026-10-01T01:00:00Z" }));
  pulls.set(4, pull(4, { closedAt: "2026-10-01T01:00:00Z" }));
  assert.deepEqual(host.rows!.openPullRowsOf({ repo: REPO, run: refused }), [
    { number: 1, headRefName: "agent/p-1", headRefOid: "a".repeat(40), updatedAt: "2026-10-02T00:00:00Z", draft: true, labels: ["hold:ceo"], auto_merge: { merge_method: "merge" } },
    { number: 2, headRefName: "agent/p-2", headRefOid: "head-2", updatedAt: "2026-10-01T00:00:00Z", draft: false, labels: [], auto_merge: null },
  ]);
  assert.deepEqual(host.rows!.openMainPullRollupsOf({ repo: REPO, run: refused }).map((p) => [p.number, p.autoMergeRequest !== null, p.isDraft]), [[1, true, true], [2, false, false]]);
});

test("a queue seat is the merge queue's entry for the pull request, none for one that is not queued, and a queue that cannot be read refuses the read", () => {
  const host = createFakeCodeHost();
  host.rowsWorld.pulls.set(1, pull(1));
  host.rowsWorld.pulls.set(2, pull(2, { armed: true }));
  host.rowsWorld.queue.entries = [{ state: "AWAITING_CHECKS", enqueuedAt: "2026-10-01T00:00:00Z", position: 1, headSha: null, pull: 1, pullId: "PR_1" }];
  assert.deepEqual(host.rows!.pullQueueStatesOf({ repo: REPO, run: refused }), [
    { number: 1, autoMergeRequest: null, mergeQueueEntry: { state: "AWAITING_CHECKS", position: 1 } },
    { number: 2, autoMergeRequest: { enabledAt: "2026-01-01T00:00:00Z" }, mergeQueueEntry: null },
  ]);
  host.rowsWorld.queue.entries = new Error("GraphQL pool exhausted");
  assert.throws(() => host.rows!.pullQueueStatesOf({ repo: REPO, run: refused }), /pool exhausted/);
});

test("a commit's check runs are the seeded ones, else those of the pull request whose head it is, else none; a seeded error refuses just that commit", () => {
  const host = createFakeCodeHost();
  const { tail, pulls } = host.rowsWorld;
  pulls.set(1, pull(1, { headRefOid: "a".repeat(40), checkRuns: [{ id: 1, name: "gate", status: "completed", conclusion: "failure", completedAt: "2026-10-02T08:00:00Z" }] }));
  tail.queue.checks.set("b".repeat(40), [{ name: "docs", conclusion: "success", completedAt: null }]);
  tail.queue.checks.set("c".repeat(40), new Error("check-runs refused"));
  const briefs = (sha: string) => host.rows!.checkRunBriefsOf({ repo: REPO, sha, run: refused });
  assert.deepEqual(briefs("a".repeat(40)), [{ name: "gate", conclusion: "failure", completedAt: "2026-10-02T08:00:00Z" }]);
  assert.deepEqual(briefs("b".repeat(40)), [{ name: "docs", conclusion: "success", completedAt: null }]);
  assert.deepEqual(briefs("d".repeat(40)), []);
  assert.throws(() => briefs("c".repeat(40)), /check-runs refused/);
});

test("the tip of main and the check runs it carries are seeded; a tip the world holds none of is refused, and a commit with no count carries none", () => {
  const host = createFakeCodeHost();
  const { queue } = host.rowsWorld.tail;
  assert.throws(() => host.rows!.mainShaOf({ repo: REPO, run: refused }), /holds no tip of main/);
  queue.mainSha = "abc1234";
  queue.checkRunTotals.set("abc1234", 4);
  assert.equal(host.rows!.mainShaOf({ repo: REPO, run: refused }), "abc1234");
  assert.equal(host.rows!.checkRunTotalOf({ repo: REPO, sha: "abc1234", run: refused }), 4);
  assert.equal(host.rows!.checkRunTotalOf({ repo: REPO, sha: "def5678", run: refused }), 0);
  queue.checkRunTotals.set("abc1234", new Error("HTTP 502"));
  assert.throws(() => host.rows!.checkRunTotalOf({ repo: REPO, sha: "abc1234", run: refused }), /HTTP 502/);
});

test("a dispatch records the workflow and runs the test's hook as it is made; a refused one throws and is not recorded", () => {
  const host = createFakeCodeHost();
  const { queue } = host.rowsWorld.tail;
  const hooked: string[] = [];
  queue.onDispatch = (workflow) => { hooked.push(workflow); };
  host.rows!.dispatchWorkflow({ repo: REPO, workflow: "trunk.yml", run: refused });
  assert.deepEqual([queue.dispatched, hooked, host.rowsWorld.calls], [["trunk.yml"], ["trunk.yml"], [`dispatchWorkflow ${REPO} trunk.yml`]]);
  queue.dispatchRefusal = "HTTP 422";
  assert.throws(() => host.rows!.dispatchWorkflow({ repo: REPO, workflow: "trunk.yml", run: refused }), /HTTP 422/);
  assert.deepEqual(queue.dispatched, ["trunk.yml"], "the refused dispatch did not happen");
});

test("the runs of a workflow by event filter answer as seeded, null for an answer with no list, an error as a refused read, and a workflow never seeded as GitHub's 404", () => {
  const host = createFakeCodeHost();
  const { trunkRuns } = host.rowsWorld.tail.queue;
  const runs = [{ id: 1, head_sha: "a".repeat(40) }];
  trunkRuns.set(trunkRunsKey(REPO, "ci.yml", "event=push"), runs);
  trunkRuns.set(trunkRunsKey(REPO, "ci.yml", "event=schedule"), null);
  trunkRuns.set(trunkRunsKey(REPO, "trunk.yml", null), new Error("HTTP 403"));
  const read = (workflow: string, eventFilter: string | null) => host.rows!.trunkRunsOf({ repo: REPO, workflow, eventFilter, run: refused });
  assert.deepEqual(read("ci.yml", "event=push"), runs);
  assert.equal(read("ci.yml", "event=schedule"), null);
  assert.throws(() => read("trunk.yml", null), /HTTP 403/);
  assert.throws(() => read("other.yml", null), (error: unknown) => /\(HTTP 404\)/.test(String((error as Error).message)) && (error as { stderr?: string }).stderr === notFound("x").stderr);
});

test("a check run's annotations, the pull request a commit came from and a workflow's other runs are seeded, and what is not seeded is none -- an annotation list, no pull request, no runs", () => {
  const host = createFakeCodeHost();
  const { annotations, originPulls, checkoutRuns, runsOnMain } = host.rowsWorld.tail.queue;
  annotations.set("503", [{ message: "RECHECK_RESULT=pass" }]);
  originPulls.set("a".repeat(40), { number: 7, title: "a merge", labels: ["session:worker-3"] });
  originPulls.set("b".repeat(40), new Error("HTTP 502"));
  checkoutRuns.set("trunk.yml", [{ headSha: "a", databaseId: 1 }]);
  runsOnMain.set("ci.yml", [{ id: 5 }, { id: 4 }, { id: 3 }]);
  assert.deepEqual(host.rows!.annotationsOfCheckRun({ repo: REPO, checkRunId: 503, run: refused }), [{ message: "RECHECK_RESULT=pass" }]);
  assert.deepEqual(host.rows!.annotationsOfCheckRun({ repo: REPO, checkRunId: 1, run: refused }), []);
  assert.deepEqual(host.rows!.originPullOfCommit({ repo: REPO, sha: "a".repeat(40), run: refused }), { number: 7, title: "a merge", labels: ["session:worker-3"] });
  assert.equal(host.rows!.originPullOfCommit({ repo: REPO, sha: "c".repeat(40), run: refused }), null);
  assert.throws(() => host.rows!.originPullOfCommit({ repo: REPO, sha: "b".repeat(40), run: refused }), /HTTP 502/);
  assert.deepEqual(host.rows!.checkoutWorkflowRunsOf({ workflow: "trunk.yml", limit: 20, run: refused }), [{ headSha: "a", databaseId: 1 }]);
  assert.deepEqual(host.rows!.checkoutWorkflowRunsOf({ workflow: "other.yml", limit: 20, run: refused }), []);
  assert.deepEqual(host.rows!.workflowRunsOnMain({ repo: REPO, workflow: "ci.yml", perPage: 2, run: refused }), [{ id: 5 }, { id: 4 }], "the page is cut as the page size says");
  host.rowsWorld.trunkRuns = [{ id: 9 }];
  assert.deepEqual(host.rows!.workflowRunsOnMain({ repo: REPO, workflow: "trunk.yml", perPage: 20, run: refused }), [{ id: 9 }], "the trunk workflow's runs are the world's own");
});

test("the API budget is seeded, and a refused operation is named in the world's failures", () => {
  const host = createFakeCodeHost();
  assert.equal(host.rows!.apiBudgetOf({ repo: REPO, run: refused }), null, "no pool read is null, never a zero");
  const pool = { remaining: 4000, limit: 5000, used: 1000, resetInMinutes: 30 };
  host.rowsWorld.tail.queue.budget = { core: pool, graphql: null };
  assert.deepEqual(host.rows!.apiBudgetOf({ repo: REPO, run: refused }), { core: pool, graphql: null });
  host.rowsWorld.failures.set("mainShaOf", new Error("HTTP 502"));
  assert.throws(() => host.rows!.mainShaOf({ repo: REPO, run: refused }), /HTTP 502/);
});
