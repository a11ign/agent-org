/**
 * EVERY NETWORK/PROCESS LOOKUP THE RULES READ -- #455's split into `scripts/merge-guard/lookups.mjs`.
 * `null` on failure, never an empty answer -- most of these need a live `gh`/`git` to exercise fully, so
 * only the offline-testable parsing is driven here; each rule's own test covers what the LOOKUP feeds it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupBranchTip, lookup } from "../../../../scripts/merge-guard/lookups.mjs";

test("lookupBranchTip reads the real tip of a real branch in this repo", () => {
  const tip = lookupBranchTip("main");
  assert.ok(tip, "main always has a tip");
  assert.match(tip as string, /^[0-9a-f]{40}$/, "a full sha, not an abbreviation or a ref name");
});

test("lookupBranchTip returns null for a branch that does not exist, never an empty string", () => {
  const tip = lookupBranchTip("this-branch-does-not-exist-294");
  assert.equal(tip, null);
});

test("lookup returns null on a thrown error, never lets the exception escape", () => {
  const result = lookup(() => {
    throw new Error("simulated failure");
  });
  assert.equal(result, null);
});

test("lookup returns the function's real result on success, including a falsy one", () => {
  assert.equal(lookup(() => 0), 0);
  assert.equal(lookup(() => ""), "");
  assert.equal(lookup(() => null), null);
});
