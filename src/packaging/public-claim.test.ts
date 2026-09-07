import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
// REUSED, NOT RE-DERIVED. `reported()` already picks the single most-recently-recorded gate entry --
// the same one `board-data.mjs`'s own consumers (the daily report, the weekly document) treat as the
// current status. A second re-implementation of "which entry is current" here would be the fact-stated-
// twice shape this repo keeps paying for.
import { reported } from "../../../../scripts/board-data.mjs";

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
const CLAIM_FILES = ["README.md", "docs/try-it.md", "docs/github-action.md"] as const;

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
  const body = text
    .replace(/<!--[\s\S]*?-->/g, " ")                              // the marker comments are not the claim
    // AN ISO DATE IS NOT A MEASUREMENT, and it took a withdrawal to notice. `2026-09-06` was read as the
    // figures 09 and 06 and demanded of the gate output, so the sentence "under re-measurement since
    // <date>" could not be written at all -- the guard blocking the one honest thing to say when a
    // figure is withdrawn. Same reasoning as the year filter below: a date is a claim about WHEN, never
    // about what was measured.
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ");
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

  // A BLOCK MAY CLAIM NOTHING, and that is the one alternative to stating the denominators. This file's
  // own header already blesses it: *"where no gate has printed a figure yet, the claim says the figure is
  // being re-measured -- that is not a placeholder to be tidied away later, it is the honest state."*
  //
  // `docs/github-action.md` is why it needed saying in code. It carried "zero false positives across
  // 1,034 conformant records" while the README said 1,183 and the guarded claim said 1,405 -- three
  // documents, one measurement, and only 1,405 in a recorded gate. Requiring denominators there would
  // have forced a number to be PICKED, which is a judgement about what the page claims and not a
  // mechanism.
  //
  // NOT ABUSABLE, because the escape is conditional on claiming nothing: a block that says it is being
  // re-measured must carry NO figure at all. "Being re-measured, and by the way it was 1,034" is the
  // stale claim wearing the honest sentence, so it is refused by the same check.
  if (/being re-measured/i.test(claim)) {
    assert.deepEqual(figuresIn(claim), [],
      `${file} says its figure is being re-measured AND states one. That is the stale claim wearing the `
      + "honest sentence: either give the denominators, or claim nothing until a recorded gate prints "
      + "one.");
    return;
  }
  // A POPULATION IS WITHDRAWN INDEPENDENTLY, not the whole block. On 2026-09-06 a refreshed baseline
  // produced findings on real pages an older baseline had passed, so the REAL-PAGE figure had to be
  // withdrawn while the CORPUS figure was untouched and still correct. The block-level escape above
  // could not express that: it is all-or-nothing, so honouring it would have withdrawn a good claim to
  // withdraw a bad one, and keeping the block would have gone on publishing a figure under
  // investigation.
  //
  // So each population states its figure OR says it is under re-measurement WITH A DATE. The date is
  // the load-bearing part: "under re-measurement" with no date is how a withdrawal becomes permanent
  // furniture, and this repo has paid for exactly that shape more than once.
  //
  // `\s+` rather than a literal space throughout: these files hard-wrap, so a figure and the population
  // it counts are routinely split across a line break. A literal space passed on the corpus figure and
  // failed on the real-page one purely because of where the line happened to end.
  const POPULATIONS = [
    { what: "the corpus", figure: /[\d,]+\s+conformant\s+records/ },
    { what: "real pages", figure: /[\d,]+\s+conformant\s+real\s+pages/ },
  ] as const;
  const withdrawn = /under\s+re-measurement\s+since\s+\d{4}-\d{2}-\d{2}/i.test(claim);

  for (const { what, figure } of POPULATIONS) {
    if (figure.test(claim)) continue;
    assert.ok(withdrawn,
      `${file}'s claim states no figure for ${what} and does not say it is under re-measurement with a `
      + "date. A population is either measured and stated, or withdrawn and dated — silence about one "
      + "reads to a stranger as a claim not made, and this project has had both of those be wrong.");
  }
  // PINNED AS A SHAPE, NEVER AS A LITERAL. The corpus assertion once read `/1,398 conformant records/`,
  // so the moment the corpus grew the guard did not merely fail to notice -- it REQUIRED the stale
  // number, and updating the claim to the measured 1,405 would have failed the test protecting the
  // claim. A test that pins a figure it does not source is a test that enforces staleness.
}

