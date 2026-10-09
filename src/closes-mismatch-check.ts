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
 * `close-rows-for-merged-pr.ts` already relies on). Neither is new work.
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
 * `acceptance-commands.ts`'s parser is line-anchored or fence-aware, so quoting the trigger phrase
 * anywhere in prose (even inside backticks) can still fire it. The same shape hit #508's own body when
 * hard-wrapping put `Acceptance:` at a line start inside a paragraph explaining #506. Break the adjacency
 * when writing about this mechanism -- a word between the keyword and the `#number` is enough (`closes`
 * issue `#494`, not `closes #494`) -- and verify with `extractClosesDeclaration`/`extractAcceptanceSection`
 * directly before pushing, the way #522 and this PR both did, rather than trusting that quoting looks safe.
 */
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { extractClosesDeclaration, closesReferences } from "./acceptance-commands.ts";
import { REPO } from "./project-identity.ts";
import { lookupClosingIssues, lookupRecentClosesPrs } from "./merge-guard/lookups.ts";
import { refuseUnknownFlags } from "./lib/cli-flags.ts";

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
 * @param {string | null} [repo] (#2995) set, looks for the FULL form (`owner/name#N`)
 * @returns {{ line: number, text: string } | null}
 */
export function findClosingPhrase(body: string, number: number, repo: string | null = null): { line: number; text: string; } | null {
  const pattern = new RegExp(`\\b(?:${CLOSING_KEYWORDS})\\s+${(repo ?? "").replace(/\./g, "\\.")}#${number}\\b`, "i");
  const lines = (body ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return { line: i + 1, text: lines[i].trim() };
  }
  return null;
}

export type MismatchReport = { ok: true } | { ok: false, reasons: string[] } | { ok: null, reason: string };
/** a bare number is the PR's own repository's */
export type ResolvedIssue = number | { repo?: string, number: number };

/**
 * Pure. Compares what `declaration` DECLARED against what `resolved` GitHub actually RESOLVED, and
 * reports the difference named -- never just that one exists. `resolved: null` means the lookup itself
 * failed (this repo's own rule throughout `merge-guard/lookups.ts`: "could not ask" and "asked and got
 * nothing" are different states) and is reported as `ok: null`, distinct from a real, examined mismatch.
 *
 * `declaration.kind` of `"missing"`/`"malformed"` is treated as declaring NOTHING for this comparison --
 * see this file's own header for why those are `closesDeclarationReport`'s question, not this one's.
 *
 * #2995: A ROW IS A REPOSITORY AND A NUMBER: both sides are compared as `owner/repo#N`, a bare `#N` taking `prRepo` (the tracker's by default).
 * A bare `#N` in a PR of any other repository is refused even when GitHub resolved it: it names an issue of THAT repository, never the row.
 * @param {import("./acceptance-commands.ts").ClosesDeclaration} declaration
 * @param {ResolvedIssue[] | null} resolved
 * @param {string} body
 * @param {string} [prRepo]
 * @returns {MismatchReport}
 */
export function closesMismatchReport(declaration: import("./acceptance-commands.ts").ClosesDeclaration, resolved: ResolvedIssue[] | null, body: string, prRepo: string = REPO): MismatchReport {
  if (resolved === null) {
    return { ok: null,
      reason: "could not ask GitHub which issues this PR would close (the closingIssuesReferences lookup failed)" };
  }
  const declared = declaration.kind === "closes"
    ? closesReferences(declaration).map((ref) => ({ repo: ref.repo ?? prRepo, number: ref.number, bare: ref.repo === null })) : [];
  const got = resolved.map((issue) => (typeof issue === "number" ? { repo: prRepo, number: issue } : { repo: issue.repo ?? prRepo, number: issue.number }));
  const named = (ref: { repo: string; number: number; }) => (ref.repo === prRepo ? `#${ref.number}` : `${ref.repo}#${ref.number}`);
  const sameRow = (a: { repo: string; number: number; }) => (b: { repo: string; number: number; }) => a.repo === b.repo && a.number === b.number;
  const declaredLabel = declared.length === 0 ? "none" : declared.map(named).join(", ");

  const accidentalClosures = got.filter((issue) => !declared.some(sameRow(issue)));
  const wrongRepository = prRepo === REPO ? [] : declared.filter((ref) => ref.bare);
  const unresolvedDeclarations = declared.filter((ref) => !got.some(sameRow(ref)) && !wrongRepository.includes(ref));

  if (accidentalClosures.length === 0 && unresolvedDeclarations.length === 0 && wrongRepository.length === 0) {
    return { ok: true };
  }

  const reasons = [];
  for (const issue of accidentalClosures) {
    const phrase = findClosingPhrase(body, issue.number, issue.repo === prRepo ? null : issue.repo);
    reasons.push(phrase
      ? `you declared ${declaredLabel}, but GitHub will close ${named(issue)} anyway -- the phrase "${phrase.text}" `
        + `on line ${phrase.line} is what does it`
      : `you declared ${declaredLabel}, but GitHub will close ${named(issue)} anyway, for a phrase this scan could `
        + "not locate in the body text (check for a cross-reference to a commit, or a different repo)");
  }
  for (const ref of unresolvedDeclarations) {
    reasons.push(`you declared ${named(ref)}, but GitHub will NOT close it -- the declaration did not produce a `
      + `real closing reference (confirm ${named(ref)} exists in ${ref.repo === prRepo ? "this repo" : ref.repo}, and that the line reads exactly `
      + `"Closes ${named(ref)}")`);
  }
  for (const ref of wrongRepository) {
    reasons.push(`you wrote \`Closes #${ref.number}\`, which names issue ${ref.number} of ${prRepo}, not a row of ${REPO} -- write \`Closes ${REPO}#${ref.number}\``);
  }
  return { ok: false, reasons };
}

export type ClosesSibling = { number: number, resolved: number[] };

/** How many recent other open-or-merged PRs declaring a `Closes` must ALL resolve nothing before the fault is called repo-wide. */
export const REPO_WIDE_SIBLINGS = 3;

/**
 * Pure. The newest `REPO_WIDE_SIBLINGS` OTHER open or merged PRs whose body declares a non-empty `Closes` (drafts
 * included), each with the numbers GitHub resolved for it. `recentPrs` is newest first, as the lookup
 * returns it. `null` in, `null` out: a lookup that could not ask has no siblings to name (#2810).
 * @param {{ number: number, body: string, resolved: number[] }[] | null} recentPrs
 * @param {number} prNumber the PR under test, never its own sibling
 * @returns {ClosesSibling[] | null}
 */
export function recentClosesSiblings(recentPrs: { number: number; body: string; resolved: number[]; }[] | null, prNumber: number): ClosesSibling[] | null {
  if (recentPrs === null) return null;
  return recentPrs
    .filter((pr) => pr.number !== prNumber)
    .filter((pr) => {
      const declaration = extractClosesDeclaration(pr.body);
      return declaration.kind === "closes" && declaration.numbers.length > 0;
    })
    .slice(0, REPO_WIDE_SIBLINGS)
    .map(({ number, resolved }) => ({ number, resolved }));
}

/**
 * Pure. Is GitHub's failure to resolve a closing reference a REPO-WIDE condition rather than this body's
 * fault (#2810)? Only when the PR under test declares at least one number and resolves none, and EVERY
 * one of exactly `REPO_WIDE_SIBLINGS` recent siblings resolves none. `siblings: null` (could not ask) and
 * fewer than three siblings are both "cannot say", which reads as NOT repo-wide: unread data is never
 * evidence of a fault. #2822: it is the ONE condition `mismatchVerdict` passes on (with a warning); it decides nothing else.
 * @param {{ declared: number[], resolved: ResolvedIssue[] }} underTest
 * @param {ClosesSibling[] | null} siblings
 * @returns {boolean}
 */
export function isRepoWideResolutionFault(underTest: { declared: number[]; resolved: ResolvedIssue[]; }, siblings: ClosesSibling[] | null): boolean {
  if (underTest.declared.length === 0 || underTest.resolved.length > 0) return false;
  if (siblings === null || siblings.length < REPO_WIDE_SIBLINGS) return false;
  return siblings.every((sibling) => sibling.resolved.length === 0);
}

/**
 * The warning the repo-wide case PASSES with (#2822). It names the condition and the remedy: the post-merge closer
 * closes the declared rows from the body, because GitHub will not.
 */
export const REPO_WIDE_WARNING = Object.freeze([
  "CLOSES MISMATCH: WARNING -- GitHub resolved no closing reference for this PR or for the last "
    + `${REPO_WIDE_SIBLINGS} open PRs that declare one, so the condition is repo-wide and not this body.`,
  "  Passing: the post-merge closer (close-rows-for-merged-pr.ts) will close the declared rows FROM THE BODY'S "
    + "DECLARATION, because GitHub resolved none.",
]);

/**
 * Pure. What a REFUSED report prints and exits with. The exit is the literal 1 for every refusal, and the words
 * are today's for every one of them (#2810). The repo-wide case is not refused any more (#2822) -- see
 * `repoWideWarning` -- so `refusal` is never asked about it and cannot turn a refusal into a pass.
 * @param {{ ok: false, reasons: string[] }} report
 * @returns {{ exit: 1, lines: string[] }}
 */
export function refusal(report: { ok: false; reasons: string[]; }): { exit: 1; lines: string[]; } {
  const head = "CLOSES MISMATCH: REFUSED -- what you declared and what GitHub will actually close disagree:";
  return { exit: 1, lines: [head, ...report.reasons.map((reason) => `  ${reason}`)] };
}

/**
 * Pure. What a mismatch prints and exits with (#2822). PASSES, with the warning, ONLY when
 * `isRepoWideResolutionFault` holds: this PR declares a number, GitHub resolved none for it, and all
 * `REPO_WIDE_SIBLINGS` recent siblings resolved none either. Every other mismatch -- an accidental closure even
 * while the condition is repo-wide, a lone mismatch, too few siblings, an unreadable sibling lookup, a partial
 * resolution -- is `refusal`, byte for byte. Absence of evidence never passes: `siblings: null` is refused.
 * @param {{ ok: false, reasons: string[] }} report
 * @param {{ declared: number[], resolved: ResolvedIssue[] }} underTest
 * @param {ClosesSibling[] | null} siblings
 * @returns {{ exit: 0 | 1, lines: string[] }}
 */
export function mismatchVerdict(report: { ok: false; reasons: string[]; }, underTest: { declared: number[]; resolved: ResolvedIssue[]; }, siblings: ClosesSibling[] | null): { exit: 0 | 1; lines: string[]; } {
  if (isRepoWideResolutionFault(underTest, siblings)) return { exit: 0, lines: [...REPO_WIDE_WARNING] };
  return refusal(report);
}

function main() {
  refuseUnknownFlags([], { entry: import.meta.url, command: "node packages/agent-org/src/closes-mismatch-check.ts" });
  const prNumber = Number(process.argv[2]);
  if (!prNumber) {
    console.error("usage: closes-mismatch-check.ts <pr-number> [owner/repo]  (the PR body is read from PR_BODY)");
    process.exit(2);
  }
  // FROM AN ENV VAR, NEVER ARGV -- identical reasoning to `acceptance-commands.ts`'s own `main()`: a PR
  // body is adversarial input, and GitHub Actions' `env:` mapping keeps it one opaque string.
  const body = process.env.PR_BODY ?? "";
  const declaration = extractClosesDeclaration(body);
  if (declaration.kind === "missing" || declaration.kind === "malformed") {
    console.log("CLOSES MISMATCH: skipped -- the Closes declaration itself is missing or malformed, "
      + "which the acceptance job's own closesDeclarationReport gate already refuses.");
    process.exit(0);
  }
  const prRepo = process.argv[3] ?? REPO; // #2995
  const resolved = lookupClosingIssues(prNumber, prRepo);
  const report = closesMismatchReport(declaration, resolved, body, prRepo);
  if (report.ok === null) {
    // FAIL CLOSED, DELIBERATELY, ON A LOOKUP FAILURE -- "could not ask" must never read as "they
    // matched". This job runs in `mergeSafety`, a required `gate` context, so this blocks every merge on
    // a GraphQL blip, not just this one PR -- a real cost, weighed and accepted anyway: the alternative
    // (allow on `null`) makes the check go silent EXACTLY when the API is unwell, which is the one moment
    // an author is least able to notice its absence. This repo's own rule throughout `merge-guard/
    // lookups.ts` is that "could not ask" and "asked and got nothing" are different states and neither
    // may read as clean -- the same choice `merge-guard.ts --ci-gate` already makes (exit 2, CANNOT ASK,
    // never treated as READY). A transient GraphQL failure is rare and retriable (push again, or the
    // `update-branch` sweep's own re-push re-runs this); a real accidental closure sailing through
    // silently is not.
    console.log(`CLOSES MISMATCH: CANNOT ASK -- ${report.reason}`);
    process.exit(2);
  }
  if (!report.ok) {
    // The sibling query is asked only when this PR's own facts already fit, so a lone mismatch costs nothing extra.
    const underTest = { declared: declaration.kind === "closes" ? declaration.numbers : [], resolved: resolved ?? [] };
    const fits = underTest.declared.length > 0 && underTest.resolved.length === 0 && prRepo === REPO;
    const siblings = fits ? recentClosesSiblings(lookupRecentClosesPrs(), prNumber) : null;
    const { exit, lines } = mismatchVerdict(report, underTest, siblings);
    for (const line of lines) console.log(line);
    process.exit(exit);
  }
  console.log("CLOSES MISMATCH: ok -- declared and resolved agree");
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
