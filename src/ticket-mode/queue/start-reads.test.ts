// A11-364: what a start is decided on -- the last known blockers and plan paths, their age, and the reason a run is held when they are not known
import { test } from "node:test";
import assert from "node:assert/strict";
import { BLOCKERS_MAX_AGE_MS, READ_RETRY_MS, blockersFailureNote, blockersHold, blockersStale, pathsHold, startReadHold, type ReadState } from "./start-reads.ts";
import { recordBlockers, recordPaths, recordPathsFailure } from "./queue-transitions.ts";
import { dueBlockerKeys, duePaths, recordBlockersFailure } from "./queue-start-reads.ts";
import { enqueue } from "./queue-entries-and-outcomes.ts";
import { emptyQueue, nextStarts } from "../queue.ts";
import type { Ticket } from "../source.ts";

const NOW = Date.UTC(2026, 9, 27, 22, 5);
const queued: ReadState = { phase: "queued", blockers: [], blockersReadAt: NOW, paths: [] };
const ticket = (key: string) => ({ key, title: key, description: "", url: `https://linear.app/x/${key}`, branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
const queueOf = (...keys: string[]) => ({ ...enqueue(emptyQueue(3), keys.map(ticket), { model: "sonnet", effort: "high" }, 0), paused: false });

test("blockers never read hold the run, with the failure when there is one", () => {
  assert.equal(blockersHold({ phase: "queued" }, NOW), "blockers unread: not read yet");
  assert.equal(blockersHold({ phase: "queued", blockersFailure: { error: "Linear answered 503", retryAt: NOW + READ_RETRY_MS } }, NOW), "blockers unread: Linear answered 503, retrying at 22:05Z");
});

test("blockers read within the limit hold nothing, and past it hold the run until they are read again", () => {
  assert.equal(blockersStale(queued, NOW + BLOCKERS_MAX_AGE_MS), false, "exactly the limit is still known");
  assert.equal(blockersStale(queued, NOW + BLOCKERS_MAX_AGE_MS + 1), true);
  assert.equal(blockersHold(queued, NOW + BLOCKERS_MAX_AGE_MS), null);
  assert.equal(blockersHold(queued, NOW + BLOCKERS_MAX_AGE_MS + 1), "blockers last read at 22:05Z, older than 30 minutes: reading them again");
  assert.equal(blockersHold({ ...queued, blockersFailure: { error: "timed out", retryAt: NOW + BLOCKERS_MAX_AGE_MS } }, NOW + BLOCKERS_MAX_AGE_MS + 1),
    "blockers last read at 22:05Z, older than 30 minutes: timed out, retrying at 22:35Z");
  assert.equal(blockersHold(queued), null, "without a clock the age is not judged");
});

test("blockers read at a time nobody recorded are too old to start on", () => {
  assert.equal(blockersStale({ phase: "queued", blockers: [] }, NOW), true);
});

test("a plan never read holds the run, and a plan that failed says why and when it is asked again", () => {
  assert.equal(pathsHold({ phase: "queued", blockers: [] }), "plan unread: not read yet");
  assert.equal(pathsHold({ phase: "queued", pathsFailure: "the link is gone", pathsRetryAt: NOW }), "plan unread: the link is gone, retrying at 22:05Z");
  assert.equal(pathsHold({ ...queued, paths: [] }), null);
  assert.equal(pathsHold({ phase: "queued", review: [] }), null, "a review round keeps the paths of the run it continues");
});

test("a run that is not queued is held by no read", () => {
  assert.equal(startReadHold({ phase: "running" }, NOW), null);
});

test("the board's note of a failed blocker read needs no clock, and a read not made yet says nothing", () => {
  assert.equal(blockersFailureNote({ phase: "queued" }), null);
  assert.equal(blockersFailureNote({ phase: "queued", blockersFailure: { error: "x", retryAt: NOW } }), "blockers unread: x, retrying at 22:05Z");
  assert.equal(blockersFailureNote({ ...queued, blockersFailure: { error: "x", retryAt: NOW + 60_000 } }), null, "blockers known and fresh when the read failed: nothing holds the run");
  assert.equal(blockersFailureNote({ ...queued, blockersFailure: { error: "x", retryAt: NOW + BLOCKERS_MAX_AGE_MS + 1 } }), "blockers last read at 22:05Z, older than 30 minutes: x, retrying at 22:35Z");
});

test("blockers are due when unread or too old, and not while a failed read waits out its retry; plans are due when unread and past their retry", () => {
  const unread = queueOf("A", "B");
  assert.deepEqual(dueBlockerKeys(unread, NOW), ["A", "B"]);
  const failed = recordBlockersFailure(unread, ["A"], "503", NOW + READ_RETRY_MS);
  assert.deepEqual(dueBlockerKeys(failed, NOW), ["B"], "A waits for its retry");
  assert.deepEqual(dueBlockerKeys(failed, NOW + READ_RETRY_MS), ["A", "B"]);
  const read = recordBlockers(unread, new Map([["A", []], ["B", []]]), NOW);
  assert.deepEqual(dueBlockerKeys(read, NOW + BLOCKERS_MAX_AGE_MS), []);
  assert.deepEqual(dueBlockerKeys(read, NOW + BLOCKERS_MAX_AGE_MS + 1), ["A", "B"]);
  const planFailed = recordPathsFailure(unread, new Map([["A", "gone"]]), NOW + READ_RETRY_MS);
  assert.deepEqual(duePaths(planFailed, NOW).map((e) => e.ticket.key), ["B"]);
  assert.deepEqual(duePaths(planFailed, NOW + READ_RETRY_MS).map((e) => e.ticket.key), ["A", "B"]);
  assert.deepEqual(duePaths(recordPaths(planFailed, new Map([["A", []]])), NOW + READ_RETRY_MS).map((e) => e.ticket.key), ["B"], "a read clears the retry");
});

test("a read clears the failure the last one left, and a failure keeps the blockers a run has", () => {
  const known = recordBlockers(queueOf("A"), new Map([["A", []]]), NOW);
  const failed = recordBlockersFailure(known, ["A"], "503", NOW + READ_RETRY_MS);
  assert.deepEqual([failed.entries[0].blockers, failed.entries[0].blockersReadAt], [[], NOW], "kept");
  const again = recordBlockers(failed, new Map([["A", []]]), NOW + 60_000);
  assert.deepEqual([again.entries[0].blockersFailure, again.entries[0].blockersReadAt], [undefined, NOW + 60_000]);
});

test("nextStarts holds a run whose blockers or plan are not known, and it takes no slot from one that can start", () => {
  const base = queueOf("A", "B", "C");
  const known = recordPaths(recordBlockers(base, new Map([["C", []]]), NOW), new Map([["C", []]]));
  assert.deepEqual(nextStarts({ ...known, max: 1 }, 0, 4, NOW).map((e) => e.ticket.key), ["C"], "A and B are unread and ahead of C in the queue: C takes the one slot");
  assert.deepEqual(nextStarts({ ...known, max: 1 }, 0, 4, NOW + BLOCKERS_MAX_AGE_MS + 1).map((e) => e.ticket.key), [], "C's blockers are too old at that time");
  assert.deepEqual(nextStarts({ ...known, max: 3 }, 0, 4).map((e) => e.ticket.key), ["A", "B", "C"], "without a clock nothing about what was read is judged");
});

test("a read of blockers keeps the head last read for the same blocker on the same branch, and takes a head it is given", () => {
  const blocker = { key: "B", state: "started", status: "In Progress", branch: "b-1", pulls: {} };
  const read = recordBlockers(queueOf("A"), new Map([["A", [{ ...blocker, head: "abc" }]]]), NOW);
  assert.equal(recordBlockers(read, new Map([["A", [blocker]]]), NOW + 1).entries[0].blockers?.[0].head, "abc", "same branch: kept until the heads are read again");
  assert.equal(recordBlockers(read, new Map([["A", [{ ...blocker, branch: "b-2" }]]]), NOW + 1).entries[0].blockers?.[0].head, undefined, "another branch: not the same head");
  assert.equal(recordBlockers(read, new Map([["A", [{ ...blocker, head: "def" }]]]), NOW + 1).entries[0].blockers?.[0].head, "def");
});
