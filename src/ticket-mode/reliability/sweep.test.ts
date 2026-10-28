// no-token: none -- the tracker is the in-memory fake, the queue is in memory and the state directory is temporary
// A11-366: a board-reliability ticket is watched on the figure it names once its fix is released, and reopened once, with the readings, and queued when the figure does not hold
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../../lib/tmp-fixture.ts";
import { createFakeTracker, fakeTicket } from "../../plugins/fakes/tracker.ts";
import type { HealthFigures } from "../health-figures.ts";
import { emptyQueue } from "../queue.ts";
import { enqueue, find, type Queue } from "../queue/queue-entries-and-outcomes.ts";
import { loadWatches, reliabilityWatchesPath } from "./store.ts";
import { syncReliabilityWatches } from "./sweep.ts";

const DESCRIPTION = "## Done-when\n\n### After merge (who runs it)\n\n* Figure: synchronous holds under 10 an hour, for 7d\n";
const LABELLED = { description: DESCRIPTION, labels: [{ name: "board-reliability", group: null }] };

const figures = (holds: number, linear = { calls: 100, failures: 0, failuresPer100: 0 }): HealthFigures => ({
  at: 0, uptimeMs: 0, loop: { lastMinute: { p50Ms: 1, p99Ms: 9 }, lastHour: { p50Ms: 1, p99Ms: 40 } }, syncHolds: { lastHour: holds, holdMs: 100 },
  calls: { linear, github: { calls: 0, failures: 0, failuresPer100: 0 } },
  runs: { sinceLastStartMs: null, startable: 0, freeSlots: 3, starting: 0, oldestStartingMs: null, holding: null }, fill: { sinceLastCompletedMs: null, lastEarlyReturn: null },
});

/** A sweep over a temporary state directory, the fake tracker and a queue holding `keys`' tickets; `served` is the figures `/api/health` serves now, and the clock moves with `clock.at`. */
function world(keys: readonly string[] = ["A11-900"], over: Parameters<typeof fakeTicket>[1] = LABELLED) {
  const stateDir = tmpDir("reliability-sweep-");
  const tracker = createFakeTracker(keys.map((key) => fakeTicket(key, { status: "In Progress", statusType: "started", ...over })));
  const clock = { at: 1_000_000 };
  const served: { figures: HealthFigures | null } = { figures: figures(0) };
  let queue: Queue = enqueue(emptyQueue(3), keys.map((key) => tracker.ticketOf(key)!), { model: "sonnet", effort: "high" }, 0);
  const store = { get: () => queue, set: (next: Queue) => { queue = next; } };
  const ctx = { settings: { stateDir, workingState: "In Progress" }, readMs: 50, store, source: tracker, now: () => clock.at, hook: { bin: "/tool/src/bin.ts" },
    deps: { healthFigures: () => served.figures, runChoice: () => ({ model: "opus", effort: "max" }) } } as never;
  const path = reliabilityWatchesPath(stateDir);
  /** The run of `key` ended, as the fix's run did before its ticket was closed. */
  const finishRun = (key: string) => store.set({ ...queue, entries: queue.entries.map((entry) => (entry.ticket.key === key ? { ...entry, phase: "finished" as const } : entry)) });
  return { tracker, clock, served, ctx, path, finishRun, sweep: () => syncReliabilityWatches(ctx), queue: () => queue, watch: (key = keys[0]) => loadWatches(path).watches[key] };
}

