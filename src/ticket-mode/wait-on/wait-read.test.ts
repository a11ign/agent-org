// no-token: none -- every seam is a stub; the one real process is a stub `fleet` script, to prove the timeout cuts a program that outlives it
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../../lib/tmp-fixture.ts";
import type { CiRun, Review, ReviewState } from "../../plugins/contracts/code-host.ts";
import { fleetJobStatusVia, readWait, readWaits, type WaitSeams } from "./wait-read.ts";
import { type Reading, type Wait, waitKey } from "./wait-types.ts";

const PULL = "https://github.com/a11ign/agent-org/pull/1872";
const HEAD = "a".repeat(40);

/** A job service status in the shape A11-243's plan gives (state, per-box progress, estimate, results). Pinned as a fixture: A11-243 had not merged when this was written, so these names are the plan's, not the service's. */
const RUNNING_JOB = { id: "fj-123", state: "running", label: "A11-229", progress: { done: 4, total: 6 }, estimatedFinish: "2026-10-25T09:00:00Z", results: null };
const DONE_JOB = { id: "fj-123", state: "done", progress: { done: 6, total: 6 }, results: "/srv/fleet/jobs/fj-123" };
const FAILED_JOB = { id: "fj-123", state: "failed", reason: "box a11y-worker-14 went offline", progress: { done: 2, total: 6 }, results: "/srv/fleet/jobs/fj-123" };

const run = (over: Partial<CiRun> = {}): CiRun => ({ status: "in_progress", conclusion: null, url: "https://github.com/a11ign/x/actions/runs/9", name: "ci", jobs: { done: 3, total: 5 }, ...over });
const review = (over: Partial<Review>): Review => ({ author: "someone", state: "APPROVED", commit: HEAD, at: 1, ...over });
const reviewState = (reviews: Review[]): ReviewState => ({ head: HEAD, trust: "inside", reviews, settled: true, view: {} });

type World = { job?: unknown | Error; run?: CiRun | null | Error | "absent"; pull?: string | null | Error; reviews?: ReviewState | null | Error; ticket?: string | Error | "unknown" | "absent" };

/** Seams answering from a world, and counting each call. */
function seamsOf(world: World) {
  const calls: string[] = [];
  const answer = <T>(value: T | Error): T => { if (value instanceof Error) throw value; return value; };
  const ciRun = world.run === "absent" || world.run === undefined ? null : world.run;
  const seams: WaitSeams = {
    fleetJobStatus: async (id) => { calls.push(`fleet ${id}`); return typeof world.job === "string" ? world.job : JSON.stringify(answer(world.job)); },
    codeHost: {
      ...(world.run === "absent" ? {} : { readCiRun: (repository: string, runId: number) => { calls.push(`ci ${repository}#${runId}`); return answer(ciRun); } }),
      readPullState: (url) => { calls.push(`pull ${url}`); return answer(world.pull === undefined ? null : world.pull); },
      readReviewState: (url) => { calls.push(`review ${url}`); return answer(world.reviews === undefined ? null : world.reviews); },
    },
    source: world.ticket === "absent" ? {} : { stateTypes: async (keys) => { calls.push(`ticket ${keys.join()}`); const type = answer(world.ticket === "unknown" ? undefined : world.ticket); return new Map(type === undefined ? [] : keys.map((key) => [key, type])); } },
  };
  return { seams, calls };
}

const JOB: Wait = { kind: "fleetJob", id: "fj-123" };
const CI: Wait = { kind: "ciRun", repository: "a11ign/x", runId: 9 };
const MERGED: Wait = { kind: "pullRequest", url: PULL, until: "merged" };
const REVIEWED: Wait = { kind: "pullRequest", url: PULL, until: "reviewed" };
const TICKET: Wait = { kind: "ticket", key: "A11-243", until: "done" };

test("A11-245: a fleet job that is queued or running is pending with its progress, estimate and no results; done finishes it with the results location", async () => {
  const running = await readWait(JOB, seamsOf({ job: RUNNING_JOB }).seams);
  assert.deepEqual(running, { wait: JOB, status: "pending", job: { state: "running", reason: null, results: null, progress: { done: 4, total: 6 }, estimatedFinish: Date.parse("2026-10-25T09:00:00Z") } });
  assert.equal((await readWait(JOB, seamsOf({ job: { ...RUNNING_JOB, state: "queued" } }).seams)).status, "pending");
  assert.deepEqual(await readWait(JOB, seamsOf({ job: DONE_JOB }).seams), { wait: JOB, status: "finished", job: { state: "done", reason: null, results: "/srv/fleet/jobs/fj-123", progress: { done: 6, total: 6 }, estimatedFinish: null } });
});

