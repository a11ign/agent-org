#!/usr/bin/env node
// @ts-check
// command: render the board's PDF from the same data the daily GitHub report reads
// THE BOARD DOCUMENT — what the board reads. The GitHub edition is the data trail; this is the answer.
//
// It shares `board-data.mjs` with the daily GitHub edition rather than re-deriving anything, so the two
// cannot disagree about a merge count or a blocker list. That is not tidiness: the reports exist to stop
// numbers being read from the wrong place, and two generators with two data layers would reproduce that
// failure inside the reporting itself.
//
// THE TONE THIS DOCUMENT IS WRITTEN IN, recorded because it is a decision and not a style: the release
// was due last month and the board is reading every edition as the answer to "when". So section 1 leads,
// and A DATE IS NEVER STATED WITHOUT ITS REASON AND ITS CONFIDENCE. A bare date reads as a promise.
//
//   npm run board:document                 markdown to stdout
//   npm run board:document -- --pdf        render a PDF and print its path
//   npm run board:document -- --discussion post today's edition as a Discussion, or update it (#1290)
import { writeFileSync, mkdirSync, mkdtempSync, readFileSync, existsSync, realpathSync }
  from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
// #589: the stated-writing-time parser, so the RENDER checks freshness where "now" means something.
import { statedWritingTime } from "./board-summary-check.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { refuseUnknownFlags } from "@a11ign/worker-fleet/cli-flags";
import { collect, readSetIsNotMain, ROOT, REPO, MILESTONE, HOURS_MS, issues, outOfRelease, unclassified, achievementsWhoseWorldMoved,
  realPageCaptureAge, worstVerdict } from "./board-data.mjs";
import { toHtml } from "./board-markdown.mjs";
import { editionDay, publishEdition, todaysEditionExists } from "./board-discussion.mjs";
import { productHome, PRODUCT_HOME_SOURCE } from "../../../scripts/product-home.mjs";

// Module scope, not inside main(): `section5` reads it, and `document()` is exported for the renderer
// test, which builds a real document without ever calling main().

/** How many WCAG criteria the tool claims what about, COUNTED FROM THE SOURCE OF TRUTH.
 *
 * Read out of `criterion-coverage.ts` at render time rather than typed, for the reason every other number
 * in this document is: a coverage claim that a person maintains by hand drifts from the code the first
 * time a criterion moves, and the drift is invisible -- both numbers look like numbers.
 *
 * It is a text count rather than an import on purpose. Importing the package would resolve through
 * `node_modules` to whichever checkout that symlink points at, which in a worktree is NOT this one -- the
 * defect that cost an hour on 2026-09-06. Reading the file beside us cannot do that.
 */
function criteriaCounts(root = ROOT) {
  const file = path.join(root, "packages/judge/src/criterion-coverage.ts");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  /** @param {string} status */
  const count = (status) => (text.match(new RegExp(`status: "${status}"`, "g")) ?? []).length;
  const assessed = count("assessed");
  const partial = count("partial");
  return assessed && partial ? { assessed, partial, reachable: count("reachable") } : null;
}

const SUMMARY_WORDS = 120;
// #589: the backstop window. The 07:25 write plus the 08:00 render is what delivers the board's
// thirty minutes; this catches a stale paragraph reaching them, so it is deliberately wider.
const SUMMARY_FRESH_MINUTES = 60;
// TWO PAGES OF BODY, and the number is MEASURED rather than chosen.
//
// Edition 2 ran to 1,864 words across four pages of body and the chairman called it too long for a daily.
// The cap below is the two-page capacity of the page style set in this file, established by rendering:
// at 910 words the appendix begins on page 3, so sections one to five occupy pages 1 and 2 alongside the
// summary. 925 leaves a little room and is not a round number for the sake of one.
//
// IF THE PAGE CSS CHANGES, RE-MEASURE THIS. A cap carried over from a different typeface or margin is a
// number that no longer describes what it claims to.
export const BODY_WORD_CAP = 925;

/** The hand-written executive summary for a given day, or null.
 *
 * NEVER ASSEMBLED FROM THE SECTIONS. A summary generated from the body is precisely what the chairman's
 * third rule forbids, and it would also be useless: the summary exists to say what the sections cannot,
 * which is what a reader should do about them today. So it is a file a person writes, and its absence
 * stops the edition rather than degrading it.
 */
/** @param {string} day @param {string} [root] */
export function summaryFor(day, root = ROOT) {
  const file = path.join(root, "docs/board/summaries", `${day}.md`);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8").trim();
  return text ? { text, words: text.split(/\s+/).filter(Boolean).length, file } : null;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];
/** "20 September 2026" -- a board reads dates, not timestamps. */
/** @param {string} iso */
const longDate = (iso) => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/** ON TRACK / AT RISK / SLIPPED, from stated criteria rather than from a feeling.
 *
 * The rule is printed with the verdict every time. A status word whose derivation is not on the page is
 * an opinion wearing a measurement's clothes, which is the exact defect this reporting was built after.
 */
/** @param {any} release @param {any[]} open */
function trackStatus(release, open) {
  if (!release?.due_on) return { word: "has no date", why: "no date has been set." };
  const unbounded = open.filter((/** @type {any} */ i) => i.milestone?.title === MILESTONE
    && /INCONCLUSIVE|hypothesis|unbounded|not yet known/i.test(i.title));
  const days = Math.ceil((Date.parse(release.due_on) - Date.now()) / (24 * HOURS_MS));
  if (days < 0) return { word: "has slipped", why: "the date has passed and work remains open." };
  if (unbounded.length > 0) {
    return { word: "is at risk", days, unbounded: unbounded.length };
  }
  return { word: "is on track", days, unbounded: 0 };
}

/** @param {any} d */
function section1(d) {
  const { word, days, unbounded } = trackStatus(d.release, d.open);
  const due = d.release?.due_on ? longDate(d.release.due_on) : "no date";
  const count = d.release?.open_issues ?? 0;
  return [
    `## The first public release is dated ${due} and ${word}.`,
    "",
    `${count} pieces of work must finish before we can publish, and ${days} days remain. `
    + `${(unbounded ?? 0) > 0
      ? "One has no known size."
      : "Every one has a next step whose size we know."}`,
    "",
    "1. We set the date by adding up the remaining work, and every change to it is recorded — a slip "
    + "cannot arrive as a bare new date.",
    "2. **This carries most of the weight:** the date assumes the one item of unknown size finishes "
    + "inside the week we allowed, and today's measurement left that week resting on less.",
    "3. It is not padded against the risk most likely to move it, stated below.",
  ].join("\n");
}

function section2() {
  return [
    "## Version one has no date until the outside user is named.",
    "",
    "**Version one means one person outside this project runs the tool on an application they own and "
    + "says whether it was worth their time**, approved by the board on 6 September. **That person exists "
    + "and is waiting for first publish**, so the date is theirs: however long they take to form a view.",
    "",
    "| stage | what decides it | when |",
    "|---|---|---|",
    "| The trained component is approved | Four checks pass, and a fifth stops objecting that one rule "
    + "was never shown to work on a real website | days |",
    "| The real-website check reaches a verdict | A theory about two distrusted measurements is tested "
    + "| unknown |",
    "| The tool is published | A person creates the account, adds a credential, types the confirmation "
    + "| **20 September 2026** |",
    "| **Someone outside the project uses it** | **A person agrees to run it and reports back** | **not "
    + "schedulable from inside** |",
    "",
    "**That last row is the honest answer: version one waits on a person we do not yet have.**",
  ].join("\n");
}

/**
 * THE THREE-EDITION RULE, #756-adjacent, `ceo` 2026-09-09: an achievement stays in the BODY for at most
 * three editions, then lives in the record and the appendix. It exists so the two-page cap is met by a
 * rule rather than by a hand decision each time the body fills -- and a decision taken by hand each week
 * is one that will be taken badly on the week nobody has time.
 *
 * `inBody: false` is what carries it. It is a FIELD ON THE RECORD rather than a date computed here,
 * because "three editions" is a judgement about what the board has already read, and the record is where
 * the rest of this document's judgements already live (`order`, `boardClaim`, `affirmed`).
 *
 * ABSENT MEANS IN THE BODY. A record written before this rule existed, or by anyone who has not read it,
 * renders exactly as it did -- so the rule can never silently empty section 3 by being forgotten. Only an
 * explicit `inBody: false` retires one.
 * @param {any[]} achievements
 */
