/**
 * RULE: DOES THIS HEAD CONTAIN main's TIP? -- #182/#165, #455's split into
 * `scripts/merge-guard/ancestry-rule.mjs`. The clock cannot answer this: a run can finish AFTER main's tip
 * was committed while the branch still does not CONTAIN that commit, which is what ordinary concurrent
 * merging produces. `null` must never fall through to "contains it" -- that IS the false pass #182 fixed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ancestryReason } from "../../../../scripts/merge-guard/ancestry-rule.mjs";

test("behindBy: 0 raises no reason -- the common, up-to-date case", () => {
  assert.deepEqual(ancestryReason(0), []);
});

test("THE #165 INCIDENT: a positive behindBy is named, and explains why a fresh run does not settle it", () => {
  const reasons = ancestryReason(2);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /DOES NOT CONTAIN main's TIP — it is 2 commit\(s\) behind/);
  assert.match(reasons[0], /may be minutes fresh/,
    "the message must say why a recent run does not settle it, or the reader re-runs CI and tries again");
});

test("MUTATION target: a FAILED lookup (null) is never read as 'contains main's tip'", () => {
  // The sharp one: `behind_by` falling through to 0 on a failed lookup would restore the exact false pass
  // #182 is about, this time silently and for a different reason (a network error rather than a stale
  // clock check). `ancestryReason` itself stays silent on `null` -- the CANNOT_ASK verdict is composed one
  // layer up, in `mergeReadiness`, which is what actually distinguishes "0" from "could not ask".
  assert.deepEqual(ancestryReason(null), [],
    "the pure rule is silent on null by design; the caller must treat null as CANNOT_ASK, never as 0");
});
