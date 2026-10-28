// no-token: gh -- herdr, the tracker and the clock are all injected; nothing is spawned
// A11-364: a live read never gates a start. The board starts what it knows, reads in the background with a timeout, and holds only the ticket it cannot read.
import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
import { createPool, type QueueStore } from "./pool.ts";
import { fakeHerdr } from "./pool-fixture.ts";
import { waitNote } from "./board-view/pull-status-and-notes.ts";
import { enqueue, type Entry, type Queue } from "./queue/queue-entries-and-outcomes.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { pauseQueue, resumeQueue } from "./queue/queue-transitions.ts";
import { BLOCKERS_MAX_AGE_MS, READ_RETRY_MS } from "./queue/start-reads.ts";
import { emptyQueue } from "./queue.ts";
import { parseTicketSettings } from "./settings.ts";
import type { Blocker, TicketSource } from "./source.ts";

const START = Date.UTC(2026, 9, 27, 22, 5);

/** The pools the case being run made. */
const made: ReturnType<typeof createPool>[] = [];

/**
 * A case that waits, when it ends, for the reads its pools still have out and the passes those wake: a read cut off after the case ended would write into the state folder the runner has just removed (the runner reports it as
 * a file that left something in its TMPDIR).
 */
function test(name: string, run: () => Promise<void>): void {
  nodeTest(name, async () => {
    try {
      await run();
    } finally {
      await Promise.all(made.splice(0).map((pool) => pool.startReadsSettled()));
    }
  });
}
const HANGS = new Promise<never>(() => {});

/** A pool over a tracker whose `blockers` is `read`, with `keys` queued and `max` slots, a clock the test moves, and a read timeout of 30 ms. `known` keys start with their blockers and plan read at the start. */
function world(keys: readonly string[], read: (asked: readonly string[]) => Promise<Map<string, Blocker[]>>, { max = 5, known = [], plan = false, download }: { max?: number; known?: readonly string[]; plan?: boolean; download?: TicketSource["download"] } = {}) {
  const root = tmpDir("ticket-start-reads-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/repos/nbl-ui-netbox" }, stateDir: join(root, "state"), tickets: plan ? { plan: "-plan-[^/]*\\.md$" } : {} });
  const tracker = createFakeTracker(keys.map((key) => fakeTicket(key)));
  const asked: (readonly string[])[] = [];
  const source: TicketSource = { ...tracker, ...(download === undefined ? {} : { download }), blockers: async (wanted) => { asked.push([...wanted]); return read(wanted); } };
  const clock = { now: START };
  let queue: Queue = resumeQueue(enqueue(emptyQueue(max), keys.map((key) => fakeTicket(key)), { model: "sonnet", effort: "high" }, 0));
  queue = { ...queue, entries: queue.entries.map((entry): Entry => (known.includes(entry.ticket.key) ? { ...entry, blockers: [], blockersReadAt: START, ...(plan ? {} : { paths: [] }) } : entry)) };
  const store: QueueStore = { get: () => queue, set: (next: Queue) => { queue = next; } };
  const herdr = fakeHerdr(new Map());
  const pool = createPool(store, { settings, source, hook: { node: "/node", bin: "/tool/src/bin.ts" }, herdr: herdr.run, hostFile: "/work/.agent-org/host.json", now: () => clock.now, load: () => ({ load: 1, cores: 14 }),
    transcriptsRoot: join(root, "transcripts"), wait: async () => {}, pluginRecord: join(root, "no-plugin-record.json"), codeHost: createFakeCodeHost(), readMs: 30 });
  made.push(pool);
  const entry = (key: string) => queue.entries.find((e) => e.ticket.key === key)!;
  const started = () => queue.entries.filter((e) => e.phase !== "queued").map((e) => e.ticket.key);
  return { pool, entry, started, store, clock, asked, settings, setQueue: (next: Queue) => { queue = next; } };
}

/** Run `act` with the board's log captured, and return the lines it wrote. */
async function logged(act: () => Promise<void>): Promise<string> {
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    await act();
  } finally {
    process.stderr.write = write;
  }
  return written.join("");
}

