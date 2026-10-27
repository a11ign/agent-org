// no-token: gh -- the board is a real `createBoard` with the tracker, the code host and the pool injected; the monitor and the ledger are fakes, but for the request thread's, under which this Node runs `sh -c true` twice
import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import type { BlockingSite } from "./blocking-ledger.ts";
import { measuredOver } from "./health-fixture.ts";
import { figuresOf, snapshotOf } from "./board-thread.ts";
import { cachedWatchdogView, emptyRecord, VIEW_CACHE_MS, withRestart, writeRecord } from "./watchdog-record.ts";
import { HEALTH_SITES, healthView, memoOver, type HealthView, requestHealthView, startRequestHealth } from "./health-route.ts";
import type { LoopReading } from "./loop-delay.ts";
import { createBoard, intervalMs } from "./server.ts";
import { parseTicketSettings } from "./settings.ts";

const READING: LoopReading = { p50Ms: 1.5, p99Ms: 2_013, maxMs: 2_020, windowMs: 60_000, sinceStartMaxMs: 6_680, at: 1_761_400_000_000 };
const SITES: BlockingSite[] = Array.from({ length: 12 }, (_, made) => ({ site: `plugins/github/pull-feedback.ts:${made + 1}`, program: "gh", count: 1, totalMs: 100 - made, maxMs: 100 - made }));

test("the health view is the loop's reading as board's, and the ten sites that held it the longest", () => {
  const asked: number[] = [];
  const hour = { p50Ms: 1, p99Ms: 90, maxMs: 2_020, windowMs: 3_600_000 };
  const calls = { linear: { calls: 200, failures: 3, failuresPer100: 1.5 }, github: { calls: 0, failures: 0, failuresPer100: 0 } };
  const view = healthView({ read: () => READING, readHour: () => hour }, { worst: (count) => { asked.push(count); return SITES.slice(0, count); } }, { holds: { total: () => 12 }, calls: { figures: () => calls } });
  assert.deepEqual(asked, [HEALTH_SITES]);
  assert.equal(HEALTH_SITES, 10);
  assert.deepEqual(view, { loop: { board: READING }, blocking: SITES.slice(0, 10), measured: { loop: READING, hour, holds: 12, calls } });
});

