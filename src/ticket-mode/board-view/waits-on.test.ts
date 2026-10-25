// no-token: gh -- the queue's view, in memory; nothing is read or spawned
// A11-272: the tickets a run waits on, shared by the overlap hold and the hold of a run stopped behind a ticket
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockersOf, declaredWaits, waitersOn } from "./waits-on.ts";
import type { ViewEntry } from "./view-types-and-filters.ts";

const entry = (key: string, over: Record<string, unknown> = {}) => ({ ticket: { key }, phase: "queued", ...over }) as unknown as ViewEntry;
const blocker = (key: string, state = "started") => ({ key, state, status: "In Progress" });

test("A11-272: a stopped run's tickets are its blockers until the tracker lists them, with the state last read of each", () => {
  const stopped = entry("A11-231", { blockers: [blocker("A11-100")], stoppedForBlocker: { at: 1, keys: ["A11-229", "A11-100"], states: { "A11-229": "unstarted" } } });
  assert.deepEqual(blockersOf(stopped).map(({ key, state }) => [key, state]), [["A11-100", "started"], ["A11-229", "unstarted"]], "a listed blocker is not added twice");
  const unread = entry("A11-231", { stoppedForBlocker: { at: 1, keys: ["A11-229"] } });
  assert.deepEqual(blockersOf(unread).map(({ state }) => state), ["unknown"], "before any read");
});

test("A11-272: a live run waits on the tickets its worker declared and on the ticket whose run has the pull request it declared; a fleet job names none", () => {
  const url = "https://github.com/a11ign/lab/pull/7";
  const owner = entry("B-1", { phase: "finished", outcome: { kind: "ready-pr", prs: [{ url }] } });
  const live = entry("A-1", { phase: "running", working: { reason: "w", waiting: true, waits: [{ kind: "ticket", key: "C-1" }, { kind: "pullRequest", url }, { kind: "fleetJob", id: "fj-1" }] } });
  assert.deepEqual([waitersOn("B-1", [live, owner]), waitersOn("C-1", [live, owner]), waitersOn("fj-1", [live, owner])].map((set) => [...set]), [["A-1"], ["A-1"], []]);
});

test("A11-272: a worker woken from its wait, or at work again, waits on nothing its note declared", () => {
  const live = entry("A-1", { phase: "running", working: { reason: "w", waits: [{ kind: "ticket", key: "C-1" }] } });
  assert.deepEqual([...waitersOn("C-1", [live])], []);
});

test("A11-272: a blocker the tracker settled, or whose pull requests all merged, is not followed", () => {
  const merged = { ...blocker("B-1"), pulls: { "https://github.com/a11ign/lab/pull/1": "merged" } };
  const a = entry("A-1", { phase: "running", blockers: [blocker("C-1", "completed"), merged, blocker("D-1", "canceled")] });
  const c = entry("C-1", { phase: "finished", blockers: [blocker("E-1")] });
  assert.deepEqual(["B-1", "C-1", "D-1", "E-1"].map((key) => waitersOn(key, [a, c]).size), [0, 0, 0, 1], "only C-1 itself waits on E-1");
});

test("A11-272: a queued run's declared waits are not its wait: only a live run's note counts", () => {
  const queued = entry("A-1", { working: { reason: "w", waits: [{ kind: "ticket", key: "C-1" }] } });
  assert.deepEqual([...waitersOn("C-1", [queued])], []);
});

test("A11-272: waits are followed back through blockers, each ticket once, through a cycle, and never to the ticket asked about", () => {
  const a = entry("A-1", { phase: "running", working: { reason: "w", waiting: true, waits: [{ kind: "ticket", key: "B-1" }] } });
  const b = entry("B-1", { blockers: [blocker("C-1")] });
  const c = entry("C-1", { blockers: [blocker("A-1"), blocker("B-1")] });
  assert.deepEqual([...waitersOn("C-1", [a, b, c])].sort(), ["A-1", "B-1"], "B-1 is blocked by C-1, and A-1 waits on B-1; C-1 itself is left out though it waits on B-1");
});

test("A11-272: the tickets a run's idle worker declared a wait on are the tickets it names and the owners of the pull requests it names, and only while it is live and idle in the wait", () => {
  const url = "https://github.com/a11ign/lab/pull/7";
  const owner = entry("B-1", { phase: "finished", outcome: { kind: "ready-pr", prs: [{ url }] } });
  const waits = [{ kind: "ticket", key: "C-1" }, { kind: "pullRequest", url }, { kind: "fleetJob", id: "fj-1" }];
  const live = entry("A-1", { phase: "running", working: { reason: "w", waiting: true, waits } });
  const woken = entry("A-2", { phase: "running", working: { reason: "w", waits } });
  const queued = entry("A-3", { phase: "queued", working: { reason: "w", waiting: true, waits } });
  assert.deepEqual([...declaredWaits([live, woken, queued, owner])], [["A-1", ["C-1", "B-1"]], ["A-2", []], ["A-3", []], ["B-1", []]], "woken or at work, and queued: no wait");
});
