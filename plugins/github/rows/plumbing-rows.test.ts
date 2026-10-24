// no-token: gh -- every operation is handed a stub `run`; nothing here spawns `gh` or needs a token
/**
 * A11-160 (step 9): THE ARGUMENTS AND READINGS OF THE OPERATIONS THE TOOL-VERSION AGREEMENT, THE HOST CHECK AND THE REVIEW EVAL ASK, which core's tests of those callers used to assert over a stubbed `gh` and which are
 * the plugin's now (core's tests run on the fake code host's rows). The argument lists are copied from the callers they were moved from. The GraphQL pool's probe and the runner that never throws are held here too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ciRunLogOf, gatingCiRunOf, plumbingRowsOf, pullForReviewEvalOf, releasePublishedAtOf, restLabelNamesOf, rowForReviewEvalOf } from "./plumbing-rows.ts";
import { GRAPHQL_POOL_PROBE } from "./graphql-pool-probe.ts";

/** A `run` that records the argument list it was given and answers `answer`. */
const recording = (answer: string) => {
  const seen: string[][] = [];
  return { seen, run: (args: string[]): string => { seen.push(args); return answer; } };
};

type Run = { id: number; head_sha: string; head_branch: string; event: string; status: string; conclusion: string; created_at: string };
const run = (id: number, event: string, created_at: string, head_branch = "main"): Run => ({ id, head_sha: String(id).padStart(40, "0"), head_branch, event, status: "completed", conclusion: "success", created_at });

/** The shape that stranded the reader (#3746): the newest run on `main` itself is a `push` from long ago, and every newer run is a `merge_group` (on `gh-readonly-queue/main/...`) or a `pull_request`. */
const STRANDED: Run[] = [
  run(35362067115, "push", "2026-09-18T15:22:56Z"),
  run(37389463315, "merge_group", "2026-10-05T23:36:36Z", "gh-readonly-queue/main/pr-3732-d8952882"),
  run(37380000001, "merge_group", "2026-10-05T22:10:00Z", "gh-readonly-queue/main/pr-3727-98af2706"),
  run(37380000002, "pull_request", "2026-10-05T23:30:00Z", "agent/some-branch-3732"),
];

/** GitHub's own filtering of `actions/workflows/ci.yml/runs`, newest first: the reader's question is answered by the fixture exactly as the real endpoint would answer it. */
function answer(runs: Run[], path: string): string {
  const query = new URL(`https://x/${path}`).searchParams;
  const matching = runs
    .filter((r) => (query.get("branch") === null || r.head_branch === query.get("branch")) && (query.get("event") === null || r.event === query.get("event")) && (query.get("status") === null || r.status === query.get("status")))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return JSON.stringify({ workflow_runs: matching.slice(0, Number(query.get("per_page") ?? "30")) });
}

