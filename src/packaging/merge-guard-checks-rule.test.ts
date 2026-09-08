/**
 * RULE: DID EVERY REQUIRED CONTEXT ACTUALLY RUN AND CONCLUDE? -- #148's other half, #455's split into
 * `scripts/merge-guard/checks-rule.mjs`. Four distinct states -- empty, missing, still running, failing --
 * each needing a different sentence and a different fix.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkReasons, SATISFIED } from "../../../../scripts/merge-guard/checks-rule.mjs";

const REQUIRED = ["changed", "ts", "python", "ansible", "docs", "changeset"];
const pr = { headRefOid: "d5c2436601abcdef" };
const green = () => REQUIRED.map((name) => (
  { name, status: "completed", conclusion: name === "ts" ? "success" : "skipped" }));

test("THE #148 CASE: not one check run, ever -- distinct from a present-and-failing context", () => {
  const reasons = checkReasons(pr, REQUIRED, []);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /NO CHECK RUNS EXIST for head d5c2436601/);
  assert.match(reasons[0], /never ran is not a failing check/,
    "must name the distinction the field cannot express, or the reader mistakes this for a red gate");
});

test("every required context present and satisfied raises nothing", () => {
  assert.deepEqual(checkReasons(pr, REQUIRED, green()), []);
});

test("`skipped` and `neutral` are SATISFIED, not failures -- a path filter declining is not a defect", () => {
  assert.ok(SATISFIED.has("skipped"));
  assert.ok(SATISFIED.has("neutral"));
  assert.ok(SATISFIED.has("success"));
  assert.ok(!SATISFIED.has("failure"));
});

test("a required context that never ran is distinct from an empty list and from a failure", () => {
  const runs = green().filter((run) => run.name !== "changeset");
  const reasons = checkReasons(pr, REQUIRED, runs);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /REQUIRED CONTEXT NEVER RAN: changeset/);
  assert.match(reasons[0], /Present-and-failing and never-ran are different states/);
});

test("a failing context and a still-running one are separate sentences", () => {
  const failing = green().map((r) => (r.name === "ts" ? { ...r, conclusion: "failure" } : r));
  assert.match(checkReasons(pr, REQUIRED, failing).join("\n"), /FAILING: ts \(failure\)/);

  const running = green().map((r) => (r.name === "ts"
    ? { ...r, status: "in_progress", conclusion: null } : r));
  const reasons = checkReasons(pr, REQUIRED, running);
  assert.match(reasons.join("\n"), /STILL RUNNING: ts/);
  assert.match(reasons.join("\n"), /ask again/, "in-flight is not a defect and must not read as one");
});

test("MUTATION target: multiple independent faults are reported as multiple sentences, not merged into one", () => {
  const runs = green().filter((run) => run.name !== "changeset")
    .map((r) => (r.name === "ts" ? { ...r, conclusion: "failure" } : r));
  const reasons = checkReasons(pr, REQUIRED, runs);
  assert.equal(reasons.length, 2, "missing-context and failing must stay two sentences");
});
