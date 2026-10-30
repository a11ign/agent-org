// no-token: gh -- herdr, the tracker, the call ledger and the clock are all injected; nothing is spawned
// A11-399: a run that crashed on transient network errors past its retries is started again once the board's own network calls succeed; on 2026-10-28 A11-231 crashed three times in an outage and stayed crashed for two days.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RECOVERY_RESTARTS, RECOVERY_WINDOW_MS } from "./crash-retry.ts";
import { poolFixture } from "./pool-fixture.ts";
import { logOf } from "./queue/run-log.ts";
import { replace } from "./queue/queue-entries-and-outcomes.ts";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
import type { TicketSource } from "./source.ts";

const KEY = "NBF-1";
const MIN = 60_000;
const HOUR = 3_600_000;
const START = Date.now() + HOUR;
const FIRST_WAIT = 30_000;
const SECOND_WAIT = 120_000;
const FIRST_RECOVERY = 10 * MIN;
const SECOND_RECOVERY = 30 * MIN;
const THIRD_RECOVERY = 2 * HOUR;
const reset = () => new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
const socket = () => new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });

/** NBF-1 queued over a tracker whose read of the ticket throws what `failures()` gives while `failing.on` is set. `tick(after)` moves the pool's clock and runs a pass; `reads` counts the starts that got as far as the read. */
async function crashing(failures: () => unknown = reset) {
  const tracker = createFakeTracker([fakeTicket(KEY)]);
  const failing = { on: true };
  const reads = { count: 0 };
  const source: TicketSource = { ...tracker, read: async (key) => {
    if (failing.on) {
      reads.count += 1;
      throw failures();
    }
    return tracker.read(key);
  } };
  const clock = { now: START };
  const made = poolFixture({ keys: [KEY], max: 1, source, now: () => clock.now, tickets: { workingState: "In Progress" } });
  const tick = async (after = 0) => { clock.now += after; await made.pool.tick(); };
  const requeues = (why: string) => logOf(made.store.get(), KEY).filter((event) => event.kind === "requeued" && event.why === why).length;
  /** `after` milliseconds on, the board's Linear and GitHub calls both answer, and a pass runs. */
  const networkBack = async (after: number) => {
    clock.now += after;
    made.calls.record("linear", false);
    made.calls.record("github", false);
    await made.pool.tick();
  };
  return { ...made, failing, reads, tick, requeues, clock, networkBack };
}

/** A11-231: three transient crashes (ECONNRESET, UND_ERR_SOCKET, ECONNRESET), the retries used up. */
async function crashedThrice() {
  const causes = [reset, socket, reset];
  let crash = 0;
  const run = await crashing(() => causes[Math.min(crash++, causes.length - 1)]());
  await run.tick();
  await run.tick(FIRST_WAIT);
  await run.tick(SECOND_WAIT);
  assert.equal(run.reads.count, 3);
  assert.equal(run.entry(KEY).phase, "finished");
  return run;
}

test("A11-231: three transient crashes, the network recovers, and the run starts again", async () => {
  const run = await crashedThrice();
  assert.equal(run.entry(KEY).crashRetry?.recovery?.notBefore, run.clock.now + FIRST_RECOVERY, "marked for the first recovery back-off");
  run.failing.on = false;
  await run.networkBack(FIRST_RECOVERY);
  assert.equal(run.requeues("network-recovered"), 1, "the restart is on the run's log");
  assert.notEqual(run.entry(KEY).phase, "finished", "started again");
  assert.notEqual(run.entry(KEY).outcome?.kind, "crashed");
});

test("a run is not started again before its back-off is over, nor while its network calls fail, nor before one succeeded after the crash", async () => {
  const run = await crashedThrice();
  await run.networkBack(FIRST_RECOVERY - 1);
  assert.equal(run.requeues("network-recovered"), 0, "the back-off is not over");
  run.clock.now += 1;
  run.calls.record("linear", true);
  await run.tick();
  assert.equal(run.requeues("network-recovered"), 0, "the back-off is over, but the latest call to Linear failed");
  await run.networkBack(1);
  assert.equal(run.requeues("network-recovered"), 1, "the calls succeed again");
});

test("a good call from before the crash is no evidence that the network is back", async () => {
  const run = await crashing();
  run.calls.record("linear", false);
  await run.tick(1);
  await run.tick(FIRST_WAIT);
  await run.tick(SECOND_WAIT);
  assert.equal(run.entry(KEY).phase, "finished");
  await run.tick(FIRST_RECOVERY);
  assert.equal(run.requeues("network-recovered"), 0, "no call has succeeded since the crash");
});

test("a run that crashes again after a restart waits for the next, longer back-off", async () => {
  const run = await crashedThrice();
  await run.networkBack(FIRST_RECOVERY);
  assert.equal(run.requeues("network-recovered"), 1);
  assert.equal(run.entry(KEY).phase, "finished", "the restart crashed again at once, the network failing");
  assert.equal(run.entry(KEY).crashRetry?.count, 2, "the count stays at the cap");
  assert.equal(run.entry(KEY).crashRetry?.recovery?.notBefore, run.clock.now + SECOND_RECOVERY);
  await run.networkBack(SECOND_RECOVERY);
  assert.equal(run.requeues("network-recovered"), 2);
  assert.equal(run.entry(KEY).crashRetry?.recovery?.notBefore, run.clock.now + THIRD_RECOVERY);
});

test("the board starts a run again three times in 24 hours, then waits until the oldest restart ages out", async () => {
  const run = await crashedThrice();
  assert.equal(RECOVERY_RESTARTS, 3);
  const first = run.clock.now + FIRST_RECOVERY;
  for (const wait of [FIRST_RECOVERY, SECOND_RECOVERY, THIRD_RECOVERY]) await run.networkBack(wait);
  assert.equal(run.requeues("network-recovered"), 3);
  await run.networkBack(THIRD_RECOVERY);
  assert.equal(run.requeues("network-recovered"), 3, "a fourth restart within 24 h is refused");
  await run.networkBack(first + RECOVERY_WINDOW_MS - run.clock.now);
  assert.equal(run.requeues("network-recovered"), 4, "the oldest restart has aged out");
});

test("a crash for another reason is not started again, however long the network works", async () => {
  const run = await crashing(() => new Error("the plan could not be read"));
  await run.tick();
  await run.networkBack(RECOVERY_WINDOW_MS);
  assert.equal(run.requeues("network-recovered"), 0);
  assert.equal(run.entry(KEY).crashRetry, undefined);
});

test("a run that used its retries and then ended for another reason carries no recovery and is not started again", async () => {
  const run = await crashedThrice();
  // `end` records a crash such as "its herdr workspace is gone" without `finishCrashed`: the count survives, the recovery mark does not.
  run.store.set(replace(run.store.get(), KEY, (entry) => ({ ...entry, crashRetry: { count: 2 }, outcome: { kind: "crashed", reason: "its herdr workspace is gone" } })));
  await run.networkBack(RECOVERY_WINDOW_MS);
  assert.equal(run.requeues("network-recovered"), 0);
  assert.equal(run.entry(KEY).phase, "finished");
});

test("a run whose ticket was completed or closed meanwhile is left as it is", async () => {
  for (const trackerState of ["completed", "canceled", "duplicate"]) {
    const run = await crashedThrice();
    run.store.set(replace(run.store.get(), KEY, (entry) => ({ ...entry, trackerState })));
    await run.networkBack(FIRST_RECOVERY);
    assert.equal(run.requeues("network-recovered"), 0, trackerState);
  }
});
