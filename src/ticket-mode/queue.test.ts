// no-token: gh -- pure transitions, and one file in a temporary directory
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { writeFileSync } from "node:fs";
import { isParked, runActions, runStatus, waitNote } from "./board-view/pull-status-and-notes.ts";
import { recordBlockerDeclared, replan } from "./queue/queue-ticket-text.ts";
import { amend, byIdentifier, childOrder, refuseParents, dismiss, enqueue, isLive, leaveBatch, liveRunCount, BACKGROUND_GONE, BACKGROUND_GONE_MS, clearEdit, clearMove, recordMove, PLAN_BATCH_MAX, remove, retry, talkRound, type Outcome, type Queue, writerStatus } from "./queue/queue-entries-and-outcomes.ts";
import { approve, checkRound, conflictRound, holdForSession, recordCheckHeads, respond, batchPlanDone, recordPathsFailure, startAnyway, feedbackRound, MAX_FEEDBACK_ROUNDS, markPublishRunning, markPublishStarting, publishDone, publishFailed, publishStarts, queuePublish, finish, markResumed, markRunning, markStarting, observe, park, noteWorking, recordBlockers, recordRepos, planDone, watchWorking, recordPullStates, recordTrackerStates, setMax, pauseQueue, resumeQueue, unpark, unreadBlockerKeys, unsettledKeys, pathsUnread, recordPaths, recordPullFiles, recordRetargets, recordVerdictNotPosted, unreadPaths, completableRuns } from "./queue/queue-transitions.ts";
import { clearPartial, nextStepRuns, planStepsUnread, queueNextStep, recordPlanSteps } from "./queue/queue-next-step.ts";
import { afterMergeDue, afterMergeUnposted, markAfterMergePosted, markAfterMergeUnposted, recordAfterMerge } from "./queue/queue-after-merge.ts";
import { talk } from "./queue/talk.ts";
import { requeueForUpdate } from "./queue/queue-pins.ts";
import { declinedPrompt, toldDeclined } from "./queue/queue-declined.ts";
import { emptyQueue, loadQueue, nextStarts, saveQueue, dismissFinishedWriters, dismissWriter, LEGACY_CREATING_FAILURE, LEGACY_REVIEW_FAILURE, markWriterRunning, markWriterStarting, queueWriter, stopWriter, writerEnded, writerFailed, writerOf, writerResumed, writerToStart, writerWaiting } from "./queue.ts";
import { moveOutcomeHeads, recordOutcomeBlocks, recordOutcomeHeads, recordPullHeads } from "./queue/queue-pull-heads.ts";
import type { Blocker, Ticket } from "./source.ts";

