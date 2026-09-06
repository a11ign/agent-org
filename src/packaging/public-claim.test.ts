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

/* EVERY file that states the measurement publicly, not just the one somebody remembered.
 *
 * The README was guarded and `docs/try-it.md` -- the page an outside user is SENT -- carried the same
 * sentence unguarded. When the README moved from 1,398 to the measured 1,405, try-it.md kept 1,398, and
 * the guard reported green because it had never been told the second copy existed. That is this repo's
 * fact-stated-twice shape landing on the one number a stranger reads before deciding to trust the tool.
 *
 * So the list is the guard. Adding a public claim without adding it here is the only way back in. */
const CLAIM_FILES = ["README.md", "docs/try-it.md"] as const;

function claimBlockIn(file: string): string {
  const text = readFileSync(path.join(REPO, file), "utf8");
  const begin = text.indexOf("<!-- CLAIM:BEGIN");
  const end = text.indexOf("<!-- CLAIM:END");
  assert.ok(begin !== -1 && end > begin,
    `${file} has no CLAIM:BEGIN/CLAIM:END block, so nothing checks what the tool claims publicly there`);
  return text.slice(begin, end);
}

function claimText(): string {
  return CLAIM_FILES.map(claimBlockIn).join("\n");
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
  // Per FILE, not over the concatenation: a denominator present in the README and missing from
  // try-it.md must fail, and a joined string cannot see that.
  for (const file of CLAIM_FILES) assertDenominators(claimBlockIn(file), file);
});

function assertDenominators(claim: string, file: string): void {
  assert.ok(claim.length > 0, `${file} has an empty claim block`);
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
}

test("the claim block is reachable from the README a stranger opens", () => {
  // A guard over a block nobody renders is a guard over nothing.
  const readme = readFileSync(path.join(REPO, "README.md"), "utf8");
  assert.match(readme, /## What this tool claims, with the number it was measured on/,
    "the claim must be a section of the README, not a hidden comment block");
});

/* ------------------------------------------------------------------------------------------------ *
 * THE GUARD COVERED A BLOCK, NOT A FILE — and README.md stated the measurement four hundred lines
 * above its own guarded block, with a figure no gate has ever printed.
 *
 *   line  18  **zero false positives across 1,183 conformant records**      <- unguarded, unsourceable
 *   line 499  On our own corpus of 1,405 conformant records ...             <- inside CLAIM:BEGIN/END
 *
 * One file, one measurement, two numbers, and only the lower one was checked. `claimBlockIn()` slices
 * between the markers, so everything outside them is invisible BY CONSTRUCTION: the guard was not
 * failing, it was answering a narrower question than its name suggests. The guarded sentence is also the
 * one almost nobody scrolls to, while line 18 is where a first reader meets the claim.
 *
 * `docs/try-it.md` was this defect across two FILES and was fixed by listing the files. This is the same
 * defect INSIDE one file, and listing files cannot fix it.
 *
 * ## What counts as a claim, and why the signature is narrow
 *
 * A guard that fired on every sentence containing a digit would be switched off within a week, and the
 * row that asked for this said so. So the signature is a RESULT OVER A DENOMINATOR — an outcome word
 * (`false positives`, `true positives`, `asserted wrongly`, `conformant records`) in the same sentence as
 * a figure. Prose that merely mentions a number is not matched at all; prose that reads like a claim IS
 * matched, and is then classified rather than silently excused, because "nothing distinguishes a measured
 * public claim from prose that reads like one" is the row's actual finding.
 *
 * A discovered sentence passes if EITHER every figure in it is sourceable from a recorded gate, OR it is
 * classified below with a reason. Nothing passes by being outside a block.
 * ------------------------------------------------------------------------------------------------ */

const OUTCOME =
  /\b(false positives?|false negatives?|true positives?|asserted wrongly|conformant records?|conformant pages?)\b/i;
const FIGURE = /\b(zero|no|\d[\d,]*)\b/i;

/** Sentences outside every claim block that read as a measured result. */
function claimLikeLinesOutsideBlocks(file: string): { line: number; text: string }[] {
  const src = readFileSync(path.join(REPO, file), "utf8");
  const begin = src.indexOf("<!-- CLAIM:BEGIN");
  const end = src.indexOf("CLAIM:END");
  const found: { line: number; text: string }[] = [];
  let offset = 0;
  src.split("\n").forEach((text, index) => {
    const at = offset;
    offset += text.length + 1;
    if (begin >= 0 && end > begin && at > begin && at < end) return;
    if (OUTCOME.test(text) && FIGURE.test(text)) found.push({ line: index + 1, text: text.trim() });
  });
  return found;
}

/**
 * Reads like a measured claim and is not one. A REASON, never a bare line number — the discipline every
 * EXEMPT table in this repository uses, and the reason this list cannot quietly grow into an excuse.
 *
 * Keyed on a distinctive SUBSTRING rather than a line number, because line numbers drift with every edit
 * above them and an entry that silently stops matching is an exemption for a problem that moved.
 */