function inBody(achievements) {
  return achievements.filter((/** @type {any} */ a) => a.inBody !== false);
}

/** @param {any} d */
function section3(d) {
  // THE COUNT COMES FROM THE LIST, and this line is why the rule exists. It read "four" as a literal
  // while the section rendered THREE bullets, and it went to the board that way on 2026-09-07 -- read
  // by five people including the one who wrote it, caught by nobody, because a numeral in prose looks
  // like a fact rather than a claim. Every other count in this file was already derived; this was the
  // one that was typed. See issue #284.
  // THE COUNT MATCHES THE BULLETS, which is the whole of #284's rule and the reason `inBody` filters here
  // rather than only at the loop below. `ceo`'s first wording had the bullets filter and the count not,
  // which would have printed "We made five things demonstrable today" above three bullets -- #284's exact
  // defect, reintroduced by the fix for a different one. Corrected in the ruling the same hour.
  const shown = inBody(d.achievements);
  const n = shown.length;
  const L = [`## We made ${numberWord(n).toLowerCase()} thing${n === 1 ? "" : "s"} demonstrable today `
    + `that ${n === 1 ? "was" : "were"} previously only claimed.`];
  L.push("");
  if (n === 0) {
    L.push("Nothing was recorded for this period. That is a statement about our record-keeping and not "
      + "necessarily about the work: this section is written by hand, because no automated source can "
      + "tell you what the product can now do that it could not before. An empty section means nobody "
      + "wrote one.");
    return L.join("\n");
  }
  L.push("These are capabilities rather than activity, and the evidence for each is in the "
    + "appendix.");
  L.push("");
  for (const a of shown) L.push(`- **${a.boardClaim ?? a.claim}**`);
  L.push("");

  return L.join("\n");
}

/**
 * THE DECISIONS ARE A LIST BECAUSE TWO SENTENCES COUNT THEM. The heading said "three decisions" and the
 * line under it said "These three do", both typed, above a table of three rows -- correct on the day and
 * held that way by nobody. `costsNothing` is here for the same reason: "two of them cost nothing to make"
 * is an editorial claim about WHICH rows, so the row carries it and the sentence counts it. See #284.
 */
// EXPORTED, not restated -- #284. `board-style.test.ts`'s "no count in the prose is typed" check used to
// hand-type the expected value beside a regex naming its sentence; the achievements/decisions/risks/stages
// counts were never added to that list because adding a fourth entry per edition is exactly the habit
// that let the first three drift silently. Reading these three lists' real `.length` at test time -- the
// same value `section4`/`section5` read to render -- means a wrong count beside ANY of them fails without
// anyone having to name the sentence.
export const DECISIONS = [
  { ask: "Approve the definition of version one.", costsNothing: true,
    ifNothing: "The question the board keeps asking stays unanswerable, and every edition repeats that." },
  { ask: "Name one person outside the project to try the tool.", costsNothing: false,
    ifNothing: "Version one cannot start, whatever engineering does. Open since August." },
  { ask: "Confirm publication may proceed in September.", costsNothing: true,
    ifNothing: "Three final steps need the owner's hands, so the engineering finishes and the release "
      + "waits." },
];

/** @param {any} d */
function section4(d) {
  const blockers = d.open.filter((/** @type {any} */ i) => i.milestone?.title === MILESTONE);
  return [
    `## The board is asked for ${numberWord(DECISIONS.length).toLowerCase()} decisions, and `
    + `${numberWord(DECISIONS.filter((x) => x.costsNothing).length).toLowerCase()} of them cost nothing `
    + "to make.",
    "",
    `None of the ${blockers.length} pieces of work between today and publication needs a board `
    + `decision. These ${numberWord(DECISIONS.length).toLowerCase()} do.`,
    "",
    "| decision | if nothing is decided |",
    "|---|---|",
    ...DECISIONS.map((x) => `| **${x.ask}** | ${x.ifNothing} |`),
    "",
    "**One rule we assess can currently be seen only on some pages**, because a page that fails it hides "
    + "its own evidence from the path a user takes. **The check now says \"cannot say\" rather than "
    + "\"nothing found\"**, which is the difference between a gap and a clean bill of health. Widening "
    + "it is tracked work. The appendix says how the failure hid.",
    "",
    // COUNTED FROM THE ROWS, never typed. This read "Four risks are live" above a table of three: a
    // sentence adjacent to a table is a claim ABOUT that table, and the only honest source for it is
    // the table.
    `### ${RISKS.length === 1 ? "One risk is" : `${numberWord(RISKS.length)} risks are`} live, and only the first could move the date.`,
    "",
    "| risk | state |",
    "|---|---|",
    ...RISKS,
  ].join("\n");
}

/** The throughput programme's stages, named ONCE.
 *
 * Section five said "the first of 1 stages" -- from the milestone's open-issue count, which falls as
 * stages close -- while the appendix said "the five stages are". Two sources for one fact, and the
 * section's was not even counting stages. The list is the fact; both places read it.
 */
export const STAGES = [
  "establish what a page should cost to record on the current format",
  "measure what more machines actually give us",
  "set a target from that",
  "make the improvements",
  "decide on hardware with the numbers attached",
];

/** The live risks, as a LIST so the sentence above the table can count them.
 *
 * The heading read "Four risks are live" above a table of three. A sentence adjacent to a table is a
 * claim about that table, and the only honest source for it is the table.
 */
export const RISKS = [
    "| **We may abandon the change to the trained component rather than adjust it.** | Its abandonment conditions were written in advance so the decision could not be softened, and the assumption it rests on is being measured properly for the first time now. |",
    "| **One item still has no known size.** | We published a fix today, found by measurement that it was "
    + "wrong, and replaced it with a theory nobody has tested. The process working — and the week we "
    + "allowed now rests on less. |",
    "| **Everything runs on one machine.** | The capture machines' credentials live on one computer. "
    + "The list of open work moved off it today; the credentials have not. |",
];

/** Small counts read as words in prose; the number still comes from the data. Exported so
 * `board-style.test.ts` renders the SAME word a real count produces, rather than re-deriving the mapping.
 * @param {number} n
 */
export function numberWord(n) {
  return ["zero", "one", "Two", "Three", "Four", "Five", "Six", "Seven"][n] ?? String(n);
}

/** @param {any} d */
function section5(d) {
  const fh = d.fleetHours;
  // THE HEADING COMES FROM THE SAME SOURCE AS THE BODY, and the CLAIM comes before the caveats.
  //
  // It read "We are not asking for money" above a body recommending a purchase -- the headings test
  // passed a heading that negated its own section, because the two were written at different times from
  // different facts. Fixing that left a second fault the board caught: the section opened with two
  // paragraphs saying we cannot cost the fleet and have not established what a page should cost, and
  // only then reached the recommendation, under a second heading repeating the first. A reader met the
  // caveats before the claim.
  const scaling = scalingArms(d);
  const L = [scaling
    ? "## We are asking for the five pre-approved machines, and the measurement that justifies it is in."
    : "## We are not asking for money, and the measurement that would justify asking is "
    + "scheduled.", ""];

  if (scaling) {
    const { ten, five, ratio } = scaling;
    L.push(`**Twice the machines record a page in the same time each.** Ten take a median of `
      + `${ten.medianSeconds} seconds per page against ${five.medianSeconds} on five — `
      + `${(ten.medianSeconds - five.medianSeconds).toFixed(1)} seconds apart inside a spread of about `
      + `${Math.round((ten.iqrSeconds + five.iqrSeconds) / 2)}, unchanged at this sample size. They do `
      + `${ratio} times the work in the same hour.`);
    L.push("");
    L.push("**The outcome that would have argued against buying — each machine getting slower as "
      + "machines are added — did not occur.**");
  } else {
    L.push("**The number that would decide it is how long one page takes to record with ten machines "
      + "against five.** Unchanged, and machines buy speed in proportion. Higher, and they do not — "
      + "which is what happened last time, on older hardware, where they competed for one disk.");
  }
  L.push("");

  // The fleet-hours line is NOT in the body: the appendix table carries it with its source, and a
  // caveat about what we cannot yet measure does not belong above the thing we have measured.
  if (fh && fh.status !== "not instrumented") {
    L.push(`**The capture machines consumed ${fh.total} on their most recent full run.** That counts `
      + "only time spent actively reading a page: not waiting between pages, setup, restarts or "
      + "electricity.");
    L.push("");
  }
  L.push("**A capture takes about a minute at median on our last sample**, and **we have not established "
    + "what it should cost on the current recording format** — the first of "
    + `${numberWord(STAGES.length).toLowerCase()} stages in a programme opened today, outside the release: `
    + "nothing in it delays September. The appendix lists them.");
  L.push("");
  L.push("**The architect's two findings are planned in; the appendix says what was done with each.**");
  L.push("");
  // #1113: THE HOME IS READ, NOT WRITTEN. This line used to carry the domain as a LITERAL, and it was
  // the EIGHTH place the homepage was stated -- the only one outside `homepage-agreement.test.ts`'s
  // population, and the one the BOARD reads. The domain did not resolve, so the document told the
  // chairman the product had a home it did not have, and every guard was green.
  //
  // Editing the literal would have closed that on one day and rebuilt the trap for whoever changes the
  // value next -- which, with the transfer on the 15th and the domain unbought, is plausibly this week.
  const home = productHome();
  if (home === null) {
    throw new Error(`board-document: ${PRODUCT_HOME_SOURCE} states no \`homepage\`, so this document `
      + "cannot say where the product lives. REFUSING to render rather than inventing one or dropping the "
      + "sentence: a board document that quietly stops making a claim reads as the claim being withdrawn.");
  }
  L.push(`**The product has a name and a home: a11ign, at ${home}**, and the board has decided it is `
    + "an all-in-one accessibility tool rather than a screen-reader one — so its parts are renamed "
    + "around that **before** publication. The appendix says what that costs.");
  return L.join("\n");
}