test("A11-245: a fleet job that failed or was cancelled is failed, with its reason or a stated one", async () => {
  const failed = await readWait(JOB, seamsOf({ job: FAILED_JOB }).seams);
  assert.equal(failed.status, "failed");
  assert.equal("job" in failed && failed.job.reason, "box a11y-worker-14 went offline");
  const cancelled = await readWait(JOB, seamsOf({ job: { state: "cancelled" } }).seams);
  assert.equal(cancelled.status, "failed");
  assert.equal("job" in cancelled && cancelled.job.reason, "the job was cancelled");
});

test("A11-245: per-box progress is summed, as a list or by box name, and fields the board does not know are ignored", async () => {
  const read = async (progress: unknown) => { const reading = await readWait(JOB, seamsOf({ job: { state: "running", progress: undefined, boxes: progress, owner: "someone", futureField: [1, 2] } }).seams); return "job" in reading ? reading.job.progress : "unreadable"; };
  assert.deepEqual(await read([{ done: 1, total: 3 }, { done: 2, total: 3 }]), { done: 3, total: 6 });
  assert.deepEqual(await read({ "a11y-worker-14": { done: 1, total: 2 }, "a11y-worker-15": { done: 0, total: 2 } }), { done: 1, total: 4 });
  assert.equal(await read([{ done: 1, total: 3 }, "x"]), null, "a box that is not a count makes the sum unknown, not a smaller sum");
  assert.equal(await read(undefined), null);
});

test("A11-245: a status that is not JSON, has no state or a state the board does not know is unreadable, and says why", async () => {
  for (const [job, why] of [["not json", /not JSON with a state/], [{ progress: { done: 1, total: 2 } }, /not JSON with a state/], [{ state: "paused" }, /state this board does not know: paused/], [[], /not JSON with a state/]] as const) {
    const reading = await readWait(JOB, seamsOf({ job }).seams);
    assert.equal(reading.status, "unreadable");
    assert.match("why" in reading ? reading.why : "", why);
  }
});

test("A11-245: a fleet read that throws or times out is unreadable with the reason, never a failure", async () => {
  const reading = await readWait(JOB, seamsOf({ job: new Error("fleet job status fj-123 did not answer in 30 s") }).seams);
  assert.deepEqual(reading, { wait: JOB, status: "unreadable", why: "fleet job status fj-123 did not answer in 30 s" });
});

test("A11-245: a CI run that completed with success, skipped or neutral is finished, any other conclusion is failed, and one still going is pending", async () => {
  for (const conclusion of ["success", "skipped", "neutral"]) assert.equal((await readWait(CI, seamsOf({ run: run({ status: "completed", conclusion }) }).seams)).status, "finished", conclusion);
  for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "startup_failure"]) assert.equal((await readWait(CI, seamsOf({ run: run({ status: "completed", conclusion }) }).seams)).status, "failed", conclusion);
  for (const status of ["queued", "in_progress"] as const) assert.equal((await readWait(CI, seamsOf({ run: run({ status }) }).seams)).status, "pending", status);
});

test("A11-245: a host that answers a run in a shape the contract does not allow is an unreadable item and rejects nothing", async () => {
  const seams = seamsOf({ run: undefined as unknown as null }).seams;
  const broken: WaitSeams = { ...seams, codeHost: { ...seams.codeHost, readCiRun: () => undefined as unknown as null } };
  const reading = await readWait(CI, broken);
  assert.equal(reading.status, "unreadable");
  const all = await readWaits([CI, JOB], new Map(), { ...broken, fleetJobStatus: async () => JSON.stringify(DONE_JOB) });
  assert.deepEqual(all.map((reading) => reading.status), ["unreadable", "finished"], "one broken item does not take the others with it");
});

