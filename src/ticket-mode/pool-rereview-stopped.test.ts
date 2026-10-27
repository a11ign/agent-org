// no-token: gh -- the code host, the reviewer, herdr and the clock are all injected fakes; nothing is spawned
// module: a body fix is re-reviewed whatever state the run is in (A11-274) -- a stopped, parked or waiting run whose blocked head's description changed is looked at again within one sweep
//
// Built on `pool-fixture.ts` as `pool-rereview.test.ts` is: a pool over the in-memory code host and reviewer, with the one run NBF-1 holding the pull request as the round it answered. The reviewer reviews the head once and
// blocks it after the run has stopped, as a11ign.github.io#3 was: its run had stopped without an outcome, so no round followed the block, and the chairman's session fixed the body. Nothing here pushes a commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeReviewer } from "../plugins/fakes/reviewer.ts";
import { poolFixture } from "./pool-fixture.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
import { MAX_FEEDBACK_ROUNDS } from "./queue/queue-transitions.ts";
import { loadReviewerGate, REVIEWER_LOGIN } from "./reviewer-port.ts";

const REPO = "a11ign/nbl-ui-netbox";
const HEAD = "h1";
const MINUTE = 60_000;
const BODY = "Refs NBF-1\n\nPartial: step 2 of 2\n";
const FIXED = "Closes NBF-1\n";
const CHANGED = [{ kind: "removed", text: "Refs NBF-1" }, { kind: "removed", text: "Partial: step 2 of 2" }, { kind: "added", text: "Closes NBF-1" }];

/** The clock of a test, in milliseconds. */
const clock = { ms: 0 };

/** The state of NBF-1 as the reviewer blocks: `state` is set on the run, which holds pull request 1 of `REPO` as its round's (`review`) and last finished, or was started, before the block. */
async function blockedWhile(state: Partial<Entry>) {
  await loadReviewerGate();
  clock.ms = 10 * MINUTE;
  const fixture = poolFixture({ keys: ["NBF-1"], tickets: { reviewer: "atomic", drafts: false }, now: () => clock.ms });
  const host = createFakeCodeHost("worker-bot");
  const { url } = host.seedPull(REPO, 1, { head: HEAD, body: BODY, settled: true, trust: "inside" });
  const reviewer = createFakeReviewer();
  await reviewer.load();
  const queue = fixture.store.get();
  fixture.store.set({ ...queue, entries: [{ ...queue.entries[0], review: [{ repo: "nbl-ui-netbox", url }], finishedAt: 15 * MINUTE, rounds: 0, ...state }] });
  const pool = fixture.restart({ codeHost: host, reviewer });
  const pull = host.pullAt(url)!;
  pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 1, "the first review of the head starts");
  reviewer.wrote({ pr: url, head: HEAD }, null);
  clock.ms = 20 * MINUTE;
  pull.reviews = [{ author: REVIEWER_LOGIN, state: "CHANGES_REQUESTED", commit: HEAD, at: clock.ms }];
  pool.reviewNewHeads();
  clock.ms = 30 * MINUTE;
  const entry = () => fixture.store.get().entries[0];
  const set = (more: Partial<Entry>) => fixture.store.set({ ...fixture.store.get(), entries: [{ ...entry(), ...more }] });
  return { reviewer, pool, pull, url, entry, set };
}

const PARKED: Partial<Entry> = { phase: "finished", outcome: { kind: "no-outcome" }, workspace: "w1", pane: "w1:p1" };
const RUNNING: Partial<Entry> = { phase: "running", workspace: "w1", pane: "w1:p1", finishedAt: undefined };

