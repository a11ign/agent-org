// no-token: none -- a pool over fakes with an injected clock; nothing is spawned
//
// A11-213: a pull request that has sat CHANGES_REQUESTED with no new push and no run for more than 30 minutes is flagged Needs you, from the watch's own reads.
// A11-352: but only when the board cannot start the round that answers it. A run the board watches gets that round, as Respond would start it, and a person is not asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "../../plugins/fakes/code-host.ts";
import { poolFixture } from "../pool-fixture.ts";
import { finish } from "../queue/queue-transitions.ts";
import { logOf } from "../queue/run-log.ts";
import { recordPullHeads, recordStaleBlock } from "../queue/queue-pull-heads.ts";
import { emptyQueue } from "../queue.ts";
import { enqueue, type Entry, type Queue } from "../queue/queue-entries-and-outcomes.ts";
import type { Ticket } from "../source.ts";
import { runStatus } from "./pull-status-and-notes.ts";
import { reasonOf } from "./run-reason.ts";
import { blockRoundLine, blocksToAnswer, isStaleBlockNote, STALE_BLOCK_MINUTES, staleBlockNote, stampedBlocks } from "./stale-block.ts";
import type { PullHead, ViewEntry } from "./view-types-and-filters.ts";

const MINUTE = 60_000;
const PR = "https://github.com/a11ign/control/pull/132";
const PRS = [{ repo: "control", url: PR }];
const BLOCKED: PullHead = { head: "abcd1234ef56", approved: false, review: "changes-requested", red: [], pending: [] };
const NOTE = "a11ign/control #132 has sat changes requested at `abcd1234` for more than 30 minutes, with no new push and no run: the pull request is a draft, and Approve starts the round that answers the review";
/** The note of a head whose stand-off ended with both routes tried (A11-290): the one case of a watched run the board does not start a round for. */
const ENDED_NOTE = "a11ign/control #132 has sat changes requested at `abcd1234` for more than 30 minutes, with no new push and no run: a person decides";
const DRAFT = { kind: "draft-pr", prs: PRS } as const;
const REVIEWED = { kind: "reviewed", prs: PRS } as const;

/** A finished run whose pull request was first read blocked `minutes` before `NOW`. It ended on a DRAFT, which the board does not answer on its own (Approve does), so a block that has stood is a note. */
const NOW = 10_000_000_000;
const blockedFor = (minutes: number, over: Partial<ViewEntry> = {}): ViewEntry =>
  ({ ticket: { key: "A11-203" }, phase: "finished", outcome: DRAFT, pullHeads: { [PR]: { ...BLOCKED, blockedSince: NOW - minutes * MINUTE } }, ...over });
/** The same block on a run that ended `reviewed`: the board watches it, so it answers the block itself. */
const watchedBlockedFor = (minutes: number, over: Partial<ViewEntry> = {}): ViewEntry => blockedFor(minutes, { outcome: REVIEWED, ...over });

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
  const entry = blockedFor(40, { outcome: { kind: "draft-pr", prs: [...PRS, { repo: "agent-org", url: other }, { repo: "toolchain", url: third }] },
    pullHeads: { [PR]: { ...BLOCKED, blockedSince: NOW - 40 * MINUTE }, [other]: { ...BLOCKED, head: "99998888", blockedSince: NOW - 50 * MINUTE }, [third]: { ...BLOCKED, head: "77776666", blockedSince: NOW - 5 * MINUTE } } });
  assert.equal(staleBlockNote(entry, NOW), `${NOTE}; a11ign/agent-org #9 has sat changes requested at \`99998888\` for more than 30 minutes, with no new push and no run: the pull request is a draft, and Approve starts the round that answers the review`);
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
/** The blocked pool of a draft, watched at the first read and again at 31 minutes, when the pull request is flagged: the board cannot start a round for a draft. */
async function flaggedPool() {
  const made = blockedPool();
  await made.pool.watchFeedback();
  made.clock.now = NOW + 31 * MINUTE;
  await made.pool.watchFeedback();
  return made;
}

