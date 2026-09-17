#!/usr/bin/env node
// @ts-check
// command: refuse when a PR's declared Closes line disagrees with what GitHub will actually close
/**
 * #549: A BODY CAN DECLARE `Closes: none` AND STILL CLOSE TWO ISSUES, AND NOTHING COMPARES THE TWO.
 * Measured live, both merged the same day: #545 declared `Closes: none — <reason>` and GitHub closed
 * #492 and #494 anyway; #537 declared the identical `none` shape and closed #494. Both had to be reopened
 * by hand -- #492 twice.
 *
 * THE CAUSE IS PROSE, AND KNOWING THE RULE IS NOT PROTECTION. Both bodies said, mid-sentence, "the wiring
 * PR (#530) closes #494" and "whose acceptance now says it closes #492" -- an author explaining WHERE a
 * closure belonged, in a form GitHub's own keyword scan (`close(s/d)`, `fix(es/ed)`, `resolve(s/d)`
 * immediately followed by `#N`) acts on regardless of intent. The SECOND instance was written by the
 * person who had filed the warning about the FIRST two hours earlier -- so "authors will remember" is
 * refuted by measurement, not argument. This is the sixth instance of the same shape this repo hit in one
 * day (a summary line under `Acceptance:`, #446; a heading's trailing text, #506; a markdown checklist,
 * #530; a `uses:` line in a YAML comment, #539) and the first two this repo's own parsers cannot fix,
 * because they are GitHub's.
 *
 * SO THE CHECK COMPARES TWO FACTS THIS PIPELINE ALREADY HOLDS, rather than trusting either side alone:
 * what the author DECLARED (`extractClosesDeclaration`, B7's own gate, already run on every PR) against
 * what GitHub RESOLVED (`lookupClosingIssues`, the same `closingIssuesReferences` query
 * `close-rows-for-merged-pr.mjs` already relies on). Neither is new work.
 *
 * TWO DIRECTIONS, TWO DIFFERENT FAULTS: a number GitHub resolves that the body never declared is an
 * ACCIDENTAL CLOSURE (today's two incidents); a number the body declares that GitHub never resolves is
 * the `Closes A1c (#487)` shape from the same morning -- a well-intentioned declaration that was
 * unparseable by GitHub's own keyword matcher, so the row silently stayed open. Both cost a hand-fix;
 * both are reported here, named, never collapsed into a bare "mismatch".
 *
 * NOT THE `acceptance` JOB -- it has no `GH_TOKEN` by design (see that job's own header: it runs an
 * arbitrary PR body's own commands, so it is given no credentials at all). This runs in `mergeSafety`
 * instead, which already carries `merge-guard`'s lookups, already has `GH_TOKEN`, and is inside the
 * required `gate` context -- a NEW step there, not folded into `mergeSafetyVerdict`'s own composition:
 * that function is deliberately scoped to head-vs-tip ONLY (see its own header) because its sibling
 * rules -- ancestry, closing-claim -- were measured refusing the NORMAL case when asked unconditionally
 * in CI. This check has the opposite property (silent on every well-formed PR, which is nearly all of
 * them), so it does not share that hazard and does not belong inside that narrowly-scoped function.
 *
 * SKIPPED, NOT REFUSED, WHEN THE DECLARATION ITSELF IS MISSING/MALFORMED -- `closesDeclarationReport`
 * (the `acceptance` job's own gate) already refuses those; re-litigating them here would be a second,
 * independently-drifting opinion about the same fact rather than a new one.
 *
 * A PR ABOUT "TEXT THAT PARSES AS AN INSTRUCTION" CANNOT DESCRIBE ITSELF WITHOUT BECOMING AN INSTANCE --
 * expect this, do not read it as having broken something. The PR that built this check tripped its own
 * two example patterns while drafting the body that explains them: `Closes: none` inside a sentence
 * describing the bug matched `extractClosesDeclaration`'s own whole-body regex, and backticked
 * `closes #494`/`closes #492` examples matched its list pattern too -- neither this file's own scan nor
 * `acceptance-commands.mjs`'s parser is line-anchored or fence-aware, so quoting the trigger phrase
 * anywhere in prose (even inside backticks) can still fire it. The same shape hit #508's own body when
 * hard-wrapping put `Acceptance:` at a line start inside a paragraph explaining #506. Break the adjacency
 * when writing about this mechanism -- a word between the keyword and the `#number` is enough (`closes`
 * issue `#494`, not `closes #494`) -- and verify with `extractClosesDeclaration`/`extractAcceptanceSection`
 * directly before pushing, the way #522 and this PR both did, rather than trusting that quoting looks safe.
 */
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { extractClosesDeclaration } from "./acceptance-commands.mjs";
import { lookupClosingIssues } from "./merge-guard/lookups.mjs";
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";

// GitHub's own documented closing keywords -- close/closes/closed, fix/fixes/fixed, resolve/resolves/
// resolved -- immediately followed by `#<number>`. Used only to LOCATE the phrase in the body for a
// refusal message, never to decide the verdict: the verdict is GitHub's own `closingIssuesReferences`
// answer, which already applies this exact matching (and more GitHub does not document) authoritatively.
const CLOSING_KEYWORDS = "close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved";

/**
 * Which line of `body` contains the phrase that makes GitHub close issue `number` -- so a refusal can
 * point an author at the line, not just the number. `null` when no line matches this scan's own (slightly
 * narrower, single-repo) view of GitHub's keyword grammar -- the closure can still be real; it may be a
 * cross-reference this scan does not model (a linked commit, a different repo). Named as such in the
 * caller's message rather than treated as "not found, so nothing to report".
 * @param {string} body
 * @param {number} number
 * @returns {{ line: number, text: string } | null}
 */
