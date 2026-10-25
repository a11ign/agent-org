// no-token: none -- pure wording over a view a test writes out
// A11-261: the line a run's card gives its CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ciNote, type CiView } from "./ci-note.ts";

const ci = (over: Partial<CiView> = {}): CiView => ({ run: { pushes: 3, jobs: 48, weighted: 184 }, ticket: { pushes: 3, jobs: 48, weighted: 184 }, budget: 300, state: "ok", ...over });

test("A11-261: the card says how many pushes, jobs and weighted minutes the run cost: CI: 3 pushes, 48 jobs, ~184 min", () => {
  assert.equal(ciNote(ci()), "CI: 3 pushes, 48 jobs, ~184 min");
});

test("A11-261: one push and one job are said in the singular", () => {
  assert.equal(ciNote(ci({ run: { pushes: 1, jobs: 1, weighted: 1 }, ticket: { pushes: 1, jobs: 1, weighted: 1 } })), "CI: 1 push, 1 job, ~1 min");
});

test("A11-261: when the ticket's total differs from the run's the card adds it", () => {
  assert.equal(ciNote(ci({ ticket: { pushes: 7, jobs: 90, weighted: 420 } })), "CI: 3 pushes, 48 jobs, ~184 min (ticket ~420 min)");
  assert.equal(ciNote(ci({ run: { pushes: 0, jobs: 0, weighted: 0 }, ticket: { pushes: 7, jobs: 90, weighted: 420 } })), "CI: 0 pushes, 0 jobs, ~0 min (ticket ~420 min)", "a run that has not pushed yet, of a ticket that has");
});

test("A11-261: past the budget the line says so, and at twice it, that it is twice over", () => {
  assert.equal(ciNote(ci({ ticket: { pushes: 5, jobs: 70, weighted: 340 }, state: "over" })), "CI: 3 pushes, 48 jobs, ~184 min (ticket ~340 min) · over budget (300)");
  assert.equal(ciNote(ci({ run: { pushes: 5, jobs: 70, weighted: 640 }, ticket: { pushes: 5, jobs: 70, weighted: 640 }, state: "held" })), "CI: 5 pushes, 70 jobs, ~640 min · over twice the budget (300)");
});

test("A11-261: a run the board has read no CI of has no line", () => {
  assert.equal(ciNote(undefined), null);
  assert.equal(ciNote(ci({ run: { pushes: 0, jobs: 0, weighted: 0 }, ticket: { pushes: 0, jobs: 0, weighted: 0 } })), null);
});
