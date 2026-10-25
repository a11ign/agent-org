// no-token: none -- `gh` is a stub that answers from a table of runs and records each call: no network, and no run is touched
import { test } from "node:test";
import assert from "node:assert/strict";
import { CI_RUN_FIELDS, readCiRun } from "./ci-run.ts";
import { GhFailure, type Gh } from "./gh.ts";

const REPOSITORY = "a11ign/agent-org";
const URL = "https://github.com/a11ign/agent-org/actions/runs/42";

/** The shape `gh run view --json status,conclusion,url,name,jobs` prints: a run with three jobs, two of them completed. */
const RUNNING = { status: "in_progress", conclusion: "", url: URL, name: "ci", jobs: [{ name: "lint", status: "completed", conclusion: "success" }, { name: "types", status: "completed", conclusion: "success" }, { name: "suite", status: "in_progress", conclusion: "" }] };

const answering = (answer: unknown): Gh => () => JSON.stringify(answer);

test("A11-245: a run still going is read with its status, no conclusion and the jobs done of all", () => {
  assert.deepEqual(readCiRun(REPOSITORY, 42, answering(RUNNING)), { status: "in_progress", conclusion: null, url: URL, name: "ci", jobs: { done: 2, total: 3 } });
});

test("A11-245: a finished run is read with its conclusion, whatever the conclusion is", () => {
  for (const conclusion of ["success", "failure", "cancelled", "skipped", "neutral", "timed_out"]) {
    assert.deepEqual(readCiRun(REPOSITORY, 42, answering({ ...RUNNING, status: "completed", conclusion, jobs: [] })), { status: "completed", conclusion, url: URL, name: "ci", jobs: null }, conclusion);
  }
});

test("A11-245: the run is asked of its own repository by id, for the fields the reader needs and nothing else", () => {
  const calls: string[][] = [];
  readCiRun(REPOSITORY, 42, (args) => { calls.push(args); return JSON.stringify(RUNNING); });
  assert.deepEqual(calls, [["run", "view", "42", "--repo", REPOSITORY, "--json", CI_RUN_FIELDS]]);
  assert.equal(CI_RUN_FIELDS, "status,conclusion,url,name,jobs");
});

test("A11-245: a run held for approval or a runner is queued, not unreadable", () => {
  for (const status of ["requested", "waiting", "pending"]) assert.equal(readCiRun(REPOSITORY, 42, answering({ ...RUNNING, status }))?.status, "queued", status);
});

test("A11-245: a run GitHub refuses, or answers in a shape this cannot read, is null and never a verdict", () => {
  const refusing: Gh = (args) => { throw new GhFailure(args, { status: 1, stdout: "", stderr: "gh: Could not resolve to a Run with the databaseId of 42 (HTTP 404)\n" }); };
  assert.equal(readCiRun(REPOSITORY, 42, refusing), null);
  assert.equal(readCiRun(REPOSITORY, 42, () => "not json"), null);
  assert.equal(readCiRun(REPOSITORY, 42, answering({ ...RUNNING, status: "stalled" })), null, "a status this does not know");
  assert.equal(readCiRun(REPOSITORY, 42, answering({ ...RUNNING, url: undefined })), null);
  assert.equal(readCiRun(REPOSITORY, 42, answering({ ...RUNNING, status: "completed", conclusion: "" })), null, "a completed run that says nothing of how it ended");
  assert.equal(readCiRun(REPOSITORY, 42, answering({ ...RUNNING, conclusion: "success" })), null, "a conclusion on a run that has not completed");
  assert.equal(readCiRun(REPOSITORY, 42, answering(null)), null);
});

test("A11-245: a run that lists no jobs yet has no job count", () => {
  assert.equal(readCiRun(REPOSITORY, 42, answering({ ...RUNNING, jobs: [] }))?.jobs, null);
  assert.equal(readCiRun(REPOSITORY, 42, answering({ ...RUNNING, jobs: undefined }))?.jobs, null);
});

/** What `gh run view 40177156793 --repo a11ign/agent-org --json status,conclusion,url,name,jobs` printed on 2026-10-25 (jobs cut to the fields read), pinned so the reader is held to GitHub's own shape and not only to the one it was written from. */
const REAL_ANSWER = {
  conclusion: "skipped", name: "auto-arm", status: "completed", url: "https://github.com/a11ign/agent-org/actions/runs/40177156793",
  jobs: ["relay", "arm", "outside-stalled", "outside-sweep", "arm-approved"].map((name) => ({ name, status: "completed", conclusion: "skipped" })),
};

test("A11-245: the answer GitHub gave for a real run is read", () => {
  assert.deepEqual(readCiRun("a11ign/agent-org", 40177156793, answering(REAL_ANSWER)), { status: "completed", conclusion: "skipped", url: REAL_ANSWER.url, name: "auto-arm", jobs: { done: 5, total: 5 } });
});
