// no-token: gh -- herdr, the code host, the reviewer and the clock are injected fakes; nothing is spawned
// A11-306: a worker ends its round at the push and the board does what the worker waited for. A red required check after the run ended starts a round, a green head with no review stays watched and gets
// its reviewer within 2 minutes of its checks going green, and the watch logs how long after the checks were first read green the reviewer started.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeReviewer } from "../plugins/fakes/reviewer.ts";
import type { PullFeedback } from "../plugins/contracts/code-host.ts";
import { isWatched, workStatus } from "./board-view/pull-status-and-notes.ts";
import { poolFixture } from "./pool-fixture.ts";
import { REVIEW_START_LIMIT_MS } from "./pool-reviewers.ts";
import type { Outcome } from "./queue/queue-entries-and-outcomes.ts";
import { loadReviewerGate, readReviewerMemory, REVIEWER_LOGIN, reviewerMemoryPath } from "./reviewer-port.ts";
import { REVIEW_START_MS } from "./server.ts";
import { ticketDir } from "./ticket-paths.ts";

const REPO = "a11ign/nbl-ui-netbox";
const HEAD = "h1";
const SECOND = 1000;
const MINUTE = 60_000;
const WORKERS = "worker-bot";
const SUITE_JOB = "https://github.com/a11ign/nbl-ui-netbox/actions/runs/410/job/41";
const stamped = (lines: string[]) => lines.map((line) => `2026-10-26T18:00:00.1234567Z ${line}`).join("\n");
const SUITE_LOG = stamped(["not ok 3 - the push is the end of the round", "AssertionError: expected 1 to equal 2", "##[error]Process completed with exit code 1."]);

/** Lets what the pool started and did not wait for (the round a watch queued and the tick it kicked) finish. */
const settled = async (): Promise<void> => { for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve)); };

/** Run `act` with the board's log captured, and return the lines it wrote. */
async function captured(act: () => Promise<void>): Promise<string[]> {
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    await act();
  } finally {
    process.stderr.write = write;
  }
  return written;
}

/**
 * NBF-1 as the board holds it once its worker pushed and ended: finished, `ready-pr`, holding pull request 1 at `HEAD`, which is open with `settled` checks and the feedback `feedback`. The reviewer is on, and the clock is `clock.ms`.
 */
async function endedRun({ settled: green = true, feedback = {}, withRun = true }: { settled?: boolean; feedback?: Partial<PullFeedback>; withRun?: boolean } = {}) {
  await loadReviewerGate();
  const clock = { ms: 0 };
  const fixture = poolFixture({ keys: ["NBF-1"], tickets: { reviewer: "atomic", drafts: false }, now: () => clock.ms });
  const host = createFakeCodeHost(WORKERS);
  host.checksAndClaims.logs.set(SUITE_JOB, SUITE_LOG);
  const { url } = host.seedPull(REPO, 1, { head: HEAD, settled: green, trust: "inside", feedback });
  const reviewer = createFakeReviewer();
  await reviewer.load();
  if (withRun) {
    const queue = fixture.store.get();
    const outcome = { kind: "ready-pr", prs: [{ repo: "nbl-ui-netbox", url }] } as Outcome;
    fixture.store.set({ ...queue, entries: [{ ...queue.entries[0], phase: "finished", finishedAt: clock.ms, outcome, pullStates: { [url]: "open" } }] });
  }
  const pool = fixture.restart({ codeHost: host, reviewer });
  const pull = host.pullAt(url)!;
  const entry = () => fixture.store.get().entries[0];
  return { clock, fixture, host, reviewer, pool, pull, url, entry };
}

/** A green head whose first look found the host refusing to start a reviewer, so the head stays green and unreviewed. */
async function refusedAtFirstLook() {
  const run = await endedRun({ withRun: false });
  run.reviewer.refuseWith("no seat is free for a reviewer");
  await captured(async () => { await run.pool.reviewNewHeads(); });
  return run;
}

/** The full sweep `later` ms after the host stopped refusing to start a reviewer: the lines it logged. */
async function sweptAfterRefusal(run: Awaited<ReturnType<typeof refusedAtFirstLook>>, later: number): Promise<string[]> {
  run.reviewer.refuseWith(null);
  run.clock.ms += later;
  return captured(async () => { await run.pool.reviewNewHeads(); });
}

/** The feedback of a pull request whose required check `suite (1)` is red at `HEAD`. */
const SUITE_RED: Partial<PullFeedback> = { failing: ["suite (1)"], failures: [{ name: "suite (1)", detailsUrl: SUITE_JOB }] };

