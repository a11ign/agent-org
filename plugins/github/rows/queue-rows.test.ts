// no-token: none -- `run` answers from a recorded table or a stub: no GitHub CLI runs
/**
 * A11-160, step 9: THE QUEUE SECTION'S READS AND ITS ONE WRITE, in GitHub's own words. The trunk sweep, the stalled-queue report, the org watch, the red-trunk reading and the queue table DECIDE what a count, a run list, a
 * pool or a queue seat means and what to do when a read is refused; their tests run on the fake code host (`src/packaging/trunk-sweep.test.ts`, `src/outside-nightly.test.ts`, `src/trunk-red.test.ts`,
 * `src/packaging/trunk-revert.test.ts`, `src/packaging/queue-table.test.ts`, ...). What the argument lists say, which `--jq` filter selects what, how a raw answer is parsed and which refusals throw are the operations', and are
 * held here with a `run` that records the call and answers a table. The argument lists are copied from the callers as they were BEFORE the move (`execFileSync("gh", ...)` in each), so a changed command fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RowsHelpers, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import { createRows } from "./index.ts";
import { QUEUE_QUERY } from "./queue-rows.ts";
import { GRAPHQL_POOL_PROBE } from "./graphql-pool-probe.ts";
import { recording } from "./recording-run.test.support.ts";

const rows = (own?: RowsRun) => createRows(() => rowsReadHelpers() as unknown as RowsHelpers, own === undefined ? undefined : { own, queue: own });
const REPO = "a11ign/a11ign";
const SHA = "a".repeat(40);
const refusal = (stderr: string) => Object.assign(new Error(`Command failed: gh\n${stderr}`), { status: 1, stderr });

// --- the trunk sweep and the table's trunk line -------------------------------------------------------------------------------------------

test("mainShaOf: the tip of `main` through `--jq .sha`, trimmed; a refusal throws", () => {
  const { run, asked } = recording("abc1234\n");
  assert.equal(rows().mainShaOf({ repo: REPO, run }), "abc1234");
  assert.deepEqual(asked, [["api", `repos/${REPO}/commits/main`, "--jq", ".sha"]]);
  assert.throws(() => rows().mainShaOf({ repo: REPO, run: recording(refusal("HTTP 502")).run }), /HTTP 502/);
});

test("checkRunTotalOf: `total_count` of the commit's check runs as a number; an answer that is not one is NaN, which the caller must not read as zero", () => {
  const { run, asked } = recording("3\n");
  assert.equal(rows().checkRunTotalOf({ repo: REPO, sha: SHA, run }), 3);
  assert.deepEqual(asked, [["api", `repos/${REPO}/commits/${SHA}/check-runs`, "--jq", ".total_count"]]);
  assert.equal(rows().checkRunTotalOf({ repo: REPO, sha: SHA, run: recording("0\n").run }), 0, "zero is an answer");
  assert.ok(Number.isNaN(rows().checkRunTotalOf({ repo: REPO, sha: SHA, run: recording("null\n").run })));
  assert.throws(() => rows().checkRunTotalOf({ repo: REPO, sha: SHA, run: recording(refusal("HTTP 404")).run }), /HTTP 404/);
});

test("dispatchWorkflow: `gh workflow run <file> --repo <repo>` and nothing else (no ref: the default branch is main), and a refused dispatch throws", () => {
  const { run, asked } = recording("");
  assert.equal(rows().dispatchWorkflow({ repo: REPO, workflow: "trunk.yml", run }), undefined);
  assert.deepEqual(asked, [["workflow", "run", "trunk.yml", "--repo", REPO]]);
  assert.throws(() => rows().dispatchWorkflow({ repo: REPO, workflow: "trunk.yml", run: recording(refusal("HTTP 422")).run }), /HTTP 422/);
});

test("checkoutWorkflowRunsOf: the newest runs of a workflow in the repository of the working directory (no `--repo`), `--workflow=<file>` as ONE argument; a list or null, a refusal throws", () => {
  const listing = [{ headSha: SHA, conclusion: "success", status: "completed", databaseId: 7 }];
  const { run, asked } = recording(listing);
  assert.deepEqual(rows().checkoutWorkflowRunsOf({ workflow: "trunk.yml", limit: 20, run }), listing);
  assert.deepEqual(asked, [["run", "list", "--workflow=trunk.yml", "--limit", "20", "--json", "headSha,conclusion,status,databaseId"]]);
  assert.equal(rows().checkoutWorkflowRunsOf({ workflow: "trunk.yml", limit: 20, run: recording({}).run }), null, "an answer that is not a list");
  assert.throws(() => rows().checkoutWorkflowRunsOf({ workflow: "trunk.yml", limit: 20, run: recording("not json").run }), SyntaxError);
  assert.throws(() => rows().checkoutWorkflowRunsOf({ workflow: "trunk.yml", limit: 20, run: recording(refusal("HTTP 502")).run }), /HTTP 502/);
});

// --- the stalled-queue report and the org watch -------------------------------------------------------------------------------------------

test("openMainPullRollupsOf: the open pull requests against main, the newest hundred, with the fields the report reads, parsed as the listing answers them", () => {
  const listing = [{ number: 5, headRefOid: SHA, autoMergeRequest: { enabledAt: "2026-10-01T00:00:00Z" }, statusCheckRollup: [], isDraft: false }];
  const { run, asked } = recording(`${JSON.stringify(listing)}\n`);
  assert.deepEqual(rows().openMainPullRollupsOf({ repo: REPO, run }), listing);
  assert.deepEqual(asked, [["pr", "list", "--repo", REPO, "--state", "open", "--base", "main", "--limit", "100", "--json", "number,headRefOid,autoMergeRequest,statusCheckRollup,isDraft"]]);
  assert.throws(() => rows().openMainPullRollupsOf({ repo: REPO, run: recording("not json").run }), SyntaxError);
  assert.throws(() => rows().openMainPullRollupsOf({ repo: REPO, run: recording(refusal("HTTP 502")).run }), /HTTP 502/);
});

test("workflowRunsOnMain: the page of runs on main of the workflow FILE, as `workflow_runs`; an answer with none is an empty list; a refusal and a non-JSON answer throw", () => {
  const runs = [{ id: 1, conclusion: "failure", created_at: "2026-10-01T00:00:00Z" }];
  const { run, asked } = recording({ total_count: 1, workflow_runs: runs });
  assert.deepEqual(rows().workflowRunsOnMain({ repo: REPO, workflow: "trunk.yml", perPage: 20, run }), runs);
  assert.deepEqual(asked, [["api", `repos/${REPO}/actions/workflows/trunk.yml/runs?branch=main&per_page=20`]]);
  assert.deepEqual(rows().workflowRunsOnMain({ repo: REPO, workflow: "trunk.yml", perPage: 20, run: recording({}).run }), [], "no list in the answer: nothing, and the caller must treat an empty page as unknown");
  assert.throws(() => rows().workflowRunsOnMain({ repo: REPO, workflow: "trunk.yml", perPage: 20, run: recording("<html>").run }), SyntaxError);
  assert.throws(() => rows().workflowRunsOnMain({ repo: REPO, workflow: "trunk.yml", perPage: 20, run: recording(refusal("HTTP 502")).run }), /HTTP 502/);
});

// --- the red-trunk reading ---------------------------------------------------------------------------------------------------------------

test("trunkRunsOf: a GET of the workflow's runs on main with ONE `-f` per filter and ten to a page; the primary's asks no event at all", () => {
  const runs = [{ id: 1, head_sha: SHA, status: "completed", conclusion: "success" }];
  const { run, asked } = recording({ total_count: 1, workflow_runs: runs });
  assert.deepEqual(rows().trunkRunsOf({ repo: REPO, workflow: "trunk.yml", eventFilter: null, run }), runs);
  assert.deepEqual(asked[0], ["api", "--method", "GET", `repos/${REPO}/actions/workflows/trunk.yml/runs`, "-f", "branch=main", "-f", "per_page=10"], "no `event=`, and `trunk.yml`");
  assert.deepEqual(rows().trunkRunsOf({ repo: "a11ign/lab", workflow: "ci.yml", eventFilter: "event=schedule", run }), runs);
  assert.deepEqual(asked[1], ["api", "--method", "GET", "repos/a11ign/lab/actions/workflows/ci.yml/runs", "-f", "branch=main", "-f", "event=schedule", "-f", "per_page=10"]);
});

test("trunkRunsOf: an answer that carries no run list is null (the workflow exists, or it is not about one), JSON null and a refusal throw -- with what gh printed, so the caller can tell a 404 from a 403", () => {
  assert.equal(rows().trunkRunsOf({ repo: REPO, workflow: "trunk.yml", eventFilter: null, run: recording({ message: "ok" }).run }), null);
  assert.deepEqual(rows().trunkRunsOf({ repo: REPO, workflow: "trunk.yml", eventFilter: null, run: recording({ workflow_runs: [] }).run }), [], "a workflow with no runs is an empty list, not null");
  assert.throws(() => rows().trunkRunsOf({ repo: REPO, workflow: "trunk.yml", eventFilter: null, run: recording("null").run }), /answered no body/);
  assert.throws(() => rows().trunkRunsOf({ repo: REPO, workflow: "trunk.yml", eventFilter: null, run: recording("<html>").run }), SyntaxError);
  for (const stderr of ["gh: Not Found (HTTP 404)\n", "gh: Forbidden (HTTP 403)\n"]) {
    assert.throws(() => rows().trunkRunsOf({ repo: REPO, workflow: "trunk.yml", eventFilter: null, run: recording(refusal(stderr)).run }),
      (error: unknown) => (error as { stderr?: string }).stderr === stderr, "the runner's own error reaches the caller untouched");
  }
});

test("annotationsOfCheckRun: the annotations of a check run by its id (an Actions job id is its check-run id); a list or null, a refusal throws", () => {
  const annotations = [{ title: "trunk-recheck", message: "RECHECK_RESULT=pass" }];
  const { run, asked } = recording(annotations);
  assert.deepEqual(rows().annotationsOfCheckRun({ repo: REPO, checkRunId: 503, run }), annotations);
  assert.deepEqual(asked, [["api", `repos/${REPO}/check-runs/503/annotations`]]);
  assert.equal(rows().annotationsOfCheckRun({ repo: REPO, checkRunId: "503", run: recording({ message: "Not Found" }).run }), null, "an answer that is not a list is null, not an empty list");
  assert.throws(() => rows().annotationsOfCheckRun({ repo: REPO, checkRunId: 503, run: recording(refusal("HTTP 403")).run }), /HTTP 403/);
});

test("originPullOfCommit: the first pull request GitHub associates with the commit, with its title and the NAMES of its labels; none, and an answer that is not a list, are null", () => {
  const pulls = [{ number: 2372, title: "a change that broke the quickstart", labels: [{ name: "session:worker-tooling" }, { name: "hold:ceo" }] }, { number: 9, title: "later", labels: [] }];
  const { run, asked } = recording(pulls);
  assert.deepEqual(rows().originPullOfCommit({ repo: REPO, sha: SHA, run }), { number: 2372, title: "a change that broke the quickstart", labels: ["session:worker-tooling", "hold:ceo"] });
  assert.deepEqual(asked, [["api", `repos/${REPO}/commits/${SHA}/pulls`]]);
  assert.deepEqual(rows().originPullOfCommit({ repo: REPO, sha: SHA, run: recording([{ number: 3 }]).run }), { number: 3, title: "", labels: [] }, "a pull request with no title or labels still names its number");
  assert.equal(rows().originPullOfCommit({ repo: REPO, sha: SHA, run: recording([]).run }), null);
  assert.equal(rows().originPullOfCommit({ repo: REPO, sha: SHA, run: recording({ message: "Not Found" }).run }), null);
  assert.throws(() => rows().originPullOfCommit({ repo: REPO, sha: SHA, run: recording(refusal("HTTP 502")).run }), /HTTP 502/);
});

// --- the queue table -----------------------------------------------------------------------------------------------------------------------

const restPull = (over: Record<string, unknown> = {}) => ({ number: 2239, head: { ref: "agent/x-2239", sha: "b".repeat(40) }, updated_at: "2026-09-23T21:03:00Z", auto_merge: null, draft: false, labels: [], ...over });

test("openPullRowsOf: the first hundred open pull requests over REST, each read as the table reads it (branch, head, update time, draft, label names, auto-merge)", () => {
  const { run, asked } = recording([restPull({ labels: [{ name: "hold:ceo" }], auto_merge: { merge_method: "merge" } })]);
  assert.deepEqual(rows().openPullRowsOf({ repo: REPO, run }), [{ number: 2239, headRefName: "agent/x-2239", headRefOid: "b".repeat(40), updatedAt: "2026-09-23T21:03:00Z", draft: false, labels: ["hold:ceo"], auto_merge: { merge_method: "merge" } }]);
  assert.deepEqual(asked, [["api", `repos/${REPO}/pulls?state=open&per_page=100`]]);
});

test("openPullRowsOf: a listing that names no head is `?` and an empty head, and carries no draft flag is `null` -- never `false` -- and no labels is none", () => {
  const [row] = rows().openPullRowsOf({ repo: REPO, run: recording([{ number: 4, updated_at: "2026-09-23T21:03:00Z" }]).run })!;
  assert.deepEqual(row, { number: 4, headRefName: "?", headRefOid: "", updatedAt: "2026-09-23T21:03:00Z", draft: null, labels: [], auto_merge: null });
});

test("openPullRowsOf: an answer that is not a list is null (not an empty list of pull requests), a refusal and a non-JSON answer throw", () => {
  assert.equal(rows().openPullRowsOf({ repo: REPO, run: recording({ message: "Not Found" }).run }), null);
  assert.throws(() => rows().openPullRowsOf({ repo: REPO, run: recording("<html>").run }), SyntaxError);
  assert.throws(() => rows().openPullRowsOf({ repo: REPO, run: recording(refusal("REST down")).run }), /REST down/);
});

test("pullQueueStatesOf: ONE GraphQL request for the queue seat of every open pull request, with the exported query, the owner and the name apart, and the nodes cut out by `--jq`", () => {
  const nodes = [{ number: 2239, autoMergeRequest: null, mergeQueueEntry: { state: "AWAITING_CHECKS", position: 1 } }];
  const { run, asked } = recording(nodes);
  assert.deepEqual(rows().pullQueueStatesOf({ repo: "x/y", run }), nodes);
  assert.deepEqual(asked, [["api", "graphql", "-f", `query=${QUEUE_QUERY}`, "-f", "o=x", "-f", "r=y", "--jq", ".data.repository.pullRequests.nodes"]]);
  assert.match(QUEUE_QUERY, /mergeQueueEntry/, "that query carries the queue field, which REST cannot");
  assert.match(QUEUE_QUERY, /autoMergeRequest/, "and the auto-merge request, so a single node answers whether a pull request is armed");
  assert.match(QUEUE_QUERY, /pullRequests\(states:OPEN,first:100\)/);
});

test("pullQueueStatesOf: an answer that is not a list is null; an exhausted pool and a non-JSON answer throw -- an empty list says nobody is queued", () => {
  assert.equal(rows().pullQueueStatesOf({ repo: REPO, run: recording("null").run }), null);
  assert.deepEqual(rows().pullQueueStatesOf({ repo: REPO, run: recording([]).run }), [], "nobody is queued is an answer");
  assert.throws(() => rows().pullQueueStatesOf({ repo: REPO, run: recording(refusal("GraphQL pool exhausted")).run }), /pool exhausted/);
  assert.throws(() => rows().pullQueueStatesOf({ repo: REPO, run: recording("<html>").run }), SyntaxError);
});

test("checkRunBriefsOf: every page of the commit's check runs, cut to a line each by `--jq`; a line that is not JSON is left out; a refusal throws", () => {
  const { run, asked } = recording([{ name: "gate", conclusion: "failure", completedAt: "2026-10-02T08:00:00Z" }, "not json", "", { name: "docs", conclusion: null, completedAt: null }]
    .map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n");
  assert.deepEqual(rows().checkRunBriefsOf({ repo: REPO, sha: SHA, run }), [
    { name: "gate", conclusion: "failure", completedAt: "2026-10-02T08:00:00Z" }, { name: "docs", conclusion: null, completedAt: null }]);
  assert.deepEqual(asked, [["api", `repos/${REPO}/commits/${SHA}/check-runs`, "--paginate", "--jq", ".check_runs[] | {name, conclusion, completedAt: .completed_at}"]]);
  assert.deepEqual(rows().checkRunBriefsOf({ repo: REPO, sha: SHA, run: recording("").run }), [], "a commit with no check runs is an empty list");
  assert.throws(() => rows().checkRunBriefsOf({ repo: REPO, sha: SHA, run: recording(refusal("check-runs refused")).run }), /check-runs refused/);
});

// --- the API budget (moved from `src/packaging/queue-table.test.ts`, #1405) -------------------------------------------------------------------

/** A `gh api ... -i` response: the rate-limit headers, a blank line, then the body. */
const headers = (remaining: number, limit = 5000) => `HTTP/2.0 200 OK\nX-Ratelimit-Limit: ${limit}\nX-Ratelimit-Remaining: ${remaining}\n\n{}`;