test("a hung blockers() read does not delay the start of a ticket whose blockers are known", async () => {
  const run = world(["NBF-1", "NBF-2"], () => HANGS, { known: ["NBF-1"] });
  await run.pool.tick();
  assert.deepEqual(run.started(), ["NBF-1"], "NBF-1 started in the pass, though the tracker never answered about NBF-2");
  assert.deepEqual(run.asked, [["NBF-2"]], "and only NBF-2 was asked about");
  assert.equal(run.entry("NBF-2").phase, "queued");
  assert.deepEqual(run.pool.figures().fill.held, [{ key: "NBF-2", reason: "blockers unread: not read yet" }], "held, and the board says for what");
});

test("a read that never answers is cut off at its timeout, and holds only the ticket it was for, with the reason and when it is asked again", async () => {
  const run = world(["NBF-1", "NBF-2"], () => HANGS, { known: ["NBF-1"] });
  const written = await logged(async () => {
    await run.pool.tick();
    await run.pool.startReadsSettled();
  });
  const failure = run.entry("NBF-2").blockersFailure;
  assert.match(failure?.error ?? "", /did not finish within 0\.03s/);
  assert.equal(failure?.retryAt, START + READ_RETRY_MS);
  assert.equal(waitNote(run.entry("NBF-2"), run.store.get().entries), `Waits: blockers unread: ${failure?.error}, retrying at 22:05Z`);
  assert.equal(run.entry("NBF-1").phase, "running", "the other ticket was never held");
  assert.match(written, /NBF-2: the tracker could not say which tickets block it \(.*did not finish within 0\.03s\); the board asks again at 22:05Z/);
});

test("a failed read holds the tickets it was for and no other, and they take no slot from one that can start", async () => {
  const run = world(["NBF-1", "NBF-2", "NBF-3", "NBF-4"], async () => { throw new Error("Linear answered 503"); }, { max: 2, known: ["NBF-4"] });
  const written = await logged(async () => {
    await run.pool.tick();
    await run.pool.startReadsSettled();
  });
  assert.deepEqual(run.started(), ["NBF-4"], "NBF-4 started; the three unread tickets came first in the queue and took no slot");
  for (const key of ["NBF-1", "NBF-2", "NBF-3"]) assert.equal(waitNote(run.entry(key), run.store.get().entries), "Waits: blockers unread: Linear answered 503, retrying at 22:05Z", key);
  assert.match(written, /NBF-1, NBF-2, NBF-3: the tracker could not say which tickets block them \(Linear answered 503\)/, "a pass with a failed read logs it");
  assert.deepEqual(run.pool.figures().fill.held.map(({ key, reason }) => [key, reason]), ["NBF-1", "NBF-2", "NBF-3"].map((key) => [key, "blockers unread: Linear answered 503, retrying at 22:05Z"]), "the figures /api/health serves name the held runs and why");
});

test("a ticket whose read failed is asked again at its retry time and starts when the tracker answers", async () => {
  let down = true;
  const run = world(["NBF-1"], async (keys) => { if (down) throw new Error("Linear answered 503"); return new Map(keys.map((key) => [key, []])); });
  await logged(async () => { await run.pool.tick(); await run.pool.startReadsSettled(); });
  assert.equal(run.entry("NBF-1").phase, "queued");
  down = false;
  await logged(async () => { await run.pool.tick(); await run.pool.startReadsSettled(); });
  assert.equal(run.asked.length, 1, "not asked again before the time it named");
  run.clock.now += READ_RETRY_MS;
  await run.pool.tick();
  await run.pool.startReadsSettled();
  assert.equal(run.asked.length, 2);
  assert.deepEqual([run.entry("NBF-1").phase, run.entry("NBF-1").blockersFailure, run.entry("NBF-1").blockersReadAt], ["running", undefined, START + READ_RETRY_MS], "read, started, and its failure and age recorded");
});

