// no-token: none -- every operation is handed a stub `run` that records the argument list (or pages); nothing here spawns `gh` or reaches the network
/**
 * A11-160 (step 9): WHAT A RED CHECK'S CLASS AND THE SHARED-FAILURE INCIDENT ROW SAY TO `gh`, which core's tests of `ci-failure-class.ts` used to assert over a stubbed `gh` and which are the plugin's now (core's tests run
 * on the fake code host's red checks, jobs, rows and pull requests). The argument lists are copied from the module they were moved from, so a changed command fails here; the answers are GitHub's own shapes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RowsHelpers } from "../../../src/plugins/contracts/code-host-rows.ts";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import { connectionOf, readsRowsByLabel } from "../../../src/packaging/rows-by-label-fixtures.ts";
import { createRows } from "./index.ts";
import { changedFilesPageOf, fileSharedFailureRow, jobFailedStepOf, jobLogTextOf, jobOfCheckUrl, openPullBehindBy, pullMergedAtOf, recentRunsOf, redCheckOf, updatePullBranch } from "./class-ci-reads.ts";
import { recording } from "./recording-run.test.support.ts";

const rows = () => createRows(() => rowsReadHelpers() as unknown as RowsHelpers);
const SHA = "abcdef12".padEnd(40, "0");
const ESC = "\u001b";
const ESCAPE_REFUSAL = "the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway";
const DETAILS = (job: string) => `https://github.com/o/r/actions/runs/555/job/${job}`;

/**
 * A `gh` over a repository with one pull request, #77, at `SHA`: its checks (`checks`: name and job), the run all of them belong to, and the job logs. It refuses a job log as the real `gh` 2.100.0 does: exit 1 on a body
 * holding an escape byte unless `--allow-escape-sequences` is among the arguments (#767), by content, so a log with no escape bytes is read with or without the flag.
 */
function redRepository({ log = "AssertionError: expected 3, got 4\n", checks = [{ name: "suite", conclusion: "failure", job: "666" }], head = SHA, attempt = 1 }:
  { log?: string; checks?: { name: string; conclusion: string; job: string; details?: string }[]; head?: string; attempt?: number } = {}) {
  return recording((args: string[]) => {
    const path = args[1];
    if (path.endsWith("/pulls/77")) return { head: { sha: head, ref: "agent/x-77" } };
    if (path.includes(`/commits/${head}/check-runs`)) {
      return { check_runs: checks.map((check) => ({ name: check.name, conclusion: check.conclusion, details_url: check.details ?? DETAILS(check.job) })) };
    }
    if (path.endsWith("/actions/runs/555")) return { name: "CI", run_attempt: attempt };
    if (path.endsWith("/logs")) {
      if (log.includes(ESC) && !args.includes("--allow-escape-sequences")) return new Error(`Command failed: gh ${args.join(" ")}\n${ESCAPE_REFUSAL}`);
      return path.includes("/jobs/667/") ? "##[error]a job reported 'failure', not success\n" : log;
    }
    return new Error(`unexpected gh ${args.join(" ")}`);
  });
}
const PR = { repo: "o/r", number: 77, head8: "abcdef12" };

test("the red check of a head: the pull request, its head's check runs, the run of the red check and that job's log WITH the flag that allows its colour codes", () => {
  const { asked, run } = redRepository({ log: `${ESC}[31mAssertionError${ESC}[0m: nope\n`, attempt: 2 });
  assert.deepEqual(redCheckOf({ ...PR, run }), { branch: "agent/x-77", workflow: "CI", runAttempt: 2, log: `${ESC}[31mAssertionError${ESC}[0m: nope\n` });
  assert.deepEqual(asked, [
    ["api", "repos/o/r/pulls/77"], ["api", `repos/o/r/commits/${SHA}/check-runs?per_page=100`], ["api", "repos/o/r/actions/runs/555"],
    ["api", "repos/o/r/actions/jobs/666/logs", "--allow-escape-sequences"],
  ]);
  // the stub is the real refusal: the same coloured log without the flag throws, so the read above passing is the flag's doing
  assert.throws(() => redRepository({ log: `${ESC}[31mx${ESC}[0m` }).run(["api", "repos/o/r/actions/jobs/666/logs"]), /--allow-escape-sequences/);
});