/** A board over a throwaway state folder, with `health` when one is given. */
function boardWith(health?: () => HealthView) {
  const dir = tmpDir("ticket-health-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: dir });
  const pool = { tick: async () => {}, reviewNewHeads: () => {}, stopWriterRun: () => {}, stop: () => {}, close: () => {}, dismiss: async () => {}, remove: async () => {}, reconcile: () => {}, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: () => {}, releaseReviewers: () => {}, retargetStacked: () => {}, rebaseStacked: async () => {}, applyEdit: async () => {}, discardEdit: () => {}, respond: () => {} };
  return createBoard({ settings, source: createFakeTracker([]), codeHost: createFakeCodeHost(), key: "a".repeat(48), queuePath: join(dir, "queue.json"), choicePath: join(dir, "choice.json"), pool, version: null, next: () => null,
    ...(health === undefined ? {} : { health }) });
}

test("GET /api/health answers the instance's health view, read fresh on every request", async () => {
  let reads = 0;
  const viewAt = (p99Ms: number): HealthView => ({ loop: { board: { ...READING, p99Ms } }, blocking: SITES.slice(0, 3), measured: measuredOver({ ...READING, p99Ms }) });
  const board = boardWith(() => { reads += 1; return viewAt(reads); });
  assert.deepEqual(await board.api("GET", "/api/health", {}), [200, viewAt(1)]);
  const [, again] = await board.api("GET", "/api/health", {});
  assert.equal((again as HealthView).loop.board.p99Ms, 2);
});

test("a board made without health does not serve the route, as an instance from before it", async () => {
  assert.deepEqual(await boardWith().api("GET", "/api/health", {}), [404, { error: "no route GET /api/health" }]);
});

test("an interval override is a whole number of ms above 0 in AGENT_ORG_<name>, and anything else keeps the constant", () => {
  assert.equal(intervalMs({ AGENT_ORG_TICK_MS: "1500" }, "TICK_MS", 30_000), 1_500);
  for (const bad of [undefined, "", "0", "-5", "1.5", "soon"]) assert.equal(intervalMs({ AGENT_ORG_TICK_MS: bad }, "TICK_MS", 30_000), 30_000, String(bad));
  assert.equal(intervalMs({ AGENT_ORG_TRACKER_MS: "900" }, "TICK_MS", 30_000), 30_000, "each override names its own interval");
});

test("the request thread's health is both loops, how old the board thread's snapshot is, the board thread's spawns, and the request thread's own count", () => {
  const requests = { ...READING, p99Ms: 4 };
  const latest = { snapshot: { loop: READING, blocking: SITES.slice(0, 2) }, receivedAt: 1_000 };
  assert.deepEqual(requestHealthView(requests, latest, 3_500, 0), { loop: { requests, board: READING }, boardSnapshotAgeMs: 2_500, blocking: SITES.slice(0, 2), requestThreadSyncCalls: 0, figures: null, watchdog: null });
  assert.equal(requestHealthView(requests, latest, 900, 0).boardSnapshotAgeMs, 0, "a clock that steps back never reads a negative age");
});

test("the request thread counts and says each synchronous spawn after it listens, and none before", () => {
  const said: string[] = [];
  const health = startRequestHealth({ latest: () => ({ snapshot: { loop: READING, blocking: [] }, receivedAt: 0 }), now: () => 0, err: (line) => said.push(line) });
  // Through the module object, as the wrappers are put on it: a named import of this test file's bundle keeps the original.
  childProcess.spawnSync("sh", ["-c", "true"]);
  assert.equal(health.view().requestThreadSyncCalls, 0, "a spawn before it listens is its start's");
  assert.deepEqual(said, []);
  health.listening();
  childProcess.spawnSync("sh", ["-c", "true"]);
  assert.equal(health.view().requestThreadSyncCalls, 1);
  assert.match(said.join(""), /^ERROR request thread: synchronous sh at \S+\n$/);
});

// A11-363: the rolling figures cross from the board thread to the request thread in the snapshot, and `/api/health` serves them beside the watchdog's record.
const CALLS = { linear: { calls: 400, failures: 2, failuresPer100: 0.5 }, github: { calls: 0, failures: 0, failuresPer100: 0 } };
const POOL = {
  runs: { sinceLastStartMs: 60_000, startable: 2, freeSlots: 1, starting: 0, oldestStartingMs: null, holding: null },
  fill: { sinceLastCompletedMs: 4_000, lastEarlyReturn: { reason: "a read of the tracker or the code host failed: fetch failed", agoMs: 9_000 } },
};

test("the board thread's snapshot carries the figures: the loop over a minute and an hour, the holds and calls of the hour, the pool's runs and passes, and the instance's age", () => {
  const hour = { p50Ms: 2, p99Ms: 80, maxMs: 900, windowMs: 3_600_000 };
  const health: HealthView = { loop: { board: READING }, blocking: [], measured: { loop: READING, hour, holds: 7, calls: CALLS } };
  const board = { store: { get: () => ({ entries: [], max: 3, paused: false }) }, update: () => null, pool: { figures: () => POOL } } as unknown as Parameters<typeof snapshotOf>[0];
  const snapshot = snapshotOf(board, null, health, 1_761_400_100_000, figuresOf(board, health, 1_761_400_100_000, 1_761_400_000_000));
  assert.deepEqual(snapshot.figures, {
    at: 1_761_400_100_000, uptimeMs: 100_000,
    loop: { lastMinute: { p50Ms: READING.p50Ms, p99Ms: READING.p99Ms }, lastHour: { p50Ms: 2, p99Ms: 80 } },
    syncHolds: { lastHour: 7, holdMs: 100 }, calls: CALLS, ...POOL,
  });
  assert.equal(figuresOf({ pool: {} } as unknown as Parameters<typeof figuresOf>[0], health, 5, 0), null, "a pool that keeps none gives none");
});

test("/api/health serves the figures as the latest snapshot holds them, with the snapshot's age, and the watchdog's record when it has restarted anything", () => {
  const figures = figuresOf({ pool: { figures: () => POOL } } as unknown as Parameters<typeof figuresOf>[0], { loop: { board: READING }, blocking: [], measured: measuredOver(READING) }, 1_000, 0);
  const watchdog = { restartsLastHour: 1, restartsLastDay: 1, restartsTotal: 1, last: { at: 1, reason: "no-fill" as const, detail: "no fill() pass has completed for 5.2 min" } };
  const view = requestHealthView(READING, { snapshot: { loop: READING, blocking: [], figures }, receivedAt: 1_000 }, 4_000, 0, watchdog);
  assert.deepEqual([view.figures, view.boardSnapshotAgeMs, view.watchdog], [figures, 3_000, watchdog]);
  const page = { linear: { calls: 100, failures: 100, failuresPer100: 100 }, github: { calls: 0, failures: 0, failuresPer100: 0 } };
  const joined = requestHealthView(READING, { snapshot: { loop: READING, blocking: [], figures }, receivedAt: 1_000 }, 4_000, 0, null, page);
  assert.deepEqual(joined.figures?.calls.linear, { calls: 100, failures: 100, failuresPer100: 100 }, "the page's reads are the instance's calls too");
});

test("the page's thread reads the watchdog's record from its file at most every few seconds, and says nothing of a watchdog that never acted or whose file cannot be read", () => {
  const path = join(tmpDir("watchdog-view-"), "tickets", "watchdog.json");
  let clock = 1_000_000;
  const view = cachedWatchdogView(path, () => clock);
  assert.equal(view(), null, "no file: nothing restarted");
  mkdirSync(dirname(path), { recursive: true });
  writeRecord(path, withRestart(emptyRecord(), { at: clock - 60_000, reason: "no-start", detail: "2 queued runs could start" }));
  assert.equal(view(), null, "the record written a moment ago is not read yet: the view is kept for a few seconds");
  clock += VIEW_CACHE_MS;
  assert.deepEqual(view(), { restartsLastHour: 1, restartsLastDay: 1, restartsTotal: 1, last: { at: 940_000, reason: "no-start", detail: "2 queued runs could start" } });
  writeFileSync(path, "{ torn");
  clock += VIEW_CACHE_MS;
  assert.equal(view(), null, "a file that cannot be read shows no restarts rather than failing the route");
});

test("the last hour's reading is kept for a few seconds, because the snapshot that carries it follows every queue change", () => {
  let clock = 1_000;
  let reads = 0;
  const hour = memoOver(() => ++reads, 5_000, () => clock);
  assert.deepEqual([hour(), hour()], [1, 1], "a second read inside the time is the first's");
  clock += 5_000;
  assert.equal(hour(), 2, "and it is worked out again when the time is up");
});