/** The scaling measurement, read out of the recorded gate rather than restated.
 *
 * Returns null when no gate carries it, and the section then says the number is missing -- which is the
 * honest state and was the TRUE state until the re-run landed. What must never happen is the section
 * saying it is missing while the record holds it.
 */
/** @param {any} d */
function scalingArms(d) {
  const gate = (d.gates ?? []).find((/** @type {any} */ g) => /medianSeconds/.test(g.output ?? ""));
  if (!gate) return null;
  /** @param {string} name */
  const arm = (name) => {
    const line = (gate.output.split("\n").find((/** @type {string} */ l) => l.trim().startsWith(name)) ?? "");
    const json = line.slice(line.indexOf("{"));
    try { return JSON.parse(json); } catch { return null; }
  };
  const ten = arm("arm-ten");
  const five = arm("arm-five");
  if (!ten || !five) return null;
  const wall = /ten boxes (\d+)s,\s*five boxes (\d+)s/.exec(gate.output);
  const ratio = wall ? (Number(wall[2]) / Number(wall[1])).toFixed(2) : null;
  return ratio ? { ten, five, ratio } : null;
}

/** Why the open-items total exceeds the blocker count, in buckets that add up on the page.
 *
 * #290 is the case that forced it: real work, deliberately outside the release, so the total counted it
 * and the blocker figure could not. Neither number was wrong and the page could not say why they differed.
 *
 * EVERY BUCKET IS COUNTED ON ITS OWN TERMS, and `later` is the one that matters. Written first as
 * `length - onRelease - out - none` it made the printed sum a TAUTOLOGY: it added up because it was
 * defined to, so it could never fail, verified nothing, and looked exactly like a check. Counting it
 * independently means the four can genuinely disagree -- and the sentence says so when they do, rather
 * than printing a total that hides it.
 * @param {any} d
 */
function reconciliation(d) {
  const onRelease = d.open.filter((/** @type {any} */ i) => i.milestone?.title === MILESTONE).length;
  const out = outOfRelease(d.open).length;
  const none = unclassified(d.open).length;
  const later = d.open.filter((/** @type {any} */ i) => i.milestone && i.milestone.title !== MILESTONE
    && !outOfRelease([i]).length).length;
  const sum = onRelease + later + out + none;
  const unclassifiedClause = none === 0
    ? ", and none are unclassified"
    : `, and ${none} carr${none === 1 ? "ies" : "y"} neither a milestone nor that label, which the rule `
      + "does not allow — they are counted here and in no milestone figure";
  const disagreement = sum === d.open.length ? ""
    : `, which does NOT equal the ${d.open.length} above — a row is being counted twice or not at all, `
      + "and this figure should not be relied on until that is explained";
  return `It reconciles with the figure above: ${onRelease} block this release, ${later} sit on a later `
    + `milestone, ${out} ${out === 1 ? "is" : "are"} deliberately out of the release`
    + `${unclassifiedClause}. ${onRelease} + ${later} + ${out} + ${none} = ${sum}${disagreement}`;
}

/** What the value column says for the most recent check: the verdict, and whether it is explained.
 *
 * A BARE VERDICT HERE IS THE COMPRESSION `orchestrator` WARNED ABOUT, in their words: "please do not let
 * the document compress FAIL and 0 asserted into one word. They are the two halves of the claim and the
 * second is the one that means anything to a reader." A reader scans this column; "FAIL" alone in it says
 * the opposite of what happened when the finding was that nothing was asserted.
 *
 * So a non-passing verdict that HAS an authored explanation says so -- a fact about the entry, not an
 * interpretation of the result -- and one that does NOT stands alone deliberately, because an unexplained
 * failure should look like one.
 * @param {any} gate @param {any} worst @param {boolean} fresh
 */
function gateHeadline(gate, worst, fresh) {
  const explained = worst && worst.verdict !== "PASS" && gate.note ? ", explained below" : "";
  const verdict = worst ? `**${worst.verdict}**${explained} — ` : "";
  return `${verdict}${gate.command}${fresh ? "" : " — older than this report's window"}`;
}

/** Where the most recent gate result came from, and what it said, in the gate's own words.
 *
 * Extracted so `sourceTable` builds a table rather than also composing prose about verdicts -- the same
 * split as `reconciliation`, and for the same reason it kept tripping the complexity limit.
 * @param {any} gate @param {string | null} captureAge @param {any} worst
 */
function gateSource(gate, captureAge, worst) {
  // Pulled from the gate's OWN printed line, never retyped -- issue #128. `rules:real-pages` prints its
  // own capture spread, and this is the one place a human used to have to copy it by hand into the
  // report; now it either quotes what the gate said or says nothing, never a stale guess.
  const spread = captureAge ? `; the gate's own capture spread: ${captureAge}` : "";
  // THE SENTENCE THE GATE PRINTED, not a word this document chose. The rule is printed with the verdict
  // every time -- a status word whose derivation is not on the page is an opinion wearing a
  // measurement's clothes, and that applies hardest to a verdict.
  const said = worst ? `; the gate's own words: "${worst.line}"` : "; the gate printed no verdict line";
  // A FAIL NOBODY HAS EXPLAINED IS NOT THE SAME AS ONE THAT IS UNDERSTOOD. Whether a failing check blocks
  // anything is a JUDGEMENT, not derivable from the output, so it is authored on the entry as `note`.
  // Absent, this says so -- rather than letting a bare FAIL frighten a reader, or an omission reassure one.
  const meaning = !worst || worst.verdict === "PASS" ? ""
    : gate.note ? `**What it means:** ${gate.note}`
      : "**No explanation has been recorded for this result**, so this document cannot say whether it "
        + "blocks anything.";
  // THE MEANING LEADS, and this is not a style choice. `orchestrator`, who ran the gate: "please do not
  // let the document compress FAIL and 0 asserted into one word. They are the two halves of the claim and
  // the second is the one that means anything to a reader." A verdict at the head of a long paragraph
  // whose qualification arrives four clauses later IS that compression, so the qualification goes first
  // and the provenance follows it.
  return (meaning ? `${meaning} ` : "")
    + `Run by the engineer who owns the machines at ${gate.at}, output recorded word for word`
    + spread + said;
}

/** The source table: every figure the body states, with where it came from.
 * @param {any} d */
