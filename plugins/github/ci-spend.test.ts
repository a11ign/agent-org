// no-token: none -- `gh` is a stub that answers from a table of runs and jobs and records each call: no network, and no run is touched
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PAGES, readBranchCi } from "./ci-spend.ts";
import { GhFailure, type AsyncGh } from "./gh.ts";

const REPOSITORY = "a11ign/announcement-emulator";
const BRANCH = "admin/a11-18-the-emulator";

const run = (id: number, over: Record<string, unknown> = {}) => ({ id, head_sha: `sha-${id}`, head_branch: BRANCH, created_at: "2026-10-25T10:00:00Z", status: "completed", conclusion: "success", ...over });
const job = (labels: string[], started = "2026-10-25T10:00:10Z", completed: string | null = "2026-10-25T10:02:30Z") => ({ labels, started_at: started, completed_at: completed, status: completed === null ? "in_progress" : "completed" });

/** A `gh` that answers the two reads from tables, page by page, and records each call's path. */
function answering(runs: unknown[], jobsByRun: Record<number, unknown[]>, calls: string[] = []): AsyncGh {
  return async (args) => {
    assert.equal(args[0], "api");
    const path = args[1]!;
    calls.push(path);
    const [route, query = ""] = path.split("?");
    const page = Number(new URLSearchParams(query).get("page"));
    const per = Number(new URLSearchParams(query).get("per_page"));
    const jobs = route!.match(/\/actions\/runs\/(\d+)\/jobs$/);
    const all = jobs === null ? runs : jobsByRun[Number(jobs[1])] ?? [];
    const items = all.slice((page - 1) * per, page * per);
    return JSON.stringify(jobs === null ? { total_count: all.length, workflow_runs: items } : { total_count: all.length, jobs: items });
  };
}

test("A11-261: a branch's runs are read with each job's runner labels and times, newest first as the host lists them", async () => {
  const runs = await readBranchCi(REPOSITORY, BRANCH, new Set(), answering([run(2, { status: "in_progress" }), run(1)], { 2: [job(["ubuntu-latest"], "2026-10-25T10:00:10Z", null)], 1: [job(["macos-14"]), job(["self-hosted", "linux"])] }));
  assert.deepEqual(runs, [
    { id: 2, headSha: "sha-2", createdAt: "2026-10-25T10:00:00Z", status: "in_progress", jobs: [{ labels: ["ubuntu-latest"], startedAt: "2026-10-25T10:00:10Z", completedAt: null }] },
    { id: 1, headSha: "sha-1", createdAt: "2026-10-25T10:00:00Z", status: "completed", jobs: [{ labels: ["macos-14"], startedAt: "2026-10-25T10:00:10Z", completedAt: "2026-10-25T10:02:30Z" }, { labels: ["self-hosted", "linux"], startedAt: "2026-10-25T10:00:10Z", completedAt: "2026-10-25T10:02:30Z" }] },
  ]);
});

test("A11-261: the runs are asked of the branch with the branch encoded, and the jobs of every attempt (filter=all) of each run", async () => {
  const calls: string[] = [];
  await readBranchCi(REPOSITORY, BRANCH, new Set(), answering([run(7)], { 7: [job(["ubuntu-latest"])] }, calls));
  assert.deepEqual(calls, [
    `repos/${REPOSITORY}/actions/runs?branch=admin%2Fa11-18-the-emulator&per_page=100&page=1`,
    `repos/${REPOSITORY}/actions/runs/7/jobs?filter=all&per_page=100&page=1`,
  ]);
});

test("A11-261: only runs whose head branch is the branch are kept, since the host's filter also matches a fork's branch of that name", async () => {
  const runs = await readBranchCi(REPOSITORY, BRANCH, new Set(), answering([run(1), run(2, { head_branch: "someone-else:admin/a11-18-the-emulator" })], { 1: [job(["ubuntu-latest"])] }));
  assert.deepEqual(runs?.map(({ id }) => id), [1]);
});

test("A11-261: a settled run is listed with no jobs and its jobs are not asked for", async () => {
  const calls: string[] = [];
  const runs = await readBranchCi(REPOSITORY, BRANCH, new Set([1]), answering([run(2), run(1)], { 2: [job(["ubuntu-latest"])], 1: [job(["macos-14"])] }, calls));
  assert.deepEqual(runs?.map(({ id, jobs }) => [id, jobs.length]), [[2, 1], [1, 0]]);
  assert.ok(!calls.some((path) => path.includes("/runs/1/jobs")), calls.join("\n"));
});

