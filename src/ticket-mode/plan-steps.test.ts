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
