// no-token: none -- `run` answers from a recorded table: no GitHub CLI runs
/**
 * A11-160 (step 6): THE PULL REQUESTS, COMMITS, CHECKS, RUNS AND LISTS THE WORK GATE READS, and the closed rows it chases. Each operation builds the argument list the gate built (the tick's memo is keyed by it) and
 * reads the answer as the gate did; what the gate DECIDES of the answer is core's and its tests run on the fake code host.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RowsHelpers } from "../../../src/plugins/contracts/code-host-rows.ts";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import { createRows } from "./index.ts";
import { forgetRefusedReads } from "./rows-by-label.ts";
import { recording } from "./recording-run.test.support.ts";

const rows = () => createRows(() => rowsReadHelpers() as unknown as RowsHelpers);
const REPO = "a11ign/agent-org";

// --- the checks `main` requires ---------------------------------------------------------------------------------------------------------

test("#5020: the required checks are read from the rulesets first, and from branch protection only when the rulesets give nothing", () => {
  const rulesets = recording([{ type: "pull_request" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "gate" }, { context: "gate" }, { context: "sweep" }] } }]);
  assert.deepEqual(rows().readRequiredContexts({ run: rulesets.run }), { contexts: ["gate", "sweep"] });
  assert.deepEqual(rulesets.asked, [["api", "repos/{owner}/{repo}/rules/branches/main"]], "the second source is not asked once the first answered");

  const classic = recording((args: string[]) => (args[1].endsWith("rules/branches/main") ? [] : { protected: true, protection: { required_status_checks: { contexts: ["gate"] } } }));
  assert.deepEqual(rows().readRequiredContexts({ run: classic.run, repo: REPO }), { contexts: ["gate"] });
  assert.deepEqual(classic.asked, [["api", `repos/${REPO}/rules/branches/main`], ["api", `repos/${REPO}/branches/main`]]);
});

test("#2022: no source giving a usable list is null with the report of why, quoting the refusal or the unusable answer, never `[]`", () => {
  const nothing = rows().readRequiredContexts({ run: recording((args: string[]) => {
    if (args[1].endsWith("rules/branches/main")) throw new Error("gh: Not Found (HTTP 404)\nsecond line");
    return { protected: false, protection: { required_status_checks: { contexts: [] } } };
  }).run });
  assert.equal(nothing.contexts, null);
  assert.match(nothing.diagnosis!, /^`gh api repos\/\{owner\}\/\{repo\}\/rules\/branches\/main` was REFUSED \(gh: Not Found \(HTTP 404\)\); `gh api repos\/\{owner\}\/\{repo\}\/branches\/main` answered, but with no usable list of contexts: \{"protected":false,"contexts":\[\]\}\.$/);
  const long = rows().readRequiredContexts({ run: recording("x".repeat(300)).run });
  assert.match(long.diagnosis!, /xxx\.\.\. \(300 chars\)/, "an unusable answer is quoted bounded, not pasted whole");
});

test("main's tip is one REST read projected to its sha and committer date; a body that is not JSON is null, a refusal throws", () => {
  const read = recording({ sha: "abc1234", date: "2026-10-01T00:00:00Z" });
  assert.deepEqual(rows().mainTipOf({ run: read.run }), { sha: "abc1234", date: "2026-10-01T00:00:00Z" });
  assert.deepEqual(read.asked, [["api", "repos/{owner}/{repo}/commits/main", "--jq", "{sha: .sha, date: .commit.committer.date}"]]);
  assert.equal(rows().mainTipOf({ run: recording("<html>").run }), null);
  assert.throws(() => rows().mainTipOf({ run: recording(new Error("HTTP 403")).run }), /HTTP 403/);
});

// --- pull requests ----------------------------------------------------------------------------------------------------------------------

test("#3892: the pull requests of a branch are listed in every state, and null when the answer is not a list", () => {
  const read = recording([{ number: 4, state: "CLOSED" }, { number: 5, state: "MERGED" }]);
  assert.deepEqual(rows().pullsOfBranch({ branch: "a11-1-x", limit: 100, run: read.run }), [{ number: 4, state: "CLOSED" }, { number: 5, state: "MERGED" }]);
  assert.deepEqual(read.asked, [["pr", "list", "--head", "a11-1-x", "--state", "all", "--limit", "100", "--json", "number,state"]]);
  assert.equal(rows().pullsOfBranch({ branch: "b", limit: 100, run: recording({}).run }), null);
  assert.throws(() => rows().pullsOfBranch({ branch: "b", limit: 100, run: recording(new Error("HTTP 502")).run }), /HTTP 502/);
});

test("the newest merged pull requests are one list of 100, null when the answer is not a list; the open list's arguments are the gate's to run through its own executor", () => {
  const read = recording([{ number: 4 }]);
  assert.deepEqual(rows().newestMergedPulls({ run: read.run }), [{ number: 4 }]);
  assert.deepEqual(read.asked, [["pr", "list", "--state", "merged", "--limit", "100", "--json", "number,headRefName,mergedAt,title,labels"]]);
  assert.equal(rows().newestMergedPulls({ run: recording("null").run }), null);
  assert.deepEqual(rows().openPullListArgs(20, "number,title"), ["pr", "list", "--state", "open", "--limit", "20", "--json", "number,title"]);
});

/** What `call` returned over a `run` that answers `answer`, and the argument lists it asked. */
function ask<T>(answer: unknown, call: (run: (args: string[]) => string) => T): { value: T; asked: string[][] } {
  const read = recording(answer);
  return { value: call(read.run), asked: read.asked };
}

