// no-token: gh -- the board is a real `createBoard` over a fake tracker and code host with a stand-in pool; the request thread is a stand-in that records what it is told; nothing is spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import { answerCall, RESTART_WINDOW_MS, RESTARTS, restartBudget, SNAPSHOT_MS, snapshotOf, startBoardThread, type RequestThread } from "./board-thread.ts";
import { measuredOver } from "./health-fixture.ts";
import type { HealthView } from "./health-route.ts";
import { localRoute, readBoardOf } from "./request-thread.ts";
import { createBoard } from "./server.ts";
import { claimantOf, parseTicketSettings } from "./settings.ts";
import type { Ticket } from "./source.ts";
import { copiesOf, type Known, LISTEN_FAILED, namedKeys, REQUEST_THREAD, type RequestThreadData, type ToBoard, type ToRequests } from "./thread-messages.ts";

const KEY = "a".repeat(48);
const ticket = (key: string, title = key) => ({ key, title, description: "", url: "", branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
const inProgress = (key: string, title = key) => ({ ...ticket(key, title), status: "In Progress", statusType: "started" }) as Ticket;
const BOARD_LOOP = { p50Ms: 1, p99Ms: 2_013, maxMs: 2_020, windowMs: 60_000, sinceStartMaxMs: 2_020, at: 7 };
const HEALTH: HealthView = { loop: { board: BOARD_LOOP }, blocking: [{ site: "plugins/github/pull-feedback.ts:74", program: "gh", count: 3, totalMs: 6_000, maxMs: 2_010 }], measured: measuredOver(BOARD_LOOP), githubCalls: null };
const PLUGINS = { read: async () => { throw new Error("the Plugins section is not read here"); } };

/** A board over a throwaway state folder and `tracker`, with a pool that holds a run and reads one pull request, as a live pool would answer. */
function boardOver(tracker = createFakeTracker([ticket("NBF-1"), ticket("NBF-2")])) {
  const dir = tmpDir("board-thread-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: dir, tickets: { port: 4747 } });
  const pool = { tick: async () => {}, reviewNewHeads: () => {}, stopWriterRun: () => {}, stop: () => {}, close: async () => {}, dismiss: async () => {}, remove: async () => {}, reconcile: async () => {}, ensureSession: async () => {},
    refreshTracker: async () => {}, watchFeedback: () => {}, releaseReviewers: () => {}, retargetStacked: () => {}, rebaseStacked: async () => {}, applyEdit: async () => {}, discardEdit: () => {}, respond: async () => {},
    held: () => ({ name: "npm run preflight", reason: "red", since: 5 }), pullReviews: () => ({ "https://github.com/a11ign/agent-org/pull/1": "Reviewer approved" }), claimWarning: () => "GitHub refuses the review claims", hostAlerts: () => [{ id: "tmp-entries", sentence: "/tmp holds 19,960 entries", since: 5 }], reviewerState: () => "on" as const };
  const paths = { queuePath: join(dir, "queue.json"), choicePath: join(dir, "choice.json") };
  const board = createBoard({ settings, source: tracker, codeHost: createFakeCodeHost(), key: KEY, ...paths, pool, now: () => 7, version: "v0.309.1", next: () => null });
  const data: Omit<RequestThreadData, "snapshot"> = { role: REQUEST_THREAD, settings, key: KEY, claimant: claimantOf(settings), paths, toolVersion: "v0.309.1", agentOrgVersion: "0.309.1" };
  return { board, tracker, settings, data };
}

test("the request thread's reads over a snapshot answer what the board's own routes answer, and the snapshot and its start data survive the structured clone", async () => {
  const { board, tracker, data } = boardOver();
  await board.api("POST", "/api/queue", { keys: ["NBF-1"], model: "sonnet", effort: "high" });
  await board.api("POST", "/api/writer", { request: "a page that says hello" }).catch(() => undefined);
  const snapshot = structuredClone(snapshotOf(board, await board.terminalAddress(), HEALTH, 7));
  const reads = readBoardOf(structuredClone({ ...data, snapshot }), { source: tracker, plugins: PLUGINS, latest: () => snapshot, health: () => null, terminalRead: () => undefined });
  for (const path of ["/api/queue", "/api/config", "/api/writer", "/api/pick", "/api/parents"]) {
    assert.deepEqual(await localRoute(reads, "GET", path, {}, new URLSearchParams()), await board.api("GET", path, {}), path);
  }
  const [, queue] = await localRoute(reads, "GET", "/api/queue", {}, new URLSearchParams()) as [number, { entries: { ticket: { key: string } }[]; held: unknown; pulls: unknown; claimWarning: unknown; hostAlerts: unknown }];
  assert.deepEqual(queue.entries.map((entry) => entry.ticket.key), ["NBF-1"], "the queue is the snapshot's");
  assert.deepEqual([queue.held, queue.pulls, queue.claimWarning], [{ name: "npm run preflight", reason: "red", since: 5 }, { "https://github.com/a11ign/agent-org/pull/1": "Reviewer approved" }, "GitHub refuses the review claims"]);
  assert.deepEqual(queue.hostAlerts, [{ id: "tmp-entries", sentence: "/tmp holds 19,960 entries", since: 5 }], "the host's alerts cross to the request thread in the snapshot (A11-279)");
});

test("A11-365: the code host's count of its calls to GitHub crosses to the request thread in the snapshot, which /api/health serves", () => {
  const { board } = boardOver();
  const githubCalls = { since: "2026-10-28T00:00:00.000Z", total: 12, perMinute: 3, notModified: 2, byKind: { graphql: 4, rest: 7, cli: 1 }, currentSweep: null, lastSweep: { at: "2026-10-28T00:00:00.000Z", calls: 3 } };
  assert.deepEqual(structuredClone(snapshotOf(board, null, { ...HEALTH, githubCalls }, 7)).githubCalls, githubCalls);
  assert.equal(snapshotOf(board, null, HEALTH, 7).githubCalls, null, "a host that counts none says none");
});

test("a read that uses the terminal address asks the board thread to work it out again, and is answered from the snapshot without waiting", async () => {
  const { board, tracker, data } = boardOver();
  const snapshot = snapshotOf(board, "https://agents.example/w/{name}", HEALTH, 7);
  let asked = 0;
  const reads = readBoardOf({ ...data, snapshot }, { source: tracker, plugins: PLUGINS, latest: () => snapshot, health: () => null, terminalRead: () => { asked += 1; } });
  const [, config] = await localRoute(reads, "GET", "/api/config", {}, new URLSearchParams()) as [number, { terminal: string | null }];
  assert.equal(config.terminal, "https://agents.example/w/{name}");
  await localRoute(reads, "GET", "/api/queue", {}, new URLSearchParams());
  assert.equal(asked, 1, "only the read that used it asked");
});

test("the request thread answers the terminal's run itself, from the snapshot, and forwards every other write", async () => {
  const { board, tracker, data } = boardOver();
  const snapshot = snapshotOf(board, null, HEALTH, 7);
  const reads = readBoardOf({ ...data, snapshot }, { source: tracker, plugins: PLUGINS, latest: () => snapshot, health: () => null, terminalRead: () => undefined });
  assert.deepEqual(await localRoute(reads, "POST", "/api/terminal-run", { link: "https://agents.example/w/NBF-1" }, new URLSearchParams()), [200, { state: "unknown" }]);
  for (const [method, path] of [["POST", "/api/queue"], ["POST", "/api/paused"], ["GET", "/api/session-asks"], ["POST", "/api/after-merge/NBF-1/1"]]) {
    assert.equal(await localRoute(reads, method, path, {}, new URLSearchParams()), undefined, `${method} ${path} goes to the board thread`);
  }
});

test("a forwarded queue request queues the page's copy of the ticket, which travels with it, not the tracker's", async () => {
  const { board } = boardOver();
  const page: Known = { tickets: new Map([["NBF-1", ticket("NBF-1", "the page's title")]]), claims: new Map() };
  const body = { keys: ["NBF-1"], model: "sonnet", effort: "high" };
  const answer = await answerCall(board, { kind: "call", id: 4, method: "POST", path: "/api/queue", body, query: "", known: copiesOf(page, namedKeys(body, page)) });
  assert.deepEqual([answer.kind, answer.id, answer.status], ["answer", 4, 200]);
  assert.equal(board.store.get().entries[0]?.ticket.title, "the page's title");
});

test("a page with no copy of a ticket takes the board thread's old one away, so the tracker's is queued", async () => {
  const { board } = boardOver();
  board.known.tickets.set("NBF-1", ticket("NBF-1", "a copy from an earlier write"));
  const empty: Known = { tickets: new Map(), claims: new Map() };
  const body = { keys: ["NBF-1"], model: "sonnet", effort: "high" };
  await answerCall(board, { kind: "call", id: 5, method: "POST", path: "/api/queue", body, query: "", known: copiesOf(empty, namedKeys(body, empty)) });
  assert.equal(board.store.get().entries[0]?.ticket.title, "NBF-1");
});

test("Queue children routes on the page's copies alone: a copy an earlier write left the board thread never stands in for the tracker's", async () => {
  const tracker = createFakeTracker([{ ...ticket("NBF-9"), children: ["NBF-10"] }, { ...inProgress("NBF-10"), parent: "NBF-9" }]);
  const { board } = boardOver(tracker);
  tracker.setClaimant("NBF-10", "desk.99999999");
  board.known.tickets.set("NBF-10", { ...ticket("NBF-10"), parent: "NBF-9" });
  const page: Known = { tickets: new Map(), claims: new Map() };
  const body = { key: "NBF-9", model: "sonnet", effort: "high" };
  const answer = await answerCall(board, { kind: "call", id: 8, method: "POST", path: "/api/queue-children", body, query: "", known: copiesOf(page, namedKeys(body, page)) });
  assert.equal(answer.status, 409, "the tracker's copy is In Progress under another instance's claim, so it is refused");
  assert.deepEqual(board.store.get().entries, []);
});

test("what a forwarded route learned of a ticket from the tracker comes back with the answer, for the request thread's next list", async () => {
  const tracker = createFakeTracker([inProgress("NBF-1", "the tracker's title")]);
  const { board, settings } = boardOver(tracker);
  tracker.setClaimant("NBF-1", claimantOf(settings));
  const page: Known = { tickets: new Map([["NBF-1", inProgress("NBF-1", "the page's title")]]), claims: new Map() };
  const body = { keys: ["NBF-1"], model: "sonnet", effort: "high" };
  const answer = await answerCall(board, { kind: "call", id: 6, method: "POST", path: "/api/queue", body, query: "", known: copiesOf(page, namedKeys(body, page)) });
  assert.equal(answer.status, 200);
  assert.equal(answer.known.tickets.find(([key]) => key === "NBF-1")?.[1]?.title, "the tracker's title", "the route read the ticket again and kept the tracker's copy");
  assert.deepEqual(answer.known.claims, [["NBF-1", claimantOf(settings)]]);
});

test("a forwarded request whose route throws is a 400 with its sentence, as on the board's own socket", async () => {
  const { board } = boardOver();
  const answer = await answerCall(board, { kind: "call", id: 7, method: "POST", path: "/api/choice", body: {}, query: "", known: { tickets: [], claims: [] } });
  assert.deepEqual([answer.status, answer.value], [400, { error: "name a model or an effort to change" }]);
});

test("the tickets a body names are its keys, its key and the sub-issues the page's copy of that ticket lists", () => {
  const known = { tickets: new Map([["NBF-9", { ...ticket("NBF-9"), children: ["NBF-10", "NBF-11"] }]]) };
  assert.deepEqual(namedKeys({ keys: ["NBF-1", "NBF-2"] }, known), ["NBF-1", "NBF-2"]);
  assert.deepEqual(namedKeys({ key: "NBF-9" }, known), ["NBF-9", "NBF-10", "NBF-11"]);
  assert.deepEqual(namedKeys({ max: 3 }, known), []);
  const listedUnderParent = { tickets: new Map([["NBF-12", { ...ticket("NBF-12"), parent: "NBF-7" }]]) };
  assert.deepEqual(namedKeys({ key: "NBF-7" }, listedUnderParent), ["NBF-7", "NBF-12"], "a sub-issue the page lists under a parent it has no copy of, as /api/parents shows it");
});

test(`the request thread is started again ${RESTARTS} times within ${RESTART_WINDOW_MS / 1000} s, and not a ${RESTARTS + 1}th`, () => {
  let now = 0;
  const mayRestart = restartBudget(() => now);
  assert.deepEqual([mayRestart(), mayRestart(), mayRestart()], [true, true, true]);
  assert.equal(mayRestart(), false);
  now = RESTART_WINDOW_MS + 1;
  assert.equal(mayRestart(), true, "the deaths of a minute ago no longer count");
});

/** A stand-in request thread: what it was told, and a way to say something to the board thread or to end. */
class StandIn extends EventEmitter {
  told: ToRequests[] = [];
  postMessage(message: ToRequests): void { this.told.push(message); }
  say(message: ToBoard): void { this.emit("message", message); }
}

/** The board thread over `boardOver()`'s board with stand-in threads, its interval driven by the test. */
function startedThread() {
  const { board: made, data } = boardOver();
  const exposure = { asked: 0 };
  const board = { ...made, terminalAddress: async () => { exposure.asked += 1; return "https://agents.example/w/{name}"; } };
  const threads: StandIn[] = [];
  const started: RequestThreadData[] = [];
  const ticks: (() => void)[] = [];
  const said = { listening: [] as number[], err: [] as string[], exits: [] as number[] };
  const thread = startBoardThread({ board, health: () => HEALTH, data, terminal: null,
    start: (workerData) => { started.push(workerData); const standIn = new StandIn(); threads.push(standIn); return standIn as unknown as RequestThread; },
    every: (run, ms) => { assert.equal(ms, SNAPSHOT_MS); ticks.push(run); }, now: () => 7,
    listening: (port) => said.listening.push(port), err: (line) => said.err.push(line), exit: (code) => said.exits.push(code) });
  return { board, thread, threads, started, ticks, said, exposure };
}

const settle = () => new Promise((done) => { setImmediate(done); });

test("the request thread starts with the board's snapshot, and is posted another after every queue change and every second", async () => {
  const { board, thread, threads, started, ticks } = startedThread();
  assert.equal(started[0].snapshot.terminal, null, "the stored address, until the board has worked it out");
  assert.deepEqual(started[0].snapshot.loop, HEALTH.loop.board);
  await board.api("POST", "/api/paused", { paused: true });
  thread.queueChanged();
  const last = threads[0].told.at(-1);
  assert.equal(last?.kind === "snapshot" && last.snapshot.queue.paused, true, "the paused queue is posted");
  const before = threads[0].told.length;
  ticks[0]();
  await settle();
  assert.equal(threads[0].told.length, before + 1, "a snapshot every second, changed or not");
});

test("the exposure is asked for the terminal address once at start and again only when a read used it, never on the snapshot's second", async () => {
  const { threads, ticks, exposure } = startedThread();
  await settle();
  assert.equal(exposure.asked, 1, "once at start");
  const told = threads[0].told.at(-1);
  assert.equal(told?.kind === "snapshot" && told.snapshot.terminal, "https://agents.example/w/{name}", "posted once worked out");
  for (let second = 0; second < 5; second += 1) ticks[0]();
  await settle();
  assert.equal(exposure.asked, 1, "the snapshot's interval asks nothing");
  threads[0].say({ kind: "terminal" });
  await settle();
  assert.equal(exposure.asked, 2);
});

test("a forwarded call is answered by the board thread's routes, and the first listen is said once however often the thread starts", async () => {
  const { board, threads, said } = startedThread();
  threads[0].say({ kind: "listening", port: 4747 });
  threads[0].say({ kind: "call", id: 1, method: "POST", path: "/api/max", body: { max: 3 }, query: "", known: { tickets: [], claims: [] } });
  await settle();
  const answer = threads[0].told.find((message) => message.kind === "answer");
  assert.equal(answer?.kind === "answer" && answer.status, 200);
  assert.equal(board.store.get().max, 3);
  threads[0].emit("exit", 1);
  threads[1].say({ kind: "listening", port: 4747 });
  assert.deepEqual(said.listening, [4747]);
});

test(`a request thread that exits is started again, and its ${RESTARTS + 1}th exit within ${RESTART_WINDOW_MS / 1000} s ends the instance with 1`, () => {
  const { threads, said } = startedThread();
  for (let death = 0; death < RESTARTS; death += 1) threads[death].emit("exit", 1);
  assert.equal(threads.length, RESTARTS + 1, "each exit started another");
  assert.deepEqual(said.exits, []);
  threads[RESTARTS].emit("exit", 1);
  assert.equal(threads.length, RESTARTS + 1, "no fifth thread");
  assert.deepEqual(said.exits, [1]);
  assert.match(said.err.at(-1) ?? "", /ERROR ticket:serve: the request thread exited 1/);
});

test("a request thread that cannot listen ends the instance at once, as the instance's own listen did, and is not started again", () => {
  const { threads, said } = startedThread();
  threads[0].emit("exit", LISTEN_FAILED);
  assert.equal(threads.length, 1);
  assert.deepEqual(said.exits, [1]);
});

test("A11-282: stop tells the request thread to stop and answers once it has exited, and it is not started again", async () => {
  const { thread, threads, said } = startedThread();
  let stopped = false;
  const stopping = thread.stop().then(() => { stopped = true; });
  assert.deepEqual(threads[0].told.at(-1), { kind: "stop" });
  await settle();
  assert.equal(stopped, false, "it waits for the thread to end");
  threads[0].emit("exit", 0);
  await stopping;
  assert.equal(threads.length, 1, "the exit it asked for does not start another thread");
  assert.deepEqual(said.exits, []);
});

test("A11-363: the figures are worked out at most once a second though a snapshot follows every queue change, and a new second works them out again", async () => {
  let worked = 0;
  let clock = 5_000;
  const { board } = boardOver();
  const counting = { ...board, pool: { ...board.pool, figures: () => { worked += 1; return { runs: { sinceLastStartMs: null, startable: 0, freeSlots: 3, starting: 0, oldestStartingMs: null, holding: null }, fill: { sinceLastCompletedMs: null, lastEarlyReturn: null, held: [] } }; } } };
  const threads: StandIn[] = [];
  const thread = startBoardThread({ board: counting, health: () => HEALTH, terminal: null, data: boardOver().data, now: () => clock, every: () => undefined, startedAt: 0,
    start: () => { const standIn = new StandIn(); threads.push(standIn); return standIn as unknown as RequestThread; } });
  const afterStart = worked;
  for (let change = 0; change < 12; change += 1) thread.queueChanged();
  assert.equal(worked, afterStart, "twelve queue changes in the same second work the figures out no more");
  clock += SNAPSHOT_MS;
  thread.queueChanged();
  assert.equal(worked, afterStart + 1);
});
