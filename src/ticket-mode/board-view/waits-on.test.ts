// no-token: gh -- the queue's view, in memory; nothing is read or spawned
// A11-272: the tickets a run waits on, shared by the overlap hold and the hold of a run stopped behind a ticket
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockersOf, waitedOn } from "./waits-on.ts";
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
  const live = entry("A-1", { phase: "running", working: { reason: "w", waits: [{ kind: "ticket", key: "C-1" }, { kind: "pullRequest", url }, { kind: "fleetJob", id: "fj-1" }] } });
  assert.deepEqual([...waitedOn(live, [live, owner])].sort(), ["B-1", "C-1"]);
});

test("A11-272: a queued run's declared waits are not its wait: only a live run's note counts", () => {
  const queued = entry("A-1", { working: { reason: "w", waits: [{ kind: "ticket", key: "C-1" }] } });
  assert.deepEqual([...waitedOn(queued, [queued])], []);
});

test("A11-272: waits are followed through blockers, each ticket once, through a cycle, and never to the run's own ticket", () => {
  const a = entry("A-1", { phase: "running", working: { reason: "w", waits: [{ kind: "ticket", key: "B-1" }] } });
  const b = entry("B-1", { blockers: [blocker("C-1")] });
  const c = entry("C-1", { blockers: [blocker("A-1"), blocker("B-1")] });
  assert.deepEqual([...waitedOn(a, [a, b, c])].sort(), ["B-1", "C-1"]);
});
