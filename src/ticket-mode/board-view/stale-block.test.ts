// no-token: none -- a pool over fakes with an injected clock; nothing is spawned
//
// A11-213: a pull request that has sat CHANGES_REQUESTED with no new push and no run for more than 30 minutes is flagged Needs you, from the watch's own reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "../../plugins/fakes/code-host.ts";
import { poolFixture } from "../pool-fixture.ts";
import { finish } from "../queue/queue-transitions.ts";
import { recordPullHeads, recordStaleBlock } from "../queue/queue-pull-heads.ts";
import { emptyQueue } from "../queue.ts";
import { enqueue, type Entry, type Queue } from "../queue/queue-entries-and-outcomes.ts";
import type { Ticket } from "../source.ts";
import { runStatus } from "./pull-status-and-notes.ts";
import { reasonOf } from "./run-reason.ts";
import { isStaleBlockNote, STALE_BLOCK_MINUTES, staleBlockNote, stampedBlocks } from "./stale-block.ts";
import type { PullHead, ViewEntry } from "./view-types-and-filters.ts";

const MINUTE = 60_000;
const PR = "https://github.com/a11ign/control/pull/132";
const PRS = [{ repo: "control", url: PR }];
const BLOCKED: PullHead = { head: "abcd1234ef56", approved: false, review: "changes-requested", red: [], pending: [] };
const NOTE = "a11ign/control #132 has sat changes requested at `abcd1234` for more than 30 minutes, with no new push and no run: a person decides";

/** A finished run whose pull request was first read blocked `minutes` before `NOW`. */
const NOW = 10_000_000_000;
const blockedFor = (minutes: number, over: Partial<ViewEntry> = {}): ViewEntry =>
  ({ ticket: { key: "A11-203" }, phase: "finished", outcome: { kind: "reviewed", prs: PRS }, pullHeads: { [PR]: { ...BLOCKED, blockedSince: NOW - minutes * MINUTE } }, ...over });

test("A11-213: a pull request blocked for 31 minutes is noted, naming it and the head, and one blocked for 29 or exactly 30 is not", () => {
  assert.equal(STALE_BLOCK_MINUTES, 30);
  assert.equal(staleBlockNote(blockedFor(31), NOW), NOTE);
  assert.equal(staleBlockNote(blockedFor(29), NOW), null);
  assert.equal(staleBlockNote(blockedFor(30), NOW), null, "more than 30, not 30");
  assert.equal(staleBlockNote(blockedFor(24 * 60), NOW), NOTE, "the note does not count minutes, so it is the same on every watch");
});

test("A11-213: a new head, an approval, a lifted block, a parked run, a running round and a queued round give no note", () => {
  const stale = { ...BLOCKED, blockedSince: NOW - 90 * MINUTE };
  const pullHeads = (head: PullHead) => ({ [PR]: head });
  assert.equal(staleBlockNote(blockedFor(90, { pullHeads: pullHeads({ ...BLOCKED }) }), NOW), null, "a head just read blocked has no stamp yet");
  assert.equal(staleBlockNote(blockedFor(90, { pullHeads: pullHeads({ ...stale, review: "approved", approved: true }) }), NOW), null, "approved");
  assert.equal(staleBlockNote(blockedFor(90, { pullHeads: pullHeads({ ...stale, review: "none" }) }), NOW), null, "the block is lifted");
  assert.equal(staleBlockNote(blockedFor(90, { workspace: "w1" }), NOW), null, "a parked run is already a person's");
  assert.equal(staleBlockNote(blockedFor(90, { phase: "running" }), NOW), null, "a round is running");
  assert.equal(staleBlockNote(blockedFor(90, { phase: "queued" }), NOW), null, "a round is queued");
  assert.equal(staleBlockNote(blockedFor(90, { pullStates: { [PR]: "merged" } }), NOW), null, "a merged pull request is not blocked");
  assert.equal(staleBlockNote(blockedFor(90, { pullStates: { [PR]: "closed" } }), NOW), null, "nor is a closed one");
  assert.equal(staleBlockNote(blockedFor(90, { pullHeads: undefined }), NOW), null, "one the watch has not read");
});

test("A11-213: every pull request that is stale is named, and one that is not is left out", () => {
  const other = "https://github.com/a11ign/agent-org/pull/9";
  const third = "https://github.com/a11ign/toolchain/pull/4";
  const entry = blockedFor(40, { outcome: { kind: "reviewed", prs: [...PRS, { repo: "agent-org", url: other }, { repo: "toolchain", url: third }] },
    pullHeads: { [PR]: { ...BLOCKED, blockedSince: NOW - 40 * MINUTE }, [other]: { ...BLOCKED, head: "99998888", blockedSince: NOW - 50 * MINUTE }, [third]: { ...BLOCKED, head: "77776666", blockedSince: NOW - 5 * MINUTE } } });
  assert.equal(staleBlockNote(entry, NOW), `${NOTE}; a11ign/agent-org #9 has sat changes requested at \`99998888\` for more than 30 minutes, with no new push and no run: a person decides`);
});

