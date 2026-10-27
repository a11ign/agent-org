// no-token: none -- queues built with the board's own transitions
// A11-274: a blocked head is re-reviewed whatever state the run is in, waiting only while its worker is working, and a body change answers the block at once for any run the block gives no worker round
import { test } from "node:test";
import assert from "node:assert/strict";
import { finishedWith, ticketOf } from "../kept-pulls-fixture.ts";
import { emptyQueue } from "../queue.ts";
import { enqueue, find, replace, type Entry, type Queue } from "./queue-entries-and-outcomes.ts";
import { bodyAnswersBlock, countRereview, handBackRereview, mayRereview } from "./queue-rereview.ts";
import { markRunning, markStarting, MAX_FEEDBACK_ROUNDS } from "./queue-transitions.ts";

const KEY = "A11-253";
const URL = "https://github.com/a11ign/a11ign.github.io/pull/3";
const PRS = [{ repo: "a11ign.github.io", url: URL }];
/** When the run ended, when its agent went idle, when the block was posted, and the sweeps after it. */
const ENDED = 1_000;
const IDLE = 1_500;
const BLOCK = { at: 2_000 };
const NOW = 3_000;
const LATER = 4_000;
const SLOTS = 3;
const LINES = [{ kind: "added", text: "Closes A11-253" }] as const;

/** `KEY` queued, starting, or running with `more` set on it. */
function live(phase: "queued" | "starting" | "running", more: Partial<Entry> = {}): Entry {
  const queued = enqueue(emptyQueue(SLOTS), [ticketOf(KEY)], { model: "sonnet", effort: "high" }, 0);
  const moved = phase === "queued" ? queued : phase === "starting" ? markStarting(queued, KEY, 1) : markRunning(markStarting(queued, KEY, 1), KEY, "w1", "w1:p1");
  return { ...find(moved, KEY)!, review: PRS, ...more };
}

/** `KEY` finished on `outcome` at `at`, holding `PRS` as the round it answered, with `more` set on it. */
function finished(outcome: Parameters<typeof finishedWith>[1], at: number, more: Partial<Entry> = {}): Queue {
  return replace(finishedWith(KEY, outcome, at), KEY, (entry) => ({ ...entry, review: PRS, ...more }));
}

const entryOf = (queue: Queue): Entry => find(queue, KEY)!;
const queueOf = (entry: Entry): Queue => ({ ...emptyQueue(SLOTS), entries: [entry] });

test("A11-274: a re-review waits only for a worker that is working: a finished run in any outcome, and a running one on a dialog or idle on a working note, are admitted", () => {
  assert.equal(mayRereview(entryOf(finished({ kind: "no-outcome" }, ENDED))), true, "stopped without an outcome");
  assert.equal(mayRereview(entryOf(finished({ kind: "needs-human", reason: "which word?" }, ENDED))), true, "parked on a question");
  assert.equal(mayRereview(entryOf(finished({ kind: "ready-pr", prs: PRS }, ENDED))), true, "finished on its pull request, as A11-235 had it");
  assert.equal(mayRereview(entryOf(finished({ kind: "crashed", reason: "gone" }, ENDED))), true);
  assert.equal(mayRereview(live("running", { waiting: true })), true, "waiting in its terminal");
  assert.equal(mayRereview(live("running", { working: { reason: "step 2", at: ENDED, idleSince: IDLE } })), true, "idle on a working note");
  assert.equal(mayRereview(live("running", { working: { reason: "step 2", at: ENDED, idleSince: IDLE, stalled: true } })), true, "stalled on it");
});

test("A11-274: a queued or starting run, and a running one last seen working, wait for a sweep that finds the worker stopped", () => {
  assert.equal(mayRereview(live("queued")), false);
  assert.equal(mayRereview(live("starting")), false);
  assert.equal(mayRereview(live("running")), false, "no note and no dialog: its agent is at work");
  assert.equal(mayRereview(live("running", { waiting: false, working: { reason: "step 2", at: ENDED } })), false, "a note whose idle clock a working status cleared");
});