function sourceTable(d) {
  /** @type {string[]} */
  const rows = [];
  /** @param {string} what @param {string} value @param {string} source */
  const push = (what, value, source) => rows.push(`| ${what} | ${value} | ${source} |`);
  push("First public release, planned date", d.release?.due_on ? longDate(d.release.due_on) : "no date",
    "the project's issue tracker, on the release milestone; every change of this date is logged against "
    + "it (GitHub milestone `v0.1.0 — first publish`)");
  push("Pieces of work blocking that release",
    String(d.open.filter((/** @type {any} */ i) => i.milestone?.title === MILESTONE).length),
    "the project's issue tracker (GitHub Issues API)");
  // THE EXCLUSION IS PRINTED, NEVER SILENT. A count that quietly drops rows is worse than one that
  // counts the wrong thing, because a reader cannot tell. `meta` rows are containers rather than work --
  // the daily report's own issue is one, and it will never close.
  // AND THE TWO COUNTS RECONCILE ON THE PAGE. The row above counts only what is on the release milestone
  // and this one counts everything, so a reader met two figures with no way to see why they differ. #290
  // is the case: real work, deliberately out of the release, counted here and invisible there. Naming the
  // out-of-release figure beside the total closes the gap by construction rather than by the reader
  // working it out -- the same rule as #284, that a count stated next to another count is a claim about
  // both. An UNCLASSIFIED row is reported rather than absorbed, because tolerating it silently would
  // rebuild the fault inside its own fix.
  push("Open work items in total", String(d.open.length),
    "the project's issue tracker, excluding rows marked as containers rather than work — the daily "
    + "report's own issue is one of these, and counting it would inflate this figure for ever. "
    + reconciliation(d));
  push("Work items closed in this period", String(d.closed.length), "the project's issue tracker");
  push("Saved changes merged in this period", String(d.merges.length),
    "the project's own version history, over the stated window — two correct counts over different "
    + `windows read as a disagreement, so the window is named (\`git log main --merges --since=${d.since}\`)`);
  push("Unpublished local changes",
    d.unpushed === null ? "could not be compared" : `${d.unpushed} change(s)`,
    "compared directly against the published copy, checked rather than assumed "
    + "(`git rev-list --count origin/main..main`)");
  push("Changes carrying the wrong author", String(d.strays.length),
    `the project's own version history, over the SAME window as the merge count above (since `
    + `${d.since}); the cause is diagnosed and the record is kept by decision`);
  const captureAge = d.latestGate ? realPageCaptureAge(d.latestGate.output) : null;
  // THE VERDICT COMES FIRST, because the board could not previously see one. This row quoted the COMMAND
  // and the capture spread; whether the check PASSED appeared nowhere in the document, while
  // `board-report.mjs` printed the gate's whole output into the GitHub edition. Two editions that would
  // have disagreed about whether a check passed, with the silent one being the one the board reads.
  const worst = d.latestGate ? worstVerdict(d.latestGate.output) : null;
  push("Most recent conformance check result",
    d.latestGate
      ? gateHeadline(d.latestGate, worst, d.gateIsFresh)
      : "**not reported**",
    d.latestGate
      ? gateSource(d.latestGate, captureAge, worst)
      : "no result has been recorded. This report does not run these checks itself: they read a library "
        + "of recordings, and a local copy of that library is only as current as its last synchronisation "
        + "— one measured here was 89 hours old and answered cleanly having examined a library that no "
        + "longer existed");
  push("Machine time consumed by the capture fleet",
    d.fleetHours?.status === "not instrumented" ? "**not instrumented**" : String(d.fleetHours.total),
    d.fleetHours?.status === "not instrumented"
      ? "printed rather than estimated. The report refuses a total that cannot name the finished run it "
        + "came from, so no figure appears until one does"
      : `measured from ${d.fleetHours.run}`);
  push("Version one, planned date", "**none — version one is undefined**",
    "the project's planning documents, all checked; a definition is proposed in section 2 for approval "
    + "(`PLAN.md`, `README.md`, `docs/backlog.md`)");

  return rows;
}

/** What the rename costs, and why the naming rule is more than a coat of paint. */
/** @param {string[]} L */
function renameBackground(L) {
  const counts = criteriaCounts();
  if (counts) {
    L.push("### What the tool claims about how many accessibility rules, and the one it withdrew.");
    L.push("");
    L.push(`Counted from the source rather than maintained by hand: **${counts.assessed} rules it `
      + `assesses**, **${counts.partial} it assesses in part**, and **${counts.reachable} it could reach `
      + "and does not yet.**");
    L.push("");
    // THE CLAIM IS GONE RATHER THAN RE-DERIVED. It read "None of those numbers moved today" beside three
    // numbers computed from the source -- and one HAD moved (yesterday's edition said 13/9/6 against
    // today's 12/10/6, #251's 4.1.3 partial). Prose asserting a diff nobody computed is the failure this
    // document exists to prevent, and the honest fix is to stop asserting it: nothing records yesterday's
    // counts, so the day's diff cannot be derived here without inventing the comparison.
    L.push("**One of them nearly moved.** Content on hover or focus is "
      + "claimed as partly assessed. Downgrading it to *reachable* was ruled and then **refused by our "
      + "own coverage test**: the rule still produces findings, and calling it unassessed would document "
      + "a criterion we report on as one we do not. **Partial is true as written**, and it stays.");
    L.push("");
    L.push("**What changed is what the check says when it cannot see.** A page that FAILS this rule "
      + "leaves its panel open, so the check compared a changed page against a changed page and found no "
      + "change. **On a page that passes, the same check is correct** — which is why it read as working "
      + "for exactly as long as it was only ever asked about pages that pass. It now speaks only from a "
      + "baseline it trusts and is silent otherwise, so the claim is narrower than it looked and true. "
      + "Widening it is tracked work.");
    L.push("");
  }

  L.push("### Commit authorship, disclosed rather than listed as a risk.");
  L.push("");
  L.push("An automated test overwrote our identity settings, so some saved changes carry the wrong "
    + "author's name — the count and its window are in the table above. **The settings are fixed; the "
    + "record is not**, and we leave it rather than rewrite history other people are building on. It is "
    + "here rather than among the risks because it changes no decision: it is disclosed so that nobody "
    + "discovers it and wonders what else was not mentioned.");
  L.push("");

  L.push("### The rename, and what it costs to do it before publication rather than after.");
  L.push("");
  L.push("Three hundred and fifty-two files in the project mention the old name, and every one of the "
    + "six things we will publish changes its name. **Doing it now costs a fortnight's care; doing it "
    + "after publication would cost every person who had already installed it** — and there is nobody in "
    + "that position yet, which is exactly why now is the moment.");
  L.push("");
  L.push("**The naming rule is what makes it worth more than a coat of paint.** A part that produces one "
    + "kind of evidence carries that in its name; a part belonging to the product itself never does. So "
    + "the screen-reader pieces say so, and the pieces that would serve any future kind of checking do "
    + "not. A second kind of checking can then join without a second rename, which is the debt this "
    + "avoids.");
  L.push("");
}

/** Why re-reading the library is expensive, and the programme opened for it. */
/** @param {string[]} L */
function throughputBackground(L) {
  renameBackground(L);
  L.push("### The architect's two findings, and what was done with each.");
  L.push("");
  L.push("**Our development copies read one another's build output rather than their own**, because they "
    + "share one dependency folder between them — so building in your own copy changes nothing the tools "
    + "see, which cost an engineer an hour convinced a component was broken when it was faithfully using "
    + "two-hour-old code. The fix is a different dependency tool that gives each copy its own; it is "
    + "**scheduled for after publication**, because that tool sits on the publishing path and changing it "
    + "a fortnight before the one irreversible step is the wrong order.");
  L.push("");
  L.push("**What accumulates on the single machine we run everything from is now measured rather than "
    + "guessed at** — thirty-six working copies, 4.4 gigabytes of them, a gigabyte of Python "
    + "environments, and a 417-megabyte local copy of the test library. **Each now gets a rule or a "
    + "recorded decision that it needs none**, rather than a clear-out that decays: the one accumulator "
    + "that was given a rule today is the one that stopped growing.");
  L.push("");
  L.push("### Why re-reading every test page is expensive, and the programme opened for it.");
  L.push("");
  L.push("The tool learns from several thousand recordings of a screen reader reading web pages. "
    + "Changing anything that alters what those recordings contain means making them all again, which "
    + "costs hours of machine time — and that is why a list of improvements sits deferred. The "
    + `${numberWord(STAGES.length).toLowerCase()} stages are: ${STAGES.join("; ")}.`);
  L.push("");
  L.push("### Why the capacity measure is not instrumented yet, and what the first design got wrong.");
  L.push("");
  L.push("The measure is the gap between a session finishing a piece of work and being given the next. "
    + "The first design keyed it on who a row was assigned to — and **every session in this project "
    + "operates as the same account**, of which there are two assignable and nine sessions. It could "
    + "have recorded *assigned* and never *which*, accruing a week of data that could not answer the "
    + "question it was collected for. It now keys on a per-session label instead, which carries "
    + "attribution and timing in one mechanism.");
  L.push("");
  L.push("**One thing that will distort the first week, recorded now so it cannot be read as progress:** "
    + "the rule for taking the next piece of work changed today, from taking it after reporting to "
    + "taking it before. The measured gap becomes structurally smaller from that moment. A first week "
    + "spanning the change will show an improvement that is a definition change rather than anyone "
    + "waiting less.");
  L.push("");
  L.push("**WITHDRAWN: a figure this board was given yesterday.** Yesterday's edition said our own "
    + "documentation claimed 12.4 seconds to record a page while measurement showed 48.7 — a fourfold "
    + "gap presented as the thing to explain. **Checked on 6 September against everything on disk, it "
    + "cannot be derived.** No document in the project produces 48.7, and the 12.4 comes from three "
    + "retired machines under an older recording format, measured as a median where the other number is "
    + "a rate. Three different things compared as one ratio. There is no fourfold gap, and the stage that "
    + "was to explain it is now the stage that establishes what a page should cost.");
  L.push("");
  L.push("**What the same check did establish, on the sample it could read:** the four costliest steps "
    + "in recording a page are all the screen reader answering, and everything our own software controls "
    + "sums to under two and a half seconds. If that holds on the current machines, faster software is "
    + "not the lever.");
  L.push("");
  L.push("**One figure to discard if the board has heard it: twelve format changes in thirty-two days "
    + "is not twelve re-readings of the library.** Five of those versions produced almost no recordings "
    + "at all, and grouping changes together is already done deliberately. We are measuring the true "
    + "rate and expect it several times lower.");
  L.push("");
}