test("#3365: the files past the first hundred are paged from the repository `gh` aims at; the commits and the diff are named by the repository the gate is reading", () => {
  const files = ask("a.ts\n\nb.ts\n", (run) => rows().pullFileNamesOf({ number: 7, run }));
  assert.deepEqual([files.value, files.asked], [["a.ts", "b.ts"], [["api", "--paginate", "repos/{owner}/{repo}/pulls/7/files?per_page=100", "--jq", ".[].filename"]]]);
  const commits = ask("aaa\n bbb \n\n", (run) => rows().commitShasOf({ repo: REPO, number: 7, run }));
  assert.deepEqual([commits.value, commits.asked], [["aaa", "bbb"], [["api", `repos/${REPO}/pulls/7/commits`, "--paginate", "--jq", ".[].sha"]]]);
  const diff = ask("diff --git a/x b/x\n", (run) => rows().compareDiffOf({ repo: REPO, base: "main", head: "abc12345", run }));
  assert.deepEqual([diff.value, diff.asked], ["diff --git a/x b/x\n", [["api", "-H", "Accept: application/vnd.github.diff", `repos/${REPO}/compare/main...abc12345`]]]);
});

test("a commit's check runs: the names that failed (once each) and every run with its summary, from the page of 100", () => {
  const page = `repos/${REPO}/commits/abc12345/check-runs?per_page=100`;
  const failing = ask("lint\n lint \ntest\n\n", (run) => rows().failingCheckNamesAt({ repo: REPO, commit: "abc12345", run }));
  assert.deepEqual([failing.value, failing.asked], [["lint", "test"], [["api", page, "--paginate", "--jq", '.check_runs[] | select(.conclusion == "failure") | .name']]]);
  const summaries = ask('{"id":1,"name":"gate","summary":"Cleared-by: review"}\n\n{"id":2,"name":"lint","summary":null}\n', (run) => rows().checkRunSummariesAt({ repo: REPO, commit: "abc12345", run }));
  assert.deepEqual([summaries.value, summaries.asked], [[{ id: 1, name: "gate", summary: "Cleared-by: review" }, { id: 2, name: "lint", summary: null }], [["api", page, "--paginate", "--jq", ".check_runs[] | {id, name, summary: .output.summary}"]]]);
});

