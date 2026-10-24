// no-token: gh -- herdr, the tracker and the clock are injected; the board is driven without a socket
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import { memoryDrain, poolFixture } from "./pool-fixture.ts";
import { updateNoteOf } from "./pool-drain.ts";
import { createBoard } from "./server.ts";
import { parseTicketSettings } from "./settings.ts";
import { updateBanner } from "./board-view/update-banner.ts";
import { reasonOf, updateLines } from "./board-view/run-reason.ts";
import { emptyQueue, loadQueue, saveQueue } from "./queue.ts";
import { markStarting } from "./queue/queue-transitions.ts";
import { recordToolPin, requeueForUpdate } from "./queue/queue-pins.ts";
import type { DrainRecord } from "../install/update-drain.ts";

/** 2026-10-21 at `hour:minute` in the viewer's zone, as the banner words a time of day. */
const at = (hour: number, minute: number): number => new Date(2026, 9, 21, hour, minute).getTime();
const record = (over: Partial<DrainRecord> = {}): DrainRecord => ({ target: "v0.280.0", since: new Date(at(12, 30)).toISOString(), deadline: new Date(at(14, 30)).toISOString(), stopped: [], ...over });
const starts = (calls: readonly string[][]) => calls.filter((args) => args.includes("agent") && args.includes("start"));

test("A11-169: with a drain record, fill starts no run and no round, and a record that cannot be read holds them as well", async () => {
  const drain = memoryDrain();
  const made = poolFixture({ keys: ["NBF-1", "NBF-2"], drain, now: () => at(13, 0) });
  drain.current = { kind: "draining", record: record() };
  await made.pool.tick();
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => made.entry(key).phase), ["queued", "queued"], "nothing starts while an update drains");
  assert.equal(starts(made.herdr.calls).length, 0);
  drain.current = { kind: "unreadable", why: "the file is torn" };
  await made.pool.tick();
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => made.entry(key).phase), ["queued", "queued"], "an unreadable record is not read as no drain");
  drain.current = { kind: "none" };
  await made.pool.tick();
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => made.entry(key).phase), ["running", "running"], "they start once the record is gone");
});

test("A11-169: the banner reads as the settled behaviour words it, and is gone with the record", () => {
  const note = { target: "v0.280.0", deadline: at(14, 30), finishing: 2, forced: false, stopped: 0 };
  assert.equal(updateBanner(note), "Updating to v0.280 (breaking): no new runs start; 2 runs finishing; forced at 14:30");
  assert.equal(updateBanner({ ...note, finishing: 1 }), "Updating to v0.280 (breaking): no new runs start; 1 run finishing; forced at 14:30");
  assert.equal(updateBanner({ ...note, deadline: at(9, 5) }), "Updating to v0.280 (breaking): no new runs start; 2 runs finishing; forced at 09:05");
  assert.equal(updateBanner(null), null, "a non-breaking update has no note, so the board says nothing");
  assert.equal(updateNoteOf({ kind: "none" }, emptyQueue(2)), null);
});

test("A11-169: while draining a live run is finishing before the update and a queued one waits for it", async () => {
  const drain = memoryDrain();
  const made = poolFixture({ keys: ["NBF-1", "NBF-2"], max: 1, drain, now: () => at(13, 0) });
  await made.pool.tick();
  drain.current = { kind: "draining", record: record() };
  const note = updateNoteOf(drain.read(), made.store.get());
  assert.deepEqual(note, { target: "v0.280.0", deadline: at(14, 30), finishing: 1, forced: false, stopped: 0 });
  const view = { note, instanceVersion: "v0.273.0" };
  assert.deepEqual(updateLines(made.entry("NBF-1"), view), ["finishing before the update"]);
  assert.deepEqual(updateLines(made.entry("NBF-2"), view), ["waits for the update"]);
  assert.deepEqual(updateLines(made.entry("NBF-1"), { note: null, instanceVersion: "v0.273.0" }), [], "nothing is said once no update drains");
});

