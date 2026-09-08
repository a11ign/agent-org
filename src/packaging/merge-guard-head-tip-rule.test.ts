/**
 * RULE: DOES GITHUB'S RECORDED HEAD MATCH THE BRANCH'S REAL TIP? -- #294/#195, #455's split into
 * `scripts/merge-guard/head-tip-rule.mjs`.
 *
 * THE #195 INCIDENT: `git ls-remote origin lead/prune-orphan-captures` -> 7c2e16fc, the branch's real tip.
 * `gh api .../pulls/195 --jq .head.sha` -> ac306fe9, GitHub's recorded head -- the tip's PARENT. Every
 * check GitHub reports belongs to that older commit: `gh api .../commits/ac306fe9/check-runs` shows 9
 * green runs, `gh api .../commits/7c2e16fc/check-runs` shows 0 -- never tested at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { headTipMismatchReason } from "../../../../scripts/merge-guard/head-tip-rule.mjs";

test("branchTip === headRefOid raises no reason -- the common case", () => {
  assert.deepEqual(headTipMismatchReason({ headRefOid: "d5c2436601abcdef" }, "d5c2436601abcdef"), []);
});

test("THE #195 INCIDENT: a mismatch names BOTH shas and the remedy", () => {
  const reasons = headTipMismatchReason({ headRefOid: "ac306fe9" }, "7c2e16fc");
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /GITHUB'S HEAD IS NOT THE BRANCH TIP/);
  assert.match(reasons[0], /ac306fe9/, "GitHub's recorded head, named");
  assert.match(reasons[0], /7c2e16fc/, "the branch's real tip, named");
  assert.match(reasons[0], /re-push/i, "the remedy is re-push, not update-the-branch -- a different fault "
    + "needs a different fix");
});
