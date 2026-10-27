// no-token: gh -- herdr, the tracker and the clock are all injected; nothing is spawned
// A11-345: a run that crashes on a transient network error is started again by the board, after a back-off, twice at most; on 2026-10-27 A11-343 and A11-344 crashed on `fetch failed` and stayed crashed until a person retried them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runStatus } from "./board-view/pull-status-and-notes.ts";
import { CRASH_RETRIES } from "./crash-retry.ts";
import { poolFixture } from "./pool-fixture.ts";
import { messageOf } from "./pool-state.ts";
import { retry } from "./queue/queue-entries-and-outcomes.ts";
import { adoptCrashed } from "./queue/queue-readopt.ts";
import { finishCrashed } from "./pool-crash-retry.ts";
import { logOf } from "./queue/run-log.ts";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
import type { TicketSource } from "./source.ts";

const KEY = "NBF-1";
const HOUR = 3_600_000;
const START = Date.now() + HOUR;
const FIRST_WAIT = 30_000;
const SECOND_WAIT = 120_000;
const staleSocket = () => new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });

/**
 * NBF-1 queued over a tracker whose read of the ticket throws `failure` while `failing.on` is set, as Linear's does in a burst of dropped connections. The run's start reads the ticket first, so a failed read crashes the start.
 * `tick(after)` moves the pool's clock `after` milliseconds and runs a pass. `reads` counts the starts that got as far as the read.
 */
async function crashing(failure: () => unknown) {
  const tracker = createFakeTracker([fakeTicket(KEY)]);
  const failing = { on: true };
  const reads = { count: 0 };
  const source: TicketSource = { ...tracker, read: async (key) => {
    if (failing.on && reads.count >= 0) {
      reads.count += 1;
      throw failure();
    }
    return tracker.read(key);
  } };
  const clock = { now: START };
  const made = poolFixture({ keys: [KEY], max: 1, source, now: () => clock.now, tickets: { workingState: "In Progress" } });
  const tick = async (after = 0) => { clock.now += after; await made.pool.tick(); };
  const log = () => logOf(made.store.get(), KEY);
  return { ...made, failing, reads, tick, log, clock };
}

test("a run that crashed on fetch failed is queued again once the back-off has passed, and the retry is on its log", async () => {
  const run = await crashing(staleSocket);
  await run.tick();
  assert.deepEqual([run.entry(KEY).phase, run.entry(KEY).outcome], ["finished", { kind: "crashed", reason: "fetch failed (UND_ERR_SOCKET)" }]);
  assert.equal(run.reads.count, 1);
  await run.tick(FIRST_WAIT - 1);
  assert.equal(run.reads.count, 1, "the back-off is not over, so the run is not started again");
  assert.equal(run.log().some((event) => event.kind === "requeued"), false);
  run.failing.on = false;
  await run.tick(1);
  assert.equal(run.log().filter((event) => event.kind === "requeued" && event.why === "crash-retry").length, 1, "the retry is logged");
  assert.notEqual(run.entry(KEY).phase, "finished", "started again");
  assert.notEqual(run.entry(KEY).outcome?.kind, "crashed");
});

test("a third transient crash is not retried: the run stays crashed, reads Failed with its reason, and the tracker was read three times", async () => {
  const run = await crashing(staleSocket);
  await run.tick();
  await run.tick(FIRST_WAIT);
  assert.equal(run.reads.count, 2, "the first retry");
  await run.tick(SECOND_WAIT - 1);
  assert.equal(run.reads.count, 2, "the second back-off is longer, and not over");
  await run.tick(1);
  assert.equal(run.reads.count, 3, "the second retry");
  assert.equal(run.entry(KEY).phase, "finished");
  assert.equal(CRASH_RETRIES, 2);
  await run.tick(HOUR);
  await run.tick(HOUR);
  assert.equal(run.reads.count, 3, "no third retry, however long it waits");
  assert.deepEqual(run.entry(KEY).outcome, { kind: "crashed", reason: "fetch failed (UND_ERR_SOCKET)" });
  assert.equal(runStatus(run.entry(KEY)), "failed");
  assert.equal(run.log().filter((event) => event.kind === "requeued" && event.why === "crash-retry").length, 2);
});

test("a crash for any other reason is not retried", async () => {
  for (const failure of [() => new Error("the plan could not be read"), () => new TypeError("Failed to parse URL"), () => Object.assign(new Error("Linear answered 400: invalid"), { status: 400 })]) {
    const run = await crashing(failure);
    await run.tick();
    assert.equal(run.entry(KEY).outcome?.kind, "crashed");
    assert.equal(run.entry(KEY).crashRetry, undefined, "no retry is scheduled");
    await run.tick(HOUR);
    assert.equal(run.reads.count, 1);
    assert.equal(run.log().some((event) => event.kind === "requeued"), false);
  }
});

