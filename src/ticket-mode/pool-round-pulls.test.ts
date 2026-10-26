// no-token: gh -- herdr, the tracker, the code host and the clock are injected; nothing is spawned
// A11-298: the watch reads the state of every pull request a queued review round names. On 2026-10-25 A11-232's round for announcement-emulator#18 outlived #18's merge and held its files for 30 hours.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost, fakePullUrl } from "../plugins/fakes/code-host.ts";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
import { poolFixture } from "./pool-fixture.ts";
import { runStatus } from "./board-view/pull-status-and-notes.ts";

const REPOSITORY = "a11ign/announcement-emulator";
const URL_18 = fakePullUrl(REPOSITORY, 18);
const WAITER = "NBF-1";
const ROUND = "NBF-2";
const FILES = ["announcement-emulator:middleware/package.json", "announcement-emulator:middleware/src/"];

/**
 * NBF-1 queued on the middleware files and NBF-2 a queued review round on #18, held back (`pathsFailure`, which only a plan read lifts) so it never starts, as A11-232's was by its blocker: the round holds #18's files. `state` is what the
 * code host says of #18. The pool is the one over that host.
 */
function stale(state: "open" | "merged" | "closed" | null) {
  const source = createFakeTracker([fakeTicket(WAITER), fakeTicket(ROUND)]);
  if (state !== null) source.linkPull(ROUND, URL_18, state);
  const made = poolFixture({ keys: [WAITER, ROUND], max: 3, source });
  made.store.set({ ...made.store.get(), entries: made.store.get().entries.map((entry) => (entry.ticket.key === WAITER
    ? { ...entry, paths: FILES, blockers: [] }
    : { ...entry, paths: [], blockers: [], review: [{ repo: "announcement-emulator", url: URL_18 }], pathsFailure: "its plan could not be downloaded", pullFiles: { [URL_18]: ["middleware/package.json"] } })) });
  const host = createFakeCodeHost("worker-bot");
  if (state !== null) host.seedPull(REPOSITORY, 18, { state, files: ["middleware/package.json"] });
  const pool = made.restart({ codeHost: host });
  const entries = () => made.store.get().entries;
  return { ...made, source, host, pool, entries, waiterStatus: () => runStatus(made.entry(WAITER), entries()) };
}

test("A11-298: a queued round holds #18's files while #18 is open, and the ticket behind them waits", async () => {
  const run = stale("open");
  await run.pool.watchFeedback();
  await run.pool.tick();
  assert.equal(run.entry(ROUND).review?.length, 1);
  assert.equal(run.entry(WAITER).phase, "queued");
  assert.equal(run.waiterStatus(), "blocked");
});

test("A11-298: once #18 is read merged the round is dropped and the ticket behind its files starts", async () => {
  const run = stale("merged");
  await run.pool.tick();
  assert.equal(run.entry(WAITER).phase, "queued", "held by the round before the watch reads #18");
  await run.pool.watchFeedback();
  const dropped = run.entry(ROUND);
  assert.deepEqual([dropped.phase, dropped.outcome?.kind, dropped.pullStates], ["finished", "reviewed", { [URL_18]: "merged" }]);
  await run.pool.tick();
  assert.ok(["starting", "running"].includes(run.entry(WAITER).phase), "the files are free");
});

test("A11-298: a pull request closed unmerged leaves the round the same way", async () => {
  const run = stale("closed");
  await run.pool.watchFeedback();
  assert.equal(run.entry(ROUND).phase, "finished");
  assert.equal(runStatus(run.entry(ROUND), run.entries()), "cancelled");
});

test("A11-298: a state the host cannot say changes nothing, and the next watch asks again", async () => {
  const run = stale(null);
  await run.pool.watchFeedback();
  assert.deepEqual([run.entry(ROUND).phase, run.entry(ROUND).review?.length], ["queued", 1]);
  run.host.seedPull(REPOSITORY, 18, { state: "merged" });
  await run.pool.watchFeedback();
  assert.equal(run.entry(ROUND).phase, "finished");
});

test("A11-298: the watch reads the state of every pull request the round names, and only those of queued rounds", async () => {
  const run = stale("open");
  await run.pool.watchFeedback();
  assert.ok(run.host.calls.includes(`readPullState ${URL_18}`), "the round's pull request is asked about");
  assert.ok(!run.host.calls.some((call) => call.startsWith("readPullState") && !call.endsWith(URL_18)));
});

test("A11-298: the sweep that settles a finished run then completes the ticket of the dropped round", async () => {
  const run = stale("merged");
  await run.pool.watchFeedback();
  await run.pool.refreshTracker();
  assert.equal(run.source.ticketOf(ROUND)?.statusType, "completed");
  assert.equal(runStatus(run.entry(ROUND), run.entries()), "completed");
});

test("A11-298: a pass that is filling slots does not have a queued round turned into a finished run under it; the next watch settles it", async () => {
  const run = stale("merged");
  const ticking = run.pool.tick();
  await run.pool.watchFeedback();
  assert.equal(run.entry(ROUND).phase, "queued", "the pass is under way");
  await ticking;
  await run.pool.watchFeedback();
  assert.equal(run.entry(ROUND).phase, "finished");
});

test("A11-298: a pull request already read merged is not asked about again", async () => {
  const run = stale("merged");
  await run.pool.watchFeedback();
  run.host.calls.length = 0;
  await run.pool.watchFeedback();
  assert.ok(!run.host.calls.some((call) => call.startsWith("readPullState")));
});