/** A finished run over a blocked pull request. A `paused` queue starts nothing, so a round the watch queues stays queued for the test to read. */
function blockedPool(outcome: Entry["outcome"] = DRAFT, paused = false) {
  const clock = { now: NOW };
  const host = createFakeCodeHost("worker-bot");
  host.seedPull("a11ign/control", 132, { head: "abcd1234ef56", feedback: { reviewDecision: "changes-requested", verdictAtHead: "changes-requested" } });
  const fixture = poolFixture({ keys: ["A11-203"], now: () => clock.now });
  fixture.store.set({ ...finish(fixture.store.get(), "A11-203", outcome!, NOW - 5 * MINUTE), paused });
  const pool = fixture.restart({ codeHost: host });
  const entry = () => fixture.entry("A11-203") as Entry & ViewEntry;
  return { clock, host, pool, entry, store: fixture.store };
}

test("A11-213: the watch flags a pull request blocked for 31 minutes as Needs you, not before, and clears the flag once the head moves", async () => {
  const { clock, host, pool, entry } = blockedPool();
  await pool.watchFeedback();
  assert.equal(entry().pullHeads?.[PR]?.blockedSince, NOW, "the first read that finds it blocked stamps it");
  assert.equal(runStatus(entry()), "awaiting-review", "a draft with a blocked pull request is not asking anyone until the note");
  clock.now = NOW + 29 * MINUTE;
  await pool.watchFeedback();
  assert.equal(entry().handedBack, undefined, "29 minutes is not enough");
  assert.equal(entry().pullHeads?.[PR]?.blockedSince, NOW, "and the stamp was kept across the reads");
  clock.now = NOW + 31 * MINUTE;
  await pool.watchFeedback();
  assert.equal(entry().handedBack, NOTE);
  assert.equal(runStatus(entry()), "needs-you");
  assert.equal(reasonOf(entry()).line, NOTE);
  const written = JSON.stringify(entry());
  clock.now = NOW + 45 * MINUTE;
  await pool.watchFeedback();
  assert.equal(JSON.stringify(entry()), written, "a later watch finds the same state and rewrites nothing");
  // A push moves the head: the block is not the same block, and the flag goes.
  const pull = host.pullAt(PR)!;
  pull.head = "feedc0de0000";
  pull.feedback = {};
  await pool.watchFeedback();
  assert.equal(entry().handedBack, undefined, "a new head clears the flag");
  assert.equal(runStatus(entry()), "awaiting-review");
  assert.equal(entry().pullHeads?.[PR]?.blockedSince, undefined);
});

test("A11-340: a head nobody reviewed is not read, logged or flagged as changes requested because GitHub still holds the decision from the head before", async () => {
  const { clock, host, pool, entry, store } = blockedPool();
  await pool.watchFeedback();
  const verdicts = () => logOf(store.get(), "A11-203").filter((event) => event.kind === "verdict");
  assert.deepEqual(verdicts().map((event) => event.kind === "verdict" && [event.head, event.review]), [["abcd1234ef56", "changes-requested"]], "the head the reviewer blocked is logged once");
  // The worker pushes: GitHub's decision stays CHANGES_REQUESTED, and no review sits at the new head.
  const pull = host.pullAt(PR)!;
  pull.head = "8b3d0ba9aaaa";
  pull.feedback = { reviewDecision: "changes-requested", verdictAtHead: null };
  await pool.watchFeedback();
  assert.equal(entry().pullHeads?.[PR]?.head, "8b3d0ba9aaaa");
  assert.equal(entry().pullHeads?.[PR]?.review, "none", "no review at the head is no verdict, whatever the decision says");
  assert.equal(entry().pullHeads?.[PR]?.blockedSince, undefined);
  assert.equal(verdicts().length, 1, "no verdict is logged for the new head");
  clock.now = NOW + 31 * MINUTE;
  await pool.watchFeedback();
  assert.equal(entry().handedBack, undefined, "and no stale-block note blames it");
  assert.equal(staleBlockNote(entry(), clock.now), null);
});

test("A11-213: the flag goes when the reviewer approves the same head, and a pull request blocked again counts its 30 minutes from when it was blocked again", async () => {
  const { clock, host, pool, entry } = await flaggedPool();
  assert.equal(entry().handedBack, NOTE);
  const pull = host.pullAt(PR)!;
  pull.feedback = { reviewDecision: "approved", verdictAtHead: "approved" };
  await pool.watchFeedback();
  assert.equal(entry().handedBack, undefined, "an approval clears it");
  clock.now = NOW + 40 * MINUTE;
  pull.feedback = { reviewDecision: "changes-requested", verdictAtHead: "changes-requested" };
  await pool.watchFeedback();
  assert.equal(entry().pullHeads?.[PR]?.blockedSince, NOW + 40 * MINUTE, "blocked again, counted from now");
  assert.equal(entry().handedBack, undefined);
});