test("A11-213: the stamp is set when a head is first read blocked, kept across reads at the same head, and dropped by a new head or a lifted block", () => {
  const read = { [PR]: { ...BLOCKED } };
  const first = stampedBlocks(read, undefined, 1000);
  assert.equal(first[PR].blockedSince, 1000, "stamped at the first read");
  const again = stampedBlocks(read, first, 5000);
  assert.deepEqual(again, first, "a later read at the same head and the same review keeps the earlier stamp, so the record does not change");
  assert.equal(stampedBlocks({ [PR]: { ...BLOCKED, head: "newhead" } }, first, 6000)[PR].blockedSince, 6000, "a new head starts the count again");
  assert.equal("blockedSince" in stampedBlocks({ [PR]: { ...BLOCKED, review: "approved", approved: true } }, first, 7000)[PR], false, "an approval drops it");
  const lifted = stampedBlocks({ [PR]: { ...BLOCKED, review: "none" } }, first, 8000);
  assert.equal("blockedSince" in lifted[PR], false, "a lifted block drops it");
  assert.equal(stampedBlocks(read, lifted, 9000)[PR].blockedSince, 9000, "and a block that comes back counts from when it came back");
  assert.equal("blockedSince" in stampedBlocks({ [PR]: { head: "h", approved: false } }, undefined, 1)[PR], false, "a head whose review was not read is not a block");
});

/** A queue of one finished run, the way `recordStaleBlock` is applied to it. */
const finishedQueue = (outcome: Entry["outcome"] = { kind: "reviewed", prs: PRS }): Queue => {
  const queue = enqueue(emptyQueue(1), [{ key: "A11-203", title: "t", description: "", url: "u", branch: "b", status: "Backlog", statusOrder: 0, team: "A11", project: null, priority: 0 } as Ticket], { model: "sonnet", effort: "high" }, 0);
  return finish(queue, "A11-203", outcome!, 100);
};
const handedBackOf = (queue: Queue): string | undefined => queue.entries[0].handedBack;

test("A11-213: a note becomes the run's handedBack and reads Needs you; a null note clears it, and clears no other hand-back", () => {
  const flagged = recordStaleBlock(finishedQueue(), "A11-203", NOTE);
  assert.equal(handedBackOf(flagged), NOTE);
  assert.equal(runStatus(flagged.entries[0] as ViewEntry), "needs-you");
  assert.equal(reasonOf(flagged.entries[0] as ViewEntry).line, NOTE, "the card shows the note");
  assert.equal(handedBackOf(recordStaleBlock(flagged, "A11-203", null)), undefined, "a push, an approval or a round clears the note it set");
  const capped = { ...finishedQueue(), entries: [{ ...finishedQueue().entries[0], handedBack: "The pull requests keep getting feedback: the board answered 3 rounds on its own and stopped." }] } as Queue;
  assert.equal(handedBackOf(recordStaleBlock(capped, "A11-203", null)), capped.entries[0].handedBack, "another hand-back is left alone when the block goes");
  assert.equal(handedBackOf(recordStaleBlock(capped, "A11-203", NOTE)), capped.entries[0].handedBack, "and is not written over");
  assert.equal(isStaleBlockNote(NOTE), true);
  assert.equal(isStaleBlockNote("a11ign/control #132 conflicts with its base branch main."), false);
});

test("A11-213: a run that already reads Needs you for its own reason keeps its worker's words, and a failed, concluded or settled run is not flagged", () => {
  const disputed = finishedQueue({ kind: "needs-human", reason: `${PR} is blocked by a rule the ticket overrides` });
  assert.equal(handedBackOf(recordStaleBlock(disputed, "A11-203", NOTE)), undefined, "the worker's reason is the card's line");
  for (const outcome of [{ kind: "crashed", reason: "the pool restarted" }, { kind: "checked", reason: "nothing to change" }] as const) {
    assert.equal(handedBackOf(recordStaleBlock(finishedQueue(outcome), "A11-203", NOTE)), undefined, `${outcome.kind} keeps its own reading`);
  }
  const completed = { ...finishedQueue(), entries: [{ ...finishedQueue().entries[0], trackerState: "completed" }] } as Queue;
  assert.equal(handedBackOf(recordStaleBlock(completed, "A11-203", NOTE)), undefined);
  const published = { ...finishedQueue(), entries: [{ ...finishedQueue().entries[0], published: { link: null, at: 1 } }] } as Queue;
  assert.equal(handedBackOf(recordStaleBlock(published, "A11-203", NOTE)), NOTE, "a published run waits on a merge, and is flagged");
});

// The pool: its watch reads the pull request, stamps the block from its own clock, and sets the run's handedBack once the block is stale.
/** The blocked pool, watched at the first read and again at 31 minutes, when the pull request is flagged. */
function flaggedPool() {
  const made = blockedPool();
  made.pool.watchFeedback();
  made.clock.now = NOW + 31 * MINUTE;
  made.pool.watchFeedback();
  return made;
}