test("blockers older than the limit are read again before the start; if that read fails the ticket is held and the others are not", async () => {
  const run = world(["NBF-1", "NBF-2"], async () => { throw new Error("Linear answered 503"); }, { known: ["NBF-1", "NBF-2"] });
  run.clock.now = START + BLOCKERS_MAX_AGE_MS;
  run.setQueue({ ...run.store.get(), entries: run.store.get().entries.map((e) => (e.ticket.key === "NBF-2" ? { ...e, blockersReadAt: START - 1_000 } : e)) });
  await logged(async () => { await run.pool.tick(); await run.pool.startReadsSettled(); });
  assert.deepEqual(run.started(), ["NBF-1"], "NBF-1's blockers are inside the limit: it starts on what is known, with no read");
  assert.deepEqual(run.asked, [["NBF-2"]], "NBF-2's are older than the limit: they are read again");
  assert.match(waitNote(run.entry("NBF-2"), run.store.get().entries) ?? "", /^Waits: blockers last read at 22:04Z, older than 30 minutes: Linear answered 503, retrying at 22:35Z$/);
  assert.equal(run.entry("NBF-2").phase, "queued");
});

test("blockers within the limit start on what is known: no read is made for them", async () => {
  const run = world(["NBF-1"], async () => { throw new Error("must not be asked"); }, { known: ["NBF-1"] });
  run.clock.now = START + BLOCKERS_MAX_AGE_MS;
  await run.pool.tick();
  assert.deepEqual([run.started(), run.asked], [["NBF-1"], []]);
});

test("a stale read that succeeds is stamped and the ticket starts on it", async () => {
  const run = world(["NBF-1"], async (keys) => new Map(keys.map((key) => [key, []])), { known: ["NBF-1"] });
  run.clock.now = START + BLOCKERS_MAX_AGE_MS + 1;
  await run.pool.tick();
  assert.equal(run.entry("NBF-1").phase, "queued", "too old to start on: held in this pass, and read beside it");
  await run.pool.startReadsSettled();
  assert.deepEqual([run.entry("NBF-1").phase, run.entry("NBF-1").blockersReadAt], ["running", START + BLOCKERS_MAX_AGE_MS + 1], "the read woke a pass, which started it at once");
});

test("a pass that starts nothing says why, once, and a run it started is in the health figures", async () => {
  const run = world(["NBF-1"], async (keys) => new Map(keys.map((key) => [key, []])), { known: ["NBF-1"] });
  run.store.set(pauseQueue(run.store.get()));
  const written = await logged(async () => { await run.pool.tick(); await run.pool.tick(); });
  assert.equal(written.match(/fill: 1 queued, and the queue is paused/g)?.length, 1, "said once while it stands");
  run.store.set(resumeQueue(run.store.get()));
  const after = await logged(async () => { await run.pool.tick(); });
  assert.doesNotMatch(after, /fill:/, "a pass that starts a run has nothing to explain");
  assert.notEqual(run.pool.figures().runs.sinceLastStartMs, null, "the start is in the health figures' latest start");
});

test("a plan download that hangs holds its own ticket, and a ticket whose plan is read starts", async () => {
  const run = world(["NBF-1", "NBF-2"], async (keys) => new Map(keys.map((key) => [key, []])), { plan: true, known: ["NBF-1", "NBF-2"],
    download: (ticket) => (ticket.key === "NBF-1" ? HANGS : Promise.resolve([])) });
  await run.pool.tick();
  assert.deepEqual(run.started(), [], "neither plan is read yet: both are held in the pass that asks");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual([run.entry("NBF-2").paths, run.entry("NBF-1").paths], [[], undefined], "NBF-2's plan is recorded as it ends, before NBF-1's is cut off");
  await logged(async () => { await run.pool.startReadsSettled(); });
  assert.deepEqual(run.started(), ["NBF-2"], "NBF-2's plan was read and it started; NBF-1's was cut off and it did not");
  assert.match(run.entry("NBF-1").pathsFailure ?? "", /did not finish within 0\.03s/);
  assert.equal(run.entry("NBF-1").pathsRetryAt, START + READ_RETRY_MS);
  assert.match(waitNote(run.entry("NBF-1"), run.store.get().entries) ?? "", /^Waits: its plan could not be downloaded \(.*did not finish within 0\.03s\); the board asks again at 22:05Z$/);
});
