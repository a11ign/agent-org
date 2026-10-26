// no-token: none -- queues built with the board's own transitions
// A11-298: a review round on a pull request that is open starts whatever its ticket's blockers are
import { test } from "node:test";
import assert from "node:assert/strict";
import { finishedWith, ticketOf } from "../kept-pulls-fixture.ts";
import { enqueue, find, replace, reviewRound, type Queue } from "../queue/queue-entries-and-outcomes.ts";
import { resumeQueue } from "../queue/queue-transitions.ts";
import { nextStarts } from "../queue.ts";
import { runStatus, waitNote, waitsOn } from "./pull-status-and-notes.ts";

const PULL = "https://github.com/a11ign/announcement-emulator/pull/20";
const BLOCKER = { key: "A11-229", state: "started", status: "In Progress", pulls: {} };

/** A11-234 finished on #20 and queued again as a review round, its ticket blocked by A11-229 (which is queued itself, so it cannot be stacked on); `more` is set on the round. */
function roundBehindBlocker(more: Record<string, unknown> = {}): Queue {
  const finished = finishedWith("A11-234", { kind: "ready-pr", prs: [{ repo: "announcement-emulator", url: PULL }] }, 10);
  const round = replace(finished, "A11-234", (entry) => ({ ...reviewRound(entry, [{ repo: "announcement-emulator", url: PULL }], 20), blockers: [BLOCKER], ...more }));
  return resumeQueue(enqueue(round, [ticketOf("A11-229")], { model: "sonnet", effort: "high" }, 30));
}

test("A11-298: a review round on an open pull request waits on none of its ticket's blockers, and starts", () => {
  const queue = roundBehindBlocker();
  const round = find(queue, "A11-234")!;
  assert.deepEqual(waitsOn(round, queue.entries), []);
  assert.equal(runStatus(round, queue.entries), "queued");
  assert.equal(waitNote(round, queue.entries), null);
  assert.ok(nextStarts(queue, 0, 14).some((entry) => entry.ticket.key === "A11-234"), "the pass starts it");
});

test("A11-298: the same ticket queued as a first run still waits on its blocker", () => {
  const queue = roundBehindBlocker();
  const first = { ...find(queue, "A11-234")!, review: undefined };
  const entries = queue.entries.map((entry) => (entry.ticket.key === "A11-234" ? first : entry));
  assert.deepEqual(waitsOn(first, entries).map(({ key }) => key), ["A11-229"]);
  assert.equal(runStatus(first, entries), "blocked");
});

test("A11-298: a round whose pull requests are all merged is no round on an open pull request, so it keeps waiting on its blockers until the watch drops it", () => {
  const queue = roundBehindBlocker({ pullStates: { [PULL]: "merged" } });
  assert.deepEqual(waitsOn(find(queue, "A11-234")!, queue.entries).map(({ key }) => key), ["A11-229"]);
});

test("A11-298: a round queued behind a ticket its worker waited on stays behind it: the worker asked for that ticket to be done", () => {
  const queue = roundBehindBlocker({ blockers: [], stoppedForBlocker: { at: 25, keys: ["A11-229"] } });
  assert.deepEqual(waitsOn(find(queue, "A11-234")!, queue.entries).map(({ key }) => key), ["A11-229"]);
  assert.equal(nextStarts(queue, 0, 14).some((entry) => entry.ticket.key === "A11-234"), false);
});

test("A11-298: a talk session on a pull request is a person's and keeps its blockers' hold", () => {
  const queue = roundBehindBlocker({ talk: true });
  assert.deepEqual(waitsOn(find(queue, "A11-234")!, queue.entries).map(({ key }) => key), ["A11-229"]);
});