function blockedPool() {
  const clock = { now: NOW };
  const host = createFakeCodeHost("worker-bot");
  host.seedPull("a11ign/control", 132, { head: "abcd1234ef56", feedback: { reviewDecision: "changes-requested", verdictAtHead: "changes-requested" } });
  const fixture = poolFixture({ keys: ["A11-203"], now: () => clock.now });
  fixture.store.set(finish(fixture.store.get(), "A11-203", { kind: "reviewed", prs: PRS }, NOW - 5 * MINUTE));
  const pool = fixture.restart({ codeHost: host });
  const entry = () => fixture.entry("A11-203") as Entry & ViewEntry;
  return { clock, host, pool, entry, store: fixture.store };
}

test("A11-213: the watch flags a pull request blocked for 31 minutes as Needs you, not before, and clears the flag once the head moves", () => {
  const { clock, host, pool, entry } = blockedPool();
  pool.watchFeedback();
  assert.equal(entry().pullHeads?.[PR]?.blockedSince, NOW, "the first read that finds it blocked stamps it");
  assert.equal(runStatus(entry()), "awaiting-review", "a reviewed run with a blocked pull request is not asking anyone, which is the gap");
  clock.now = NOW + 29 * MINUTE;
  pool.watchFeedback();
  assert.equal(entry().handedBack, undefined, "29 minutes is not enough");
  assert.equal(entry().pullHeads?.[PR]?.blockedSince, NOW, "and the stamp was kept across the reads");
  clock.now = NOW + 31 * MINUTE;
  pool.watchFeedback();
  assert.equal(entry().handedBack, NOTE);
  assert.equal(runStatus(entry()), "needs-you");
  assert.equal(reasonOf(entry()).line, NOTE);
  const written = JSON.stringify(entry());
  clock.now = NOW + 45 * MINUTE;
  pool.watchFeedback();
  assert.equal(JSON.stringify(entry()), written, "a later watch finds the same state and rewrites nothing");
  // A push moves the head: the block is not the same block, and the flag goes.
  const pull = host.pullAt(PR)!;
  pull.head = "feedc0de0000";
  pull.feedback = {};
  pool.watchFeedback();
  assert.equal(entry().handedBack, undefined, "a new head clears the flag");
  assert.equal(runStatus(entry()), "awaiting-review");
  assert.equal(entry().pullHeads?.[PR]?.blockedSince, undefined);
});

test("A11-213: the flag goes when the reviewer approves the same head, and a pull request blocked again counts its 30 minutes from when it was blocked again", () => {
  const { clock, host, pool, entry } = flaggedPool();
  assert.equal(entry().handedBack, NOTE);
  const pull = host.pullAt(PR)!;
  pull.feedback = { reviewDecision: "approved", verdictAtHead: "approved" };
  pool.watchFeedback();
  assert.equal(entry().handedBack, undefined, "an approval clears it");
  clock.now = NOW + 40 * MINUTE;
  pull.feedback = { reviewDecision: "changes-requested", verdictAtHead: "changes-requested" };
  pool.watchFeedback();
  assert.equal(entry().pullHeads?.[PR]?.blockedSince, NOW + 40 * MINUTE, "blocked again, counted from now");
  assert.equal(entry().handedBack, undefined);
});

test("A11-213: a flag set on a run whose pull request then merges or whose ticket the tracker settles is cleared, so the card does not quote a block that is gone", () => {
  for (const settled of [{ pullStates: { [PR]: "merged" } }, { pullStates: { [PR]: "closed" } }, { trackerState: "completed" }, { trackerState: "canceled" }]) {
    const { pool, entry, store } = flaggedPool();
    assert.equal(entry().handedBack, NOTE);
    store.set({ ...store.get(), entries: store.get().entries.map((e) => ({ ...e, ...settled })) } as Queue);
    pool.watchFeedback();
    assert.equal(entry().handedBack, undefined, JSON.stringify(settled));
  }
});

/** Let the tick that a feedback round wakes, which `watchFeedback` does not wait for, finish before the test's directory is removed. */
const roundStarted = async () => { for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

test("A11-213: a round the same watch starts is not lost to the flag: new feedback on a pull request that goes stale in that watch starts its round, and the round carries no note", async () => {
  const { clock, host, pool, entry } = blockedPool();
  pool.watchFeedback();
  clock.now = NOW + 31 * MINUTE;
  Object.assign(host.pullAt(PR)!.feedback, { authors: ["alice"], feedbackAt: clock.now - 1000 });
  pool.watchFeedback();
  assert.deepEqual([entry().phase, entry().rounds], ["queued", 1], "the round was queued from the feedback");
  assert.equal(entry().handedBack, undefined);
  await roundStarted();
});

test("A11-213: recordPullHeads keeps the stamp it is given", () => {
  const queue = recordPullHeads(finishedQueue(), "A11-203", { [PR]: { ...BLOCKED, blockedSince: 42 } });
  assert.equal(queue.entries[0].pullHeads?.[PR]?.blockedSince, 42);
});
