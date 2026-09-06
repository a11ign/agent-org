import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/* THE PUBLIC CLAIM CANNOT OUTLIVE ITS MEASUREMENT.
 *
 * The README states what this tool was measured to do, and a stranger acts on that sentence. Every figure
 * in it must be sourceable from a gate result somebody actually ran and recorded verbatim in
 * `docs/board/reported.json` -- the same channel the board document quotes, for the same reason.
 *
 * WHY THIS TEST EXISTS AT ALL. The sentence originally proposed for the README carried "88 conformant
 * real pages". That number appears nowhere: the project's own record says 85 in two places and 86 in
 * four, the corpus source has 91 conformant entries, and the gate's last run said "82 of 85". Four
 * numbers for one quantity, and 88 was not among them -- it came from an expectation stated before the
 * capture rather than from a gate. A figure nobody can source is a figure that will still be in the
 * README long after the run it came from.
 *
 * SO: a number may appear in the claim ONLY if a recorded gate output contains it. Where no gate has
 * printed a figure yet, the claim says the figure is being re-measured. That is not a placeholder to be
 * tidied away later -- it is the honest state, and it is what the sentence should say until a run says
 * otherwise.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function claimText(): string {
  const readme = readFileSync(path.join(REPO, "README.md"), "utf8");
  const begin = readme.indexOf("<!-- CLAIM:BEGIN");
  const end = readme.indexOf("<!-- CLAIM:END");
  assert.ok(begin !== -1 && end > begin,
    "README.md has no CLAIM:BEGIN/CLAIM:END block, so nothing checks what the tool claims publicly");
  return readme.slice(begin, end);
}

function recordedGateOutput(): string {
  const raw = JSON.parse(readFileSync(path.join(REPO, "docs/board/reported.json"), "utf8"));
  return (raw.gates ?? []).map((g: { output?: string }) => g.output ?? "").join("\n");
}

/** Figures a reader would act on. Years and version-like tokens are not claims about measurement. */
function figuresIn(text: string): string[] {
  const body = text.replace(/<!--[\s\S]*?-->/g, " ");            // the marker comments are not the claim
  return [...new Set((body.match(/\b\d[\d,]*\b/g) ?? [])
    .filter((n) => !/^(19|20)\d\d$/.test(n.replace(/,/g, ""))))];
}

test("every figure in the public claim is sourceable from a recorded gate result", () => {
  const claim = claimText();
  const gates = recordedGateOutput();
  const unsourced = figuresIn(claim).filter((n) =>
    !gates.includes(n) && !gates.includes(n.replace(/,/g, "")));

  // THERE IS NO EXEMPTION, and the one there used to be is why this comment is long.
  //
  // `DECLARED` held "1,398" -- the corpus figure -- on the reasoning that it "is cited three times in the
  // project's own record and has never disagreed with itself". On 2026-09-06 it disagreed with itself:
  // `promote:gated` printed 1,405. So the premise the exemption rested on was gone, and what the
  // exemption then did was keep a stale number in the public claim while this test reported green --
  // the vacuous guard this file was written to prevent, arriving through the exception rather than
  // through the check.
  //
  // An exemption whose premise has moved reads exactly like an exemption that still applies. The figure
  // is now sourceable from a recorded gate, which is what the rest of this test asks of every other
  // number, so it no longer needs one.
  const offending = unsourced;

  assert.deepEqual(offending, [],
    "these figures are in the public claim and in no recorded gate output, so nothing keeps them true: "
    + `${offending.join(", ")}. Record the gate's verbatim output in docs/board/reported.json, or take `
    + "the figure out of the claim and say it is being re-measured.");
});

test("the claim never says 'no false positives'", () => {
  // Ruled by the chief executive 2026-09-06: that phrase claims something about the WEB, and what was
  // measured is a corpus. The denominator is part of the claim.
  assert.doesNotMatch(claimText(), /no false positives/i,
    "the claim must state what was measured and on what, never the unbounded phrase");
});

test("every population the claim mentions carries the denominator it was measured on", () => {
  const claim = claimText();
  // `\s+` rather than a literal space: README.md hard-wraps, so a figure and the population it counts
  // are routinely split across a line break. A literal space passed on the corpus figure and failed on
  // the real-page one purely because of where the line happened to end -- which would have read as the
  // claim missing its denominator when the denominator was there.
  // PINNED AS A SHAPE, NEVER AS A LITERAL. This read `/1,398 conformant records/`, so the moment the
  // corpus grew the guard did not merely fail to notice -- it REQUIRED the stale number, and updating
  // the claim to the measured 1,405 would have failed the test protecting the claim. A test that pins a
  // figure it does not source is a test that enforces staleness.
  assert.match(claim, /[\d,]+\s+conformant records/,
    "the corpus figure and its denominator are the substance of the claim");
  assert.match(claim, /[\d,]+\s+conformant real pages/,
    "the real-page claim needs its denominator for the same reason the corpus one does — 'clean on real "
    + "pages' without a count is the unbounded phrase this file already forbids, one population along");
  // The claim used to have to say "being re-measured", because the real-page figure had no gate behind
  // it. It has one now, so requiring that phrase would force the claim to disclaim a measurement it
  // actually has. What survives is the rule underneath it, and it is the assertion above: every
  // population the claim mentions carries the denominator it was measured on.
});

test("the claim block is reachable from the README a stranger opens", () => {
  // A guard over a block nobody renders is a guard over nothing.
  const readme = readFileSync(path.join(REPO, "README.md"), "utf8");
  assert.match(readme, /## What this tool claims, with the number it was measured on/,
    "the claim must be a section of the README, not a hidden comment block");
});