export function findClosingPhrase(body, number) {
  const pattern = new RegExp(`\\b(?:${CLOSING_KEYWORDS})\\s+#${number}\\b`, "i");
  const lines = (body ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return { line: i + 1, text: lines[i].trim() };
  }
  return null;
}

/** @typedef {{ ok: true } | { ok: false, reasons: string[] } | { ok: null, reason: string }} MismatchReport */

/**
 * Pure. Compares what `declaration` DECLARED against what `resolved` GitHub actually RESOLVED, and
 * reports the difference named -- never just that one exists. `resolved: null` means the lookup itself
 * failed (this repo's own rule throughout `merge-guard/lookups.mjs`: "could not ask" and "asked and got
 * nothing" are different states) and is reported as `ok: null`, distinct from a real, examined mismatch.
 *
 * `declaration.kind` of `"missing"`/`"malformed"` is treated as declaring NOTHING for this comparison --
 * see this file's own header for why those are `closesDeclarationReport`'s question, not this one's.
 * @param {import("./acceptance-commands.mjs").ClosesDeclaration} declaration
 * @param {number[] | null} resolved
 * @param {string} body
 * @returns {MismatchReport}
 */
export function closesMismatchReport(declaration, resolved, body) {
  if (resolved === null) {
    return { ok: null,
      reason: "could not ask GitHub which issues this PR would close (the closingIssuesReferences lookup failed)" };
  }
  const declaredNumbers = declaration.kind === "closes" ? declaration.numbers : [];
  const declaredSet = new Set(declaredNumbers);
  const resolvedSet = new Set(resolved);
  const declaredLabel = declaredNumbers.length === 0 ? "none" : `#${declaredNumbers.join(", #")}`;

  const accidentalClosures = resolved.filter((n) => !declaredSet.has(n));
  const unresolvedDeclarations = declaredNumbers.filter((n) => !resolvedSet.has(n));

  if (accidentalClosures.length === 0 && unresolvedDeclarations.length === 0) {
    return { ok: true };
  }

  const reasons = [];
  for (const n of accidentalClosures) {
    const phrase = findClosingPhrase(body, n);
    reasons.push(phrase
      ? `you declared ${declaredLabel}, but GitHub will close #${n} anyway -- the phrase "${phrase.text}" `
        + `on line ${phrase.line} is what does it`
      : `you declared ${declaredLabel}, but GitHub will close #${n} anyway, for a phrase this scan could `
        + "not locate in the body text (check for a cross-reference to a commit, or a different repo)");
  }
  for (const n of unresolvedDeclarations) {
    reasons.push(`you declared #${n}, but GitHub will NOT close it -- the declaration did not produce a `
      + `real closing reference (confirm #${n} exists in this repo, and that the line reads exactly `
      + `"Closes #${n}")`);
  }
  return { ok: false, reasons };
}

function main() {
  refuseUnknownFlags([], { entry: import.meta.url, command: "node packages/agent-org/src/closes-mismatch-check.mjs" });
  const prNumber = Number(process.argv[2]);
  if (!prNumber) {
    console.error("usage: closes-mismatch-check.mjs <pr-number>  (the PR body is read from PR_BODY)");
    process.exit(2);
  }
  // FROM AN ENV VAR, NEVER ARGV -- identical reasoning to `acceptance-commands.mjs`'s own `main()`: a PR
  // body is adversarial input, and GitHub Actions' `env:` mapping keeps it one opaque string.
  const body = process.env.PR_BODY ?? "";
  const declaration = extractClosesDeclaration(body);
  if (declaration.kind === "missing" || declaration.kind === "malformed") {
    console.log("CLOSES MISMATCH: skipped -- the Closes declaration itself is missing or malformed, "
      + "which the acceptance job's own closesDeclarationReport gate already refuses.");
    process.exit(0);
  }
  const closing = lookupClosingIssues(prNumber);
  const resolved = closing === null ? null : closing.map((issue) => issue.number);
  const report = closesMismatchReport(declaration, resolved, body);
  if (report.ok === null) {
    // FAIL CLOSED, DELIBERATELY, ON A LOOKUP FAILURE -- "could not ask" must never read as "they
    // matched". This job runs in `mergeSafety`, a required `gate` context, so this blocks every merge on
    // a GraphQL blip, not just this one PR -- a real cost, weighed and accepted anyway: the alternative
    // (allow on `null`) makes the check go silent EXACTLY when the API is unwell, which is the one moment
    // an author is least able to notice its absence. This repo's own rule throughout `merge-guard/
    // lookups.mjs` is that "could not ask" and "asked and got nothing" are different states and neither
    // may read as clean -- the same choice `merge-guard.mjs --ci-gate` already makes (exit 2, CANNOT ASK,
    // never treated as READY). A transient GraphQL failure is rare and retriable (push again, or the
    // `update-branch` sweep's own re-push re-runs this); a real accidental closure sailing through
    // silently is not.
    console.log(`CLOSES MISMATCH: CANNOT ASK -- ${report.reason}`);
    process.exit(2);
  }
  if (!report.ok) {
    console.log("CLOSES MISMATCH: REFUSED -- what you declared and what GitHub will actually close disagree:");
    for (const reason of report.reasons) console.log(`  ${reason}`);
    process.exit(1);
  }
  console.log("CLOSES MISMATCH: ok -- declared and resolved agree");
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
