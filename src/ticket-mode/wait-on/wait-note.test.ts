// no-token: none -- the pure marks of a waiting note, over a clock a test sets
import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorkingNote } from "../queue/queue-entries-and-outcomes.ts";
import { BACKGROUND_WAIT_MS, MAX_WAKE_TRIES, declaredMark, deadlineOf, repeatOf, undeclaredMark, wakeRefused } from "./wait-note.ts";
import { type Judged, judgeWaits } from "./wait-verdict.ts";
import type { Reading, Wait } from "./wait-types.ts";

const MIN = 60_000;
const STALL = 30 * MIN;
const AT = Date.UTC(2026, 9, 25, 10, 0);
const JOB: Wait = { kind: "fleetJob", id: "fj-1" };
const RUN: Wait = { kind: "ciRun", repository: "a11ign/x", runId: 9 };

const note = (over: Partial<WorkingNote> = {}): WorkingNote => ({ reason: "r", at: AT, idleSince: AT, waits: [JOB], ...over });
const pending = (wait: Wait): Reading => ({ wait: wait as never, status: "pending", job: { state: "running", reason: null, results: null, progress: { done: 4, total: 6 }, estimatedFinish: null } }) as Reading;
const finished = (wait: Wait): Reading => ({ wait: wait as never, status: "finished", job: { state: "done", reason: null, results: "/r", progress: null, estimatedFinish: null } }) as Reading;
const failed = (wait: Wait): Reading => ({ wait: wait as never, status: "failed", job: { state: "failed", reason: "box offline", results: null, progress: null, estimatedFinish: null } }) as Reading;
const judged = (readings: Reading[], readAt = AT): Judged => ({ verdict: judgeWaits(readings), readAt, text: "Waiting on fleet job fj-1 (4 of 6 pages)" });

test("A11-245: the deadline is `until`, or three hours after the note", () => {
  assert.equal(deadlineOf({ at: AT }), AT + BACKGROUND_WAIT_MS);
  assert.equal(deadlineOf({ at: AT, until: AT + 5 * 60 * MIN }), AT + 300 * MIN);
});

test("A11-245: a declared wait inside its deadline is waiting with the card's line, whatever the idle time, and not woken", () => {
  const inside = declaredMark(note(), AT + 100 * MIN, STALL, judged([pending(JOB)]));
  assert.deepEqual([inside.waiting, inside.stalled, inside.woke, inside.waitText], [true, undefined, undefined, "Waiting on fleet job fj-1 (4 of 6 pages)"]);
  const unread = declaredMark(note(), AT, STALL, null);
  assert.equal(unread.waitText, "Waiting on fleet job fj-1", "before any reading, the card names what it waits on");
});

test("A11-245: the wait ending wakes once: all finished, or any failed, with the items it told the worker had ended", () => {
  const done = declaredMark(note({ waits: [JOB, RUN] }), AT + MIN, STALL, judged([finished(JOB), finished(RUN)]));
  assert.deepEqual([done.woke, done.ended, done.idleSince], [{ at: AT + MIN, why: "finished" }, [JOB, RUN], AT + MIN]);
  const one = declaredMark(note({ waits: [JOB, RUN] }), AT + MIN, STALL, judged([finished(JOB), pending(RUN)]));
  assert.equal(one.woke, undefined, "one of two finished: no wake");
  const bad = declaredMark(note({ waits: [JOB, RUN] }), AT + MIN, STALL, judged([failed(JOB), pending(RUN)]));
  assert.deepEqual([bad.woke?.why, bad.ended], ["failed", [JOB]], "any failed wakes at once");
  const again = declaredMark({ ...done }, AT + 2 * MIN, STALL, judged([finished(JOB), finished(RUN)]));
  assert.deepEqual(again.woke, done.woke, "a note already woken keeps its wake: it is not set again");
});

test("A11-245: past its deadline with items pending, a reading taken before the deadline wakes nothing and one at or after it wakes once, naming what is pending", () => {
  const until = AT + 10 * MIN;
  const late = (readAt: number) => declaredMark(note({ until, waits: [JOB, RUN] }), until + MIN, STALL, judged([finished(JOB), pending(RUN)], readAt));
  assert.equal(late(until - 1).woke, undefined, "a reading from before the deadline says nothing of it");
  assert.equal(late(until - 1).waiting, true, "and the run is still shown as waiting");
  assert.deepEqual(late(until).woke, { at: until + MIN, why: "late", on: "CI run a11ign/x#9" }, "only the pending item is named");
  const woken = late(until);
  const grace = declaredMark({ ...note({ until }), woke: woken.woke, idleSince: until + MIN }, until + MIN + STALL - 1, STALL, null);
  assert.deepEqual([grace.stalled, grace.waiting], [undefined, undefined], "inside the grace after the prompt: neither stalled nor waiting");
  const stalled = declaredMark({ ...note({ until }), woke: woken.woke, idleSince: until + MIN }, until + MIN + STALL, STALL, null);
  assert.equal(stalled.stallReason, `waited past ${new Date(until).toISOString()} on CI run a11ign/x#9`);
});

test("A11-245: a run woken for a finished wait that sits idle with no newer outcome is stalled after the idle grace, with no reason beyond idleness", () => {
  const woken = { ...note(), woke: { at: AT, why: "finished" as const }, ended: [JOB] };
  assert.equal(declaredMark(woken, AT + STALL - 1, STALL, null).stalled, undefined);
  const stalled = declaredMark(woken, AT + STALL, STALL, null);
  assert.deepEqual([stalled.stalled, stalled.stallReason], [true, undefined]);
});