test("a ticket whose figure breaches after release is reopened once, with the readings, and queued on the default model", async () => {
  const w = world();
  await w.sweep();
  assert.equal(w.watch().state, "open", "enrolled from the queue, not closed yet");
  w.finishRun("A11-900");
  w.tracker.completeAs("A11-900", "person");
  w.clock.at += 60_000;
  await w.sweep();
  assert.deepEqual([w.watch().state, w.watch().began, w.watch().reads], ["watching", 1_060_000, 1], "the first reading of the window is under 10");
  w.served.figures = figures(23);
  w.clock.at += 60_000;
  await w.sweep();

  assert.equal(w.tracker.ticketOf("A11-900")?.status, "In Progress", "moved out of Done, into the working state");
  assert.deepEqual([w.watch().state, w.watch().reopens, w.watch().commented, w.watch().queued], ["reopened", 1, true, true]);
  assert.equal(w.tracker.comments.length, 1);
  const { text } = w.tracker.comments[0]!;
  assert.match(text, /^agent-org reopened this ticket/);
  assert.match(text, /Figure: synchronous holds under 10 an hour, for 7d\./);
  assert.match(text, /Reading: synchronous holds 23 an hour at 1970-01-01T00:18:40.000Z/);
  assert.match(text, /- synchronous holds 23 an hour\n/);
  assert.match(text, /- loop lag p99 40 ms\n/);
  const entry = find(w.queue(), "A11-900");
  assert.deepEqual([entry?.phase, entry?.model, entry?.effort], ["queued", "opus", "max"], "queued on the saved default model and effort");

  w.clock.at += 60_000;
  await w.sweep();
  await w.sweep();
  assert.deepEqual([w.tracker.comments.length, w.watch().reopens, w.queue().entries.filter(({ ticket }) => ticket.key === "A11-900").length], [1, 1, 1], "not reopened, commented or queued a second time");
});

test("a figure that holds is never reopened, and the window closes held", async () => {
  const w = world();
  w.tracker.completeAs("A11-900", "person");
  w.served.figures = figures(9);
  await w.sweep();
  w.clock.at += 7 * 86_400_000;
  await w.sweep();
  assert.deepEqual([w.watch().state, w.tracker.ticketOf("A11-900")?.status, w.tracker.comments.length], ["held", "Done", 0]);
});

test("the figure of the week before the fix is installed is no breach", async () => {
  const w = world();
  w.tracker.completeAs("A11-900", "person");
  w.served.figures = figures(500);
  const merged = { ...w.queue(), runLog: { "A11-900": [{ kind: "merged", url: "https://github.com/a11ign/agent-org/pull/1", at: 1 }] } } as unknown as Queue;
  (w.ctx as { store: { set: (q: Queue) => void } }).store.set(merged);
  await w.sweep();
  assert.deepEqual([w.watch().state, w.watch().began, w.tracker.ticketOf("A11-900")?.status], ["watching", undefined, "Done"], "its pull request is in a repository whose release has had no time to install");
});

test("a ticket the person reopened is not reopened by the board, and is watched again at its next close", async () => {
  const w = world();
  w.tracker.completeAs("A11-900", "person");
  await w.sweep();
  await w.tracker.restoreState!("A11-900", { from: "In Progress", to: "Done" });
  w.served.figures = figures(50);
  await w.sweep();
  assert.deepEqual([w.watch().state, w.watch().reopens, w.tracker.comments.length], ["open", 0, 0]);
  w.tracker.completeAs("A11-900", "person");
  await w.sweep();
  assert.equal(w.watch().state, "reopened", "the second close, with the figure still over, is a breach of its own");
});

test("a ticket labelled board-reliability with no Figure line is listed with why, and is never reopened", async () => {
  const w = world(["A11-901"], { description: "## Done-when\n\n* Merged.\n", labels: [{ name: "board-reliability", group: null }] });
  w.tracker.completeAs("A11-901", "person");
  w.served.figures = figures(500);
  await w.sweep();
  assert.deepEqual([w.watch("A11-901").spec, w.watch("A11-901").why, w.tracker.ticketOf("A11-901")?.status], [null, "its Done-when has no `Figure:` line", "Done"]);
});

test("a ticket without the label is not watched", async () => {
  const w = world(["A11-902"], { description: DESCRIPTION, labels: [] });
  await w.sweep();
  assert.equal(w.watch("A11-902"), undefined);
});

test("A11-282 and A11-345 get their figures backwards: each is reopened now when its figure is already over", async () => {
  const w = world(["A11-282", "A11-345"], { description: "No figure here.", labels: [] });
  w.tracker.completeAs("A11-282", "person");
  w.tracker.completeAs("A11-345", "person");
  w.served.figures = figures(755, { calls: 300, failures: 30, failuresPer100: 10 });
  await w.sweep();
  assert.deepEqual(["A11-282", "A11-345"].map((key) => [w.watch(key).state, w.tracker.ticketOf(key)?.status]), [["reopened", "In Progress"], ["reopened", "In Progress"]]);
  assert.deepEqual(w.tracker.comments.map(({ key }) => key).sort(), ["A11-282", "A11-345"]);
});