test("#1405 apiBudgetOf reads both pools through the given run, with the argv the live call used", () => {
  const { run, asked } = recording((args: string[]) => headers(args[1] === "graphql" ? 4990 : 4000));
  const budget = rows().apiBudgetOf({ repo: REPO, run });
  assert.deepEqual(asked, [
    ["api", `repos/${REPO}`, "-i", "--jq", ".name"],
    ["api", "graphql", "-f", "query=query { viewer { login } }", "-i"],
  ], "one call per pool, each of its own kind -- core through REST, graphql through GraphQL");
  assert.deepEqual(asked[1], [...GRAPHQL_POOL_PROBE], "the graphql pool is read with the one probe the plugin names (`graphql-pool-probe.ts`), not a copy of its text");
  // `resource` and `resetAt` joined the shape in #2003, when `poolFromHeaders` moved to `api-pool.ts` so `work-gate.ts`'s refusal could name WHICH pool refused and WHEN it comes back in absolute terms. This fixture
  // sends neither header, so both read `null` -- which is the honest answer and not a zero.
  assert.deepEqual(budget, {
    core: { remaining: 4000, limit: 5000, used: 1000, resetInMinutes: null, resource: null, resetAt: null },
    graphql: { remaining: 4990, limit: 5000, used: 10, resetInMinutes: null, resource: null, resetAt: null },
  });
});

