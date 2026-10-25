// no-token: gh -- herdr, the tracker, the code host, the `fleet` job service and the clock are injected; the one real process is a stub `fleet` script that proves the exec seam and its timeout
// A11-245: a run that declares what it waits on (a fleet job, a CI run, a pull request, a ticket) is read by the board and prompted ONCE when it ends, fails or passes its deadline; the card says what it waits on
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import type { CiRun } from "../plugins/contracts/code-host.ts";
import { poolFixture } from "./pool-fixture.ts";
import { herdrName } from "./pool.ts";
import { ticketDir } from "./ticket-paths.ts";
import { workingNote } from "./board-view/pull-status-and-notes.ts";
import { clockOf } from "./board-view/update-banner.ts";
import { deadlineOf } from "./board-view/wait-deadline.ts";
import { fleetJobStatusVia } from "./wait-on/wait-read.ts";
import type { TicketSource } from "./source.ts";

const NAME = herdrName("NBF-1");
/** The pane NBF-1's agent is in, which every prompt reaches it by: herdr 0.9.3 lists Claude agents with no name (A11-279). */
const PANE = "w1:p1";
const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 25, 10, 0, 0);
const REPO = "a11ign/agent-org";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** What the job service says of fleet job `fj-1`: its state, with 4 of 6 pages done unless a test says otherwise. */
const job = (state: string, over: Record<string, unknown> = {}): string => JSON.stringify({ id: "fj-1", state, progress: { done: 4, total: 6 }, ...over });

/** A tracker that answers where each ticket stands from `types`, and counts what it was asked. */
function trackerWith(types: Map<string, string>, asked: string[] = []): TicketSource {
  const fake = createFakeTracker();
  return { assigned: fake.assigned, read: fake.read, download: fake.download, keywords: fake.keywords, stateTypes: async (keys) => { asked.push(...keys); return new Map(keys.filter((key) => types.has(key)).map((key) => [key, types.get(key)!])); } };
}

type Options = Readonly<{
  /** What `fleet job status fj-1 --json` prints, asked at every read with the test's clock. */
  fleet?: (now: number) => string;
  /** The program that answers it, in place of `fleet`: the real exec seam. */
  fleetJobStatus?: (id: string) => Promise<string>;
  codeHost?: ReturnType<typeof createFakeCodeHost>;
  types?: Map<string, string>;
  /** The deadline the outcome gives. */
  until?: string;
}>;

/** NBF-1 wrote `working` declaring `waitingOn`, and went idle: the board's pool, its fakes and the clock a test moves. */
async function waitingRun(waitingOn: unknown, { fleet = () => job("running"), fleetJobStatus, codeHost = createFakeCodeHost(), types = new Map(), until }: Options = {}) {
  let clock = T0;
  const fleetAsked: string[] = [];
  const made = poolFixture({ now: () => clock, source: trackerWith(types) });
  const refuse = { left: 0, tried: 0 };
  const herdr = (args: string[], timeoutMs?: number): string => {
    // Only the board's wake prompts are counted and refused: A11-85's "background work is gone" prompt is another thing.
    if (args.includes("prompt") && args.includes(PANE) && !String(args.at(-1)).startsWith("your background work is gone")) {
      refuse.tried += 1;
      if (refuse.left > 0) { refuse.left -= 1; throw new Error("herdr exited 1: the pane is busy"); }
    }
    return made.herdr.run(args);
  };
  const pool = made.restart({ codeHost, herdr, waitSeams: { fleetJobStatus: fleetJobStatus ?? (async (id) => { fleetAsked.push(id); return fleet(clock); }) } });
  await pool.tick();
  made.status.set(NAME, "working");
  await pool.tick();
  const file = join(ticketDir(made.settings, "NBF-1"), "outcome.json");
  /** The worker writes `outcome` with the file's time on the test's clock, which the deadline counts from, and goes idle. */
  const write = async (outcome: Record<string, unknown>) => {
    writeFileSync(file, JSON.stringify(outcome));
    utimesSync(file, new Date(clock), new Date(clock));
    made.status.set(NAME, "idle");
    await pool.tick();
    await flush();
  };
  await write({ kind: "working", reason: "waiting for the capture", waitingOn, ...(until === undefined ? {} : { until }) });
  const prompts = () => made.herdr.calls.filter((args) => args.includes("prompt") && args.includes(PANE)).map((args) => String(args.at(-1)));
  /** The clock moves on and the pool ticks once; the reading it starts is there for the tick after. */
  const pass = async (ms = MIN) => { clock += ms; await pool.tick(); await flush(); };
  const passes = async (count: number, ms = MIN) => { for (let i = 0; i < count; i += 1) await pass(ms); };
  return { ...made, pool, codeHost, fleetAsked, refuse, write, prompts, pass, passes, now: () => clock, working: () => made.entry("NBF-1").working, note: () => workingNote(made.entry("NBF-1")), file };
}

