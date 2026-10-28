// no-token: gh -- herdr, the tracker and the clock are all injected; nothing is spawned
// A11-272, step 3: a plan whose step needs another ticket's work writes that ticket in its `## Blocked by` section, and the board records it as a blocker when it attaches the plan, so the queue orders the two before any
// run starts. The 2026-10-25 shape: A11-231's step 2 needed A11-229's step 3 (here NBF-1 and NBF-2).
import { createSettledPool } from "./pool-settled-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
import { herdrName, type QueueStore } from "./pool.ts";
import { fakeHerdr } from "./pool-fixture.ts";
import { runStatus } from "./board-view/pull-status-and-notes.ts";
import { enqueue, type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { resumeQueue } from "./queue/queue-transitions.ts";
import { emptyQueue } from "./queue.ts";
import { parseTicketSettings } from "./settings.ts";
import type { TicketSource } from "./source.ts";
import { ticketDir } from "./ticket-paths.ts";

const PLANNED = "NBF-1";
const BLOCKER = "NBF-2";
const START = Date.now() + 3_600_000;
const settled = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const plan = (middle: string) => `# Step 2 waits on ${BLOCKER}\n\n${middle}## Paths\n\n- \`agent-org:src/fit.ts\`\n`;
const BLOCKED_BY = `## Blocked by\n\nBlocked-by: ${BLOCKER}\nstep 2 needs ${BLOCKER}'s step 3\n\n`;

/** A pool of one slot over a tracker that holds NBF-1, which is being planned, and NBF-2, which is queued behind it; the planner has left `text` as NBF-1's plan, and the next tick attaches it. */
async function planning(text: string, over: (tracker: ReturnType<typeof createFakeTracker>) => TicketSource = (tracker) => tracker) {
  const root = tmpDir("ticket-plan-blockers-");
  const settings = parseTicketSettings({ clones: { "agent-org": "/repos/agent-org" }, stateDir: join(root, "state"), tickets: { plan: "-plan-[^/]*\\.md$", planner: { run: "Run the planner with: unattended: plan {key} into {dir}", state: "Planned" } } });
  const tracker = createFakeTracker([fakeTicket(PLANNED), fakeTicket(BLOCKER)]);
  const source = over(tracker);
  const tickets = [PLANNED, BLOCKER].map((key) => fakeTicket(key));
  let queue: Queue = resumeQueue(enqueue(emptyQueue(1), tickets, { model: "sonnet", effort: "high" }, 0, { keys: new Set([PLANNED]), choice: { model: "opus", effort: "max" }, batch: false }));
  const store: QueueStore = { get: () => queue, set: (next: Queue) => { queue = next; } };
  const status = new Map<string, string>();
  const herdr = fakeHerdr(status);
  const clock = { now: START };
  const pool = createSettledPool(store, { settings, source, hook: { node: "/node", bin: "/tool/src/bin.ts" }, herdr: herdr.run, hostFile: "/work/.agent-org/host.json", now: () => clock.now, load: () => ({ load: 1, cores: 14 }),
    transcriptsRoot: join(root, "transcripts"), wait: async () => {}, pluginRecord: join(root, "no-plugin-record.json"), codeHost: createFakeCodeHost() });
  await pool.tick();
  const dir = ticketDir(settings, PLANNED);
  mkdirSync(join(dir, "plan"), { recursive: true });
  writeFileSync(join(dir, "plan", `${PLANNED}-0001-plan-fit.md`), text);
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "planned" }));
  status.set(herdrName(PLANNED), "idle");
  // A run the pass starts is listed working, as its agent is: the passes a start wakes would otherwise read it as gone from herdr.
  const tick = async () => {
    clock.now += 60_000;
    for (const key of [PLANNED, BLOCKER]) if (!status.has(herdrName(key))) status.set(herdrName(key), "working");
    await pool.tick();
    await settled();
  };
  const entry = (key: string) => queue.entries.find((e) => e.ticket.key === key)!;
  const starts = () => herdr.calls.filter((args) => args.includes("agent") && args.includes("start"));
  const blockedBy = async () => (await tracker.blockers!([PLANNED])).get(PLANNED)?.map(({ key }) => key) ?? [];
  return { tick, entry, starts, tracker, blockedBy, statusOf: (key: string) => runStatus(entry(key), queue.entries) };
}

test("A11-272: a plan with a `## Blocked by` section is attached, the tracker records the blocker, the entry waits for it to merge, and the blocker starts first", async () => {
  const run = await planning(plan(BLOCKED_BY));
  await run.tick();
  assert.deepEqual(await run.blockedBy(), [BLOCKER], "the tracker has NBF-2 as NBF-1's blocker, written by the board and not the planner");
  assert.deepEqual(run.entry(PLANNED).waitMerged, [BLOCKER], "the step needs the other ticket's work on the default branch, not a diff on its branch");
  await run.tick();
  assert.deepEqual(run.entry(PLANNED).blockers?.map(({ key }) => key), [BLOCKER], "its blockers were read again with the relation, since a run with unread blockers is never started");
  assert.equal(run.statusOf(PLANNED), "blocked");
  assert.equal(run.entry(PLANNED).phase, "queued", "NBF-1 is queued behind NBF-2");
  assert.ok(["starting", "running"].includes(run.entry(BLOCKER).phase), "the blocker starts on the one slot, ahead of the ticket that waits on it");
  assert.equal(run.starts().filter((args) => args.join(" ").includes(herdrName(PLANNED))).length, 1, "NBF-1 was started once, as the planner, and not again as a worker");
});

test("A11-272: a plan with no `## Blocked by` section records no blocker and leaves the entry as planDone left it", async () => {
  const run = await planning(plan("Blocked-by: NBF-2\n\n"));
  await run.tick();
  assert.deepEqual(await run.blockedBy(), []);
  assert.equal(run.entry(PLANNED).waitMerged, undefined);
});

test("A11-272: a tracker that refuses the blocker, or takes none, still has the plan attached; the entry records no wait", async () => {
  const refusing = await planning(plan(BLOCKED_BY), (tracker) => ({ ...tracker, addBlockers: async () => { throw new Error("the tracker is down"); } }));
  await refusing.tick();
  assert.deepEqual(await refusing.blockedBy(), []);
  assert.ok(refusing.entry(PLANNED).planned, "the plan was attached and the ticket queued to be worked");
  assert.equal(refusing.entry(PLANNED).waitMerged, undefined);
  const without = await planning(plan(BLOCKED_BY), (tracker) => ({ ...tracker, addBlockers: undefined }));
  await without.tick();
  assert.ok(without.entry(PLANNED).planned, "a tracker with no blockers takes the plan all the same");
  assert.equal(without.entry(PLANNED).waitMerged, undefined);
});

test("A11-272: a tracker that refuses one of the planned blockers still records the others, and the entry waits to merge on those", async () => {
  const run = await planning(plan("## Blocked by\n\nBlocked-by: NBF-9\nBlocked-by: NBF-2\n\n"), (tracker) => ({ ...tracker, addBlockers: async (key, keys) => {
    if (keys.includes("NBF-9")) throw new Error("NBF-9 is no ticket");
    await tracker.addBlockers!(key, keys);
  } }));
  await run.tick();
  assert.deepEqual(await run.blockedBy(), [BLOCKER]);
  assert.deepEqual(run.entry(PLANNED).waitMerged, [BLOCKER]);
});