test("A11-306: a required check that goes red after the run ended starts a round, and the round's brief carries the failure", async () => {
  const run = await endedRun({ settled: false, feedback: { pendingRequired: ["suite (1)"] } });
  await run.pool.watchFeedback();
  await settled();
  assert.deepEqual([run.entry().phase, run.entry().rounds ?? 0], ["finished", 0], "CI still running when the run ended: the worker is not woken, and it did not wait");
  run.pull.feedback = SUITE_RED;
  run.clock.ms += 5 * MINUTE;
  await run.pool.watchFeedback();
  await settled();
  assert.deepEqual([run.entry().phase, run.host.checksAndClaims.reruns], ["finished", [[SUITE_JOB]]], "the red check is rerun first (A11-300), and no worker is asked yet");
  run.clock.ms += 3 * MINUTE;
  await run.pool.watchFeedback();
  await settled();
  const woken = run.entry();
  assert.notEqual(woken.phase, "finished", "red again after the rerun: the run is woken");
  assert.equal(woken.rounds, 1);
  assert.match(woken.feedback ?? "", new RegExp(`^suite \\(1\\) failed on the head commit of ${run.url.replace(/[./]/g, "\\$&")}:$`, "m"));
  assert.match(woken.feedback ?? "", /^  not ok 3 - the push is the end of the round$/m, "the failing test");
  assert.match(woken.feedback ?? "", /^  AssertionError: expected 1 to equal 2$/m, "and its error line");
  assert.match(readFileSync(join(ticketDir(run.fixture.settings, "NBF-1"), "brief.md"), "utf8"), /^>   AssertionError: expected 1 to equal 2$/m, "the round's brief quotes the log");
});

test("A11-306: a required check that was already red when the run ended starts a round too: the run left, the board did not", async () => {
  const run = await endedRun({ feedback: SUITE_RED });
  await run.pool.watchFeedback();
  await settled();
  assert.deepEqual([run.entry().phase, run.host.checksAndClaims.reruns], ["finished", [[SUITE_JOB]]], "rerun first");
  await run.pool.watchFeedback();
  await settled();
  assert.notEqual(run.entry().phase, "finished");
  assert.match(run.entry().feedback ?? "", /^suite \(1\) failed on the head commit of /m);
});

test("A11-306: a green head with no review stays watched, gets its reviewer from the watch, and starts no round until the review has findings", async () => {
  const run = await endedRun({ feedback: { pendingRequired: [] } });
  assert.equal(workStatus(run.entry()), "awaiting-review");
  assert.equal(isWatched(run.entry()), true, "watched before anything is read");
  await run.pool.watchFeedback();
  await settled();
  assert.deepEqual(run.reviewer.started, [{ pr: run.url, head: HEAD }], "the reviewer is started for the green head");
  assert.deepEqual([run.entry().phase, run.entry().rounds ?? 0, isWatched(run.entry())], ["finished", 0, true], "and the run is still watched, with no round: nothing is red and nothing is reviewed yet");
  run.clock.ms += 10 * MINUTE;
  await run.pool.watchFeedback();
  await settled();
  assert.deepEqual([run.entry().phase, isWatched(run.entry()), run.reviewer.started.length], ["finished", true, 1], "still watched while the reviewer works, and not started twice");
  run.pull.reviews = [{ author: REVIEWER_LOGIN, state: "CHANGES_REQUESTED", commit: HEAD, at: run.clock.ms }];
  await run.pool.watchFeedback();
  await settled();
  assert.notEqual(run.entry().phase, "finished", "the review's findings wake the run");
  assert.match(run.entry().feedback ?? "", new RegExp(`${REVIEWER_LOGIN} requested changes on `));
});

test("A11-306: the reviewer starts within 2 minutes of the required checks going green, however the sweep falls on the green", async () => {
  assert.ok(REVIEW_START_MS * 2 <= REVIEW_START_LIMIT_MS, "a head read green at the first sweep after it went green is started in that sweep: the cadence leaves room for a sweep that is late");
  for (const greenAfter of [0, 1, 30 * SECOND, 59 * SECOND, 60 * SECOND, 61 * SECOND, 90 * SECOND, 119 * SECOND, 5 * MINUTE + 17 * SECOND]) {
    const run = await endedRun({ settled: false, withRun: false });
    let startedAt: number | null = null;
    // The server's sweep of green heads, on its cadence, for as long as it takes: the head's checks go green `greenAfter` ms into it.
    for (run.clock.ms = 0; startedAt === null && run.clock.ms <= 20 * MINUTE; run.clock.ms += REVIEW_START_MS) {
      run.pull.settled = run.clock.ms >= greenAfter;
      await run.pool.startGreenReviewers();
      if (run.reviewer.started.length > 0) startedAt = run.clock.ms;
    }
    assert.notEqual(startedAt, null, `green after ${greenAfter} ms: the reviewer started`);
    assert.ok(startedAt! - greenAfter <= REVIEW_START_LIMIT_MS, `green after ${greenAfter} ms: started at ${startedAt}, ${startedAt! - greenAfter} ms after the green`);
    assert.equal(run.reviewer.started.length, 1, "once");
    await run.pool.reviewNewHeads();
    await run.pool.startGreenReviewers();
    assert.equal(run.reviewer.started.length, 1, "and the full sweep and the next look start no second one");
  }
});

