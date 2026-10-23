// no-token: none -- pure: the declarations are given here, and nothing is read
import { test } from "node:test";
import assert from "node:assert/strict";
import { afterPartialMerge, currentStepOf, currentStepPaths, partialStepOf, stepNamed, stepQueuedLine, stepRunningLine } from "./board-view/plan-steps.ts";

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
  assert.deepEqual(afterPartialMerge("step 2 and the docs remain", [], 9), { next: { step: 2, of: 9, counted: true } }, "a bare `step 2` is not read as the step finished: it may as well be the step that remains");
  assert.deepEqual(afterPartialMerge("step 3 of 2: a typo", [], 5), { stalled: "Partial merged: step 3 of 2: a typo. It names no step, so nothing was queued: Dismiss it and queue the ticket" }, "an impossible step goes to a person, however large the plan is");
  assert.deepEqual(afterPartialMerge("step 2 of the plan", [{ step: 4, of: 9 }]), { stalled: "Partial merged: step 2 of the plan. Step 2 is not after step 4: nothing was queued" }, "a step not past the last recorded one never goes backwards");
});

test("A11-173: a step the board counted says so in the queued and running lines, and a step the declaration named does not", () => {
  assert.equal(stepQueuedLine([{ step: 2, of: 9, counted: true }]), "step 2 of 9 merged (counted by the board: the Partial line named no step); step 3 queued");
  assert.equal(stepRunningLine([{ step: 2, of: 9, counted: true }]), "step 2 of 9 merged (counted by the board: the Partial line named no step); step 3 running");
  assert.equal(stepQueuedLine([{ step: 2, of: 9 }]), "step 2 of 9 merged; step 3 queued");
});

// A11-175: the step a pull request finishes is read from its body's `Partial:` line, and the step a run is on from its declaration, its merged steps and its plan.
test("A11-175: partialStepOf reads the step from the body's Partial: line, in any case and under any markdown decoration, and nothing from a body without one", () => {
  const body = (line: string) => `Refs A11-160\n\n## What changed\n\n- the reviewer's calls move\n\n${line}\n\nOutside-Region: README.md — docs\n`;
  assert.deepEqual(partialStepOf(body("Partial: step 3 of 9: reviews, checks and the verdict door. Steps 4 to 9 remain.")), { step: 3, of: 9 });
  assert.deepEqual(partialStepOf(body("**Partial:** step 3 of 9 - the rest")), { step: 3, of: 9 });
  assert.deepEqual(partialStepOf(body("- partial: Step 2 Of 5")), { step: 2, of: 5 });
  assert.deepEqual(partialStepOf(body("> Partial: step 1 of 2")), { step: 1, of: 2 });
  assert.deepEqual(partialStepOf("Partial: step 3 of 9\r\nCloses nothing"), { step: 3, of: 9 }, "a line ends at a line break of either kind");
  assert.equal(partialStepOf(body("Partial: the settings page")), null, "a Partial: line that names no step names none");
  assert.equal(partialStepOf(body("Partial: step 12 of 9")), null, "nor an impossible one");
  assert.equal(partialStepOf("Closes A11-160\n\nThis completes the plan: step 9 of 9 is done."), null, "a body with no Partial: line finishes its ticket, and no step is named in prose");
  assert.equal(partialStepOf("It is not Partial: nothing here\nstep 3 of 9 is on the next line"), null, "the step must be on the Partial: line itself");
  assert.equal(partialStepOf(""), null);
});

test("A11-175: a run's current step is the step its partial names, else the one after the last merged, else step 1 of a plan whose sections list paths, else none", () => {
  const merged = [{ step: 1, of: 9, prs: [] }, { step: 2, of: 9, prs: [] }];
  const stepPaths = { "3": ["agent-org:src/c/"], "4": ["agent-org:src/d/"] };
  assert.equal(currentStepOf({ partial: "step 3 of 9: reviews", steps: merged }), 3, "a finished run whose partial pull request is open");
  assert.equal(currentStepOf({ partial: "step 5 of 9", steps: merged }), 5, "the declaration is what the run finished");
  assert.equal(currentStepOf({ steps: merged }), 3, "a run queued or running for the next step");
  assert.equal(currentStepOf({ partial: "the identity work", steps: merged }), 3, "a declaration that names no step is the run's step by the record");
  assert.equal(currentStepOf({ stepPaths }), 1, "no step merged or declared, in a plan whose sections list paths");
  assert.equal(currentStepOf({}), null, "a run that is no step of a plan");
  assert.equal(currentStepOf({ partial: "the settings page" }), null);
  assert.equal(currentStepOf({ stepPaths: {} }), null);
  assert.deepEqual([currentStepPaths({ partial: "step 3 of 9", stepPaths }), currentStepPaths({ steps: merged, stepPaths })], [["agent-org:src/c/"], ["agent-org:src/c/"]]);
  assert.equal(currentStepPaths({ partial: "step 5 of 9", stepPaths }), null, "a step whose section lists no paths has none");
  assert.equal(currentStepPaths({ steps: merged }), null, "a run with no recorded step paths has none");
  assert.equal(currentStepPaths({ partial: "step 3 of 9", stepPaths: { "3": [] } }), null, "and an empty list is none");
});