test("A11-274: a parked run that stopped without an outcome before the block has its body fix re-reviewed on the same head within one sweep, and the look counts as one of its rounds", async () => {
  const { reviewer, pool, pull, url, entry } = await blockedWhile(PARKED);
  pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 1, "a block nobody answered starts nothing");
  pull.body = FIXED;
  pool.reviewNewHeads();
  assert.deepEqual(reviewer.started, [{ pr: url, head: HEAD }, { pr: url, head: HEAD }], "the same head, with no commit");
  assert.deepEqual(reviewer.briefs[1]?.rereview?.body, CHANGED, "told which lines changed");
  assert.equal(entry().rounds, 1, "counted as A11-235 counts a re-review");
});

test("A11-274: a running run waiting in its terminal, and one idle on a working note, have a body fix re-reviewed within one sweep", async () => {
  for (const [why, state] of [["on a dialog", { waiting: true }], ["idle on a working note", { working: { reason: "step 2", at: 12 * MINUTE, idleSince: 12 * MINUTE } }]] as const) {
    const { reviewer, pool, pull, entry } = await blockedWhile({ ...RUNNING, ...state });
    pull.body = FIXED;
    pool.reviewNewHeads();
    assert.equal(reviewer.started.length, 2, why);
    assert.deepEqual(reviewer.briefs[1]?.rereview?.body, CHANGED, why);
    assert.equal(entry().rounds, 1, why);
  }
});

test("A11-274: a running run whose agent is working gets no re-review, and once it is seen idle it gets one", async () => {
  const { reviewer, pool, pull, set, entry } = await blockedWhile(RUNNING);
  pull.body = FIXED;
  pool.reviewNewHeads();
  assert.deepEqual([reviewer.started.length, entry().rounds], [1, 0], "the worker may still be editing the description");
  set({ working: { reason: "step 2", at: 31 * MINUTE, idleSince: 31 * MINUTE } });
  pool.reviewNewHeads();
  assert.deepEqual([reviewer.started.length, entry().rounds], [2, 1]);
});

test("A11-274: a stopped run with no round left is handed back once and starts no reviewer", async () => {
  const { reviewer, pool, pull, entry } = await blockedWhile({ ...PARKED, rounds: MAX_FEEDBACK_ROUNDS });
  pull.body = FIXED;
  pool.reviewNewHeads();
  const handedBack = entry().handedBack;
  pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 1, "no reviewer");
  assert.equal(entry().rounds, MAX_FEEDBACK_ROUNDS, "and no round counted");
  assert.match(handedBack ?? "", /^The pull requests keep getting feedback: the board answered 3 rounds on its own and stopped\. .*was answered by editing the description/);
  assert.equal(entry().handedBack, handedBack, "once");
});

test("A11-274: a review round the block queued keeps A11-235's rule while it runs, even waiting in its terminal, and the round's end releases the look", async () => {
  const { reviewer, pool, pull, set, entry } = await blockedWhile(PARKED);
  set({ ...RUNNING, queuedAt: 21 * MINUTE, waiting: true });
  pull.body = FIXED;
  pool.reviewNewHeads();
  assert.deepEqual([reviewer.started.length, entry().rounds], [1, 0], "the block's own round is under way: its end is the answer");
  set({ phase: "finished", outcome: { kind: "no-outcome" }, finishedAt: 35 * MINUTE, waiting: false });
  pool.reviewNewHeads();
  assert.deepEqual([reviewer.started.length, entry().rounds], [2, 1]);
});

test("A11-274: a running run with no round left starts no reviewer and is not handed back while it runs, and is handed back once it has stopped", async () => {
  const { reviewer, pool, pull, set, entry } = await blockedWhile({ ...RUNNING, waiting: true, rounds: MAX_FEEDBACK_ROUNDS });
  pull.body = FIXED;
  pool.reviewNewHeads();
  assert.deepEqual([reviewer.started.length, entry().handedBack], [1, undefined]);
  set({ phase: "finished", outcome: { kind: "no-outcome" }, finishedAt: 35 * MINUTE, waiting: false });
  pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 1);
  assert.match(entry().handedBack ?? "", /^The pull requests keep getting feedback/);
});