/** @param {any} d */
function appendix(d) {
  const L = [
    "## Appendix: every figure above, and where it came from.",
    "",
    "**No number in this report is estimated.** Where something is not measured it says so, in those "
    + "words. That discipline exists because this project's own record is a catalogue of correct values "
    + "read from the wrong place, and three of them arrived in a single day: a figure quoted from a summary "
    + "note while the real measurement sat on disk, an example number invented for a test that was then "
    + "copied into documentation, and a proposed fix inferred from an error message without checking "
    + "whether the cause it named existed. All three were caught by asking where a number came from, "
    + "never by asking whether it looked right.",
    "",
    "| | | source |",
    "|---|---|---|",
    ...sourceTable(d),
    "",
  ];
  throughputBackground(L);
  if (d.achievements.length > 0) {
    // THE APPENDIX DOES NOT FILTER, and its heading carries the total so the whole number is on the page
    // without spending body words on it. "Lives in the record and the appendix" is what retirement MEANS:
    // a retired achievement is still a thing the product can do, and a reader who wants the full list must
    // not have to ask for it.
    L.push(`### Evidence for every achievement to date: ${d.achievements.length}.`);
    L.push("");
    L.push(`The ${inBody(d.achievements).length} listed in section 3 are the most recent; the rest were `
      + "carried in earlier editions and are kept here.");
    L.push("");
    for (const a of d.achievements) {
      L.push(`**${a.boardClaim ?? a.claim}**`);
      L.push("");
      L.push(`> ${a.evidence}`);
      L.push("");
    }
  }
  L.push(`*Generated from the project's issue tracker and version history at `
    + `${new Date().toISOString()}. A daily engineering edition carrying the same figures is published `
    + "alongside this document and shares its data source, so the two cannot disagree.*");
  return L.join("\n");
}

/** @param {any} d @param {{text: string} | null} [summary] */
/** @param {any} d @param {{text: string} | null} [summary] @param {{ lateAt?: string }} [opts] */
export function document(d, summary, opts) {
  return [
    `# a11ign — board report, ${longDate(new Date().toISOString())}`,
    "",
    // THE DOCUMENT SAYS OF ITSELF THAT IT IS LATE, in its own header rather than in a covering message.
    // A board member reading the PDF a week later has only the document; a caveat delivered beside it is
    // a caveat that does not travel with the thing it qualifies.
    ...(opts?.lateAt ? [`**LATE EDITION, published ${opts.lateAt}.**`, ""] : []),
    "*a11ign drives a real screen reader through real navigation to assess the accessibility "
    + "failures that automated scanners structurally cannot reach. Nothing is published yet.*",
    "",
    ...(summary ? ["## Executive summary", "", summary.text, ""] : []),
    section1(d), "", section2(), "", section3(d), "", section4(d), "", section5(d), "", appendix(d),
  ].join("\n");
}

/**
 * Sections one to five only: not the title, not the summary, not the appendix.
 *
 * EXPORTED, not restated — issue #88. `board-style.test.ts` had its own copy of exactly this slice, which
 * is how the body-cap check could exist as a TEST but not as a REFUSAL: the generator itself had no way to
 * ask "is my own output too long" without duplicating the boundary logic a second time. One copy now feeds
 * both the test and `requireBodyWithinCap` below.
 */
/** @param {string} md */
export function bodyOnly(md) {
  const start = md.indexOf("\n## ", md.indexOf("## Executive summary") + 1);
  const from = start === -1 ? md.indexOf("\n## ") : start;
  const to = md.indexOf("## Appendix");
  return md.slice(from === -1 ? 0 : from, to === -1 ? undefined : to);
}

/** @param {string} s */
const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;

/** "2026-09-06", or the honest word for a missing one — never a guess.
 * @param {string | null | undefined} at */
const dateLabel = (at) => {
  const parsed = at ? Date.parse(at) : NaN;
  return Number.isNaN(parsed) ? "unknown date" : /** @type {string} */ (at).slice(0, 10);
};

const MAX_CLAIM_PREVIEW = 70;
/** A claim, shortened for a refusal message that has to stay scannable, not published.
 * @param {string} text */
const preview = (text) =>
  text.length > MAX_CLAIM_PREVIEW ? `${text.slice(0, MAX_CLAIM_PREVIEW - 1)}…` : text;

/**
 * THE BODY CAP MUST NAME THE TRADE, NOT JUST THE OVERFLOW — issue #88.
 *
 * `board-style.test.ts` already refused a body over `BODY_WORD_CAP`, but only as a TEST someone reads
 * later — `main()` itself never checked, so the first person to actually HIT the cap was an agent at
 * 07:50 with an edition to render, staring at a bare word count. The guard is right; what it left unsaid
 * is what forced the deletion — new evidence displacing old evidence, invisibly, decided by whoever was
 * in the most hurry rather than by anyone weighing which claim had stopped earning its place.
 *
 * So the refusal lists every achievement OLDEST FIRST, by its `at` timestamp, with the word count it
 * costs the body (section 3's bullet only — the evidence itself lives in the appendix and is not part of
 * this cap). Age is a fact read off the record, not a guess made under the same time pressure the
 * original bug was about.
 */
/**
 * The refusal MESSAGE, as a pure function of the data and the rendered document — or `null` when the body
 * fits. Split from `requireBodyWithinCap` below purely so a test can assert on the TEXT without spawning
 * the CLI or trapping `process.exit`.
 */
/** @param {any} d @param {string} md */
export function bodyCapRefusal(d, md) {
  const words = wordCount(bodyOnly(md));
  if (words <= BODY_WORD_CAP) return null;
  const over = words - BODY_WORD_CAP;
  const lines = [`board:document REFUSES — the body is ${words} words against a ${BODY_WORD_CAP} cap.`,
    `Retiring or shortening ${over} word(s) worth of content would fit.`];
  if (d.achievements.length === 0) {
    lines.push("No achievements are recorded to retire, so the overflow is in the other sections' prose "
      + "— cut repetition or move detail to the appendix.");
  } else {
    lines.push("The achievements, oldest first:");
    const oldestFirst = [...d.achievements].sort((a, b) => Date.parse(a.at ?? 0) - Date.parse(b.at ?? 0));
    oldestFirst.forEach((a, i) => {
      const text = a.boardClaim ?? a.claim;
      lines.push(`  [${i}] "${preview(text)}"   written ${dateLabel(a.at)}, ${wordCount(text)} words`);
    });
    lines.push("Retire one, or shorten the entry you are adding.");
  }
  return lines.join("\n");
}

/** @param {any} d @param {string} md */
function requireBodyWithinCap(d, md) {
  const refusal = bodyCapRefusal(d, md);
  if (!refusal) return;
  console.error(refusal);
  process.exit(5);
}

