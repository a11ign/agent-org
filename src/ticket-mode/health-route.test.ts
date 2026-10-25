// no-token: gh -- the board is a real `createBoard` with the tracker, the code host and the pool injected; the monitor and the ledger are fakes, but for the request thread's, under which this Node runs `sh -c true` twice
import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import type { BlockingSite } from "./blocking-ledger.ts";
import { HEALTH_SITES, healthView, type HealthView, requestHealthView, startRequestHealth } from "./health-route.ts";
import type { LoopReading } from "./loop-delay.ts";
import { createBoard, intervalMs } from "./server.ts";
import { parseTicketSettings } from "./settings.ts";

const READING: LoopReading = { p50Ms: 1.5, p99Ms: 2_013, maxMs: 2_020, windowMs: 60_000, sinceStartMaxMs: 6_680, at: 1_761_400_000_000 };
const SITES: BlockingSite[] = Array.from({ length: 12 }, (_, made) => ({ site: `plugins/github/pull-feedback.ts:${made + 1}`, program: "gh", count: 1, totalMs: 100 - made, maxMs: 100 - made }));

test("the health view is the loop's reading as board's, and the ten sites that held it the longest", () => {
  const asked: number[] = [];
  const view = healthView({ read: () => READING }, { worst: (count) => { asked.push(count); return SITES.slice(0, count); } });
  assert.deepEqual(asked, [HEALTH_SITES]);
  assert.equal(HEALTH_SITES, 10);
  assert.deepEqual(view, { loop: { board: READING }, blocking: SITES.slice(0, 10) });
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
  const board = boardWith(() => { reads += 1; return { loop: { board: { ...READING, p99Ms: reads } }, blocking: SITES.slice(0, 3) }; });
  assert.deepEqual(await board.api("GET", "/api/health", {}), [200, { loop: { board: { ...READING, p99Ms: 1 } }, blocking: SITES.slice(0, 3) }]);
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
  assert.deepEqual(requestHealthView(requests, latest, 3_500, 0), { loop: { requests, board: READING }, boardSnapshotAgeMs: 2_500, blocking: SITES.slice(0, 2), requestThreadSyncCalls: 0 });
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