test("each kind of transient error is retried: fetch failed, ECONNRESET, ETIMEDOUT, EAI_AGAIN, an undici code and a 5xx", async () => {
  const coded = (code: string) => () => Object.assign(new Error(`${code}`), { code });
  for (const failure of [() => new TypeError("fetch failed"), coded("ECONNRESET"), coded("ETIMEDOUT"), coded("EAI_AGAIN"), coded("UND_ERR_CONNECT_TIMEOUT"), () => Object.assign(new Error("Linear answered 502"), { status: 502 })]) {
    const run = await crashing(failure);
    await run.tick();
    await run.tick(FIRST_WAIT);
    assert.equal(run.reads.count, 2, String(failure().message));
  }
});

test("a person's Retry gives a run that used its retries a fresh set", async () => {
  const run = await crashing(staleSocket);
  await run.tick();
  await run.tick(FIRST_WAIT);
  await run.tick(SECOND_WAIT);
  assert.equal(run.reads.count, 3);
  run.store.set(retry(run.store.get(), KEY, run.clock.now));
  assert.equal(run.entry(KEY).crashRetry, undefined);
  await run.tick();
  assert.equal(run.reads.count, 4, "started by the person's retry");
  await run.tick(FIRST_WAIT);
  assert.equal(run.reads.count, 5, "and retried by the board again");
});

test("the board's log line for a network error names the code under it", () => {
  assert.equal(messageOf(staleSocket()), "fetch failed (UND_ERR_SOCKET)");
  assert.equal(messageOf(new TypeError("fetch failed")), "fetch failed", "no cause, no code");
  assert.equal(messageOf(new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) })), "fetch failed (ECONNRESET)");
  assert.equal(messageOf(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })), "ENOENT: no such file", "an error's own code is not added");
  assert.equal(messageOf("plain"), "plain");
});

/** NBF-1 over a tracker whose move to the working state and claim throw `failure` for their first `failures` tries, as Linear's do in a burst of dropped connections. Returns the tries of each. */
async function startWrites(failures: number, failure: unknown) {
  const tracker = createFakeTracker([fakeTicket(KEY)]);
  const tries = { move: 0, claim: 0 };
  const source: TicketSource = { ...tracker,
    moveToWorkingState: async (key, state) => { tries.move += 1; if (tries.move <= failures) throw failure; return tracker.moveToWorkingState!(key, state); },
    claim: async (key, claimant) => { tries.claim += 1; if (tries.claim <= failures) throw failure; return tracker.claim!(key, claimant); } };
  const made = poolFixture({ keys: [KEY], max: 1, source, now: () => START, tickets: { workingState: "In Progress" } });
  await made.pool.tick();
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  return { ...made, tracker, tries };
}

test("a tracker write at a run's start that fails on the network is tried again, and the run is not crashed by it", async () => {
  const run = await startWrites(2, staleSocket());
  assert.deepEqual(run.tries, { move: 3, claim: 3 });
  assert.equal(run.tracker.ticketOf(KEY)?.status, "In Progress", "the ticket was moved at the third try");
  assert.deepEqual(run.tracker.claimed.map(({ key }) => key), [KEY]);
  assert.equal(run.entry(KEY).phase, "running");
  assert.equal(run.entry(KEY).outcome, undefined);
});

test("a tracker write at a run's start that the tracker refuses is not tried again, and the run still starts", async () => {
  const run = await startWrites(1, Object.assign(new Error("Linear answered 400: invalid"), { status: 400 }));
  assert.deepEqual(run.tries, { move: 1, claim: 1 });
  assert.equal(run.entry(KEY).phase, "running");
});

test("a tracker write at a run's start that keeps failing on the network gives up after three tries, and the run still starts", async () => {
  const run = await startWrites(10, staleSocket());
  assert.deepEqual(run.tries, { move: 3, claim: 3 });
  assert.equal(run.entry(KEY).phase, "running");
});

test("only a run that is still starting is retried: one a person stopped, or that a drain queued again, reads crashed with no retry", async () => {
  const run = await crashing(staleSocket);
  const queued = run.store.get();
  assert.equal(queued.entries[0].phase, "queued");
  assert.equal(finishCrashed(queued, KEY, staleSocket(), START).entries[0].crashRetry, undefined, "queued again mid-start");
  await run.tick();
  const crashedRun = run.store.get();
  assert.equal(crashedRun.entries[0].crashRetry?.count, 1, "the start that failed is retried");
});

test("a crashed run the board finds working again loses its scheduled retry", async () => {
  const run = await crashing(staleSocket);
  await run.tick();
  assert.equal(run.entry(KEY).crashRetry?.retryAt, START + FIRST_WAIT);
  run.store.set(adoptCrashed(run.store.get(), KEY, "w1", "w1:p1", START + 1));
  assert.equal(run.entry(KEY).crashRetry?.retryAt, undefined);
  await run.tick(HOUR);
  assert.equal(run.reads.count, 1, "not queued again under its own pane");
});
