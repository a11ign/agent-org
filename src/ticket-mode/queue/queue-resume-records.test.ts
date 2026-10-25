// no-token: none -- the queue's pure transitions and the card's pure wording; no pool, no herdr, nothing is spawned
// A11-279: what the queue keeps of a restart and of the board's resume prompt, and what the card and the brief say of them
import { test } from "node:test";
import assert from "node:assert/strict";
import { enqueue, find, replace, type Queue } from "./queue-entries-and-outcomes.ts";
import { finish, markRunning, markStarting, resumeQueue } from "./queue-transitions.ts";
import { emptyQueue } from "../queue.ts";
import { lostBeforeThisStart, loseInRestart } from "./queue-readopt.ts";
import { requeueForUpdate } from "./queue-pins.ts";
import { resumeLine } from "../board-view/run-reason.ts";
import { clockOf } from "../board-view/update-banner.ts";
import { lostText } from "../brief-ticket-text.ts";
import type { Ticket } from "../source.ts";

const T0 = Date.UTC(2026, 9, 25, 15, 0, 0);
const ticket = (key: string) => ({ key, title: key, description: "", url: `https://linear.app/x/${key}`, branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;

/** `running` started, each in workspace `w<n>`, behind them `queued` still queued. */
function queueOf(running: readonly string[], queued: readonly string[] = []): Queue {
  const queue = resumeQueue(enqueue(emptyQueue(running.length), [...running, ...queued].map(ticket), { model: "sonnet", effort: "high" }, 0));
  return running.reduce((next, key, index) => markRunning(markStarting(next, key, 10), key, `w${index + 1}`, `w${index + 1}:p1`), queue);
}

test("A11-279: the runs one restart lost are queued again at the front in the order the queue held them, and a later restart's go first", () => {
  const lost = loseInRestart(loseInRestart(queueOf(["NBF-1", "NBF-2"], ["NBF-3"]), "NBF-1", 500), "NBF-2", 500);
  assert.deepEqual(lost.entries.map((e) => [e.ticket.key, e.phase]), [["NBF-1", "queued"], ["NBF-2", "queued"], ["NBF-3", "queued"]]);
  assert.equal(loseInRestart(queueOf(["NBF-1", "NBF-2"], ["NBF-3"]), "NBF-2", 600).entries[0].ticket.key, "NBF-2");
});

test("A11-279: a run stopped and queued again, or ended, drops its idle clock and resume", () => {
  const resumed = replace(queueOf(["NBF-1"]), "NBF-1", (entry) => ({ ...entry, idleSince: 1, resume: { at: 2, after: "restart" } }));
  const requeued = find(requeueForUpdate(resumed, "NBF-1", "v0.300.0", 900), "NBF-1")!;
  assert.deepEqual([requeued.phase, requeued.idleSince, requeued.resume], ["queued", undefined, undefined]);
  const ended = find(finish(resumed, "NBF-1", { kind: "checked", reason: "done" }, 900), "NBF-1")!;
  assert.deepEqual([ended.phase, ended.idleSince, ended.resume], ["finished", undefined, undefined]);
});

test("A11-279: only the queueing a loss made is told of it in its brief", () => {
  const lost = find(loseInRestart(queueOf(["NBF-1"]), "NBF-1", 500), "NBF-1")!;
  assert.equal(lostBeforeThisStart(lost), 500);
  assert.equal(lostBeforeThisStart({ ...lost, queuedAt: 900 }), undefined, "a later queueing of the same run is not");
  assert.match(lostText(500), /^## A restart lost this run's session\n\n/);
  assert.ok(lostText(T0).includes("2026-10-25T15:00:00.000Z") && lostText(T0).includes("carry on from the earlier run's work rather than starting again"));
  assert.equal(lostText(undefined), "", "a run no restart lost has no such section");
});

test("A11-279: a running run's card says the board's resume of it, and nothing once it has none or is not running", () => {
  const running = find(queueOf(["NBF-1"]), "NBF-1")!;
  assert.equal(resumeLine(running), null);
  assert.equal(resumeLine({ ...running, resume: { at: T0, after: "restart" } }), `Resumed after a restart at ${clockOf(T0)}`);
  assert.equal(resumeLine({ ...running, resume: { at: T0 + 10 * 60_000, after: "idle", idleSince: T0 } }), `Idle since ${clockOf(T0)}, resumed at ${clockOf(T0 + 10 * 60_000)}`);
  assert.equal(resumeLine({ ...running, resume: { at: T0, after: "restart", refused: "agent target w1:p1 is busy" } }), "could not be prompted: agent target w1:p1 is busy");
  assert.equal(resumeLine({ ...running, phase: "finished", resume: { at: T0, after: "restart" } }), null);
});
