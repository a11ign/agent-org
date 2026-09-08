/**
 * #471 (B7): A PR MUST DECLARE WHAT IT CLOSES.
 *
 * #468 -- the first merge armed under the PAT -- proved the closing pipeline works and produced this gap
 * in the same run: `close-rows` correctly closed nothing, because the PR body declared nothing, and A0's
 * own row (#451) stayed open while the work that closed it landed on main. `close-rows` did the right
 * thing with what it was given; the gap is that a PR is allowed to declare nothing at all.
 *
 * The fix reuses the shape #446 already built for `Acceptance:` -- "nobody wrote one" and "this
 * deliberately has none" must read as different states, or the second becomes cover for the first --
 * applied to the other half of the body. It must never INFER a row from a branch name or a title: a
 * wrongly-closed row is worse than an open one, because it leaves work that looks done.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { extractClosesDeclaration, closesDeclarationReport } from "../../../../scripts/acceptance-commands.mjs";

// --- the four fixtures the issue itself names ---

test('extractClosesDeclaration: THE ISSUE\'S OWN FIXTURE -- "Closes #451" -> closes [451]', () => {
  assert.deepEqual(extractClosesDeclaration("Closes #451"), { kind: "closes", numbers: [451] });
});

test('extractClosesDeclaration: THE ISSUE\'S OWN FIXTURE -- "Closes: none - reason" -> opt-out, reason recorded', () => {
  assert.deepEqual(extractClosesDeclaration("Closes: none - reason"), { kind: "none", reason: "reason" });
});

test('extractClosesDeclaration: THE ISSUE\'S OWN FIXTURE -- "Closes: none" (no reason) is MALFORMED, not "none"', () => {
  const result = extractClosesDeclaration("Closes: none");
  assert.equal(result.kind, "malformed");
  assert.match((/** @type {{detail: string}} */ (result)).detail, /names no reason/);
});

test("extractClosesDeclaration: THE ISSUE'S OWN FIXTURE -- a body with neither is MISSING", () => {
  assert.deepEqual(extractClosesDeclaration("Nothing here about closing anything."), { kind: "missing" });
  assert.deepEqual(extractClosesDeclaration(""), { kind: "missing" });
  assert.deepEqual(extractClosesDeclaration(null), { kind: "missing" });
  assert.deepEqual(extractClosesDeclaration(undefined), { kind: "missing" });
});

// --- "malformed is not none" -- the distinction the issue explicitly calls out ---

test("extractClosesDeclaration: THE #471 MEASUREMENT -- \"Closes\" in prose, with no number, is MALFORMED", () => {
  const result = extractClosesDeclaration("This PR closes out some loose ends.");
  assert.equal(result.kind, "malformed");
  assert.match((/** @type {{detail: string}} */ (result)).detail, /names no `#<number>`/);
});

test("extractClosesDeclaration: a malformed issue number (not digits) is MALFORMED, never MISSING", () => {
  const result = extractClosesDeclaration("Closes #abc");
  assert.equal(result.kind, "malformed");
});

test("extractClosesDeclaration: em-dash and plain hyphen after `none` both work, exactly like Acceptance:'s own", () => {
  assert.deepEqual(extractClosesDeclaration("Closes: none — an em dash reason"),
    { kind: "none", reason: "an em dash reason" });
  assert.deepEqual(extractClosesDeclaration("Closes: none - a hyphen reason"),
    { kind: "none", reason: "a hyphen reason" });
});

// --- never infers: it reads only the word "Closes", never a branch name, a title, or a bare "#N" ---

test("extractClosesDeclaration: a bare issue reference with no `Closes` keyword is NEVER inferred as a closure", () => {
  assert.deepEqual(extractClosesDeclaration("See #451 for context."), { kind: "missing" });
});

test("extractClosesDeclaration: \"encloses\"/\"discloses\" do not false-match the word boundary", () => {
  assert.deepEqual(extractClosesDeclaration("This encloses a diagram and discloses nothing new."),
    { kind: "missing" });
});

// --- multiple issues in one declaration ---

