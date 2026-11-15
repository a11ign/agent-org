// no-token: none -- pure functions over a queue held in memory
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeTicket } from "../../plugins/fakes/tracker.ts";
import { enqueue, replace, type Entry, type Queue } from "../queue/queue-entries-and-outcomes.ts";
import { emptyQueue } from "../queue.ts";
import { logEvent } from "../queue/run-log.ts";
import { eventLine, isStuck, report, verdicts, type ScenarioResult } from "./stuck-runs.ts";

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const queued = (...keys: string[]): Queue => enqueue(emptyQueue(3), keys.map((key) => fakeTicket(key)), { model: "sonnet", effort: "high" }, NOW);
const changed = (queue: Queue, key: string, over: Partial<Entry>): Queue => replace(queue, key, (entry) => ({ ...entry, ...over }) as Entry);
const verdictOf = (queue: Queue, key: string) => verdicts(queue, NOW).find((one) => one.key === key)!;

test("a run In progress whose card says nothing, and a queued run nothing holds, are stuck with no reason shown", () => {
  let queue = queued("FIX-1", "FIX-2");
  queue = changed(queue, "FIX-1", { phase: "running", startedAt: NOW, workspace: "w1", pane: "w1:p1" });
  assert.deepEqual([verdictOf(queue, "FIX-1").status, verdictOf(queue, "FIX-1").reason], ["working", null]);
  assert.ok(isStuck(verdictOf(queue, "FIX-1")));
  assert.deepEqual([verdictOf(queue, "FIX-2").status, verdictOf(queue, "FIX-2").reason], ["queued", null]);
  assert.ok(isStuck(verdictOf(queue, "FIX-2")));
});

test("a run whose card says why is not stuck: a worker's working note, a crash with its reason, a run waiting on a dialog", () => {
  let queue = queued("FIX-1", "FIX-2", "FIX-3");
  queue = changed(queue, "FIX-1", { phase: "running", startedAt: NOW, working: { reason: "running the suite", at: NOW } } as Partial<Entry>);
  queue = changed(queue, "FIX-2", { phase: "finished", finishedAt: NOW, outcome: { kind: "crashed", reason: "its herdr workspace is gone" } } as Partial<Entry>);
  queue = changed(queue, "FIX-3", { phase: "running", startedAt: NOW, waiting: true, prompt: "Do you trust this folder?" } as Partial<Entry>);
  assert.deepEqual(verdicts(queue, NOW).map(({ key, reason }) => [key, reason]), [
    ["FIX-1", "running the suite"], ["FIX-2", "its herdr workspace is gone"], ["FIX-3", "Waiting on a person: Do you trust this folder?"],
  ]);
  assert.ok(verdicts(queue, NOW).every((verdict) => !isStuck(verdict)));
});

test("a run the board flagged as stalled is not stuck: the card says it stalled, though the reason line leaves the stalled note out", () => {
  const queue = changed(queued("FIX-1"), "FIX-1", { phase: "running", startedAt: NOW, working: { reason: "running the suite", at: NOW, stalled: true } } as Partial<Entry>);
  assert.equal(verdictOf(queue, "FIX-1").status, "working");
  assert.equal(verdictOf(queue, "FIX-1").reason, "Stalled: idle with no newer outcome since it said: running the suite");
  assert.ok(!isStuck(verdictOf(queue, "FIX-1")));
});

test("a settled run needs no reason: Checked, Completed and Cancelled say where it is by themselves", () => {
  let queue = queued("FIX-1", "FIX-2", "FIX-3");
  queue = changed(queue, "FIX-1", { phase: "finished", finishedAt: NOW, outcome: { kind: "checked" } } as Partial<Entry>);
  queue = changed(queue, "FIX-2", { phase: "finished", finishedAt: NOW, outcome: { kind: "done" } } as Partial<Entry>);
  queue = changed(queue, "FIX-3", { phase: "finished", finishedAt: NOW, outcome: { kind: "stopped" } } as Partial<Entry>);
  assert.deepEqual(verdicts(queue, NOW).map(({ status }) => status), ["checked", "completed", "cancelled"]);
  assert.ok(verdicts(queue, NOW).every((verdict) => !isStuck(verdict)));
});