const ticket = (key: string) => ({ key, title: key, description: "", url: "", branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
const choice = { model: "opus", effort: "high" };
const keys = (queue: Queue) => queue.entries.map((e) => e.ticket.key);
/** Ticket A queued on a two-slot queue, not started. */
const queuedA = () => enqueue(emptyQueue(2), [ticket("A")], choice, 1);
/** Ticket A started on a one-slot queue, running on worker w1 in pane w1:p1. */
const runningA = () => markRunning(markStarting(enqueue(emptyQueue(1), [ticket("A")], choice, 0), "A", 1), "A", "w1", "w1:p1");
/** Ticket A running on w1, with a working note, "the roll is still running", kept at 50 and set at 1000. */
const workingA = () => noteWorking(runningA(), "A", "the roll is still running", 50, 1000);

test("enqueue adds what you selected, in order, once each, with no repository until the worker chooses", () => {
  let queue = enqueue(emptyQueue(3), [ticket("A"), ticket("B")], choice, 1);
  queue = enqueue(queue, [ticket("B"), ticket("C")], { ...choice, model: "sonnet" }, 2);
  assert.deepEqual(keys(queue), ["A", "B", "C"]);
  assert.equal(queue.entries[1].model, "opus", "B kept the choice it was first queued with");
  assert.deepEqual(queue.entries.map((e) => e.repos), [[], [], []]);
});

const planChoice = { model: "opus", effort: "max" };

test("a ticket queued to be planned first carries the planning model and effort, and the others do not", () => {
  const queue = enqueue(emptyQueue(3), [ticket("A"), ticket("B")], { model: "sonnet", effort: "high" }, 1, { keys: new Set(["A"]), choice: planChoice });
  assert.deepEqual(queue.entries[0].plan, planChoice);
  assert.deepEqual([queue.entries[0].model, queue.entries[0].effort], ["sonnet", "high"], "it is worked on the run's own choice once planned");
  assert.equal(queue.entries[1].plan, undefined);
});

test("once its plan is attached, a planned ticket is queued again where it was, to be worked, with nothing left of its planning run", () => {
  let queue = enqueue(emptyQueue(3), [ticket("A"), ticket("B")], choice, 1, { keys: new Set(["A"]), choice: planChoice });
  queue = markRunning(markStarting(queue, "A", 2), "A", "w1", "w1:p1");
  queue = planDone(observe(queue, "A", "working"), "A");
  const [a] = queue.entries;
  assert.deepEqual(keys(queue), ["A", "B"]);
  assert.deepEqual({ phase: a.phase, plan: a.plan, planned: a.planned, workspace: a.workspace, pane: a.pane, startedAt: a.startedAt, seenWorking: a.seenWorking, queuedAt: a.queuedAt },
    { phase: "queued", plan: undefined, planned: true, workspace: undefined, pane: undefined, startedAt: undefined, seenWorking: undefined, queuedAt: 1 });
  assert.deepEqual(nextStarts(resumeQueue(queue), 0, 4).map((e) => e.ticket.key), ["A", "B"], "it starts in its old place");
});

test("a retried planning run plans again, and a retried planned run keeps its mark", () => {
  let queue = enqueue(emptyQueue(3), [ticket("A")], choice, 1, { keys: new Set(["A"]), choice: planChoice });
  queue = retry(finish(markStarting(queue, "A", 2), "A", { kind: "crashed", reason: "herdr refused" }, 3), "A", 4);
  assert.deepEqual(queue.entries[0].plan, planChoice);
  queue = planDone(queue, "A");
  queue = retry(finish(markStarting(queue, "A", 5), "A", { kind: "crashed", reason: "herdr refused" }, 6), "A", 7);
  assert.deepEqual([queue.entries[0].plan, queue.entries[0].planned], [undefined, true]);
});

const batched = { choice: planChoice, batch: true };

test("the tickets one press of Queue plans first are one batch, of 8 at most in queue order, and a run of one is no batch", () => {
  const tickets = Array.from({ length: 10 }, (_, i) => ticket(`T${i + 1}`));
  let queue = enqueue(emptyQueue(3), [ticket("OLD")], choice, 1, { keys: new Set(["OLD"]), ...batched });
  queue = enqueue(queue, [ticket("OLD"), ...tickets, ticket("WORK")], choice, 2, { keys: new Set(["OLD", ...tickets.map((t) => t.key)]), ...batched });
  const batchOf = (key: string) => queue.entries.find((e) => e.ticket.key === key)!.batch;
  assert.equal(PLAN_BATCH_MAX, 8);
  assert.deepEqual(tickets.slice(0, 8).map((t) => batchOf(t.key)), Array(8).fill("b2-0"), "the first 8, in queue order");
  assert.deepEqual(tickets.slice(8).map((t) => batchOf(t.key)), ["b2-1", "b2-1"], "the rest are the next run");
  assert.equal(batchOf("OLD"), undefined, "a ticket queued at another time, alone, is never batched with them");
  assert.equal(batchOf("WORK"), undefined, "a ticket not planned first is in no batch");
  const nine = enqueue(emptyQueue(3), tickets.slice(0, 9), choice, 3, { keys: new Set(tickets.map((t) => t.key)), ...batched });
  assert.equal(nine.entries[8].batch, undefined, "the ninth of nine is planned alone");
  const alone = enqueue(emptyQueue(3), tickets.slice(0, 2), choice, 4, { keys: new Set(["T1", "T2"]), choice: planChoice });
  assert.deepEqual(alone.entries.map((e) => e.batch), [undefined, undefined], "a planner that does not batch plans each alone");
});

test("a batch is one run: its tickets take one slot between them, starting or running, and a full queue starts none of a new batch", () => {
  const plan = { keys: new Set(["A", "B", "C"]), ...batched };
  let queue = resumeQueue(enqueue(emptyQueue(1), [ticket("A"), ticket("B"), ticket("C"), ticket("D")], choice, 1, plan));
  assert.deepEqual(nextStarts(queue, 0, 14).map((e) => e.ticket.key), ["A", "B", "C"], "one slot holds the whole batch, and D waits");
  queue = setMax(markStarting(markStarting(queue, "A", 2), "B", 2), 3);
  assert.deepEqual(nextStarts(queue, 0, 14).map((e) => e.ticket.key), ["C", "D"], "two tickets of a starting batch take one slot of three, and C, left behind, takes one of its own");
  queue = ["A", "B"].reduce((q, key) => markRunning(q, key, "w1", "w1:p1"), queue);
  assert.deepEqual(nextStarts(setMax(queue, 1), 0, 14), [], "a running batch fills the only slot");
});

test("A11-77: a batch's planned ticket keeps the blockers its planner said to wait on to merge, nextStarts holds it until they merge, and a retry drops them", () => {
  const plan = { keys: new Set(["A", "B", "C"]), ...batched };
  const pull = "https://github.com/acme/nbl-ui-netbox/pull/12";
  const open: Blocker = { key: "A", state: "started", status: "In Review", branch: "a", pulls: { [pull]: "open" } };
  const merged: Blocker = { ...open, pulls: { [pull]: "merged" } };
  const at = (q: Queue, key: string) => q.entries.find((e) => e.ticket.key === key)!;
  let queue = enqueue({ ...emptyQueue(3), paused: false }, [ticket("A"), ticket("B"), ticket("C")], choice, 1, plan);
  queue = batchPlanDone(queue, "B", "nbl-ui-netbox", ["A"]);
  queue = batchPlanDone(queue, "C", "nbl-ui-netbox");
  assert.deepEqual([at(queue, "B").waitMerged, at(queue, "C").waitMerged], [["A"], undefined], "set only when the planner named one to wait on");
  assert.equal(at(queue, "B").plannedRepo, "nbl-ui-netbox");
  queue = recordBlockers(queue, new Map([["B", [open]]]));
  assert.deepEqual(nextStarts(queue, 0, 14).map((e) => e.ticket.key), ["A", "C"], "B holds no slot while its blocker's pull request is open, though both are in one repository");
  queue = recordBlockers(queue, new Map([["B", [merged]]]));
  assert.deepEqual(nextStarts(queue, 0, 14).map((e) => e.ticket.key), ["A", "C"], "its merged pull request is not read yet (A11-206)");
  queue = recordBlockerDeclared(queue, "B", pull, { kind: "none" });
  assert.deepEqual(nextStarts(queue, 0, 14).map((e) => e.ticket.key), ["A", "C"], "A is still queued, so its merged pull request does not let B go (A11-206)");
  queue = finish(queue, "A", { kind: "ready-pr", prs: [] }, 2);
  assert.deepEqual(nextStarts(queue, 0, 14).map((e) => e.ticket.key), ["B", "C"], "once A's run has ended, its pull request has merged and been read, B starts");
  const retried = retry(finish(queue, "B", { kind: "crashed", reason: "gone" }, 3), "B", 4);
  assert.deepEqual([at(retried, "B").plannedRepo, at(retried, "B").waitMerged], [undefined, undefined], "a retried run has no planned repository, so it has no mark either");
});

test("a ticket of a batch leaves it when it starts alone, when its plan is attached, and when it is retried", () => {
  const plan = { keys: new Set(["A", "B"]), ...batched };
  let queue = enqueue(emptyQueue(3), [ticket("A"), ticket("B")], choice, 1, plan);
  assert.deepEqual([leaveBatch(queue, "A").entries[0].batch, leaveBatch(queue, "A").entries[1].batch], [undefined, "b1-0"]);
  queue = recordBlockers(queue, new Map([["A", []], ["B", []]]));
  queue = ["A", "B"].reduce((q, key) => markRunning(markStarting(q, key, 2), key, "w1", "w1:p1"), queue);
  const done = batchPlanDone(queue, "A", "nbl-ui-netbox");
  const [a] = done.entries;
  assert.deepEqual({ phase: a.phase, batch: a.batch, plan: a.plan, planned: a.planned, plannedRepo: a.plannedRepo, blockers: a.blockers },
    { phase: "queued", batch: undefined, plan: undefined, planned: true, plannedRepo: "nbl-ui-netbox", blockers: undefined });
  assert.deepEqual(unreadBlockerKeys(done), ["A"], "its blockers are read again, since its batch's order was just recorded");
  assert.equal(batchPlanDone(queue, "B", null).entries[1].plannedRepo, null, "a ticket the planner named no repository for records none");
  const retried = retry(finish(queue, "B", { kind: "crashed", reason: "gone" }, 3), "B", 4).entries.find((e) => e.ticket.key === "B")!;
  assert.deepEqual([retried.batch, retried.plan], [undefined, planChoice], "a retried ticket of a batch is planned again, alone");
});

test("the repositories a worker made worktrees in are recorded on its entry", () => {
  const queue = recordRepos(enqueue(emptyQueue(1), [ticket("A")], choice, 1), "A", ["nbl-ui-netbox", "nbl-ui-platform-libs"]);
  assert.deepEqual(queue.entries[0].repos, ["nbl-ui-netbox", "nbl-ui-platform-libs"], "a ticket can land in several");
});

test("amend and remove touch a queued entry only", () => {
  let queue = enqueue(emptyQueue(3), [ticket("A"), ticket("B")], choice, 1);
  queue = markStarting(queue, "A", 2);
  queue = amend(amend(queue, "A", { model: "sonnet" }), "B", { model: "sonnet", effort: "max" });
  assert.equal(queue.entries[0].model, "opus", "A started with opus and keeps it");
  assert.deepEqual([queue.entries[1].model, queue.entries[1].effort], ["sonnet", "max"]);
  assert.deepEqual(keys(remove(remove(queue, "A"), "B")), ["A"], "a started entry is not removed");
});

test("a new queue is paused, and nothing starts until it is started; pausing again stops new starts", () => {
  let queue = queuedA();
  assert.equal(queue.paused, true, "queueing is never also starting");
  assert.deepEqual(nextStarts(queue, 0, 14), []);
  queue = resumeQueue(queue);
  assert.deepEqual(nextStarts(queue, 0, 14).map((e) => e.ticket.key), ["A"]);
  assert.deepEqual(nextStarts(pauseQueue(queue), 0, 14), []);
});

test("nextStarts fills free slots in queue order, counts starting and running alike, and starts nothing past the host's cores", () => {
  let queue = resumeQueue(enqueue(emptyQueue(2), [ticket("A"), ticket("B"), ticket("C")], choice, 1));
  assert.deepEqual(nextStarts(queue, 1, 14).map((e) => e.ticket.key), ["A", "B"]);
  queue = markStarting(queue, "A", 2);
  assert.deepEqual(nextStarts(queue, 1, 14).map((e) => e.ticket.key), ["B"]);
  queue = markRunning(markStarting(queue, "B", 3), "B", "w2", "w2:p1");
  assert.deepEqual(nextStarts(queue, 1, 14), [], "both slots are taken");
  queue = setMax(queue, 3);
  assert.deepEqual(nextStarts(queue, 14, 14).map((e) => e.ticket.key), ["C"], "exactly equal to the cores does not refuse");
  assert.deepEqual(nextStarts(queue, 14.01, 14), [], "past them it does");
  assert.throws(() => setMax(queue, 0), /1 or more/);
});

test("nextStarts passes over a run waiting on a blocker, which holds no slot, and starts it once the blocker is done", () => {
  const blockedBy = (state: string) => new Map([["A", [{ key: "LIB-1", state, status: state, pulls: {} }]], ["B", []]]);
  let queue = resumeQueue(enqueue(emptyQueue(1), [ticket("A"), ticket("B")], choice, 1));
  assert.deepEqual(unreadBlockerKeys(queue), ["A", "B"], "nothing read yet");
  queue = recordBlockers(queue, blockedBy("started"));
  assert.deepEqual(unreadBlockerKeys(queue), []);
  assert.deepEqual(nextStarts(queue, 0, 14).map((e) => e.ticket.key), ["B"], "B starts first though it was queued after A");
  queue = recordBlockers(queue, blockedBy("completed"));
  assert.deepEqual(nextStarts(queue, 0, 14).map((e) => e.ticket.key), ["A"]);
  const started = recordBlockers(markStarting(queue, "A", 2), blockedBy("started"));
  assert.deepEqual(started.entries[0].blockers, [{ key: "LIB-1", state: "completed", status: "completed", pulls: {} }], "a run that has started keeps what it started with");
});

test("observe marks working, and a status that is none of the four ordinary ones as waiting on a person", () => {
  let queue = markRunning(markStarting(enqueue(emptyQueue(1), [ticket("A")], choice, 1), "A", 2), "A", "w1", "w1:p1");
  queue = observe(queue, "A", "idle");
  assert.equal(queue.entries[0].seenWorking, false, "idle before the first prompt is taken is not a finished turn");
  queue = observe(observe(queue, "A", "working"), "A", "idle");
  assert.equal(queue.entries[0].seenWorking, true);
  assert.equal(observe(queue, "A", "blocked").entries[0].waiting, true);
  assert.equal(observe(queue, "A", "working").entries[0].waiting, false);
});

test("retry puts a finished entry back at the end, except a draft pull request, which is the result", () => {
  let queue = enqueue(emptyQueue(3), [ticket("A"), ticket("B"), ticket("C")], choice, 1);
  queue = finish(queue, "A", { kind: "crashed", reason: "x" }, 5);
  queue = finish(queue, "B", { kind: "draft-pr", prs: [{ repo: "nbl-ui-netbox", url: "u" }] }, 5);
  queue = retry(retry(queue, "A", 9), "B", 9);
  assert.deepEqual(keys(queue), ["B", "C", "A"]);
  assert.deepEqual([queue.entries[2].phase, queue.entries[2].outcome, queue.entries[2].queuedAt], ["queued", undefined, 9]);
  assert.equal(queue.entries[0].phase, "finished");
});

test("the queue file round-trips, and a missing one is an empty queue", () => {
  const path = join(tmpDir("ticket-queue-"), "tickets", "queue.json");
  assert.deepEqual(loadQueue(path, 4), emptyQueue(4));
  const queue = queuedA();
  saveQueue(path, queue);
  assert.deepEqual(loadQueue(path, 9), queue, "the saved max wins over the default");
  saveQueue(path, resumeQueue(queue));
  assert.equal(loadQueue(path, 9).paused, false, "a started queue stays started across a restart of the board");
});

test("finished runs are read from the tracker until it settles their ticket, and a live run never is", () => {
  let queue: Queue = enqueue(emptyQueue(3), [ticket("NBF-1"), ticket("NBF-2"), ticket("NBF-3")], { model: "opus", effort: "high" }, 0);
  queue = finish(queue, "NBF-1", { kind: "draft-pr", prs: [] }, 5);
  queue = finish(queue, "NBF-2", { kind: "needs-human", reason: "r" }, 5);
  assert.deepEqual(unsettledKeys(queue), ["NBF-1", "NBF-2"], "NBF-3 is still queued");
  queue = recordTrackerStates(queue, new Map([["NBF-1", "completed"], ["NBF-2", "started"], ["NBF-3", "completed"]]));
  assert.equal(queue.entries.find((e) => e.ticket.key === "NBF-1")!.trackerState, "completed");
  assert.equal(queue.entries.find((e) => e.ticket.key === "NBF-3")!.trackerState, undefined, "a queued run takes no tracker state");
  assert.deepEqual(unsettledKeys(queue), ["NBF-2"], "a completed ticket is not asked about again");
});

test("a finished run records its pull requests' states, and one they settle is not asked about again", () => {
  const url = "https://github.com/netboxlabs/nbl-ui-platform-libs/pull/775";
  let queue: Queue = enqueue(emptyQueue(3), [ticket("NBF-1"), ticket("NBF-2")], { model: "opus", effort: "high" }, 0);
  queue = finish(queue, "NBF-1", { kind: "draft-pr", prs: [{ repo: "nbl-ui-platform-libs", url }] }, 5);
  queue = recordPullStates(queue, new Map([["NBF-1", { [url]: "open" as const }], ["NBF-2", { [url]: "merged" as const }]]));
  assert.equal(queue.entries.find((e) => e.ticket.key === "NBF-2")!.pullStates, undefined, "a queued run takes no pull request states");
  assert.deepEqual(unsettledKeys(queue), ["NBF-1"], "an open pull request is asked about again");
  queue = recordPullStates(queue, new Map([["NBF-1", { [url]: "merged" as const }]]));
  assert.deepEqual(queue.entries.find((e) => e.ticket.key === "NBF-1")!.pullStates, { [url]: "merged" });
  assert.deepEqual(unsettledKeys(queue), [], "a merged one is not");
});

test("a parked run keeps its workspace and pane, holds no slot, and is not retried until its workspace is closed", () => {
  let queue = resumeQueue(enqueue(emptyQueue(1), [ticket("A"), ticket("B")], choice, 1));
  queue = markRunning(markStarting(queue, "A", 2), "A", "w1", "w1:p1");
  queue = park(queue, "A", { kind: "needs-human", reason: "which colour?" }, 5);
  const a = () => queue.entries.find((e) => e.ticket.key === "A")!;
  assert.deepEqual([a().phase, a().workspace, a().pane, isParked(a()), isLive(a())], ["finished", "w1", "w1:p1", true, false]);
  assert.deepEqual(nextStarts(queue, 0, 14).map((e) => e.ticket.key), ["B"], "a parked run holds no slot");
  assert.equal(retry(queue, "A", 9), queue, "a second workspace would take the same herdr name");
  queue = unpark(queue, "A");
  assert.deepEqual([a().workspace, a().pane, a().outcome?.kind, isParked(a())], [undefined, undefined, "needs-human", false], "closing keeps the outcome");
  assert.deepEqual(keys(retry(queue, "A", 9)), ["B", "A"]);
});

test("finish drops the workspace and pane, and markResumed makes a parked run live again without its old outcome or tracker state", () => {
  const running = markRunning(markStarting(enqueue(emptyQueue(1), [ticket("A")], choice, 1), "A", 2), "A", "w1", "w1:p1");
  const finished = finish(running, "A", { kind: "stopped" }, 5);
  assert.deepEqual([finished.entries[0].workspace, finished.entries[0].pane], [undefined, undefined]);
  assert.equal(markResumed(finished, "A").entries[0].phase, "finished", "a run with no workspace has nothing to resume in");
  const parked = recordPullStates(recordTrackerStates(park(running, "A", { kind: "no-outcome" }, 5), new Map([["A", "started"]])), new Map([["A", { u: "open" as const }]]));
  const [a] = markResumed(parked, "A").entries;
  assert.deepEqual([a.phase, a.outcome, a.finishedAt, a.trackerState, a.pullStates, a.workspace, a.pane, a.seenWorking],
    ["running", undefined, undefined, undefined, undefined, "w1", "w1:p1", true]);
  assert.equal(unpark(running, "A").entries[0].workspace, "w1", "unpark leaves a live run's workspace alone");
});

const pr = { repo: "app", url: "https://github.com/x/app/pull/1" };

test("A11-153: the board completes the ticket of a merged run whatever kind its outcome was, except one declared partial or already closed by the board", () => {
  const merged = (fields: Record<string, unknown>) => ({ review: [pr], pullStates: { [pr.url]: "merged" as const }, trackerState: "started", ...fields });
  const withOutcome = (outcome: Parameters<typeof finish>[2], fields: Record<string, unknown> = {}) => {
    const queue = markRunning(markStarting(enqueue(emptyQueue(3), [ticket("A")], choice, 1), "A", 2), "A", "w1", "w1:p1");
    const ended = finish(queue, "A", outcome, 3);
    return { ...ended, entries: ended.entries.map((e) => ({ ...e, ...merged(fields) })) };
  };
  for (const outcome of [{ kind: "needs-human" as const, reason: "q" }, { kind: "crashed" as const, reason: "x" }, { kind: "stopped" as const }]) {
    assert.deepEqual(completableRuns(withOutcome(outcome)).map((e) => e.ticket.key), ["A"], `${outcome.kind}: its merged pull request completes the ticket`);
  }
  assert.deepEqual(completableRuns(withOutcome({ kind: "needs-human", reason: "q" }, { partial: "the settings page" })), [], "a partial run's ticket is left open");
  assert.deepEqual(completableRuns(withOutcome({ kind: "needs-human", reason: "q" }, { closedByBoard: true })), [], "once closed by the board it is not closed again");
  assert.deepEqual(completableRuns(withOutcome({ kind: "needs-human", reason: "q" }, { pullStates: { [pr.url]: "open" } })), [], "an open pull request completes nothing");
  assert.deepEqual(completableRuns(withOutcome({ kind: "needs-human", reason: "q" }, { trackerState: "completed" })), [], "a ticket the tracker finished is left alone");
  assert.deepEqual(unsettledKeys(withOutcome({ kind: "needs-human", reason: "q" })), [], "a merged needs-human run is settled, so the tracker is not asked about it again");
});

test("A11-153: a run's outcome heads are kept on top of each other, its current heads replace each other, and agent-org's own push moves only the heads it pushed over", () => {
  const second = { repo: "app", url: "https://github.com/x/app/pull/2" };
  const queue = endedWith({ kind: "needs-human", reason: "q" }, { review: [pr, second] });
  const recorded = recordOutcomeHeads(recordOutcomeHeads(queue, "A", { [pr.url]: "h1" }), "A", { [second.url]: "k1" });
  assert.deepEqual(recorded.entries[0].outcomeHeads, { [pr.url]: "h1", [second.url]: "k1" });
  const read = recordPullHeads(recordPullHeads(recorded, "A", { [pr.url]: { head: "h1", approved: false } }), "A", { [pr.url]: { head: "h2", approved: true } });
  assert.deepEqual(read.entries[0].pullHeads, { [pr.url]: { head: "h2", approved: true } });
  assert.deepEqual(moveOutcomeHeads(recorded, "A", "h1", "h3").entries[0].outcomeHeads, { [pr.url]: "h3", [second.url]: "k1" });
  assert.deepEqual(moveOutcomeHeads(queue, "A", "h1", "h3"), queue, "a run with none recorded is left as it is");
  const running = markRunning(markStarting(enqueue(emptyQueue(1), [ticket("B")], choice, 1), "B", 2), "B", "w1", "w1:p1");
  assert.deepEqual(recordOutcomeHeads(running, "B", { [pr.url]: "h1" }), running, "only a finished run records them");
});

test("A11-153: markResumed and a new end drop a run's heads, since the round that follows records its own", () => {
  const running = markRunning(markStarting(enqueue(emptyQueue(1), [ticket("A")], choice, 1), "A", 2), "A", "w1", "w1:p1");
  const parked = park(running, "A", { kind: "needs-human", reason: "q" }, 5);
  const withHeads = recordPullHeads(recordOutcomeHeads(parked, "A", { [pr.url]: "h1" }), "A", { [pr.url]: { head: "h2", approved: false } });
  assert.deepEqual([withHeads.entries[0].outcomeHeads, withHeads.entries[0].pullHeads !== undefined], [{ [pr.url]: "h1" }, true]);
  const [resumed] = markResumed(withHeads, "A").entries;
  assert.deepEqual([resumed.outcomeHeads, resumed.pullHeads], [undefined, undefined]);
  const [ended] = finish(withHeads, "A", { kind: "needs-human", reason: "again" }, 9).entries;
  assert.deepEqual([ended.outcomeHeads, ended.pullHeads], [undefined, undefined]);
});

test("A11-258: the pull requests a needs-human run ended with changes requested are recorded for a finished run only, none records nothing, and a resume or a new end drops them", () => {
  const queue = endedWith({ kind: "needs-human", reason: "q" });
  assert.deepEqual(recordOutcomeBlocks(queue, "A", { [pr.url]: "h1" }).entries[0].outcomeBlocks, { [pr.url]: "h1" });
  assert.deepEqual(recordOutcomeBlocks(queue, "A", {}), queue, "a run that stopped on something else carries no record");
  const running = markRunning(markStarting(enqueue(emptyQueue(1), [ticket("B")], choice, 1), "B", 2), "B", "w1", "w1:p1");
  assert.deepEqual(recordOutcomeBlocks(running, "B", { [pr.url]: "h1" }), running, "only a finished run records them");
  const blocked = recordOutcomeBlocks(park(markRunning(markStarting(enqueue(emptyQueue(1), [ticket("A")], choice, 1), "A", 2), "A", "w1", "w1:p1"), "A", { kind: "needs-human", reason: "q" }, 5), "A", { [pr.url]: "h1" });
  assert.deepEqual(markResumed(blocked, "A").entries[0].outcomeBlocks, undefined, "a resumed run records its own at its next end");
  assert.deepEqual(finish(blocked, "A", { kind: "needs-human", reason: "again" }, 9).entries[0].outcomeBlocks, undefined, "and so does a new end");
});

/** A queue whose one run, A, ended with `outcome` after a worker in session `s1`. */
function endedWith(outcome: Parameters<typeof finish>[2], fields: Record<string, unknown> = {}): Queue {
  const queue = markRunning(markStarting(enqueue(emptyQueue(3), [ticket("A"), ticket("B")], choice, 1), "A", 2), "A", "w1", "w1:p1");
  const ended = finish(queue, "A", outcome, 3, { tokens: { input: 1, output: 2 }, session: "s1" });
  return { ...ended, entries: ended.entries.map((e) => (e.ticket.key === "A" ? { ...e, ...fields } : e)) };
}

test("a run that ends records the Claude session its worker used, so a review run can resume it", () => {
  const [a] = endedWith({ kind: "draft-pr", prs: [pr] }).entries;
  assert.equal(a.session, "s1");
  assert.deepEqual(a.tokens, { input: 1, output: 2 });
});

test("approve queues a run's open pull requests again, at the end, as a review run that keeps the worker's session and nothing of the run", () => {
  const queue = approve(endedWith({ kind: "draft-pr", prs: [pr] }, { pullStates: { [pr.url]: "open" } }), "A", 9);
  const a = queue.entries.find((e) => e.ticket.key === "A");
  assert.deepEqual(keys(queue), ["B", "A"]);
  assert.deepEqual(a, { ticket: ticket("A"), repos: [], model: "opus", effort: "high", session: "s1", review: [pr], phase: "queued", queuedAt: 9, ciSince: 2 });
  const ready = endedWith({ kind: "reviewed", prs: [pr] });
  assert.deepEqual(approve(ready, "A", 9), ready, "pull requests ready already are not approved again: Respond to review is theirs");
});

test("approve reviews only the pull requests still open, and leaves a run with none open alone", () => {
  const merged = { repo: "lib", url: "https://github.com/x/lib/pull/2" };
  const queue = endedWith({ kind: "draft-pr", prs: [pr, merged] }, { pullStates: { [pr.url]: "open", [merged.url]: "merged" } });
  assert.deepEqual(approve(queue, "A", 9).entries.find((e) => e.ticket.key === "A")?.review, [pr]);
  const none = endedWith({ kind: "draft-pr", prs: [] });
  assert.deepEqual(approve(none, "A", 9), none, "a draft outcome naming no pull request has nothing to review");
});

test("a retried run that is not a review run starts a fresh worker, and an ended run never keeps an earlier worker's session", () => {
  const handed = endedWith({ kind: "needs-human", reason: "?" });
  const retried = retry(handed, "A", 4);
  assert.equal(retried.entries.find((e) => e.ticket.key === "A")?.session, undefined);
  const rerun = finish(markRunning(markStarting(handed, "A", 5), "A", "w2", "w2:p1"), "A", { kind: "draft-pr", prs: [pr] }, 6);
  assert.equal(rerun.entries.find((e) => e.ticket.key === "A")?.session, undefined, "herdr never named run 2's session, and run 1's is not its");
});

test("approve leaves alone a run that is not an open result: live, handed back, parked, or settled", () => {
  const draft = endedWith({ kind: "draft-pr", prs: [pr] });
  const live = markRunning(markStarting(enqueue(emptyQueue(3), [ticket("A")], choice, 1), "A", 2), "A", "w1", "w1:p1");
  const parked = park(live, "A", { kind: "needs-human", reason: "?" }, 3);
  for (const [why, queue] of [
    ["live", live], ["handed back", endedWith({ kind: "needs-human", reason: "?" })], ["parked", parked],
    ["merged", { ...draft, entries: draft.entries.map((e) => ({ ...e, pullStates: { [pr.url]: "merged" as const } })) }],
    ["completed in the tracker", recordTrackerStates(draft, new Map([["A", "completed"]]))],
  ] as const) assert.deepEqual(approve(queue, "A", 9), queue, why);
});

test("a review run that failed is retried as a review run, and a reviewed one is a result, not retried", () => {
  const review = approve(endedWith({ kind: "draft-pr", prs: [pr] }), "A", 9);
  const crashed = finish(markRunning(markStarting(review, "A", 10), "A", "w2", "w2:p1"), "A", { kind: "crashed", reason: "x" }, 11);
  const retried = retry(crashed, "A", 12).entries.find((e) => e.ticket.key === "A");
  assert.deepEqual([retried?.phase, retried?.review, retried?.session], ["queued", [pr], "s1"]);
  const reviewed = endedWith({ kind: "reviewed", prs: [pr] });
  assert.deepEqual(retry(reviewed, "A", 12), reviewed);
});

test("a move the board made is recorded on its run once, the first one kept, and a retry carries it over", () => {
  const started = markRunning(markStarting(enqueue(emptyQueue(3), [ticket("A")], choice, 1), "A", 2), "A", "w1", "w1:p1");
  const moved = { from: "Todo", to: "In Progress" };
  const recorded = recordMove(started, "A", moved);
  assert.deepEqual(recorded.entries[0].movedFrom, moved);
  assert.deepEqual(recordMove(recorded, "A", { from: "Done", to: "In Progress" }).entries[0].movedFrom, moved, "a second move does not replace the record");
  assert.deepEqual(recordMove(started, "B", moved), started, "a run that is not on the queue records nothing");
  const crashed = finish(recorded, "A", { kind: "crashed", reason: "x" }, 4);
  assert.deepEqual(retry(crashed, "A", 5).entries[0].movedFrom, moved, "a retried run finds its ticket started, so the record is all there is");
});

test("A11-91: clearing a proposed edit drops it and leaves the outcome as the worker wrote it; a run with no proposal is left as it is", () => {
  const edit = { title: "Right title", why: "the title is wrong", base: { title: "Wrong title", description: "text" } };
  const proposed = endedWith({ kind: "checked", reason: "r", edit });
  assert.deepEqual(clearEdit(proposed, "A").entries[0].outcome, { kind: "checked", reason: "r" });
  assert.equal(clearEdit(proposed, "A").entries[0].phase, "finished");
  const plain = endedWith({ kind: "done", reason: "r", evidence: ["e"] });
  assert.deepEqual(clearEdit(plain, "A"), plain, "nothing to clear: the queue is as it was");
  assert.equal(clearEdit(endedWith({ kind: "draft-pr", prs: [] }), "A").entries[0].outcome?.kind, "draft-pr");
});

test("clearing a move drops the record and leaves the run as it was", () => {
  const ended = endedWith({ kind: "checked", reason: "r" });
  const cleared = clearMove(recordMove(ended, "A", { from: "Todo", to: "In Progress" }), "A");
  assert.equal(cleared.entries[0].movedFrom, undefined);
  assert.deepEqual([cleared.entries[0].phase, cleared.entries[0].outcome], ["finished", { kind: "checked", reason: "r" }]);
});

/** The head the watch read as ready to merge (A11-179): approved at it, no required check red or running. */
const GREEN_HEAD = { head: "h1", approved: true, review: "approved", red: [], pending: [] } as const;
const readyToMerge = (fields: Record<string, unknown> = {}) => endedWith({ kind: "reviewed", prs: [pr] }, { review: [pr], pullStates: { [pr.url]: "open" }, pullHeads: { [pr.url]: GREEN_HEAD }, ...fields });
const a = (queue: Queue) => queue.entries.find((e) => e.ticket.key === "A")!;

test("new feedback on a run Ready to merge queues a review round at the end that answers it, resuming the worker and keeping its Slack link", () => {
  const published = { link: "https://slack/1", at: 4 };
  const queue = feedbackRound(readyToMerge({ published }), "A", "New review feedback on x", 9);
  assert.deepEqual(keys(queue), ["B", "A"]);
  assert.deepEqual(a(queue), { ticket: ticket("A"), repos: [], model: "opus", effort: "high", session: "s1", published, review: [pr], phase: "queued", queuedAt: 9,
    feedback: "New review feedback on x", rounds: 1, ciSince: 2 });
});

test("a run the board does not watch gets no round: awaiting a person's review, parked, merged, or handed back", () => {
  const live = markRunning(markStarting(enqueue(emptyQueue(3), [ticket("A")], choice, 1), "A", 2), "A", "w1", "w1:p1");
  for (const [why, queue] of [
    ["awaiting review", endedWith({ kind: "draft-pr", prs: [pr] })], ["live", live], ["parked", park(live, "A", { kind: "no-outcome" }, 3)],
    ["merged", readyToMerge({ pullStates: { [pr.url]: "merged" } })], ["handed back", readyToMerge({ handedBack: "x" })],
  ] as const) assert.deepEqual(feedbackRound(queue, "A", "f", 9), queue, why);
});

test("after three rounds of its own, the next feedback hands the run to a person, whose Respond to review lets the board carry on", () => {
  assert.equal(MAX_FEEDBACK_ROUNDS, 3);
  const third = readyToMerge({ rounds: 2 });
  assert.equal(a(feedbackRound(third, "A", "f", 9)).rounds, 3, "the third round still starts");
  const fourth = feedbackRound(readyToMerge({ rounds: 3 }), "A", "a failing check", 9);
  assert.deepEqual([a(fourth).phase, a(fourth).outcome?.kind], ["finished", "reviewed"], "it is not queued, and keeps its pull requests");
  assert.match(a(fourth).handedBack ?? "", /keep getting feedback: the board answered 3 rounds on its own and stopped\. Respond to review starts another\. The latest: a failing check/);
  assert.deepEqual(approve(fourth, "A", 10), fourth, "its pull requests are ready: Approve is for drafts");
  const asked = a(respond(fourth, "A", 10));
  assert.deepEqual([asked.phase, asked.rounds, asked.handedBack, asked.feedback, asked.asked], ["queued", undefined, undefined, undefined, true],
    "Respond to review starts the count again");
});

/** A run, A, parked on `outcome` with its workspace open, after a review round that resumed session `s1` and holds the pull request `pr`. */
function parkedOn(outcome: Parameters<typeof park>[2], fields: Record<string, unknown> = {}): Queue {
  const queue = markRunning(markStarting(enqueue(emptyQueue(3), [ticket("A"), ticket("B")], choice, 1), "A", 2), "A", "w1", "w1:p1");
  const parked = park(queue, "A", outcome, 3, { session: "s1" });
  return { ...parked, entries: parked.entries.map((e) => (e.ticket.key === "A" ? { ...e, review: [pr], pullStates: { [pr.url]: "open" }, ...fields } : e)) };
}

test("A11-89: a parked run whose pull request conflicts is queued as a review round that resumes its worker, keeps its session, and holds no workspace", () => {
  const queue = conflictRound(parkedOn({ kind: "needs-human", reason: "which colour?" }), "A", "a conflict line", 9);
  assert.deepEqual(keys(queue), ["B", "A"]);
  assert.deepEqual(a(queue), { ticket: ticket("A"), repos: [], model: "opus", effort: "high", session: "s1", review: [pr], phase: "queued", queuedAt: 9,
    feedback: "a conflict line", rounds: 1, ciSince: 2 });
});

test("A11-89: a parked run that has used its rounds is left parked, with no handedBack, and a run the board watches or does not resume is left as it is", () => {
  const capped = parkedOn({ kind: "needs-human", reason: "x" }, { rounds: 3 });
  assert.deepEqual(conflictRound(capped, "A", "a conflict line", 9), capped, "nothing queued at the cap");
  assert.equal(a(conflictRound(capped, "A", "a conflict line", 9)).handedBack, undefined, "no handedBack: a parked run reads Needs you already");
  for (const [why, queue] of [
    ["stopped", parkedOn({ kind: "stopped" })], ["checked", parkedOn({ kind: "checked", reason: "nothing to do" })], ["a draft", parkedOn({ kind: "draft-pr", prs: [pr] })],
    ["watched", readyToMerge()], ["tracker completed", parkedOn({ kind: "needs-human", reason: "x" }, { trackerState: "completed" })],
  ] as const) assert.deepEqual(conflictRound(queue, "A", "a conflict line", 9), queue, why);
});

test("Publish queues one run for the ticked runs Ready to merge with their open pull requests, refusing any other run and a second publish", () => {
  const ready = readyToMerge();
  const queued = queuePublish(ready, ["A"], 36);
  assert.deepEqual(queued.publish, { id: "p10", keys: ["A"], prs: [pr], phase: "queued", queuedAt: 36 });
  assert.throws(() => queuePublish(queued, ["A"], 37), /a publish run is under way/);
  assert.throws(() => queuePublish(ready, ["B"], 37), /B is not Ready to merge/);
  assert.throws(() => queuePublish(readyToMerge({ published: { link: null, at: 1 } }), ["A"], 37), /A is not Ready to merge/, "no double posting");
  assert.throws(() => queuePublish(ready, [], 37), /tick at least one/);
  assert.doesNotThrow(() => queuePublish(publishFailed(queued, "x", 40), ["A"], 41), "a finished publish run is no bar to the next");
});

test("Publish on a machine that publishes before review queues a run awaiting only its review, refuses it by default, and refuses a draft, red checks or an unread head under either setting", () => {
  const unreviewed = (fields: Record<string, unknown> = {}, head: Record<string, unknown> = {}) => readyToMerge({ pullHeads: { [pr.url]: { ...GREEN_HEAD, approved: false, review: "none", ...head } }, ...fields });
  assert.deepEqual(queuePublish(unreviewed(), ["A"], 36, "awaiting-review").publish?.keys, ["A"]);
  assert.deepEqual(queuePublish(readyToMerge(), ["A"], 36, "awaiting-review").publish?.keys, ["A"], "Ready to merge still publishes");
  assert.throws(() => queuePublish(unreviewed(), ["A"], 36), /A is not Ready to merge, so it cannot be published/, "the default is today's");
  assert.throws(() => queuePublish(unreviewed(), ["A"], 36, "ready-to-merge"), /A is not Ready to merge, so/);
  for (const [why, queue] of [["red", unreviewed({}, { red: ["gate"] })], ["running", unreviewed({}, { pending: ["suite"] })], ["not read yet", readyToMerge({ pullHeads: {} })],
    ["a draft", unreviewed({ outcome: { kind: "draft-pr", prs: [pr] } })], ["published", unreviewed({ published: { link: null, at: 1 } })]] as const) {
    assert.throws(() => queuePublish(queue, ["A"], 36, "awaiting-review"), /A is not Ready to merge, nor awaiting only its review/, why);
  }
});

test("a publish run holds a slot while it is live, starts while workers are paused, and its result marks its runs Published or leaves them as they were", () => {
  const queued = queuePublish(pauseQueue(readyToMerge()), ["A"], 36);
  assert.equal(publishStarts(queued), true, "the person just asked for it");
  assert.equal(publishStarts({ ...queued, max: 0 }), false, "but it needs a free slot");
  const running = markPublishRunning(markPublishStarting(queued, 37), "w9", "w9:p1");
  assert.equal(nextStarts({ ...resumeQueue(enqueue(running, [ticket("C"), ticket("D")], choice, 38)), max: 2 }, 1, 8).length, 1, "it holds one of two slots");
  const done = publishDone(running, ["https://slack/1", "https://slack/2"], 50);
  assert.deepEqual(a(done).published, { link: "https://slack/1", at: 50 }, "the first link");
  assert.deepEqual([done.publish?.phase, done.publish?.workspace, done.publish?.pane], ["finished", undefined, undefined]);
  const failed = publishFailed(running, "no channel for nbl-ui-netbox", 50);
  assert.deepEqual([a(failed).published, failed.publish?.failure], [undefined, "no channel for nbl-ui-netbox"]);
  const path = join(tmpDir("ticket-queue-publish-"), "queue.json");
  saveQueue(path, done);
  assert.deepEqual(loadQueue(path, 3).publish, done.publish, "the publish run survives a restart of the board");
});

test("Respond to review queues a round now on a run Ready to merge or Published, resuming the worker", () => {
  const published = { link: "https://slack/1", at: 4 };
  const queue = respond(readyToMerge({ published, rounds: 2 }), "A", 9);
  assert.deepEqual(keys(queue), ["B", "A"]);
  assert.deepEqual(a(queue), { ticket: ticket("A"), repos: [], model: "opus", effort: "high", session: "s1", published, review: [pr], phase: "queued", queuedAt: 9, asked: true, ciSince: 2 });
});

test("A11-154: Respond to review queues a round on a finished run with a pull request open whatever its outcome ended on, resuming the worker", () => {
  const open = { review: [pr], pullStates: { [pr.url]: "open" } };
  for (const outcome of [
    { kind: "needs-human", reason: "which colour?" }, { kind: "crashed", reason: "herdr finds no agent in its workspace" }, { kind: "no-outcome" }, { kind: "wrong-repo", where: "a11ign/control" },
    { kind: "ready-pr", prs: [pr] }, { kind: "reviewed", prs: [pr] },
  ] as const) {
    const asked = a(respond(endedWith(outcome, open), "A", 9));
    assert.deepEqual([asked.phase, asked.review, asked.session, asked.asked, asked.outcome], ["queued", [pr], "s1", true, undefined], outcome.kind);
  }
});

test("A11-154: Respond to review on a run whose pull requests are drafts approves them, marking them ready and starting the same round", () => {
  const draft = endedWith({ kind: "draft-pr", prs: [pr] }, { pullStates: { [pr.url]: "open" } });
  assert.deepEqual(respond(draft, "A", 9), approve(draft, "A", 9));
  assert.deepEqual([a(respond(draft, "A", 9)).phase, a(respond(draft, "A", 9)).review], ["queued", [pr]]);
});

test("A11-154: Respond to review that cannot act throws the reason, and changes nothing", () => {
  const live = markRunning(markStarting(enqueue(emptyQueue(3), [ticket("A")], choice, 1), "A", 2), "A", "w1", "w1:p1");
  const queued = respond(readyToMerge(), "A", 9);
  const refused: [string, Queue, RegExp][] = [
    ["a run not on the board", readyToMerge(), /Z is not on the board/],
    ["a run still running", live, /A is still running/],
    ["a run not yet run", enqueue(emptyQueue(3), [ticket("A")], choice, 1), /A has not run yet/],
    ["a round already queued", queued, /a round is already queued for A/],
    ["a talk session already queued", talk(readyToMerge(), "A", 9), /a talk session is already queued for A/],
    ["no pull request open", endedWith({ kind: "needs-human", reason: "x" }), /A has no pull request open/],
    ["a merged pull request", readyToMerge({ pullStates: { [pr.url]: "merged" } }), /A has no pull request open/],
    ["completed in the tracker", recordTrackerStates(readyToMerge(), new Map([["A", "completed"]])), /A's ticket is completed in the tracker, so there is nothing to respond to/],
    ["canceled in the tracker", recordTrackerStates(readyToMerge(), new Map([["A", "canceled"]])), /A's ticket is closed in the tracker/],
    ["a workspace still open", readyToMerge({ workspace: "w1" }), /A's workspace is open/],
  ];
  for (const [why, queue, reason] of refused) {
    const key = why === "a run not on the board" ? "Z" : "A";
    assert.throws(() => respond(queue, key, 9), reason, why);
  }
});

test("A11-125: Respond to review on a run the board handed back at its cap for a conflict carries the conflict lines, and a retry keeps them while no other round does", () => {
  const conflict = "https://github.com/x/app/pull/1 conflicts with its base branch main.";
  const handed = feedbackRound(readyToMerge({ rounds: 3 }), "A", conflict, 9);
  assert.match(a(handed).handedBack ?? "", /The latest: https:\/\/github\.com\/x\/app\/pull\/1 conflicts with its base branch main\./);
  const asked = a(respond(handed, "A", 10));
  assert.deepEqual([asked.asked, asked.conflict, asked.handedBack], [true, conflict, undefined], "the round names the conflict it answers");
  const crashed = finish(markRunning(markStarting(respond(handed, "A", 10), "A", 10), "A", "w2", "w2:p1"), "A", { kind: "crashed", reason: "x" }, 11);
  assert.equal(a(retry(crashed, "A", 12)).conflict, conflict, "a retried round keeps the conflict it answers");
  const checked = a(respond(feedbackRound(readyToMerge({ rounds: 3 }), "A", "a failing check", 9), "A", 10));
  assert.equal(checked.conflict, undefined, "a check that fails is no conflict, so the round has none");
  assert.equal(a(feedbackRound(readyToMerge({ conflict }), "A", "a board round", 9)).conflict, undefined, "a board round drops it");
  assert.equal(a(approve(endedWith({ kind: "draft-pr", prs: [pr] }, { pullStates: { [pr.url]: "open" }, conflict }), "A", 9)).conflict, undefined, "an approved round drops it");
});

test("a review round that failed is retried as the same round: its feedback, its asking and its count of the board's own rounds stay", () => {
  const round = feedbackRound(readyToMerge({ rounds: 1 }), "A", "f", 9);
  const crashed = finish(markRunning(markStarting(round, "A", 10), "A", "w2", "w2:p1"), "A", { kind: "crashed", reason: "x" }, 11);
  const retried = a(retry(crashed, "A", 12));
  assert.deepEqual([retried.feedback, retried.rounds, retried.review], ["f", 2, [pr]], "the cap cannot be escaped by a retry");
  const asked = respond(readyToMerge(), "A", 9);
  const failed = finish(markRunning(markStarting(asked, "A", 10), "A", "w2", "w2:p1"), "A", { kind: "crashed", reason: "x" }, 11);
  assert.equal(a(retry(failed, "A", 12)).asked, true);
});

test("Publish posts each ticked run once, and a run queued for another round while it posts is still Published", () => {
  assert.deepEqual(queuePublish(readyToMerge(), ["A", "A"], 36).publish?.prs, [pr], "a run ticked twice is posted once");
  const publishing = markPublishRunning(markPublishStarting(queuePublish(readyToMerge(), ["A"], 36), 37), "w9", "w9:p1");
  const meanwhile = respond(publishing, "A", 40);
  assert.deepEqual(a(publishDone(meanwhile, ["https://slack/1"], 50)).published, { link: "https://slack/1", at: 50 });
});

test("a ready pull request run is not approved: approve changes nothing, since only a draft waits for an Approve", () => {
  const pr = { repo: "nbl-ui-netbox", url: "https://github.com/x/nbl-ui-netbox/pull/1" };
  const ready = endedWith({ kind: "ready-pr", prs: [pr] }, { pullStates: { [pr.url]: "open" } });
  assert.equal(approve(ready, "A", 9), ready, "the same queue back");
  assert.equal(ready.entries.find((e) => e.ticket.key === "A")?.outcome?.kind, "ready-pr");
});

test("dismiss takes a finished run off the board, and leaves a queued, live, parked or being-published one where it is", () => {
  let queue = resumeQueue(enqueue(emptyQueue(2), [ticket("A"), ticket("B"), ticket("C")], choice, 1));
  queue = markRunning(markStarting(queue, "A", 2), "A", "w1", "w1:p1");
  assert.equal(dismiss(queue, "A"), queue, "a live run is Stop's");
  assert.equal(dismiss(queue, "B"), queue, "a queued run is Remove's");
  queue = park(queue, "A", { kind: "needs-human", reason: "which colour?" }, 5);
  assert.equal(dismiss(queue, "A"), queue, "a parked run's workspace is closed first, so no workspace is left with no run to close it");
  queue = unpark(queue, "A");
  assert.deepEqual(keys(dismiss(queue, "A")), ["B", "C"], "once closed, it goes");
  queue = finish(markRunning(markStarting(queue, "B", 6), "B", "w2", "w2:p1"), "B", { kind: "checked", reason: "already fixed" }, 8);
  assert.deepEqual(keys(dismiss(queue, "B")), ["A", "C"], "a checked run is dismissed like any other");
  assert.equal(dismiss(queue, "NOPE"), queue);
});

test("a checked run is not retried: a second worker would check the same thing again", () => {
  let queue = resumeQueue(enqueue(emptyQueue(1), [ticket("A")], choice, 1));
  queue = finish(markRunning(markStarting(queue, "A", 2), "A", "w1", "w1:p1"), "A", { kind: "checked", reason: "nothing to change" }, 5);
  assert.equal(retry(queue, "A", 9), queue);
  assert.deepEqual(queue.entries[0].outcome, { kind: "checked", reason: "nothing to change" });
});

test("a run the publish run under way is posting is not dismissed until the publish run has ended", () => {
  const publishing = queuePublish(readyToMerge(), ["A"], 36);
  assert.equal(dismiss(publishing, "A"), publishing);
  assert.deepEqual(keys(dismiss(publishDone(publishing, ["https://slack/1"], 40), "A")), ["B"]);
});

test("A11-76: the queue refuses a parent, a ticket with open sub-issues, whole and naming why, and takes it once its sub-issues are all done", () => {
  const epic = { ...ticket("A11-24"), children: ["A11-25", "A11-26"] };
  const before = enqueue(emptyQueue(3), [ticket("A")], choice, 1);
  assert.throws(() => enqueue(before, [ticket("B"), epic], choice, 2),
    /^Error: A11-24 has 2 open sub-issues \(A11-25, A11-26\): a parent is not queued, because it has nothing of its own to build\. Queue its children instead$/);
  assert.throws(() => refuseParents([{ ...ticket("A11-9"), children: ["A11-10"] }]), /A11-9 has 1 open sub-issue \(A11-10\)/);
  const settled = enqueue(before, [ticket("B"), { ...epic, children: [] }], choice, 2);
  assert.deepEqual(keys(settled), ["A", "B", "A11-24"], "an epic whose sub-issues are all done or canceled is queued as any ticket is");
  assert.deepEqual(keys(enqueue(before, [ticket("C")], choice, 2)), ["A", "C"], "a ticket read before sub-issues were (no children field) is ordinary");
});

test("A11-76: a parent's children are queued in their blocking order, siblings first, and by identifier where nothing orders them", () => {
  const blockers = new Map([["A11-25", [{ key: "A11-27" }]], ["A11-27", [{ key: "A11-26" }, { key: "OTHER-1" }]], ["A11-26", []]]);
  assert.deepEqual(childOrder(["A11-25", "A11-26", "A11-27", "A11-100"], blockers), { keys: ["A11-26", "A11-27", "A11-25", "A11-100"], note: null },
    "A11-26 blocks A11-27, which blocks A11-25; a blocker that is not a sibling orders nothing; A11-100 is free and last by identifier");
  const queued = enqueue(emptyQueue(3), childOrder(["A11-25", "A11-26", "A11-27"], blockers).keys.map(ticket), choice, 1);
  assert.deepEqual(keys(queued), ["A11-26", "A11-27", "A11-25"], "the queue runs them in that order");
});

test("A11-76: with no blocking relations to read, a parent's children go in identifier order, and the note says so; a cycle is named", () => {
  assert.deepEqual(childOrder(["A11-10", "A11-9", "A11-100", "A11-9"], null),
    { keys: ["A11-9", "A11-10", "A11-100"], note: "the tracker gives no blocking order, so they are queued in identifier order" });
  const cycle = childOrder(["A-3", "A-1", "A-2"], new Map([["A-1", [{ key: "A-2" }]], ["A-2", [{ key: "A-1" }]], ["A-3", []]]));
  assert.deepEqual(cycle, { keys: ["A-3", "A-1", "A-2"], note: "the blocking relations among A-1, A-2 go round in a cycle, so those are queued in identifier order" });
  assert.ok(byIdentifier("A11-9", "A11-10") < 0 && byIdentifier("B-1", "A-2") > 0);
});

test("the live runs are the starting and running ones, a batch counted once, and the publish run while it is under way", () => {
  let queue = resumeQueue(enqueue(emptyQueue(5), [ticket("A"), ticket("B"), ticket("C")], choice, 1));
  assert.equal(liveRunCount(queue), 0, "queued is not live");
  queue = markRunning(markStarting(queue, "A", 2), "A", "w1", "w1:p1");
  queue = markStarting(queue, "B", 3);
  assert.equal(liveRunCount(queue), 2);
  queue = { ...queue, entries: queue.entries.map((e) => (e.ticket.key === "A" || e.ticket.key === "C" ? { ...e, phase: "running" as const, batch: "b1" } : e)) };
  assert.equal(liveRunCount(queue), 2, "A and C are one batch's run");
  queue = { ...queue, publish: { id: "p1", keys: [], prs: [], phase: "running", queuedAt: 4 } };
  assert.equal(liveRunCount(queue), 3);
  queue = finish(queue, "B", { kind: "stopped" }, 5);
  assert.equal(liveRunCount({ ...queue, publish: { ...queue.publish!, phase: "finished" } }), 1);
});

test("A11-80: a working note keeps a running run running; only a newer one replaces it, and the outcome the run ends on drops it", () => {
  const running = runningA();
  const noted = noteWorking(running, "A", "the roll is still running", 50, 60);
  const a = (q: Queue) => q.entries[0];
  assert.deepEqual([a(noted).phase, a(noted).working], ["running", { reason: "the roll is still running", at: 50, idleSince: 60 }]);
  assert.deepEqual(a(noteWorking(noted, "A", "again", 50, 99)).working, a(noted).working, "the same file read again changes nothing");
  assert.deepEqual(a(noteWorking(noted, "A", "the second play is running", 70, 80)).working, { reason: "the second play is running", at: 70, idleSince: 80 });
  const ended = finish(noted, "A", { kind: "draft-pr", prs: [] }, 90);
  assert.deepEqual([a(ended).phase, a(ended).working], ["finished", undefined], "the outcome it ended on replaces the note");
  assert.equal(a(noteWorking(ended, "A", "late", 95, 96)).working, undefined, "a working outcome never touches a run that is not running");
});

test("A11-80: a working run idle with no newer outcome for the stall time is marked stalled, and working again clears the clock", () => {
  const running = runningA();
  const stall = 30 * 60_000;
  const noted = noteWorking(running, "A", "the roll is still running", 50, 1000);
  const note = (q: Queue) => q.entries[0].working;
  assert.equal(note(watchWorking(noted, "A", "idle", 1000 + stall - 1, stall))?.stalled, undefined, "not yet");
  const stalled = watchWorking(noted, "A", "idle", 1000 + stall, stall);
  assert.equal(note(stalled)?.stalled, true);
  assert.equal(stalled.entries[0].phase, "running", "a stall ends nothing");
  const woke = watchWorking(stalled, "A", "working", 1000 + stall + 5, stall);
  assert.deepEqual(note(woke), { reason: "the roll is still running", at: 50 }, "its work woke it: no idle clock, no stall");
  assert.equal(note(watchWorking(woke, "A", "idle", 1000 + stall + 10, stall))?.idleSince, 1000 + stall + 10, "idle again starts the clock again");
  assert.deepEqual(watchWorking(running, "A", "idle", 1e9, stall), running, "a run with no note has no stall");
});

test("A11-85: an idle working run with no background work is stalled by background work gone once BACKGROUND_GONE_MS has passed, and resumed once", () => {
  const stall = 30 * 60_000;
  const noted = workingA();
  const note = (q: Queue) => q.entries[0].working;
  const none = (q: Queue, now: number) => watchWorking(q, "A", "idle", now, stall, "none");
  const first = none(noted, 1000);
  assert.deepEqual(note(first), { reason: "the roll is still running", at: 50, idleSince: 1000, noBackgroundSince: 1000 }, "the gone clock starts");
  assert.equal(note(none(first, 1000 + BACKGROUND_GONE_MS - 1))?.stalled, undefined, "not before the time");
  const gone = none(first, 1000 + BACKGROUND_GONE_MS);
  assert.deepEqual([note(gone)?.stalled, note(gone)?.stallReason, note(gone)?.resumed], [true, BACKGROUND_GONE, true], "stalled, and resumed");
  assert.equal(gone.entries[0].phase, "running", "a stall ends nothing");
  assert.equal(note(none(gone, 1000 + BACKGROUND_GONE_MS * 2))?.resumed, true, "still resumed, not again");
});

test("A11-85: a shell or a Monitor on the pane clears the gone mark, and a pane that cannot be read changes nothing of it", () => {
  const running = runningA();
  const noted = noteWorking(running, "A", "the roll is still running", 50, 1000);
  const note = (q: Queue) => q.entries[0].working;
  const started = watchWorking(noted, "A", "idle", 1000, 30 * 60_000, "none");
  const gone = watchWorking(started, "A", "idle", 1000 + BACKGROUND_GONE_MS, 30 * 60_000, "none");
  assert.equal(note(gone)?.stalled, true, "POSITIVE: the run is stalled before the live work is seen");
  const live = watchWorking(gone, "A", "idle", 1000 + BACKGROUND_GONE_MS + 1, 30 * 60_000, "live");
  assert.deepEqual(note(live), { reason: "the roll is still running", at: 50, idleSince: 1000, waiting: true }, "live work clears the stall, the gone clock and the resume, and the run is waiting on it");
  const unread = watchWorking(noted, "A", "idle", 1000 + BACKGROUND_GONE_MS * 5, 30 * 60_000, null);
  assert.deepEqual(note(unread), { reason: "the roll is still running", at: 50, idleSince: 1000 }, "a pane that cannot be read: the idle clock alone");
});

test("A11-85: a newer working note keeps the resume, so the worker is not prompted twice, and working status clears the stall but not the resume", () => {
  const running = runningA();
  const note = (q: Queue) => q.entries[0].working;
  const started = watchWorking(noteWorking(running, "A", "first", 50, 1000), "A", "idle", 1000, 30 * 60_000, "none");
  const gone = watchWorking(started, "A", "idle", 1000 + BACKGROUND_GONE_MS, 30 * 60_000, "none");
  assert.equal(note(gone)?.resumed, true, "POSITIVE: resumed once the gone time has passed");
  const again = noteWorking(gone, "A", "second", 70, 2000);
  assert.deepEqual(note(again), { reason: "second", at: 70, idleSince: 2000, resumed: true }, "the resume outlasts a newer note");
  const woke = watchWorking(gone, "A", "working", 2001, 30 * 60_000, "none");
  assert.deepEqual(note(woke), { reason: "first", at: 50, resumed: true }, "working clears the stall and the gone clock, and keeps the resume");
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

test("A11-236: an idle run whose pane shows live background work is waiting, not stalled, past the idle clock and up to the three-hour bound", () => {
  const stall = 30 * MINUTE;
  const noted = noteWorking(runningA(), "A", "two shells are running", 1000, 1000);
  const note = (q: Queue) => q.entries[0].working;
  const idle = (now: number) => note(watchWorking(noted, "A", "idle", now, stall, "live"));
  assert.deepEqual([idle(1000 + 31 * MINUTE)?.waiting, idle(1000 + 31 * MINUTE)?.stalled], [true, undefined], "31 minutes idle with shells: waiting, not stalled");
  assert.deepEqual([idle(1000 + 3 * HOUR - 1)?.waiting, idle(1000 + 3 * HOUR - 1)?.stalled], [true, undefined], "just inside three hours: still waiting");
  const control = note(watchWorking(noted, "A", "idle", 1000 + 31 * MINUTE, stall, null));
  assert.deepEqual([control?.waiting, control?.stalled], [undefined, true], "CONTROL: the same idle time with an unreadable pane stalls, as it always did");
});

test("A11-236: past three hours with live work and no named job, the worker is woken once, and the run is stalled only after tickets.stallMinutes more idle, saying its background work was still running", () => {
  const noted = noteWorking(runningA(), "A", "two shells are running", 1000, 1000);
  const late = watchWorking(noted, "A", "idle", 1000 + 3 * HOUR, 30 * MINUTE, "live").entries[0].working;
  assert.deepEqual([late?.stalled, late?.waiting, late?.woke], [undefined, undefined, { at: 1000 + 3 * HOUR, why: "late" }], "at the bound: woken once, not stalled yet");
  const later = watchWorking(watchWorking(noted, "A", "idle", 1000 + 3 * HOUR, 30 * MINUTE, "live"), "A", "idle", 1000 + 3 * HOUR + 30 * MINUTE, 30 * MINUTE, "live").entries[0].working;
  assert.deepEqual([later?.stalled, later?.woke], [true, { at: 1000 + 3 * HOUR, why: "late" }], "stalled once the grace has passed, and the wake is not set again");
  assert.equal(later?.stallReason, `waited past ${new Date(1000 + 3 * HOUR).toISOString()} with its background work still running`);
});

test("A11-236: a note that names a job is waiting inside its bound even with a pane that shows none, and the worker is prompted once, not stalled", () => {
  const noted = noteWorking(runningA(), "A", "the fleet capture runs", 1000, 1000, { waitingOn: "the fleet capture on three boxes" });
  const note = (q: Queue) => q.entries[0].working;
  const first = watchWorking(noted, "A", "idle", 1000, 30 * MINUTE, "none");
  const gone = watchWorking(first, "A", "idle", 1000 + BACKGROUND_GONE_MS, 30 * MINUTE, "none");
  assert.deepEqual([note(gone)?.waiting, note(gone)?.stalled, note(gone)?.resumed], [true, undefined, true], "waiting, not stalled, and resumed once");
  const hour = watchWorking(gone, "A", "idle", 1000 + HOUR, 30 * MINUTE, "none");
  assert.deepEqual([note(hour)?.waiting, note(hour)?.stalled], [true, undefined], "an hour in: the idle clock does not stall it");
  const unread = note(watchWorking(noted, "A", "idle", 1000 + HOUR, 30 * MINUTE, null));
  assert.deepEqual([unread?.waiting, unread?.stalled], [true, undefined], "an unreadable pane: the declared wait still counts");
});

test("A11-236: past its until, a run that named a job is woken once and then stalled after the grace, and the reason names the job and the deadline", () => {
  const until = Date.parse("2026-10-24T23:00:00Z");
  const at = until - 2 * HOUR;
  const noted = noteWorking(runningA(), "A", "the fleet capture runs", at, at, { waitingOn: "the fleet capture on three boxes", until });
  const note = (q: Queue, now: number, background: "live" | "none" | null = "live") => watchWorking(q, "A", "idle", now, 30 * MINUTE, background);
  assert.equal(note(noted, until - 1).entries[0].working?.waiting, true, "inside until");
  const expired = note(noted, until);
  assert.deepEqual([expired.entries[0].working?.stalled, expired.entries[0].working?.waiting, expired.entries[0].working?.woke], [undefined, undefined, { at: until, why: "late" }], "at until: woken, not stalled");
  for (const background of ["live", null, "none"] as const) {
    const stalled = note(note(noted, until, background), until + 30 * MINUTE, background).entries[0].working;
    assert.equal(stalled?.stallReason, "waited past 2026-10-24T23:00:00.000Z on the fleet capture on three boxes", `stalled after the grace with a pane that reads ${background}`);
  }
});

test("A11-236: until replaces the three-hour default, longer or shorter, and a newer working note starts the bound again", () => {
  const stall = 30 * MINUTE;
  const longer = noteWorking(runningA(), "A", "r", 0, 0, { waitingOn: "job", until: 5 * HOUR });
  const at = (q: Queue, now: number) => watchWorking(q, "A", "idle", now, stall, "live").entries[0].working;
  assert.deepEqual([at(longer, 4 * HOUR)?.waiting, at(longer, 4 * HOUR)?.stalled], [true, undefined], "an until five hours out: still waiting at four");
  const shorter = noteWorking(runningA(), "A", "r", 0, 0, { waitingOn: "job", until: HOUR });
  assert.deepEqual([at(shorter, HOUR)?.woke?.why, at(shorter, HOUR)?.waiting], ["late", undefined], "an until one hour out: the bound is passed at one hour, not three");
  const stalled = watchWorking(shorter, "A", "idle", HOUR, stall, "live");
  const renewed = noteWorking(stalled, "A", "still running", 2 * HOUR, 2 * HOUR, { waitingOn: "job" });
  assert.deepEqual([at(renewed, 4 * HOUR)?.waiting, at(renewed, 4 * HOUR)?.stalled], [true, undefined], "a newer outcome counts the three hours from its own time");
});

test("A11-236: an until at or before the outcome's own time is the bound as written: the worker is woken at its first idle tick, and the stall that follows names the job and that time", () => {
  const at = Date.parse("2026-10-25T08:00:00Z");
  const past = Date.parse("2026-01-01T12:00:00Z");
  const idle = (until: number, now: number) => watchWorking(noteWorking(runningA(), "A", "r", at, at, { waitingOn: "job", until }), "A", "idle", now, 30 * MINUTE, "live").entries[0].working;
  assert.equal(idle(past, at + MINUTE)?.woke?.why, "late", "an until before the file: woken at once");
  const stalled = watchWorking(watchWorking(noteWorking(runningA(), "A", "r", at, at, { waitingOn: "job", until: past }), "A", "idle", at + MINUTE, 30 * MINUTE, "live"), "A", "idle", at + MINUTE + 30 * MINUTE, 30 * MINUTE, "live").entries[0].working;
  assert.equal(stalled?.stallReason, "waited past 2026-01-01T12:00:00.000Z on job", "naming the job and the until it gave");
  assert.deepEqual([idle(at, at - 1)?.waiting, idle(at, at)?.woke?.why], [true, "late"], "an until equal to the file's time ends the wait at that time");
});

test("A11-236: working status clears waiting along with the idle clock and the stall, and a note without a job or live work takes the idle clock as before", () => {
  const noted = noteWorking(runningA(), "A", "r", 50, 1000, { waitingOn: "job" });
  const waiting = watchWorking(noted, "A", "idle", 2000, 30 * MINUTE, "live");
  assert.equal(waiting.entries[0].working?.waiting, true);
  const woke = watchWorking(waiting, "A", "working", 3000, 30 * MINUTE, "live").entries[0].working;
  assert.deepEqual(woke, { reason: "r", at: 50, waitingOn: "job" }, "awake: no idle clock, no waiting");
  const plain = watchWorking(noteWorking(runningA(), "A", "r", 50, 1000), "A", "idle", 1000 + 30 * MINUTE, 30 * MINUTE, "none").entries[0].working;
  assert.equal(plain?.stalled, true, "no job and no live work: the idle clock stalls it");
  assert.equal(plain?.waiting, undefined);
});

// A11-82: runs that share a path in one repository start in turn, and a review round keeps the footprint of the run it continues.
test("A11-82: runs that share a path in one repository start in turn: the earlier one starts and the later waits for it, while disjoint and other-repository runs start together", () => {
  const queued = resumeQueue(enqueue(emptyQueue(4), [ticket("A"), ticket("B"), ticket("C"), ticket("D")], choice, 1));
  const queue = recordPaths(queued, new Map([["A", ["app:src/pool.ts"]], ["B", ["app:src/"]], ["C", ["lib:src/pool.ts"]], ["D", ["app:docs/"]]]));
  assert.deepEqual(nextStarts(queue, 0, 14).map((e) => e.ticket.key), ["A", "C", "D"], "B shares src/pool.ts with A, and waits for it in this pass");
  const running = markRunning(markStarting(queue, "A", 2), "A", "w1", "w1:p1");
  assert.deepEqual(nextStarts(running, 0, 14).map((e) => e.ticket.key), ["C", "D"], "with A live, B is held, and the rest start");
  assert.equal(runStatus(running.entries.find((e) => e.ticket.key === "B")!, running.entries), "blocked", "B shows Blocked");
  const reviewed = finish(running, "A", { kind: "draft-pr", prs: [pr] }, 3);
  const open = { ...reviewed, entries: reviewed.entries.map((e) => (e.ticket.key === "A" ? { ...e, pullStates: { [pr.url]: "open" as const }, pullFiles: { [pr.url]: ["src/pool.ts"] } } : e)) };
  assert.deepEqual(nextStarts(open, 0, 14).map((e) => e.ticket.key), ["C", "D"], "a finished run with a pull request open still holds its path");
  const merged = { ...open, entries: open.entries.map((e) => (e.ticket.key === "A" ? { ...e, pullStates: { [pr.url]: "merged" as const } } : e)) };
  assert.deepEqual(nextStarts(merged, 0, 14).map((e) => e.ticket.key), ["B", "C", "D"], "once its pull request merges, B starts");
});

// A11-125: a run that has just ended with a pull request open holds its files from that moment, and while they are unread it holds its repository.
test("A11-125: a finished run with a pull request whose files are not read yet holds its repository, and holds only its files once they are read", () => {
  const queued = resumeQueue(enqueue(emptyQueue(4), [ticket("A"), ticket("B"), ticket("C"), ticket("D")], choice, 1));
  const queue = recordPaths(queued, new Map([["A", ["app:src/plan.ts"]], ["B", ["app:src/other.ts"]], ["C", ["lib:src/pool.ts"]], ["D", ["app:docs/"]]]));
  const ended = finish(markRunning(markStarting(queue, "A", 2), "A", "w1", "w1:p1"), "A", { kind: "draft-pr", prs: [pr] }, 3);
  const open = (fields: Record<string, unknown>) => ({ ...ended, entries: ended.entries.map((e) => (e.ticket.key === "A" ? { ...e, pullStates: { [pr.url]: "open" as const }, ...fields } : e)) });
  assert.deepEqual(nextStarts(open({}), 0, 14).map((e) => e.ticket.key), ["C"], "unread: B and D share its repository, and wait for the watch");
  assert.equal(runStatus(open({}).entries.find((e) => e.ticket.key === "D")!, open({}).entries), "blocked", "D shows Blocked");
  assert.equal(waitNote(open({}).entries.find((e) => e.ticket.key === "B")!, open({}).entries), "Waits on A #1: its changed files are not read yet");
  assert.deepEqual(nextStarts(open({ pullFiles: { [pr.url]: ["README.md"] } }), 0, 14).map((e) => e.ticket.key), ["B", "C", "D"], "read: only what it changes holds, and B and D start");
});

// A11-125: a run whose plan could not be downloaded takes no slot another run could use, and the read that finds its plan clears why it waits.
test("A11-125: a run whose plan could not be downloaded takes no slot, and the read that finds its plan clears why it waits", () => {
  const failing = recordPathsFailure(resumeQueue(enqueue(emptyQueue(1), [ticket("A"), ticket("B")], choice, 1)), new Map([["A", "the link is gone"]]));
  const withB = recordPaths(failing, new Map([["B", ["app:src/b.ts"]]]));
  assert.deepEqual(nextStarts(withB, 0, 14).map((e) => e.ticket.key), ["B"], "A is passed over, and B takes the one slot");
  assert.equal(recordPaths(withB, new Map([["A", ["app:src/a.ts"]]])).entries[0].pathsFailure, undefined, "read, its failure is cleared");
  assert.deepEqual(recordPaths(withB, new Map([["A", ["app:src/a.ts"]]])).entries[0].paths, ["app:src/a.ts"]);
  assert.equal(recordPathsFailure(recordPaths(withB, new Map([["A", ["app:src/a.ts"]]])), new Map([["A", "again"]])).entries[0].pathsFailure, "again", "and a later failure is recorded");
});

// A11-125: Start anyway passes a queued run's overlap, records it, and keeps the record through a start, a finish, a retry and a review round.
test("A11-125: Start anyway passes a run's overlap and the record survives a start, a finish, a retry and a review round", () => {
  const queued = recordPaths(resumeQueue(enqueue(emptyQueue(3), [ticket("A"), ticket("B")], choice, 1)), new Map([["A", ["app:src/pool.ts"]], ["B", ["app:src/"]]]));
  const running = markRunning(markStarting(queued, "A", 2), "A", "w1", "w1:p1");
  const b = () => running.entries.find((e) => e.ticket.key === "B")!;
  assert.deepEqual(runActions(b(), undefined, running.entries), ["start-anyway", "remove"], "Blocked on the overlap, it is offered Start anyway beside Remove");
  assert.throws(() => startAnyway(running, "A", 5), /A is not queued/, "a run that is not queued has no overlap to start past");
  const passed = startAnyway(running, "B", 5);
  assert.deepEqual(passed.entries.find((e) => e.ticket.key === "B")?.overlapOverride, { holder: "A", pull: null, path: "src/", at: 5 }, "the overlap it passed is recorded");
  assert.deepEqual(nextStarts(passed, 0, 14).map((e) => e.ticket.key), ["B"], "it starts now, beside A");
  const started = markRunning(markStarting(passed, "B", 6), "B", "w2", "w2:p2");
  assert.equal(started.entries.find((e) => e.ticket.key === "B")?.overlapOverride?.holder, "A", "a start keeps it");
  const crashed = finish(started, "B", { kind: "crashed", reason: "x" }, 7);
  const retried = retry(crashed, "B", 8);
  assert.equal(retried.entries.find((e) => e.ticket.key === "B")?.overlapOverride, undefined, "a retry starts over: an overlap is checked again, and not passed silently");
  assert.equal(feedbackRound(readyToMerge({ overlapOverride: { holder: "A", pull: null, path: "src/", at: 5 } }), "A", "f", 9).entries.find((e) => e.ticket.key === "A")?.overlapOverride?.holder,
    "A", "a review round keeps it");
  const reviewing = feedbackRound(readyToMerge(), "A", "f", 9);
  assert.equal(reviewing.entries.find((e) => e.ticket.key === "A")?.pullFiles, undefined, "a review round whose files are not read yet");
  const withB = recordPaths(reviewing, new Map([["B", ["app:src/b.ts"]]]));
  assert.ok(nextStarts(resumeQueue(withB), 0, 14).some((e) => e.ticket.key === "B"), "a review round holds no repository until its parent is read: B starts");
});

test("A11-125: Start anyway is refused for a run that is not queued, that overlaps nothing, or that waits on a ticket", () => {
  const queued = recordPaths(resumeQueue(enqueue(emptyQueue(3), [ticket("A"), ticket("B"), ticket("C")], choice, 1)), new Map([["A", ["app:src/pool.ts"]], ["B", ["app:docs/"]], ["C", ["app:src/"]]]));
  const running = markRunning(markStarting(queued, "A", 2), "A", "w1", "w1:p1");
  assert.throws(() => startAnyway(running, "B", 5), /nothing overlaps B now, so there is no overlap to start past/, "B shares no path with A");
  const blocked = recordBlockers(running, new Map([["C", [{ key: "Z", state: "started", status: "In Progress", pulls: {} }]]]));
  assert.throws(() => startAnyway(blocked, "C", 5), /C waits on a ticket or its plan/, "C also waits on Z as a ticket, which Start anyway does not pass");
  assert.deepEqual(runActions(blocked.entries.find((e) => e.ticket.key === "C")!, undefined, blocked.entries), ["remove"], "so it is not offered");
});

test("A11-117: two queued runs in one repository start together up to the queue's limit when their source files differ, and a run that shares eslint.config.ts waits", () => {
  const scaffold = ["app:.acceptance/", "app:.changeset/"];
  const paths = (...files: string[]) => new Map([["A", [...scaffold, ...files]], ["B", [...scaffold, ...files]]]);
  const two = recordPaths(resumeQueue(enqueue(emptyQueue(2), [ticket("A"), ticket("B")], choice, 1)), new Map([["A", [...scaffold, "app:src/a.ts"]], ["B", [...scaffold, "app:src/b.ts"]]]));
  assert.deepEqual(nextStarts(two, 0, 14).map((e) => e.ticket.key), ["A", "B"], "both start at once");
  assert.deepEqual(two.entries.map((e) => waitNote(e, two.entries)), [null, null], "neither waits on the scaffolding");
  const one = recordPaths(resumeQueue(enqueue(emptyQueue(1), [ticket("A"), ticket("B")], choice, 1)), new Map([["A", [...scaffold, "app:src/a.ts"]], ["B", [...scaffold, "app:src/b.ts"]]]));
  assert.deepEqual(nextStarts(one, 0, 14).map((e) => e.ticket.key), ["A"], "the queue's limit still holds the second");
  const shared = recordPaths(resumeQueue(enqueue(emptyQueue(2), [ticket("A"), ticket("B")], choice, 1)), paths("app:eslint.config.ts"));
  assert.deepEqual(nextStarts(shared, 0, 14).map((e) => e.ticket.key), ["A"], "B shares eslint.config.ts with A, so it waits for A in this pass");
  const running = markRunning(markStarting(shared, "A", 2), "A", "w1", "w1:p1");
  assert.equal(waitNote(running.entries[1], running.entries), "Waits on A: both touch eslint.config.ts", "and the board names the shared file, not the directories");
});

test("A11-82: tickets of one batch whose plans share a path are held against each other: the earlier starts and the later waits", () => {
  const queued = resumeQueue(enqueue(emptyQueue(3), [ticket("A"), ticket("B")], choice, 1));
  const batched = { ...queued, entries: queued.entries.map((e) => ({ ...e, batch: "b1" })) };
  const queue = recordPaths(batched, new Map([["A", ["app:src/a.ts"]], ["B", ["app:src/a.ts"]]]));
  assert.deepEqual(nextStarts(queue, 0, 14).map((e) => e.ticket.key), ["A"], "a shared batch is no reason to start both");
});

test("A11-82: a queued review round holds its pull requests' paths, so a run that shares one waits for the round, which starts", () => {
  const queue = recordPaths(feedbackRound(readyToMerge({ paths: ["app:src/a.ts"] }), "A", "f", 9), new Map([["B", ["app:src/a.ts"]]]));
  assert.deepEqual(nextStarts(resumeQueue(queue), 0, 14).map((e) => e.ticket.key), ["A"], "B, queued first, waits for the round A is");
});

test("A11-82: a run whose plan is not read yet, or is planning, starts by its own rules: it is not held by a path, and a review round keeps its run's footprint", () => {
  const queue = feedbackRound(readyToMerge({ paths: ["app:src/a.ts"], plannedRepo: "app", pullFiles: { [pr.url]: ["src/b.ts"] } }), "A", "f", 9);
  assert.deepEqual([a(queue).paths, a(queue).plannedRepo, a(queue).pullFiles], [["app:src/a.ts"], "app", { [pr.url]: ["src/b.ts"] }], "the round carries the footprint");
  const retried = retry(endedWith({ kind: "needs-human", reason: "x" }, { review: [pr], paths: ["app:src/a.ts"] }), "A", 9);
  assert.deepEqual(a(retried).paths, ["app:src/a.ts"], "a retried review round keeps its paths");
  const plain = retry(endedWith({ kind: "needs-human", reason: "x" }, { paths: ["app:src/a.ts"] }), "A", 9);
  assert.equal(a(plain).paths, undefined, "a retried run reads its plan again");
  assert.equal(pathsUnread(a(plain)), true);
  assert.equal(pathsUnread({ ...a(plain), plan: { model: "opus", effort: "max" } }), false, "a planning run has no paths to read");
  assert.equal(pathsUnread({ ...a(plain), review: [pr] }), false, "a review round keeps its run's paths");
});

test("A11-82: paths are recorded on queued runs only, and the files of a pull request on finished runs only", () => {
  const queued = recordPaths(enqueue(emptyQueue(2), [ticket("A"), ticket("B")], choice, 1), new Map([["A", ["app:a.ts"]], ["B", []]]));
  assert.deepEqual(queued.entries.map((e) => e.paths), [["app:a.ts"], []], "an empty list is a plan read with no paths");
  assert.deepEqual(unreadPaths(queued), [], "both are read");
  const started = recordPaths(markStarting(queued, "A", 2), new Map([["A", ["app:other.ts"]]]));
  assert.deepEqual(a(started).paths, ["app:a.ts"], "a started run keeps what it started with");
  const finished = recordPullFiles(endedWith({ kind: "draft-pr", prs: [pr] }), "A", { [pr.url]: ["src/c.ts"] });
  assert.deepEqual(a(finished).pullFiles, { [pr.url]: ["src/c.ts"] });
  assert.equal(recordPullFiles(queuedA(), "A", { [pr.url]: ["x"] }).entries[0].pullFiles, undefined, "a queued run has no pull request to read");
});

test("a verdict that is not on a finished run's pull request is recorded on the run, and cleared once a review is on it", () => {
  const pr = { repo: "nbl-ui-netbox", url: "https://github.com/x/nbl-ui-netbox/pull/1" };
  const finished = endedWith({ kind: "draft-pr", prs: [pr] });
  const said = recordVerdictNotPosted(finished, "A", "verdict not posted: the reviewer ended without writing a verdict file");
  assert.equal(a(said).verdictNotPosted, "verdict not posted: the reviewer ended without writing a verdict file");
  const cleared = recordVerdictNotPosted(said, "A", undefined);
  assert.equal("verdictNotPosted" in a(cleared), false, "cleared: the key is gone, not left undefined");
  assert.deepEqual(a(cleared), a(finished), "and the run is otherwise as it was");
  const queued = queuedA();
  assert.equal("verdictNotPosted" in recordVerdictNotPosted(queued, "A", "x").entries[0], false, "a queued run has no pull request to say of");
});

test("A11-106: what a finished run's stacked pull requests need said of their bases is recorded on the run, and cleared once none needs it", () => {
  const pr = { repo: "agent-org", url: "https://github.com/a11ign/agent-org/pull/1749" };
  const finished = endedWith({ kind: "draft-pr", prs: [pr] });
  const note = { [pr.url]: "Needs retarget: x still targets nbf-1-fit, whose branch is gone: retarget it by hand" };
  const said = recordRetargets(finished, "A", note);
  assert.deepEqual(a(said).retargets, note);
  const cleared = recordRetargets(said, "A", undefined);
  assert.equal("retargets" in a(cleared), false, "cleared: the key is gone, not left undefined");
  assert.deepEqual(a(cleared), a(finished), "and the run is otherwise as it was");
  assert.equal("retargets" in recordRetargets(queuedA(), "A", note).entries[0], false, "a queued run has no pull request to say of");
});

/*
 * Writer runs (A11-94): a new-ticket request is its own record, holds a worker slot only while it runs, and keeps its drafts until each is settled.
 */

const request = { id: "w1", request: "Show the requests a person made", mode: "quick" as const, placement: "auto" as const, form: {} };
/** A ticket the run filed, as the board holds it once the tracker has read it back (A11-135). */
const filed = (key: string) => ({ key, url: `https://linear.app/x/${key}`, inPick: true });

test("a writer run is queued, starts on a free slot, and holds one while it runs and while it starts", () => {
  let queue = queueWriter(emptyQueue(1), request, 1);
  assert.equal(writerToStart(queue)?.id, "w1");
  queue = markWriterStarting(queue, "w1", 2);
  assert.equal(writerToStart(queue), undefined, "its slot is held while it starts");
  assert.equal(liveRunCount(queue), 1);
  queue = markWriterRunning(queue, "w1", "ws", "p");
  assert.equal(writerStatus(writerOf(queue, "w1")!), "writing");
  queue = writerEnded(queue, "w1", { tickets: [filed("NBF-1")] }, 4);
  assert.equal(liveRunCount(queue), 0, "a run that has ended holds no slot");
  assert.equal(writerStatus(writerOf(queue, "w1")!), "done");
  assert.deepEqual(writerOf(queue, "w1")?.tickets, [filed("NBF-1")]);
});

test("A11-199: a writer run records the placement it is queued with", () => {
  const manual = queueWriter(emptyQueue(1), { ...request, placement: "manual", form: { priority: "low" } }, 1);
  assert.deepEqual([writerOf(manual, "w1")?.placement, writerOf(manual, "w1")?.form], ["manual", { priority: "low" }]);
});

test("a writer run records the model and effort it is queued with, and a run queued without them records none", () => {
  const queue = queueWriter(emptyQueue(1), { ...request, model: "sonnet", effort: "max" }, 1);
  assert.deepEqual([writerOf(queue, "w1")?.model, writerOf(queue, "w1")?.effort], ["sonnet", "max"]);
  assert.equal(writerOf(queueWriter(emptyQueue(1), request, 1), "w1")?.model, undefined, "a run queued before the choice was stamped has none, so it starts on the host file's");
});

test("A11-129: a grill run whose agent ends its turn on a question is Waiting, with the question and when the wait began; the same question is no change, and the answer resumes it", () => {
  const grill = { ...request, mode: "grill" as const };
  let queue = markWriterRunning(markWriterStarting(queueWriter(emptyQueue(1), grill, 1), "w1", 2), "w1", "ws", "p");
  queue = writerWaiting(queue, "w1", "Q1: editable or read-only?", 10);
  assert.deepEqual([writerStatus(writerOf(queue, "w1")!), writerOf(queue, "w1")?.waiting], ["waiting", { question: "Q1: editable or read-only?", since: 10 }]);
  assert.equal(liveRunCount(queue), 1, "it holds its slot while the person answers");
  assert.deepEqual(writerWaiting(queue, "w1", "Q1: editable or read-only?", 99), queue, "the same question keeps its time, so the board is not rewritten each pass");
  queue = writerWaiting(queue, "w1", "Q2: which goal?", 20);
  assert.deepEqual(writerOf(queue, "w1")?.waiting, { question: "Q2: which goal?", since: 20 }, "a new question starts a new wait");
  queue = writerResumed(queue, "w1", 30);
  assert.equal(writerOf(queue, "w1")?.waiting, undefined, "the answer clears the wait");
  assert.equal(writerOf(queue, "w1")?.startedAt, 30, "and the working clock starts again from it");
  assert.equal(writerStatus(writerOf(queue, "w1")!), "writing");
  assert.deepEqual(writerResumed(queue, "w1", 40), queue, "a run that is not waiting is unchanged");
});

test("A11-129: a waiting run that fails or files its tickets is no longer waiting, and the run's terminal is kept on the record", () => {
  const waiting = writerWaiting(markWriterRunning(markWriterStarting(queueWriter(emptyQueue(1), { ...request, mode: "grill" as const }, 1), "w1", 2), "w1", "ws", "p"), "w1", "a question", 3);
  const failed = writerOf(writerFailed(waiting, "w1", "nobody answered its question for 4 hours", 4), "w1")!;
  assert.deepEqual([writerStatus(failed), failed.waiting, failed.workspace, failed.pane], ["failed", undefined, "ws", "p"], "a failed run keeps its workspace on the record");
  const done = writerOf(writerEnded(waiting, "w1", { tickets: [filed("NBF-2")] }, 4), "w1")!;
  assert.equal(done.waiting, undefined, "a run that filed its tickets has its answer, and no question");
});

test("A11-129: a run that ends keeps the terminal it was in once its workspace and pane are cleared, so a link to that terminal can say it ended", () => {
  const started = markRunning(markStarting(enqueue(emptyQueue(3), [ticket("A")], choice, 1), "A", 2), "A", "w1", "w1:p1");
  const ended = finish(started, "A", { kind: "done", reason: "shipped", evidence: [] }, 5).entries[0];
  assert.deepEqual([ended.workspace, ended.pane, ended.lastTerminal], [undefined, undefined, { workspace: "w1", pane: "w1:p1" }]);
  const parked = unpark(park(started, "A", { kind: "needs-human", reason: "a question" }, 5), "A").entries[0];
  assert.deepEqual(parked.lastTerminal, { workspace: "w1", pane: "w1:p1" }, "a parked run that is unparked keeps it too");
});

test("a writer run waits for a worker slot as a ticket does, and is not held by Pause", () => {
  let queue = pauseQueue(emptyQueue(1));
  queue = queueWriter(queue, request, 1);
  assert.equal(writerToStart(queue)?.id, "w1", "a person asked for it: Pause does not hold it");
  queue = queueWriter(queue, { ...request, id: "w2" }, 2);
  queue = markWriterStarting(queue, "w1", 3);
  assert.equal(writerToStart(queue), undefined, "one slot, held by the first");
});

test("at most three writer runs are unfinished at once, and a fourth is refused naming why", () => {
  let queue = emptyQueue(3);
  for (const id of ["a", "b", "c"]) queue = queueWriter(queue, { ...request, id }, 1);
  assert.throws(() => queueWriter(queue, { ...request, id: "d" }, 2), /3 new-ticket requests are unfinished already/);
  queue = writerFailed(queue, "a", "stopped", 3);
  assert.equal(queueWriter(queue, { ...request, id: "d" }, 4).writers?.length, 4, "a finished one does not count");
});

test("a grill run is running while it waits on the person between its questions: it holds its slot, and is not queued again", () => {
  let queue = markWriterRunning(markWriterStarting(queueWriter(emptyQueue(1), { ...request, mode: "grill" }, 1), "w1", 2), "w1", "ws", "p");
  assert.equal(writerOf(queue, "w1")?.phase, "running");
  assert.equal(writerStatus(writerOf(queue, "w1")!), "writing");
  assert.equal(liveRunCount(queue), 1, "a grill run holds its slot while the person answers");
  assert.equal(writerToStart(queue), undefined, "a running run is not queued again");
});

test("a run that files no ticket and fails says why, and keeps any ticket it made before it stopped", () => {
  const running = markWriterRunning(markWriterStarting(queueWriter(emptyQueue(1), request, 1), "w1", 2), "w1", "ws", "p");
  const stopped = writerEnded(running, "w1", { tickets: [filed("NBF-4")], failure: "its attachment was refused (500)" }, 3);
  assert.deepEqual([writerStatus(writerOf(stopped, "w1")!), writerOf(stopped, "w1")?.failure], ["failed", "its attachment was refused (500)"]);
  assert.deepEqual(writerOf(stopped, "w1")?.tickets, [filed("NBF-4")], "the ticket stays made, and is shown with the failure");
  assert.equal(writerOf(writerEnded(running, "w1", { tickets: [] }, 3), "w1")?.failure, undefined, "a run that ends with no failure is done");
});

test("a stopped run keeps the tickets it made, and a finished run dismisses once, while one still under way must be stopped first", () => {
  let queue = markWriterRunning(markWriterStarting(queueWriter(emptyQueue(1), request, 1), "w1", 2), "w1", "ws", "p");
  assert.throws(() => dismissWriter(queue, "w1"), /stop the new-ticket request before you dismiss it/);
  queue = stopWriter(queue, "w1", 4);
  assert.equal(writerOf(queue, "w1")?.failure, "stopped on the board");
  queue = stopWriter(queue, "w1", 5);
  assert.equal(writerOf(queue, "w1")?.finishedAt, 4, "a finished run is not changed by a stop");
  queue = dismissWriter(queue, "w1");
  assert.deepEqual(queue.writers, []);
});

test("dismissFinishedWriters removes every finished new-ticket request in one step and leaves runs under way and the board's check runs", () => {
  let queue = emptyQueue(3);
  for (const id of ["w1", "w2", "w3"]) queue = queueWriter(queue, { ...request, id }, 1);
  queue = writerEnded(queue, "w1", { tickets: [filed("NBF-4")] }, 2);
  queue = writerFailed(queue, "w2", "no team", 3);
  const cleared = dismissFinishedWriters(queue);
  assert.deepEqual(cleared.writers?.map((run) => [run.id, run.phase]), [["w3", "queued"]], "a queued run stays; both finished ones, Done and Failed, go");
  assert.equal(dismissFinishedWriters(cleared).writers?.length, 1, "nothing finished: nothing changes");
  assert.deepEqual(dismissFinishedWriters(queue, ["w2"]).writers?.map((run) => run.id), ["w1", "w3"], "only the finished runs named go: w1 is finished and not named, w3 is under way");
  assert.deepEqual(dismissFinishedWriters(queue, ["w3"]).writers?.map((run) => run.id), ["w1", "w2", "w3"], "a run under way is not dismissed even when it is named");
  assert.deepEqual(dismissFinishedWriters(queue, []).writers?.map((run) => run.id), ["w1", "w2", "w3"], "no ids named, none go");
  const check = writerEnded(queueWriter(emptyQueue(1), { ...request, id: "c1", mode: "verify" as never }, 1), "c1", { tickets: [] }, 2);
  assert.deepEqual(dismissFinishedWriters(check).writers?.map((run) => run.id), ["c1"], "a check run of the board is not a notification");
});

test("a writer run round-trips through the queue file with the tickets it filed", () => {
  const path = join(tmpDir("ticket-queue-writers-"), "queue.json");
  const queue = writerEnded(markWriterRunning(markWriterStarting(queueWriter(emptyQueue(2), request, 1), "w1", 2), "w1", "ws", "p"), "w1",
    { tickets: [filed("NBF-1")], failure: "its plan is not attached" }, 3);
  saveQueue(path, queue);
  const loaded = loadQueue(path, 2);
  assert.deepEqual(loaded.writers?.[0].tickets, [filed("NBF-1")]);
  assert.equal(loaded.writers?.[0].failure, "its plan is not attached");
  assert.equal(loadQueue(join(tmpDir("ticket-queue-old-"), "queue.json"), 2).writers, undefined, "a file from before writer runs loads with none");
});

test("a run an older board left for review is failed, and an older grill run waiting is running again; a run an older board was filing is failed to check the tracker", () => {
  const path = join(tmpDir("ticket-queue-legacy-"), "queue.json");
  const draft = (file: string, status: string, created?: { key: string; url: string; inPick?: boolean }) => ({ id: `d-${file}`, file, status, created,
    draft: { title: file, why: "w", doneWhen: ["d"], notes: null, team: null, project: null, repo: null, goal: null, labels: [], priority: "none", parent: null,
      blocks: [], blockedBy: [], duplicates: [] }, duplicates: [] });
  const old = { entries: [], max: 1, paused: true, writers: [
    { ...request, phase: "finished", queuedAt: 1, finishedAt: 5, drafts: [draft("01-a.json", "pending")], rejected: [] },
    { ...request, id: "w2", phase: "waiting", question: "Which goal?", queuedAt: 1, startedAt: 1, drafts: [], rejected: [] },
    { ...request, id: "w3", phase: "creating", queuedAt: 1, startedAt: 1, drafts: [draft("01-c.json", "created", { key: "NBF-7", url: "u" }), draft("02-d.json", "creating")], rejected: [] },
  ] };
  writeFileSync(path, JSON.stringify(old));
  const loaded = loadQueue(path, 1);
  assert.equal(writerOf(loaded, "w1")?.failure, LEGACY_REVIEW_FAILURE);
  assert.equal(writerStatus(writerOf(loaded, "w1")!), "failed");
  assert.deepEqual(writerOf(loaded, "w1")?.tickets, [], "no ticket is made from a draft left for review");
  assert.equal(writerOf(loaded, "w2")?.phase, "running", "its agent is still in its terminal");
  assert.equal(writerOf(loaded, "w2")?.startedAt, undefined, "and its clock starts again: a grill limit counts from the resume, not from an hours-old start");
  assert.equal(writerOf(loaded, "w3")?.failure, LEGACY_CREATING_FAILURE);
  assert.deepEqual(writerOf(loaded, "w3")?.tickets, [{ key: "NBF-7", url: "u", inPick: true }], "a ticket an older board made is kept, as made, and an absent flag meant in Pick");
});

test("A11-199: a writer run stored before placement existed is read with the placement its form implies, and one that names its placement keeps it", () => {
  const path = join(tmpDir("ticket-queue-placement-"), "queue.json");
  const { placement: _placed, ...bare } = request;
  const stored = (id: string, form: object, placement?: string) => ({ ...bare, id, phase: "queued", queuedAt: 1, form, tickets: [], ...(placement === undefined ? {} : { placement }) });
  writeFileSync(path, JSON.stringify({ entries: [], max: 1, paused: true, writers: [stored("w1", {}), stored("w2", { priority: "high" }), stored("w3", { repo: "a" }, "auto"), stored("w4", {}, "manual")] }));
  const loaded = loadQueue(path, 1);
  assert.deepEqual(["w1", "w2", "w3", "w4"].map((id) => writerOf(loaded, id)?.placement), ["auto", "manual", "auto", "manual"],
    "a run with no placement is auto without choices and manual with them; a stored placement is kept");
});

test("a legacy run that was creating its tickets, with every draft made, ends done: no ticket is left to make (A11-135)", () => {
  const path = join(tmpDir("ticket-queue-legacy-done-"), "queue.json");
  const made = { id: "d-a", file: "01-a.json", status: "created", created: { key: "NBF-8", url: "u" },
    draft: { title: "a", why: "w", doneWhen: ["d"], notes: null, team: null, project: null, repo: null, goal: null, labels: [], priority: "none", parent: null,
      blocks: [], blockedBy: [], duplicates: [] }, duplicates: [] };
  writeFileSync(path, JSON.stringify({ entries: [], max: 1, paused: true, writers: [{ ...request, phase: "creating", queuedAt: 1, startedAt: 1, drafts: [made], rejected: [] }] }));
  const loaded = writerOf(loadQueue(path, 1), "w1");
  assert.deepEqual([loaded?.phase, loaded?.failure, loaded?.tickets.map(({ key }) => key)], ["finished", undefined, ["NBF-8"]]);
});


test("A11-257: the queue holds a ticket with an open decision or an ungrilled screen like any other: its planner settles it", () => {
  const open = { ...ticket("A"), description: "## Acceptance\n\n- Decide whether the list sorts.\n" };
  assert.deepEqual(keys(enqueue(emptyQueue(2), [open], choice, 1)), ["A"]);
  assert.deepEqual(keys(enqueue(emptyQueue(2), [{ ...ticket("B"), description: "**Screen:** yes\n" }], choice, 1)), ["B"]);
});

const ANSWERED = { [pr.url]: { head: "h1", step: "round" as const } };

test("A11-154: a round started on red checks records the head it answers, and the round, its end and a retried round all carry it", () => {
  const queue = feedbackRound(readyToMerge(), "A", "test failed on the head commit", 9, ANSWERED);
  assert.deepEqual([a(queue).phase, a(queue).rounds, a(queue).checkHeads], ["queued", 1, ANSWERED]);
  const running = markRunning(markStarting(queue, "A", 10), "A", "w2", "w2:p1");
  const ended = finish(running, "A", { kind: "reviewed", prs: [pr] }, 11);
  assert.deepEqual(a(ended).checkHeads, ANSWERED, "a head that stays red after its round is not answered twice");
  const crashed = finish(running, "A", { kind: "crashed", reason: "x" }, 11);
  assert.deepEqual(a(retry(crashed, "A", 12)).checkHeads, ANSWERED, "a retried round still knows the head");
  assert.deepEqual(a(respond(ended, "A", 12)).checkHeads, ANSWERED, "so does the round a person asks for");
  assert.equal(a(feedbackRound(readyToMerge(), "A", "review feedback", 9)).checkHeads, undefined, "a round that answers no check records none");
});

test("A11-154: red checks wake a run that ended needs-human, crashed or with no outcome, as they wake a run Ready to merge, and no other", () => {
  const open = { review: [pr], pullStates: { [pr.url]: "open" } };
  for (const outcome of [{ kind: "needs-human", reason: "which colour?" }, { kind: "crashed", reason: "x" }, { kind: "no-outcome" }, { kind: "wrong-repo", where: "a11ign/control" }] as const) {
    const queue = checkRound(endedWith(outcome, open), "A", "test failed on the head commit", 9, ANSWERED);
    assert.deepEqual([a(queue).phase, a(queue).rounds, a(queue).feedback, a(queue).checkHeads, a(queue).session], ["queued", 1, "test failed on the head commit", ANSWERED, "s1"], outcome.kind);
  }
  const parked = checkRound(parkedOn({ kind: "needs-human", reason: "which colour?" }), "A", "test failed on the head commit", 9, ANSWERED);
  assert.deepEqual([a(parked).phase, a(parked).workspace], ["queued", undefined], "a parked run's round holds no workspace (the pool closed it)");
  for (const [why, queue] of [
    ["stopped", endedWith({ kind: "stopped" }, open)], ["checked", endedWith({ kind: "checked", reason: "nothing to do" }, open)], ["a draft", endedWith({ kind: "draft-pr", prs: [pr] }, open)],
    ["merged", endedWith({ kind: "needs-human", reason: "x" }, { review: [pr], pullStates: { [pr.url]: "merged" } })],
    ["completed in the tracker", endedWith({ kind: "needs-human", reason: "x" }, { ...open, trackerState: "completed" })], ["live", markRunning(markStarting(enqueue(emptyQueue(3), [ticket("A")], choice, 1), "A", 2), "A", "w1", "w1:p1")],
  ] as const) assert.deepEqual(checkRound(queue, "A", "f", 9, ANSWERED), queue, why);
});

test("A11-154: at the cap on the board's own rounds, red checks hand a run of any outcome to a person, who answers with Respond to review", () => {
  const open = { review: [pr], pullStates: { [pr.url]: "open" }, rounds: MAX_FEEDBACK_ROUNDS };
  for (const outcome of [{ kind: "needs-human", reason: "x" }, { kind: "crashed", reason: "x" }, { kind: "ready-pr", prs: [pr] }] as const) {
    const handed = checkRound(endedWith(outcome, open), "A", "test failed on the head commit", 9, ANSWERED);
    assert.deepEqual([a(handed).phase, a(handed).rounds, a(handed).checkHeads], ["finished", MAX_FEEDBACK_ROUNDS, ANSWERED], `${outcome.kind}: no round, and the head is answered`);
    assert.match(a(handed).handedBack ?? "", /board answered 3 rounds on its own and stopped\. Respond to review starts another\. The latest: test failed on the head commit/, outcome.kind);
    assert.equal(runStatus(a(handed)), "needs-you", `${outcome.kind}: reads Needs you`);
    const asked = a(respond(handed, "A", 10));
    assert.deepEqual([asked.phase, asked.rounds, asked.handedBack, asked.asked], ["queued", undefined, undefined, true], `${outcome.kind}: Respond starts the count again`);
  }
  assert.equal(a(conflictRound(endedWith({ kind: "needs-human", reason: "x" }, open), "A", "a conflict line", 9)).handedBack, undefined, "a conflict alone still hands nothing back");
});

test("A11-154: what a rerun or a name for a person records is kept for the finished run only", () => {
  const heads = { [pr.url]: { head: "h1", step: "rerun" as const, note: "Reran test on h1: a runner was lost" } };
  assert.deepEqual(a(recordCheckHeads(readyToMerge(), "A", heads)).checkHeads, heads);
  const running = markRunning(markStarting(enqueue(emptyQueue(3), [ticket("A")], choice, 1), "A", 2), "A", "w1", "w1:p1");
  assert.deepEqual(recordCheckHeads(running, "A", heads), running, "a run that is not finished records none");
});

test("A11-154: a queued round a working Talk session holds back is not started and holds no slot, and is started once the hold is lifted", () => {
  const round = respond(readyToMerge(), "A", 9);
  const resumed = resumeQueue(round);
  assert.ok(nextStarts(resumed, 1, 8).some((e) => e.ticket.key === "A"), "POSITIVE CONTROL: with no hold it starts");
  const held = holdForSession(resumed, "A", "Waits for the Talk session in w3 to end");
  assert.equal(a(held).sessionWait, "Waits for the Talk session in w3 to end");
  assert.ok(!nextStarts(held, 1, 8).some((e) => e.ticket.key === "A"), "it waits");
  const ahead = (queue: Queue): Queue => ({ ...queue, max: 1, entries: [a(queue), ...queue.entries.filter((e) => e.ticket.key !== "A")] });
  assert.deepEqual(nextStarts(ahead(resumed), 1, 8).map((e) => e.ticket.key), ["A"], "POSITIVE CONTROL: first in the queue and free, it takes the one slot");
  assert.deepEqual(nextStarts(ahead(held), 1, 8).map((e) => e.ticket.key), ["B"], "held, it takes no slot another run could use");
  const released = holdForSession(held, "A", undefined);
  assert.equal(a(released).sessionWait, undefined);
  assert.ok(nextStarts(released, 1, 8).some((e) => e.ticket.key === "A"), "and starts once the hold is lifted");
  const closed = holdForSession(released, "A", undefined, "Closed the Talk session in w3 before this round");
  assert.equal(a(closed).sessionNote, "Closed the Talk session in w3 before this round");
  assert.equal(a(holdForSession(closed, "A", undefined)).sessionNote, "Closed the Talk session in w3 before this round", "a pass that closes nothing keeps what an earlier one said");
  const started = markStarting(holdForSession(resumed, "A", "Waits for the Talk session in w3 to end"), "A", 30);
  assert.deepEqual([a(started).sessionWait, a(started).phase], [undefined, "starting"], "a run that starts holds no wait");
  const ended = finish(markRunning(markStarting(closed, "A", 30), "A", "w4", "w4:p1"), "A", { kind: "reviewed", prs: [pr] }, 31);
  assert.equal(a(ended).sessionNote, undefined, "the note is the round's, and goes when it ends");
  const finished = readyToMerge();
  assert.deepEqual(holdForSession(finished, "A", "x"), finished, "a run that is not queued is left alone");
});

test("A11-154: a hand-back goes when the run is answered in its terminal and ends again, and Respond is refused on a run that concluded or was stopped", () => {
  const handed = checkRound(parkedOn({ kind: "needs-human", reason: "which colour?" }, { rounds: MAX_FEEDBACK_ROUNDS }), "A", "test failed", 9, ANSWERED);
  assert.match(a(handed).handedBack ?? "", /keep getting feedback/);
  const resumed = markResumed(handed, "A");
  assert.deepEqual([a(resumed).phase, a(resumed).handedBack], ["running", undefined], "the person answered the agent: the hand-back is spent");
  const ended = finish(resumed, "A", { kind: "ready-pr", prs: [pr] }, 20);
  assert.deepEqual([a(ended).handedBack, runStatus(a(ended))], [undefined, "awaiting-review"], "so the run reads what it ended on");
  const open = { review: [pr], pullStates: { [pr.url]: "open" } };
  assert.throws(() => respond(endedWith({ kind: "checked", reason: "nothing to do" }, open), "A", 9), /A concluded \(checked\): there is nothing for a worker to answer/);
  assert.throws(() => respond(endedWith({ kind: "stopped" }, open), "A", 9), /A was stopped/);
});

const PR_1 = "https://github.com/a11ign/agent-org/pull/1811";
const PR_2 = "https://github.com/a11ign/agent-org/pull/1812";
/** Ticket A, planned and run: a worker on a session ended on a partial pull request that merged, with its plan paths, a state move and an earlier step. */
const mergedPartial = (partial: string, over: Partial<Queue["entries"][number]> = {}) => {
  let queue = finish(markRunning(markStarting(enqueue(emptyQueue(1), [ticket("A")], choice, 0), "A", 1), "A", "w1", "w1:p1"), "A", { kind: "ready-pr", prs: [{ repo: "agent-org", url: PR_1 }], partial }, 9);
  queue = recordPullStates(recordMove(queue, "A", { from: "Todo", to: "In Progress" }), new Map([["A", { [PR_1]: "merged" as const }]]));
  // The merged pull request's body was read and declared nothing that overrules the outcome (A11-181): the run's partial is acted on as the worker wrote it.
  return { ...queue, entries: queue.entries.map((e) => ({ ...e, session: "session-1", planned: true, paths: ["agent-org:src/a.ts"], plannedRepo: "agent-org", projectRepo: "agent-org", declared: { kind: "none" as const, urls: [PR_1] }, ...over })) };
};

test("A11-168: queueNextStep appends the merged step and its pull requests, and drops partial, session, outcome, pull states and movedFrom", () => {
  const finished = mergedPartial("step 1 of 2: the rest");
  const [next] = queueNextStep(finished, "A", { step: 1, of: 2, prs: [PR_1] }, 50).entries;
  assert.deepEqual(next.steps, [{ step: 1, of: 2, prs: [PR_1] }]);
  assert.deepEqual([next.phase, next.queuedAt, next.ticket.key, next.model, next.effort, next.planned, next.paths, next.plannedRepo, next.projectRepo],
    ["queued", 50, "A", "opus", "high", true, ["agent-org:src/a.ts"], "agent-org", "agent-org"], "the ticket, model, effort, plan paths and repositories are kept");
  for (const dropped of ["session", "outcome", "partial", "pullStates", "movedFrom", "plan", "review", "trackerState", "finishedAt", "startedAt", "workspace"] as const) assert.equal(next[dropped], undefined, dropped);
  const [second] = queueNextStep(mergedPartial("step 2 of 3", { steps: next.steps }), "A", { step: 2, of: 3, prs: [PR_2] }, 60).entries;
  assert.deepEqual(second.steps?.map(({ step }) => step), [1, 2], "a later step is appended after the earlier one");
});

// A11-175: the paths each step section of the plan lists are recorded with the plan's paths, and travel with them to the next step and through a round.
const STEP_PATHS = { "1": ["agent-org:src/a.ts"], "2": ["agent-org:src/b/"] };

test("A11-175: recordPaths records the step sections' paths beside the plan's, replaces them when the plan is read again, and leaves a run that has started as it is", () => {
  const queued = resumeQueue(enqueue(emptyQueue(2), [ticket("A"), ticket("B")], choice, 1));
  const read = recordPaths(queued, new Map([["A", ["agent-org:src/a.ts", "agent-org:src/b/"]], ["B", ["agent-org:src/"]]]), new Map<string, Record<string, readonly string[]>>([["A", STEP_PATHS], ["B", {}]]));
  assert.deepEqual(read.entries.map((entry) => [entry.paths, entry.stepPaths]), [[["agent-org:src/a.ts", "agent-org:src/b/"], STEP_PATHS], [["agent-org:src/"], undefined]], "a plan whose steps list no paths records none");
  const again = recordPaths(read, new Map([["A", ["agent-org:src/a.ts"]]]), new Map());
  assert.equal(again.entries[0].stepPaths, undefined, "a plan read again that has none drops what was recorded");
  assert.deepEqual(recordPaths(queued, new Map([["A", ["agent-org:src/a.ts"]]])).entries[0].stepPaths, undefined, "and callers that read no step sections record none");
  const started = markStarting(read, "A", 5);
  assert.deepEqual(recordPaths(started, new Map([["A", ["agent-org:x/"]]]), new Map([["A", { "1": ["agent-org:x/"] }]])).entries.find((entry) => entry.ticket.key === "A")?.stepPaths, STEP_PATHS, "a run that has started keeps what it started with");
});

test("A11-175: a queued run whose plan is written again drops the paths of its steps with the plan's paths", () => {
  const queued = recordPaths(resumeQueue(enqueue(emptyQueue(1), [ticket("A")], choice, 1)), new Map([["A", ["agent-org:src/a.ts"]]]), new Map([["A", STEP_PATHS]]));
  assert.deepEqual(queued.entries[0].stepPaths, STEP_PATHS);
  const [again] = replan(queued, "A", { model: "opus", effort: "max" }, [], undefined).entries;
  assert.deepEqual([again.paths, again.stepPaths], [undefined, undefined]);
});

test("A11-175: the next step's run carries the step sections' paths with the plan's, and so does a review round, a talk session and a retried review", () => {
  const finished = mergedPartial("step 1 of 2: the rest", { stepPaths: STEP_PATHS });
  const [next] = queueNextStep(finished, "A", { step: 1, of: 2, prs: [PR_1] }, 50).entries;
  assert.deepEqual(next.stepPaths, STEP_PATHS, "the next step is queued with every step's paths, and reads its own from them");
  assert.deepEqual(queueNextStep(mergedPartial("step 1 of 2"), "A", { step: 1, of: 2, prs: [PR_1] }, 50).entries[0].stepPaths, undefined, "a plan with none carries none");
  const asked = finish(markRunning(markStarting({ ...emptyQueue(1), entries: [next] }, "A", 51), "A", "w1", "w1:p1"), "A", { kind: "draft-pr", prs: [{ repo: "agent-org", url: PR_2 }], partial: "step 2 of 2" }, 70);
  const withSession = { ...asked, entries: [{ ...asked.entries[0], session: "s-2" }] };
  assert.deepEqual(approve(withSession, "A", 80).entries[0].stepPaths, STEP_PATHS, "a review round carries them");
  assert.deepEqual(talk(withSession, "A", 90).entries[0].stepPaths, STEP_PATHS, "a talk session carries them");
  const reviewing = { ...withSession, entries: [{ ...approve(withSession, "A", 80).entries[0], phase: "finished" as const, outcome: { kind: "crashed", reason: "boom" } as Outcome }] };
  assert.deepEqual(retry(reviewing, "A", 100).entries[0].stepPaths, STEP_PATHS, "a retried review round keeps them");
});

test("A11-168: a queued next step keeps its steps through a review round, a talk session and a retry, so each knows which step it is", () => {
  const [next] = queueNextStep(mergedPartial("step 1 of 3"), "A", { step: 1, of: 3, prs: [PR_1] }, 50).entries;
  const crashed = finish(markRunning(markStarting({ ...emptyQueue(1), entries: [next] }, "A", 51), "A", "w1", "w1:p1"), "A", { kind: "crashed", reason: "boom" }, 52);
  assert.deepEqual(retry(crashed, "A", 60).entries[0].steps, next.steps, "a retried step is still that step");
  const asked = finish({ ...crashed, entries: [{ ...crashed.entries[0], session: "s-2" }] }, "A", { kind: "draft-pr", prs: [{ repo: "agent-org", url: PR_2 }], partial: "step 2 of 3" }, 70);
  assert.deepEqual(approve(asked, "A", 80).entries[0].steps, next.steps, "a review round carries them");
});

test("A11-168: a finished run whose partial pull request merged is due its next step, paired with the step it finished and the pull requests that merged", () => {
  const due = nextStepRuns(mergedPartial("step 1 of 9 of the plan"));
  assert.deepEqual(due.map(({ entry, step }) => [entry.ticket.key, step]), [["A", { step: 1, of: 9, prs: [PR_1] }]]);
  const queue = queueNextStep(mergedPartial("step 1 of 9 of the plan"), "A", due[0].step, 70);
  assert.deepEqual(queue.entries.map((e) => [e.phase, e.steps?.length]), [["queued", 1]]);
  assert.deepEqual(nextStepRuns(queue), [], "a queued run is not due again");
});

test("A11-168: no next step is due for a run with no declaration, an unmerged or closed pull request, a settled ticket, a parked workspace, or a declaration that moves nowhere", () => {
  assert.deepEqual(nextStepRuns(mergedPartial("step 1 of 9", { partial: undefined })), [], "no declaration: the pull request completes the ticket");
  assert.deepEqual(nextStepRuns(recordPullStates(mergedPartial("step 1 of 9"), new Map([["A", { [PR_1]: "open" as const }]]))), [], "still open");
  assert.deepEqual(nextStepRuns(recordPullStates(mergedPartial("step 1 of 9"), new Map([["A", { [PR_1]: "closed" as const }]]))), [], "closed unmerged");
  assert.deepEqual(nextStepRuns(mergedPartial("step 1 of 9", { trackerState: "completed" })), [], "the tracker finished the ticket");
  assert.deepEqual(nextStepRuns(mergedPartial("step 1 of 9", { workspace: "w1", pane: "w1:p1" })), [], "its workspace is still open");
  for (const partial of ["the settings page", "step 9 of 9", "step 1 of 9"]) {
    const steps = partial === "step 1 of 9" ? [{ step: 1, of: 9, prs: [PR_2] }] : undefined;
    assert.deepEqual(nextStepRuns(mergedPartial(partial, { steps })), [], partial);
  }
});

test("A11-181: no next step is due, and no plan is counted, for a partial run whose merged bodies the board has not read yet", () => {
  assert.deepEqual(nextStepRuns(mergedPartial("step 1 of 9", { declared: undefined })), [], "the outcome's words are not acted on before the pull request's are read");
  assert.deepEqual(planStepsUnread(mergedPartial("the identity work", { declared: undefined })), []);
  assert.equal(nextStepRuns(mergedPartial("step 1 of 9")).length, 1, "and once read, it is due");
});

test("A11-168: a merged partial run is not Completed: it needs a person while nothing is queued for it, and a queued entry is untouched by queueNextStep unless finished", () => {
  const [entry] = mergedPartial("the settings page").entries;
  assert.equal(runStatus(entry), "needs-you");
  assert.equal(runStatus({ ...entry, partial: undefined }), "completed", "a pull request with no declaration still completes the run");
  const queued = queueNextStep(queuedA(), "A", { step: 1, of: 2, prs: [PR_1] }, 5);
  assert.deepEqual(queued.entries.map((e) => e.steps), [undefined]);
});

test("A11-167: a stale plan written again leaves the run what it had: the record of its move, its merged steps and the overlap it was started past, and the choice it was planned with", () => {
  const move = { from: "Todo", to: "In Progress" };
  const steps = [{ step: 1, of: 2, prs: [] }];
  const overlap = { holder: "B", pull: null, path: "src/a.ts", at: 5 };
  let queue = markStarting(enqueue(emptyQueue(1), [ticket("A")], choice, 0), "A", 1);
  queue = { ...queue, entries: queue.entries.map((e) => ({ ...e, movedFrom: move, steps, overlapOverride: overlap, plan: { model: "opus", effort: "max" } })) };
  const [planned] = planDone(queue, "A").entries;
  assert.deepEqual([planned.movedFrom, planned.steps, planned.overlapOverride, planned.plannedWith], [move, steps, overlap, { model: "opus", effort: "max" }]);
  const { movedFrom: _m, steps: _s, overlapOverride: _o, plan: _p, ...bare } = queue.entries[0];
  assert.equal("movedFrom" in planDone({ ...queue, entries: [bare] }, "A").entries[0], false, "a run with none has none");
});

test("A11-167: a retried review round keeps the text it was briefed with, so it can say what changed, and a retried planned run keeps the choice it was planned with", () => {
  const read = { updatedAt: null, hash: "a".repeat(64), description: "old", readAt: 1 };
  const pr = { repo: "r", url: "https://github.com/x/r/pull/1" };
  const failed = finish({ ...queuedA(), entries: queuedA().entries.map((e) => ({ ...e, review: [pr], briefedAgainst: read, plannedWith: { model: "opus", effort: "max" } })) }, "A", { kind: "crashed", reason: "x" }, 5);
  const [retried] = retry(failed, "A", 9).entries;
  assert.deepEqual([retried.briefedAgainst, retried.plannedWith], [read, { model: "opus", effort: "max" }]);
});

test("A11-173: a done outcome clears the run's partial; checked and reviewed keep it", () => {
  const declared = (outcome: Outcome) => finish(mergedPartial("a live check the chairman runs after merge"), "A", outcome, 20).entries[0].partial;
  assert.equal(declared({ kind: "done", reason: "PR merged", evidence: ["e"] }), undefined, "done says nothing remains to build");
  assert.equal(declared({ kind: "checked", reason: "nothing to change" }), "a live check the chairman runs after merge", "checked keeps it");
  assert.equal(declared({ kind: "reviewed", prs: [{ repo: "agent-org", url: PR_1 }] }), "a live check the chairman runs after merge", "reviewed keeps it");
  assert.equal(declared({ kind: "crashed", reason: "boom" }), "a live check the chairman runs after merge", "a crash keeps it");
  assert.equal(clearPartial(mergedPartial("the docs"), "A").entries[0].partial, undefined, "clearPartial drops it on the run it names");
  assert.equal(clearPartial(mergedPartial("the docs"), "B").entries[0].partial, "the docs", "and leaves another run's");
});

test("A11-173: a merged partial run that names no step is due the step after the last recorded one once the plan's size is known, and never before", () => {
  assert.deepEqual(nextStepRuns(mergedPartial("step 2 of the plan (identity)")), [], "a plan not counted yet queues nothing");
  assert.deepEqual(nextStepRuns(mergedPartial("step 2 of the plan (identity)", { planSteps: 9 })).map(({ step }) => step), [{ step: 2, of: 9, prs: [PR_1], counted: true }], "the step it names, marked as counted by the board");
  assert.deepEqual(nextStepRuns(mergedPartial("the identity work", { planSteps: 9, steps: [{ step: 1, of: 9, prs: [PR_2] }] })).map(({ step }) => step), [{ step: 2, of: 9, prs: [PR_1], counted: true }], "no step named: the one after the last recorded");
  assert.deepEqual(nextStepRuns(mergedPartial("the identity work", { planSteps: 0 })), [], "a plan with no numbered steps stops");
  assert.deepEqual(nextStepRuns(mergedPartial("the identity work", { planSteps: 1 })), [], "a one-step plan has no step after its first");
  const [queued] = queueNextStep(mergedPartial("step 2 of the plan", { planSteps: 9 }), "A", { step: 2, of: 9, prs: [PR_1], counted: true }, 50).entries;
  assert.deepEqual([queued.steps, queued.planSteps], [[{ step: 2, of: 9, prs: [PR_1], counted: true }], 9], "the next step's run keeps the count and records the step as counted");
  const asked = finish(markRunning(markStarting({ ...emptyQueue(1), entries: [{ ...queued, session: "s-2" }] }, "A", 51), "A", "w1", "w1:p1"), "A", { kind: "draft-pr", prs: [{ repo: "agent-org", url: PR_2 }], partial: "step 3 of 9" }, 52);
  assert.equal(approve(asked, "A", 60).entries[0].planSteps, 9, "a review round carries it");
});

test("A11-173: the plan's step count is wanted by a merged partial run that gives no total, once, and 0 is a count", () => {
  assert.deepEqual(planStepsUnread(mergedPartial("step 2 of the plan")).map((e) => e.ticket.key), ["A"]);
  assert.deepEqual(planStepsUnread(mergedPartial("the identity work")).map((e) => e.ticket.key), ["A"]);
  assert.deepEqual(planStepsUnread(mergedPartial("step 2 of 9")), [], "the declaration gives the total");
  assert.deepEqual(planStepsUnread(mergedPartial("the work", { steps: [{ step: 1, of: 9, prs: [] }] })), [], "the record gives it");
  assert.deepEqual(planStepsUnread(mergedPartial("the work", { planSteps: 0 })), [], "already counted, even as 0");
  assert.deepEqual(planStepsUnread(mergedPartial("the work", { partial: undefined })), [], "no declaration");
  assert.deepEqual(planStepsUnread(recordPullStates(mergedPartial("the work"), new Map([["A", { [PR_1]: "open" as const }]]))), [], "a pull request still open");
  assert.deepEqual(planStepsUnread(mergedPartial("the work", { trackerState: "completed" })), [], "a settled ticket");
  assert.equal(recordPlanSteps(mergedPartial("the work"), "A", 0).entries[0].planSteps, 0);
  assert.equal(recordPlanSteps(queuedA(), "A", 9).entries[0].planSteps, undefined, "recorded on a finished run only");
});

const AFTER_MERGE_TICKET = { ...ticket("A"), description: "## Done-when\n\n### Before merge\n\n- a test\n\n### After merge (who runs it)\n\n- the laptop run. The chairman, after merge." };
/** Ticket A, whose description has an After-merge line, ended on a ready pull request that merged. */
const mergedWithChecks = (over: Partial<Queue["entries"][number]> = {}): Queue => {
  const queue = finish(markRunning(markStarting(enqueue(emptyQueue(1), [AFTER_MERGE_TICKET], choice, 0), "A", 1), "A", "w1", "w1:p1"), "A", { kind: "ready-pr", prs: [{ repo: "agent-org", url: PR_1 }] }, 9);
  return { ...recordPullStates(queue, new Map([["A", { [PR_1]: "merged" as const }]])), entries: recordPullStates(queue, new Map([["A", { [PR_1]: "merged" as const }]])).entries.map((e) => ({ ...e, ...over })) };
};

test("A11-173: a Completed run whose pull requests merged is due its After-merge lines once, and a declared, unmerged, listed or line-less one is not", () => {
  const lines = [{ line: "the laptop run. The chairman, after merge.", owner: "The chairman" }];
  assert.deepEqual(afterMergeDue(mergedWithChecks()).map(({ entry, lines: due }) => [entry.ticket.key, due]), [["A", lines]]);
  const recorded = recordAfterMerge(mergedWithChecks(), "A", lines);
  assert.deepEqual(recorded.entries[0].afterMerge, lines);
  assert.deepEqual(afterMergeDue(recorded), [], "recorded once, never again");
  assert.deepEqual(afterMergeDue(mergedWithChecks({ partial: "step 1 of 3" })), [], "a partial run is not Completed");
  assert.deepEqual(afterMergeDue(recordPullStates(mergedWithChecks(), new Map([["A", { [PR_1]: "open" as const }]]))), [], "the pull request is still open");
  assert.deepEqual(afterMergeDue(mergedWithChecks({ ticket: ticket("A") })), [], "a ticket with no After-merge line");
  assert.deepEqual(afterMergeDue(mergedWithChecks({ trackerState: "completed" })).map(({ entry }) => entry.ticket.key), ["A"], "a ticket the tracker closed on Closes is listed too");
  assert.deepEqual(afterMergeUnposted(recorded).map((e) => e.ticket.key), ["A"], "listed and not yet posted");
  const posted = markAfterMergePosted(recorded, "A");
  assert.deepEqual(afterMergeUnposted(posted), [], "marked posted: not posted again");
  assert.deepEqual(afterMergeUnposted(markAfterMergeUnposted(posted, "A")).map((e) => e.ticket.key), ["A"], "unmarked after a failed post: tried again");
  assert.deepEqual(afterMergeUnposted(mergedWithChecks()), [], "nothing is posted that was never listed");
  const carried = talkRound(posted.entries[0], 70);
  assert.deepEqual([carried.afterMerge, carried.afterMergePosted], [lines, true], "a talk session opened on the run keeps what was listed and posted, so it is not posted again");
  const done = finish(markRunning(markStarting(enqueue(emptyQueue(1), [AFTER_MERGE_TICKET], choice, 0), "A", 1), "A", "w1", "w1:p1"), "A", { kind: "done", reason: "r", evidence: ["e"] }, 9);
  assert.equal(runStatus(done.entries[0]), "completed");
  assert.deepEqual(afterMergeDue(done), [], "a done with no merged pull request verified every Done-when item: nothing is left to list");
});

test("A11-174: a waiting run keeps the first line of its dialog, a run that stops waiting drops it, and a first line is ignored for a status that is not waiting", () => {
  const waiting = observe(runningA(), "A", "blocked", "Which database should the migration use?");
  assert.deepEqual([waiting.entries[0].waiting, waiting.entries[0].prompt], [true, "Which database should the migration use?"]);
  assert.equal(observe(waiting, "A", "blocked").entries[0].prompt, undefined, "a pane with no readable dialog leaves no stale first line");
  assert.equal(observe(waiting, "A", "working", "stale").entries[0].prompt, undefined);
});

test("A11-174: a declined safety prompt is counted, is not waiting, and is told once; the run's end and a requeue for an update drop it", () => {
  const prompt = { command: "rm -f $SC/*.done", warning: "Dangerous rm operation on possibly-empty variable path" };
  const waiting = observe(runningA(), "A", "blocked", "Do you want to proceed?");
  const declined = declinedPrompt(declinedPrompt(waiting, "A", prompt, 10), "A", prompt, 20);
  assert.deepEqual(declined.entries[0].declined, { ...prompt, at: 20, count: 2, told: false });
  assert.deepEqual([declined.entries[0].waiting, declined.entries[0].prompt], [false, undefined]);
  assert.equal(toldDeclined(declined, "A").entries[0].declined?.told, true);
  assert.equal(finish(toldDeclined(declined, "A"), "A", { kind: "no-outcome" }, 30).entries[0].declined, undefined);
  assert.equal(requeueForUpdate(declined, "A", "v1", 40).entries[0].declined, undefined);
});