test("A11-169: at the deadline each live run is stopped and re-queued, the update is started, and the round after it resumes the session on the new version", async () => {
  const drain = memoryDrain();
  const updates: string[] = [];
  let clock = at(13, 0);
  const made = poolFixture({ keys: ["NBF-1", "NBF-2"], drain, now: () => clock, startUpdate: () => updates.push("started") });
  await made.pool.tick();
  made.status.set("t-nbf-1", "working");
  made.status.set("t-nbf-2", "working");
  await made.pool.tick();
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => made.entry(key).phase), ["running", "running"]);
  drain.current = { kind: "draining", record: record() };
  await made.pool.tick();
  assert.deepEqual(updates, [], "before the deadline the runs finish on their own and the update is not started");
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => made.entry(key).phase), ["running", "running"]);

  clock = at(14, 31);
  await made.pool.tick();
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => made.entry(key).phase), ["queued", "queued"], "the live runs are stopped and queued again");
  assert.equal(made.entry("NBF-1").workspace, undefined, "their workspaces are closed");
  assert.ok(made.herdr.calls.some((args) => args.includes("workspace") && args.includes("close")));
  assert.deepEqual(made.entry("NBF-1").stoppedForUpdate, { at: at(14, 31), target: "v0.280.0" });
  assert.equal(made.entry("NBF-1").session, "session-t-nbf-1", "the Claude session is kept for the next round");
  assert.deepEqual(updates, ["started"], "the auto-update service is started at once, once");
  assert.equal(drain.writes.length, 1);
  assert.deepEqual(drain.writes[0].stopped, ["NBF-1", "NBF-2"]);
  assert.ok(drain.writes[0].forcedAt !== undefined);
  const view = { note: updateNoteOf(drain.read(), made.store.get()), instanceVersion: "v0.273.0" };
  assert.deepEqual(updateLines(made.entry("NBF-1"), view), ["stopped for the update at 14:31 and re-queued; resumes on v0.280"]);
  assert.equal(updateBanner(view.note), "Updating to v0.280 (breaking): no new runs start; 2 runs stopped at 14:30 and queued again; applying now");
  await made.pool.tick();
  assert.deepEqual(updates, ["started"], "a later pass stops nothing and starts nothing more");
  assert.equal(starts(made.herdr.calls).length, 2, "and no round starts while the record stands");

  // The update applied: the record is gone, and the instance that restarted on the new version starts the rounds.
  drain.current = { kind: "none" };
  mkdirSync(join(made.root, "transcripts", "p"), { recursive: true });
  writeFileSync(join(made.root, "transcripts", "p", "session-t-nbf-1.jsonl"), "{}\n");
  const calls = made.herdr.calls.length;
  await made.restart({ hook: { node: "/node", bin: "/tool/versions/v0.280.0/src/bin.ts" } }).tick();
  const round = starts(made.herdr.calls.slice(calls)).find((args) => args.includes("t-nbf-1"))!;
  assert.ok(round.includes("--resume") && round.includes("session-t-nbf-1"), "the round resumes the stopped run's own session");
  assert.equal(made.entry("NBF-1").toolVersion, "v0.280.0", "on the new version");
  assert.equal(made.entry("NBF-1").stoppedForUpdate, undefined, "the stopped line goes when its round starts");
  assert.deepEqual(updateLines(made.entry("NBF-1"), { note: null, instanceVersion: "v0.280.0" }), []);
  assert.ok(reasonOf(made.entry("NBF-1")).line === null);
});

test("A11-169: the publish run and a new-ticket run that are live at the deadline are stopped too, so the update can apply", async () => {
  const drain = memoryDrain();
  let clock = at(13, 0);
  const made = poolFixture({ keys: [], drain, now: () => clock, startUpdate: () => {} });
  made.store.set({ ...made.store.get(), publish: { id: "p1", keys: [], prs: [], phase: "running", queuedAt: 1, workspace: "w9", pane: "w9:p1" } });
  drain.current = { kind: "draining", record: record() };
  clock = at(14, 31);
  await made.pool.tick();
  assert.equal(made.store.get().publish?.phase, "finished");
  assert.match(made.store.get().publish?.failure ?? "", /stopped for the update to v0\.280\.0 at 14:31/);
});

