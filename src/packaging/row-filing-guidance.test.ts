/**
 * #871: THE TWO FILING RULES THAT ARE ABOUT A PARSER, PINNED TO THE PARSER.
 *
 * `docs/row-filing.md` now carries two rules whose whole justification is what a machine does with a
 * section a person wrote: a Region's exclusion sentence DECLARES the path it denies, and an Acceptance
 * saying `npm test` names a command the tokenless, corpus-less acceptance job cannot run.
 *
 * THE FIRST RULE IS AN ASSERTION ABOUT CODE, SO IT IS PINNED TO THE CODE. A rule justified by a parser's
 * behaviour and not pinned to it is a claim nobody re-checks; when `declaredRegionFiles` learns to read
 * negation -- which the guidance explicitly argues against, but which somebody may still do -- this test
 * fails and the guidance is corrected in the same commit rather than quietly becoming false.
 *
 * The measured incident: #848's Region said "`.github/workflows/ready-label-audit.yml` is NOT in this
 * region", `declaredRegionFiles` returned that path anyway, and `fileOverlapReason` refused another
 * session's claim on #849 over a file #848 had no intention of touching.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { declaredRegionFiles } from "../../../../scripts/region-paths.mjs";

const GUIDANCE = fileURLToPath(new URL("../../../../docs/row-filing.md", import.meta.url));
const guidance = () => readFileSync(GUIDANCE, "utf8");

/**
 * #848's Region as it was actually written, reduced to its shape: a fenced list of paths the change
 * touches, then a sentence excluding one. The exclusion names a REAL path so the assertion below is about
 * the grammar rather than about a string the extractor would never have matched.
 */
const EXCLUDED = ".github/workflows/ready-label-audit.yml";
const BODY_WITH_AN_EXCLUSION_IN_ITS_REGION = [
  "## Region",
  "",
  "```",
  "scripts/ready-label-audit.mjs",
  "```",
  "",
  `**\`${EXCLUDED}\` is NOT in this region** -- the triggers are somebody else's half.`,
  "",
  "## Acceptance",
  "",
  "Acceptance: npx tsx --test packages/lab/src/packaging/ready-label-audit.test.ts",
].join("\n");

test("an exclusion sentence inside a Region DECLARES the path it denies", () => {
  const declared = declaredRegionFiles(BODY_WITH_AN_EXCLUSION_IN_ITS_REGION);

  // The mutation guard: the fixture's Region must carry a real declaration too, or this test would pass
  // for any text at all -- asserting about an empty Region proves nothing about the grammar.
  assert.ok(declared, "the fixture must have a Region section at all, not CANNOT_ASK");
  assert.ok(declared.includes("scripts/ready-label-audit.mjs"),
    "the fixture's Region must genuinely declare its own path, or this assertion is vacuous");

  assert.ok(declared.includes(EXCLUDED),
    "the word NOT is invisible to the path grammar, so the excluded file is declared -- if this now "
    + "fails, `declaredRegionFiles` has learned negation and docs/row-filing.md must be corrected");
});

test("moving the exclusion under its own heading is what actually removes the declaration", () => {
  const repaired = BODY_WITH_AN_EXCLUSION_IN_ITS_REGION.replace(
    `**\`${EXCLUDED}\` is NOT in this region** -- the triggers are somebody else's half.`,
    "## Not in scope\n\n**The workflow file** -- the triggers are somebody else's half.");

  const declared = declaredRegionFiles(repaired) ?? [];
  assert.deepEqual(declared, ["scripts/ready-label-audit.mjs"],
    "the Region declares only what the change touches once the exclusion is a section of its own");
});

test("the guidance states both rules, each with the mechanism rather than only the instruction", () => {
  const text = guidance();

  assert.match(text, /no negation grammar/i,
    "the Region rule must be findable by the phrase the open-check greps for");
  assert.match(text, /declaredRegionFiles/,
    "the Region rule names the parser it is a claim about, so a reader can check it");
  assert.match(text, /## Not in scope/,
    "the rule must say where an exclusion goes instead, not only where it may not go");

  assert.match(text, /AN ACCEPTANCE NAMES FILES, NEVER `npm test`/,
    "the Acceptance rule must be stated, not implied");
  assert.match(text, /cannot name a file that verifies it has no acceptance/,
    "quote pr:open's own refusal, so a filer who follows the refusal exactly passes");
});

/**
 * #1163: THE TWO SENTENCES ADDED 2026-09-12, EACH EARNED BY A ROW REFUSED OR CORRECTED THAT DAY.
 *
 * Asserted by their LOAD-BEARING PARTS rather than as frozen strings. A test pinning a whole sentence
 * fails on a comma and teaches the next person to edit the test instead of the prose -- which is the same
 * failure as a guard that reports the file it was pointed at rather than the property it was written for.
 */
/**
 * WHITESPACE IS COLLAPSED IN EVERY ASSERTION BELOW, and this unit needed the lesson three separate times
 * before it stuck: `guidanceDrift`'s own patterns missed `does not mean\nunimportant`, this test missed
 * `An\nacceptance names the files that must RUN`, and only the third write got it right first time.
 *
 * **A prose assertion against a WRAPPED file is matching a line, not a sentence.** The page wraps at 110
 * characters and the phrases worth pinning are longer than the gap left at the end of a line, so the
 * probability that a load-bearing phrase spans a wrap is high rather than incidental -- and the failure is
 * a silent non-match, which reads exactly like the prose being absent.
 */
const flat = () => guidance().replace(/\s+/g, " ");

test("#1163: the acceptance rule says which POPULATION the files come from, not only that files are named", () => {
  const text = flat();

  assert.match(text, /a transcript names the files a defect is IN/i,
    "the wrong population has to be named, or the rule reads as advice about being careful");
  assert.match(text, /an acceptance names the files that must RUN/i,
    "the right population, stated as the contrast -- this is the half a filer applies");
  assert.match(text, /does not transfer/i,
    "the two lists overlap enough to look interchangeable, which is why the rule exists at all");
  assert.match(text, /comm -3/,
    "a rule with no command to check it against is one nobody re-checks -- the same standard the Region "
    + "rule above is held to, which carries `declaredRegionFiles` for the reader to run");
});

test("#1163: `out-of-release` is stated as answering ONE question, with importance said elsewhere", () => {
  const text = flat();

  assert.match(text, /answers one question/i, "the whole point is the singular");
  assert.match(text, /does this block the 20 September publish/i,
    "the question itself, or the rule cannot be applied to a row");
  assert.match(text, /does not mean unimportant/i,
    "the reading that moved #1161 into the release on the wrong axis");
  assert.match(text, /out of release, ready/i, "how a row says BOTH things at once");
  assert.match(text, /importance is said by the ready order/i,
    "where importance actually lives -- without this the rule only forbids and offers nothing");

  // WHITESPACE COLLAPSED FIRST, because markdown wraps and every one of these spans a line break somewhere.
  // The live check learned this by failing on this page: `does not mean\nunimportant` matched nothing.
  assert.ok(/does not mean\s+unimportant/.test(guidance()) === true,
    "sanity: the phrase really is in the raw file too, so the collapse above is convenience and not a "
    + "weakening -- if this ever fails the assertions above are passing on a normalisation artefact");
});

test("#1163: the guidance says the milestone description is COMPARED, not merely that it agrees", () => {
  const text = flat();

  assert.match(text, /guidanceDrift/,
    "the page names the guard that compares it, so a reader can check the claim rather than trust it");
  assert.match(text, /two copies of one rule with nothing comparing them/i,
    "and says WHY, which is the defect this page would otherwise be a second instance of");
});
