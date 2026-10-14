// no-token: gh -- pure transitions, and one file in a temporary directory
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { isParked } from "./board-view.ts";
import {
  amend, emptyQueue, enqueue, finish, isLive, loadQueue, markResumed, markRunning, markStarting, nextStarts, observe, park, recordBlockers, recordRepos,
  planDone, recordPullStates, recordTrackerStates, remove, retry, saveQueue, setMax, setPaused, unpark, unreadBlockerKeys, unsettledKeys, type Queue,
} from "./queue.ts";
import type { Ticket } from "./source.ts";

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