test("A11-169: /api/config tells the page the instance's version and the draining update, and /api/queue the same for its polling", async () => {
  const dir = tmpDir("ticket-update-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: dir });
  const pool = { tick: async () => {}, reviewNewHeads: () => {}, stopWriterRun: () => {}, stop: () => {}, close: () => {}, dismiss: async () => {}, remove: async () => {}, reconcile: () => {}, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: () => {}, releaseReviewers: () => {}, retargetStacked: () => {}, rebaseStacked: async () => {}, applyEdit: async () => {}, discardEdit: () => {}, respond: () => {} };
  const drain = memoryDrain();
  const { api } = createBoard({ settings, source: createFakeTracker([]), codeHost: createFakeCodeHost(), key: "a".repeat(48), queuePath: join(dir, "queue.json"), choicePath: join(dir, "choice.json"), pool,
    poolDeps: { drain }, version: "v0.273.0", next: () => null, now: () => at(13, 0) });
  const [, calm] = await api("GET", "/api/config", {}) as [number, any];
  assert.equal(calm.version, "v0.273.0");
  assert.equal(calm.updateNote, null, "a non-breaking update shows nothing on the board");
  drain.current = { kind: "draining", record: record() };
  const [, config] = await api("GET", "/api/config", {}) as [number, any];
  assert.deepEqual(config.updateNote, { target: "v0.280.0", deadline: at(14, 30), finishing: 0, forced: false, stopped: 0 });
  const [, queue] = await api("GET", "/api/queue", {}) as [number, any];
  assert.deepEqual(queue.update, { version: "v0.273.0", note: config.updateNote, next: null });
});

test("A11-169: requeueForUpdate keeps what a run was doing and drops what its live agent held, and touches only a live run", () => {
  const entry = { ticket: { key: "NBF-1" }, repos: ["a"], model: "sonnet", effort: "high", plan: { model: "opus", effort: "max" }, review: [{ repo: "a/b", url: "https://github.com/a/b/pull/1" }], rounds: 2,
    movedFrom: { from: "Todo", to: "In Progress" }, phase: "running", queuedAt: 1, startedAt: 5, workspace: "w1", pane: "w1:p1", seenWorking: true, working: { reason: "x", at: 1 }, toolVersion: "v0.273.0", toolRoot: "/t/v0.273.0" } as any;
  const queue = { entries: [entry, { ...entry, ticket: { key: "NBF-2" }, phase: "queued", workspace: undefined }, { ...entry, ticket: { key: "NBF-3" }, phase: "finished", workspace: "w3" }], max: 2, paused: false } as any;
  const next = requeueForUpdate(queue, "NBF-1", "v0.280.0", 99, "s-1");
  const [requeued] = next.entries;
  assert.equal(requeued.phase, "queued");
  assert.equal(requeued.queuedAt, 99);
  assert.deepEqual(requeued.stoppedForUpdate, { at: 99, target: "v0.280.0" });
  assert.equal(requeued.session, "s-1");
  assert.deepEqual([requeued.plan, requeued.review, requeued.rounds, requeued.movedFrom], [entry.plan, entry.review, 2, entry.movedFrom], "its plan, round, count and the move of its ticket are kept");
  for (const field of ["workspace", "pane", "startedAt", "seenWorking", "working"]) assert.equal((requeued as any)[field], undefined, `${field} belongs to the live agent`);
  assert.deepEqual(requeueForUpdate(queue, "NBF-2", "v0.280.0", 99), queue, "a queued run is left as it is");
  assert.deepEqual(requeueForUpdate(queue, "NBF-3", "v0.280.0", 99), queue, "so is a parked one, which has no live agent");
});

test("A11-169: the pin is recorded on a starting run only, and survives a save and a load of the queue", () => {
  const base = { ticket: { key: "NBF-1" }, repos: [], model: "sonnet", effort: "high", queuedAt: 1 } as any;
  const queued = { entries: [{ ...base, phase: "queued" }], max: 1, paused: false } as any;
  assert.equal(recordToolPin(queued, ["NBF-1"], { toolRoot: "/t/v0.280.0", toolVersion: "v0.280.0" }).entries[0].toolRoot, undefined, "a run that is not starting records nothing");
  const starting = recordToolPin(markStarting(queued, "NBF-1", 5), ["NBF-1"], { toolRoot: "/t/v0.280.0", toolVersion: "v0.280.0" });
  const path = join(tmpDir("ticket-queue-"), "queue.json");
  saveQueue(path, starting);
  assert.deepEqual([loadQueue(path, 1).entries[0].toolRoot, loadQueue(path, 1).entries[0].toolVersion], ["/t/v0.280.0", "v0.280.0"]);
});

test("A11-169: a run whose workspace herdr will not close is left running, not queued again beside its agent, and is stopped on the pass after herdr closes it", async () => {
  const drain = memoryDrain();
  const updates: string[] = [];
  const made = poolFixture({ keys: ["NBF-1"], drain, now: () => at(14, 31), startUpdate: () => updates.push("started") });
  await made.pool.tick();
  made.status.set("t-nbf-1", "working");
  await made.pool.tick();
  drain.current = { kind: "draining", record: record() };
  made.herdr.closing.refusal = "pane_busy";
  await made.pool.tick();
  assert.equal(made.entry("NBF-1").phase, "running", "its agent may still be running, so no second round is queued for it");
  assert.deepEqual(drain.writes.at(-1)?.stopped ?? [], [], "it is not recorded as stopped");
  made.herdr.closing.refusal = null;
  await made.pool.tick();
  assert.equal(made.entry("NBF-1").phase, "queued");
  assert.deepEqual(drain.writes.at(-1)?.stopped, ["NBF-1"]);
});