test("A11-245: a tracker that never answers is cut at its timeout and the item is unreadable, while the other items are read", async () => {
  const hung: WaitSeams = { ...seamsOf({ job: DONE_JOB }).seams, source: { stateTypes: () => new Promise(() => undefined) }, readTimeoutMs: 50 };
  const started = Date.now();
  const readings = await readWaits([TICKET, JOB], new Map(), hung);
  assert.deepEqual(readings.map((reading) => reading.status), ["unreadable", "finished"]);
  assert.match((readings[0] as { why: string }).why, /the tracker did not answer about A11-243 in 0.05 s/);
  assert.ok(Date.now() - started < 5_000);
});

test("A11-245: a fleet job that was canceled, spelt either way, is failed", async () => {
  assert.equal((await readWait(JOB, seamsOf({ job: { state: "canceled" } }).seams)).status, "failed");
});

test("A11-245: a CI run is unreadable when the code host says nothing, throws, or has no CI-run read at all", async () => {
  assert.match((await readWait(CI, seamsOf({ run: null }).seams) as { why: string }).why, /could not read the run/);
  assert.match((await readWait(CI, seamsOf({ run: new Error("gh run view failed") }).seams) as { why: string }).why, /gh run view failed/);
  const old = await readWait(CI, seamsOf({ run: "absent" }).seams);
  assert.equal(old.status, "unreadable");
  assert.match((old as { why: string }).why, /older than contract 1\.17/);
});

test("A11-245: a pull request waited on until merged is finished when merged, failed when closed without merging, pending when open", async () => {
  assert.equal((await readWait(MERGED, seamsOf({ pull: "MERGED" }).seams)).status, "finished");
  assert.equal((await readWait(MERGED, seamsOf({ pull: "CLOSED" }).seams)).status, "failed");
  assert.equal((await readWait(MERGED, seamsOf({ pull: "OPEN" }).seams)).status, "pending");
  assert.equal((await readWait(MERGED, seamsOf({ pull: null }).seams)).status, "unreadable");
  assert.equal((await readWait(MERGED, seamsOf({ pull: new Error("boom") }).seams)).status, "unreadable");
  const { seams, calls } = seamsOf({ pull: "OPEN" });
  await readWait(MERGED, seams);
  assert.deepEqual(calls, [`pull ${PULL}`], "a merge wait never asks for the reviews");
});

test("A11-245: a pull request waited on until reviewed is finished by an approval or a change request on its current head, and says which", async () => {
  const read = async (reviews: Review[]) => readWait(REVIEWED, seamsOf({ pull: "OPEN", reviews: reviewState(reviews) }).seams) as Promise<Extract<Reading, { pull: unknown }>>;
  const approved = await read([review({ state: "APPROVED" })]);
  assert.deepEqual([approved.status, approved.pull.review], ["finished", "APPROVED"]);
  const changes = await read([review({ state: "CHANGES_REQUESTED" })]);
  assert.deepEqual([changes.status, changes.pull.review], ["finished", "CHANGES_REQUESTED"], "a change request is a finished review and not a failure");
  assert.equal((await read([review({ state: "APPROVED", commit: "b".repeat(40) })])).status, "pending", "a review of an older head is not a review of this one");
  assert.equal((await read([review({ state: "COMMENTED" }), review({ state: "DISMISSED" })])).status, "pending");
  assert.equal((await read([])).status, "pending");
  const latest = await read([review({ state: "CHANGES_REQUESTED", at: 1 }), review({ state: "APPROVED", at: 2 })]);
  assert.equal(latest.pull.review, "APPROVED", "the newest review on the head stands");
});

test("A11-245: a pull request waited on until reviewed is finished by a merge, failed by a close, and unreadable when the reviewer's gate does not load", async () => {
  assert.equal((await readWait(REVIEWED, seamsOf({ pull: "MERGED" }).seams)).status, "finished");
  assert.equal((await readWait(REVIEWED, seamsOf({ pull: "CLOSED" }).seams)).status, "failed");
  const gate = await readWait(REVIEWED, seamsOf({ pull: "OPEN", reviews: new Error("the reviewer's gate does not load") }).seams);
  assert.deepEqual([gate.status, (gate as { why: string }).why], ["unreadable", "the reviewer's gate does not load"]);
  assert.equal((await readWait(REVIEWED, seamsOf({ pull: "OPEN", reviews: null }).seams)).status, "unreadable");
});