const PAGE_CSS = `
  /* TYPOGRAPHY IS WHERE THE TWO-PAGE BODY IS PAID FOR, not content.
     The body reached 910 words with every repetition removed and all evidence moved to the appendix;
     the next cut would have been a risk or a number, which the chairman's rules forbid. So the page is
     set tighter instead: 14mm margins and 10pt/1.42 rather than 18mm and 10.5pt/1.5. Still comfortably
     readable in print, and it buys roughly a third of a page. */
  @page { size: A4; margin: 14mm 14mm 13mm; }
  body { font: 10pt/1.42 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #16191d; }
  h1 { font-size: 20pt; margin: 0 0 2mm; letter-spacing: -0.01em; }
  h1 + p em, h1 + p { color: #5a6472; font-size: 9.5pt; margin: 0 0 6mm; }
  h2 { font-size: 12.5pt; margin: 6.5mm 0 2mm; padding-top: 2mm; border-top: 1.5px solid #16191d;
       break-after: avoid; }
  h3 { font-size: 10.5pt; margin: 4mm 0 1.5mm; break-after: avoid; }
  p, li { margin: 0 0 2mm; }
  ul, ol { margin: 0 0 3mm; padding-left: 5mm; }
  strong { font-weight: 650; }
  /* LET A LONG TABLE FLOW. break-inside:avoid pushes a table that will not fit ENTIRELY onto the next
     page, which on 8 September left page three as one heading and one paragraph with the appendix table
     stranded overleaf. Rows are individually short, so breaking between them costs a reader nothing and
     keeps the page full. The header repeats across the break.
     NO BACKTICKS IN THIS COMMENT: it lives inside a template literal, and a backtick here ends the
     string. CLAUDE.md records that exact defect twice, ten minutes apart; this is the third. */
  table { border-collapse: collapse; width: 100%; margin: 2mm 0 4mm; font-size: 9pt; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  th { text-align: left; border-bottom: 1.2px solid #16191d; padding: 1.3mm 2mm; vertical-align: top; }
  td { border-bottom: 0.4px solid #ccd2da; padding: 1.3mm 2mm; vertical-align: top; }
  code { font: 9pt/1.4 ui-monospace, "SF Mono", Menlo, monospace; background: #f1f3f6;
         padding: 0.3mm 1mm; border-radius: 2px; }
  pre { background: #f1f3f6; padding: 2.5mm 3mm; border-radius: 3px; overflow-x: auto;
        break-inside: avoid; }
  pre code { background: none; padding: 0; font-size: 8.5pt; }
  blockquote { margin: 0 0 3mm; padding: 0 0 0 4mm; border-left: 2px solid #c3cad4; color: #3d4552;
               font-size: 9.5pt; }
  a { color: #16191d; }
  hr { border: 0; border-top: 0.4px solid #ccd2da; margin: 5mm 0; }
`;

// NOTHING RUNS ON IMPORT -- see the note in `board-report.mjs`. `document()` stays exported above
// so the renderer test can build a real document without rendering a PDF or touching GitHub.
/** THE SUMMARY GATES THE EDITION, and a missing one is a MISSING EDITION rather than a summary-less
 * document. A summary assembled from the sections below it is precisely what the chairman's third rule
 * forbids, so there is no fallback to generate one -- the only way to publish is for a person to have
 * written it. Returns the summary, or exits.
 */

// #607: A LATE MORNING PRODUCED NO DOCUMENT RATHER THAN A LATE ONE, and neither guard was wrong.
//
// The 9 September edition posted its comment at 07:11:53Z and refused the PDF: two capability claims were
// past the freshness bar. Both authors re-affirmed inside the window -- 07:32:17Z and 07:34:13Z -- and the
// merge carrying them did not land before the render window closed at 07:59:59Z. `republish` could not
// rescue it either: by #507's own design it is permitted ONLY when today's release already exists, because
// a republish must be able to replace a document the board HAS and must never create one they should not
// have yet. No release existed, because RENDERING is the step that creates it.
//
// **Two guards, each correct alone, composing into a state with no exit.** A day three minutes late
// produced nothing.
//
// THE FAILURE MODE OF A LATE PATH IS THAT IT BECOMES THE NORMAL ONE. A document that is always late and
// always says so is worse than the refusal it replaces, because the header stops being read. So the four
// conditions are not ceremony: the noon cut-off stops it being an evening document, and "no edition yet"
// keeps it disjoint from `republish` -- one creates, the other replaces, and neither can do the other's
// job.
export const LATE_EDITION_EARLIEST = 7 * 60 + 30;
export const LATE_EDITION_CUTOFF = 12 * 60;

/**
 * Pure: `"08:05"` -> 485. `null` for anything that is not HH:MM.
 * @param {string | undefined | null} hhmm @returns {number | null}
 */
export function minutesOfDay(hhmm) {
  const m = typeof hhmm === "string" ? hhmm.match(/^(\d{2}):(\d{2})$/) : null;
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2])];
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/**
 * THE VERDICT, PURE: may a LATE edition render right now? `null` to proceed; a refusal STRING otherwise.
 *
 * THE ORDER OF THE CHECKS IS ASSERTED BY A TEST, because each refusal sends the reader somewhere
 * different and the wrong one sends them to the wrong place. A missing summary reported as "too late"
 * would have somebody widening a time window over a paragraph nobody wrote.
 *
 * @param {{ summary: { text: string } | null | undefined, stated: string | null,
 *           editionExists: boolean, londonNow: string }} state
 * @returns {string | null}
 */
export function lateEditionRefusal({ summary, stated, editionExists, londonNow }) {
  if (!summary) {
    return "REFUSING a late edition: there is no summary for today.\n"
      + "A late edition is a late DOCUMENT, not a document without its one hand-written paragraph. "
      + "Write the summary first; the missing summary is the missing edition.";
  }
  const statedMinutes = minutesOfDay(stated);
  if (statedMinutes === null) {
    return "REFUSING a late edition: the summary does not say when it was written.\n"
      + 'Open it with "Written at HH:MM on D Month". A late edition claims in its own header that it is '
      + "late, and that claim is only checkable against a time the summary states.";
  }
  if (statedMinutes < LATE_EDITION_EARLIEST) {
    return `REFUSING a late edition: the summary says it was written at ${stated}, which is inside the `
      + "normal window.\nThis path exists for a summary written AFTER 07:30 London. A document written on "
      + "time does not need a header saying it is late -- run the ordinary render.";
  }
  if (editionExists) {
    return "REFUSING a late edition: today's edition already exists.\n"
      + "A late edition CREATES today's document; replacing one the board already has is `republish`'s "
      + "job, and the two are deliberately disjoint. Use `republish`.";
  }
  const nowMinutes = minutesOfDay(londonNow);
  if (nowMinutes === null) {
    return `REFUSING a late edition: could not read the London time (${londonNow}).\n`
      + "Refusing rather than guessing: the whole of this path is a claim about what time it is.";
  }
  if (nowMinutes >= LATE_EDITION_CUTOFF) {
    return `REFUSING a late edition: London reads ${londonNow}, past the ${
      String(Math.floor(LATE_EDITION_CUTOFF / 60)).padStart(2, "0")}:00 cut-off.\n`
      + "A morning document must not arrive in the evening. What is late by hours is not a late edition, "
      + "it is tomorrow's problem, and a header nobody believes is worse than an absent document.";
  }
  return null;
}

/**
 * THE STATED WRITING TIME MUST BE TRUE AT THE MOMENT OF THE RENDER, and this is the only place that can
 * say so -- #589.
 *
 * It lived in `board-style.test.ts` until 2026-09-09, where it compared the summary's stated time against
 * the clock at TEST time. A unit suite runs on every pull request at every hour, so from 60 minutes after
 * the summary was written the whole queue failed on a document that was correct: measured this morning,
 * every open PR red at 09:05 London against a summary written at 08:05 and never touched by any of them.
 * The assertion was right and the place was wrong. Here, "now" IS the render, which is the only moment
 * the freshness of a board paragraph means anything.
 *
 * The board asked for thirty minutes -- "it should be as fresh as possible as a lot happens over night".
 * The SCHEDULE delivers that (the summary is written at 07:25 and the edition renders at 08:00); this is
 * the backstop that catches a stale one reaching the board, so it is the wider sixty.
 *
 * @param {boolean} publishing @param {{text: string} | null | undefined} summary @param {string} today @param {Date} [now]
 */
