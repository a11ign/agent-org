// no-token: gh -- herdr, the tracker and the clock are injected; the pool is driven over fakes
// A11-363: what the pool gives `/api/health` -- the latest run start, the startable entries and free slots, when a fill() pass last completed and why the last one returned early
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import { fillFiguresOf, newFillState, runFiguresOf } from "./health-figures.ts";
import { memoryDrain, poolFixture } from "./pool-fixture.ts";
import { replace } from "./queue/queue-entries-and-outcomes.ts";
import { recordBlockers, recordPaths } from "./queue/queue-transitions.ts";
import type { TicketSource } from "./source.ts";

const ticket = (key: string) => ({ key, title: key, description: "", url: `https://linear.app/x/${key}`, branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 });

/** A tracker whose blockers read throws while `down.on` is set. */
function trackerWithBlockers(down: { on: boolean }): TicketSource {
  const fake = createFakeTracker([ticket("NBF-1"), ticket("NBF-2")] as never);
  return { ...fake, blockers: async () => { if (down.on) throw new Error("fetch failed\n    at somewhere"); return new Map(); } };
}

test("a pass that runs to its end is a completed pass, a run it starts is the latest start, and nothing is startable once everything has started", async () => {
  let clock = 1_000;
  const made = poolFixture({ keys: ["NBF-1", "NBF-2"], max: 3, now: () => clock });
  assert.deepEqual(made.pool.figures().fill, { sinceLastCompletedMs: null, lastEarlyReturn: null }, "no pass yet");
  await made.pool.tick();
  clock = 31_000;
  const figures = made.pool.figures();
  assert.deepEqual(figures.fill, { sinceLastCompletedMs: 30_000, lastEarlyReturn: null });
  assert.deepEqual([figures.runs.sinceLastStartMs, figures.runs.startable, figures.runs.freeSlots, figures.runs.starting], [30_000, 0, 1, 0], "both runs started at 1000; one slot of three is free");
});

test("a pass whose reads of the tracker fail returns early: it is not completed, nothing starts, and the reason is the first line of the failure; the next pass that reads clears it", async () => {
  const down = { on: true };
  let clock = 5_000;
  const made = poolFixture({ keys: ["NBF-1", "NBF-2"], source: trackerWithBlockers(down), now: () => clock });
  await made.pool.tick();
  clock = 9_000;
  assert.deepEqual(made.pool.figures().fill, { sinceLastCompletedMs: null, lastEarlyReturn: { reason: "a read of the tracker or the code host failed: fetch failed", agoMs: 4_000 } });
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => made.entry(key).phase), ["queued", "queued"], "one failed read stopped every start");
  assert.deepEqual([made.pool.figures().runs.startable, made.pool.figures().runs.sinceLastStartMs], [0, null], "entries whose blockers are unread are not startable");
  down.on = false;
  clock = 12_000;
  await made.pool.tick();
  assert.deepEqual(made.pool.figures().fill, { sinceLastCompletedMs: 0, lastEarlyReturn: null }, "completed, and the early return is cleared");
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => made.entry(key).phase), ["running", "running"]);
});

test("queued entries whose blockers and paths are read are startable, and the free slots are the slots no live run holds", () => {
  const made = poolFixture({ keys: ["NBF-1", "NBF-2", "NBF-3"], max: 3, now: () => 100 });
  const read = recordPaths(recordBlockers(made.store.get(), new Map([["NBF-1", []], ["NBF-2", []], ["NBF-3", []]])), new Map([["NBF-1", []], ["NBF-2", []], ["NBF-3", []]]));
  made.store.set(replace(read, "NBF-3", (entry) => ({ ...entry, phase: "running", workspace: "w9", pane: "w9:p1", startedAt: 40 })));
  const { runs } = made.pool.figures();
  assert.deepEqual([runs.startable, runs.freeSlots, runs.sinceLastStartMs, runs.starting], [2, 2, 60, 0]);
});