/** The deadline the card ends a wait's words with, `, until 16:30`, from the working note the worker's outcome gave (A11-272). */
const dueOf = (run: Readonly<{ working: () => Parameters<typeof deadlineOf>[0] | undefined }>): string => `, until ${clockOf(deadlineOf(run.working()!))}`;

const ciRun = (over: Partial<CiRun> = {}): CiRun => ({ status: "in_progress", conclusion: null, url: `https://github.com/${REPO}/actions/runs/9`, name: "ci", jobs: { done: 3, total: 5 }, ...over });

/** A code host that holds CI run `a11ign/agent-org#9`, still running unless `over` says otherwise. */
function hostWithRun(over: Partial<CiRun> = {}) {
  const codeHost = createFakeCodeHost();
  codeHost.ciRuns.runs.set(`${REPO}#9`, ciRun(over));
  return codeHost;
}

/** The prompts the worker has been sent once the clock has moved on `count` more minutes. */
async function promptsAfter(run: Awaited<ReturnType<typeof waitingRun>>, count: number): Promise<string[]> {
  await run.passes(count);
  return run.prompts();
}

/** A run waiting on a fleet job that is done, whose first `refusals` wake prompts herdr refuses. */
async function wokenRefusing(refusals: number, passes: number) {
  const run = await waitingRun([{ fleetJob: "fj-1" }], { fleet: () => job("done") });
  run.refuse.left = refusals;
  await run.passes(passes);
  return run;
}

test("A11-245: a fleet job that finishes wakes the worker once, with its state and where its results are, however many ticks follow", async () => {
  let state = job("running");
  const run = await waitingRun([{ fleetJob: "fj-1" }], { fleet: () => state });
  await run.passes(3);
  assert.deepEqual(run.prompts(), [], "pending: nothing is sent");
  state = job("done", { progress: { done: 6, total: 6 }, results: "/srv/fleet/jobs/fj-1" });
  await run.passes(6);
  assert.equal(run.prompts().length, 1, "exactly one prompt");
  assert.match(run.prompts()[0], /^What you waited on has finished: fleet job fj-1 is done; its results are at \/srv\/fleet\/jobs\/fj-1 \(fleet job fetch fj-1 --to <dir> copies them\)\. Act on it/);
  assert.equal(run.working()?.woke?.why, "finished");
});

