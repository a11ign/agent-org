// no-token: gh -- herdr, the tracker and the clock are all injected; nothing is spawned
// A11-304: a transient error writing a run's result to the tracker is tried again; on 2026-10-26 A11-289 ended `done`, Linear's completion write failed with `fetch failed`, and the run went to Needs you with no question to answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runStatus, workingNote } from "./board-view/pull-status-and-notes.ts";
import { herdrName } from "./pool.ts";
import { doneComment } from "./pool-outcome.ts";
import { poolFixture } from "./pool-fixture.ts";
import { logOf } from "./queue/run-log.ts";
import { WRITE_GIVE_UP_MS, WRITE_RETRY_NOTE, isRetryableWrite, writeWait } from "./result-write-retry.ts";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
import { ticketDir } from "./ticket-paths.ts";
import type { Outcome } from "./queue/queue-entries-and-outcomes.ts";
import type { TicketSource } from "./source.ts";

const KEY = "NBF-1";
const DONE = { kind: "done", reason: "Dependabot's update had merged; every Done-when line holds on main", evidence: ["npm test: 12 pass"] };
const networkBlip = (code = "ECONNRESET") => new TypeError("fetch failed", { cause: Object.assign(new Error(`read ${code}`), { code }) });
const answered = (status: number, message: string) => Object.assign(new Error(message), { status });
const HOUR = 3_600_000;
/** The pool's clock starts ahead of the real one, so an outcome file the test writes now is older than a run that ends on it, as a worker's is on a real clock. */
const START = Date.now() + HOUR;
const settled = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

/** What the tracker does with the nth completion (from 1): throws, answers with a note, or takes it. */
type Attempt = (n: number) => string | void | Promise<string | void>;

/**
 * NBF-1's run, ended `done` as A11-289's was, over a tracker whose completion is `attempt`. `clock.now` is the pool's time, moved by `tick`. The first tick after the outcome is written is the first try.
 */
async function doneRun(attempt: Attempt, outcome: Record<string, unknown> = DONE, tickets: Record<string, unknown> = {}, tracker = createFakeTracker([fakeTicket(KEY)])) {
  const calls: number[] = [];
  const source: TicketSource = { ...tracker, complete: async (key, comment) => {
    calls.push(calls.length + 1);
    const note = await attempt(calls.length);
    if (typeof note === "string") return note;
    return tracker.complete!(key, comment);
  } };
  const clock = { now: START };
  const made = poolFixture({ keys: [KEY], max: 1, source, now: () => clock.now, tickets: { workingState: "In Progress", ...tickets } });
  await made.pool.tick();
  made.status.set(herdrName(KEY), "working");
  await made.pool.tick();
  writeFileSync(join(ticketDir(made.settings, KEY), "outcome.json"), JSON.stringify(outcome));
  made.status.set(herdrName(KEY), "idle");
  /** A tick, `after` milliseconds past the last, with the write it starts finished. */
  const tick = async (after = 0) => { clock.now += after; await made.pool.tick(); await settled(); };
  await tick();
  const log = () => logOf(made.store.get(), KEY);
  const reasonOf = (): string => { const done = made.entry(KEY).outcome; return done?.kind === "needs-human" ? done.reason : ""; };
  return { ...made, tracker, calls, tick, log, reasonOf, clock };
}

test("the first two completion writes fail on the network and the third succeeds: the ticket is completed, the outcome stays done, and no person was asked", async () => {
  const run = await doneRun((n) => { if (n <= 2) throw networkBlip(); });
  assert.equal(run.calls.length, 1);
  assert.deepEqual([run.entry(KEY).phase, run.entry(KEY).outcome], ["running", undefined], "not ended, and no person");
  assert.deepEqual(workingNote(run.entry(KEY)), { text: WRITE_RETRY_NOTE, stalled: false, waiting: false });
  assert.equal(WRITE_RETRY_NOTE, "recording the result in the tracker (retrying)");
  assert.notEqual(runStatus(run.entry(KEY)), "needs-you");
  await run.tick(writeWait(1) - 1);
  assert.equal(run.calls.length, 1, "the wait is not over, so the tracker is not asked");
  await run.tick(1);
  assert.equal(run.calls.length, 2);
  assert.notEqual(runStatus(run.entry(KEY)), "needs-you");
  await run.tick(writeWait(2));
  assert.equal(run.calls.length, 3);
  assert.equal(run.tracker.ticketOf(KEY)?.status, "Done");
  assert.deepEqual([run.entry(KEY).phase, run.entry(KEY).outcome?.kind, run.entry(KEY).working], ["finished", "done", undefined]);
  assert.equal(run.log().some((event) => event.kind === "needs-you"), false, "no Needs-you event in the run log");
});

