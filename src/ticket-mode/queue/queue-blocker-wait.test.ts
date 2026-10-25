// no-token: gh -- pure transitions over a queue in memory; nothing is read or spawned
// A11-272: a run whose worker waits on another ticket is queued again behind it, keeping what it needs to resume, and the queue holds it there until the ticket is done
import { test } from "node:test";
import assert from "node:assert/strict";
import { enqueue, type Queue } from "./queue-entries-and-outcomes.ts";
import { markRunning, markStarting, recordBlockers, recordPaths, resumeQueue } from "./queue-transitions.ts";
import { emptyQueue, nextStarts } from "../queue.ts";
import { logOf } from "./run-log.ts";
import { recordStoppedStates, requeueBehindBlocker, resumesStoppedSession, unlistedKeys } from "./queue-blocker-wait.ts";
import { waitNote, waitsOn } from "../board-view/pull-status-and-notes.ts";
import type { Ticket } from "../source.ts";

const ticket = (key: string) => ({ key, title: key, description: "", url: "", branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "A11", project: null, priority: 0 }) as Ticket;
const FILES = ["lab:middleware/runtime/main.py"];
const WAIT = { keys: ["A11-229"], others: [{ kind: "fleetJob" as const, id: "fj-1" }] };

/** A11-231 running on the middleware files, with A11-229 queued behind them. */
function deadlocked(): Queue {
  const queued = recordPaths(resumeQueue(enqueue(emptyQueue(3), [ticket("A11-231"), ticket("A11-229")], { model: "opus", effort: "high" }, 1)), new Map([["A11-231", FILES], ["A11-229", FILES]]));
  const blockersRead = recordBlockers(queued, new Map([["A11-231", []], ["A11-229", []]]));
  return markRunning(markStarting(blockersRead, "A11-231", 2), "A11-231", "w1", "w1:p1");
}

test("A11-272: the parked run is queued again with its session, plan and paths, without its workspace or its blockers, and the log says why", () => {
  const requeued = requeueBehindBlocker(deadlocked(), "A11-231", { ...WAIT, session: "session-1" }, 50);
  const entry = requeued.entries.find((e) => e.ticket.key === "A11-231")!;
  assert.deepEqual([entry.phase, entry.session, entry.workspace, entry.blockers, entry.paths], ["queued", "session-1", undefined, undefined, FILES]);
  assert.deepEqual(entry.stoppedForBlocker, { at: 50, ...WAIT });
  assert.ok(resumesStoppedSession(entry));
  assert.deepEqual(logOf(requeued, "A11-231").at(-1), { kind: "requeued", why: "blocker", at: 50 });
});

test("A11-272: a run that is not live is left alone", () => {
  const queue = deadlocked();
  assert.equal(requeueBehindBlocker(queue, "A11-229", WAIT, 50), queue);
});

test("A11-272: the deadlock lets go: A11-229 starts on the files, and A11-231 waits for it whether or not the tracker lists the relation", () => {
  const requeued = requeueBehindBlocker(deadlocked(), "A11-231", { ...WAIT, session: "session-1" }, 50);
  for (const listed of [[], [{ key: "A11-229", state: "unstarted", status: "Todo", pulls: {} }]]) {
    const read = recordBlockers(requeued, new Map([["A11-231", listed]]));
    assert.deepEqual(nextStarts(read, 0, 14).map((e) => e.ticket.key), ["A11-229"]);
    const waiter = read.entries.find((e) => e.ticket.key === "A11-231")!;
    assert.deepEqual(waitsOn(waiter, read.entries).map(({ key }) => key), ["A11-229"]);
    assert.equal(waitNote(waiter, read.entries), "Waits for A11-229 (queued) to merge");
  }
});

test("A11-272: a blocker it was stopped for is waited on until done, never stacked on, even with a branch pushed in its repository", () => {
  const requeued = requeueBehindBlocker(deadlocked(), "A11-231", WAIT, 50);
  const pushed = recordBlockers(requeued, new Map([["A11-231", [{ key: "A11-229", state: "started", status: "In Progress", branch: "a11-229", head: "abc", pulls: { "https://github.com/a11ign/lab/pull/3": "open" } }]]]));
  const withRepo = { ...pushed, entries: pushed.entries.map((e) => ({ ...e, projectRepo: "a11ign/lab" })) };
  const waiter = withRepo.entries.find((e) => e.ticket.key === "A11-231")!;
  assert.deepEqual(waitsOn(waiter, withRepo.entries).map(({ key }) => key), ["A11-229"]);
});

test("A11-272: a ticket the tracker does not list lets go once its state, as read, is completed; before the list is read nothing is asked", () => {
  const requeued = requeueBehindBlocker(deadlocked(), "A11-231", { keys: ["A11-500"], others: [] }, 50);
  const waiter = () => read.entries.find((e) => e.ticket.key === "A11-231")!;
  assert.deepEqual(unlistedKeys(requeued.entries.find((e) => e.ticket.key === "A11-231")!), [], "its blockers are not read yet");
  let read = recordBlockers(requeued, new Map([["A11-231", []]]));
  assert.deepEqual(unlistedKeys(waiter()), ["A11-500"]);
  read = recordStoppedStates(read, "A11-231", new Map([["A11-500", "started"]]));
  assert.equal(waitsOn(waiter(), read.entries).length, 1);
  read = recordStoppedStates(read, "A11-231", new Map([["A11-500", "completed"]]));
  assert.deepEqual(waitsOn(waiter(), read.entries), []);
});

test("A11-272: its start drops the record, so the run it resumes holds nothing behind the ticket", () => {
  const requeued = requeueBehindBlocker(deadlocked(), "A11-231", WAIT, 50);
  const started = markStarting(requeued, "A11-231", 60);
  assert.equal(started.entries.find((e) => e.ticket.key === "A11-231")!.stoppedForBlocker, undefined);
});