test("A11-261: a run GitHub has not started is queued, as readCiRun reads it", async () => {
  for (const status of ["queued", "requested", "waiting", "pending"]) assert.equal((await readBranchCi(REPOSITORY, BRANCH, new Set(), answering([run(1, { status })], { 1: [] })))?.[0]?.status, "queued", status);
});

test("A11-261: a branch that ran nothing is an empty list, not null", async () => {
  assert.deepEqual(await readBranchCi(REPOSITORY, BRANCH, new Set(), answering([], {})), []);
});

test("A11-261: more runs than a page are read from the next page, and jobs likewise", async () => {
  const many = Array.from({ length: 130 }, (_, index) => run(1000 - index));
  const calls: string[] = [];
  const jobs = Array.from({ length: 120 }, () => job(["ubuntu-latest"]));
  const runs = await readBranchCi(REPOSITORY, BRANCH, new Set(many.slice(1).map(({ id }) => id)), answering(many, { 1000: jobs }, calls));
  assert.equal(runs?.length, 130);
  assert.equal(runs?.[0]?.jobs.length, 120, "both pages of the one unsettled run's jobs");
  assert.deepEqual(calls.filter((path) => path.includes("?branch=")).map((path) => path.slice(-6)), ["page=1", "page=2"]);
});

test("A11-261: a list that goes on past the page cap is null, never a short list", async () => {
  const cap = MAX_PAGES * 100;
  const calls: string[] = [];
  const endless: AsyncGh = async (args) => { calls.push(args[1]!); return JSON.stringify({ total_count: cap + 1, workflow_runs: Array.from({ length: 100 }, (_, index) => run(index)) }); };
  assert.equal(await readBranchCi(REPOSITORY, BRANCH, new Set(), endless), null);
  assert.equal(calls.length, MAX_PAGES, "no more pages are read than the cap");
});

test("A11-261: a host that says more exist and lists none is null", async () => {
  assert.equal(await readBranchCi(REPOSITORY, BRANCH, new Set(), async () => JSON.stringify({ total_count: 3, workflow_runs: [] })), null);
});

test("A11-261: a refused gh, an answer that does not parse, and a shape this cannot bill are each null", async () => {
  const refusing: AsyncGh = async (args) => { throw new GhFailure(args, { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)\n" }); };
  assert.equal(await readBranchCi(REPOSITORY, BRANCH, new Set(), refusing), null, "a repository it cannot read");
  assert.equal(await readBranchCi(REPOSITORY, BRANCH, new Set(), async () => "not json"), null);
  assert.equal(await readBranchCi(REPOSITORY, BRANCH, new Set(), async () => JSON.stringify({ workflow_runs: [] })), null, "no total");
  assert.equal(await readBranchCi(REPOSITORY, BRANCH, new Set(), answering([run(1, { status: "stalled" })], { 1: [] })), null, "a status it does not know");
  assert.equal(await readBranchCi(REPOSITORY, BRANCH, new Set(), answering([run(1, { created_at: "yesterday" })], { 1: [] })), null, "a time that is no time");
  assert.equal(await readBranchCi(REPOSITORY, BRANCH, new Set(), answering([run(1)], { 1: [{ labels: "ubuntu-latest", started_at: null, completed_at: null }] })), null, "labels that are no list");
  assert.equal(await readBranchCi(REPOSITORY, BRANCH, new Set(), answering([run(1)], { 1: [job(["ubuntu-latest"], "soon")] })), null, "a job time that is no time");
});

test("A11-261: the jobs of one run refused make the whole read null, so no total is added up from some of a branch's runs", async () => {
  const partial: AsyncGh = async (args) => { if (args[1]!.includes("/runs/2/jobs")) throw new GhFailure(args, { status: 1, stdout: "", stderr: "HTTP 502" }); return answering([run(3), run(2)], { 3: [job(["ubuntu-latest"])] })(args); };
  assert.equal(await readBranchCi(REPOSITORY, BRANCH, new Set(), partial), null);
});