test("A11-213: a flag set on a run whose pull request then merges or whose ticket the tracker settles is cleared, so the card does not quote a block that is gone", async () => {
  for (const settled of [{ pullStates: { [PR]: "merged" } }, { pullStates: { [PR]: "closed" } }, { trackerState: "completed" }, { trackerState: "canceled" }]) {
    const { pool, entry, store } = await flaggedPool();
    assert.equal(entry().handedBack, NOTE);
    store.set({ ...store.get(), entries: store.get().entries.map((e) => ({ ...e, ...settled })) } as Queue);
    await pool.watchFeedback();
    assert.equal(entry().handedBack, undefined, JSON.stringify(settled));
  }
});

/** Let the tick that a feedback round wakes, which `watchFeedback` does not wait for, finish before the test's directory is removed. */
const roundStarted = async () => { for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

test("A11-213: a round the same watch starts is not lost to the flag: new feedback on a pull request that goes stale in that watch starts its round, and the round carries no note", async () => {
  const { clock, host, pool, entry } = blockedPool(REVIEWED, true);
  await pool.watchFeedback();
  clock.now = NOW + 31 * MINUTE;
  Object.assign(host.pullAt(PR)!.feedback, { authors: ["alice"], feedbackAt: clock.now - 1000 });
  await pool.watchFeedback();
  assert.deepEqual([entry().phase, entry().rounds], ["queued", 1], "the round was queued from the feedback");
  assert.equal(entry().handedBack, undefined);
  await roundStarted();
});

// --- A11-352: the board answers a block that has stood, and asks a person only when it cannot ---------------------------------------------------------------------------

test("A11-352: a block that has stood on a run the board watches is answered by a round and gives no note; one that has not stood, a parked run and a settled pull request are left alone", () => {
  const stood = watchedBlockedFor(31);
  assert.equal(staleBlockNote(stood, NOW), null, "the board starts the round, so there is nothing to tell a person");
  assert.deepEqual(blocksToAnswer(stood, NOW), [{ url: PR, head: BLOCKED.head }]);
  assert.equal(blockRoundLine({ url: PR, head: BLOCKED.head }), "a11ign/control #132 has sat changes requested at `abcd1234` for more than 30 minutes with no new push: answer the review, then push.");
  assert.deepEqual(blocksToAnswer(watchedBlockedFor(30), NOW), [], "more than 30 minutes, not 30");
  assert.deepEqual(blocksToAnswer(watchedBlockedFor(90, { workspace: "w1" }), NOW), [], "a parked run is a person's, and Respond closes its workspace first");
  assert.deepEqual(blocksToAnswer(watchedBlockedFor(90, { pullStates: { [PR]: "merged" } }), NOW), [], "a merged pull request is not blocked");
  assert.deepEqual(blocksToAnswer(watchedBlockedFor(90, { phase: "running" }), NOW), [], "a round is under way");
  assert.deepEqual(blocksToAnswer(watchedBlockedFor(90, { pullHeads: { [PR]: { ...BLOCKED, review: "approved", approved: true, blockedSince: NOW - 90 * MINUTE } } }), NOW), [], "an approval ends the block");
});

test("A11-352: a run the board does not watch is noted, saying why no round starts: a draft waits for Approve, a run that ended another way for Respond", () => {
  assert.equal(staleBlockNote(blockedFor(31), NOW), NOTE);
  assert.deepEqual(blocksToAnswer(blockedFor(31), NOW), [], "the board starts no round on a draft");
  const crashed = staleBlockNote(blockedFor(31, { outcome: { kind: "crashed", reason: "the pool restarted" }, review: PRS }), NOW);
  assert.match(crashed ?? "", /no run: the board does not start a round on a run that ended this way, and Respond to review does$/);
  assert.equal(isStaleBlockNote(NOTE) && isStaleBlockNote(crashed ?? undefined), true, "both are the board's own, so the board clears them");
  assert.equal(isStaleBlockNote("a11ign/control #132 has sat changes requested at `abcd1234` for more than 30 minutes, with no new push and no run: a person decides"), true, "and so is a note written before the reason was named");
});

test("A11-352: a stand-off whose routes have ended is the one block of a watched run the board does not answer, and says a person decides", () => {
  const ended = watchedBlockedFor(31, { standoff: { ...STANDOFF, planner: { decision: "upheld", reason: "The entry point can be split." } } });
  assert.deepEqual(blocksToAnswer(ended, NOW), [], "its two routes were the rounds, and a third is not started");
  assert.ok(staleBlockNote(ended, NOW)?.startsWith(ENDED_NOTE));
});

test("A11-352: a finished reviewed run whose pull request has sat changes requested at its head gets a feedback round from the board at 31 minutes, and no Needs-you note", async () => {
  const { clock, pool, entry, store } = blockedPool(REVIEWED, true);
  await pool.watchFeedback();
  assert.equal(entry().phase, "finished", "a head just read blocked has not stood yet, and the reviewer and the stand-off have their window");
  clock.now = NOW + 29 * MINUTE;
  await pool.watchFeedback();
  assert.equal(entry().phase, "finished", "29 minutes is not enough");
  clock.now = NOW + 31 * MINUTE;
  await pool.watchFeedback();
  assert.deepEqual([entry().phase, entry().rounds, entry().handedBack], ["queued", 1, undefined], "the round Respond would start is queued, counted as the board's own, with nobody asked");
  assert.match(entry().feedback ?? "", /a11ign\/control #132 has sat changes requested at `abcd1234`.*answer the review, then push\./s, "and it says what to answer");
  const events = logOf(store.get(), "A11-203");
  assert.deepEqual(events.filter((event) => event.kind === "round").map((event) => event.kind === "round" && event.cause), ["feedback"]);
  assert.deepEqual(events.filter((event) => event.kind === "needs-you"), [], "no Needs-you was raised");
  assert.notEqual(runStatus(entry()), "needs-you");
  await roundStarted();
});

test("A11-352: the round is not asked for again while it is queued, and a parked run is not started a round", async () => {
  const { clock, pool, entry } = blockedPool(REVIEWED);
  await pool.watchFeedback();
  clock.now = NOW + 31 * MINUTE;
  await pool.watchFeedback();
  await pool.watchFeedback();
  assert.equal(entry().rounds, 1, "a second watch finds the run queued and adds no round");
  await roundStarted();
  const parked = blockedPool(REVIEWED);
  await parked.pool.watchFeedback();
  parked.store.set({ ...parked.store.get(), entries: parked.store.get().entries.map((each) => ({ ...each, workspace: "w1" })) } as Queue);
  parked.clock.now = NOW + 31 * MINUTE;
  await parked.pool.watchFeedback();
  assert.deepEqual([parked.entry().phase, parked.entry().handedBack], ["finished", undefined], "a parked run is a person's already, and is neither started nor flagged");
});

test("A11-352: at the cap on the board's rounds the run is handed back saying so, not with the stale-block note", async () => {
  const { clock, pool, entry, store } = blockedPool(REVIEWED);
  store.set({ ...store.get(), entries: store.get().entries.map((each) => ({ ...each, rounds: 3 })) } as Queue);
  await pool.watchFeedback();
  clock.now = NOW + 31 * MINUTE;
  await pool.watchFeedback();
  assert.equal(entry().phase, "finished");
  assert.match(entry().handedBack ?? "", /^The pull requests keep getting feedback: the board answered 3 rounds on its own and stopped\. Respond to review starts another\./);
  assert.equal(isStaleBlockNote(entry().handedBack), false);
  await roundStarted();
});

test("A11-352: the board asks for each head once: a worker that answers without a push is not asked again, and the note then says so", async () => {
  const { clock, host, pool, entry, store } = blockedPool(REVIEWED, true);
  await pool.watchFeedback();
  clock.now = NOW + 31 * MINUTE;
  await pool.watchFeedback();
  assert.deepEqual([entry().phase, entry().rounds, entry().blockAsked], ["queued", 1, { [PR]: BLOCKED.head }]);
  await roundStarted();
  // The round ends with a reply and no push: the run finishes again, the pull request still blocked at the same head.
  store.set(finish(store.get(), "A11-203", REVIEWED, clock.now));
  await pool.watchFeedback();
  clock.now += 31 * MINUTE;
  await pool.watchFeedback();
  assert.deepEqual([entry().phase, entry().rounds], ["finished", 1], "no second round for the head");
  assert.equal(entry().handedBack, "a11ign/control #132 has sat changes requested at `abcd1234` for more than 30 minutes, with no new push and no run: the board already asked the worker to answer it at this head, which has not moved: a person decides");
  // A push is a new head, blocked again: the board asks for that head too, and the note goes.
  host.pullAt(PR)!.head = "feedc0de0000";
  await pool.watchFeedback();
  clock.now += 31 * MINUTE;
  await pool.watchFeedback();
  assert.deepEqual([entry().phase, entry().rounds, entry().handedBack, entry().blockAsked], ["queued", 2, undefined, { [PR]: "feedc0de0000" }]);
  await roundStarted();
});

test("A11-352: a note written before the reason was named goes, leaving the run to its round", async () => {
  const { clock, pool, entry, store } = blockedPool(REVIEWED, true);
  const old = "a11ign/control #132 has sat changes requested at `abcd1234` for more than 30 minutes, with no new push and no run: a person decides";
  await pool.watchFeedback();
  store.set({ ...store.get(), entries: store.get().entries.map((each) => ({ ...each, handedBack: old })) } as Queue);
  assert.equal(staleBlockNote(entry(), NOW + 31 * MINUTE), null, "a reviewed run carrying the old note is the run the board answers, so the old reason is not rewritten into a wrong one");
  clock.now = NOW + 31 * MINUTE;
  await pool.watchFeedback();
  assert.equal(entry().handedBack, undefined, "the old note goes");
  await pool.watchFeedback();
  assert.deepEqual([entry().phase, entry().rounds], ["queued", 1], "and the next watch starts the round");
  await roundStarted();
});

test("A11-213: recordPullHeads keeps the stamp it is given", () => {
  const queue = recordPullHeads(finishedQueue(), "A11-203", { [PR]: { ...BLOCKED, blockedSince: 42 } });
  assert.equal(queue.entries[0].pullHeads?.[PR]?.blockedSince, 42);
});

// --- A11-290: a block that is a stand-off waits for both routes, and says what each came to ---------------------------------------------------------------------------

const STANDOFF = { url: PR, head: BLOCKED.head, reasons: "**Review of #132 at `abcd1234`, by reviewer-1: not convinced**\n\nThe bundle is still 340 KB.", reply: "Plan cannot be met: 200 KB is below the entry point.", stage: "done" };

test("A11-290: a stand-off whose planner round and worker round have both ended is flagged at 30 minutes, and the card says what the reviewer and the worker last said and what the planner decided", () => {
  const note = staleBlockNote(blockedFor(31, { standoff: { ...STANDOFF, planner: { decision: "upheld", reason: "The entry point can be split." } } }), NOW);
  assert.ok(note !== null && isStaleBlockNote(note), "it is still the A11-213 note, so the board clears it as it clears that one");
  assert.ok(note.startsWith(ENDED_NOTE));
  assert.match(note, /The reviewer last said: The bundle is still 340 KB\./);
  assert.match(note, /the worker last said: Plan cannot be met: 200 KB is below the entry point\./);
  assert.match(note, /the planner upheld: The entry point can be split\.$/);
  const unasked = staleBlockNote(blockedFor(31, { standoff: { ...STANDOFF, reply: null } }), NOW);
  assert.match(unasked ?? "", /the worker last said: nothing on the pull request; the planner was not asked$/);
});

test("A11-290: the flag waits while a route is still to go: an open stand-off of a watched run, and a decision the planner took within the limit", () => {
  const open = { ...STANDOFF, stage: "open" };
  assert.equal(staleBlockNote(blockedFor(90, { standoff: open, outcome: { kind: "reviewed", prs: PRS } }), NOW), null, "the next watch routes it");
  assert.notEqual(staleBlockNote(blockedFor(90, { standoff: open, handedBack: "The pull requests keep getting feedback" }), NOW), null, "a run the board does not watch is never routed, so the flag stands");
  const planned = { ...STANDOFF, stage: "planned", planner: { decision: "amended", reason: "The limit is now 400 KB." }, decidedAt: NOW - 10 * MINUTE };
  assert.equal(staleBlockNote(blockedFor(90, { standoff: planned }), NOW), null, "the reviewer re-reviews bound by the amendment");
  assert.notEqual(staleBlockNote(blockedFor(90, { standoff: { ...planned, decidedAt: NOW - 40 * MINUTE } }), NOW), null, "and when it did not within the limit, a person is told");
});

test("A11-290: a stand-off of another head, or of another pull request, does not hold or colour the flag", () => {
  assert.equal(staleBlockNote(blockedFor(31, { standoff: { ...STANDOFF, head: "00000000" } }), NOW), NOTE);
  assert.equal(staleBlockNote(blockedFor(31, { standoff: { ...STANDOFF, url: "https://github.com/a11ign/control/pull/9" } }), NOW), NOTE);
});