const NOT_A_MEASURED_CLAIM: Record<string, string> = {
  "concentrate in the two subjective criteria":
    "Guidance about WHERE false positives occur, with no figure attached to an outcome — the numbers in "
    + "the sentence are criterion identifiers (2.4.4, 2.4.6), not a measurement.",
  "Exits non-zero on **any** false positive":
    "Describes what a COMMAND does, not what a run measured. 'any' is a threshold in the tool's "
    + "behaviour; there is no denominator here to go stale.",
  "the layer with zero false positives":
    "A back-reference to the claim proper, not an independent measurement — it carries no denominator, so "
    + "there is nothing for a gate to source. If it ever gains one it stops matching this entry and this "
    + "guard asks for it.",
  "asserts something about the web":
    "The chief executive's RULING about phrasing, quoted. It exists to forbid a sentence, so matching the "
    + "forbidden words is the point of it.",
  "judges screen-reader evidence against WCAG":
    "A table row describing what the layer IS. Its figures are criterion counts in prose, not a measured "
    + "result over a corpus.",
  "always on, [`packages/judge/src/rules.ts`]":
    "A pointer to where the layer lives. The figure is a file path fragment and a criterion count.",
  "Measured against a local **Qwen":
    "A measurement of a THIRD-PARTY model's throughput, not of this tool's findings — no gate here "
    + "produces it and none should. It states its own apparatus in the sentence.",
  "runs through the `applyGate` seam":
    "Describes a code seam and cites a file, not a result.",
  "The strongest evidence so far is structural rather than a number":
    "Says explicitly that it is NOT a number. Matched only because 'false positives' appears in the "
    + "sentence arguing that point.",
  "The suite currently reports full recall":
    "`docs/METHODOLOGY.md` governs this one and forbids quoting it as a headline; the sentence carries "
    + "that caveat inline. It is the eval fixtures, not the corpus gate, and has no recorded gate by "
    + "design.",
};

test("every claim-like sentence OUTSIDE the block is sourceable, or classified with a reason", () => {
  const gates = recordedGateOutput();
  const discovered = claimLikeLinesOutsideBlocks("README.md");

  // A signature this specific finding NOTHING would mean the scan broke, not that the README is clean --
  // twelve matched by hand during this unit's own survey.
  assert.ok(discovered.length >= 8,
    `only ${discovered.length} claim-like sentence(s) found outside the block; the scan is broken, not `
    + "the README suddenly free of measurement prose");

  const offenders = discovered
    .filter(({ text }) => !Object.keys(NOT_A_MEASURED_CLAIM).some((key) => text.includes(key)))
    .filter(({ text }) => figuresIn(text).some((n) =>
      !gates.includes(n) && !gates.includes(n.replace(/,/g, ""))))
    .map(({ line, text }) => `  README.md:${line}  ${text.slice(0, 90)}`);

  assert.deepEqual(offenders, [],
    "these sentences read as a measured result, sit OUTSIDE the claim block, and carry a figure no "
    + "recorded gate has printed:\n" + offenders.join("\n")
    + "\n\nThe claim block is not the boundary of what a reader acts on. Either source the figure from a "
    + "recorded gate in docs/board/reported.json, move the sentence inside the block, or classify it in "
    + "NOT_A_MEASURED_CLAIM with a reason.");
});

test("every classification still matches a real sentence, so none excuses a problem that moved", () => {
  // The vacuity guard. An entry keyed on text that no longer appears excuses nothing while making the
  // list look like coverage -- and this file's own history is the argument: an exemption held "1,398" on
  // a premise that later stopped being true, and kept a stale number in the public claim while the test
  // reported green.
  const text = claimLikeLinesOutsideBlocks("README.md").map((l) => l.text).join("\n");
  for (const [key, reason] of Object.entries(NOT_A_MEASURED_CLAIM)) {
    assert.ok(reason.length > 40, `NOT_A_MEASURED_CLAIM["${key}"] needs a real reason, not a placeholder`);
    assert.ok(text.includes(key),
      `NOT_A_MEASURED_CLAIM["${key}"] no longer matches any discovered sentence -- the prose was edited `
      + "or the scan drifted. Delete the entry, or re-check the signature.");
  }
});

test("PROOF: prose with a number and no outcome is NOT matched, or the guard gets switched off", () => {
  // The half that keeps this usable, driven on synthetic text so it holds whatever the README says today.
  assert.equal(OUTCOME.test("It is ~100 lines and about a second, but it pulls half a gigabyte."), false);
  assert.equal(OUTCOME.test("Measured on 18 real pages; the capture took 12.4 seconds."), false,
    "a figure with a unit is not a claim about findings");
  assert.ok(OUTCOME.test("zero false positives across 1,183 conformant records"),
    "and the sentence this row is about must still match, or the guard covers nothing");
});