/* A REAL-PAGE FIGURE STATES ITS AGE BESIDE IT -- issue #128.
 *
 * `rules:real-pages` prints its own date-range and hour-spread line -- "*** 298 hour(s) between the
 * oldest and newest, so this compares a MIXED population against one baseline" -- and what reached
 * `docs/board/reported.json` was a bare "PASS — all 84 of 84 ... examined and clean", with no date range
 * and no hour spread. That bare figure is what travelled into the README, `docs/try-it.md` and the
 * release's real-page claim: four places carrying "84 of 84" and none of them able to say as of when. A
 * refreshed baseline invalidated it the same night, and it was caught by a person noticing, not by
 * anything in the pipeline being able to tell.
 *
 * So two things are checked, matching the row's own two acceptance cases: the RECORDING keeps the spread
 * the gate printed (an entry that has been trimmed past it is the defect at its source), and a PUBLIC
 * CLAIM stating a real-page figure carries its as-of date beside it, the same way the denominator and the
 * withdrawal already are required above. */
const REAL_PAGE_RESULT = /\b\d[\d,]*\s+of\s+\d[\d,]*\b[^\n]*\breal pages\b/i;
const DATE_RANGE = /\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s*\.\.\s*\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/;
const HOUR_SPREAD = /hour\(s\)\s+between/i;
const AS_OF_DATE = /\bas of\s+\d{4}-\d{2}-\d{2}\b/i;

test("the most recently recorded gate entry keeps the capture spread it printed, if it states a real-page result", () => {
  // Scoped to the LATEST entry only, matching `reported()`'s own selection -- that is the one entry
  // anything downstream (the board document's risk line, this file's own figure-sourcing) ever treats as
  // CURRENT. An older entry sitting further back in the array already carries whatever it carried before
  // this row existed and is archival evidence, not a live claim; checking it would be checking something
  // nothing downstream reads, and would hold pre-existing recordings to a rule written after them.
  const { latestGate } = reported();
  if (!latestGate || !REAL_PAGE_RESULT.test(latestGate.output ?? "")) return;

  assert.ok(DATE_RANGE.test(latestGate.output) && HOUR_SPREAD.test(latestGate.output),
    "the most recently recorded gate entry states a real-page result and has been trimmed past the date "
    + "range and hour-spread line the gate itself printed, so a figure quoted from it later cannot say as "
    + `of when (#128): ${latestGate.command}`);
});

function assertRealPageAsOfDate(claim: string, file: string): void {
  if (!REAL_PAGE_RESULT.test(claim)) return; // withdrawn, or states no real-page figure at all -- covered above
  assert.match(claim, AS_OF_DATE,
    `${file} states a real-page figure with no "as of <date>" beside it, so a reader cannot tell how old `
    + "the captures behind it are (#128). State the date the gate ran, the way the denominator and the "
    + "withdrawal are already required above.");
}

test("a public claim stating a real-page figure carries its as-of date beside it", () => {
  for (const file of CLAIM_FILES) assertRealPageAsOfDate(claimBlockIn(file), file);
});

test("PROOF: a real-page figure with its as-of date renders normally, and one without does not", () => {
  assert.doesNotThrow(() => assertRealPageAsOfDate(
    "84 of 84 conformant real pages examined and clean, as of 2026-09-06.", "synthetic"));
  assert.throws(() => assertRealPageAsOfDate(
    "84 of 84 conformant real pages examined and clean.", "synthetic"));
});

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

test("every file carrying a CLAIM block is IN the list, so one cannot be added unguarded", () => {
  // "So the list is the guard" -- this file's own header, and the acknowledged hole in it: a new public
  // claim is protected only if somebody remembers to add its file here. That is a rule a human has to
  // remember, which this repo's own doctrine says does not happen.
  //
  // DERIVED, in the direction that matters. Adding a CLAIM block and not listing the file now fails;
  // removing a file from the list AND deleting its block stays possible, because that is a deliberate act
  // rather than an omission. `docs/` is the whole surface a stranger is sent to, plus the README.
  const roots = ["README.md", ...walkDocs()];
  const carrying = roots.filter((file) =>
    readFileSync(path.join(REPO, file), "utf8").includes("<!-- CLAIM:BEGIN"));
  assert.ok(carrying.length >= 3,
    `only ${carrying.length} file(s) carry a CLAIM block; the scan is broken, not the claims withdrawn`);

  const unlisted = carrying.filter((file) => !(CLAIM_FILES as readonly string[]).includes(file));
  assert.deepEqual(unlisted, [],
    "these files carry a CLAIM:BEGIN block and are not in CLAIM_FILES, so nothing checks their figures:\n"
    + unlisted.map((f) => `  ${f}`).join("\n")
    + "\n\nA claim block that nothing reads is worse than none: it looks guarded.");
});

