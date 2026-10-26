// no-token: gh -- the queue's view, in memory; nothing is read or spawned
// A11-272: the wait cycles among the tickets on the board: blockers, declared waits and the files a run holds, read as one graph
import { test } from "node:test";
import assert from "node:assert/strict";
import { cycleNote, cycleSentence, waitCycles } from "./wait-cycles.ts";
import { overlapWait } from "./overlap-hold.ts";
import type { ViewEntry } from "./view-types-and-filters.ts";

const FILES = ["lab:middleware/runtime/main.py", "lab:middleware/src/"];
const entry = (key: string, over: Record<string, unknown> = {}) => ({ ticket: { key }, phase: "queued", ...over }) as unknown as ViewEntry;
const blocker = (key: string, state = "started") => ({ key, state, status: "In Progress" });
const parkedOn = (...waits: Record<string, unknown>[]) => ({ phase: "running", working: { reason: "w", at: 1, waiting: true, waits } });

test("A11-272: the A11-231/A11-229 shape is one cycle: a run waits on a ticket that is held behind the run's files, though the hold is lifted for it", () => {
  const entries = [entry("A11-231", { ...parkedOn({ kind: "ticket", key: "A11-229" }), paths: FILES }), entry("A11-229", { paths: FILES })];
  const [cycle, ...rest] = waitCycles(entries);
  assert.equal(rest.length, 0);
  assert.deepEqual([cycle.id, cycle.keys, cycle.loop], ["A11-229,A11-231", ["A11-229", "A11-231"], ["A11-229", "A11-231", "A11-229"]]);
  assert.deepEqual(cycle.edges.map(({ from, to, kind }) => `${from} ${kind} ${to}`).sort(), ["A11-229 files A11-231", "A11-231 waits-on A11-229"]);
  assert.equal(cycleSentence(cycle), "Wait cycle A11-229 → A11-231 → A11-229: A11-229 is held behind A11-231's files; A11-231's worker waits on A11-229.");
});

test("A11-272: once the run is queued behind its ticket and the ticket runs, there is no cycle", () => {
  const entries = [entry("A11-231", { stoppedForBlocker: { at: 1, keys: ["A11-229"] }, paths: FILES }), entry("A11-229", { phase: "running", paths: FILES })];
  assert.deepEqual(waitCycles(entries), []);
});

test("A11-272: two queued tickets that block each other are a cycle of blockers alone", () => {
  const entries = [entry("A-1", { blockers: [blocker("B-1")] }), entry("B-1", { blockers: [blocker("A-1")] })];
  const [cycle] = waitCycles(entries);
  assert.deepEqual(cycle.edges.map(({ kind }) => kind), ["blocked-by", "blocked-by"]);
});

test("A11-272: a cycle of three tickets is one cycle, its loop starting at the smallest key; a ticket outside it is not in it", () => {
  const entries = [
    entry("C-1", { blockers: [blocker("A-1")] }), entry("A-1", { blockers: [blocker("B-1")] }), entry("B-1", { blockers: [blocker("C-1")] }),
    entry("D-1", { blockers: [blocker("A-1")] }),
  ];
  const cycles = waitCycles(entries);
  assert.equal(cycles.length, 1);
  assert.deepEqual([cycles[0].keys, cycles[0].loop], [["A-1", "B-1", "C-1"], ["A-1", "B-1", "C-1", "A-1"]]);
  assert.equal(cycleNote(entries[3], entries), null);
});

test("A11-272: a blocker the tracker settled holds nothing, so it makes no cycle", () => {
  const entries = [entry("A-1", { blockers: [blocker("B-1", "completed")] }), entry("B-1", { blockers: [blocker("A-1")] })];
  assert.deepEqual(waitCycles(entries), []);
});

test("A11-272: a fleet job or a CI run names no ticket, so a run parked on one is in no cycle", () => {
  const entries = [entry("A-1", { ...parkedOn({ kind: "fleetJob" }, { kind: "ciRun" }), paths: FILES }), entry("B-1", { paths: FILES })];
  assert.deepEqual(waitCycles(entries), [], "B-1 is held behind A-1's files, and A-1 waits on neither a ticket nor a pull request");
});