test("A11-245: a new note that declares only items the worker was just told had ended is a repeat, and is stalled for it, never woken", () => {
  const told = note({ woke: { at: AT, why: "finished" }, ended: [JOB, RUN] });
  assert.deepEqual(repeatOf(told, [JOB]), { repeat: true, ended: [JOB, RUN], woke: told.woke }, "it carries the wake, so a second identical rewrite is a repeat too");
  assert.deepEqual(repeatOf(told, [JOB, { kind: "fleetJob", id: "fj-2" }]), {}, "one new item: a new wait");
  assert.deepEqual(repeatOf(note({ woke: { at: AT, why: "late", on: "x" } }), [JOB]), {}, "a late prompt told it nothing had ended");
  assert.deepEqual(repeatOf(undefined, [JOB]), {}, "the first note is never a repeat");
  assert.deepEqual(repeatOf(told, undefined), {}, "an undeclared wait is never one");
  const marked = declaredMark(note({ repeat: true, ended: [JOB] }), AT + MIN, STALL, judged([finished(JOB)]));
  assert.deepEqual([marked.stalled, marked.stallReason, marked.woke], [true, "re-declared a wait that had already ended: fleet job fj-1", undefined]);
});

test("A11-245: a repeat is read once before it is judged: still over, it is stalled; not over (a CI run rerun under the same ID), it is an ordinary wait and wakes the worker when it ends", () => {
  const told = { at: AT, why: "failed" as const };
  const repeat = note({ repeat: true, ended: [JOB], woke: told });
  const unread = declaredMark(repeat, AT + MIN, STALL, null);
  assert.deepEqual([unread.waiting, unread.stalled, unread.repeat], [true, undefined, true], "before any reading it is waiting, and still marked");
  const rerun = declaredMark(repeat, AT + MIN, STALL, judged([pending(JOB)]));
  assert.deepEqual([rerun.waiting, rerun.stalled, rerun.repeat, rerun.woke], [true, undefined, undefined, undefined], "pending: no longer a repeat, and not woken");
  const ended = declaredMark(rerun, AT + 2 * MIN, STALL, judged([finished(JOB)]));
  assert.deepEqual([ended.woke?.why, ended.stalled], ["finished", undefined], "and when it ends the worker is woken as for any wait");
  const still = declaredMark(repeat, AT + MIN, STALL, judged([failed(JOB)]));
  assert.deepEqual([still.stalled, still.repeat], [true, true], "still over: stalled, and still a repeat");
});

test("A11-245: a refused wake is not recorded as sent: the try is counted, and after three the run is stalled with the refusal", () => {
  const woke = { at: AT, why: "finished" as const };
  const sent = note({ woke, ended: [JOB] });
  const once = wakeRefused(sent, "the pane is busy", woke);
  assert.deepEqual([once.woke, once.wakeTries, once.wakeRefusal], [undefined, 1, "the pane is busy"]);
  assert.equal(wakeRefused(note({ woke: { at: AT + 1, why: "finished" } }), "x", woke).wakeTries, undefined, "a wake that is not the refused one is left alone");
  const spent = declaredMark({ ...once, wakeTries: MAX_WAKE_TRIES }, AT + MIN, STALL, judged([finished(JOB)]));
  assert.deepEqual([spent.stalled, spent.stallReason, spent.woke], [true, "could not wake the worker: the pane is busy", undefined]);
});

test("A11-236: an undeclared wait is waiting inside its deadline, woken once at it, and stalled only after the idle grace, naming what it waited on", () => {
  const plain = { reason: "r", at: AT, idleSince: AT, waitingOn: "the capture shells" };
  assert.equal(undeclaredMark(plain, AT + BACKGROUND_WAIT_MS - 1, STALL).waiting, true);
  const woken = undeclaredMark(plain, AT + BACKGROUND_WAIT_MS, STALL);
  assert.deepEqual([woken.woke, woken.waiting, woken.stalled], [{ at: AT + BACKGROUND_WAIT_MS, why: "late" }, undefined, undefined]);
  const stalled = undeclaredMark({ ...woken }, AT + BACKGROUND_WAIT_MS + STALL, STALL);
  assert.equal(stalled.stallReason, `waited past ${new Date(AT + BACKGROUND_WAIT_MS).toISOString()} on the capture shells`);
  assert.equal(undeclaredMark({ reason: "r", at: AT, idleSince: AT }, AT + BACKGROUND_WAIT_MS, STALL).woke?.why, "late", "live work with no job named is woken the same way");
});

test("A11-236: a late wake herdr keeps refusing is offered three times for an undeclared wait too, and then the run is stalled with the refusal", () => {
  const refused = { reason: "r", at: AT, idleSince: AT, waitingOn: "the capture shells", wakeTries: MAX_WAKE_TRIES, wakeRefusal: "no such agent" };
  const marked = undeclaredMark(refused, AT + BACKGROUND_WAIT_MS, STALL);
  assert.deepEqual([marked.stalled, marked.stallReason, marked.woke], [true, "could not wake the worker: no such agent", undefined]);
  assert.equal(undeclaredMark({ ...refused, wakeTries: MAX_WAKE_TRIES - 1 }, AT + BACKGROUND_WAIT_MS, STALL).woke?.why, "late", "two refusals: still offered");
});