/* #313: A TIME/DURATION PROMISE IS A CLAIM TOO, and every check above only ever looked for a NUMERAL.
 * "Expect the run to take a few minutes." carries no digit, so it was invisible to `figuresIn` even had
 * it been inside the guarded block -- and it was not: `docs/try-it.md`'s CLAIM block sources only the
 * corpus and real-page denominators, 105 lines below this sentence.
 *
 * THE PROMISE IS REAL AND UNSOURCED, NOT WRONG. The only recorded timing for a page of this shape is
 * `CLAUDE.md`'s "abandoned at the 280 s hard timeout", measured on the deprecated UTM guests under an
 * older recording format -- not a figure this claim could honestly cite. #311 (fleet-gated) is the row
 * that produces a current one. Until it lands, the honest state is the same one this file already
 * requires of a withdrawn NUMERIC figure: say plainly that the exact timing is under re-measurement,
 * rather than asserting a duration nothing currently backs.
 *
 * PARAGRAPH-SCOPED, not line-scoped like the OUTCOME/FIGURE scan above. These files hard-wrap (the same
 * fact the denominator regexes above use `\s+` for), so "Expect the run to take a few minutes." and its
 * sourcing sentence routinely fall on different physical lines of the same paragraph. Scanning by
 * paragraph (blank-line-separated) means a duration promise and an adjacent "under re-measurement"
 * sentence are read together regardless of where the editor wrapped them.
 */
const DURATION_PROMISE = /\b(?:takes?|took|expect(?:s|ed)?|costs?)\b/i;
const DURATION_UNIT = /\b(?:minutes?|seconds?|hours?)\b/i;

/** Paragraphs (outside every claim block) that promise a duration, keyed by the line their text starts on. */
function durationClaimParagraphsOutsideBlocks(file: string): { line: number; text: string }[] {
  return durationClaimParagraphsIn(readFileSync(path.join(REPO, file), "utf8"));
}

/** The pure half of `durationClaimParagraphsOutsideBlocks`, so the paragraph/list-boundary logic itself
 * is testable on synthetic text and cannot drift out of sync with whatever the real docs say today. */
function durationClaimParagraphsIn(src: string): { line: number; text: string }[] {
  const lines = src.split("\n");
  const found: { line: number; text: string }[] = [];
  let inClaimBlock = false;
  let para: string[] = [];
  let paraStartLine = 1;
  let paraTouchedBlock = false;
  const flush = () => {
    if (para.length > 0 && !paraTouchedBlock) {
      const text = para.join(" ");
      if (DURATION_PROMISE.test(text) && DURATION_UNIT.test(text)) {
        found.push({ line: paraStartLine, text });
      }
    }
    para = [];
    paraTouchedBlock = false;
  };
  // A markdown LIST has no blank line between items, so a blank-line-only paragraph boundary joins every
  // bullet in a list into one "paragraph" -- which is how a duration promise in one bullet and unrelated
  // prose three bullets later ended up read as a single claim. Each list item starts its own paragraph.
  const LIST_ITEM = /^(?:[-*]|\d+\.)\s/;
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line.includes("CLAIM:BEGIN")) inClaimBlock = true;
    if (inClaimBlock) paraTouchedBlock = true; // a paragraph straddling the block is never "outside" it
    if (line.includes("CLAIM:END")) inClaimBlock = false;
    if (line === "") {
      flush();
      return;
    }
    if (LIST_ITEM.test(line)) flush(); // a new bullet/numbered item is never a continuation
    if (para.length === 0) paraStartLine = index + 1;
    para.push(line);
  });
  flush();
  return found;
}

const UNDER_REMEASUREMENT = /under\s+re-measurement\s+since\s+\d{4}-\d{2}-\d{2}/i;

/**
 * Reads like a duration promise and is not one worth sourcing. Same discipline as `NOT_A_MEASURED_CLAIM`
 * above: a REASON, never a bare line number, keyed on a distinctive substring so a moved or edited
 * sentence silently stops matching rather than silently keeping a stale exemption alive.
 */
const NOT_A_DURATION_CLAIM: Record<string, string> = {
  "Getting one takes ~20 minutes":
    "Setup time for provisioning NVDA once, not a claim about how long a capture or a run takes -- no "
    + "capture gate has ever measured, or should measure, a one-time Windows setup step.",
  "the real cost of the two hours":
    "Refers back to this page's own title-level time budget for the whole exercise (setup plus "
    + "evaluation), not a measured capture duration -- there is no gate that could source a reader's own "
    + "time investment in trying the tool.",
  "Was it worth the minutes it cost":
    "A question posed TO the reader in a self-assessment checklist, not a promise made BY this page -- "
    + "there is nothing here for a gate to source because nothing here asserts a duration.",
  "expected to add 1-2 minutes":
    "Already self-qualified as untested rather than asserted as measured fact -- the same sentence says "
    + "outright 'it has not run on a Windows runner', which is the honest disclosure this guard exists to "
    + "require elsewhere.",
  "checked before you spend the minutes":
    "'Spend the minutes' is idiomatic for wasted effort, not a duration figure, and the promise-verb match "
    + "in the same bullet ('takes us one capture to answer') counts CAPTURES, not time -- there is no "
    + "duration claim in this sentence for a gate to source.",
};