test("A11-245: a CI run that completes with success wakes the worker once, naming its conclusion and address", async () => {
  const codeHost = hostWithRun();
  const run = await waitingRun([{ ciRun: `${REPO}#9` }], { codeHost });
  await run.passes(3);
  assert.deepEqual(run.prompts(), []);
  codeHost.ciRuns.runs.set(`${REPO}#9`, ciRun({ status: "completed", conclusion: "success" }));
  await run.passes(6);
  assert.equal(run.prompts().length, 1);
  assert.match(run.prompts()[0], /^What you waited on has finished: CI run a11ign\/agent-org#9 \(ci\) concluded success: https:\/\/github\.com\/a11ign\/agent-org\/actions\/runs\/9\. Act on it/);
});

test("A11-245: a pull request that merges wakes the worker once", async () => {
  const codeHost = createFakeCodeHost();
  const { url } = codeHost.seedPull(REPO, 7);
  const run = await waitingRun([{ pullRequest: url, until: "merged" }], { codeHost });
  await run.passes(3);
  assert.deepEqual(run.prompts(), []);
  codeHost.pullAt(url)!.state = "merged";
  await run.passes(6);
  assert.equal(run.prompts().length, 1);
  assert.match(run.prompts()[0], /^What you waited on has finished: pull request https:\/\/github\.com\/a11ign\/agent-org\/pull\/7 was merged\. Act on it/);
});

test("A11-245: a pull request waited on until reviewed wakes the worker once when a review stands on its current head, and a review of an older head does not", async () => {
  const codeHost = createFakeCodeHost();
  const { url } = codeHost.seedPull(REPO, 8, { reviews: [{ author: "reviewer", state: "APPROVED", commit: "an-older-head", at: T0 }] });
  const run = await waitingRun([{ pullRequest: url, until: "reviewed" }], { codeHost });
  await run.passes(4);
  assert.deepEqual(run.prompts(), [], "a review of an older head is not a review of this one");
  codeHost.pullAt(url)!.reviews = [{ author: "reviewer", state: "APPROVED", commit: "head-8", at: T0 + MIN }];
  await run.passes(6);
  assert.equal(run.prompts().length, 1);
  assert.match(run.prompts()[0], /pull request https:\/\/github\.com\/a11ign\/agent-org\/pull\/8 has an approving review on its current head\. Act on it/);
});

test("A11-245: a ticket the tracker has completed wakes the worker once", async () => {
  const types = new Map([["A11-9", "completed"]]);
  const run = await waitingRun([{ ticket: "A11-9", until: "done" }], { types });
  await run.passes(6);
  assert.equal(run.prompts().length, 1);
  assert.match(run.prompts()[0], /^What you waited on has finished: ticket A11-9 is done\. Act on it/);
});

test("A11-272: a ticket the wait's reading finds not done is not waited on in the pane: the run is stopped and queued behind it, and nothing is prompted", async () => {
  const types = new Map([["A11-9", "started"]]);
  const run = await waitingRun([{ ticket: "A11-9", until: "done" }], { types });
  await run.passes(3);
  assert.deepEqual([run.entry("NBF-1").phase, run.entry("NBF-1").stoppedForBlocker?.keys], ["queued", ["A11-9"]]);
  assert.deepEqual(run.prompts(), []);
});

test("A11-245: with two items, one finished is no prompt; when the second finishes the worker is prompted once, and a board that restarted afterwards sends nothing more", async () => {
  const codeHost = hostWithRun();
  let state = job("running");
  const run = await waitingRun([{ fleetJob: "fj-1" }, { ciRun: `${REPO}#9` }], { fleet: () => state, codeHost });
  state = job("done", { results: "/srv/fleet/jobs/fj-1" });
  await run.passes(4);
  assert.deepEqual(run.prompts(), [], "the job is done, the CI run is not");
  assert.equal(run.note()?.text, `Waiting on fleet job fj-1 (done); CI run a11ign/agent-org#9 (running, 3 of 5 jobs)${dueOf(run)}`);
  codeHost.ciRuns.runs.set(`${REPO}#9`, ciRun({ status: "completed", conclusion: "success" }));
  await run.passes(6);
  assert.equal(run.prompts().length, 1, "both are over: one prompt, naming both");
  assert.ok(run.prompts()[0].includes("fleet job fj-1 is done") && run.prompts()[0].includes("CI run a11ign/agent-org#9 (ci) concluded success"));
  const restarted = run.restart({ codeHost, waitSeams: { fleetJobStatus: async () => state } });
  await restarted.tick();
  await flush();
  await restarted.tick();
  assert.equal(run.prompts().length, 1, "the note's own `woke` says the worker was told: a restarted pool sends none");
});

test("A11-245: a fleet job that fails wakes the worker with its reason first, even while another item is pending", async () => {
  const codeHost = hostWithRun();
  const run = await waitingRun([{ fleetJob: "fj-1" }, { ciRun: `${REPO}#9` }], { fleet: () => job("failed", { reason: "box a11y-worker-14 went offline", results: "/srv/fleet/jobs/fj-1" }), codeHost });
  const prompts = await promptsAfter(run, 5);
  assert.equal(prompts.length, 1, "once, with the CI run still running");
  assert.match(prompts[0], /^Your wait failed: fleet job fj-1 failed: box a11y-worker-14 went offline\. All of it: fleet job fj-1 failed: box a11y-worker-14 went offline; CI run a11ign\/agent-org#9 \(ci\) is running, 3 of 5 jobs done/);
  assert.equal(run.working()?.woke?.why, "failed");
});

test("A11-245: a CI run that concludes failure wakes the worker with the conclusion", async () => {
  const codeHost = hostWithRun({ status: "completed", conclusion: "failure" });
  const prompts = await promptsAfter(await waitingRun([{ ciRun: `${REPO}#9` }], { codeHost }), 5);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /^Your wait failed: CI run a11ign\/agent-org#9 \(ci\) concluded failure: https:\/\/github\.com\/a11ign\/agent-org\/actions\/runs\/9\./);
});

test("A11-245: a pull request closed without merging, and a canceled ticket, each wake the worker once with the reason", async () => {
  const codeHost = createFakeCodeHost();
  const { url } = codeHost.seedPull(REPO, 7, { state: "closed" });
  const closed = await waitingRun([{ pullRequest: url, until: "merged" }], { codeHost });
  await closed.passes(5);
  assert.deepEqual(closed.prompts().map((text) => text.slice(0, 90)), [`Your wait failed: pull request ${url} was closed without merging. All of it: pull request`.slice(0, 90)]);
  const canceled = await waitingRun([{ ticket: "A11-9", until: "done" }], { types: new Map([["A11-9", "canceled"]]) });
  await canceled.passes(5);
  assert.equal(canceled.prompts().length, 1);
  assert.match(canceled.prompts()[0], /^Your wait failed: ticket A11-9 is canceled\./);
});

test("A11-245: an item the board cannot read is pending and never a failure: the card says why, and nothing is sent", async () => {
  const run = await waitingRun([{ fleetJob: "fj-1" }], { fleet: () => { throw new Error("fleet job status fj-1 failed: ssh: connection refused"); } });
  await run.passes(5);
  assert.deepEqual(run.prompts(), []);
  assert.equal(run.note()?.text, `Waiting on fleet job fj-1 (could not read it: fleet job status fj-1 failed: ssh: connection refused)${dueOf(run)}`);
  assert.deepEqual([run.note()?.stalled, run.note()?.waiting], [false, true]);
});

test("A11-245: a wait still pending at `until` is prompted once with each item's progress, from a reading taken at or after it, never again, and stalled after tickets.stallMinutes with the items named", async () => {
  const until = new Date(T0 + 10 * MIN).toISOString();
  const run = await waitingRun([{ fleetJob: "fj-1" }], { until });
  await run.passes(9);
  assert.deepEqual(run.prompts(), [], "inside until");
  await run.pass();
  assert.deepEqual(run.prompts(), [], "at until the last reading is from before it: the board waits for one taken at or after");
  await run.pass();
  assert.equal(run.prompts().length, 1);
  assert.match(run.prompts()[0], new RegExp(`^Your wait passed its deadline \\(${until.replace(/[.]/g, "\\.")}\\) with these still pending: fleet job fj-1 is running, 4 of 6 pages\\. Check them`));
  assert.deepEqual([run.working()?.woke?.why, run.working()?.stalled], ["late", undefined], "woken, not stalled yet");
  await run.passes(29);
  assert.equal(run.working()?.stalled, undefined, "inside the grace that follows the prompt");
  await run.passes(30);
  assert.equal(run.prompts().length, 1, "no second prompt however long it idles");
  assert.equal(run.working()?.stalled, true);
  assert.equal(run.working()?.stallReason, `waited past ${until} on fleet job fj-1`);
  assert.equal(run.note()?.text, `Stalled: waited past ${until} on fleet job fj-1 since it said: waiting for the capture`);
});

test("A11-245: a newer working outcome after a late prompt clears the stall and gets a fresh deadline and a fresh wake", async () => {
  const until = new Date(T0 + 5 * MIN).toISOString();
  const run = await waitingRun([{ fleetJob: "fj-1" }], { until });
  await run.passes(40);
  assert.equal(run.working()?.stalled, true);
  await run.write({ kind: "working", reason: "still capturing, a longer wait", waitingOn: [{ fleetJob: "fj-1" }], until: new Date(run.now() + 3 * HOUR).toISOString() });
  assert.deepEqual([run.working()?.stalled, run.working()?.woke, run.working()?.waiting], [undefined, undefined, true], "a fresh note: not stalled, not yet woken, waiting");
  await run.passes(30);
  assert.equal(run.prompts().length, 1, "still only the first prompt: its new deadline is hours away");
});

test("A11-245: the card reads Waiting on fleet job fj-1 (4 of 6 pages, about 20 min), not Stalled, including after the run has idled past tickets.stallMinutes", async () => {
  const run = await waitingRun([{ fleetJob: "fj-1" }], { fleet: (now) => job("running", { estimatedFinish: new Date(now + 20 * MIN).toISOString() }) });
  await run.pass();
  const text = `Waiting on fleet job fj-1 (4 of 6 pages, about 20 min)${dueOf(run)}`;
  assert.deepEqual(run.note(), { text, stalled: false, waiting: true });
  await run.passes(40);
  assert.deepEqual(run.note(), { text, stalled: false, waiting: true }, "40 minutes idle, past the 30-minute stall: still waiting");
  assert.equal(run.working()?.stalled, undefined);
});

test("A11-245: a declared wait ignores the pane: with no background work shown, it is not marked 'background work gone' and the worker is not prompted for it", async () => {
  const run = await waitingRun([{ fleetJob: "fj-1" }]);
  await run.passes(10);
  assert.deepEqual([run.working()?.stalled, run.working()?.stallReason, run.working()?.resumed, run.working()?.noBackgroundSince], [undefined, undefined, undefined, undefined]);
  assert.deepEqual(run.prompts(), [], "ten minutes on an empty pane: A11-85 would have prompted it after three");
});

test("A11-245: one read per unfinished item per minute, a finished item is not read again, and nothing is read while the agent works", async () => {
  const codeHost = hostWithRun();
  const run = await waitingRun([{ fleetJob: "fj-1" }, { ciRun: `${REPO}#9` }], { fleet: () => job("done"), codeHost });
  const first = [run.fleetAsked.length, codeHost.ciRuns.asked.length];
  assert.deepEqual(first, [1, 1], "one read of each, when the wait was first seen");
  await run.pass(10_000);
  await run.pass(10_000);
  assert.deepEqual([run.fleetAsked.length, codeHost.ciRuns.asked.length], [1, 1], "no second read inside a minute");
  await run.pass(MIN);
  await run.pass(MIN);
  assert.deepEqual([run.fleetAsked.length, codeHost.ciRuns.asked.length], [1, 3], "a minute on: the CI run is read again, and the finished job never is");
  run.status.set(NAME, "working");
  await run.pass(5 * MIN);
  await run.pass(5 * MIN);
  assert.deepEqual([run.fleetAsked.length, codeHost.ciRuns.asked.length], [1, 3], "nothing is read while the agent works");
});

test("A11-245: the real exec seam: a stub `fleet` on the PATH answers `job status fj-1 --json`, and one that outlives its timeout is unreadable without holding a tick", async () => {
  const bin = tmpDir("fleet-stub-");
  const script = join(bin, "fleet");
  writeFileSync(script, `#!/bin/sh\n[ "$1 $2 $3 $4" = "job status fj-1 --json" ] || { echo "unexpected: $*" >&2; exit 2; }\n[ -f "${bin}/slow" ] && exec sleep 5\ncat "${bin}/status.json"\n`);
  chmodSync(script, 0o755);
  writeFileSync(join(bin, "status.json"), job("done", { results: "/srv/fleet/jobs/fj-1" }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const via = fleetJobStatusVia({ env, timeoutMs: 300 });
  const woken = await waitingRun([{ fleetJob: "fj-1" }], { fleetJobStatus: via });
  await until(() => woken.prompts().length > 0, () => woken.pass());
  assert.equal(woken.prompts().length, 1);
  assert.match(woken.prompts()[0], /fleet job fj-1 is done; its results are at \/srv\/fleet\/jobs\/fj-1/);
  writeFileSync(join(bin, "slow"), "");
  const slow = await waitingRun([{ fleetJob: "fj-1" }], { fleetJobStatus: via });
  const started = Date.now();
  await slow.pool.tick();
  assert.ok(Date.now() - started < 250, "a tick does not wait for the program");
  await until(() => /could not read it/.test(slow.note()?.text ?? ""), () => slow.pass());
  assert.equal(slow.note()?.text, `Waiting on fleet job fj-1 (could not read it: fleet job status fj-1 did not answer in 0.3 s)${dueOf(slow)}`);
  assert.deepEqual(slow.prompts(), [], "a program that outlives its timeout is pending, not a failure");
});

/** Calls `step` until `done` holds, waiting for real processes between: at most three seconds. */
async function until(done: () => boolean, step: () => Promise<void>): Promise<void> {
  for (let i = 0; i < 60 && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await step();
  }
}

test("A11-245: a worker woken for a finished wait that re-declares the same items, still over, is marked stalled, and the board wakes it no more", async () => {
  let state = job("done", { results: "/srv/fleet/jobs/fj-1" });
  const run = await waitingRun([{ fleetJob: "fj-1" }], { fleet: () => state });
  await run.passes(4);
  assert.equal(run.prompts().length, 1);
  run.status.set(NAME, "working");
  await run.pass();
  await run.write({ kind: "working", reason: "waiting again, for the same job", waitingOn: [{ fleetJob: "fj-1" }] });
  assert.equal(run.working()?.repeat, true);
  await run.passes(5);
  assert.equal(run.prompts().length, 1, "no second wake for the repeat");
  assert.equal(run.working()?.stalled, true);
  assert.equal(run.working()?.stallReason, "re-declared a wait that had already ended: fleet job fj-1");
  await run.write({ kind: "working", reason: "and again", waitingOn: [{ fleetJob: "fj-1" }] });
  await run.passes(5);
  assert.deepEqual([run.prompts().length, run.working()?.repeat], [1, true], "a second identical rewrite is a repeat too, and is not woken");
  state = job("running");
  await run.write({ kind: "working", reason: "a different job now", waitingOn: [{ fleetJob: "fj-2" }] });
  assert.equal(run.working()?.repeat, undefined, "a different item is a new wait");
});

test("A11-245: a CI run that failed and is rerun under the same ID, declared again, is an ordinary wait: not stalled, and the worker is woken when the rerun ends", async () => {
  const codeHost = hostWithRun({ status: "completed", conclusion: "failure" });
  const run = await waitingRun([{ ciRun: `${REPO}#9` }], { codeHost });
  await run.passes(4);
  assert.equal(run.prompts().length, 1, "woken for the failure");
  codeHost.ciRuns.runs.set(`${REPO}#9`, ciRun());
  run.status.set(NAME, "working");
  await run.pass();
  await run.write({ kind: "working", reason: "reran the failed jobs, waiting again", waitingOn: [{ ciRun: `${REPO}#9` }] });
  await run.passes(4);
  assert.deepEqual([run.working()?.stalled, run.working()?.repeat, run.working()?.waiting], [undefined, undefined, true], "the rerun is pending: a wait like any other");
  assert.equal(run.prompts().length, 1, "and nothing more is sent while it runs");
  codeHost.ciRuns.runs.set(`${REPO}#9`, ciRun({ status: "completed", conclusion: "success" }));
  await run.passes(4);
  assert.equal(run.prompts().length, 2, "woken once more when the rerun ends");
  assert.match(run.prompts()[1], /concluded success/);
});

test("A11-236: an undeclared wait past its bound whose wake prompt herdr keeps refusing is tried three times and then stalled with the refusal", async () => {
  const run = await waitingRun("the capture shells", { until: new Date(T0 + 5 * MIN).toISOString() });
  run.refuse.left = 99;
  await run.passes(12);
  assert.equal(run.refuse.tried, 3, "three tries and no more");
  assert.match(run.working()?.stallReason ?? "", /^could not wake the worker: .*the pane is busy/);
});

test("A11-245: a prompt herdr refuses is offered again on the next pass and recorded as sent only once it is taken; refused three times, the run is stalled with the refusal", async () => {
  const flaky = await wokenRefusing(1, 5);
  assert.equal(flaky.refuse.tried, 2, "refused once, taken the second time");
  assert.equal(flaky.prompts().length, 1);
  const stuck = await wokenRefusing(99, 8);
  assert.equal(stuck.refuse.tried, 3, "tried three times and no more");
  assert.deepEqual(stuck.prompts(), []);
  assert.equal(stuck.working()?.stalled, true);
  assert.match(stuck.working()?.stallReason ?? "", /^could not wake the worker: .*the pane is busy/);
});