test("extractClosesDeclaration: multiple issues, comma-separated", () => {
  assert.deepEqual(extractClosesDeclaration("Closes #451, #452"), { kind: "closes", numbers: [451, 452] });
});

test('extractClosesDeclaration: multiple issues joined with "and"', () => {
  assert.deepEqual(extractClosesDeclaration("Closes #451 and #452"), { kind: "closes", numbers: [451, 452] });
});

test("extractClosesDeclaration: a colon is accepted before the number too (`Closes: #451`)", () => {
  assert.deepEqual(extractClosesDeclaration("Closes: #451"), { kind: "closes", numbers: [451] });
});

test("extractClosesDeclaration: THE #527 MEASUREMENT -- two SEPARATE Closes lines both report, not just the first", () => {
  // Caught live on #522: the body declared `Closes #510` and `Closes #497` on separate lines, and the
  // gate printed only `CLOSES: #510` -- #497 vanished with no warning, even though close-rows-for-merged-
  // pr.mjs (which reads GitHub's own closingIssuesReferences, never this regex) closed both for real. A
  // reporting defect, not a closing one -- but the report and GitHub disagreeing about a fact both see is
  // exactly the shape this repository has already paid for.
  assert.deepEqual(extractClosesDeclaration("Closes #510\nCloses #497"), { kind: "closes", numbers: [510, 497] });
});

test("extractClosesDeclaration: three separate Closes lines all report, in the order written", () => {
  assert.deepEqual(extractClosesDeclaration("Closes #1\nsome text in between\nCloses #2\nCloses #3"),
    { kind: "closes", numbers: [1, 2, 3] });
});

test("extractClosesDeclaration: a separate line mixed with a comma-list on another line -- both contribute", () => {
  assert.deepEqual(extractClosesDeclaration("Closes #1, #2\nCloses #3"), { kind: "closes", numbers: [1, 2, 3] });
});

// --- realistic PR-body shapes, not just the bare line ---

test("extractClosesDeclaration: the declaration works embedded in a real multi-paragraph body", () => {
  const body = [
    "## Summary",
    "",
    "This fixes the thing.",
    "",
    "## Acceptance",
    "",
    'Acceptance: node -e "process.exit(0)"',
    "",
    "Closes #471",
    "",
  ].join("\n");
  assert.deepEqual(extractClosesDeclaration(body), { kind: "closes", numbers: [471] });
});

// --- closesDeclarationReport: THE COMPOSED VERDICT ---

test("closesDeclarationReport: THE MEASUREMENT -- MISSING is ok:false", () => {
  const report = closesDeclarationReport("nothing to declare here");
  assert.equal(report.ok, false);
  assert.match(report.line, /^CLOSES: MISSING/);
});

test("closesDeclarationReport: THE MEASUREMENT -- MALFORMED is ok:false, same as MISSING", () => {
  const report = closesDeclarationReport("Closes: none");
  assert.equal(report.ok, false);
  assert.match(report.line, /^CLOSES: MALFORMED/);
});

test("closesDeclarationReport: a stated `none` opt-out is ok:true and names the reason", () => {
  const report = closesDeclarationReport("Closes: none — this is a docs-only change");
  assert.equal(report.ok, true);
  assert.match(report.line, /^CLOSES: NONE -> this is a docs-only change/);
});

test("closesDeclarationReport: a real `Closes #N` is ok:true and names the number", () => {
  const report = closesDeclarationReport("Closes #471");
  assert.equal(report.ok, true);
  assert.equal(report.line, "CLOSES: #471");
});

// --- MUTATION TARGET: documents the exact gap #468 measured ---

test("MUTATION TARGET: without this check, an empty declaration is indistinguishable from a valid one", () => {
  // The pre-#471 shape: nothing examined the body for a Closes: declaration at all, so a PR with no such
  // line and a PR with `Closes #451` both passed the acceptance job identically -- precisely how A0's own
  // row (#451) stayed open while the work that closed it merged to main.
  const noCheckAtAll = (body: string) => (body ? "ok" : "ok");
  assert.equal(noCheckAtAll("nothing declared"), "ok",
    "documents why the absence of this check cannot see the gap #468 measured");
});