test("A11-274: a run handed back with no round left is not re-reviewed, and one handed back that a person gave rounds again is", () => {
  const handed = entryOf(finished({ kind: "no-outcome" }, ENDED, { handedBack: "keeps getting feedback", rounds: MAX_FEEDBACK_ROUNDS }));
  assert.equal(mayRereview(handed), false);
  assert.equal(mayRereview({ ...handed, rounds: 0 }), true);
});

test("A11-343 kept: a run the planner set waiting on another ticket is not re-reviewed, whatever its state", () => {
  const waitingOn = { key: "A11-1", reason: "its pull request lands first", since: ENDED };
  assert.equal(mayRereview(entryOf(finished({ kind: "no-outcome" }, ENDED, { waitingOnTicket: waitingOn }))), false);
  assert.equal(mayRereview(live("running", { waiting: true, waitingOnTicket: waitingOn })), false);
});

test("A11-274: a running run with no round left waits for its end, where it is handed back, rather than being handed back while it runs", () => {
  assert.equal(mayRereview(live("running", { waiting: true, rounds: MAX_FEEDBACK_ROUNDS })), false);
  assert.equal(mayRereview(live("running", { waiting: true, rounds: MAX_FEEDBACK_ROUNDS - 1 })), true);
});

test("A11-274: for a run the block gives no worker round, every body change since the look answers it, whatever its finishedAt; a watched run keeps A11-235's rule", () => {
  const parked = entryOf(finished({ kind: "no-outcome" }, ENDED, { workspace: "w1" }));
  assert.deepEqual(bodyAnswersBlock(parked, BLOCK, LINES), LINES, "it ended before the block, and no round is coming");
  assert.deepEqual(bodyAnswersBlock(live("running", { waiting: true }), BLOCK, LINES), LINES);
  assert.deepEqual(bodyAnswersBlock(undefined, BLOCK, LINES), LINES, "no run holds the pull request");
  const watched = entryOf(finished({ kind: "ready-pr", prs: PRS }, ENDED));
  assert.deepEqual(bodyAnswersBlock(watched, BLOCK, LINES), [], "its round for the block has not ended yet");
  assert.deepEqual(bodyAnswersBlock({ ...watched, finishedAt: NOW }, BLOCK, LINES), LINES, "and once it has, the edit answers it");
});

test("A11-274: a running round queued since the block is the round that answers it, so A11-235's rule holds through it; a round queued before the block does not answer it", () => {
  assert.deepEqual(bodyAnswersBlock(live("running", { waiting: true, queuedAt: NOW }), BLOCK, LINES), [], "the block's own round is still under way");
  assert.deepEqual(bodyAnswersBlock(live("running", { waiting: true, queuedAt: ENDED }), BLOCK, LINES), LINES, "a round that began before the block");
  assert.deepEqual(bodyAnswersBlock(live("running", { waiting: true, queuedAt: NOW, review: undefined }), BLOCK, LINES), LINES, "a first run holds no round");
});

test("A11-274: a re-review counts one round on any run it admits, and none on a run whose worker is working", () => {
  const stopped = countRereview(finished({ kind: "no-outcome" }, ENDED, { rounds: 1 }), KEY, NOW, "the block was answered by editing the description");
  assert.equal(entryOf(stopped).rounds, 2);
  assert.equal(entryOf(countRereview(queueOf(live("running", { waiting: true })), KEY, NOW)).rounds, 1, "waiting in its terminal");
  const working = queueOf(live("running"));
  assert.equal(countRereview(working, KEY, NOW), working, "left alone");
});

test("A11-274: a finished run with no round left is handed back once, whatever outcome it stopped on, and a running one is not, since its end would drop the hand-back", () => {
  const capped = finished({ kind: "no-outcome" }, ENDED, { rounds: MAX_FEEDBACK_ROUNDS });
  const handed = handBackRereview(capped, KEY, "the block was answered by editing the description", NOW);
  assert.match(entryOf(handed).handedBack ?? "", /^The pull requests keep getting feedback: the board answered 3 rounds on its own and stopped\./);
  assert.equal(handBackRereview(handed, KEY, "again", LATER), handed, "once");
  const waiting = queueOf(live("running", { waiting: true, rounds: MAX_FEEDBACK_ROUNDS }));
  assert.equal(handBackRereview(waiting, KEY, "answered", NOW), waiting);
});
