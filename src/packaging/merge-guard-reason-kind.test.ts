/**
 * WHICH reason a refusal is, not just that there was one -- #455's split into
 * `scripts/merge-guard/reason-kind.mjs`. Kept as ONE list rather than distributed per rule: "the guard
 * refused for ancestry and GitHub merged it" and "the guard refused for a missing check and GitHub merged
 * it" are different bugs, and #188's reconciliation log needs to tell them apart from a bare verdict.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reasonKind } from "../../../../scripts/merge-guard/reason-kind.mjs";

test("reasonKind classifies every reason shape the rule modules actually produce", () => {
  // A reason this cannot classify is worth knowing about immediately, not discovering later in a log
  // full of UNCLASSIFIED entries -- the count-based-check shape this repo keeps finding, arriving here
  // through a label instead of a number.
  const cases: [string, string][] = [
    ["BASE IS NOT main — it is `x`.", "BASE_NOT_MAIN"],
    ["NO CHECK RUNS EXIST for head abc — not one, ever.", "NO_RUNS"],
    ["REQUIRED CONTEXT NEVER RAN: changeset.", "MISSING_REQUIRED_CONTEXT"],
    ["STILL RUNNING: ts. Not a refusal forever — ask again.", "STILL_RUNNING"],
    ["FAILING: ts (failure).", "FAILING"],
    ["THIS HEAD DOES NOT CONTAIN main's TIP — it is 2 commit(s) behind.", "ANCESTRY"],
    ["EVERY RUN PREDATES THE CURRENT main. Newest run x, `main` tipped y.", "STALE"],
    ["WOULD CLOSE #237 \"example row\", but it is claimed.", "CLAIMED_BY_ANOTHER_SESSION"],
    ["GITHUB'S HEAD IS NOT THE BRANCH TIP: GitHub recorded abc, the branch's real tip is def.", "HEAD_MISMATCH"],
  ];
  for (const [reason, expected] of cases) assert.equal(reasonKind(reason), expected, reason);
});

test("an unrecognised reason is UNCLASSIFIED, never silently matched to the wrong kind", () => {
  assert.equal(reasonKind("something nobody wrote a pattern for"), "UNCLASSIFIED");
});

test("PR-HOLD REASONS (#266) DELIBERATELY HAVE NO KIND: they never enter the #188 reconciliation log", () => {
  // `prHoldReasons` refuses a PUSH, not an arming decision -- it is never composed into the verdict
  // `recordVerdict` logs, so it needs no entry here. Documented as a test rather than left implicit, so a
  // future reader does not add one "for completeness" and wonder why it never matches anything real.
  assert.equal(reasonKind("#258 IS HELD by dispatcher, and you are worker-capture."), "UNCLASSIFIED");
});