test("a completion that moved the ticket and then failed on the network is not lost: the retry posts the worker's evidence as a comment, and completes nothing twice", async () => {
  const moved = createFakeTracker([fakeTicket(KEY)]);
  const run = await doneRun(async (n) => { if (n === 1) { await moved.complete!(KEY, "moved, comment lost"); throw networkBlip(); } }, DONE, {}, moved);
  assert.equal(moved.ticketOf(KEY)?.status, "Done", "the move went through before the failure");
  await run.tick(writeWait(1));
  assert.equal(run.calls.length, 1, "complete is not called again for a ticket that is already finished");
  assert.deepEqual(moved.comments.map(({ text }) => text), ["moved, comment lost", doneComment(DONE as { reason: string; evidence: string[] })]);
  assert.equal(run.entry(KEY).outcome?.kind, "done");
});

test("each kind of transient error is tried again: fetch failed, ECONNRESET, ETIMEDOUT, a 5xx and a 429", async () => {
  const blips = [new TypeError("fetch failed"), networkBlip("ECONNRESET"), networkBlip("ETIMEDOUT"), answered(503, "Linear answered 503: upstream"), answered(429, "Linear answered 429: rate limited")];
  for (const blip of blips) {
    const run = await doneRun((n) => { if (n === 1) throw blip; });
    assert.equal(run.entry(KEY).outcome, undefined, `${blip.message}: not ended`);
    await run.tick(writeWait(1));
    assert.equal(run.entry(KEY).outcome?.kind, "done", blip.message);
    assert.equal(run.tracker.ticketOf(KEY)?.status, "Done", blip.message);
  }
});

test("the worker's outcome is never rewritten: the run log ends done, and each failed write is an event of its own", async () => {
  const run = await doneRun((n) => { if (n <= 2) throw networkBlip(); });
  await run.tick(writeWait(1));
  await run.tick(writeWait(2));
  const kinds = run.log().map((event) => event.kind);
  assert.deepEqual(kinds.filter((kind) => kind === "tracker-write"), ["tracker-write", "tracker-write"]);
  const writes = run.log().flatMap((event) => (event.kind === "tracker-write" ? [[event.step, event.failures, event.error]] : []));
  assert.deepEqual(writes, [["retrying", 1, "fetch failed (ECONNRESET)"], ["retrying", 2, "fetch failed (ECONNRESET)"]]);
  const finished = run.log().filter((event) => event.kind === "finished");
  assert.deepEqual(finished.map((event) => (event.kind === "finished" ? event.outcome : "")), ["done"], "the run finished once, as the worker said");
  assert.equal(kinds.includes("needs-you"), false);
});

test("a refusal for the request itself (a 4xx that is not 429) ends Needs you at once, under the access item, with the tracker's words and one call", async () => {
  const refusal = answered(400, "Linear answered 400: Argument Validation Error");
  const run = await doneRun(() => { throw refusal; });
  assert.equal(run.calls.length, 1);
  const outcome = run.entry(KEY).outcome as Extract<Outcome, { kind: "needs-human" }>;
  assert.deepEqual([outcome.kind, outcome.escalation], ["needs-human", "access"]);
  assert.equal(run.reasonOf(), `money, access or security — ${KEY} could not be completed (${refusal.message}): ${DONE.reason}`);
  assert.equal(run.log().some((event) => event.kind === "tracker-write" && event.step === "refused"), true);
  await run.tick(writeWait(1));
  assert.equal(run.calls.length, 1, "no retry");
});

test("a refusal after network failures goes to a person at once, naming the refusal", async () => {
  const refusal = answered(403, "Linear answered 403: forbidden");
  const run = await doneRun((n) => { throw n === 1 ? networkBlip() : refusal; });
  await run.tick(writeWait(1));
  assert.equal(run.calls.length, 2);
  assert.match(run.reasonOf(), /Linear answered 403: forbidden/);
  assert.equal((run.entry(KEY).outcome as { escalation?: string }).escalation, "access");
});

test("a tracker that has no state to complete the ticket in ends Needs you under the access item with the tracker's note, and is not tried again", async () => {
  const run = await doneRun(() => `${KEY}'s team has no completed state, so it stays in In Progress`);
  assert.equal(run.calls.length, 1);
  assert.equal(run.reasonOf(), `money, access or security — ${KEY} was not completed (${KEY}'s team has no completed state, so it stays in In Progress): ${DONE.reason}`);
  assert.equal((run.entry(KEY).outcome as { escalation?: string }).escalation, "access");
});

test("a transient error that lasts more than an hour ends Needs you under the access item, with the tracker's words and the worker's reason; before the hour it is still tried again", async () => {
  const failure = networkBlip();
  const run = await doneRun(() => { throw failure; });
  const started = run.clock.now;
  while (run.clock.now - started < HOUR - 1 && run.entry(KEY).outcome === undefined) {
    await run.tick(Math.min(writeWait(run.calls.length), HOUR - 1 - (run.clock.now - started)));
    assert.equal(run.entry(KEY).outcome, undefined, `still tried again ${run.clock.now - started} ms in`);
    assert.notEqual(runStatus(run.entry(KEY)), "needs-you");
  }
  const tries = run.calls.length;
  assert.ok(tries > 4, "tried more than the first few times");
  await run.tick(1);
  await run.tick(writeWait(tries));
  const outcome = run.entry(KEY).outcome as Extract<Outcome, { kind: "needs-human" }>;
  assert.deepEqual([outcome.kind, outcome.escalation], ["needs-human", "access"]);
  assert.match(outcome.reason, new RegExp(`^money, access or security — ${KEY} could not be completed \\(fetch failed \\(ECONNRESET\\); it has failed since .+, more than an hour\\): ${DONE.reason}$`));
  assert.equal(run.log().some((event) => event.kind === "tracker-write" && event.step === "gave-up"), true);
  assert.ok(WRITE_GIVE_UP_MS === HOUR);
  const after = run.calls.length;
  await run.tick(HOUR);
  assert.equal(run.calls.length, after, "an ended run is not tried again");
});

