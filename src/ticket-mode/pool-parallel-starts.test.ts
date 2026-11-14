// no-token: gh -- herdr, the tracker, the code host and the clock are all injected fakes; nothing is spawned
// module: a planned batch starts every ticket with no unfinished blocker at once, within tickets.max (A11-442, F3 step 1) -- the starts a pass chose open side by side, and the overlap and blocker rules decide as before
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
import { waitNote } from "./board-view/pull-status-and-notes.ts";
import { fakeHerdr, poolFixture } from "./pool-fixture.ts";
import { createPool, herdrName, type QueueStore } from "./pool.ts";
import { enqueue, type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { batchPlanDone, resumeQueue } from "./queue/queue-transitions.ts";
import { emptyQueue } from "./queue.ts";
import { parseTicketSettings } from "./settings.ts";

const RUNNING = "A11-499";
const HOUR_MS = 3_600_000;
const START = Date.now() + HOUR_MS;
/** The queue's slots, as the acceptance criterion names them. */
const SLOTS = 4;
/** Event-loop turns enough for a pass, the reads it began and the starts they woke to reach their first held pause. */
const PASS_TURNS = 40;
/** Rounds of turns the round test lets go of the held fetches over, each round long enough for a second fetch to begin if it could. */
const RELEASE_ROUNDS = 10;
/** The length of a git commit id in hex. */
const SHA_LENGTH = 40;
/** A commit id made of one repeated hex digit. */
const sha = (digit: string): string => digit.repeat(SHA_LENGTH);
const turns = async (count = PASS_TURNS): Promise<void> => { for (let turn = 0; turn < count; turn += 1) await new Promise((resolve) => setImmediate(resolve)); };

/** A plan whose `## Paths` names `files`, as a batch's planner attaches it. */
const planOf = (files: readonly string[]): string => `# Plan\n\n## Paths\n\n${files.map((file) => `- \`agent-org:${file}\``).join("\n")}\n`;

/**
 * A pool of four slots, one of them held by A11-499's run, over a tracker that holds a batch its planner has just settled: each ticket of `plans` queued again with its plan attached (its `## Paths` naming the files
 * given), placed in agent-org, and blocked in the tracker by the tickets `after` names, as the board records a batch's `order.json`. Every pause just after a start (`wait`) holds until `release`, so a test sees which
 * starts a pass opened before any of them settled.
 */
async function plannedBatch(plans: Readonly<Record<string, readonly string[]>>, after: Readonly<Record<string, readonly string[]>> = {}) {
  const root = tmpDir("ticket-parallel-starts-");
  const settings = parseTicketSettings({ clones: { "agent-org": "/repos/agent-org" }, stateDir: join(root, "state"), tickets: { max: SLOTS, plan: "-plan-[^/]*\\.md$" } });
  const keys = Object.keys(plans);
  const tracker = createFakeTracker([fakeTicket(RUNNING), ...keys.map((key) => fakeTicket(key))]);
  for (const key of keys) tracker.attach(key, `${key}-0001-plan-work.md`, planOf(plans[key]));
  for (const [key, blockers] of Object.entries(after)) await tracker.addBlockers!(key, blockers);
  let queue: Queue = resumeQueue(enqueue(emptyQueue(SLOTS), [fakeTicket(RUNNING)], { model: "sonnet", effort: "high" }, 0));
  const store: QueueStore = { get: () => queue, set: (next: Queue) => { queue = next; } };
  const status = new Map<string, string>();
  const herdr = fakeHerdr(status);
  const gate = { closed: false, held: [] as (() => void)[] };
  const wait = (): Promise<void> => (gate.closed ? new Promise((resolve) => { gate.held.push(resolve); }) : Promise.resolve());
  const pool = createPool(store, { settings, source: tracker, hook: { node: "/node", bin: "/tool/src/bin.ts" }, herdr: herdr.run, hostFile: "/work/.agent-org/host.json", now: () => START,
    load: () => ({ load: 1, cores: 14 }), transcriptsRoot: join(root, "transcripts"), wait, pluginRecord: join(root, "no-plugin-record.json"), codeHost: createFakeCodeHost(),
    restartReads: { bootId: () => "boot-1", herdrStart: () => "1" } });
  // A11-499's run takes one of the four slots before the batch is queued again.
  await pool.tick();
  await pool.startReadsSettled();
  status.set(herdrName(RUNNING), "working");
  const batch = { keys: new Set(keys), choice: { model: "opus", effort: "max" }, batch: true };
  store.set(keys.reduce((next, key) => batchPlanDone(next, key, "agent-org", [], START), enqueue(store.get(), keys.map((key) => fakeTicket(key)), { model: "sonnet", effort: "high" }, 1, batch)));
  const started = (): string[] => herdr.calls.filter((args) => args.includes("agent") && args.includes("start"))
    .map((args) => String(args[args.indexOf("start") + 1])).filter((label) => label !== herdrName(RUNNING));
  /** A pass with every pause after a start held: it reads what the starts are decided on, and the passes those reads wake open what they can. */
  const passHeld = async (): Promise<void> => {
    gate.closed = true;
    void pool.tick();
    await turns();
  };
  const release = async (): Promise<void> => {
    gate.closed = false;
    for (const resume of gate.held.splice(0)) resume();
    await turns();
    await pool.startReadsSettled();
  };
  const phaseOf = (key: string): string | undefined => queue.entries.find((entry) => entry.ticket.key === key)?.phase;
  return { started, passHeld, release, phaseOf, entries: () => queue.entries };
}

