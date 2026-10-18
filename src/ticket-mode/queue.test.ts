// no-token: gh -- pure transitions, and one file in a temporary directory
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { isParked, runStatus } from "./board-view.ts";
import {
  amend, approve, byIdentifier, childOrder, conflictRound, refuseParents, respond, batchPlanDone, dismiss, feedbackRound, MAX_FEEDBACK_ROUNDS, markPublishRunning, markPublishStarting, publishDone, publishFailed, publishStarts, queuePublish, emptyQueue, enqueue, finish, isLive, leaveBatch, liveRunCount, loadQueue, markResumed, markRunning, markStarting, nextStarts, observe, park,
  BACKGROUND_GONE, BACKGROUND_GONE_MS, clearEdit, clearMove, noteWorking, recordBlockers, recordMove, recordRepos, planDone, watchWorking, PLAN_BATCH_MAX, recordPullStates, recordTrackerStates, remove, retry, saveQueue, setMax, setPaused, unpark, unreadBlockerKeys, unsettledKeys, type Queue,
  pathsUnread, recordPaths, recordPullFiles, recordVerdictNotPosted, unreadPaths,
  changeDraft, dismissWriter, draftOf, markWriterRunning, markWriterStarting, queueWriter, stopWriter, writerDrafted, writerFailed, writerOf, writerResumed, writerStatus, writerToStart, writerWaiting,
} from "./queue.ts";
import type { Blocker, Ticket } from "./source.ts";
import type { Draft } from "./writer.ts";

const ticket = (key: string) => ({ key, title: key, description: "", url: "", branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
const choice = { model: "opus", effort: "high" };
const keys = (queue: Queue) => queue.entries.map((e) => e.ticket.key);

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
  assert.deepEqual(nextStarts(setPaused(queue, false), 0, 4).map((e) => e.ticket.key), ["A", "B"], "it starts in its old place");
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
  let queue = setPaused(enqueue(emptyQueue(1), [ticket("A"), ticket("B"), ticket("C"), ticket("D")], choice, 1, plan), false);
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
  assert.deepEqual(nextStarts(queue, 0, 14).map((e) => e.ticket.key), ["A", "B", "C"], "once that pull request has merged, B starts");
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
  let queue = enqueue(emptyQueue(2), [ticket("A")], choice, 1);
  assert.equal(queue.paused, true, "queueing is never also starting");
  assert.deepEqual(nextStarts(queue, 0, 14), []);
  queue = setPaused(queue, false);
  assert.deepEqual(nextStarts(queue, 0, 14).map((e) => e.ticket.key), ["A"]);
  assert.deepEqual(nextStarts(setPaused(queue, true), 0, 14), []);
});

