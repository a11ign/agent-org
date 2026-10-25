// no-token: none -- pure decisions over numbers
// A11-261: when a ticket's CI passes its budget the worker is warned once; at twice the budget, and at each further whole budget, the run is held; a budget of 0 is none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetState, budgetStep, DEFAULT_CI_BUDGET_MINUTES, holdReason, warnPrompt } from "./budget.ts";

test("A11-261: the default budget is 300 weighted minutes", () => {
  assert.equal(DEFAULT_CI_BUDGET_MINUTES, 300);
});

test("A11-261: nothing is done at or under the budget; past it the worker is warned, once", () => {
  assert.deepEqual(budgetStep(299, 300, undefined), { kind: "none" });
  assert.deepEqual(budgetStep(300, 300, undefined), { kind: "none" }, "the budget itself is not past it");
  assert.deepEqual(budgetStep(301, 300, undefined), { kind: "warn" });
  assert.deepEqual(budgetStep(599, 300, undefined), { kind: "warn" });
  assert.deepEqual(budgetStep(450, 300, { warned: 301 }), { kind: "none" }, "already warned");
});

test("A11-261: at twice the budget the run is held, and the hold stands for the warning that was never sent", () => {
  assert.deepEqual(budgetStep(600, 300, undefined), { kind: "hold", multiple: 2 });
  assert.deepEqual(budgetStep(1200, 300, undefined), { kind: "hold", multiple: 4 }, "a ticket first read far past the budget is held at its multiple");
  assert.deepEqual(budgetStep(650, 300, { warned: 310 }), { kind: "hold", multiple: 2 });
});

test("A11-261: a held ticket is held again at each further whole budget, and not before", () => {
  assert.deepEqual(budgetStep(899, 300, { warned: 310, held: 2 }), { kind: "none" });
  assert.deepEqual(budgetStep(900, 300, { warned: 310, held: 2 }), { kind: "hold", multiple: 3 });
  assert.deepEqual(budgetStep(1250, 300, { warned: 310, held: 3 }), { kind: "hold", multiple: 4 });
  assert.deepEqual(budgetStep(1250, 300, { warned: 310, held: 4 }), { kind: "none" });
});

test("A11-261: a budget of 0 never warns or holds", () => {
  for (const weighted of [0, 1, 300, 600, 100_000]) assert.deepEqual(budgetStep(weighted, 0, undefined), { kind: "none" }, String(weighted));
});

test("A11-261: the card's state is ok under the budget, over it, and held at twice it; a budget of 0 is always ok", () => {
  assert.deepEqual([0, 300, 301, 599, 600, 900].map((weighted) => budgetState(weighted, 300)), ["ok", "ok", "over", "over", "held", "held"]);
  assert.equal(budgetState(5000, 0), "ok");
});

test("A11-261: the warning is one line that names the total, the budget and where the board holds the run", () => {
  const line = warnPrompt(310, 300);
  assert.equal(line, "CI budget: this ticket has run ~310 weighted CI minutes of its 300. Run the tests locally and batch your fixes into one push; at 600 the board holds this run.");
  assert.ok(!line.includes("\n"), "a new line typed into a pane would submit it early");
});

test("A11-261: the hold's reason names the total and the multiple of the budget", () => {
  assert.equal(holdReason(640, 300, 2), "Held: CI ~640 min, over twice this ticket's budget of 300");
  assert.equal(holdReason(940, 300, 3), "Held: CI ~940 min, over 3 times this ticket's budget of 300");
});