test("the red check is the first failing one that is not the roll-up `gate`, whichever order the checks list in, and the roll-up's log is not read", () => {
  const gateFirst = redRepository({ checks: [{ name: "gate", conclusion: "failure", job: "667" }, { name: "suite", conclusion: "timed_out", job: "666" }] });
  assert.equal(redCheckOf({ ...PR, run: gateFirst.run })?.log, "AssertionError: expected 3, got 4\n");
  assert.ok(gateFirst.asked.every((args) => !args[1].includes("/jobs/667/")), "the roll-up's log names no cause and is not read");
  const onlyGate = redRepository({ checks: [{ name: "gate", conclusion: "failure", job: "667" }] });
  assert.equal(redCheckOf({ ...PR, run: onlyGate.run })?.log, "##[error]a job reported 'failure', not success\n", "with nothing else red, the roll-up is the check");
  const green = redRepository({ checks: [{ name: "suite", conclusion: "success", job: "666" }, { name: "lint", conclusion: "cancelled", job: "668" }] });
  assert.equal(redCheckOf({ ...PR, run: green.run }), null, "only a failure or a timeout is red");
});

test("a head that moved, nothing red and a red check that is not a workflow job are no check to read: null, and not one more call than needed", () => {
  const moved = redRepository({ head: "f".repeat(40) });
  assert.equal(redCheckOf({ ...PR, run: moved.run }), null);
  assert.equal(moved.asked.length, 1, "the pull request alone");
  const notAJob = redRepository({ checks: [{ name: "external", conclusion: "failure", job: "1", details: "https://example.com/status/1" }] });
  assert.equal(redCheckOf({ ...PR, run: notAJob.run }), null);
  assert.equal(notAJob.asked.length, 2, "the pull request and its check runs");
});

test("a red check read that is refused, or answers something that is not JSON, THROWS: it is never 'not red'", () => {
  assert.throws(() => redCheckOf({ ...PR, run: () => { throw new Error("HTTP 502"); } }), /HTTP 502/);
  assert.throws(() => redCheckOf({ ...PR, run: () => "<html>502</html>" }), SyntaxError);
  const logRefused = recording((args: string[]) => (args[1].endsWith("/logs") ? new Error("HTTP 410: the logs have expired") : redRepository().run(args)));
  assert.throws(() => redCheckOf({ ...PR, run: logRefused.run }), /HTTP 410/);
});

test("the workflow runs listed for the CI facts: the newest on main, or the newest that failed for a pull request, each at its limit, in the fields the facts read", () => {
  const body = { workflow_runs: [{ name: "CI", conclusion: "failure", head_branch: "main", updated_at: "2026-10-10T11:00:00Z", id: 1, extra: "dropped" }] };
  const onMain = recording(body);
  assert.deepEqual(recentRunsOf({ repo: "o/r", kind: "on-main", limit: 10, run: onMain.run }), [{ name: "CI", conclusion: "failure", headBranch: "main", updatedAt: "2026-10-10T11:00:00Z" }]);
  assert.deepEqual(onMain.asked, [["api", "repos/o/r/actions/runs?branch=main&per_page=10"]]);
  const failing = recording(body);
  recentRunsOf({ repo: "o/r", kind: "failing-for-pull-requests", limit: 50, run: failing.run });
  assert.deepEqual(failing.asked, [["api", "repos/o/r/actions/runs?status=failure&event=pull_request&per_page=50"]]);
  assert.deepEqual(recentRunsOf({ repo: "o/r", kind: "on-main", limit: 10, run: () => "{}" }), [], "an answer that carries no list of runs is no run");
  assert.throws(() => recentRunsOf({ repo: "o/r", kind: "on-main", limit: 10, run: () => { throw new Error("HTTP 403"); } }), /HTTP 403/);
});