test("nextStarts fills free slots in queue order, counts starting and running alike, and starts nothing past the host's cores", () => {
  let queue = setPaused(enqueue(emptyQueue(2), [ticket("A"), ticket("B"), ticket("C")], choice, 1), false);
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
  let queue = setPaused(enqueue(emptyQueue(1), [ticket("A"), ticket("B")], choice, 1), false);
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
  const queue = enqueue(emptyQueue(2), [ticket("A")], choice, 1);
  saveQueue(path, queue);
  assert.deepEqual(loadQueue(path, 9), queue, "the saved max wins over the default");
  saveQueue(path, setPaused(queue, false));
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
  let queue = setPaused(enqueue(emptyQueue(1), [ticket("A"), ticket("B")], choice, 1), false);
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
  assert.deepEqual(a, { ticket: ticket("A"), repos: [], model: "opus", effort: "high", session: "s1", review: [pr], phase: "queued", queuedAt: 9 });
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

const readyToMerge = (fields: Record<string, unknown> = {}) => endedWith({ kind: "reviewed", prs: [pr] }, { review: [pr], pullStates: { [pr.url]: "open" }, ...fields });
const a = (queue: Queue) => queue.entries.find((e) => e.ticket.key === "A")!;

test("new feedback on a run Ready to merge queues a review round at the end that answers it, resuming the worker and keeping its Slack link", () => {
  const published = { link: "https://slack/1", at: 4 };
  const queue = feedbackRound(readyToMerge({ published }), "A", "New review feedback on x", 9);
  assert.deepEqual(keys(queue), ["B", "A"]);
  assert.deepEqual(a(queue), { ticket: ticket("A"), repos: [], model: "opus", effort: "high", session: "s1", published, review: [pr], phase: "queued", queuedAt: 9,
    feedback: "New review feedback on x", rounds: 1 });
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
    feedback: "a conflict line", rounds: 1 });
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

test("a publish run holds a slot while it is live, starts while workers are paused, and its result marks its runs Published or leaves them as they were", () => {
  const queued = queuePublish(setPaused(readyToMerge(), true), ["A"], 36);
  assert.equal(publishStarts(queued), true, "the person just asked for it");
  assert.equal(publishStarts({ ...queued, max: 0 }), false, "but it needs a free slot");
  const running = markPublishRunning(markPublishStarting(queued, 37), "w9", "w9:p1");
  assert.equal(nextStarts({ ...setPaused(enqueue(running, [ticket("C"), ticket("D")], choice, 38), false), max: 2 }, 1, 8).length, 1, "it holds one of two slots");
  const done = publishDone(running, ["https://slack/1", "https://slack/2"], 50);
  assert.deepEqual(a(done).published, { link: "https://slack/1", at: 50 }, "the first link");
  assert.deepEqual([done.publish?.phase, done.publish?.workspace, done.publish?.pane], ["finished", undefined, undefined]);
  const failed = publishFailed(running, "no channel for nbl-ui-netbox", 50);
  assert.deepEqual([a(failed).published, failed.publish?.failure], [undefined, "no channel for nbl-ui-netbox"]);
  const path = join(tmpDir("ticket-queue-publish-"), "queue.json");
  saveQueue(path, done);
  assert.deepEqual(loadQueue(path, 3).publish, done.publish, "the publish run survives a restart of the board");
});

test("Respond to review queues a round now on a run Ready to merge or Published, resuming the worker, and leaves drafts, parked and merged runs alone", () => {
  const published = { link: "https://slack/1", at: 4 };
  const queue = respond(readyToMerge({ published, rounds: 2 }), "A", 9);
  assert.deepEqual(keys(queue), ["B", "A"]);
  assert.deepEqual(a(queue), { ticket: ticket("A"), repos: [], model: "opus", effort: "high", session: "s1", published, review: [pr], phase: "queued", queuedAt: 9, asked: true });
  const live = markRunning(markStarting(enqueue(emptyQueue(3), [ticket("A")], choice, 1), "A", 2), "A", "w1", "w1:p1");
  for (const [why, q] of [
    ["a draft", endedWith({ kind: "draft-pr", prs: [pr] })], ["parked", park(live, "A", { kind: "no-outcome" }, 3)], ["live", live],
    ["holding a workspace", readyToMerge({ workspace: "w1" })], ["merged", readyToMerge({ pullStates: { [pr.url]: "merged" } })], ["completed in the tracker", recordTrackerStates(readyToMerge(), new Map([["A", "completed"]]))],
  ] as const) assert.deepEqual(respond(q, "A", 9), q, why);
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
  let queue = setPaused(enqueue(emptyQueue(2), [ticket("A"), ticket("B"), ticket("C")], choice, 1), false);
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
  let queue = setPaused(enqueue(emptyQueue(1), [ticket("A")], choice, 1), false);
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
  let queue = setPaused(enqueue(emptyQueue(5), [ticket("A"), ticket("B"), ticket("C")], choice, 1), false);
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
  const running = markRunning(markStarting(enqueue(emptyQueue(1), [ticket("A")], choice, 0), "A", 1), "A", "w1", "w1:p1");
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
  const running = markRunning(markStarting(enqueue(emptyQueue(1), [ticket("A")], choice, 0), "A", 1), "A", "w1", "w1:p1");
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
  const running = markRunning(markStarting(enqueue(emptyQueue(1), [ticket("A")], choice, 0), "A", 1), "A", "w1", "w1:p1");
  const stall = 30 * 60_000;
  const noted = noteWorking(running, "A", "the roll is still running", 50, 1000);
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
  const running = markRunning(markStarting(enqueue(emptyQueue(1), [ticket("A")], choice, 0), "A", 1), "A", "w1", "w1:p1");
  const noted = noteWorking(running, "A", "the roll is still running", 50, 1000);
  const note = (q: Queue) => q.entries[0].working;
  const started = watchWorking(noted, "A", "idle", 1000, 30 * 60_000, "none");
  const gone = watchWorking(started, "A", "idle", 1000 + BACKGROUND_GONE_MS, 30 * 60_000, "none");
  assert.equal(note(gone)?.stalled, true, "POSITIVE: the run is stalled before the live work is seen");
  const live = watchWorking(gone, "A", "idle", 1000 + BACKGROUND_GONE_MS + 1, 30 * 60_000, "live");
  assert.deepEqual(note(live), { reason: "the roll is still running", at: 50, idleSince: 1000 }, "live work clears the stall, the gone clock and the resume");
  const unread = watchWorking(noted, "A", "idle", 1000 + BACKGROUND_GONE_MS * 5, 30 * 60_000, null);
  assert.deepEqual(note(unread), { reason: "the roll is still running", at: 50, idleSince: 1000 }, "a pane that cannot be read: the idle clock alone");
});

test("A11-85: a newer working note keeps the resume, so the worker is not prompted twice, and working status clears the stall but not the resume", () => {
  const running = markRunning(markStarting(enqueue(emptyQueue(1), [ticket("A")], choice, 0), "A", 1), "A", "w1", "w1:p1");
  const note = (q: Queue) => q.entries[0].working;
  const started = watchWorking(noteWorking(running, "A", "first", 50, 1000), "A", "idle", 1000, 30 * 60_000, "none");
  const gone = watchWorking(started, "A", "idle", 1000 + BACKGROUND_GONE_MS, 30 * 60_000, "none");
  assert.equal(note(gone)?.resumed, true, "POSITIVE: resumed once the gone time has passed");
  const again = noteWorking(gone, "A", "second", 70, 2000);
  assert.deepEqual(note(again), { reason: "second", at: 70, idleSince: 2000, resumed: true }, "the resume outlasts a newer note");
  const woke = watchWorking(gone, "A", "working", 2001, 30 * 60_000, "none");
  assert.deepEqual(note(woke), { reason: "first", at: 50, resumed: true }, "working clears the stall and the gone clock, and keeps the resume");
});

// A11-82: runs that share a path in one repository start in turn, and a review round keeps the footprint of the run it continues.
test("A11-82: runs that share a path in one repository start in turn: the earlier one starts and the later waits for it, while disjoint and other-repository runs start together", () => {
  const queued = setPaused(enqueue(emptyQueue(4), [ticket("A"), ticket("B"), ticket("C"), ticket("D")], choice, 1), false);
  const queue = recordPaths(queued, new Map([["A", ["app:src/pool.ts"]], ["B", ["app:src/"]], ["C", ["lib:src/pool.ts"]], ["D", ["app:docs/"]]]));
  assert.deepEqual(nextStarts(queue, 0, 14).map((e) => e.ticket.key), ["A", "C", "D"], "B shares src/pool.ts with A, and waits for it in this pass");
  const running = markRunning(markStarting(queue, "A", 2), "A", "w1", "w1:p1");
  assert.deepEqual(nextStarts(running, 0, 14).map((e) => e.ticket.key), ["C", "D"], "with A live, B is held, and the rest start");
  assert.equal(runStatus(running.entries.find((e) => e.ticket.key === "B")!, running.entries), "blocked", "B shows Blocked");
  const reviewed = finish(running, "A", { kind: "draft-pr", prs: [pr] }, 3);
  const open = { ...reviewed, entries: reviewed.entries.map((e) => (e.ticket.key === "A" ? { ...e, pullStates: { [pr.url]: "open" as const } } : e)) };
  assert.deepEqual(nextStarts(open, 0, 14).map((e) => e.ticket.key), ["C", "D"], "a finished run with a pull request open still holds its path");
  const merged = { ...open, entries: open.entries.map((e) => (e.ticket.key === "A" ? { ...e, pullStates: { [pr.url]: "merged" as const } } : e)) };
  assert.deepEqual(nextStarts(merged, 0, 14).map((e) => e.ticket.key), ["B", "C", "D"], "once its pull request merges, B starts");
});

test("A11-82: tickets of one batch whose plans share a path are held against each other: the earlier starts and the later waits", () => {
  const queued = setPaused(enqueue(emptyQueue(3), [ticket("A"), ticket("B")], choice, 1), false);
  const batched = { ...queued, entries: queued.entries.map((e) => ({ ...e, batch: "b1" })) };
  const queue = recordPaths(batched, new Map([["A", ["app:src/a.ts"]], ["B", ["app:src/a.ts"]]]));
  assert.deepEqual(nextStarts(queue, 0, 14).map((e) => e.ticket.key), ["A"], "a shared batch is no reason to start both");
});

test("A11-82: a queued review round holds its pull requests' paths, so a run that shares one waits for the round, which starts", () => {
  const queue = recordPaths(feedbackRound(readyToMerge({ paths: ["app:src/a.ts"] }), "A", "f", 9), new Map([["B", ["app:src/a.ts"]]]));
  assert.deepEqual(nextStarts(setPaused(queue, false), 0, 14).map((e) => e.ticket.key), ["A"], "B, queued first, waits for the round A is");
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
  assert.equal(recordPullFiles(enqueue(emptyQueue(2), [ticket("A")], choice, 1), "A", { [pr.url]: ["x"] }).entries[0].pullFiles, undefined, "a queued run has no pull request to read");
});

test("a verdict that is not on a finished run's pull request is recorded on the run, and cleared once a review is on it", () => {
  const pr = { repo: "nbl-ui-netbox", url: "https://github.com/x/nbl-ui-netbox/pull/1" };
  const finished = endedWith({ kind: "draft-pr", prs: [pr] });
  const said = recordVerdictNotPosted(finished, "A", "verdict not posted: the reviewer ended without writing a verdict file");
  assert.equal(a(said).verdictNotPosted, "verdict not posted: the reviewer ended without writing a verdict file");
  const cleared = recordVerdictNotPosted(said, "A", undefined);
  assert.equal("verdictNotPosted" in a(cleared), false, "cleared: the key is gone, not left undefined");
  assert.deepEqual(a(cleared), a(finished), "and the run is otherwise as it was");
  const queued = enqueue(emptyQueue(2), [ticket("A")], choice, 1);
  assert.equal("verdictNotPosted" in recordVerdictNotPosted(queued, "A", "x").entries[0], false, "a queued run has no pull request to say of");
});

/*
 * Writer runs (A11-94): a new-ticket request is its own record, holds a worker slot only while it runs, and keeps its drafts until each is settled.
 */

const request = { id: "w1", request: "Show the requests a person made", mode: "quick" as const, form: {} };
const drafted = (file: string) => ({ file, draft: { title: file, why: "w", doneWhen: ["d"], notes: null, team: null, project: null, repo: null, goal: null, labels: [],
  priority: "none", parent: null, blocks: [], blockedBy: [], duplicates: [] } as Draft, duplicates: [], status: "pending" as const, id: `d-${file}` });

test("a writer run is queued, starts on a free slot, and holds one while it runs and while it starts", () => {
  let queue = queueWriter(emptyQueue(1), request, 1);
  assert.equal(writerToStart(queue)?.id, "w1");
  queue = markWriterStarting(queue, "w1", 2);
  assert.equal(writerToStart(queue), undefined, "its slot is held while it starts");
  assert.equal(liveRunCount(queue), 1);
  queue = markWriterRunning(queue, "w1", "ws", "p");
  assert.equal(writerStatus(writerOf(queue, "w1")!), "writing");
  queue = writerDrafted(queue, "w1", { drafts: [drafted("01-a.json")], rejected: [] }, 3);
  assert.equal(liveRunCount(queue), 0, "a finished run holds no slot");
  assert.equal(writerStatus(writerOf(queue, "w1")!), "ready");
});

test("a writer run waits for a worker slot as a ticket does, and is not held by Pause", () => {
  let queue = setPaused(emptyQueue(1), true);
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

test("a grill run waits on its question without a slot, and runs again once it works", () => {
  let queue = markWriterRunning(markWriterStarting(queueWriter(emptyQueue(1), { ...request, mode: "grill" }, 1), "w1", 2), "w1", "ws", "p");
  queue = writerWaiting(queue, "w1", "Which goal?");
  assert.equal(writerStatus(writerOf(queue, "w1")!), "needs-you");
  assert.equal(liveRunCount(queue), 0);
  assert.equal(writerToStart(queue), undefined, "a waiting run is not queued again");
  queue = writerResumed(queue, "w1", 9);
  assert.equal(writerOf(queue, "w1")?.phase, "running");
  assert.equal(writerOf(queue, "w1")?.question, undefined);
});

test("a run that wrote no valid draft ends failed and names each refused file; a run that wrote none at all says so", () => {
  const queue = queueWriter(emptyQueue(1), request, 1);
  const bad = writerDrafted(queue, "w1", { drafts: [], rejected: [{ file: "02-wire.json", reason: '02-wire.json: "priority" must be one of urgent' }] }, 2);
  assert.equal(writerOf(bad, "w1")?.failure, 'none of its drafts is valid: 02-wire.json: "priority" must be one of urgent');
  assert.equal(writerStatus(writerOf(bad, "w1")!), "failed");
  assert.equal(writerOf(writerDrafted(queue, "w1", { drafts: [], rejected: [] }, 2), "w1")?.failure, "it wrote no draft");
});

test("a stopped run keeps the drafts it wrote, and a finished run dismisses once, while one still writing must be stopped first", () => {
  let queue = markWriterRunning(markWriterStarting(queueWriter(emptyQueue(1), request, 1), "w1", 2), "w1", "ws", "p");
  assert.throws(() => dismissWriter(queue, "w1"), /stop the new-ticket request before you dismiss it/);
  queue = writerDrafted(queue, "w1", { drafts: [drafted("01-a.json")], rejected: [] }, 3);
  queue = stopWriter(queue, "w1", 4);
  assert.equal(writerOf(queue, "w1")?.drafts.length, 1, "a finished run is not changed by a stop");
  queue = dismissWriter(queue, "w1");
  assert.deepEqual(queue.writers, []);
});

test("a draft is changed by its own id, and a writer run round-trips through the queue file with its drafts", () => {
  const path = join(tmpDir("ticket-queue-writers-"), "queue.json");
  let queue = writerDrafted(markWriterRunning(markWriterStarting(queueWriter(emptyQueue(2), request, 1), "w1", 2), "w1", "ws", "p"), "w1",
    { drafts: [drafted("01-a.json")], rejected: [{ file: "02-b.json", reason: "02-b.json: is not valid JSON" }] }, 3);
  queue = changeDraft(queue, "w1", "d-01-a.json", (draft) => ({ ...draft, status: "discarded" }));
  saveQueue(path, queue);
  const loaded = loadQueue(path, 2);
  assert.equal(loaded.writers?.[0].drafts[0].status, "discarded");
  assert.deepEqual(loaded.writers?.[0].rejected, [{ file: "02-b.json", reason: "02-b.json: is not valid JSON" }]);
  assert.equal(draftOf(loaded, "w1", "d-01-a.json")?.status, "discarded");
  assert.equal(loadQueue(join(tmpDir("ticket-queue-old-"), "queue.json"), 2).writers, undefined, "a file from before writer runs loads with none");
});