test("A11-306: the watch logs how long after the checks were first read green the reviewer started, and says so when that is past 2 minutes", async () => {
  const prompt = await endedRun({ withRun: false });
  const promptLog = await captured(async () => { await prompt.pool.startGreenReviewers(); });
  assert.equal(promptLog.filter((line) => line.includes("the reviewer started 0 s after the checks of h1 were first read green")).length, 1, `a start at the look that read the green: ${promptLog.join("")}`);
  assert.equal(promptLog.some((line) => line.includes("later than")), false, "and it is not late");

  const refused = await endedRun({ withRun: false });
  refused.reviewer.refuseWith("no seat is free for a reviewer");
  const first = await captured(async () => { await refused.pool.startGreenReviewers(); });
  assert.equal(first.some((line) => line.includes("the reviewer started")), false, "a start the host refused is no start");
  refused.reviewer.refuseWith(null);
  refused.clock.ms += 7 * MINUTE + 30 * SECOND;
  assert.equal((await captured(async () => { await refused.pool.startGreenReviewers(); })).some((line) => line.includes("the reviewer started")), false, "a head whose start was refused is left to the full sweep");
  const late = await captured(async () => { await refused.pool.reviewNewHeads(); });
  assert.equal(late.filter((line) => line.includes("the reviewer started 450 s after the checks of h1 were first read green, later than the 2 minutes it is to start within")).length, 1, late.join(""));

  const again = await captured(async () => { await refused.pool.reviewNewHeads(); });
  assert.equal(again.some((line) => line.includes("the reviewer started")), false, "said once for the head");
});

test("A11-306: a head read green, then red, then green again is counted from its second green, and a head a push replaced is forgotten", async () => {
  const run = await refusedAtFirstLook();
  run.pull.settled = false;
  run.clock.ms += 10 * MINUTE;
  await captured(async () => { await run.pool.reviewNewHeads(); });
  run.pull.settled = true;
  const logged = await sweptAfterRefusal(run, 5 * SECOND);
  assert.equal(logged.filter((line) => line.includes("the reviewer started 0 s after the checks of h1 were first read green") && !line.includes("later than")).length, 1, `the first green was forgotten when the checks went red: ${logged.join("")}`);

  const replaced = await refusedAtFirstLook();
  replaced.pull.head = "h2";
  const next = await sweptAfterRefusal(replaced, 10 * MINUTE);
  assert.equal(next.filter((line) => line.includes("the reviewer started 0 s after the checks of h2 were first read green")).length, 1, `the new head is counted from its own green: ${next.join("")}`);
});

test("A11-306: the early look starts first reviews only: it counts no refusal toward a person, re-posts no verdict and prompts no reviewer", async () => {
  const run = await endedRun({ withRun: false });
  run.reviewer.refuseWith('herdr refused to start "reviewer-1": no seat is free');
  await captured(async () => { await run.pool.startGreenReviewers(); });
  await captured(async () => { await run.pool.startGreenReviewers(); });
  assert.equal(run.reviewer.started.length, 0);
  assert.equal(run.fixture.store.get().entries.length, 1);
  const memory = readReviewerMemory(reviewerMemoryPath(run.fixture.settings.stateDir)).memory;
  assert.deepEqual([...memory.refusals.keys()], [], "herdr's refusal at the early look is not counted: the count of A11-241 stays one per full sweep");
  await captured(async () => { await run.pool.reviewNewHeads(); });
  const counted = readReviewerMemory(reviewerMemoryPath(run.fixture.settings.stateDir)).memory;
  assert.deepEqual([...counted.refusals.values()].map(({ count }) => count), [1], "and the full sweep counts it as it did");

  const working = await endedRun({ withRun: false });
  await working.pool.startGreenReviewers();
  working.reviewer.wrote({ pr: working.url, head: HEAD }, null);
  working.clock.ms += 10 * MINUTE;
  await working.pool.startGreenReviewers();
  await working.pool.startGreenReviewers();
  assert.deepEqual([working.reviewer.reprompted.length, working.reviewer.reposted.length], [0, 0], "a reviewer that ended with no verdict file is the full sweep's to prompt, once per look of its own");
});

test("A11-306: a head whose checks have not settled gets no reviewer and no gap is logged for it", async () => {
  const run = await endedRun({ settled: false, withRun: false });
  const logged = await captured(async () => { await run.pool.startGreenReviewers(); });
  assert.deepEqual([run.reviewer.started.length, logged.some((line) => line.includes("first read green"))], [0, false]);
});
