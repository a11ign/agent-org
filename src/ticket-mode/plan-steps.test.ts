// no-token: none -- pure: the declarations are given here, and nothing is read
import { test } from "node:test";
import assert from "node:assert/strict";
import { afterPartialMerge, stepNamed, stepQueuedLine, stepRunningLine } from "./board-view/plan-steps.ts";

test("A11-168: a declaration names a step as `step <N> of <M>`, in any case, wherever the words are, and the first one counts", () => {
  assert.deepEqual(stepNamed("step 1 of 9 of the plan. Steps 2 to 9 remain."), { step: 1, of: 9 });
  assert.deepEqual(stepNamed("The rest: STEP 3 OF 4, then the docs"), { step: 3, of: 4 });
  assert.deepEqual(stepNamed("step 2 of 5 (step 3 of 5 next)"), { step: 2, of: 5 }, "the first match");
});

test("A11-168: a declaration with no step, or an impossible one, names none", () => {
  for (const text of ["the settings page", "", "steps 1 to 3 remain", "step one of nine", "step 0 of 3", "step 4 of 3", "substep 1 of 3 only"]) assert.equal(stepNamed(text), null, text);
});

test("A11-168: a numbered step below the last, past every step already merged, queues the next step", () => {
  assert.deepEqual(afterPartialMerge("step 1 of 9 of the plan", []), { next: { step: 2, of: 9 } });
  assert.deepEqual(afterPartialMerge("step 3 of 4", [{ step: 1, of: 4 }, { step: 2, of: 4 }]), { next: { step: 4, of: 4 } });
});

test("A11-168: a declaration that names no step, names the last step, or is not past the last merged step queues nothing, and says why", () => {
  assert.deepEqual(afterPartialMerge("the settings page", []), { stalled: "Partial merged: the settings page. It names no step, so nothing was queued: Dismiss it and queue the ticket" });
  assert.deepEqual(afterPartialMerge("step 9 of 9 the docs", [{ step: 8, of: 9 }]), { stalled: "Partial merged: step 9 of 9 the docs. It names step 9 of 9, the last, with Partial: the last step closes the ticket" });
  assert.deepEqual(afterPartialMerge("step 2 of 9", [{ step: 1, of: 9 }, { step: 2, of: 9 }]), { stalled: "Partial merged: step 2 of 9. Step 2 is not after step 2: nothing was queued" });
  assert.deepEqual(afterPartialMerge("step 1 of 9", [{ step: 4, of: 9 }]), { stalled: "Partial merged: step 1 of 9. Step 1 is not after step 4: nothing was queued" });
});

test("A11-168: the line names the last merged step and the next, queued until it runs", () => {
  assert.equal(stepQueuedLine([{ step: 1, of: 9 }]), "step 1 of 9 merged; step 2 queued");
  assert.equal(stepRunningLine([{ step: 1, of: 9 }, { step: 2, of: 9 }]), "step 2 of 9 merged; step 3 running");
  assert.equal(stepQueuedLine([]), null, "a run that is no later step says nothing");
});

test("A11-173: a declaration naming step N without of M, or no step at all, takes the plan's size from the record or the plan and queues the step after; a plan with no remaining step stops", () => {
  // A11-160's line: "step 2 of the plan", in a nine-step plan whose record is empty (the run started before the record existed).
  assert.deepEqual(afterPartialMerge("step 2 of the plan (identity). Steps 3 to 9 remain", [], 9), { next: { step: 3, of: 9, counted: true } }, "the first step the declaration names, counted against the plan's size");
  assert.deepEqual(afterPartialMerge("step 2 of the plan (identity). Steps 3 to 9 remain", [{ step: 1, of: 9 }]), { next: { step: 3, of: 9, counted: true } }, "the size is the record's when the record has one, with no plan read");
  assert.deepEqual(afterPartialMerge("the identity work", [{ step: 1, of: 9 }, { step: 2, of: 9 }], 9), { next: { step: 4, of: 9, counted: true } }, "no step named: the first the record does not show as merged finished");
  assert.deepEqual(afterPartialMerge("the identity work", [], 9), { next: { step: 2, of: 9, counted: true } }, "an empty record: step 1 finished");
  assert.deepEqual(afterPartialMerge("step 3 of 9", [], 4), { next: { step: 4, of: 9 } }, "a declaration that names step N of M is read as before, not counted, whatever the plan holds");
  // Only a plan with no remaining step stops.
  assert.deepEqual(afterPartialMerge("the docs", [], 0), { stalled: "Partial merged: the docs. It names no step, and the plan has no numbered steps, so nothing was queued: Dismiss it and queue the ticket" }, "a plan with no numbered steps");
  assert.deepEqual(afterPartialMerge("the docs", []), { stalled: "Partial merged: the docs. It names no step, so nothing was queued: Dismiss it and queue the ticket" }, "a plan not counted (yet) stops as before");
  assert.deepEqual(afterPartialMerge("the docs", [{ step: 8, of: 9 }], 9), { stalled: "Partial merged: the docs. The board counted it as step 9 of 9, the last, with Partial: the last step closes the ticket" }, "the step counted is the plan's last");
  assert.deepEqual(afterPartialMerge("step 9 of the plan", [], 9), { stalled: "Partial merged: step 9 of the plan. The board counted it as step 9 of 9, the last, with Partial: the last step closes the ticket" });
  assert.deepEqual(afterPartialMerge("step 12 of the plan", [], 9), { stalled: "Partial merged: step 12 of the plan. It names step 12, past the plan's last step, 9: nothing was queued" });
  assert.deepEqual(afterPartialMerge("step 2 of the plan", [{ step: 4, of: 9 }]), { stalled: "Partial merged: step 2 of the plan. Step 2 is not after step 4: nothing was queued" }, "a step not past the last recorded one never goes backwards");
});

test("A11-173: a step the board counted says so in the queued and running lines, and a step the declaration named does not", () => {
  assert.equal(stepQueuedLine([{ step: 2, of: 9, counted: true }]), "step 2 of 9 merged (counted by the board: the Partial line named no step); step 3 queued");
  assert.equal(stepRunningLine([{ step: 2, of: 9, counted: true }]), "step 2 of 9 merged (counted by the board: the Partial line named no step); step 3 running");
  assert.equal(stepQueuedLine([{ step: 2, of: 9 }]), "step 2 of 9 merged; step 3 queued");
});
