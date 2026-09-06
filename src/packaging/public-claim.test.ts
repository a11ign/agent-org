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

  // The corpus figure is the one exception, and it is declared rather than assumed: it is cited three
  // times in the project's own record and has never disagreed with itself. Everything else must come
  // from a gate somebody ran.
  const DECLARED = new Set(["1,398"]);
  const offending = unsourced.filter((n) => !DECLARED.has(n));

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

test("the claim states its denominator, and says so where a figure is not yet measured", () => {
  const claim = claimText();
  assert.match(claim, /1,398 conformant records/,
    "the corpus figure and its denominator are the substance of the claim");
  assert.match(claim, /re-measured|being re-measured/i,
    "where a figure is not yet sourceable the claim must say so, rather than omitting it silently — an "
    + "absent number reads as a claim not made, and this one is a claim awaiting its measurement");
});

test("the claim block is reachable from the README a stranger opens", () => {
  // A guard over a block nobody renders is a guard over nothing.
  const readme = readFileSync(path.join(REPO, "README.md"), "utf8");
  assert.match(readme, /## What this tool claims, with the number it was measured on/,
    "the claim must be a section of the README, not a hidden comment block");
});