test("A11-272: a pull request wait is an edge to the ticket whose run has the pull request open", () => {
  const url = "https://github.com/a11ign/lab/pull/7";
  const owner = { outcome: { kind: "ready-pr", prs: [{ url }] } };
  const waiter = entry("A-1", parkedOn({ kind: "pullRequest", url }));
  const blockedByWaiter = entry("C-1", { ...owner, blockers: [blocker("A-1")] });
  const [cycle] = waitCycles([waiter, blockedByWaiter]);
  assert.deepEqual(cycle.edges.map(({ from, to, kind }) => `${from} ${kind} ${to}`), ["A-1 waits-on C-1", "C-1 blocked-by A-1"]);
  assert.deepEqual(waitCycles([waiter, entry("C-1", owner)]), [], "a pull request whose ticket waits on nothing is no cycle");
});

test("A11-272: the card of a ticket in a cycle names it; the card of another ticket says nothing", () => {
  const entries = [entry("A11-231", { ...parkedOn({ kind: "ticket", key: "A11-229" }), paths: FILES }), entry("A11-229", { paths: FILES }), entry("A11-300")];
  assert.equal(cycleNote(entries[0], entries), "in a wait cycle: A11-229 → A11-231 → A11-229");
  assert.equal(cycleNote(entries[1], entries), "in a wait cycle: A11-229 → A11-231 → A11-229");
  assert.equal(cycleNote(entries[2], entries), null);
});

test("A11-272: a worker woken from its wait waits on no ticket its note named, so the files alone make no cycle", () => {
  const entries = [entry("A11-231", { phase: "running", working: { reason: "w", at: 1, waits: [{ kind: "ticket", key: "A11-229" }] }, paths: FILES }), entry("A11-229", { paths: FILES })];
  assert.deepEqual(waitCycles(entries), []);
});

const PULL_18 = "https://github.com/a11ign/announcement-emulator/pull/18";
const MIDDLEWARE_FILES = ["announcement-emulator:middleware/package.json", "announcement-emulator:middleware/src/"];
/**
 * The 2026-10-25 board (A11-298): A11-229 queued on the middleware files, A11-231 queued behind A11-229, and A11-232 a queued review round on #18 that holds #18's files. `behind232` is what holds the round back:
 * the ticket its worker waited on (`stoppedForBlocker`), which a round stays behind, or a plain blocker of its ticket, which a round on an open pull request does not wait on.
 */
const stuckBoard = (behind232: Record<string, unknown>) => [
  entry("A11-229", { paths: MIDDLEWARE_FILES }),
  entry("A11-231", { blockers: [blocker("A11-229")] }),
  entry("A11-232", { review: [{ repo: "announcement-emulator", url: PULL_18 }], pullFiles: { [PULL_18]: ["middleware/package.json"] }, ...behind232 }),
];

test("A11-298: 229 → (overlap) 232 → (blocker) 231 → (blocker) 229 is one cycle, found once, with the overlap edge counted", () => {
  const [cycle, ...rest] = waitCycles(stuckBoard({ stoppedForBlocker: { at: 1, keys: ["A11-231"] } }));
  assert.equal(rest.length, 0);
  assert.deepEqual([cycle.id, cycle.loop], ["A11-229,A11-231,A11-232", ["A11-229", "A11-232", "A11-231", "A11-229"]]);
  assert.deepEqual(cycle.edges.map(({ from, to, kind }) => `${from} ${kind} ${to}`), ["A11-229 files A11-232", "A11-232 blocked-by A11-231", "A11-231 blocked-by A11-229"]);
  assert.equal(cycleSentence(cycle), "Wait cycle A11-229 → A11-232 → A11-231 → A11-229: A11-229 is held behind A11-232's files; A11-232 is blocked by A11-231; A11-231 is blocked by A11-229.");
});

test("A11-298: and the board breaks it: the round waits on A11-229 through A11-231, so its files do not hold A11-229, which starts", () => {
  const entries = stuckBoard({ stoppedForBlocker: { at: 1, keys: ["A11-231"] } });
  assert.equal(overlapWait(entries[0], entries), null);
});

test("A11-298: a round on an open pull request is not blocked by its ticket's blockers, so the same board without the worker's own wait is no cycle", () => {
  assert.deepEqual(waitCycles(stuckBoard({ blockers: [blocker("A11-231")] })), []);
});

test("A11-298: a round whose pull request merged holds nothing, so it is in no cycle", () => {
  assert.deepEqual(waitCycles(stuckBoard({ stoppedForBlocker: { at: 1, keys: ["A11-231"] }, pullStates: { [PULL_18]: "merged" } })), []);
});