test("while an update drains the pass completes having started nothing on purpose: it says so, and nothing is startable, so a restart is not asked for", async () => {
  const drain = memoryDrain();
  const made = poolFixture({ keys: ["NBF-1"], drain, now: () => 100 });
  drain.current = { kind: "draining", record: { target: "v0.280.0", since: new Date(0).toISOString(), deadline: new Date(1e12).toISOString(), stopped: [] } };
  await made.pool.tick();
  const figures = made.pool.figures();
  assert.equal(figures.fill.sinceLastCompletedMs, 0, "a draining board's pass is a completed one");
  assert.match(figures.fill.lastEarlyReturn?.reason ?? "", /an update is draining/);
  assert.deepEqual([figures.runs.startable, figures.runs.holding], [0, "an update is draining, so no run starts until it has applied"]);
  drain.current = { kind: "none" };
  await made.pool.tick();
  assert.deepEqual([made.pool.figures().runs.holding, made.pool.figures().fill.lastEarlyReturn], [null, null], "gone with the record");
});

test("a run still starting is counted with how long it has been starting, and a batch is one run", () => {
  const made = poolFixture({ keys: ["NBF-1", "NBF-2"], now: () => 100 });
  made.store.set(replace(replace(made.store.get(), "NBF-1", (entry) => ({ ...entry, phase: "starting", startedAt: 70, batch: "b1" })), "NBF-2", (entry) => ({ ...entry, phase: "starting", startedAt: 60, batch: "b1" })));
  const { runs } = made.pool.figures();
  assert.deepEqual([runs.starting, runs.oldestStartingMs], [1, 40]);
});

test("the pure figures: the latest start is the later of the queue's and the one this instance made, and a held board reports nothing startable", () => {
  const queue = { ...poolFixture({ keys: ["NBF-1"] }).store.get() };
  const started = { ...queue, entries: queue.entries.map((entry) => ({ ...entry, startedAt: 200 })) };
  assert.equal(runFiguresOf(started, 1, null, 500, 900).sinceLastStartMs, 400, "the start this instance made after the queue dropped its record");
  assert.equal(runFiguresOf(started, 1, null, null, 900).sinceLastStartMs, 700);
  assert.equal(runFiguresOf(queue, 1, null, null, 900).sinceLastStartMs, null, "none ever");
  assert.equal(runFiguresOf(started, 3, "a command of tickets.preflight fails, so no run starts", null, 900).startable, 0);
  assert.deepEqual(fillFiguresOf({ ...newFillState(), completedAt: 100, early: { reason: "r", at: 150 } }, 400), { sinceLastCompletedMs: 300, lastEarlyReturn: { reason: "r", agoMs: 250 } });
});

test("only a run that is recorded as starting is a start: a pass that starts nothing leaves the last start where it was, even when the queue has dropped its record", async () => {
  let clock = 1_000;
  const made = poolFixture({ keys: ["NBF-1"], now: () => clock });
  await made.pool.tick();
  made.store.set(replace(made.store.get(), "NBF-1", (entry) => ({ ...entry, startedAt: undefined })));
  clock = 61_000;
  assert.equal(made.pool.figures().runs.sinceLastStartMs, 60_000, "the start this instance made is remembered");
  clock = 121_000;
  await made.pool.tick();
  assert.equal(made.pool.figures().runs.sinceLastStartMs, 120_000, "a pass that started nothing did not move it");
});

test("a stopping instance starts nothing, completes its passes, and says why", async () => {
  const made = poolFixture({ keys: ["NBF-1", "NBF-2"], now: () => 100 });
  made.pool.endStarts();
  await made.pool.tick();
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => made.entry(key).phase), ["queued", "queued"]);
  const figures = made.pool.figures();
  assert.deepEqual([figures.runs.holding, figures.runs.startable, figures.fill.sinceLastCompletedMs], ["the instance is stopping, so no run starts", 0, 0]);
});