test("A11-245: a ticket the tracker has completed is finished, canceled is failed, anything else is pending, and a tracker that cannot say is unreadable", async () => {
  assert.equal((await readWait(TICKET, seamsOf({ ticket: "completed" }).seams)).status, "finished");
  assert.equal((await readWait(TICKET, seamsOf({ ticket: "canceled" }).seams)).status, "failed");
  for (const type of ["started", "unstarted", "backlog", "triage"]) assert.equal((await readWait(TICKET, seamsOf({ ticket: type }).seams)).status, "pending", type);
  assert.equal((await readWait(TICKET, seamsOf({ ticket: "unknown" }).seams)).status, "unreadable");
  assert.match((await readWait(TICKET, seamsOf({ ticket: "absent" }).seams) as { why: string }).why, /cannot say where a ticket stands/);
  assert.match((await readWait(TICKET, seamsOf({ ticket: new Error("Linear is down") }).seams) as { why: string }).why, /Linear is down/);
});

test("A11-245: one call is made for each item that has not finished, and none for one that has", async () => {
  const { seams, calls } = seamsOf({ job: RUNNING_JOB, run: run({ status: "completed", conclusion: "success" }), pull: "OPEN", ticket: "started" });
  const waits = [JOB, CI, MERGED, TICKET];
  const first = await readWaits(waits, new Map(), seams);
  assert.deepEqual(first.map((reading) => reading.status), ["pending", "finished", "pending", "pending"]);
  assert.deepEqual([...calls].sort(), [`ci a11ign/x#9`, "fleet fj-123", `pull ${PULL}`, "ticket A11-243"]);
  calls.length = 0;
  const second = await readWaits(waits, new Map(first.map((reading) => [waitKey(reading.wait), reading])), seams);
  assert.deepEqual(calls.sort(), ["fleet fj-123", `pull ${PULL}`, "ticket A11-243"], "the finished run is not read again");
  assert.deepEqual(second[1], first[1]);
});

test("A11-245: an item that was unreadable is read again, and a failed one is kept", async () => {
  const flaky = seamsOf({ job: new Error("timeout") });
  const first = await readWaits([JOB, CI], new Map(), { ...flaky.seams });
  assert.equal(first[0].status, "unreadable");
  const healed = seamsOf({ job: DONE_JOB, run: run({ status: "completed", conclusion: "failure" }) });
  const second = await readWaits([JOB, CI], new Map(first.map((reading) => [waitKey(reading.wait), reading])), healed.seams);
  assert.deepEqual(second.map((reading) => reading.status), ["finished", "failed"]);
  healed.calls.length = 0;
  await readWaits([JOB, CI], new Map(second.map((reading) => [waitKey(reading.wait), reading])), healed.seams);
  assert.deepEqual(healed.calls, [], "finished and failed readings are kept");
});

test("A11-245: the fleet program is run with no shell, answers what it printed, and is cut when it outlives its timeout", async () => {
  /** A `fleet` on a PATH of its own, which is the one the read runs. */
  const fleetThat = (body: string, timeoutMs?: number) => {
    const dir = tmpDir("wait-read-");
    const path = join(dir, "fleet");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return fleetJobStatusVia({ timeoutMs, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  };
  assert.deepEqual(JSON.parse(await fleetThat('echo "{\\"state\\":\\"running\\",\\"args\\":\\"$*\\"}"')("fj-1")), { state: "running", args: "job status fj-1 --json" });
  await assert.rejects(fleetThat('echo "no such job" >&2; exit 3')("fj-1"), /^Error: fleet job status fj-1 failed: no such job$/);
  const started = Date.now();
  await assert.rejects(fleetThat("exec sleep 30", 200)("fj-1"), /^Error: fleet job status fj-1 did not answer in 0.2 s$/);
  assert.ok(Date.now() - started < 5_000, "the program that outlives its timeout does not hold the read");
  await assert.rejects(fleetJobStatusVia({ env: { PATH: "" } })("fj-1"), /failed: /, "a box with no fleet program");
  const refusing = fleetThat('echo "ran" > /dev/null');
  for (const id of ["--help", "-h", "a b", ""]) await assert.rejects(refusing(id), /is not a fleet job ID/, `an ID of ${JSON.stringify(id)} is never handed to the program`);
});