/** A `run` over a fixture of runs, recording the arguments it was given. */
function runsOver(runs: Run[]) {
  const seen: string[][] = [];
  return { seen, run: (args: string[]): string => { seen.push(args); return answer(runs, args[1].replace(/^repos\/[^/]+\/[^/]+\//, "")); } };
}

test("#3746 CONTROL FIRST: the fixture's population has the stranded shape, and the question the old reader asked still answers the 2026-09-18 push run", () => {
  assert.ok(new Set(STRANDED.map((r) => r.event)).size >= 2, "across at least two events");
  assert.ok(STRANDED.some((r) => r.event === "merge_group" && r.created_at > "2026-10-01"), "a merge_group run newer than every push run");
  const oldQuestion = JSON.parse(answer(STRANDED, "actions/workflows/ci.yml/runs?branch=main&status=completed&per_page=1")).workflow_runs;
  assert.deepEqual(oldQuestion.map((r: Run) => [r.id, r.event]), [[35362067115, "push"]], "the old query can only ever return the push run");
});

test("#3746: the run that gates `main` is the newest completed merge_group run, asked first, and mapped to the vocabulary core reads", () => {
  const { seen, run: ask } = runsOver(STRANDED);
  assert.deepEqual(gatingCiRunOf({ repo: "a11ign/a11ign", run: ask }), { id: 37389463315, sha: "37389463315".padStart(40, "0"), createdAt: "2026-10-05T23:36:36Z", event: "merge_group" });
  assert.deepEqual(seen, [["api", "repos/a11ign/a11ign/actions/workflows/ci.yml/runs?event=merge_group&status=completed&per_page=1"]], "one question, and the second is not asked when the first answers");
});

test("#3746: a repository with no merge queue is read by its newest completed run on `main`, after the merge_group question answered none", () => {
  const pushes = [run(5, "push", "2026-10-05T10:00:00Z"), run(4, "push", "2026-10-04T10:00:00Z"), run(3, "pull_request", "2026-10-05T11:00:00Z", "agent/x")];
  const { seen, run: ask } = runsOver(pushes);
  assert.equal(gatingCiRunOf({ repo: "o/r", run: ask })?.id, 5);
  assert.deepEqual(seen.map((args) => args[1]), ["repos/o/r/actions/workflows/ci.yml/runs?event=merge_group&status=completed&per_page=1", "repos/o/r/actions/workflows/ci.yml/runs?branch=main&status=completed&per_page=1"]);
  assert.equal(gatingCiRunOf({ repo: "o/r", run: runsOver([]).run }), null, "no run on either question is null, never an empty run");
});

test("#3746: a refused first question throws and the second is not asked; a refused second question throws too", () => {
  const seen: string[][] = [];
  assert.throws(() => gatingCiRunOf({ repo: "o/r", run: (args) => { seen.push(args); throw new Error("HTTP 502"); } }), /HTTP 502/);
  assert.equal(seen.length, 1, "a refusal is not an answer of none, so the fallback is not asked");
  assert.throws(() => gatingCiRunOf({ repo: "o/r", run: (args) => { if (args[1].includes("merge_group")) return JSON.stringify({ workflow_runs: [] }); throw new Error("HTTP 403"); } }), /HTTP 403/);
  assert.throws(() => gatingCiRunOf({ repo: "o/r", run: () => "not json" }));
});

test("a run's whole log is `run view --log`; a run GitHub says has none is the empty log, and any other refusal is thrown", () => {
  const { seen, run: ask } = recording("setup\ndone");
  assert.equal(ciRunLogOf({ repo: "a11ign/a11ign", id: 77, run: ask }), "setup\ndone");
  assert.deepEqual(seen, [["run", "view", "77", "--repo", "a11ign/a11ign", "--log"]]);
  assert.equal(ciRunLogOf({ repo: "o/r", id: 1, run: () => { throw Object.assign(new Error("Command failed"), { stderr: "failed to get run log: log not found" }); } }), "", "an expired log is an answer about the run");
  assert.equal(ciRunLogOf({ repo: "o/r", id: 1, run: () => { throw new Error("Command failed: gh run view\nfailed to get run log: log not found"); } }), "", "and so is the same words in the message");
  assert.throws(() => ciRunLogOf({ repo: "o/r", id: 1, run: () => { throw new Error("HTTP 403 rate limit"); } }), /HTTP 403/);
});

test("a release's date is the REST read of its tag, in epoch milliseconds, null when it parses to none, and a refusal or a non-JSON answer throws", () => {
  const { seen, run: ask } = recording(JSON.stringify({ published_at: "2026-10-04T20:15:29Z" }));
  assert.equal(releasePublishedAtOf({ repo: "a11ign/agent-org", tag: "v0.22.0", run: ask }), Date.parse("2026-10-04T20:15:29Z"));
  assert.deepEqual(seen, [["api", "repos/a11ign/agent-org/releases/tags/v0.22.0"]]);
  assert.equal(releasePublishedAtOf({ repo: "o/r", tag: "v1", run: () => JSON.stringify({ published_at: null }) }), null);
  assert.equal(releasePublishedAtOf({ repo: "o/r", tag: "v1", run: () => "{}" }), null);
  assert.throws(() => releasePublishedAtOf({ repo: "o/r", tag: "v1", run: () => "not json" }));
  assert.throws(() => releasePublishedAtOf({ repo: "o/r", tag: "v1", run: () => { throw new Error("HTTP 404"); } }), /HTTP 404/);
});

test("a worker's row labels are one REST read projected to the names, over the REST pool and not GraphQL's", () => {
  const { seen, run: ask } = recording('["tier:haiku","in-progress"]');
  assert.deepEqual(restLabelNamesOf({ repo: "a11ign/a11ign", number: 4918, run: ask }), ["tier:haiku", "in-progress"]);
  assert.deepEqual(seen, [["api", "repos/a11ign/a11ign/issues/4918", "--jq", "[.labels[].name]"]]);
  assert.throws(() => restLabelNamesOf({ repo: "o/r", number: 1, run: () => "not json" }));
  assert.throws(() => restLabelNamesOf({ repo: "o/r", number: 1, run: () => { throw new Error("HTTP 502"); } }), /HTTP 502/);
});

test("the review eval's reads: a pull request's title, body and commits, a row's title and body, each as `gh` printed them", () => {
  const pull = recording(JSON.stringify({ title: "t", body: "b", baseRefOid: "base", headRefOid: "head" }));
  assert.deepEqual(pullForReviewEvalOf({ repo: "a11ign/agent-org", number: 1243, run: pull.run }), { title: "t", body: "b", baseRefOid: "base", headRefOid: "head" });
  assert.deepEqual(pull.seen, [["pr", "view", "1243", "--repo", "a11ign/agent-org", "--json", "title,body,baseRefOid,headRefOid"]]);
  const row = recording(JSON.stringify({ title: "t", body: "b" }));
  assert.deepEqual(rowForReviewEvalOf({ repo: "a11ign/agent-org", number: 1200, run: row.run }), { title: "t", body: "b" });
  assert.deepEqual(row.seen, [["issue", "view", "1200", "--repo", "a11ign/agent-org", "--json", "title,body"]]);
  assert.throws(() => pullForReviewEvalOf({ repo: "o/r", number: 1, run: () => { throw new Error("HTTP 404"); } }), /HTTP 404/);
  assert.throws(() => rowForReviewEvalOf({ repo: "o/r", number: 1, run: () => "not json" }));
});

test("the GraphQL pool's probe is one GraphQL read of the viewer with the response headers, and the rows hand it out as it is", () => {
  assert.deepEqual([...GRAPHQL_POOL_PROBE], ["api", "graphql", "-f", "query=query { viewer { login } }", "-i"]);
  const own = (): string => { throw new Error("not asked"); };
  assert.deepEqual([...plumbingRowsOf({ own, queue: own }, () => ({}) as never).graphqlPoolProbeArgs()], [...GRAPHQL_POOL_PROBE]);
});

test("an operation whose caller hands no run runs on the plugin's own; the runner that never throws is the plugin's `withAnswer`, and refused when there is none", () => {
  const seen: string[][] = [];
  const rows = plumbingRowsOf({ own: (args) => { seen.push([...args]); return JSON.stringify(["x"]); }, queue: () => "" }, () => ({}) as never);
  assert.deepEqual(rows.restLabelNamesOf({ repo: "o/r", number: 3 }), ["x"]);
  assert.deepEqual(seen, [["api", "repos/o/r/issues/3", "--jq", "[.labels[].name]"]], "the plugin's own gh, as the process's account");
  assert.throws(() => rows.answeringRunnerWith({ cwd: "/x" }), /no runner of their own/);
  const asked: unknown[] = [];
  const answering = plumbingRowsOf({ own: () => "", queue: () => "", withAnswer: (request) => { asked.push(request); return () => ({ status: 0, stdout: "ok", stderr: "" }); } }, () => ({}) as never);
  assert.deepEqual(answering.answeringRunnerWith({ cwd: "/x", timeoutMs: 5 })(["a"], { input: "i" }), { status: 0, stdout: "ok", stderr: "" });
  assert.deepEqual(asked, [{ cwd: "/x", timeoutMs: 5 }], "the request the caller made is the runner's policy, whole");
});