test("a check's details address names its repository and job only when it is a workflow job's", () => {
  assert.deepEqual(jobOfCheckUrl("https://github.com/a11ign/a11ign/actions/runs/1011/job/11"), { repo: "a11ign/a11ign", jobId: "11" });
  assert.equal(jobOfCheckUrl("https://github.com/a11ign/a11ign/runs/11"), null, "an address of a check run is no job");
  assert.equal(jobOfCheckUrl("https://example.com/o/r/actions/runs/1/job/2"), null, "nor one of another host");
  assert.equal(jobOfCheckUrl(""), null);
});

test("the failed step of a job is the name of its first failed step, none when it has none, and the log is read with the escape flag", () => {
  const job = recording({ steps: [{ name: "Set up job", conclusion: "success" }, { name: "Install agent-org", conclusion: "failure" }, { name: "Run tests", conclusion: "failure" }] });
  assert.equal(jobFailedStepOf({ repo: "o/r", jobId: "11", run: job.run }), "Install agent-org");
  assert.deepEqual(job.asked, [["api", "repos/o/r/actions/jobs/11"]]);
  assert.equal(jobFailedStepOf({ repo: "o/r", jobId: 11, run: () => JSON.stringify({ steps: [{ name: "a", conclusion: "success" }] }) }), null);
  assert.equal(jobFailedStepOf({ repo: "o/r", jobId: 11, run: () => "{}" }), null, "a job that states no steps has no failed one");
  assert.throws(() => jobFailedStepOf({ repo: "o/r", jobId: 11, run: () => { throw new Error("HTTP 404"); } }), /HTTP 404/);
  const log = recording("a log\n");
  assert.equal(jobLogTextOf({ repo: "o/r", jobId: "11", run: log.run }), "a log\n");
  assert.deepEqual(log.asked, [["api", "repos/o/r/actions/jobs/11/logs", "--allow-escape-sequences"]]);
});

test("the files a pull request changes: the first page of names, none when the answer is not a list, and a refusal throws", () => {
  const page = recording([{ filename: "a.ts" }, { filename: "b/c.ts", sha: "x" }]);
  assert.deepEqual(changedFilesPageOf({ repo: "o/r", number: 5, perPage: 100, run: page.run }), ["a.ts", "b/c.ts"]);
  assert.deepEqual(page.asked, [["api", "repos/o/r/pulls/5/files?per_page=100"]]);
  assert.equal(changedFilesPageOf({ repo: "o/r", number: 5, perPage: 100, run: () => '{"message":"Not Found"}' }), null);
  assert.throws(() => changedFilesPageOf({ repo: "o/r", number: 5, perPage: 100, run: () => { throw new Error("HTTP 502"); } }), /HTTP 502/);
});

test("when a pull request merged is its `merged_at`, none while it has not; how far behind a PR is: open, then the compare of its base to its head", () => {
  const merged = recording({ merged_at: "2026-10-11T10:32:00Z" });
  assert.equal(pullMergedAtOf({ repo: "a/b", number: 5004, run: merged.run }), "2026-10-11T10:32:00Z");
  assert.deepEqual(merged.asked, [["api", "repos/a/b/pulls/5004"]]);
  assert.equal(pullMergedAtOf({ repo: "a/b", number: 5004, run: () => '{"merged_at":null}' }), null);
  assert.throws(() => pullMergedAtOf({ repo: "a/b", number: 1, run: () => { throw new Error("HTTP 404"); } }), /HTTP 404/);

  const behind = recording((args: string[]) => (args[1].includes("/compare/") ? { behind_by: 3 } : { state: "open", head: { sha: "h1" }, base: { ref: "release" } }));
  assert.equal(openPullBehindBy({ repo: "a/b", number: 7, run: behind.run }), 3);
  assert.deepEqual(behind.asked, [["api", "repos/a/b/pulls/7"], ["api", "repos/a/b/compare/release...h1"]]);
  const noBase = recording((args: string[]) => (args[1].includes("/compare/") ? {} : { state: "open", head: { sha: "h2" } }));
  assert.equal(openPullBehindBy({ repo: "a/b", number: 7, run: noBase.run }), 0, "a compare that states no count is zero behind");
  assert.equal(noBase.asked[1][1], "repos/a/b/compare/main...h2", "a pull request that states no base is compared with main");
  const closed = recording({ state: "closed", head: { sha: "h3" } });
  assert.equal(openPullBehindBy({ repo: "a/b", number: 7, run: closed.run }), null, "a pull request that is not open is not compared");
  assert.equal(closed.asked.length, 1);
});

