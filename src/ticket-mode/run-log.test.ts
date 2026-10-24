// no-token: gh -- pure transitions, one file in a temporary directory, and a pool over fakes
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { poolFixture } from "./pool-fixture.ts";
import { OUTCOME_FILE } from "./worker-files.ts";
import { ticketDir } from "./ticket-paths.ts";
import { dismiss, enqueue, remove, retry, type Outcome, type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { batchPlanDone, feedbackRound, finish, markRunning, markStarting, observe, planDone, publishDone, recordPullStates, respond, MAX_FEEDBACK_ROUNDS } from "./queue/queue-transitions.ts";
import { queueNextStep } from "./queue/queue-next-step.ts";
import { requeueForUpdate } from "./queue/queue-pins.ts";
import { recordPullHeads, recordStaleBlock } from "./queue/queue-pull-heads.ts";
import { replan } from "./queue/queue-ticket-text.ts";
import { talk } from "./queue/talk.ts";
import { GONE_LOGS_MAX, RUN_LOG_MAX, logEvent, logOf, shortReason, type RunEvent } from "./queue/run-log.ts";
import { emptyQueue, loadQueue, saveQueue } from "./queue.ts";
import type { Ticket } from "./source.ts";

// A11-219: a run's event log, kept on the queue by ticket.
const ticket = (key: string) => ({ key, title: key, description: "", url: `https://linear.app/x/${key}`, branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
const choice = { model: "opus", effort: "high" };
const worker = { instance: "agents", host: "agents-host" };
const PRS = [{ repo: "a11ign/agent-org", url: "https://github.com/a11ign/agent-org/pull/1" }, { repo: "a11ign/agent-org", url: "https://github.com/a11ign/agent-org/pull/2" }];
const [FIRST, SECOND] = [PRS[0].url, PRS[1].url];
const ready: Outcome = { kind: "ready-pr", prs: PRS };

const kinds = (queue: Queue, key = "A"): string[] => logOf(queue, key).map((event) => event.kind);

/** The log of `key` without its times, for deepEqual. */
const bodies = (queue: Queue, key = "A") => logOf(queue, key).map(({ at: _at, ...body }) => body);

/** Ticket A queued at 1 on a queue of two slots, started at 2 with the worker, and finished at 3 on `outcome`. */
function finishedA(outcome: Outcome = ready, planFirst = false): Queue {
  const queued = enqueue(emptyQueue(2), [ticket("A")], choice, 1, planFirst ? { keys: new Set(["A"]), choice: { model: "opus", effort: "max" } } : null);
  return finish(markRunning(markStarting(queued, "A", 2, worker), "A", "w1", "w1:p1"), "A", outcome, 3);
}

test("a ticket's life is logged as it happens: each event once, in order, with its time", () => {
  let queue = enqueue(emptyQueue(2), [ticket("A")], choice, 1, { keys: new Set(["A"]), choice: { model: "opus", effort: "max" } });
  queue = markStarting(queue, "A", 2, worker);
  queue = planDone(markRunning(queue, "A", "w1", "w1:p1"), "A", { now: 3 });
  queue = markStarting(queue, "A", 4, worker);
  queue = finish(markRunning(queue, "A", "w2", "w2:p1"), "A", ready, 5);
  queue = recordPullHeads(queue, "A", { [FIRST]: { head: "h1", approved: false, review: "changes-requested" } }, 6);
  queue = feedbackRound(recordPullStates(queue, new Map([["A", { [FIRST]: "open" }]]), 6), "A", "the title is wrong\nand the body", 7);
  queue = finish(markRunning(markStarting(queue, "A", 8, worker), "A", "w3", "w3:p1"), "A", { kind: "reviewed", prs: PRS }, 9);
  queue = recordPullStates(queue, new Map([["A", { [FIRST]: "merged", [SECOND]: "open" }]]), 10);
  queue = dismiss(queue, "A", 11);
  assert.equal(queue.entries.length, 0, "the entry is gone, and its log is not");
  assert.deepEqual(logOf(queue, "A"), [
    { at: 1, kind: "queued", model: "opus", effort: "high", planFirst: true },
    { at: 2, kind: "started", model: "opus", effort: "max", instance: "agents" },
    { at: 3, kind: "planned", link: "https://linear.app/x/A" },
    { at: 4, kind: "started", model: "opus", effort: "high", instance: "agents" },
    { at: 5, kind: "pr-opened", url: FIRST },
    { at: 5, kind: "pr-opened", url: SECOND },
    { at: 5, kind: "finished", outcome: "ready-pr" },
    { at: 6, kind: "verdict", url: FIRST, head: "h1", review: "changes-requested" },
    { at: 7, kind: "round", cause: "feedback", reason: "the title is wrong" },
    { at: 8, kind: "started", model: "opus", effort: "high", instance: "agents" },
    { at: 9, kind: "finished", outcome: "reviewed" },
    { at: 10, kind: "merged", url: FIRST },
    { at: 11, kind: "dismissed" },
  ] satisfies RunEvent[]);
});

test("a watch that reads the same heads and states again adds no event", () => {
  const heads = { [FIRST]: { head: "h1", approved: true, review: "approved" as const }, [SECOND]: { head: "h2", approved: false, review: "none" as const } };
  const states = new Map([["A", { [FIRST]: "merged" as const, [SECOND]: "open" as const }]]);
  const once = recordPullStates(recordPullHeads(finishedA(), "A", heads, 4), states, 4);
  const again = recordPullStates(recordPullHeads(once, "A", heads, 5), states, 5);
  assert.deepEqual(logOf(again, "A"), logOf(once, "A"));
  assert.deepEqual(bodies(once).slice(-2), [{ kind: "verdict", url: FIRST, head: "h1", review: "approved" }, { kind: "merged", url: FIRST }], "a review of none is no verdict");
  const moved = recordPullHeads(again, "A", { [FIRST]: { head: "h3", approved: true, review: "approved" } }, 6);
  assert.deepEqual(bodies(moved).at(-1), { kind: "verdict", url: FIRST, head: "h3", review: "approved" }, "the same review at a new head is a new verdict");
});

test("a pull request already merged in the record when the log began is not logged as merging now", () => {
  const stored = { ...finishedA(), runLog: undefined };
  const merged = { ...stored, entries: stored.entries.map((entry) => ({ ...entry, pullStates: { [FIRST]: "merged" } })) } as Queue;
  const next = recordPullStates(merged, new Map([["A", { [FIRST]: "merged" }]]), 9);
  assert.equal(next.runLog, undefined);
});

test("a log keeps its last 200 events, and the logs of the 50 tickets that ended most recently", () => {
  let queue: Queue = emptyQueue(1);
  for (let at = 0; at < RUN_LOG_MAX + 5; at += 1) queue = logEvent(queue, "A", at, { kind: "merged", url: `u${at}` });
  assert.equal(logOf(queue, "A").length, RUN_LOG_MAX);
  assert.deepEqual([logOf(queue, "A")[0].at, logOf(queue, "A").at(-1)?.at], [5, RUN_LOG_MAX + 4]);
  let ended: Queue = emptyQueue(1);
  for (let n = 0; n < GONE_LOGS_MAX + 1; n += 1) ended = remove(enqueue(ended, [ticket(`T${n}`)], choice, n * 10), `T${n}`, n * 10 + 1);
  const left = Object.keys(ended.runLog ?? {});
  assert.equal(left.length, GONE_LOGS_MAX);
  assert.ok(!left.includes("T0") && left.includes("T1") && left.includes(`T${GONE_LOGS_MAX}`), "the oldest ended ticket's log is the one dropped");
});

test("a ticket still on the queue keeps its log, however many tickets have ended", () => {
  let queue = enqueue(emptyQueue(1), [ticket("KEEP")], choice, 0);
  for (let n = 0; n < GONE_LOGS_MAX + 2; n += 1) queue = remove(enqueue(queue, [ticket(`T${n}`)], choice, n + 1), `T${n}`, n + 1);
  assert.deepEqual(kinds(queue, "KEEP"), ["queued"]);
});

test("the log is saved with the queue and read back unchanged", () => {
  const queue = dismiss(finishedA(), "A", 4);
  const path = join(tmpDir("run-log-"), "queue.json");
  saveQueue(path, queue);
  assert.deepEqual(loadQueue(path, 2).runLog, queue.runLog);
  assert.ok(logOf(loadQueue(path, 2), "A").length >= 4);
});

test("a transition given no time logs nothing, so a caller without a clock keeps its old signature", () => {
  const queue = remove(enqueue(emptyQueue(1), [ticket("A")], choice, 1), "A");
  assert.equal(queue.entries.length, 0);
  assert.deepEqual(kinds(queue), ["queued"], "only enqueue, which is given its time, logged: no removed");
  assert.deepEqual(kinds(dismiss(finishedA(), "A")), ["queued", "started", "pr-opened", "pr-opened", "finished"], "no dismissed");
});

test("a log survives every way the board rebuilds a run, and a ticket queued again continues it", () => {
  const crashed = finishedA({ kind: "crashed", reason: "herdr went away" });
  const retried = retry(crashed, "A", 10);
  assert.deepEqual(kinds(retried), ["queued", "started", "finished", "requeued"]);
  assert.deepEqual(bodies(retried).slice(2), [{ kind: "finished", outcome: "crashed", reason: "herdr went away" }, { kind: "requeued", why: "retry" }]);
  const live = markRunning(markStarting(enqueue(emptyQueue(1), [ticket("A")], choice, 1), "A", 2, worker), "A", "w1", "w1:p1");
  assert.deepEqual(bodies(requeueForUpdate(live, "A", "v2", 5)).at(-1), { kind: "requeued", why: "update" });
  const planned = replan(enqueue(emptyQueue(1), [ticket("A")], choice, 1), "A", { model: "opus", effort: "max" }, [], undefined, 6);
  assert.deepEqual(bodies(planned).at(-1), { kind: "requeued", why: "replan" });
  const partial = finishedA({ kind: "ready-pr", prs: PRS, partial: "step 1 of 2: more" });
  assert.deepEqual(bodies(queueNextStep(partial, "A", { step: 1, of: 2, prs: [FIRST] }, 7)).at(-1), { kind: "requeued", why: "next-step" });
  const after = dismiss(finishedA(), "A", 5);
  assert.deepEqual(kinds(retry(enqueue(after, [ticket("A")], choice, 8), "A", 9)), kinds(enqueue(after, [ticket("A")], choice, 8)), "retrying a queued entry changes nothing");
  assert.deepEqual(kinds(enqueue(after, [ticket("A")], choice, 8)).slice(-2), ["dismissed", "queued"], "queued again reads after its earlier dismissal");
});

test("a pull request the log has seen opened is not logged again when a later round names it", () => {
  const queue = finish(markRunning(markStarting(retry(finishedA(), "A", 4), "A", 5, worker), "A", "w", "w:p"), "A", { kind: "reviewed", prs: PRS }, 6);
  assert.equal(logOf(queue, "A").filter((event) => event.kind === "pr-opened").length, 2);
  const again = finish(queue, "A", { kind: "reviewed", prs: PRS }, 7);
  assert.equal(logOf(again, "A").length, logOf(queue, "A").length, "finishing a run on the outcome it has already finished on is one ending");
});

test("a run that needs a person logs it once, and its answer when the person gives it", () => {
  let queue = markRunning(markStarting(enqueue(emptyQueue(1), [ticket("A")], choice, 1), "A", 2, worker), "A", "w1", "w1:p1");
  queue = observe(queue, "A", "blocked", "Allow this command?", 3);
  queue = observe(queue, "A", "blocked", "Allow this command?", 4);
  assert.deepEqual(bodies(queue).slice(-1), [{ kind: "needs-you", reason: "Allow this command?" }]);
  queue = observe(queue, "A", "working", undefined, 5);
  queue = observe(queue, "A", "working", undefined, 6);
  assert.deepEqual(bodies(queue).slice(-1), [{ kind: "answered", by: "terminal" }]);
  assert.deepEqual(kinds(queue), ["queued", "started", "needs-you", "answered"]);

  const asked = finishedA({ kind: "needs-human", reason: "which of the two?\nsecond line" });
  assert.deepEqual(bodies(asked).slice(-2), [{ kind: "finished", outcome: "needs-human", reason: "which of the two?" }, { kind: "needs-you", reason: "which of the two?" }]);
  const withPull = finishedA({ kind: "needs-human", reason: "which?" });
  const answered = respond({ ...withPull, entries: withPull.entries.map((entry) => ({ ...entry, review: PRS })) }, "A", 8);
  assert.deepEqual(bodies(answered).slice(-2), [{ kind: "answered", by: "respond" }, { kind: "round", cause: "asked", reason: null }]);
});

test("a start that is put back on the queue before its agent opens is not logged as a start, and a run that opens is, at the time it began", () => {
  const queued = enqueue(emptyQueue(1), [ticket("A")], choice, 1);
  const abandoned = planDone(markStarting(queued, "A", 2, worker), "A", { unattended: false, now: 3 });
  assert.deepEqual(kinds(abandoned), ["queued", "planned"], "its plan had reached the ticket, so the run went back on the queue");
  const refused = finish(markStarting(queued, "A", 2, worker), "A", { kind: "needs-human", reason: "a decision is open" }, 3);
  assert.deepEqual(kinds(refused), ["queued", "finished", "needs-you"], "an open decision refuses the start before an agent opens");
  const opened = markRunning(markStarting(queued, "A", 2, worker), "A", "w1", "w1:p1");
  assert.deepEqual(logOf(opened, "A").at(-1), { at: 2, kind: "started", model: "opus", effort: "high", instance: "agents" });
  assert.equal(logOf(markRunning(opened, "A", "w1", "w1:p1"), "A").length, 2, "a run that is running already is not started again");
});

test("a watch of a run that is no longer on the queue logs nothing for it", () => {
  const gone = observe(emptyQueue(1), "NBL-1", "blocked", "Allow?", 5);
  assert.equal(gone.runLog, undefined);
});

test("the board's hand-back at its cap of rounds logs that a person is needed, and a stale-block note does too, once", () => {
  const watched = (rounds: number): Queue => {
    const queue = finishedA();
    return { ...queue, entries: queue.entries.map((entry) => ({ ...entry, rounds })) };
  };
  const handed = feedbackRound(watched(MAX_FEEDBACK_ROUNDS), "A", "still red", 9);
  assert.deepEqual(kinds(handed).slice(-1), ["needs-you"]);
  assert.equal(kinds(feedbackRound(handed, "A", "still red", 10)).filter((kind) => kind === "needs-you").length, 1, "the same words again is no new event");
  const noted = recordStaleBlock(finishedA(), "A", "changes requested at h1 for 90 minutes with no push", 9);
  assert.deepEqual(bodies(noted).slice(-1), [{ kind: "needs-you", reason: "changes requested at h1 for 90 minutes with no push" }]);
  assert.equal(logOf(recordStaleBlock(noted, "A", "changes requested at h1 for 90 minutes with no push", 10), "A").length, logOf(noted, "A").length);
});

test("a talk session and a publish are logged, and a talk session taken off the queue is not a removed run", () => {
  const talking = talk(finishedA({ kind: "needs-human", reason: "which?" }), "A", 6);
  assert.deepEqual(bodies(talking).slice(-1), [{ kind: "round", cause: "talk", reason: null }]);
  assert.deepEqual(kinds(remove(talking, "A", 7)), kinds(talking), "the finished run it replaced is back, and nothing was removed");
  const publishing: Queue = { ...finishedA({ kind: "reviewed", prs: PRS }), publish: { id: "p1", keys: ["A"], prs: PRS, phase: "running", queuedAt: 8 } };
  const published = publishDone(publishing, ["https://slack/1"], 9);
  assert.deepEqual(bodies(published).slice(-1), [{ kind: "published", link: "https://slack/1" }]);
});

test("a ticket planned in a batch is logged as planned, with the ticket's address", () => {
  const queue = batchPlanDone(enqueue(emptyQueue(1), [ticket("A")], choice, 1), "A", "a11ign/agent-org", [], 5);
  assert.deepEqual(bodies(queue).at(-1), { kind: "planned", link: "https://linear.app/x/A" });
});

test("a reason is the first line of what was said, cut to a short line", () => {
  assert.equal(shortReason("\n  the first line  \nthe second"), "the first line");
  assert.equal(shortReason("   \n "), null);
  assert.equal(shortReason("x".repeat(500))?.length, 160);
});

/** Write the run's outcome file. */
function writeOutcome(made: ReturnType<typeof poolFixture>, key: string, outcome: Record<string, unknown>): void {
  mkdirSync(ticketDir(made.settings, key), { recursive: true });
  writeFileSync(join(ticketDir(made.settings, key), OUTCOME_FILE), JSON.stringify(outcome));
}

test("the pool logs what it does to a run: queued, started on this instance, finished, and dismissed", async () => {
  const made = poolFixture({ now: () => 100 });
  await made.pool.tick();
  made.status.set("t-nbf-1", "idle");
  writeOutcome(made, "NBF-1", { kind: "checked", reason: "nothing to change" });
  await made.pool.tick();
  assert.deepEqual(bodies(made.store.get(), "NBF-1"), [
    { kind: "queued", model: "sonnet", effort: "high", planFirst: false },
    { kind: "started", model: "sonnet", effort: "high", instance: made.settings.instance },
    { kind: "finished", outcome: "checked", reason: "nothing to change" },
  ]);
  await made.pool.dismiss("NBF-1");
  assert.equal(made.store.get().entries.length, 0);
  assert.deepEqual(logOf(made.store.get(), "NBF-1").at(-1), { at: 100, kind: "dismissed" });
});

test("a queued run the pool removes is logged as removed", async () => {
  const made = poolFixture({ now: () => 100 });
  await made.pool.remove("NBF-1");
  assert.deepEqual(logOf(made.store.get(), "NBF-1"), [{ at: 0, kind: "queued", model: "sonnet", effort: "high", planFirst: false }, { at: 100, kind: "removed" }]);
});