test("A11-345's failure rate over fewer than 20 calls reads nothing, so it is neither a breach nor a hold", async () => {
  const w = world(["A11-345"], { description: "", labels: [] });
  w.tracker.completeAs("A11-345", "person");
  w.served.figures = figures(0, { calls: 3, failures: 3, failuresPer100: 100 });
  await w.sweep();
  w.clock.at += 8 * 86_400_000;
  await w.sweep();
  assert.deepEqual([w.watch("A11-345").state, w.watch("A11-345").reads, w.tracker.ticketOf("A11-345")?.status], ["watching", 0, "Done"]);
});

test("a board that serves no figures reads nothing; a tracker that refuses the reopen is tried again at the next refresh", async () => {
  const w = world();
  w.tracker.completeAs("A11-900", "person");
  w.served.figures = null;
  await w.sweep();
  assert.deepEqual([w.watch().state, w.watch().reads], ["watching", 0]);
  w.served.figures = figures(40);
  const restore = w.tracker.restoreState!;
  (w.tracker as { restoreState: unknown }).restoreState = async () => { throw new Error("Linear is down"); };
  await w.sweep();
  assert.deepEqual([w.watch().state, w.tracker.ticketOf("A11-900")?.status], ["breached", "Done"]);
  (w.tracker as { restoreState: unknown }).restoreState = restore;
  await w.sweep();
  assert.deepEqual([w.watch().state, w.watch().reopens, w.tracker.ticketOf("A11-900")?.status], ["reopened", 1, "In Progress"]);
});

test("two refreshes that overlap reopen a breached ticket once", async () => {
  const w = world();
  w.finishRun("A11-900");
  w.tracker.completeAs("A11-900", "person");
  w.served.figures = figures(40);
  await Promise.all([w.sweep(), w.sweep()]);
  assert.deepEqual([w.watch().reopens, w.tracker.comments.length], [1, 1]);
});

test("a pool given no source of the figures watches nothing and asks the tracker nothing", async () => {
  const w = world();
  (w.ctx as { deps: object }).deps = {};
  w.tracker.calls.length = 0;
  await w.sweep();
  assert.deepEqual([w.watch(), w.tracker.calls], [undefined, []]);
});

/** The tracker's `stateTypes` replaced by `replacement`, which is handed the original. */
function replaceStateTypes(tracker: ReturnType<typeof createFakeTracker>, replacement: (original: NonNullable<typeof tracker.stateTypes>) => typeof tracker.stateTypes): void {
  (tracker as { stateTypes: unknown }).stateTypes = replacement(tracker.stateTypes!);
}

test("a held watch is not asked of the tracker, and is dropped 30 days after its last reading", async () => {
  const w = world();
  w.served.figures = figures(1);
  w.tracker.completeAs("A11-900", "person");
  await w.sweep();
  w.clock.at += 7 * 86_400_000;
  await w.sweep();
  assert.equal(w.watch().state, "held");
  w.tracker.calls.length = 0;
  let asked: readonly string[] = [];
  replaceStateTypes(w.tracker, (original) => async (keys) => { asked = keys; return original(keys); });
  w.clock.at += 60_000;
  await w.sweep();
  assert.deepEqual(asked, ["A11-282", "A11-345"], "only the backfilled tickets, which are not held");
  w.clock.at += 30 * 86_400_000;
  await w.sweep();
  assert.equal(w.watch().state, "watching", "dropped, and enrolled afresh from the queue, where its ticket is still completed");
  assert.equal(w.watch().reads, 1);
});

test("a tracker call that never answers ends the sweep as a failure of its step, and the next sweep goes on", async () => {
  const w = world();
  w.tracker.completeAs("A11-900", "person");
  const original = w.tracker.stateTypes!;
  replaceStateTypes(w.tracker, () => () => new Promise(() => undefined));
  await w.sweep();
  assert.equal(w.watch().state, "open", "the states could not be read in time, so nothing moved");
  replaceStateTypes(w.tracker, () => original);
  w.clock.at += 60_000;
  await w.sweep();
  assert.equal(w.watch().state, "watching");
});
