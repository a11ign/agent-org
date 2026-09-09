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