test("A11-442: a planned batch of five, three with no unfinished blocker, on four slots with one in use: the three start in one pass, side by side, and the two blocked tickets wait", async () => {
  const batch = await plannedBatch(
    { "A11-500": ["src/a.ts"], "A11-501": ["src/b.ts"], "A11-502": ["src/c.ts"], "A11-503": ["src/d.ts"], "A11-504": ["src/e.ts"] },
    { "A11-503": ["A11-500"], "A11-504": ["A11-503"] },
  );
  await batch.passHeld();
  assert.deepEqual(["A11-503", "A11-504"].map(batch.phaseOf), ["queued", "queued"], "the blocked tickets wait, as today");
  assert.deepEqual(batch.started().sort(), ["A11-500", "A11-501", "A11-502"].map(herdrName),
    "every unblocked ticket's agent was started before the first of them settled: none waits for another's start");
  await batch.release();
  assert.deepEqual(["A11-500", "A11-501", "A11-502"].map(batch.phaseOf), ["running", "running", "running"]);
  assert.deepEqual(["A11-503", "A11-504"].map(batch.phaseOf), ["queued", "queued"], "and still wait once the three are running");
});

test("A11-442: two unblocked tickets whose plans claim the same file: the overlap rule holds the second out of the pass that opens the first, as it does today", async () => {
  const batch = await plannedBatch({ "A11-500": ["src/shared.ts"], "A11-501": ["src/shared.ts"], "A11-502": ["src/own.ts"] });
  await batch.passHeld();
  assert.ok(batch.started().includes(herdrName("A11-500")), "the first of the two starts");
  assert.ok(!batch.started().includes(herdrName("A11-501")), "the second does not start beside it");
  assert.equal(batch.phaseOf("A11-501"), "queued");
  const held = batch.entries().find((entry) => entry.ticket.key === "A11-501")!;
  assert.match(waitNote(held, batch.entries()) ?? "", /A11-500/, "it waits on the run that holds the file it claims");
  await batch.release();
});

test("A11-442: two stacked review rounds in one clone, queued in one pass, still fetch and merge their base one after the other, as before", async () => {
  const fixture = poolFixture({ keys: ["A11-510", "A11-511"], clones: { "agent-org": "/repos/agent-org" } });
  const base = { key: "A11-509", repo: "agent-org", branch: "admin/a11-509", sha: sha("1") };
  fixture.store.set({ ...fixture.store.get(), entries: fixture.store.get().entries.map((entry, at) => ({ ...entry, blockers: [], blockersReadAt: START, stackBase: base,
    review: [{ repo: "agent-org", url: `https://github.com/a11ign/agent-org/pull/${at + 1}` }] })) });
  const fetching = { now: 0, most: 0, held: [] as (() => void)[] };
  const git = async (_cwd: string, args: readonly string[]): Promise<string> => {
    if (args[0] === "ls-remote") return `${sha("2")}\trefs/heads/${base.branch}\n`;
    if (args[0] !== "fetch") throw new Error("the test's git does nothing past the fetch");
    fetching.now += 1;
    fetching.most = Math.max(fetching.most, fetching.now);
    await new Promise<void>((resolve) => { fetching.held.push(resolve); });
    fetching.now -= 1;
    throw new Error("the test's fetch ends here");
  };
  const pool = fixture.restart({ git, now: () => START });
  const ticking = pool.tick();
  // Each held fetch is let go after a few turns, so a second round that opened beside the first would be counted while the first is still held.
  for (let turn = 0; turn < RELEASE_ROUNDS; turn += 1) {
    await turns();
    for (const resume of fetching.held.splice(0)) resume();
  }
  await ticking;
  assert.equal(fetching.most, 1, "one round's fetch at a time");
  assert.deepEqual(["A11-510", "A11-511"].map((key) => fixture.entry(key).phase), ["finished", "finished"], "both rounds were tried, each ending on its failed fetch");
});