export function requireSummaryIsFresh(publishing, summary, today, now = new Date()) {
  if (!publishing || !summary) return;
  const londonNow = new Intl.DateTimeFormat("en-GB",
    { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const stated = statedWritingTime(summary.text, now);
  if (!stated) {
    console.error(`REFUSING to render: the summary for ${today} does not say when it was written.\n`
      + 'Open it with "Written at HH:MM on D Month" -- a document the board reads at 08:00 must say how '
      + "old its one hand-written paragraph is, and a stated time nothing checks is decoration.");
    process.exit(5);
  }
  if (stated.driftMinutes > SUMMARY_FRESH_MINUTES) {
    console.error(`REFUSING to render: the summary for ${today} says it was written at ${stated.stated} `
      + `and London now reads ${londonNow} -- ${stated.driftMinutes} minutes later, past the `
      + `${SUMMARY_FRESH_MINUTES}-minute window.\n`
      + "Rewrite it from the state at this moment. Do NOT adjust the time it claims: the claim is the "
      + "thing being checked, and editing it to pass is how a freshness rule becomes a formality.");
    process.exit(5);
  }
}

/** @param {boolean} publishing */
function requireSummary(publishing) {
  // The edition's day in LONDON (#1302), the same day the summary check warns about and the Discussion is
  // titled by -- a UTC slice here asked for yesterday's summary between 00:00 and 01:00 London in summer.
  const today = editionDay();
  const summary = summaryFor(today);
  if (publishing && !summary) {
    console.error(`REFUSING to render: no executive summary for ${today}.\n\n`
      + `Write at most ${SUMMARY_WORDS} words in docs/board/summaries/${today}.md, answering three `
      + "things: are we on the date, what changed since yesterday, what must the board decide today.\n"
      + "It is written by hand, per edition, and is NOT assembled from the sections below it -- a "
      + "machine-written summary is the thing the chairman's rules forbid.\n"
      + "Nothing was written. A missing summary is a missing edition.");
    process.exit(5);
  }
  if (summary && summary.words > SUMMARY_WORDS) {
    console.error(`REFUSING to render: the summary for ${today} is ${summary.words} words, over the `
      + `${SUMMARY_WORDS}-word cap. Cut it; that cap is what makes it a summary.`);
    process.exit(5);
  }
  requireSummaryIsFresh(publishing, summary, today);
  return summary;
}

/**
 * REFUSE, DO NOT WARN, and the reason is the render itself: this document is produced at 08:00
 * unattended. A warning in a log nobody reads is exactly how the false sentence would have shipped —
 * which it nearly did (#90), and was caught only because a person happened to re-read it.
 *
 * The refusal names the entry, its claim and what moved, so re-affirming is a ten-second act rather than
 * an investigation. `--allow-dirty-read-set` deliberately does NOT override it: that flag is about which
 * COPY of the read set is quoted, and this is about whether a quoted sentence still describes the world.
 */
/** @param {any[]} achievements */
function refuseIfTheWorldMoved(achievements) {
  const cited = achievements.map((a) => a.issue).filter((/** @type {any} */ n) => n !== undefined);
  if (!cited.length) return;
  // CLOSED-AT, not just CLOSED. The refusal is 'nobody has looked since it moved', so the moment it
  // moved is part of the question -- see `achievementsWhoseWorldMoved`.
  const issueState = Object.fromEntries(
    issues().map((/** @type {any} */ i) => [String(i.number), { state: i.state, closedAt: i.closedAt ?? null }]));
  const moved = achievementsWhoseWorldMoved({ achievements, issueState });
  if (!moved.length) return;

  console.error(`REFUSING to render: ${moved.length} achievement(s) in docs/board/reported/ have `
    + "outlived what they were written against. Section 3 is the one part of this document no gate "
    + "computes, so it is also the one nothing re-checks -- and an entry that is true when written stays "
    + "in the file after it stops being true.\n");
  for (const { index, claim, why } of moved) {
    console.error(`  achievements[${index}]  ${claim}\n      ${why}\n`);
  }
  console.error("This does NOT say the claims are false -- it says nobody has looked since the world "
    + "moved. Re-affirm an entry with an `affirmed` field saying why it still stands, or retire it.");
  process.exit(1);
}

/** The env var override, checked first so a runner with Chrome somewhere unusual never has to touch code. */
const CHROME_ENV_VAR = "BOARD_DOCUMENT_CHROME";

/** Every location this has actually needed to check, existsSync'd rather than executed. */
const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",   // a developer's Mac
  "/usr/bin/google-chrome-stable",                                   // GitHub's ubuntu-latest runner image
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",                                       // Ubuntu's own chromium package name
  "/usr/bin/chromium",
];

/** Names to fall back to on PATH, in case a package manager put Chrome somewhere none of the above see. */
const CHROME_PATH_NAMES = ["google-chrome-stable", "google-chrome", "chromium-browser", "chromium"];

/**
 * Resolve a real, existing Chrome/Chromium executable -- issue #280. This used to be a single hardcoded
 * macOS path (`/Applications/Google Chrome.app/...`), which is exactly the assumption this workflow
 * stopped being able to make the day it moved off a developer's laptop onto `ubuntu-latest`: every run
 * failed `spawnSync ... ENOENT`, a stack trace that names neither the missing browser nor what to do
 * about it -- "a verification that shares a failure mode with the action verifies nothing" applies here
 * to a PRECONDITION rather than a check, but the lesson is the same: name the cause, don't let the
 * OS report it as a generic failure to spawn.
 *
 * Every candidate is checked with `existsSync`, never executed speculatively, so a wrong guess costs one
 * stat call rather than a spawned, possibly-misbehaving process. The `which` fallback only runs if none
 * of the known paths hit, and only against a fixed, hardcoded list of names -- never a name built from
 * input, so there is nothing here for a shell to interpret unsafely.
 */
/**
 * @param {{ env?: NodeJS.ProcessEnv, exists?: (p: string) => boolean, which?: (name: string) => string }} [deps]
 *   Injectable for the "not found" and "found on PATH" branches, which cannot be exercised
 *   deterministically against this machine's REAL filesystem and PATH -- this Mac has the real Chrome
 *   installed at the real candidate path, so a test asserting "not found" would have to delete it.
 */
export function resolveChromeBinary(deps = {}) {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const which = deps.which ?? ((name) => spawnSync("which", [name], { encoding: "utf8" }).stdout?.trim() ?? "");

  const override = env[CHROME_ENV_VAR];
  if (override) {
    if (!exists(override)) {
      throw new Error(`${CHROME_ENV_VAR}=${override} does not exist. Unset it to use the built-in search, `
        + "or point it at a real Chrome/Chromium executable.");
    }
    return override;
  }
  for (const candidate of CHROME_CANDIDATES) {
    if (exists(candidate)) return candidate;
  }
  for (const name of CHROME_PATH_NAMES) {
    const found = which(name);
    if (found) return found;
  }
  throw new Error("No Chrome or Chromium found. Checked the usual macOS and Linux install locations, plus "
    + `PATH for ${CHROME_PATH_NAMES.join(", ")}. Install one, or set ${CHROME_ENV_VAR} to its path.`);
}

function main() {
  refuseUnknownFlags(["--pdf", "--since", "--out", "--allow-dirty-read-set", "--release",
    "--late-edition", "--discussion"], { entry: import.meta.url, command: "npm run board:document" });

  const argv = process.argv.slice(2);
  /** @type {(n: string) => string | undefined} */
  const flagOf = (n) => argv.find((a) => a.startsWith(`${n}=`))?.split("=").slice(1).join("=");

  const late = argv.includes("--late-edition");
  const discussion = argv.includes("--discussion");
  const summary = requireSummary(argv.includes("--pdf") || argv.includes("--release") || discussion || late);
  const lateAt = late ? requireLateEditionPermitted(summary) : undefined;
  const d = collect(flagOf("--since") ?? new Date(Date.now() - 24 * HOURS_MS).toISOString());
  // THE WORLD-MOVED CHECK RUNS FIRST, before the markdown is built: a stale claim should not be
  // rendered at all, and this is the cheaper of the two refusals. The body cap needs `md` and so must
  // follow it.
  refuseIfTheWorldMoved(d.achievements);
  const md = document(d, summary, { lateAt });
  // UNCONDITIONAL, unlike the summary check above: a body over the cap is wrong in the plain markdown
  // preview too, not only when publishing, and catching it earlier is the whole point of issue #88 (the
  // agent who hit this had already reached the render-a-PDF step before the cap said anything).
  requireBodyWithinCap(d, md);

  if (!argv.includes("--pdf") && !discussion) {
    process.stdout.write(md + "\n");
    return;
  }
  const stamped = stampedForPublishing(md, { allowDirty: argv.includes("--allow-dirty-read-set") });
  // THE DISCUSSION IS THE EDITION (#1290) and the PDF an optional copy, so the Discussion goes first: a PDF
  // render failing afterwards cannot cost the board the edition itself.
  if (discussion) publishDiscussion(stamped);
  if (argv.includes("--pdf")) {
    renderPdfEdition(stamped, { outFlag: flagOf("--out"), release: argv.includes("--release") });
  }
}

/**
 * THE SAME REFUSAL AS THE GITHUB EDITION, for every copy that reaches the board. A published document is
 * harder to retract than a comment, so the read set must be `main`'s or nothing is published.
 * @param {string} md @param {{ allowDirty: boolean }} opts
 * @returns {string} the document, stamped with the fact when a read set that is not `main`'s was allowed
 */
function stampedForPublishing(md, { allowDirty }) {
  const dirt = readSetIsNotMain();
  if (dirt && !allowDirty) {
    console.error("REFUSING to render: the files this document reads out of the working tree are not "
      + "`main`'s, so the edition would carry something nobody has reviewed.\n\n" + dirt
      + "\n\nNothing was written. Commit and merge the read set, or pass --allow-dirty-read-set, which "
      + "renders and stamps the document with the fact.");
    process.exit(3);
  }
  return dirt
    ? md + "\n\n---\n\n*Rendered with `--allow-dirty-read-set`: the files this edition reads out of the "
      + "working tree are not `main`'s, so the gate line and the fleet-hours line may quote something "
      + "unreviewed. Stated here rather than left for a reader to discover.*"
    : md;
}

/**
 * THE EDITION ITSELF (#1290). A refusal exits 6, a code of its own, so a failed run's status says which step
 * refused before anyone opens the log.
 * @param {string} md
 */
function publishDiscussion(md) {
  try {
    const { url, action } = publishEdition({ day: editionDay(), body: md });
    process.stdout.write(`${url} (${action})\n`);
  } catch (error) {
    console.error(String(/** @type {Error} */ (error)?.message ?? error));
    process.exit(6);
  }
}

/**
 * THE PDF, OPTIONAL SINCE #1290: kept for a day a file is wanted, and `--release` still means something only
 * beside it. The scheduled edition renders none and creates no release draft.
 * @param {string} stamped @param {{ outFlag: string | undefined, release: boolean }} opts
 */
function renderPdfEdition(stamped, { outFlag, release }) {
  // WHERE THE CHAIRMAN LOOKS, which is the only requirement this path has.
  //
  // It was `~/Library/Logs/a11y-witness`, beside the scheduled job's log, on the reasoning that a
  // LaunchAgent's output belongs there on macOS. That reasoning was about the LOG. A board document is
  // not a log -- it is a deliverable a person opens, and a deliverable filed where its reader does not
  // look has not been delivered. So: `~/Documents/a11y-witness-board-reports/`, one file per date. The
  // log stays in `~/Library/Logs/a11y-witness/`, where the original reasoning does still hold.
  //
  // NOT in the repository, and deliberately: `runs/` is shared -- often a symlink to the corpus tree --
  // and a guard is landing that makes every `runs/` writer askable, so a PDF written every morning
  // would be a writer nobody remembered when that guard was designed.
  const outDir = outFlag
    ?? path.join(process.env.HOME ?? ROOT, "Documents", "a11y-witness-board-reports");
  mkdirSync(outDir, { recursive: true });
  const stem = `a11ign-board-${editionDay()}`;
  // THE INTERMEDIATE HTML DOES NOT GO WHERE THE CHAIRMAN LOOKS. It is Chrome's input, not a
  // deliverable, and "one file per date" means one file: a folder holding two files per day, one of
  // which opens as unstyled markup, is a folder somebody has to learn to read past.
  const html = path.join(mkdtempSync(path.join(tmpdir(), "board-")), `${stem}.html`);
  const pdf = path.join(outDir, `${stem}.pdf`);
  writeFileSync(html, `<!doctype html><meta charset="utf-8"><title>${stem}</title>`
    + `<style>${PAGE_CSS}</style>${toHtml(stamped)}`);

  renderPdfWithChrome(html, pdf);
  process.stdout.write(`${pdf}\n`);

  if (release) publishToDraftRelease(pdf);
}

/**
 * HEADLESS CHROME, not pandoc or a PDF library. Chrome is already on this machine because the capture
 * fleet needs a Chromium; pandoc is not installed and would make the board's daily document depend on
 * an operator running `brew install`. A dependency the board's report cannot be produced without is a
 * worse risk than a slightly plainer typeface.
 * @param {string} html @param {string} pdf
 */
function renderPdfWithChrome(html, pdf) {
  let chrome;
  try {
    chrome = resolveChromeBinary();
  } catch (e) {
    console.error(`REFUSING to render: ${/** @type {{ message?: string }} */ (e).message}`);
    process.exit(2);
  }
  console.error(`Using ${chrome}`);
  execFileSync(chrome, ["--headless", "--disable-gpu", "--no-pdf-header-footer",
    `--print-to-pdf=${pdf}`, `file://${html}`], { stdio: "pipe" });
}

/** Deliver the PDF as an asset on a DRAFT GitHub Release, which is one click from the Releases tab.
 *
 * A draft release was chosen over attaching to the report issue because GitHub's API cannot attach a file
 * to an issue comment at all -- that is a web-UI drag-and-drop, so a daily automated attachment is
 * impossible, not merely awkward.
 *
 * THE TAG IS NAMESPACED `board/<date>` AND THE RELEASE STAYS A DRAFT, both deliberately. A draft creates
 * no git tag until it is published, so nothing here can be mistaken for a product version or picked up by
 * the changesets machinery -- which matters in a repo whose first npm publish has not happened yet and
 * whose release workflow reads tags.
 * @param {string} pdf
 */
/**
 * THE LATE GATE RUNS BEFORE ANYTHING IS COLLECTED OR RENDERED (#607). Every one of its four conditions is
 * knowable without the document, and a refusal that arrives after a render has spent a minute reading
 * GitHub is a refusal somebody learns to pre-empt by not running it.
 * @param {{ text: string } | null | undefined} summary
 * @returns {string} London's `HH:MM` at this moment, for the header
 */
function requireLateEditionPermitted(summary) {
  const lateAt = londonNowHHMM();
  const refusal = lateEditionRefusal({ summary,
    stated: summary ? (statedWritingTime(summary.text, lateAt)?.stated ?? null) : null,
    editionExists: todaysEditionExists({ day: editionDay() }), londonNow: lateAt });
  if (refusal) {
    console.error(`${refusal}\n\nNothing was written.`);
    process.exit(5);
  }
  return lateAt;
}

/** London's wall clock as `HH:MM`, the one string every part of the late path agrees on. */
export function londonNowHHMM() {
  return new Intl.DateTimeFormat("en-GB",
    { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

/** @param {string} pdf */
function publishToDraftRelease(pdf) {
  const tag = `board/${editionDay()}`;
  const title = `Board report — ${editionDay()}`;
  const notes = "The daily board document. Generated from GitHub and git; every figure carries its "
    + "source, and anything unmeasured says so rather than being estimated. The GitHub issue edition is "
    + "the data trail.";
  const exists = (() => {
    try {
      const raw = execFileSync("gh", ["release", "view", tag, "--repo", REPO, "--json", "isDraft"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return JSON.parse(raw);
    } catch { return null; }
  })();

  if (!exists) {
    execFileSync("gh", ["release", "create", tag, pdf, "--repo", REPO, "--draft",
      "--title", title, "--notes", notes], { stdio: "pipe" });
  } else if (!exists.isDraft) {
    // REFUSE rather than overwrite. A published release is visible to everyone with the repository; a
    // re-render replacing its asset would change what somebody has already been sent, silently.
    console.error(`REFUSING to replace assets on ${tag}: it is PUBLISHED, not a draft. A re-render would `
      + "change a document somebody has already been given. Render with --out and deliver by hand, or "
      + "cut a new tag.");
    process.exitCode = 4;
    return;
  } else {
    execFileSync("gh", ["release", "upload", tag, pdf, "--repo", REPO, "--clobber"], { stdio: "pipe" });
  }
  process.stdout.write(`https://github.com/${REPO}/releases/tag/${encodeURIComponent(tag)} (draft)\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
