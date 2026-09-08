/**
 * #549: a PR body can declare `Closes: none` and still close two issues, and nothing compared what the
 * author DECLARED against what GitHub RESOLVED. Measured live, same day: #545 declared `none` and closed
 * #492 and #494 anyway; #537 declared `none` and closed #494. Both cost a hand-reopen -- #492 twice.
 *
 * These fixtures are the ones the issue itself names, driving `closesMismatchReport` directly with an
 * INJECTED `resolved` array rather than a live `closingIssuesReferences` query -- the same "inject the
 * fact, never fetch it" shape every other `merge-guard/*-rule.test.ts` file already uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { closesMismatchReport, findClosingPhrase } from "../../../../scripts/closes-mismatch-check.mjs";
import type { ClosesDeclaration } from "../../../../scripts/acceptance-commands.mjs";

const NONE: ClosesDeclaration = { kind: "none", reason: "docs-only change" };
const CLOSES = (numbers: number[]): ClosesDeclaration => ({ kind: "closes", numbers });

// --- findClosingPhrase ---

test("findClosingPhrase: finds a real `closes #N` line, case-insensitively, and names the line number", () => {
  const body = "Some prose.\n\nThe wiring PR (#530) closes #494 once it lands.\n\nMore prose.";
  const found = findClosingPhrase(body, 494);
  assert.ok(found);
  assert.equal(found?.line, 3);
  assert.match(found?.text ?? "", /closes #494/);
});

test("findClosingPhrase: the exact #545/#537 shape -- a closing verb mid-sentence, not at line start", () => {
  const body = "A closed row whose acceptance now says it closes #492, which needs a look.";
  const found = findClosingPhrase(body, 492);
  assert.ok(found, "the exact incident shape must be locatable");
});

test("findClosingPhrase: null when the number never appears with a closing keyword", () => {
  const body = "This PR references #487 in passing, with no closing verb nearby.";
  assert.equal(findClosingPhrase(body, 487), null);
});

test("findClosingPhrase: a bare mention with no closing keyword at all is not found", () => {
  const body = "See #510 for background.";
  assert.equal(findClosingPhrase(body, 510), null);
});

// --- closesMismatchReport: the issue's own four fixtures, verbatim ---

test("#549 FIXTURE 1: declared none + resolved [492,494] -> REFUSED, naming both", () => {
  const body = "Closes: none — cleanup only.\n\nThe wiring PR (#530) closes #494.\n"
    + "A closed row whose acceptance now says it closes #492.";
  const report = closesMismatchReport(NONE, [492, 494], body);
  assert.equal(report.ok, false);
  if (report.ok === false) {
    assert.equal(report.reasons.length, 2);
    assert.ok(report.reasons.some((r) => r.includes("#492")));
    assert.ok(report.reasons.some((r) => r.includes("#494")));
    // THE DIFFERENCE, NOT JUST THAT THERE IS ONE -- the issue's own acceptance line.
    assert.ok(report.reasons.some((r) => /line \d+/.test(r)),
      "at least one reason must point at the actual line, not just the number");
  }
});

test("#549 FIXTURE 2: declared [487] + resolved [] -> REFUSED, naming 487 as declared-but-unresolvable", () => {
  const report = closesMismatchReport(CLOSES([487]), [], "Closes #487\n\nSome description.");
  assert.equal(report.ok, false);
  if (report.ok === false) {
    assert.equal(report.reasons.length, 1);
    assert.match(report.reasons[0], /#487/);
    assert.match(report.reasons[0], /will NOT close it/);
  }
});

test("#549 FIXTURE 3: declared [510,497] + resolved [510,497] -> allowed", () => {
  const report = closesMismatchReport(CLOSES([510, 497]), [510, 497], "Closes #510, #497");
  assert.deepEqual(report, { ok: true });
});

test("#549 FIXTURE 4: declared none + resolved [] -> allowed", () => {
  const report = closesMismatchReport(NONE, [], "Closes: none — docs only.");
  assert.deepEqual(report, { ok: true });
});

// --- The `resolved` order/set does not matter, and a lookup FAILURE is a distinct, never-clean state ---

test("resolved order is irrelevant -- this is a SET comparison, not a sequence one", () => {
  const report = closesMismatchReport(CLOSES([497, 510]), [510, 497], "Closes #497, #510");
  assert.deepEqual(report, { ok: true });
});

test("resolved: null (the lookup failed) is CANNOT ASK, never treated as a clean/empty match", () => {
  const report = closesMismatchReport(NONE, null, "Closes: none — reason");
  assert.equal(report.ok, null);
  if (report.ok === null) {
    assert.match(report.reason, /closingIssuesReferences/);
  }
});

// --- missing/malformed declarations are this comparison's non-concern -- closesDeclarationReport's job ---

test("a MISSING declaration is treated as declaring nothing, for this comparison only", () => {
  const report = closesMismatchReport({ kind: "missing" }, [], "no closes line at all");
  assert.deepEqual(report, { ok: true });
});

test("a MISSING declaration with a real resolved closure is still reported, same as `none`", () => {
  const report = closesMismatchReport({ kind: "missing" }, [494], "the wiring PR closes #494");
  assert.equal(report.ok, false);
});

test("a MALFORMED declaration is treated as declaring nothing, for this comparison only", () => {
  const report = closesMismatchReport({ kind: "malformed", detail: "no #<number>" }, [], "Closes: something");
  assert.deepEqual(report, { ok: true });
});

// --- MUTATION TARGET: the comparison must run in BOTH directions, not just one ---

test("#549 MUTATION TARGET: an accidental closure with NO declared numbers at all is still caught -- not "
  + "only when some numbers were declared", () => {
  const report = closesMismatchReport(CLOSES([]), [999], "no closing phrase written deliberately");
  assert.equal(report.ok, false);
});

test("#549 MUTATION TARGET: extra undeclared closures alongside correctly-declared ones are still named", () => {
  // #510 was declared and correctly resolved; #999 was never declared but GitHub resolves it anyway --
  // both real, independent facts, and only the second is a fault.
  const report = closesMismatchReport(CLOSES([510]), [510, 999], "Closes #510");
  assert.equal(report.ok, false);
  if (report.ok === false) {
    assert.equal(report.reasons.length, 1);
    assert.match(report.reasons[0], /#999/);
  }
});