function assertDurationClaimSourced(file: string): void {
  const discovered = durationClaimParagraphsOutsideBlocks(file);
  const offenders = discovered
    .filter(({ text }) => !Object.keys(NOT_A_DURATION_CLAIM).some((key) => text.includes(key)))
    .filter(({ text }) => !UNDER_REMEASUREMENT.test(text))
    .map(({ line, text }) => `  ${file}:${line}  ${text.slice(0, 120)}`);

  assert.deepEqual(offenders, [],
    "these paragraphs promise a time or duration, sit outside the claim block, and neither cite a "
    + "recorded measurement nor say the timing is under re-measurement:\n" + offenders.join("\n")
    + "\n\nEither cite a recorded gate's timing inside a CLAIM block, say the timing is 'under "
    + "re-measurement since <date>', classify the sentence in NOT_A_DURATION_CLAIM with a reason, or "
    + "do not promise a duration at all.");
}

test("every time/duration promise outside the claim block is sourced, disclosed, or classified", () => {
  for (const file of CLAIM_FILES) assertDurationClaimSourced(file);
});

test("every duration classification still matches a real sentence", () => {
  // The vacuity guard, same shape as the one above for NOT_A_MEASURED_CLAIM.
  const text = CLAIM_FILES
    .flatMap((file) => durationClaimParagraphsOutsideBlocks(file).map((p) => p.text))
    .join("\n");
  for (const [key, reason] of Object.entries(NOT_A_DURATION_CLAIM)) {
    assert.ok(reason.length > 40, `NOT_A_DURATION_CLAIM["${key}"] needs a real reason, not a placeholder`);
    assert.ok(text.includes(key),
      `NOT_A_DURATION_CLAIM["${key}"] no longer matches any discovered paragraph -- the prose was edited `
      + "or the scan drifted. Delete the entry, or re-check the signature.");
  }
});

test("PROOF: a duration promise with no unit, and a unit with no promise verb, are both NOT matched", () => {
  assert.equal(DURATION_PROMISE.test("A capture is around a minute on an ordinary page.")
    && DURATION_UNIT.test("A capture is around a minute on an ordinary page."), false,
    "'is' is not a promise verb -- this sentence alone must not trip the guard, or it would fire on any "
    + "prose that merely mentions a duration in passing");
  assert.ok(DURATION_PROMISE.test("Expect the run to take a few minutes.")
    && DURATION_UNIT.test("Expect the run to take a few minutes."),
    "and the sentence this row is about must still match, or the guard covers nothing");
});

test("PROOF: durationClaimParagraphsIn joins a wrapped paragraph and reads the whole thing", () => {
  // Synthetic, not read from a real doc -- driven this way so the SHAPE (a duration promise wrapping onto
  // a second physical line, with its sourcing sentence continuing there too) is proven regardless of
  // whatever today's real prose happens to say.
  const found = durationClaimParagraphsIn(
    "Expect the run to take a few minutes. Timing is under re-measurement since\n2026-09-07 (#311).");
  assert.equal(found.length, 1, "the two-line paragraph must be read as ONE paragraph, not discarded or "
    + "split into two half-sentences neither of which matches both signatures");
  assert.match(found[0].text, UNDER_REMEASUREMENT,
    "the re-measurement sentence that continues on the NEXT physical line must be read as part of the "
    + "same paragraph, or a duration promise and its own sourcing two lines below it would never be seen "
    + "together");
});

test("PROOF: a markdown LIST does not join unrelated bullets into one paragraph", () => {
  const found = durationClaimParagraphsIn(
    "- Expect the run to take a few minutes.\n- Nothing else in this bullet mentions time at all.");
  assert.equal(found.length, 1, "only the FIRST bullet promises a duration; joining both into one "
    + "paragraph would make an unrelated later bullet part of the same (unsourced) claim");
  assert.doesNotMatch(found[0].text, /Nothing else/,
    "the second bullet must not have been absorbed into the first bullet's paragraph");
});

/** Every markdown file under `docs/`, which with the README is the surface a stranger is sent to. */
function walkDocs(dir = "docs"): string[] {
  return readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return walkDocs(rel);
    return entry.name.endsWith(".md") ? [rel] : [];
  });
}
