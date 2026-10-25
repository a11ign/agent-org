// no-token: none -- the poller over stub seams and a clock a test sets
import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorkingNote } from "../queue/queue-entries-and-outcomes.ts";
import type { WaitSeams } from "./wait-read.ts";
import { POLL_EVERY_MS, judgedWait, pollWhenDue, type WaitPolls } from "./wait-watch.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const note = (over: Partial<WorkingNote> = {}): WorkingNote => ({ reason: "r", at: 1000, waits: [{ kind: "fleetJob", id: "fj-1" }, { kind: "fleetJob", id: "fj-2" }], ...over });

/** Seams whose fleet status answers per job, counting each ask. */
function seams(states: Record<string, string>) {
  const asked: string[] = [];
  const stubs: WaitSeams = { codeHost: {} as WaitSeams["codeHost"], source: {}, fleetJobStatus: async (id) => { asked.push(id); return JSON.stringify({ state: states[id] }); } };
  return { stubs, asked };
}

test("A11-245: one read per unfinished item a minute; a finished item is not read again; the reading is there for a later call", async () => {
  const polls: WaitPolls = new Map();
  let clock = 0;
  const { stubs, asked } = seams({ "fj-1": "done", "fj-2": "running" });
  pollWhenDue(polls, "t-1", note(), () => clock, stubs);
  assert.equal(judgedWait(polls, "t-1", note()), null, "the read runs off the call: nothing is judged until it completes");
  await flush();
  assert.equal(judgedWait(polls, "t-1", note())?.verdict.outcome, "pending");
  assert.deepEqual(asked, ["fj-1", "fj-2"]);
  clock += POLL_EVERY_MS - 1;
  pollWhenDue(polls, "t-1", note(), () => clock, stubs);
  await flush();
  assert.equal(asked.length, 2, "inside a minute: no read");
  clock += 1;
  pollWhenDue(polls, "t-1", note(), () => clock, stubs);
  await flush();
  assert.deepEqual(asked.slice(2), ["fj-2"], "a minute on: only the unfinished item is read");
  assert.equal(judgedWait(polls, "t-1", note())?.readAt, POLL_EVERY_MS, "the reading says when its read began");
});

test("A11-245: a read under way is not started twice, and a reading belongs to the note it was taken for", async () => {
  const polls: WaitPolls = new Map();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const asked: string[] = [];
  const stubs: WaitSeams = { codeHost: {} as WaitSeams["codeHost"], source: {}, fleetJobStatus: async (id) => { asked.push(id); await held; return JSON.stringify({ state: "done" }); } };
  const one = note({ waits: [{ kind: "fleetJob", id: "fj-1" }] });
  pollWhenDue(polls, "t-1", one, () => 0, stubs);
  pollWhenDue(polls, "t-1", one, () => 10 * POLL_EVERY_MS, stubs);
  assert.deepEqual(asked, ["fj-1"], "the first read is still under way: a second is not started");
  release();
  await flush();
  assert.equal(judgedWait(polls, "t-1", one)?.verdict.outcome, "finished");
  assert.equal(judgedWait(polls, "t-1", note({ at: 2000 })), null, "a newer note has no reading yet");
});

test("A11-245: nothing is read for a note with no declared wait, one already woken, a repeat already stalled, or a wake herdr keeps refusing, and what was held is dropped", async () => {
  const polls: WaitPolls = new Map();
  const { stubs, asked } = seams({ "fj-1": "running", "fj-2": "running" });
  for (const over of [{ woke: { at: 1, why: "finished" as const } }, { repeat: true as const, stalled: true, woke: { at: 1, why: "finished" as const } }, { wakeTries: 3 }]) pollWhenDue(polls, "t-1", note(over), () => 0, stubs);
  assert.deepEqual(asked, []);
  pollWhenDue(polls, "t-9", note({ repeat: true, woke: { at: 1, why: "finished" } }), () => 0, stubs);
  await flush();
  assert.equal(asked.length, 2, "a repeat not yet judged is read, once, to see whether what it declares is over");
  pollWhenDue(polls, "t-1", note(), () => 0, stubs);
  await flush();
  assert.ok(polls.has("t-1"));
  pollWhenDue(polls, "t-1", { reason: "r", at: 1000 }, () => 0, stubs);
  assert.equal(polls.has("t-1"), false, "a run that no longer declares a wait holds no reading");
});