test("the merge queue's runs: the newest 50 with or without their conclusion, the jobs of one run and one Actions job, each with the runner and steps that tell whether it ever started", () => {
  const runs = recording([{ id: 9, head_branch: "gh-readonly-queue/main/pr-4-abc", created_at: "t" }]);
  rows().mergeGroupRunsOf({ repo: REPO, withConclusion: false, run: runs.run });
  rows().mergeGroupRunsOf({ repo: REPO, withConclusion: true, run: runs.run });
  assert.deepEqual(runs.asked, [
    ["api", `repos/${REPO}/actions/runs?event=merge_group&per_page=50`, "--jq", "[.workflow_runs[] | {id, head_branch, created_at}]"],
    ["api", `repos/${REPO}/actions/runs?event=merge_group&per_page=50`, "--jq", "[.workflow_runs[] | {id, head_branch, conclusion, created_at}]"],
  ]);
  const jobs = recording([{ conclusion: "cancelled", runner_name: "", steps: 0 }]);
  assert.deepEqual(rows().jobsOfMergeGroupRun({ repo: REPO, runId: 9, run: jobs.run }), [{ conclusion: "cancelled", runner_name: "", steps: 0 }]);
  assert.deepEqual(jobs.asked, [["api", `repos/${REPO}/actions/runs/9/jobs?per_page=100`, "--jq", "[.jobs[] | {conclusion, runner_name, steps: (.steps // [] | length)}]"]]);
  const job = recording({ conclusion: "failure", runner_name: "r", steps: 3 });
  assert.deepEqual(rows().actionsJobOf({ repo: REPO, jobId: "77", run: job.run }), { conclusion: "failure", runner_name: "r", steps: 3 });
  assert.deepEqual(job.asked, [["api", `repos/${REPO}/actions/jobs/77`, "--jq", "{conclusion, runner_name, steps: (.steps // [] | length)}"]]);
});

// --- the lists --------------------------------------------------------------------------------------------------------------------------

test("agent-org#1624: the open rows are one `issue list`, and an answer that parses but is not a list THROWS, saying what it was", () => {
  const read = recording([{ number: 4 }]);
  assert.deepEqual(rows().openRowsOf({ limit: 500, fields: "number,title", run: read.run }), [{ number: 4 }]);
  assert.deepEqual(read.asked, [["issue", "list", "--state", "open", "--limit", "500", "--json", "number,title"]]);
  assert.throws(() => rows().openRowsOf({ limit: 500, fields: "number", run: recording({ message: "rate limited" }).run }), /^Error: the answer was not a list: "\{\\"message\\":\\"rate limited\\"\}"$/);
  assert.throws(() => rows().openRowsOf({ limit: 500, fields: "number", run: recording("not json").run }));
});

test("#472: the labels with a prefix are listed from the repository's labels; ZERO BYTES is no label (not a refusal), a non-list is null and a refusal throws", () => {
  const read = recording([{ name: "answer:ceo" }, { name: "answer:pm" }, { name: "other:x" }, { name: 4 }]);
  assert.deepEqual(rows().labelNamesWithPrefix({ prefix: "answer:", run: read.run }), ["answer:ceo", "answer:pm"]);
  assert.deepEqual(read.asked, [["label", "list", "--search", "answer:", "--limit", "100", "--json", "name"]]);
  assert.deepEqual(rows().labelNamesWithPrefix({ prefix: "answer:", run: recording("").run }), []);
  assert.equal(rows().labelNamesWithPrefix({ prefix: "answer:", run: recording({ message: "x" }).run }), null);
  assert.throws(() => rows().labelNamesWithPrefix({ prefix: "answer:", run: recording(new Error("HTTP 502")).run }), /HTTP 502/);
});

// --- closed rows ------------------------------------------------------------------------------------------------------------------------

/** A REST world: issue 7 closed with the claim label and 150 comments, 8 open, 9 absent (HTTP 404). */
function claimWorld() {
  return recording((args: string[]) => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (path.endsWith("/issues/7")) return { state: "closed", labels: [{ name: "in-progress" }], comments: 150 };
    if (path.endsWith("/issues/8")) return { state: "open", labels: [{ name: "in-progress" }], comments: 0 };
    if (path.endsWith("/issues/9")) return Object.assign(new Error("gh: Not Found"), { stderr: "gh: Not Found (HTTP 404)" });
    if (path.includes("/issues/7/comments")) return [{ body: "c", created_at: "t", user: { login: "bot" } }];
    if (path.endsWith("/issues/7/timeline")) return [[{ event: "cross-referenced", source: { issue: { number: 31, title: "pr", pull_request: {} } } }, { event: "labeled" }]];
    if (path.endsWith("/pulls/31")) return { head: { ref: "a11-7-x" } };
    throw new Error(`unexpected ${args.join(" ")}`);
  });
}

