// no-token: gh -- herdr, the tracker and the clock are injected; nothing is spawned
// A11-298: the tick records which ticket each queued run waits on and since when, so a wait of hours on the same one is listed
import { test } from "node:test";
import assert from "node:assert/strict";
import { poolFixture } from "./pool-fixture.ts";
import { longWaits, longWaitSentence } from "./board-view/long-waits.ts";

const HOLDER = "NBF-1";
const WAITER = "NBF-2";
const FILES = ["lab:middleware/package.json"];
const T0 = Date.UTC(2026, 9, 25, 13, 0, 0);
const HOUR = 60 * 60_000;

/** NBF-1 and NBF-2 queued on the same files, the clock a test moves, and the pool over them. */
function world() {
  const clock = { now: T0 };
  const made = poolFixture({ keys: [HOLDER, WAITER], now: () => clock.now, max: 3 });
  made.store.set({ ...made.store.get(), entries: made.store.get().entries.map((entry) => ({ ...entry, paths: FILES, blockers: [] })) });
  return { ...made, clock };
}

test("A11-298: a run held three hours behind the same ticket is listed with what it waits on, and the wait began at the first tick that saw it", async () => {
  const made = world();
  await made.pool.tick();
  assert.ok(["starting", "running"].includes(made.entry(HOLDER).phase));
  assert.deepEqual(made.entry(WAITER).waitSince, { on: HOLDER, since: T0 });
  made.clock.now += 3 * HOUR;
  await made.pool.tick();
  assert.equal(made.entry(WAITER).waitSince?.since, T0, "the same holder: the wait goes on from the first tick");
  const [wait, ...rest] = longWaits(made.store.get().entries, made.clock.now);
  assert.equal(rest.length, 0);
  assert.equal(longWaitSentence(wait, made.clock.now), "NBF-2 has waited 3 h 0 min on NBF-1's files: NBF-1 is In progress, so it can move by itself.");
});

test("A11-298: a run held for less than two hours is not listed, and a run that starts has no wait recorded", async () => {
  const made = world();
  await made.pool.tick();
  made.clock.now += HOUR;
  await made.pool.tick();
  assert.deepEqual(longWaits(made.store.get().entries, made.clock.now), []);
  made.store.set({ ...made.store.get(), entries: made.store.get().entries.map((entry) => (entry.ticket.key === HOLDER ? { ...entry, paths: [], phase: "finished" as const, outcome: { kind: "checked" as const, reason: "x" } } : entry)) });
  await made.pool.tick();
  assert.ok(["starting", "running"].includes(made.entry(WAITER).phase));
  assert.equal(made.entry(WAITER).waitSince, undefined);
});