test("Awaiting review says where a run is only while a review is owed: once its pull request is approved at its head, a run whose card says nothing more is stuck (A11-342)", () => {
  const url = "https://github.com/fixture/app/pull/1";
  const awaiting = { phase: "finished", finishedAt: NOW, outcome: { kind: "ready-pr", prs: [{ repo: "fixture/app", url }] } } as Partial<Entry>;
  let queue = changed(queued("FIX-1", "FIX-2"), "FIX-1", awaiting);
  queue = changed(queue, "FIX-2", { ...awaiting, pullHeads: { [url]: { head: "f".repeat(40), approved: true, review: "approved" } } } as Partial<Entry>);
  assert.deepEqual(verdicts(queue, NOW).map(({ status, reason }) => [status, reason]), [["awaiting-review", null], ["awaiting-review", null]]);
  assert.deepEqual(verdicts(queue, NOW).map(isStuck), [false, true], "a review owed explains the wait; an approval with nothing said does not");
});

test("a failed run with no reason is stuck: Failed says that it ended, not why", () => {
  const queue = changed(queued("FIX-1"), "FIX-1", { phase: "finished", finishedAt: NOW, outcome: { kind: "crashed" } } as Partial<Entry>);
  assert.equal(verdictOf(queue, "FIX-1").status, "failed");
  assert.ok(isStuck(verdictOf(queue, "FIX-1")));
});

test("the report lists each run, and for every stuck one its run log and the board's journal lines that name it", () => {
  let queue = changed(queued("FIX-1", "FIX-2"), "FIX-1", { phase: "running", startedAt: NOW, workspace: "w1", pane: "w1:p1" });
  queue = logEvent(queue, "FIX-1", NOW, { kind: "started", model: "sonnet", effort: "high", instance: null });
  queue = changed(queue, "FIX-2", { phase: "finished", finishedAt: NOW, outcome: { kind: "checked", reason: "nothing to change" } } as Partial<Entry>);
  const result: ScenarioResult = { name: "a-fault", faults: "something broke", runs: verdicts(queue, NOW), journal: ["ticket:serve: FIX-1 lost its pane", "ticket:serve: FIX-2 checked"] };
  const text = report([result]);
  assert.match(text, /^a-fault \(something broke\): 1 stuck with no reason shown$/m);
  assert.match(text, /^ {2}FIX-1: working, no reason shown$/m);
  assert.match(text, /^ {2}FIX-2: checked: nothing to change$/m);
  assert.match(text, /^ {2}run log of FIX-1:\n {4}2026-11-01T12:00:00\.000Z queued .*\n {4}2026-11-01T12:00:00\.000Z started /m);
  assert.match(text, /^ {4}ticket:serve: FIX-1 lost its pane$/m);
  assert.doesNotMatch(text, /run log of FIX-2/, "a run that is not stuck has no log in the report");
  assert.doesNotMatch(text, /FIX-2 checked/, "nor the journal's lines on it");
  assert.match(text, /^1 run left stuck with no reason shown\.$/m);
});

test("a report with no stuck run says so on its last line", () => {
  const queue = changed(queued("FIX-1"), "FIX-1", { phase: "finished", finishedAt: NOW, outcome: { kind: "checked" } } as Partial<Entry>);
  assert.match(report([{ name: "a-fault", faults: "x", runs: verdicts(queue, NOW), journal: [] }]), /: no stuck runs\n[\s\S]*No run was left stuck with no reason shown\.\n$/);
});

test("a log event is one line: its UTC time, its kind, then its other fields as JSON", () => {
  assert.equal(eventLine({ at: NOW, kind: "requeued", why: "restart" } as Parameters<typeof eventLine>[0]), '2026-11-01T12:00:00.000Z requeued {"why":"restart"}');
});
