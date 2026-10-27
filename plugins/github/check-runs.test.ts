// no-token: none -- `gh` is a recorded `exec`; nothing reaches GitHub
import { test } from "node:test";
import assert from "node:assert/strict";
import { rerunFailedJobsOf } from "../../src/ticket-port/ci-reads.ts";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import { create } from "./index.ts";
import { jobOfDetails, readCheckLog, rerunFailedChecks } from "./check-runs.ts";
import { rerunRuns } from "./rerun-runs.ts";
import { GhFailure } from "./gh.ts";

const JOB = "https://github.com/a11ign/agent-org/actions/runs/38391781529/job/112233";
const OTHER_JOB_SAME_RUN = "https://github.com/a11ign/agent-org/actions/runs/38391781529/job/112244";
const OTHER_RUN = "https://github.com/a11ign/other/actions/runs/7/job/8";
const failure = (args: string[], stderr = "gh: HTTP 403\n") => new GhFailure(args, { status: 1, stdout: "", stderr });

test("A11-154: an Actions job's page names its repository, run and job, and any other address names none", () => {
  assert.deepEqual(jobOfDetails(JOB), { repo: "a11ign/agent-org", runId: 38391781529, jobId: 112233 });
  for (const other of ["https://github.com/a11ign/agent-org/runs/112233", "https://ci.example/job/1", "https://github.com/a11ign/agent-org/pull/1"]) assert.equal(jobOfDetails(other), null, other);
});

test("the log of the job an address names is read with the escape codes allowed, which gh exits 1 on otherwise", () => {
  const calls: string[][] = [];
  assert.equal(readCheckLog(JOB, (args) => { calls.push(args); return "the log"; }, () => undefined), "the log");
  assert.deepEqual(calls, [["api", "repos/a11ign/agent-org/actions/jobs/112233/logs", "--allow-escape-sequences"]]);
});

test("an address that names no job is not read at all, and a log GitHub refuses is null with the reason logged", () => {
  const calls: string[][] = [];
  const logged: string[] = [];
  assert.equal(readCheckLog("https://github.com/a11ign/agent-org/pull/1", (args) => { calls.push(args); return "x"; }, (line) => logged.push(line)), null);
  assert.deepEqual([calls, logged], [[], []], "a commit status's address makes no call and says nothing");
  assert.equal(readCheckLog(JOB, (args) => { throw failure(args); }, (line) => logged.push(line)), null);
  assert.equal(logged.length, 1);
  assert.match(logged[0], new RegExp(`${JOB.replace(/[/.]/g, "\\$&")} could not be read: Command failed: gh api repos/a11ign/agent-org/actions/jobs/112233/logs --allow-escape-sequences gh: HTTP 403$`), "the command and GitHub's reason, as the pool logged them");
});

test("the failed jobs of each run are rerun once however many of its jobs are named, and an address that names no run is left out", () => {
  const calls: string[][] = [];
  assert.equal(rerunFailedChecks([JOB, OTHER_JOB_SAME_RUN, OTHER_RUN, "https://github.com/a11ign/agent-org/pull/1"], (args) => { calls.push(args); return ""; }), null);
  assert.deepEqual(calls, [["run", "rerun", "38391781529", "--failed", "-R", "a11ign/agent-org"], ["run", "rerun", "7", "--failed", "-R", "a11ign/other"]]);
  assert.equal(rerunFailedChecks([], () => { throw new Error("no call is made for no checks"); }), null);
});

test("a rerun GitHub refuses answers the first line of why, and the runs after it are not tried", () => {
  const calls: string[][] = [];
  const refused = rerunFailedChecks([JOB, OTHER_RUN], (args) => { calls.push(args); throw failure(args); });
  assert.equal(refused, "Command failed: gh run rerun 38391781529 --failed -R a11ign/agent-org");
  assert.equal(calls.length, 1);
});

test("the code host the plugin makes runs both through its one gh, as the process's own account", () => {
  const calls: { file: string; args: readonly string[]; env: unknown }[] = [];
  const host = create({}, fakePluginDeps({ exec: (file, args, options) => { calls.push({ file, args, env: options?.env }); return { status: 0, stdout: "log text", stderr: "" }; } }));
  assert.equal(host.readCheckLog(JOB), "log text");
  assert.equal(host.rerunFailedChecks([JOB]), null);
  assert.deepEqual(calls.map(({ file, args }) => [file, ...args]), [["gh", "api", "repos/a11ign/agent-org/actions/jobs/112233/logs", "--allow-escape-sequences"], ["gh", "run", "rerun", "38391781529", "--failed", "-R", "a11ign/agent-org"]]);
});

test("the plugin's rerun is one spelling with core's `rerunFailedJobsOf`, which wake still calls until step 7 moves it, so the two cannot drift", () => {
  const core: string[][] = [];
  rerunFailedJobsOf("a11ign/agent-org", 38391781529, (args) => { core.push(args); return ""; });
  const plugin: string[][] = [];
  rerunFailedChecks([JOB], (args) => { plugin.push(args); return ""; });
  assert.equal(core.length, 1, "POSITIVE CONTROL: core's helper made its call");
  assert.deepEqual(plugin, core);
});

test("A11-342: rerunRuns reruns the whole run each address names, once, with no --failed, and answers why GitHub refused", () => {
  const calls: string[][] = [];
  assert.equal(rerunRuns([JOB, OTHER_JOB_SAME_RUN, OTHER_RUN, "https://github.com/a11ign/agent-org/pull/1"], (args) => { calls.push(args); return ""; }), null);
  assert.deepEqual(calls.map((args) => args.join(" ")), ["run rerun 38391781529 -R a11ign/agent-org", "run rerun 7 -R a11ign/other"], "each run once, whole, and an address that names no run is left out");
  assert.equal(rerunRuns([], () => { throw new Error("no call is made for no runs"); }), null);
  assert.equal(rerunRuns([JOB], () => { throw new Error("run 38391781529 cannot be rerun\nmore"); }), "run 38391781529 cannot be rerun");
});
