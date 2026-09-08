/**
 * RULE: IS THIS PR BASED ON `main`? -- half of the #148 case, #455's split into `scripts/merge-guard/base-rule.mjs`.
 *
 * `ci.yml` triggers on `pull_request: branches: [main]`, so a PR based on another open PR's branch runs
 * no workflow at all and the branch protection covering `main` protects nothing here. Measured on #148:
 * `CLEAN/MERGEABLE`, zero check runs, 182 real insertions nothing ever tested.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseReason } from "../../../../scripts/merge-guard/base-rule.mjs";

test("a PR based on main raises no reason -- the common case must stay silent", () => {
  assert.deepEqual(baseReason({ baseRefName: "main" }), []);
});

test("THE #148 CASE: a base that is not main is named, and WHY it matters is explained", () => {
  const reasons = baseReason({ baseRefName: "lead/real-page-outcome-is-stated" });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /BASE IS NOT main/);
  assert.match(reasons[0], /lead\/real-page-outcome-is-stated/);
  assert.match(reasons[0], /branches: \[main\]/,
    "it must say WHY a non-main base runs nothing, not just that the base is wrong");
});
