import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
// REUSED, NOT RE-DERIVED. `reported()` already picks the single most-recently-recorded gate entry --
// the same one `board-data.mjs`'s own consumers (the daily report, the weekly document) treat as the
// current status. A second re-implementation of "which entry is current" here would be the fact-stated-
// twice shape this repo keeps paying for.
import { reported } from "../board-data.mjs";
import { HOME_CHECKOUT } from "../project-config.mjs";

/* THE PUBLIC CLAIM CANNOT OUTLIVE ITS MEASUREMENT.
 *
 * The README states what this tool was measured to do, and a stranger acts on that sentence. Every figure
 * in it must be sourceable from a gate result somebody actually ran and recorded verbatim in
 * `docs/board/reported/` -- the same channel the board document quotes, for the same reason.
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
const REPO = HOME_CHECKOUT;

/* EVERY file that states the measurement publicly, not just the one somebody remembered.
 *
 * The README was guarded and `docs/try-it.md` -- the page an outside user is SENT -- carried the same
 * sentence unguarded. When the README moved from 1,398 to the measured 1,405, try-it.md kept 1,398, and
 * the guard reported green because it had never been told the second copy existed. That is this repo's
 * fact-stated-twice shape landing on the one number a stranger reads before deciding to trust the tool.
 *
 * `examples/workflow.yml` -- the ONE file `docs/github-action.md` itself tells a reader is "copy-
 * pasteable" -- carried the retired "1,034 conformant records" figure unguarded until #324's V1
 * rehearsal found it, and by then it had already been copied verbatim into a real consumer's own
 * committed workflow: the exact fact-stated-twice failure this list exists to close, landing on the one
 * file a stranger is explicitly told to copy rather than merely read.
 *
 * So the list is the guard. Adding a public claim without adding it here is the only way back in. */
const CLAIM_FILES = ["README.md", "docs/try-it.md", "docs/github-action.md", "examples/workflow.yml"] as const;

/* #1599 done-when 2: CLAUDE.md IS STILL NOT SCANNED BY THE CLAIM MACHINERY, and #2451 is what now guards
 * the one figure it carries that a stranger-facing claim also carries. #1599's reason stands: CLAUDE.md
 * has no `<!-- CLAIM:BEGIN -->` marker and is not the surface `CLAIM_FILES`'s comment above is about -- it
 * is read by an agent working ON the repo, not a stranger deciding whether to trust the tool, and it is
 * edited directly, same-day, by whoever is maintaining it. Holding it to the figure-sourcing and
 * denominator checks would make every such edit answer to rules written for the README, and turning the
 * scan on it (tried under #1599) caught a stale "0 false positives across 1,183 conformant records" that
 * was a wrong figure, not a misclassified one.
 *
 * WHAT #2451 CHANGED, AND WHY THAT DOES NOT OVERRIDE THE ABOVE. The `N criteria asserted wrongly, M
 * referred` pair is stated in THREE files (README's claim block, CLAUDE.md, and the record's current-
 * reading section in docs/operational-lessons.md) and nothing compared the copies: reviewer-2 changed only
 * CLAUDE.md to `394 referred` on #2418 and every guard stayed green. The test "the calibration reading
 * is the same pair in all three files" pins ONLY that pair, and pins it to the README's copy -- the one
 * the sourcing test above already ties to a recorded gate. CLAUDE.md gains no marker and no other rule;
 * a same-day edit that leaves the pair alone is untouched. A same-day edit that MOVES it fails naming the
 * file, which is the cost intended: the number is a reading at a moment (CLAUDE.md says so itself) and a
 * copy that lags it is the stale claim. The author of the change that moves the README's pair moves the
 * other two in the same PR -- the test derives the number, so it needs no one's permission.
 *
 * WHAT STILL GUARDS THE REST OF CLAUDE.md: `asserting-subtypes.test.ts`'s "CLAUDE.md's counts match the
 * artefacts" pins its RULE-OWNERSHIP figures against `rule-ownership.json`. No other CLAUDE.md figure is
 * guarded. */

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

/** Every recorded gate entry's own verbatim output, ONE STRING PER ENTRY -- never pre-joined. #1599: the
 * in-block figure test below still wants one big string (a figure sourced anywhere is enough for the
 * measured claim proper), but a figure sourced OUTSIDE the block also has to answer "beside what", and
 * that question only makes sense per entry -- a joined string cannot say which entry a figure and an
 * outcome word came from, so it cannot tell "422 came from the same table row 'referred' names" from "422
 * happened to sit in some other entry's timestamp". */
function recordedGateEntries(): string[] {
  const dir = path.join(REPO, "docs/board/reported/gates");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")).output ?? "");
}