test("updating a pull request's branch is a PUT of its update-branch, and a refusal (a conflict) throws", () => {
  const put = recording("{}");
  updatePullBranch({ repo: "a11ign/a11ign", number: 4969, run: put.run });
  assert.deepEqual(put.asked, [["api", "-X", "PUT", "repos/a11ign/a11ign/pulls/4969/update-branch"]]);
  assert.throws(() => updatePullBranch({ repo: "a/b", number: 1, run: () => { throw new Error("422 merge conflict"); } }), /merge conflict/);
});

test("the incident row is filed after its label: the label made or updated, then the row with one label and the body, and its number is read off the address printed", () => {
  const seen = recording((args: string[]) => (args[0] === "issue" ? "https://github.com/a11ign/a11ign/issues/9001\n" : ""));
  assert.equal(fileSharedFailureRow({ label: "ci-shared-failure", description: "One CI failure shared by several open pull requests", title: "CI failure shared by 2 PRs", body: "the body", run: seen.run }), 9001);
  assert.deepEqual(seen.asked, [
    ["label", "create", "ci-shared-failure", "--force", "--description", "One CI failure shared by several open pull requests"],
    ["issue", "create", "--title", "CI failure shared by 2 PRs", "--label", "ci-shared-failure", "--body", "the body"],
  ]);
  assert.equal(fileSharedFailureRow({ label: "l", description: "d", title: "t", body: "b", run: () => "created, but no address\n" }), null, "an answer that names no row is no row number");
  const refusedLabel = recording((args: string[]) => (args[0] === "label" ? new Error("HTTP 403") : ""));
  assert.throws(() => fileSharedFailureRow({ label: "l", description: "d", title: "t", body: "b", run: refusedLabel.run }), /HTTP 403/);
  assert.deepEqual(refusedLabel.asked.map((args) => args[0]), ["label"], "no row is filed when its label could not be made");
});

test("the incident rows are the by-label connection read with the fields the refresh needs, mapped to names, bodies, labels and the closing pull requests; a refusal throws", () => {
  const nodes = [{ number: 4988, body: "b", createdAt: "2026-10-11T09:00:00Z", closedAt: "2026-10-11T10:00:00Z", labels: ["ci-shared-failure", "backlog"],
    closedByPullRequestsReferences: [{ number: 5004, repository: { nameWithOwner: "a11ign/agent-org" } }] }];
  const seen = recording((args: string[]) => (readsRowsByLabel(args) === null ? new Error("unexpected") : JSON.parse(connectionOf(nodes))));
  const [row] = rows().sharedFailureRowsOf({ label: "ci-shared-failure", state: "closed", newest: 20, run: seen.run });
  assert.deepEqual(row, { number: 4988, body: "b", createdAt: "2026-10-11T09:00:00Z", closedAt: "2026-10-11T10:00:00Z", labels: ["ci-shared-failure", "backlog"], closedBy: [{ number: 5004, repo: "a11ign/agent-org" }] });
  assert.deepEqual(readsRowsByLabel(seen.asked[0]), { label: "ci-shared-failure", state: "CLOSED" });
  const query = seen.asked[0].find((arg) => arg.startsWith("query=")) ?? "";
  assert.match(query, /number body createdAt closedAt labels\(first:20\)\{nodes\{name\}\} closedByPullRequestsReferences\(first:10\)\{nodes\{number repository\{nameWithOwner\}\}\}/);
  assert.deepEqual(rows().sharedFailureRowsOf({ label: "ci-shared-failure", state: "open", newest: 20, run: () => connectionOf([{ number: 1 }]) }).map((r) => [r.number, r.body, r.labels, r.closedBy]), [[1, "", [], []]], "a row that states nothing else has an empty body, no labels and no closing pull request");
  assert.throws(() => rows().sharedFailureRowsOf({ label: "ci-shared-failure", state: "open", newest: 20, run: () => { throw new Error("HTTP 502"); } }), /HTTP 502/);
});