test("#3535: the closed rows still carrying the claim are read over REST by number: the last two pages of comments, the cross-referencing pull requests, a 404 is an absent row", () => {
  const world = claimWorld();
  const found = rows().closedClaimedRowsOf({ repo: REPO, numbers: [7, 8, 9], claimLabel: "in-progress", run: world.run });
  assert.deepEqual(found, [{ number: 7, labels: [{ name: "in-progress" }], comments: [{ body: "c", createdAt: "t", author: { login: "bot" } }, { body: "c", createdAt: "t", author: { login: "bot" } }],
    closedByPullRequestsReferences: [{ number: 31, headRefName: "a11-7-x", title: "pr" }] }], "an open row and an absent one are no closed claim");
  assert.deepEqual(world.asked.map((args) => args.join(" ")), [
    `api repos/${REPO}/issues/7`, `api repos/${REPO}/issues/7/comments?per_page=100&page=1`, `api repos/${REPO}/issues/7/comments?per_page=100&page=2`,
    `api --paginate --slurp repos/${REPO}/issues/7/timeline`, `api repos/${REPO}/pulls/31`, `api repos/${REPO}/issues/8`, `api repos/${REPO}/issues/9`,
  ]);
});

test("#948: a refusal that is not a 404 refuses the whole read, and a body that is not JSON says so", () => {
  assert.throws(() => rows().closedClaimedRowsOf({ repo: REPO, numbers: [7], claimLabel: "in-progress", run: recording(Object.assign(new Error("boom"), { stderr: "HTTP 500" })).run }), /boom/);
  assert.throws(() => rows().closedClaimedRowsOf({ repo: REPO, numbers: [7], claimLabel: "in-progress", run: recording("<html>").run }), /^Error: its answer was not JSON \(/);
});

test("#5050: the closed rows carrying any answer label are ONE aliased connection read per kind, a row carrying two read twice and kept once, and null when the answer is not whole", () => {
  forgetRefusedReads();
  const node = (number: number) => ({ number, title: "t", state: "CLOSED", labels: { nodes: [{ name: "answer:ceo" }] } });
  const read = recording({ data: { repository: { a0: { nodes: [node(4), node(5)] }, a1: { nodes: [node(5)] } } } });
  assert.deepEqual(rows().closedRowsCarryingLabels({ names: ["answer:ceo", "answer:pm"], kind: "issues", run: read.run }), [
    { number: 4, title: "t", state: "CLOSED", labels: [{ name: "answer:ceo" }] }, { number: 5, title: "t", state: "CLOSED", labels: [{ name: "answer:ceo" }] }]);
  const [args] = read.asked;
  assert.deepEqual([args.slice(0, 3).join(" "), args.slice(4)], ["api graphql -f", ["-F", "owner={owner}", "-F", "name={repo}"]]);
  assert.match(args[3], /a0: issues\(labels: \["answer:ceo"\], states: CLOSED, first: 100, orderBy: \{field: UPDATED_AT, direction: DESC\}\) \{ nodes \{ number title state labels\(first:30\)\{nodes\{name\}\} \} \} a1: issues\(labels: \["answer:pm"\]/);
  rows().closedRowsCarryingLabels({ names: ["answer:ceo"], kind: "pullRequests", run: read.run });
  assert.match(read.asked[1][3], /a0: pullRequests\(labels: \["answer:ceo"\], states: \[CLOSED, MERGED\], first: 100, .* nodes \{ number title state isDraft labels\(first:30\)/);
  assert.equal(rows().closedRowsCarryingLabels({ names: ["answer:ceo"], kind: "issues", run: recording({ errors: [{}], data: { repository: { a0: { nodes: [] } } } }).run }), null);
  assert.equal(rows().closedRowsCarryingLabels({ names: ["answer:ceo"], kind: "issues", run: recording({ data: { repository: { a0: {} } } }).run }), null);
  forgetRefusedReads();
});