function recordedGateOutput(): string {
  // ONE FILE PER GATE ENTRY since #159 -- the single JSON file conflicted whenever two agents recorded
  // into it. The QUESTION is unchanged: every figure in the claim must appear in some gate's verbatim
  // output, so this reads the directory and joins what it finds rather than trusting one file's shape.
  return recordedGateEntries().join("\n");
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
    + `${offending.join(", ")}. Record the gate's verbatim output in docs/board/reported/, or take `
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

  // #1599 M2: A FIGURE STATED BESIDE "UNDER RE-MEASUREMENT." IS STILL A WITHDRAWAL WITH THE DATE DROPPED,
  // not a population that has "stated its figure". Without this, the loop below reads `figure.test(claim)`
  // and `continue`s the moment ANY denominator-shaped phrase appears ANYWHERE in the block -- including a
  // superseded figure quoted alongside its own withdrawal ("...is superseded: re-derived on the 17 of
  // those pages still in the corpus...") -- so a dateless "under re-measurement." never gets asked for its
  // date at all as long as some old number is still sitting in the same paragraph. Checked unconditionally,
  // against the whole block, because a stale-date defect is a defect wherever it sits, not only in a
  // paragraph a POPULATIONS regex happens to miss.
  if (/under\s+re-measurement\b/i.test(claim)) {
    assert.ok(withdrawn,
      `${file} says a figure is "under re-measurement" with no "since <date>" beside it. A figure still `
      + "quoted nearby (a superseded number, a historical reference) does not make this a stated claim -- "
      + "it is a withdrawal, and an undated withdrawal is how a stale number becomes permanent furniture.");
  }

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
const AS_OF_DATE = /\bas of\s+\d{4}-\d{2}-\d{2}\b/i;

// #1652: #1630's own sentence -- "Measured 2026-09-14 on the 41 conformant real pages of the calibration
// set" -- carries no "N of M" pair at all, so REAL_PAGE_RESULT above never fired on it and its date could
// be dropped with nothing catching it (all three of this row's Acceptance files stayed 40/40 green on the
// reproduction). This is a SEPARATE shape, matched independently of REAL_PAGE_RESULT so a future edit to
// one cannot silently stop covering the other.
//
// THE DATE MUST SIT BESIDE THIS FIGURE, NOT MERELY SOMEWHERE IN THE BLOCK -- #1599 M2's own lesson,
// applied here rather than re-learned: README.md's block also carries the superseded product-path
// figure's own date ("The 2026-08-24 18-page product-path figure is superseded...") in the same
// paragraph, so a check that asked only "does AS_OF_DATE match anywhere in this claim" would read the
// 41-page figure as dated by a date that belongs to a different figure entirely. So the date is required
// immediately before "on the N conformant real pages of", the exact position #1630's real sentence
// already uses it in, rather than as a bare co-occurrence.
const ON_THE_N_REAL_PAGES = /\bon\s+the\s+\d[\d,]*\s+conformant\s+real\s+pages\s+of\b/i;
const DATED_ON_THE_N_REAL_PAGES = /\b\d{4}-\d{2}-\d{2}\s+on\s+the\s+\d[\d,]*\s+conformant\s+real\s+pages\s+of\b/i;

test("the most recently recorded gate entry keeps the capture spread it printed, if it states a real-page result", () => {
  // Scoped to the LATEST entry only, matching `reported()`'s own selection -- that is the one entry
  // anything downstream (the board document's risk line, this file's own figure-sourcing) ever treats as
  // CURRENT. An older entry sitting further back in the array already carries whatever it carried before
  // this row existed and is archival evidence, not a live claim; checking it would be checking something
  // nothing downstream reads, and would hold pre-existing recordings to a rule written after them.
  const { latestGate } = reported();
  if (!latestGate || !REAL_PAGE_RESULT.test(latestGate.output ?? "")) return;

  // THE DATE RANGE IS THE AGE STATEMENT. THE HOUR LINE IS A JUDGEMENT ABOUT THE AGE, AND IT IS
  // CONDITIONAL -- corrected 2026-09-07, after this assertion refused a healthy run.
  //
  // `real-page-freshness.mjs:50,91` emits `*** N hour(s) between the oldest and newest` only when
  // `spreadMs > ROLE_SPREAD_WARN_MS` (six hours). #82's refresh brought the spread to 1h 07m, so the
  // gate correctly printed no such line -- and requiring it unconditionally meant this test PASSED on
  // the 298-hour mixed-population run it was written about and REFUSED the one-hour uniform one that
  // fixed it. **Strictest about exactly the runs needing no scrutiny**, and it would have accepted every
  // edition since the corpus went mixed.
  //
  // That is the same shape as `realPageCaptureAge` one file along, fixed in the same change: a reader
  // keyed on a WARNING goes silent when the news is good. So the requirement is the date range, which is
  // printed unconditionally, is more precise than the derived hours, and is what #128's property
  // actually asks for -- "a real-page figure states its age beside it". The hour line is welcome when
  // present and cannot be required, because its absence is good news.
  assert.ok(DATE_RANGE.test(latestGate.output),
    "the most recently recorded gate entry states a real-page result and has been trimmed past the date "
    + "range the gate itself printed, so a figure quoted from it later cannot say as of when (#128): "
    + `${latestGate.command}`);
});

function assertRealPageAsOfDate(claim: string, file: string): void {
  if (REAL_PAGE_RESULT.test(claim)) {
    assert.match(claim, AS_OF_DATE,
      `${file} states a real-page figure with no "as of <date>" beside it, so a reader cannot tell how old `
      + "the captures behind it are (#128). State the date the gate ran, the way the denominator and the "
      + "withdrawal are already required above.");
    return;
  }
  if (ON_THE_N_REAL_PAGES.test(claim)) {
    assert.match(claim, DATED_ON_THE_N_REAL_PAGES,
      `${file} states a real-page figure phrased "on the N conformant real pages of ..." with no date `
      + "immediately beside it, so a reader cannot tell how old the captures behind it are (#128, #1652). "
      + 'State the date right before "on the N conformant real pages of", the way #1630\'s own sentence '
      + "does -- a date elsewhere in the same block belongs to a different figure and does not count.");
    return;
  }
  // withdrawn, or states no real-page figure at all -- covered above
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

test("PROOF (#1652): 'on the N conformant real pages of ...' renders normally dated, and not when the "
  + "date is dropped -- #1630's own sentence, reproduced exactly", () => {
  // CONTROL: #1630's actual, undamaged sentence.
  assert.doesNotThrow(() => assertRealPageAsOfDate(
    "Measured 2026-09-14 on the 41 conformant real pages of the calibration set at the shipped floor "
    + "(run 2f9c51aa): 0 criteria asserted wrongly, 422 referred.", "synthetic"));

  // MUTATION: the exact reproduction the row's Evidence/Open-check describe -- the date dropped, nothing
  // else changed. Before this row, all three Acceptance files stayed green on this text.
  assert.throws(() => assertRealPageAsOfDate(
    "Measured on the 41 conformant real pages of the calibration set at the shipped floor (run 2f9c51aa): "
    + "0 criteria asserted wrongly, 422 referred.", "synthetic"),
    /on the N conformant real pages of/,
    "#1630's sentence with its date dropped must be caught -- this is the exact regression #1652 exists "
    + "to close");
});

test("PROOF (#1652): a date belonging to a DIFFERENT figure elsewhere in the block does not excuse this "
  + "figure's own missing date", () => {
  // Same shape as README.md's real block: the 41-page figure's date is dropped, but the paragraph still
  // carries the SUPERSEDED product-path figure's own date a sentence later. A check that asked only
  // "does some date appear anywhere in this claim" would read this as dated -- #1599 M2's lesson, applied
  // to this new shape rather than re-learned by it.
  assert.throws(() => assertRealPageAsOfDate(
    "Measured on the 41 conformant real pages of the calibration set: 0 criteria asserted wrongly, 422 "
    + "referred. The 2026-08-24 18-page product-path figure is superseded: re-derived on the 17 of those "
    + "pages still in the corpus, 0 asserted wrongly, 180 referred.", "synthetic"),
    /on the N conformant real pages of/,
    "the 2026-08-24 date belongs to a different, superseded figure and must not source this one");
});

test("PROOF (#1599 M2): a stale figure quoted beside an undated withdrawal does not excuse the missing date", () => {
  // The bug this closes: the POPULATIONS loop below `continue`s the moment its figure regex matches
  // ANYWHERE in the block, so a historical number sitting near a dateless "under re-measurement." made the
  // whole population read as "stated", and the missing date was never asked for.
  assert.throws(() => assertDenominators(
    "84 conformant records the tool asserted no failures on. The real-page figure is under re-measurement. "
    + "The 2026-08-24 figure was 18 conformant real pages, 0 asserted wrongly, 4 referred.",
    "synthetic"),
    /under re-measurement/,
    "a dateless 'under re-measurement.' must fail even with an old real-page figure quoted right beside it");

  // The fix does not fire on a genuinely dated withdrawal, historical figure and all -- this is the shape
  // README.md and docs/try-it.md actually use today.
  assert.doesNotThrow(() => assertDenominators(
    "84 conformant records the tool asserted no failures on. The real-page figure is under re-measurement "
    + "since 2026-09-14. The 2026-08-24 figure was 18 conformant real pages, 0 asserted wrongly, 4 "
    + "referred.",
    "synthetic"));
});

test("the claim block is reachable from the README a stranger opens", () => {
  // A guard over a block nobody renders is a guard over nothing.
  const readme = readFileSync(path.join(REPO, "README.md"), "utf8");
  assert.match(readme, /## What this tool claims, with the number it was measured on/,
    "the claim must be a section of the README, not a hidden comment block");
});

/* #2451: THE CALIBRATION READING IS ONE PAIR IN THREE FILES, AND THE README'S COPY IS THE ANCHOR.
 *
 * `N criteria asserted wrongly, M referred` sits in README's claim block, in CLAUDE.md and in the record's
 * current-reading section. The README's copy is the one the sourcing test above ties to a recorded gate, so
 * the other two are compared to IT and not to a literal here -- a literal would be the test that enforces
 * staleness (see the note after `assertDenominators`). Why CLAUDE.md is compared without being scanned is
 * answered beside `CLAIM_FILES`, in the #1599 note.
 *
 * `\s+` between the words because all three files hard-wrap, and the record's copy does split across a
 * line ("asserted wrongly,\n395 referred."). Only the "criteria asserted wrongly" phrasing is the current
 * reading: the record's superseded paragraph says "0 asserted wrongly, 422 referred" without "criteria",
 * which is why it can sit in the same section and not be mistaken for a second current reading.
 *
 * The THIRD copy the row's Open-check lists (`operational-lessons.md`, "CLAUDE.md's index prose, before
 * #2217 shortened it") is a verbatim archive of what CLAUDE.md said at that date and is dated in its own
 * text, so it is deliberately outside the section this reads. */
const READING_PAIR = /\b(\d[\d,]*)\s+criteria\s+asserted\s+wrongly,\s+(\d[\d,]*)\s+referred\b/g;
const RECORD_READING_HEADING = "## What ASSERTED versus REFERRED was measured at";

function readingPairsIn(text: string): string[] {
  return [...text.matchAll(READING_PAIR)]
    .map(([, wrong, referred]) => `${wrong.replace(/,/g, "")} asserted wrongly, ${referred.replace(/,/g, "")} referred`);
}

function recordReadingSection(): string {
  const text = readFileSync(path.join(REPO, "docs/operational-lessons.md"), "utf8");
  const begin = text.indexOf(`\n${RECORD_READING_HEADING}\n`);
  assert.ok(begin !== -1,
    `docs/operational-lessons.md has no "${RECORD_READING_HEADING}" section, so the record's copy of the `
    + "calibration reading is not being compared with anything (CLAUDE.md links to that heading)");
  const next = text.indexOf("\n## ", begin + 1);
  return text.slice(begin, next === -1 ? undefined : next);
}

function assertReadingCopies(copies: { readme: string; claude: string; record: string }): void {
  const anchor = readingPairsIn(copies.readme);
  assert.ok(anchor.length <= 1,
    `README's claim block states the calibration reading ${anchor.length} times (${anchor.join(" | ")}), so `
    + "there is no single reading for CLAUDE.md and the record to be compared with");
  if (anchor.length === 0) {
    // Withdrawn is the ONE honest way for the README to state no pair, and it must say so: without this an
    // edit to the README's phrasing blinds the regex above and both comparisons below pass on nothing.
    assert.match(copies.readme, /under\s+re-measurement\b/i,
      "README's claim block states no `N criteria asserted wrongly, M referred` pair and does not say it is "
      + "under re-measurement, so this guard can no longer see the reading it exists to compare");
    assert.deepEqual([readingPairsIn(copies.claude), readingPairsIn(copies.record)], [[], []],
      "README's claim block has withdrawn the calibration reading, but CLAUDE.md or "
      + "docs/operational-lessons.md still states one -- the stale claim, wearing a file nobody scans");
    return;
  }
  assert.deepEqual(readingPairsIn(copies.claude), anchor,
    `CLAUDE.md's calibration reading is not README's (${anchor[0]}). Move it in the same change that moved `
    + "the README's; the README's is the one a recorded gate sources.");
  assert.ok(readingPairsIn(copies.record).includes(anchor[0]),
    `docs/operational-lessons.md's "${RECORD_READING_HEADING}" section does not state README's calibration `
    + `reading (${anchor[0]}) as its current one. Move it in the same change that moved the README's.`);
}

test("the calibration reading is the same pair in README, CLAUDE.md and the record", () => {
  assertReadingCopies({
    readme: claimBlockIn("README.md"),
    claude: readFileSync(path.join(REPO, "CLAUDE.md"), "utf8"),
    record: recordReadingSection(),
  });
});

test("PROOF (#2451): editing the pair in any ONE of the three files turns the comparison red, and only then", () => {
  const pair = (wrong: number, referred: number, sep = " ") =>
    `**${wrong} criteria asserted wrongly,${sep}${referred} referred**`;
  const copies = (over: Partial<Record<"readme" | "claude" | "record", string>> = {}) => ({
    readme: `On our own corpus ... Measured 2026-09-24 ...: ${pair(0, 395)}. The 2026-08-24 figure is superseded: 0 asserted wrongly, 180 referred.`,
    claude: `Measured 2026-09-24 on the calibration set at protocol 21: ${pair(0, 395)} -- a reading at a moment.`,
    // The record wraps mid-pair, and quotes superseded readings WITHOUT "criteria" in the same section.
    record: `${pair(0, 395, "\n")}.\n\n**Superseded readings.** 2026-09-14: 0 asserted wrongly, 422 referred.`,
    ...over,
  });

  // CONTROL: the undamaged three, wrapped record copy and superseded readings included.
  assert.doesNotThrow(() => assertReadingCopies(copies()));

  // MUTATION, once per file -- the same edit reviewer-2 made to CLAUDE.md alone on #2418 (395 -> 394).
  assert.throws(() => assertReadingCopies(copies({ claude: pair(0, 394) })), /CLAUDE\.md/);
  assert.throws(() => assertReadingCopies(copies({ record: pair(0, 394, "\n") })), /operational-lessons\.md/);
  assert.throws(() => assertReadingCopies(copies({ readme: pair(0, 394) })), /CLAUDE\.md/);
  // The other half of the pair, and a superseded quote is not a substitute for the current reading.
  assert.throws(() => assertReadingCopies(copies({ claude: pair(1, 395) })), /CLAUDE\.md/);
  assert.throws(() => assertReadingCopies(copies({ record: "0 asserted wrongly, 395 referred" })),
    /operational-lessons\.md/);
});

test("PROOF (#2451): a withdrawn README reading must be withdrawn everywhere, and a blinded regex is refused", () => {
  const withdrawn = "The reading is under re-measurement since 2026-09-25.";
  assert.doesNotThrow(() => assertReadingCopies({ readme: withdrawn, claude: "no pair", record: "no pair" }));
  assert.throws(() => assertReadingCopies(
    { readme: withdrawn, claude: "**0 criteria asserted wrongly, 395 referred**", record: "no pair" }),
    /withdrawn/);
  // README rephrased so the pair is not recognised and nothing says withdrawn: the guard must not go quiet.
  assert.throws(() => assertReadingCopies(
    { readme: "0 asserted wrongly, 395 referred", claude: "no pair", record: "no pair" }), /can no longer see/);
  assert.throws(() => assertReadingCopies({
    readme: "0 criteria asserted wrongly, 395 referred; 0 criteria asserted wrongly, 180 referred",
    claude: "", record: "" }), /states the calibration reading 2 times/);
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
 * row that asked for this said so. So there are TWO signatures, both narrow: a RESULT OVER A DENOMINATOR
 * — an outcome word (`false positives`, `true positives`, `asserted wrongly`, `conformant records`) in the
 * same sentence as a figure — or a NUMERIC TRANSITION, a before-and-after pair joined by an arrow
 * (`headings went 5 → 0`). Prose that merely mentions a number is not matched at all; prose that reads
 * like a claim IS matched, and is then classified rather than silently excused, because "nothing
 * distinguishes a measured public claim from prose that reads like one" is the row's actual finding.
 *
 * THE TRANSITION SIGNATURE IS #338: `docs/try-it.md:73` — "headings went 5 → 0, links 6 → 1, graphics
 * 1 → 0" — carries none of the OUTCOME words above, so the first signature alone could never see it, and
 * it is the single interpretive instruction that tells a first reader whether a thin report means their
 * page is fine or their run was swallowed by a consent overlay. An arrow between two figures is narrow on
 * purpose: checked against every CLAIM_FILES today, it matches ONLY this sentence — a version number, a
 * WCAG criterion, a line count and a CLI flag never take this shape, because none of them is a recorded
 * before-and-after.
 *
 * A discovered sentence passes if EITHER every figure in it is sourceable from a recorded gate, OR it is
 * classified below with a reason. Nothing passes by being outside a block.
 * ------------------------------------------------------------------------------------------------ */

const OUTCOME =
  /\b(false positives?|false negatives?|true positives?|asserted wrongly|conformant records?|conformant pages?)\b/i;
const FIGURE = /\b(zero|no|\d[\d,]*)\b/i;
const NUMERIC_TRANSITION = /\d[\d,]*\s*(?:→|->)\s*\d[\d,]*/;

/**
 * #1599: A FIGURE IS SOURCED BY ITS PHRASE, NOT BY ITS DIGITS. The bug this row fixes: `gates.includes(n)`
 * asked only whether a figure's digits occur anywhere in the ENTIRE joined corpus of every gate ever
 * recorded, so "41" was "sourced" by a diff hunk header (`41c41`) and "422" by a timestamp
 * (`…30-422Z-…`) in some unrelated entry -- neither gate said anything about this claim at all.
 *
 * The fix asks a narrower, truthful question: does ONE recorded gate ENTRY contain this figure as its own
 * token (not a fragment of a longer number, a hash, or a timestamp) AND, in that SAME entry, the outcome
 * word the claim uses it beside ("referred", "asserted wrongly", "conformant records", ...)? A gate's own
 * output is often a TABLE ("floor scored conformant asserted-wrongly ... referred" with the figures in a
 * row below it) rather than the claim's own prose shape, so this does not require the exact phrase as a
 * contiguous substring -- only that the figure and the word it is claimed beside came from the same run.
 */
const OUTCOME_HINTS: readonly RegExp[] = [
  /\bfalse\s+positives?\b/i,
  /\bfalse\s+negatives?\b/i,
  /\btrue\s+positives?\b/i,
  /\basserted\b/i,
  /\bwrongly\b/i,
  /\bconformant\b/i,
  /\brecords?\b/i,
  /\bpages?\b/i,
  /\breferred\b/i,
];

/** Which of `OUTCOME_HINTS` a claim-like sentence actually uses -- only those are asked of a gate entry,
 * so a figure is never sourced by a hint the sentence never made. */
function outcomeHintsIn(text: string): RegExp[] {
  return OUTCOME_HINTS.filter((hint) => hint.test(text));
}

/** A figure token, bounded so it cannot match as a FRAGMENT of a longer number, a hash, or a timestamp --
 * `41` must not match inside `41c41` or `2026-09-08T17:17:14Z`'s digits either side of it. */
function figureToken(digits: string): RegExp {
  return new RegExp(`(?<![\\w.])${digits}(?![\\w.])`);
}

/** True if SOME recorded gate entry contains this figure as its own token AND, in that same entry, at
 * least one of the sentence's own outcome words -- the two facts have to come from the same run, not
 * merely from the same multi-megabyte pile of everything ever recorded. */
function figureSourcedByPhrase(digits: string, hints: RegExp[], entries: string[]): boolean {
  if (hints.length === 0) return false; // no outcome word at all -- nothing for this figure to sit beside
  const token = figureToken(digits);
  return entries.some((entry) => token.test(entry) && hints.some((hint) => hint.test(entry)));
}

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
    const isMeasuredClaim = (OUTCOME.test(text) && FIGURE.test(text)) || NUMERIC_TRANSITION.test(text);
    if (isMeasuredClaim) found.push({ line: index + 1, text: text.trim() });
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
  "Measured in `907ed704`": "#338: a REAL measurement -- verbatim in the commit cited inline, 2026-08-03 "
    + "-- but it predates the board-recording mechanism (introduced 2026-09-06) entirely and describes a "
    + "one-time corpus audit taken when this rule pair was added, not a recurring board-gate metric this "
    + "guard's `docs/board/reported.json` sourcing was built to represent. Two other paths were tried and "
    + "both were worse: writing a fabricated `reported.json` entry would claim a live gate run nobody "
    + "performed just now, and verifying the citation against `git log` fails in CI's OWN checkout -- "
    + "`actions/checkout@v4` defaults to `fetch-depth: 1` for this job, so the commit this cites is not an "
    + "object CI's shallow clone has, and a check that can never pass under real conditions is worse than "
    + "no check. Accepted here with its provenance stated in the prose itself (the hash), checkable by "
    + "hand, rather than machine-verified.",
  // #1599: THREE NEW ENTRIES, found by switching the sourcing check from "digits anywhere" to "this "
  // figure, beside this outcome word, in the same gate entry" -- none of these three ever had a gate to
  // be sourced from; they passed only because their digits happened to occur somewhere in the corpus.
  "true positives: the search box is announced as a bare `edit`":
    "The three digits here (3.3.2, 4.1.2) are WCAG CRITERION NUMBERS in parentheses, not a count -- "
    + "`news.ycombinator.com`'s '3 findings, all true positives' is the actual claim, but it sits on the "
    + "PREVIOUS physical line (these files hard-wrap), which this LINE-scoped check never joins to this "
    + "one. No gate has ever recorded 'true positive' as a word at all -- there is no board-gate metric "
    + "for it, only this one demo run's own transcript, which is not machine-checkable here.",
  "3 findings, all true positives, none from the trained scorer":
    "A real, reproduced measurement (#1367: the V1 rehearsal's original run, its re-run, and a fresh "
    + "capture at commit `a8894c27`, all found the same 3 axe-core violations) with its provenance stated "
    + "inline, the same class as the 'Measured in `907ed704`' entry above -- but there is no board-gate "
    + "metric named 'true positive' for ANY recorded gate to source this figure from (checked: the word "
    + "never appears in `docs/board/reported/gates/`), so it is disclosed rather than machine-sourced.",
  // #2089: THREE ENTRIES for #1663's reach-variance finding, landed by #2049. All three carry figures
  // from the SWEEP's own instrumentation (`domCensus`, reach counts) over six recorded samples of
  // `w3.org/WAI`. Recorded gates DO print a `census heading=N link=N` line -- but only for the pages in
  // the real-pages job (`edinburgh-castle link=1`, `leeds link=74`), never for `w3.org/WAI`, and no gate
  // records a REACH count for any page at all. So there is no entry for these figures to be sourced from.
  "held constant at `link=75` while reach went":
    "#1663's six-sample instrument reading, not a board-gate metric. `link=75` is this page's own "
    + "`domCensus`, and 13/17/40/80 are how many links the SWEEP reached across six samples -- the whole "
    + "point of the sentence is that the two diverge. No recorded gate runs `w3.org/WAI` (the real-pages "
    + "job's census lines cover other pages), and no gate records a reach count for any page, so neither "
    + "figure has an entry to co-occur with. The provenance is the six samples named in the sentence.",
  "Only the last step, 80 → 84, is the live page changing":
    "The same six-sample instrument reading as the entry above, carrying its one genuine page-change "
    + "step. It is a statement about a LIVE third-party page moving between two captures, which no gate "
    + "in this repository measures and none should -- a recorded gate would pin a number that w3.org is "
    + "free to change again tomorrow. Disclosed with its apparatus (the census moved with it) inline.",
  "figures rest on the census above rather than on identity":
    "A back-reference to the two entries above, stating which evidence the 13 → 80 figures DO rest on -- "
    + "it introduces no measurement of its own. `UNCOMPARABLE` is `compareIdentity`'s verdict word, not "
    + "an outcome a gate scores, and the three result fixtures it describes are fixtures precisely "
    + "because they dropped what `documentIdentity` reads. Nothing here is sourceable, by construction.",
  "headings went 5":
    "Measured once on this project's own local test page, illustrating what a consent-overlay swallowing "
    + "the whole run looks like -- the same class as the 'Measured in `907ed704`' entry above (a real, "
    + "reproducible measurement predating the board-recording mechanism) but with no commit to cite: it "
    + "describes the TOOL's behaviour on a fixture page anyone can reload, not a corpus/real-page metric "
    + "`docs/board/reported/` was built to track.",
};

/**
 * #338: this used to read `claimLikeLinesOutsideBlocks("README.md")` ALONE. The duration-promise check
 * below it already looped over every `CLAIM_FILES` entry; this one did not, so `docs/try-it.md:73` — 92
 * lines above that file's own CLAIM block — was invisible to the figure guard no matter what it said,
 * the exact "guarded file, unguarded line" shape #313 fixed for durations and left standing here.
 */
function assertMeasuredClaimSourced(file: string): void {
  const entries = recordedGateEntries();
  const discovered = claimLikeLinesOutsideBlocks(file);
  const offenders = discovered
    .filter(({ text }) => !Object.keys(NOT_A_MEASURED_CLAIM).some((key) => text.includes(key)))
    .filter(({ text }) => {
      const hints = outcomeHintsIn(text);
      return figuresIn(text).some((n) => !figureSourcedByPhrase(n.replace(/,/g, ""), hints, entries));
    })
    .map(({ line, text }) => `  ${file}:${line}  ${text.slice(0, 90)}`);

  assert.deepEqual(offenders, [],
    "these sentences read as a measured result, sit OUTSIDE the claim block, and carry a figure no "
    + "recorded gate ENTRY prints beside the outcome word this sentence uses it for (a figure found only "
    + "by coincidence -- a hash, a timestamp, an unrelated entry's own count -- no longer counts):\n"
    + offenders.join("\n")
    + "\n\nThe claim block is not the boundary of what a reader acts on. Either source the figure from a "
    + "recorded gate in docs/board/reported/, move the sentence inside the block, or classify it in "
    + "NOT_A_MEASURED_CLAIM with a reason.");
}

test("every claim-like sentence OUTSIDE the block is sourceable, or classified with a reason", () => {
  // A signature this specific finding NOTHING would mean the scan broke, not that the docs are suddenly
  // clean of measurement prose -- twelve matched by hand in README.md alone during this unit's original
  // survey, plus try-it.md:73 once #338 taught the scan the numeric-transition shape.
  const discovered = CLAIM_FILES.flatMap((file) => claimLikeLinesOutsideBlocks(file));
  assert.ok(discovered.length >= 9,
    `only ${discovered.length} claim-like sentence(s) found outside the block across ${CLAIM_FILES.length} `
    + "file(s); the scan is broken, not the docs suddenly free of measurement prose");

  for (const file of CLAIM_FILES) assertMeasuredClaimSourced(file);
});

test("every classification still matches a real sentence, so none excuses a problem that moved", () => {
  // The vacuity guard. An entry keyed on text that no longer appears excuses nothing while making the
  // list look like coverage -- and this file's own history is the argument: an exemption held "1,398" on
  // a premise that later stopped being true, and kept a stale number in the public claim while the test
  // reported green.
  const text = CLAIM_FILES
    .flatMap((file) => claimLikeLinesOutsideBlocks(file).map((l) => l.text))
    .join("\n");
  for (const [key, reason] of Object.entries(NOT_A_MEASURED_CLAIM)) {
    assert.ok(reason.length > 40, `NOT_A_MEASURED_CLAIM["${key}"] needs a real reason, not a placeholder`);
    assert.ok(text.includes(key),
      `NOT_A_MEASURED_CLAIM["${key}"] no longer matches any discovered sentence -- the prose was edited `
      + "or the scan drifted. Delete the entry, or re-check the signature.");
  }
});

test("PROOF (#1599 M3/M4): a figure is sourced by co-occurring with its outcome word in ONE gate entry, "
  + "not by digits found anywhere across every entry", () => {
  // Two synthetic entries, standing in for `docs/board/reported/gates/*.json`. Entry A never mentions a
  // measurement outcome at all; entry B is where the real 41/0/422 figures actually live, beside the
  // words a reader would recognise them by.
  const entryA = "run A: 18 commits on the PR, 4 recorded refusal(s), never captured";
  const entryB = "run B: floor 0.6557  scored 44  conformant 41  asserted-wrongly 0  referred 422";
  const entries = [entryA, entryB];
  const sourced = (n: string, text: string) => figureSourcedByPhrase(n, outcomeHintsIn(text), entries);

  const real = "Measured ... 41 conformant real pages ...: 0 criteria asserted wrongly, 422 referred.";
  for (const n of ["41", "0", "422"]) {
    assert.ok(sourced(n, real), `${n} sits beside its outcome word in entry B and must be sourced`);
  }

  // M3: restoring the old undated line reuses 18 and 4 -- both DO appear somewhere in the corpus (entry
  // A), which is exactly the coincidence the old `gates.includes(n)` rule fell for (README.md:34's "18
  // real pages ... 4 referred", #1599). Neither ever sits beside "real pages" or "referred" in any entry,
  // so the phrase check must reject both, or the mutation this row exists to catch is back.
  const restored = "Measured on 18 real pages … 0 criteria asserted wrongly, 4 referred.";
  assert.equal(sourced("18", restored), false,
    "18 sits only in entry A, never beside 'real pages' -- coincidence must not source it");
  assert.equal(sourced("4", restored), false,
    "4 sits only in entry A, never beside 'referred' -- coincidence must not source it");

  // The mutation itself, stated rather than merely implied: the OLD rule this row replaces asked only
  // whether the joined corpus CONTAINS the digits, with no entry or outcome-word requirement at all. If
  // that rule comes back, this exact fixture reads sourced for 18 and 4 -- the failure this row is about.
  const oldRuleJoinedCorpus = entries.join("\n");
  assert.ok(["18", "4"].every((n) => oldRuleJoinedCorpus.includes(n)),
    "this fixture only proves the row's point if 18 and 4 really are present by coincidence in the "
    + "corpus -- if this stops being true the fixture needs new numbers, not a passing test");
});

test("PROOF: prose with a number and no outcome is NOT matched, or the guard gets switched off", () => {
  // The half that keeps this usable, driven on synthetic text so it holds whatever the README says today.
  assert.equal(OUTCOME.test("It is ~100 lines and about a second, but it pulls half a gigabyte."), false);
  assert.equal(OUTCOME.test("Measured on 18 real pages; the capture took 12.4 seconds."), false,
    "a figure with a unit is not a claim about findings");
  assert.ok(OUTCOME.test("zero false positives across 1,183 conformant records"),
    "and the sentence this row is about must still match, or the guard covers nothing");
});

test("PROOF: a numeric transition matches with no OUTCOME word, and a version-like number does not", () => {
  // #338's actual addition. try-it.md:73 carries none of the OUTCOME words, so this is the shape that
  // proves the transition signature is doing real work rather than being redundant with OUTCOME/FIGURE.
  assert.ok(NUMERIC_TRANSITION.test("headings went 5 → 0, links 6 → 1, graphics 1 → 0."),
    "the sentence this row is about must match, or the guard still cannot see it");
  assert.ok(NUMERIC_TRANSITION.test("throughput rose from 36.7 -> 12.4 s"), "the ASCII arrow form too");
  assert.equal(NUMERIC_TRANSITION.test("capture -> axe -> judge -> report"), false,
    "a pipeline diagram with no digits either side of an arrow is not a measured transition");
  assert.equal(NUMERIC_TRANSITION.test("Perceive → Navigate → Interact"), false,
    "words joined by an arrow are not a transition just because the arrow this repo also uses appears");
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
  "checked before you spend the minutes":
    "'Spend the minutes' is idiomatic for wasted effort, not a duration figure, and the promise-verb match "
    + "in the same bullet ('takes us one capture to answer') counts CAPTURES, not time -- there is no "
    + "duration claim in this sentence for a gate to source.",
  "Expect three to eight minutes for a real page":
    "#1060, superseding #396's entry for the same sentence, itself superseded 2026-09-19 by #311's "
    + "reconciliation with #915. A REAL, sourced duration promise -- 3 m 14 s / 3 m 45 s / 4 m 14 s / "
    + "4 m 32 s / 4 m 38 s / 4 m 50 s / 5 m 48 s / 5 m 52 s / 6 m 35 s / 7 m 52 s / 7 m 54 s across eleven "
    + "real-page runs, cited inline with the issues that recorded them (#311, #915). Still a one-time "
    + "orchestrator-run timing measurement rather than a recurring board-gate metric, and still disclosed "
    + "in the prose rather than machine-verified, for the reason #338 settled on: verifying an inline "
    + "citation against git history fails in CI's shallow checkout. WHAT CHANGED (2026-09-19): #915's own "
    + "edit narrowed the population to five runs and a FOUR-to-eight range, silently dropping #311's other "
    + "six measured runs -- including 3 m 14 s, the genuine fastest of the eleven, which sits below that "
    + "floor. product-manager's 2026-09-11 ruling on #311 had already decided THREE-to-eight for exactly "
    + "this reason; the reconciliation restores it with the fuller n. This guard could not see the earlier "
    + "drift, because it asks whether a duration promise is SOURCED and not whether the source agrees with "
    + "it. `try-it-runnable.test.ts` asks the second question.",
  "Expect three to eight minutes**, per the measurement above":
    "The second mention of the same measurement, in the 'how long a large page takes' section -- same "
    + "sourcing, same reasoning as the entry above; kept separate because #313's own history is that a "
    + "figure fixed in one copy and left stale in a second is this repo's most expensive recurring shape. "
    + "#1060 pins the two copies EQUAL as well as classifying them separately: the range stated anywhere "
    + "on the page must match the one inside the timing block.",
  "The snippets above set `timeout-minutes: 20` on the job":
    "#1518: a designed CEILING, not a promise about how long a run takes -- its derivation (a bit over "
    + "twice the slowest job measured, 9 m 20 s) is stated inline against figures the same paragraph "
    + "already gives, not read from a recorded gate. The thing this guard exists to catch is a duration "
    + "promised and never checked against reality; a deliberately generous safety margin is a different "
    + "claim, and #1518's own account is that NO ceiling at all is the defect.",
  "| a Windows machine already |":
    "#1060: one-time SETUP times in a routing table (about twenty minutes with a Windows machine, 1.5-2 "
    + "hours to build a VM), the same class as 'Getting one takes ~20 minutes' above and for the same "
    + "reason: no capture gate has ever measured, or should measure, a one-time Windows setup step.",
  "unreachable in a user's first ten minutes":
    "Newly discovered by #324's V1 rehearsal, which added examples/workflow.yml to CLAIM_FILES for the "
    + "first time -- this describes how quickly a PAST defect (probe-forms silently off) would have been "
    + "noticed, not a promise about how long using this tool takes. There is no duration claim here for a "
    + "gate to source.",
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
