// no-token: none -- a board over a stub pool, a fake tracker and a plugins seam, served on a Unix socket in a temporary directory and reached through the page's proxy as an SSH connection is
// A11-270: the 1 s budget of a first load over SSH, kept by a test so it cannot slip back. The board has what made it 15 to 25 s on the chairman's Mac: plugin checks that take 5 s or never end,
// a tracker that takes 0.6 s to list the tickets (the host's `/api/tickets`), and a queue as large as the host's. The tunnel's far end is the board's socket; opening it takes 250 ms.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Connection, Connections, Target } from "./connections.ts";
import { PAGES, percentile, runPage, timePages, type ReadOf } from "../../scripts/page-timing.ts";
import type { PluginModule } from "../plugins/manifest.ts";
import { defaultCatalog } from "../plugins/registry.ts";
import { httpForward, proxy } from "./remote-proxy.ts";
import { hostShapedQueue, serveBoard } from "./queue-view-fixture.ts";
import type { PluginsAnswer } from "./plugins-api.ts";

const RUNS = 20;
const BUDGET_MS = 1000;
const PLUGINS_MS = 300;
const CHECK_LIMIT_MS = 1500;
const OPENING_MS = 150;
const TRACKER_MS = 600;
const PERSONAL: Connection = { name: "personal", kind: "ssh", ssh: "agents", agentOrg: "agent-org" };

/** A plugin whose checks take `ms` to answer, or never do (an infinite `ms`). */
const plugin = (name: string, ms: number) => ({ plugin: defaultCatalog().plugins.find((candidate) => candidate.name === name)!,
  module: { doctorChecks: () => (ms === Number.POSITIVE_INFINITY ? new Promise(() => undefined) : new Promise((done) => { setTimeout(done, ms, []).unref(); })) } as unknown as PluginModule });

/** An SSH connection whose tunnel takes `OPENING_MS` to open the first time it is reached, and whose far end is `target`. */
function tunnelTo(target: Target): Connections {
  let opened: Promise<Target> | null = null;
  const reach = () => (opened ??= new Promise((done) => { setTimeout(done, OPENING_MS, target); }));
  return { get: (name: string) => (name === PERSONAL.name ? PERSONAL : undefined), reach, restart: reach, answered: () => {}, forget: () => {}, close: () => {} } as unknown as Connections;
}

const queue = hostShapedQueue();
const key = queue.entries.at(-1)!.ticket.key;
const served = await serveBoard({ queue, ticketsMs: TRACKER_MS, tickets: 120, plugins: {
  load: async () => ({ loaded: [], unbuilt: [plugin("linear", 5_000), plugin("github", Number.POSITIVE_INFINITY)], refusals: [] }), limitMs: CHECK_LIMIT_MS } });
const connections = tunnelTo({ key: served.key, host: served.host, address: { socket: served.socket }, terminal: () => null });
const readOf: ReadOf = (path) => proxy(connections, PERSONAL.name, { method: "GET", path, body: null }, httpForward);
const pluginsAfter = new Map<number, number>();
const timedReads: ReadOf = async (path) => {
  const started = performance.now();
  const answered = await readOf(path);
  if (path === "/api/plugins") pluginsAfter.set(pluginsAfter.size, performance.now() - started);
  return answered;
};

test("A11-270: every page draws within 1 s at p95 on a first load over SSH, the plugins answer within 300 ms, and every read answers", async () => {
  const timing = await timePages(timedReads, RUNS, { ...PAGES, Run: runPage(key) });
  for (const [page, { times, failed }] of Object.entries(timing.pages)) {
    assert.deepEqual([...failed], [], `${page} reads that did not answer 200`);
    assert.equal(times.length, RUNS);
    const p95 = percentile([...times].sort((a, b) => a - b), 95);
    assert.ok(p95 < BUDGET_MS, `${page}: p95 ${Math.round(p95)} ms, first load ${Math.round(times[0])} ms, over ${BUDGET_MS} ms`);
    assert.ok(times[0] < BUDGET_MS, `${page}: the first load, which opens the tunnel, took ${Math.round(times[0])} ms`);
  }
  assert.ok(pluginsAfter.size >= RUNS, "the plugins were read on every run of the pages that read them");
  const slowest = Math.max(...pluginsAfter.values());
  assert.ok(slowest < PLUGINS_MS + OPENING_MS, `the slowest plugins read took ${Math.round(slowest)} ms with checks that take 5 s and never end (the first includes the tunnel's ${OPENING_MS} ms)`);
  const queueBytes = timing.sizes.get("/api/queue") ?? Number.POSITIVE_INFINITY;
  const fullBytes = JSON.stringify(queue).length;
  assert.ok(queueBytes < fullBytes / 3, `the queue read is ${queueBytes} bytes of JSON for a queue of ${fullBytes}`);
});

test("A11-270: a check that never ends or takes longer than its limit is shown as timed out, and the read still answers at once", async () => {
  const [status, answer] = await readOf("/api/plugins");
  assert.equal(status, 200);
  const checks = (answer as PluginsAnswer).concerns.flatMap(({ plugins }) => plugins).flatMap(({ name, checks: rows }) => rows.filter(({ ok }) => !ok).map(({ detail }) => [name, detail]));
  assert.deepEqual(checks.filter(([name]) => name === "linear" || name === "github"), [
    ["linear", `its checks did not finish within ${CHECK_LIMIT_MS / 1000} seconds`], ["github", `its checks did not finish within ${CHECK_LIMIT_MS / 1000} seconds`]]);
  assert.equal((answer as PluginsAnswer).checkedAt === null, false);
});

test("A11-270: the closing of the served board", async () => {
  await served.close();
});
