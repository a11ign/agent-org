// no-token: none -- pure transitions over a queue a test writes out
// A11-261: a run held for its ticket's CI spend is stopped and queued again as the update drain stops one, held back for two passes of the board, started again resuming its session, and told why.
import { test } from "node:test";
import assert from "node:assert/strict";
import { enqueue, find, reviewRound, type Queue } from "../queue/queue-entries-and-outcomes.ts";
import { emptyQueue, nextStarts } from "../queue.ts";
import { logOf } from "../queue/run-log.ts";
import { markRunning, markStarting, resumeQueue, MAX_FEEDBACK_ROUNDS } from "../queue/queue-transitions.ts";
import { resumesStoppedSession } from "../queue/queue-blocker-wait.ts";
import { waitNote } from "../board-view/pull-status-and-notes.ts";
import type { Ticket } from "../source.ts";
import { ageHolds, isCiHeld, requeueForCiHold, tellFinishedRun } from "./hold.ts";

const ticket = (key: string) => ({ key, title: key, description: "", url: `https://linear.app/x/${key}`, branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
const REASON = "Held: CI ~640 min, over twice this ticket's budget of 300";

/** NBF-1 running in workspace w1 with the session s1 recorded, as a live run has. */
const running = (): Queue => {
  const queued = resumeQueue(enqueue(emptyQueue(3), [ticket("NBF-1")], { model: "sonnet", effort: "high" }, 0, null));
  return markRunning(markStarting(queued, "NBF-1", 5), "NBF-1", "w1", "w1:p1");
};
const held = (queue = running()) => requeueForCiHold(queue, "NBF-1", REASON, 100, "s1");

test("A11-261: a live run is stopped and queued again with its session, the reason, and nothing its agent held", () => {
  const entry = find(held(), "NBF-1")!;
  assert.equal(entry.phase, "queued");
  assert.equal(entry.session, "s1");
  assert.deepEqual(entry.ciHold, { reason: REASON, at: 100, passes: 0 });
  assert.deepEqual([entry.workspace, entry.pane, entry.startedAt], [undefined, undefined, undefined]);
  assert.equal(entry.ciSince, 5, "the run's CI still counts from its first start");
  assert.deepEqual(logOf(held(), "NBF-1").at(-1), { kind: "requeued", why: "ci-budget", at: 100 });
});

test("A11-261: a run that is not live is not stopped", () => {
  const queued = resumeQueue(enqueue(emptyQueue(3), [ticket("NBF-1")], { model: "sonnet", effort: "high" }, 0, null));
  assert.equal(requeueForCiHold(queued, "NBF-1", REASON, 100), queued);
});

test("A11-261: the queued run is held back through two passes of the board, and starts on the third", () => {
  let queue = held();
  assert.deepEqual(nextStarts(queue, 1, 14), [], "the pass that queued it");
  queue = ageHolds(queue);
  assert.equal(isCiHeld(find(queue, "NBF-1")!), true);
  assert.deepEqual(nextStarts(queue, 1, 14), [], "the next pass: held, and the reason is shown");
  queue = ageHolds(queue);
  assert.equal(isCiHeld(find(queue, "NBF-1")!), false);
  assert.deepEqual(nextStarts(queue, 1, 14).map((entry) => entry.ticket.key), ["NBF-1"], "the one after: released, with no person's hand");
  assert.equal(find(queue, "NBF-1")!.ciHold?.reason, REASON, "the reason stays for the brief");
});

test("A11-261: the card says why a held run waits, until it is released", () => {
  const queue = held();
  assert.equal(waitNote(find(queue, "NBF-1")!, queue.entries), REASON);
  assert.equal(waitNote(find(ageHolds(ageHolds(queue)), "NBF-1")!, queue.entries), null);
});

test("A11-261: a held run resumes its session when it starts", () => {
  assert.equal(resumesStoppedSession(find(held(), "NBF-1")!), true);
  assert.equal(resumesStoppedSession(find(running(), "NBF-1")!), false);
});

test("A11-261: the round that follows a hold is logged as a ci-budget round, drops the hold, and counts toward no cap", () => {
  const queue = markStarting(ageHolds(ageHolds(held())), "NBF-1", 200);
  const entry = find(queue, "NBF-1")!;
  assert.equal(entry.ciHold, undefined);
  assert.equal(entry.rounds, undefined, `the cap of ${MAX_FEEDBACK_ROUNDS} is for review findings, and a hold is not one`);
  assert.deepEqual(logOf(queue, "NBF-1").at(-1), { kind: "round", cause: "ci-budget", reason: REASON, at: 200 });
  assert.equal(entry.ciSince, 5, "a round keeps the run's first start");
});

/** NBF-1 finished on a pull request, as a run Ready to merge is. */
const finishedRun = (): Queue => {
  const live = running();
  return { ...live, entries: live.entries.map((entry) => ({ ...entry, phase: "finished" as const, finishedAt: 50, outcome: { kind: "ready-pr" as const, prs: [{ repo: "r", url: "https://github.com/a/r/pull/1" }] } })) };
};

test("A11-261: a finished run is not stopped and nothing holds it: it is told the reason, which its next round, whoever starts it, carries into its brief and drops when it starts", () => {
  const queue = tellFinishedRun(finishedRun(), "NBF-1", REASON);
  const entry = find(queue, "NBF-1")!;
  assert.deepEqual([entry.phase, entry.ciTold, entry.ciHold], ["finished", REASON, undefined]);
  assert.equal(waitNote(entry, queue.entries), null, "the card has no wait to show for a run that waits for nothing");
  const round = reviewRound(entry, entry.outcome && "prs" in entry.outcome ? entry.outcome.prs : [], 100);
  assert.deepEqual([round.ciTold, round.ciHold, round.ciSince], [REASON, undefined, 5], "a round carries what the run was told, and when its CI count began");
  assert.deepEqual(nextStarts({ ...queue, entries: [round] }, 1, 14).length, 1, "and is not held back for it");
  const started = markStarting({ ...queue, entries: [round] }, "NBF-1", 200);
  assert.equal(find(started, "NBF-1")!.ciTold, undefined);
  assert.deepEqual(logOf(started, "NBF-1").filter(({ kind }) => kind === "round"), [], "the round is logged by whatever started it, not as a hold");
  assert.equal(tellFinishedRun(running(), "NBF-1", REASON).entries[0]!.ciTold, undefined, "a live run is stopped, not told");
});

test("A11-261: a run that started before the board recorded its first start keeps its latest start as the count's beginning when it is held", () => {
  const live = running();
  const legacy = { ...live, entries: live.entries.map(({ ciSince: _since, ...entry }) => entry) };
  assert.equal(find(requeueForCiHold(legacy, "NBF-1", REASON, 100, "s1"), "NBF-1")!.ciSince, 5);
});

test("A11-261: ageing a queue with no hold changes nothing", () => {
  const queue = running();
  assert.equal(ageHolds(queue), queue);
});
