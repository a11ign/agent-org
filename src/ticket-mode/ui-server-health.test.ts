// no-token: gh -- the page's service and the instance are real handlers on 127.0.0.1, with the tracker, the code host, the pool and the loop readings injected; nothing is spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import { boardKey, boardKeyPath } from "./board-key.ts";
import { browserSessions, browserSessionsPath } from "./browser-sessions.ts";
import { createConnections, type ConnectionsRead } from "./connections.ts";
import { measuredOver } from "./health-fixture.ts";
import type { HealthView } from "./health-route.ts";
import type { LoopReading } from "./loop-delay.ts";
import { passedOn } from "./remote-proxy.ts";
import { createBoard } from "./server.ts";
import { parseTicketSettings } from "./settings.ts";
import { createUi } from "./ui-server.ts";

const PAGE: LoopReading = { p50Ms: 0, p99Ms: 1.2, maxMs: 3, windowMs: 60_000, sinceStartMaxMs: 9, at: 1_761_400_000_000 };
const BOARD_LOOP: LoopReading = { ...PAGE, p99Ms: 2_013 };
const BOARD: HealthView = { loop: { board: BOARD_LOOP }, blocking: [{ site: "plugins/github/pull-feedback.ts:74", program: "gh", count: 4, totalMs: 8_040, maxMs: 2_016 }], measured: measuredOver(BOARD_LOOP) };

/** A server for `handle` on a free port on 127.0.0.1: its base address, and what closes it. */
async function listen(handle: (port: number) => (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  const handler = handle(port);
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((done) => server.close(() => done())) };
}

/** This machine's instance, answering `BOARD` on its `/api/health`, and the page's service in front of it, with `loop` as its own reading when one is given. */
async function services(loop?: () => LoopReading) {
  const stateDir = tmpDir("ticket-ui-health-");
  const key = boardKey(boardKeyPath(stateDir));
  const pool = { tick: async () => {}, reviewNewHeads: () => {}, stopWriterRun: () => {}, stop: () => {}, close: () => {}, dismiss: async () => {}, remove: async () => {}, reconcile: () => {}, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: () => {}, releaseReviewers: () => {}, retargetStacked: () => {}, rebaseStacked: async () => {}, applyEdit: async () => {}, discardEdit: () => {}, respond: () => {} };
  let instancePort = 0;
  const instance = await listen((port) => {
    instancePort = port;
    const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir, tickets: { port } });
    return createBoard({ settings, source: createFakeTracker([]), codeHost: createFakeCodeHost(), key, queuePath: join(stateDir, "queue.json"), choicePath: join(stateDir, "choice.json"), pool, version: null, next: () => null, health: () => BOARD }).handle;
  });
  const sessions = browserSessions(browserSessionsPath(stateDir));
  const read: ConnectionsRead = { connections: [{ name: "local", kind: "local" }], refusal: null, migrated: null };
  const connections = createConnections(read.connections, { local: { port: instancePort, keyPath: boardKeyPath(stateDir) } });
  const page = await listen((port) => createUi({ port, key, sessions, read, connections, ...(loop === undefined ? {} : { loop }) }).handle);
  const cookie = `ticket_session=${sessions.open()}`;
  const get = async (path: string, headers: Record<string, string> = { cookie }) => {
    const response = await fetch(`${page.base}${path}`, { headers });
    return [response.status, await response.json()] as const;
  };
  return { get, key, close: async () => { await page.close(); await instance.close(); connections.close(); } };
}

test("the page's service answers its own loop at its root /api/health, to a paired browser and to the key, as /api/connections", async () => {
  let reads = 0;
  const { get, key, close } = await services(() => { reads += 1; return PAGE; });
  try {
    assert.deepEqual(await get("/api/health"), [200, { loop: { page: PAGE } }]);
    assert.deepEqual(await get("/api/health", { "x-ticket-token": key }), [200, { loop: { page: PAGE } }]);
    assert.equal(reads, 2, "read fresh on every request");
  } finally {
    await close();
  }
});

test("a browser that has not paired is refused the page's health, and its loop is not read", async () => {
  let reads = 0;
  const { get, close } = await services(() => { reads += 1; return PAGE; });
  try {
    const [status] = await get("/api/health", {});
    assert.equal(status, 401);
    assert.equal(reads, 0);
  } finally {
    await close();
  }
});

test("a service made without a loop reading does not serve the route, as one from before it", async () => {
  const { get, close } = await services();
  try {
    assert.deepEqual(await get("/api/health"), [404, { error: "no route GET /api/health" }]);
  } finally {
    await close();
  }
});

test("a paired browser reads a connection's /api/health through the page's service, which passes the read on with the instance's key", async () => {
  assert.equal(passedOn("GET", "/api/health"), true);
  assert.equal(passedOn("POST", "/api/health"), false, "it is a read, and writes nothing");
  const { get, close } = await services(() => PAGE);
  try {
    assert.deepEqual(await get("/c/local/api/health"), [200, BOARD]);
  } finally {
    await close();
  }
});