test("#1405 an EXHAUSTED pool is read off the failed call's stdout -- gh exits non-zero on the 403, and the headers are still there", () => {
  const { run } = recording((args: string[]) => {
    if (args[1] !== "graphql") return headers(4000);
    throw Object.assign(new Error("gh: HTTP 403"), { stdout: headers(0) });
  });
  const budget = rows().apiBudgetOf({ repo: REPO, run });
  assert.equal(budget?.graphql?.remaining, 0, "0 remaining, not UNREADABLE: the outage this line exists to report");
  assert.equal(budget?.graphql?.used, 5000);
});

test("#1405 a call that fails with no headers is UNREADABLE, and both failing is null -- never a zero, and it never throws", () => {
  const fail = (): never => { throw Object.assign(new Error("gh: could not connect"), { stdout: "" }); };
  assert.equal(rows().apiBudgetOf({ repo: REPO, run: fail }), null);
  const oneOnly = rows().apiBudgetOf({ repo: REPO, run: (args) => (args[1] === "graphql" ? fail() : headers(4000)) });
  assert.equal(oneOnly?.graphql, null);
  assert.equal(oneOnly?.core?.remaining, 4000, "the positive control: the readable pool beside it is still read");
});

// --- the runner a caller that hands none gets ----------------------------------------------------------------------------------------------

test("an operation whose caller hands no run asks the plugin's own `gh`, with the same argument list; one that hands a run never touches it", () => {
  const own = recording("abc1234\n");
  assert.equal(rows(own.run).mainShaOf({ repo: REPO }), "abc1234");
  assert.deepEqual(own.asked, [["api", `repos/${REPO}/commits/main`, "--jq", ".sha"]]);
  const given = recording("def5678\n");
  assert.equal(rows(own.run).mainShaOf({ repo: REPO, run: given.run }), "def5678");
  assert.equal(own.asked.length, 1, "the caller's run answered, so the plugin's own was not asked");
});