test("a run waiting to try its write again is never marked stalled or prompted, however long its agent has been idle", async () => {
  const STALL_MINUTES = 5;
  const run = await doneRun(() => { throw networkBlip(); }, DONE, { stallMinutes: STALL_MINUTES });
  // The board's own tries come 10 minutes apart once the waits have grown, so the agent is idle for longer than the stall watch waits, between them.
  for (let minute = 0; minute < 40; minute += 1) await run.tick(60_000);
  assert.equal(run.entry(KEY).outcome, undefined, "still waiting, within the hour");
  assert.equal(run.entry(KEY).working?.stalled, undefined);
  assert.equal(run.entry(KEY).working?.reason, WRITE_RETRY_NOTE);
  assert.equal(run.herdr.calls.filter((args) => args.includes("prompt")).length, 0, "the agent is never prompted");
});

test("a worker that writes working while a write waits to be tried again drops the wait: its next done is written at once", async () => {
  const run = await doneRun((n) => { if (n === 1) throw networkBlip(); });
  const dir = ticketDir(run.settings, KEY);
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "working", reason: "rechecking" }));
  await run.tick(1);
  assert.equal(run.calls.length, 1, "working writes nothing");
  writeFileSync(join(dir, "outcome.json"), JSON.stringify(DONE));
  await run.tick(1);
  assert.equal(run.calls.length, 2, "written without waiting out the earlier wait");
  assert.equal(run.entry(KEY).outcome?.kind, "done");
});

test("a proposed edit whose ticket cannot be read for a moment is tried again and recorded with the worker's own outcome", async () => {
  const tracker = createFakeTracker([fakeTicket(KEY)]);
  let reads = 0;
  let failing = false;
  const source: TicketSource = { ...tracker, read: async (key) => { reads += 1; if (failing) { failing = false; throw networkBlip(); } return tracker.read(key); } };
  const clock = { now: START };
  const made = poolFixture({ keys: [KEY], max: 1, source, now: () => clock.now });
  await made.pool.tick();
  made.status.set(herdrName(KEY), "working");
  await made.pool.tick();
  const edit = { title: "A better title", why: "the title names the wrong thing" };
  writeFileSync(join(ticketDir(made.settings, KEY), "outcome.json"), JSON.stringify({ kind: "checked", reason: "nothing to change", edit }));
  made.status.set(herdrName(KEY), "idle");
  failing = true;
  const tick = async (after: number) => { clock.now += after; await made.pool.tick(); await settled(); };
  await tick(0);
  const readsBefore = reads;
  assert.deepEqual([made.entry(KEY).outcome, made.entry(KEY).working?.reason], [undefined, WRITE_RETRY_NOTE]);
  await tick(writeWait(1));
  assert.ok(reads > readsBefore);
  assert.equal(made.entry(KEY).outcome?.kind, "checked", "the worker's outcome, as it wrote it");
});

test("only the network, a 5xx and a 429 are worth trying again", () => {
  for (const err of [new TypeError("fetch failed"), networkBlip(), answered(500, "x"), answered(502, "x"), answered(429, "x")]) assert.equal(isRetryableWrite(err), true, err.message);
  for (const err of [answered(400, "x"), answered(401, "x"), answered(403, "x"), answered(404, "x"), new Error("Linear refused the update")]) assert.equal(isRetryableWrite(err), false, err.message);
});

test("a worker's own stop with a proposed edit that cannot be recorded keeps the item it named, and is not relabelled as access", async () => {
  const tracker = createFakeTracker([fakeTicket(KEY)]);
  const source: TicketSource = { ...tracker, read: async (key) => { if (reading) throw answered(400, "Linear answered 400: bad request"); return tracker.read(key); } };
  let reading = false;
  const made = poolFixture({ keys: [KEY], max: 1, source, now: () => START });
  await made.pool.tick();
  made.status.set(herdrName(KEY), "working");
  await made.pool.tick();
  writeFileSync(join(ticketDir(made.settings, KEY), "outcome.json"), JSON.stringify({ kind: "needs-human", reason: "which colour?", escalation: "reserved", edit: { title: "T", why: "w" } }));
  made.status.set(herdrName(KEY), "idle");
  reading = true;
  await made.pool.tick();
  await settled();
  const outcome = made.entry(KEY).outcome as Extract<Outcome, { kind: "needs-human" }>;
  assert.deepEqual([outcome.kind, outcome.escalation], ["needs-human", "reserved"]);
  assert.equal(outcome.reason, "reserved to the person — which colour? (the worker's proposed edit to NBF-1's text could not be recorded: Linear answered 400: bad request)");
});
