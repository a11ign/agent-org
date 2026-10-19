import { extractLabeledSection } from "../region-paths.ts";
import { readFileSync, statSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { localImports, importedNamesFor, stripComments } from "../lib/local-import-closure.ts";
import { toolImports } from "../lib/installed-tool-imports.ts";
import { tryResolveTypescript, type TypescriptResolution } from "../lib/resolve-typescript.ts";
import { RESOURCES, FLEET_QUESTION, ACCEPTANCE_FIELD } from "../project-vocabulary.ts";

export type Classification = { verdict: "runnable" } | { verdict: "refused", reason: string } | { verdict: "prose", reason: string };
export type Section = { kind: "missing" } | { kind: "none", reason: string } | { kind: "commands", commands: string[] } | { kind: "duplicate", occurrences: { line: number, text: string }[] };
/** one row a body names: `repo` is `owner/name`, or null for a bare `#N` (the PR's own repository's) */
export type ClosesReference = { repo: string | null, number: number };
export type ClosesDeclaration = { kind: "missing" } | { kind: "malformed", detail: string } | { kind: "none", reason: string } | { kind: "closes", numbers: number[], references?: ClosesReference[] };
// #621: `corpus` is OPTIONAL, deliberately -- every existing capabilities literal in this file's own test
// suite (`NO_HISTORY`, `WITH_HISTORY`) predates it and names only three keys. `unmetRequirements`'s own
// rule already reads an absent key as unmet, never as satisfied by default, so making the field optional
// costs nothing: an object that never mentions `corpus` still answers "unmet" exactly as if it had named
// `corpus: false`.
export type JobCapabilities = { history: boolean, token: boolean, fleet: boolean, corpus?: boolean };

// `pnpm run fleet:*` and its siblings -- the resource ban every worker/agent role file below `ceo` and
// `orchestrator` carries, verbatim, elsewhere in this repo. A GitHub-hosted runner is not one of the
// exceptions to it.
// #1912: THE NAMED ENTRIES NAME A THING, where every other pattern names an INVOCATION. `fleet:status` in a
// sentence is still somebody running `fleet:status`; `A11Y_PVE_KEY` in a sentence may be a unit test
// asserting what happens when the key is ABSENT -- #1911's Acceptance was a plain rstest run whose bullet
// said exactly that, and `row-file` routed it to `orchestrator`, the one session the row existed to spare.
// `fleetOrLabAcceptance` reads these outside bullet prose only; see `withoutBulletProse`.
//
// #2619 (child 3d of #69): THE VALUES ARE `RESOURCES`, a11ign's project declaration -- this file now
// derives its two working lists from the `named` flag each entry carries, rather than choosing the patterns
// itself. A second project's declaration can name a different resource ban, or none. `resourcePatternsFrom`
// is EXPORTED, pure, and takes `resources` as a parameter rather than closing over `RESOURCES`, so a test
// can show a fixture project's OWN list (an empty one included) derives its own two working lists, without
// swapping the module's own import-time binding of `RESOURCES`.
export function resourcePatternsFrom(resources: readonly { pattern: RegExp; reason: string; named: boolean; }[]): { patterns: [RegExp, string][]; namedNotInvoked: Set<RegExp>; } {
  return {
    patterns: resources.map(({ pattern, reason }) => [pattern, reason]),
    namedNotInvoked: new Set(resources.filter((resource) => resource.named).map((resource) => resource.pattern)),
  };
}

export const { patterns: FLEET_LAB_PATTERNS, namedNotInvoked: NAMED_NOT_INVOKED } = resourcePatternsFrom(RESOURCES);

// #1988: A PARAGRAPH DECLARING THE WORK **OUT** IS NOT THE ROW DOING IT. `extractLabeledSection` runs to
// the next `##` heading, so the Acceptance span swallows every bold-labelled paragraph after it --
// `Done when` and `Not in scope` both. #1984's `Not in scope` said "and the three systemd units, done in
// #1982", and that one sentence routed a row whose Acceptance is a single rstest run to `orchestrator`,
// replacing the `lane:any` its Region had correctly derived (`withAcceptanceLane` drops `lane:any` by
// design, #1912). The row was re-laned by hand.
//
// ONE LABEL, BECAUSE ONE IS WHAT THE POPULATION HAS. Measured 2026-09-23 over every open row: nine bodies
// carry `**Not in scope:**` and no other bold spelling of it appears; the two `## Not in scope` headings
// need nothing, since a heading already ends the span. NAMED and not inferred, for the reason
// `FLEET_LAB_PATTERNS` is: a list somebody chose is what makes trimming on it safe. What is DERIVED is
// how far the paragraph reaches -- `withoutScopeDisclaimer` below, structurally, exactly as
// `withoutBulletProse` derives a bullet item's extent from its marker.
const SCOPE_DISCLAIMER = /^\s*\*\*not in scope\b/i;

// #2175: THE INVOCATION PATTERNS -- everything a declared No does NOT silence. The NAMED entries name a
// THING a test double can also name (`systemctl` in "given a fake `systemctl`"); the rest name a COMMAND, and
// `fleet:status` in an Acceptance is somebody running it whatever the row's answer says (#1912's ground).
const INVOCATION_PATTERNS = FLEET_LAB_PATTERNS.filter(([pattern]) => !NAMED_NOT_INVOKED.has(pattern));
const NAMED_PATTERNS = FLEET_LAB_PATTERNS.filter(([pattern]) => NAMED_NOT_INVOKED.has(pattern));

// NAMED, NOT INFERRED -- the answer is the FIRST WORD, from a short list somebody chose. Measured 2026-09-25
// over the 400 most recent rows (151 carry the section): `No`/`Neither` and `Yes`/`Both` are the
// unambiguous ones, `Partly` and free prose (`The lab only`, `It needs the corpus ...`) are not, and a
// reader that guessed at prose would be the deriver's own defect (#1241) moved one section along. The
// lookahead keeps `Nobody`, `Not applicable` and `No-op` from reading as No.
const ANSWER_END = "(?=$|[\\s.,:;!\u2014\u2013])";
const DECLARED_NO = new RegExp(`^(?:no|neither)${ANSWER_END}`, "i");
const DECLARED_YES = new RegExp(`^(?:yes|both)${ANSWER_END}`, "i");

const DECLARED_YES_REASON = `is declared by the row itself ("${FLEET_QUESTION}?" answers Yes) to need the fleet or the lab`;

/**
 * #2175: THE ROW'S OWN ANSWER to the template's "Does the acceptance need the fleet or the lab?" -- `"no"`,
 * `"yes"`, or `null` for a body that has no such section OR whose answer is not an unambiguous No/Yes
 * (`Partly`, prose, empty). **`null` means UNDECLARED, and undeclared rows derive exactly as they did
 * before this existed**: absence and "could not read it" are never promoted to an answer.
 * @param body a row body
 */
export function declaredFleetAnswer(body: string): "no" | "yes" | null {
  if (typeof body !== "string") return null;
  const section = extractLabeledSection(body, FLEET_QUESTION);
  if (section === null) return null;
  const answer = section.replace(/^[\s*_`]+/, "");
  if (DECLARED_NO.test(answer)) return "no";
  return DECLARED_YES.test(answer) ? "yes" : null;
}

/**
 * #1241: DOES THIS ROW'S ACCEPTANCE NAME A FLEET OR LAB COMMAND? The lane derivation asks; nothing else
 * could answer it.
 *
 * `laneLabelsFor` derives a lane from the Region's PATHS, so **a row whose deliverable is not a commit
 * can never carry a lane** -- #1042 (a destination the chairman provisions) and #1234 (a systemd timer on
 * the control plane) both reached `ready`/`lane:any` with an acceptance naming a specific session, and an
 * engineer had to read the body to discover the row was not theirs. Twice.
 *
 * THE LIST IS NOT RETYPED. `FLEET_LAB_PATTERNS` above is the resource ban every role file below `ceo` and
 * `orchestrator` already carries, and a second copy is the fact-stated-twice shape on the one question
 * both are answering. CORPUS_PATTERNS is deliberately NOT included: a `runs/`-reading gate is a verdict
 * somebody else must report, which is a different rule from "this command needs hardware nobody else has".
 *
 * @param body a row body
 * @returns the reason the matched command needs the fleet or lab, or null
 */
export function fleetOrLabAcceptance(body: string): string | null {
  // THE RAW SECTION, not `extractAcceptanceSection`'s commands -- and that is the correction review
  // forced. That function returns the first COMMAND LINE; for #1042 and #1234 it returns one line of
  // prose, so the numbered clauses naming systemd and `gh workflow run` were never looked at. The two
  // rows this deriver was filed on both answered null, and a lane deriver answering null for a row that
  // is NOT lane:any looks exactly like one answering null for a row that is.
  //
  // Running a command and CLASSIFYING a row are different questions over the same text: `pr-open` needs
  // the runnable lines, this needs everything the section says it will take.
  const declared = declaredFleetAnswer(body);
  const section = extractLabeledSection(body, ACCEPTANCE_FIELD);
  // #2175: DECLARATION FIRST, PATTERN SECOND. A No silences the five NAMED patterns and nothing else; a Yes
  // routes with no pattern at all. Rows that say neither derive from the patterns alone, as before.
  const patterns = declared === "no" ? INVOCATION_PATTERNS : FLEET_LAB_PATTERNS;
  const matched = section === null ? null : patternReason(section, patterns);
  return matched ?? (declared === "yes" ? DECLARED_YES_REASON : null);
}

/**
 * The reason of the first of `patterns` that matches `section`: a NAMED pattern is read against
 * `namedPatternText` (#1912, #1988), an invocation against the whole span.
 */
function patternReason(section: string, patterns: readonly [RegExp, string][]): string | null {
  const named = namedPatternText(section);
  for (const [pattern, reason] of patterns) {
    if (pattern.test(NAMED_NOT_INVOKED.has(pattern) ? named : section)) return reason;
  }
  return null;
}

/**
 * The text a NAMED pattern is read against: the Acceptance span minus its bullet prose (#1912) and minus
 * any scope-disclaiming paragraph (#1988).
 *
 * INVOCATION PATTERNS STILL READ THE WHOLE SPAN, disclaimer included, and that is deliberate rather than
 * an omission. #1912 settled it for bullets on the same ground: `fleet:status` in a sentence is still
 * somebody running `fleet:status`, while a NAMED thing -- a variable, a unit, a place -- may be a test's
 * subject or, here, the work a row says it will NOT do. The conservative direction is to over-route an
 * invocation, which a reader can see and correct, rather than to under-route one silently.
 */
function namedPatternText(section: string): string {
  return withoutBulletProse(withoutScopeDisclaimer(section));
}

/**
 * #1912, widened by #1988: the reason a NAMED pattern would have given when it appears ONLY in text the
 * deriver trims, and WHICH trim swallowed it -- `row-file` prints both, so neither rule can get a row
 * wrong in silence. #1912 made silence the defect; a second silent trim would re-make it.
 *
 * The form is derived, not assumed: the pattern is re-tested against the span with only the disclaimer
 * removed, so a mention that survives that is the bullet rule's and one that does not is this row's.
 * @param body a row body
 */
export function untrimmedFleetMention(body: string): { reason: string; form: "bullet" | "scope disclaimer"; } | null {
  const section = extractLabeledSection(body, ACCEPTANCE_FIELD);
  if (section === null || fleetOrLabAcceptance(body) !== null) return null;
  // #2175: under a declared No the DECLARATION decided, and `declarationDisagreement` says so. Naming a
  // trim here would send the filer to the wrong fix -- a numbered clause is not a bullet.
  if (declaredFleetAnswer(body) === "no") return null;
  const hit = FLEET_LAB_PATTERNS.find(([pattern]) => NAMED_NOT_INVOKED.has(pattern) && pattern.test(section));
  if (!hit) return null;
  const survivesDisclaimerTrim = hit[0].test(withoutScopeDisclaimer(section));
  return { reason: hit[1], form: survivesDisclaimerTrim ? "bullet" : "scope disclaimer" };
}

/**
 * #2175: WHERE THE ROW'S ANSWER AND THE PATTERNS DISAGREE, and which one won. The finding is the
 * disagreement, and before this it was resolved silently in the pattern's favour.
 *
 * Three shapes, and an agreement is `null`: a No that silenced a NAMED pattern (`routed: false`, and the
 * pattern that lost is named); a No that an INVOCATION overrode (`routed: true`, and the pattern that won
 * is named); a Yes that no pattern backed (`routed: true`, `reason: null`). A row that declares nothing has
 * nothing to disagree with -- that is `untrimmedFleetMention`'s territory.
 * @param body a row body
 */
export function declarationDisagreement(body: string): { declared: "no" | "yes"; routed: boolean; reason: string | null; } | null {
  const declared = declaredFleetAnswer(body);
  if (declared === null) return null;
  const section = extractLabeledSection(body, ACCEPTANCE_FIELD);
  if (declared === "yes") {
    return section !== null && patternReason(section, FLEET_LAB_PATTERNS) !== null
      ? null : { declared, routed: true, reason: null };
  }
  if (section === null) return null;
  const invocation = patternReason(section, INVOCATION_PATTERNS);
  if (invocation !== null) return { declared, routed: true, reason: invocation };
  // The RAW span, not `namedPatternText`: under a No the declaration decided, so a mention the bullet or
  // disclaimer trim would have swallowed anyway is still worth naming rather than passing over.
  const silenced = NAMED_PATTERNS.find(([pattern]) => pattern.test(section));
  return silenced ? { declared, routed: false, reason: silenced[1] } : null;
}

/**
 * #1988: the Acceptance span minus any SCOPE-DISCLAIMING PARAGRAPH -- label line and continuations --
 * outside a code fence. A NAMED pattern is read against what is left.
 *
 * THE LABEL IS THE MARKER AND THE EXTENT IS DERIVED, which is `withoutBulletProse`'s own shape one
 * paragraph over: that function finds a bullet by `- ` and then works out where the item ends from the
 * body's structure. Here the marker is `**Not in scope`, and the paragraph ends the way any lazy
 * Markdown block does -- `endsLazyBlock`, shared with the bullet rule rather than written twice.
 *
 * SO A NUMBERED CLAUSE IS STILL READ, and that is the bound this trim needs: `endsLazyBlock` ends the
 * block at a numbered clause, a heading, or a blank line followed by unindented text, so `Done when`'s
 * clauses -- #1241's two founding rows are exactly that shape -- survive it. A row stating a real
 * hardware dependency still routes; only the paragraph saying the work is OUT does not.
 */
function withoutScopeDisclaimer(section: string): string {
  let inFence = false;
  let inDisclaimer = false;
  let afterBlank = false;
  return section.split(/\r\n|\r|\n/).filter((line) => {
    const isFence = /^\s*(```|~~~)/.test(line);
    if (isFence) { inFence = !inFence; inDisclaimer = false; }
    if (inFence || isFence) return true;
    if (SCOPE_DISCLAIMER.test(line)) { inDisclaimer = true; afterBlank = false; return false; }
    if (line.trim() === "") { afterBlank = inDisclaimer; return true; }
    if (inDisclaimer && !endsLazyBlock(line, { afterBlank })) return false;
    inDisclaimer = false;
    return true;
  }).join("\n");
}

/**
 * #1912: the Acceptance section minus its BULLET ITEMS -- marker line and continuations -- outside a code
 * fence: the text a NAMED pattern (a variable, a unit, a place) is read against. Invocation patterns still
 * read the whole section.
 *
 * WHY BULLETS AND ONLY BULLETS. This repo's Acceptance shape is a fenced command followed by "the run
 * passes and includes:" and a bullet per thing the tests assert -- a bullet there DESCRIBES a test. What
 * the Acceptance DOES lives in the fence, in a numbered clause (#1234's "1. A systemd USER timer...",
 * #1042's "2. `A11Y_CORPUS_REMOTE` is set on the lab.") or in a plain sentence, and all three are still
 * read. The raw section stays the input (#1241): going back to the runnable lines alone is what made
 * #1042 and #1234 answer null.
 *
 * NOT A PROOF, A CONVENTION. A bullet that genuinely does the thing (`- run systemctl ...`) now answers
 * null -- the direction #1241 called unsafe -- so `row-file` says so when it happens (see
 * `untrimmedFleetMention`), and the fix is to write that step as a numbered clause, which is read.
 */
function withoutBulletProse(section: string): string {
  let inFence = false;
  let inItem = false;
  let afterBlank = false;
  return section.split(/\r\n|\r|\n/).filter((line) => {
    const isFence = /^\s*(```|~~~)/.test(line);
    if (isFence) inFence = !inFence;
    // #1914's review: a fence, opening or closing, ENDS the item -- else the line after a closing fence
    // reads as the bullet's lazy continuation and a real step is dropped.
    if (isFence) inItem = false;
    if (inFence || isFence) return true;
    if (/^\s*[-*+]\s/.test(line)) { inItem = true; afterBlank = false; return false; }
    if (line.trim() === "") { afterBlank = inItem; return true; }
    if (inItem && !endsLazyBlock(line, { afterBlank })) return false;
    inItem = false;
    return true;
  }).join("\n");
}

/**
 * Does `line` end the lazily-continued block above it -- a bullet item (#1912) or a scope-disclaiming
 * paragraph (#1988)? The WHOLE block is prose, not its marker line (#1914's review: a wrapped bullet's
 * `A11Y_PVE_KEY` on an indented continuation still routed, silently). An indented line continues the
 * block, and so does an unindented one straight after it -- Markdown's lazy continuation -- unless it
 * opens a block of its own: a numbered clause, a heading or a fence is the work, and is read. After a
 * blank line only indentation keeps a line inside the block.
 *
 * ONE FUNCTION FOR BOTH, because it is one Markdown rule and #1988 would otherwise have been a second
 * spelling of it that could drift from this one.
 * @param line a non-blank line outside any fence
 */
function endsLazyBlock(line: string, { afterBlank }: { afterBlank: boolean; }) {
  if (/^\s/.test(line)) return false;
  return afterBlank || /^(\d+[.)]\s|#)/.test(line);
}

// #2473: `check-signals` is the only entry spelled like a FILE STEM, and `-` is a word boundary, so the bare
// word also refused any test FILE whose name merely begins with it (`check-signals-pipe.test.ts`, whose
// import closure never reaches runs/). The gate is the npm script (`training:check-signals`, with an
// optional `:complete` suffix) or `check-signals.mjs`: the name NOT continued by `-`, `.` or a path
// separator. `.mjs` is the one `.` continuation that IS the gate.
const CHECK_SIGNALS_GATE = /\bcheck-signals(?:\.mjs\b|(?![-.\w/]))/;

// `runs/` is gitignored -- a GitHub runner never has a corpus, so these read nothing and report cleanly.
// CLAUDE.md: "A GATE THAT READS runs/ IS NOT YOURS TO REPORT."
export const CORPUS_PATTERNS = ([
  [/\brules:gate\b/, "reads runs/, which is gitignored and absent in CI"],
  [/\brules:coverage\b/, "reads runs/, which is gitignored and absent in CI"],
  [CHECK_SIGNALS_GATE, "reads runs/, which is gitignored and absent in CI"],
  [/\bcorpus:starvation\b/, "reads runs/, which is gitignored and absent in CI"],
  [/\bscorer:shortcuts\b/, "reads runs/, which is gitignored and absent in CI"],
] as [RegExp, string][]);

// #516: `pnpm run mutate` (`packages/guards/src/mutation-check.mjs`) AND `Refutation:` HAVE OPPOSITE EXIT CONVENTIONS.
// `mutate`'s own contract (see that file's header) is exit 0 = the guard BITES -- the GOOD outcome.
// `Refutation:` reads success as any NON-ZERO exit (#438) -- so a `Refutation:` line naming `mutate`
// inverts the verdict, and the dangerous half is not the confusing red: a guard that DID NOT bite exits 1,
// which `Refutation:` reads as REFUSED -- the passing state. It produces a green for the exact case the
// section exists to catch. Neither convention changes -- each is right on its own terms -- so the fix is
// to make the collision unwalkable rather than to unify them: refuse to interpret the exit code at all,
// naming the inversion and pointing at the alternative #504 already established (drop the parsed section,
// paste `mutate`'s real output under an unparsed heading). Classified `"refused"`, the SAME mechanism as
// the fleet/lab/corpus patterns above -- this is a command whose exit code this job cannot honestly
// interpret, not a claim the PR body failed to support, so it never runs and never fails the job on its
// own (#516's own stated acceptance).
export const MUTATE_PATTERN = /\bnpm run mutate\b|\bmutation-check\.mjs\b/;

// #446: A LEADING `VAR=value` ASSIGNMENT IS NOT THE COMMAND. This repo's own Acceptance/Mutation lines
// routinely start with one -- `A11Y_ALLOW_ARMED_PUSH="..." git push`, `GH_TOKEN=... gh pr view`,
// `PYTHONDONTWRITEBYTECODE=1 pytest ...` -- and the executable check below must look PAST it, or every
// one of those legitimate, real commands would misclassify as prose over an assignment that was never
// meant to be looked up on `$PATH`.
export const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;

// #446's OWN STATED SECOND HALF: `command -v` finds these because they genuinely ARE executable, so no
// existence check can catch a line that merely starts with one. Flagged by name instead -- the identical
// shape `FLEET_LAB_PATTERNS`/`CORPUS_PATTERNS` already use, for the identical reason: a check that can
// answer "is this refusable" cannot also answer "is this claim supportable", so it needs its own list.
export const UNVERIFIABLE_BUILTINS = new Set(["echo", "true", ":", "test", "time", "["]);

// #2178: THE SHELL KEYWORDS THAT OPEN OR CLOSE A BLOCK. `for` IS a command -- to bash -- so telling the filer
// it has "no executable" sends them to look for a missing binary. It has none because it is grammar, not a
// program. `[[` is left out on purpose: `[[ -f x ]]` is a complete one-line command, not a block edge.
// Only the REASON differs from the no-executable refusal; the verdict is the same `prose` it always was.
export const SHELL_BLOCK_KEYWORDS = new Set(["for", "while", "until", "if", "case", "select", "function",
  "do", "then", "else", "elif", "fi", "done", "esac", "{", "}"]);

/**
 * The first token of a command that could plausibly BE the command -- skipping a leading `cd <dir> &&` (#3058)
 * and any leading `VAR=value` assignments (#446). `undefined` for an empty or whitespace-only line.
 *
 * `cd` IS NOT THE COMMAND: its exit code proves nothing and the command after the `&&` is what runs, so that
 * is the token whose executable, refusal or prose reading the line gets. `UNVERIFIABLE_BUILTINS` is the
 * opposite case -- `echo` IS the command and says nothing -- which is why `cd` is skipped, not listed there.
 */
export function firstRealToken(command: string): string | undefined {
  const tokens = stripLeadingCd(command).trim().split(/\s+/).filter(Boolean);
  return tokens.find((token) => !ENV_ASSIGNMENT.test(token));
}

// The three "execute" bits of a POSIX mode (owner+group+other) -- named because `0o111` reads as an
// arbitrary octal constant otherwise.
const EXECUTE_BITS = 0o111;

/**
 * Does `token` resolve to something executable -- the same question `command -v` answers, computed
 * without a subprocess so `classifyCommand` stays pure (this file's own stated invariant) even for this
 * check. A token containing `/` is checked directly as a path (a relative or absolute script, never
 * `$PATH`-searched); anything else is searched across `$PATH`'s own directories, exactly as a shell would.
 */
export function commandExists(token: string): boolean {
  const isExecutableFile = (path: string) => {
    try {
      return (statSync(path).mode & EXECUTE_BITS) !== 0;
    } catch {
      return false;
    }
  };
  if (token.includes("/")) return isExecutableFile(token);
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return dirs.some((dir) => isExecutableFile(join(dir, token)));
}

// #497/#510: THIS JOB'S ENVIRONMENT IS DECLARED IN ONE PLACE, per docs/pipeline.md, and this constant
// describes the `acceptance` job SPECIFICALLY -- it is never read by `reusable-build-test.yml`'s `ts` or
// `trunkGate` invocations, both of which DO carry a real `GH_TOKEN: github.token` (row-claim-live.test.ts's
// live call runs for real there). `fleet` is the only one of the two that is a runner-level fact true of
// EVERY job in this repo -- a GitHub-hosted ubuntu runner has no Windows worker, full stop. `token` is not
// that: it is a DELIBERATE, job-specific security choice (this job alone executes an untrusted PR body's
// own commands, so it alone is given no token at all -- see this file's own header). Read this as "false in
// the one job that consults it," never as "false on any GitHub runner" -- a future caller of this same
// mechanism from `ts`/`trunkGate` would need its own, differently-true `token` value, not this one.
// `history` is the one axis a PR itself controls, via `History: full` in the body (#497).
export const FULL_CAPABILITIES =
  ({ history: true, token: true, fleet: true, corpus: true } as JobCapabilities);

// A bare line, deliberately -- `History: full` names nothing else the way `Acceptance:`/`Closes:` name a
// command or an issue, so this needs no section parser, just a marker this PR's checkout should deepen
// before anything else runs.
// #1036: BOLD-TOLERANT, because six lines below `commandLinesAfter`'s own stop rule already is --
// `^(?:\*\*|__)?${name}:(?:\*\*|__)?` for `Acceptance:`/`Refutation:`/`Mutation:`. One function, two
// conventions about bold, three lines apart, and the stricter one was the newer code. `**History: full**`
// is a spelling these bodies reach for constantly, and it was recognised NOWHERE: not as a declaration, so
// the checkout stayed shallow, and not as a declaration by `commandLinesAfter` either, so it was taken as
// a command and terminated the scan -- reproducing #1035's exact pair of misleading messages in the very
// commit that fixed them. worker-capture's finding.
//
// Still ANCHORED at both ends, which is what keeps `node scripts/x.mjs --History: full-run` a command:
// the tolerance is for the wrapper, never for surrounding text.
const HISTORY_FULL_PATTERN = /^\s*(?:\*\*|__)?History:\s*full(?:\*\*|__)?\s*$/im;

// #1036: A LINE THAT OPENS WITH `History:` AND IS NOT A RECOGNISED DECLARATION. `History: full.` and
// `History: shallow` are neither honoured nor commands, and silently taking them as commands is how the
// unrecognised spelling produces a refusal about something else. Named rather than guessed at.
const HISTORY_ISH_PATTERN = /^\s*(?:\*\*|__)?History\s*:/i;

/**
 * #1036: is this line an attempt at the `History:` declaration, recognised or not?
 *
 * Both answers skip, and for different reasons. The RECOGNISED form is honoured from the whole body by
 * `hasFullHistoryDeclaration`, so taking it as a command is pure loss. A NEAR-MISS (`History: full.`,
 * `History: shallow`) is not honoured and the checkout stays shallow -- but it must not ALSO become a
 * command and terminate the scan, because then the job reports "every command above was refused" about a
 * line the author wrote as a declaration, and the real command, whose refusal would have named `history`
 * and been followable, never enters the list at all. Skipping leaves exactly one refusal, and it is the
 * one that names the actual problem.
 *
 * Extracted rather than inlined so `commandLinesAfter` stays under the complexity gate -- a called
 * function's branches are not the caller's, the same reason `postBlockedByNoteIfAny` exists next door.
 */
function isHistoryDeclarationLine(trimmed: string): boolean {
  return HISTORY_FULL_PATTERN.test(trimmed) || HISTORY_ISH_PATTERN.test(trimmed);
}

/**
 * Does the PR body ask for this run's checkout to carry full history (#497)? A PR carrying the line with
 * no historical fixture in its Acceptance command pays only time, never a wrong verdict -- see this
 * file's own header and #497's own "what it must not become" for why that asymmetry is deliberate.
 */
export function hasFullHistoryDeclaration(body: string | null | undefined): boolean {
  return HISTORY_FULL_PATTERN.test(body ?? "");
}

// #2099: THE `token` DECLARATION, IN THE `History: full` FAMILY AND FOR ITS REASON.
//
// `jobCapabilities()` names four capabilities this job can lack and a row could declare three of them:
// `history` in the body, `fleet` by a required template dropdown, `corpus` by the template's prose rule.
// `token` had NOTHING, so a row whose Acceptance is a `gh` command said so in prose no code reads, and
// nothing said so until `pr-open` -- after a builder had claimed the row and built the change (#879's
// cost, paid again).
//
// A BODY FIELD AND NOT A TEMPLATE DROPDOWN, and the reason is which body has to carry it. The `fleet`
// dropdown is enforced by the web form, which `gh issue create` does not apply (`fileRefusalReason` says
// so about the three required sections), and -- decisively -- the declaration has to be readable from the
// **PR body** at `pr-open`, where there is no template and no dropdown. `History: full` is the proven
// shape for exactly that: one anchored line, parsed by one function, honoured wherever it lands.
//
// A REASON IS REQUIRED, like `Closes: none -- <reason>`. "This is hand-run" is a fact about the command;
// WHO runs it and WHY a runner cannot is the thing a reader of the PR needs, and the bare form would
// become the flag people add to make a red check green.
// HORIZONTAL WHITESPACE ONLY, and this is not a style choice: `\s` matches a NEWLINE, so a pattern
// written with `\s*` around the reason spans lines -- measured on `Hand-run:` followed by a blank line and
// a fenced `gh` command, where it captured the fence and reported the row as declared. A declaration is
// one line by definition, and a bare `Hand-run:` must fall through to the near-miss rule below.
const HAND_RUN_PATTERN = /^[^\S\r\n]*(?:\*\*|__)?Hand-run:[^\S\r\n]*(?:\*\*|__)?[^\S\r\n]*(\S[^\r\n]*?)[^\S\r\n]*$/im;

// #1036's near-miss rule, on this field: a line that OPENS with `Hand-run:` and is not a recognised
// declaration (`Hand-run:` with nothing after it) is neither honoured nor a command. Taking it as a
// command is how an unrecognised spelling produces a refusal about something else -- see
// `isHistoryDeclarationLine` for the full argument, which is the same one.
const HAND_RUN_ISH_PATTERN = /^\s*(?:\*\*|__)?Hand-run\s*:/i;

/** #2099: is this line an attempt at the `Hand-run:` declaration, recognised or not? */
function isHandRunDeclarationLine(trimmed: string) {
  return HAND_RUN_PATTERN.test(trimmed) || HAND_RUN_ISH_PATTERN.test(trimmed);
}

/**
 * #2099: is this line a DECLARATION rather than a command -- `History: full` or `Hand-run: <reason>`,
 * recognised or near-miss? One function so `commandLinesAfter` pays ONE branch for the whole family: the
 * caller sits at this repo's complexity gate, and every declaration added since has had to be free there
 * (`isHistoryDeclarationLine` was extracted for exactly this, and says so).
 */
export function isDeclarationLine(trimmed: string): boolean {
  return isHistoryDeclarationLine(trimmed) || isHandRunDeclarationLine(trimmed);
}

/**
 * #2099: the row's or PR's own statement that its Acceptance is run BY HAND, and why -- or `null`.
 *
 * The reason is returned rather than a boolean, because every message this declaration produces quotes
 * it: a `NOT RUN` line naming no reason is the prose it replaces with extra steps.
 */
export function handRunDeclaration(body: string | null | undefined): string | null {
  const match = HAND_RUN_PATTERN.exec(body ?? "");
  if (!match) return null;
  const reason = match[1].replace(/\s*(?:\*\*|__)\s*$/, "").trim();
  // THE EMPTINESS TEST IS ON THE NORMALIZED REASON, NEVER ON WHETHER THE PATTERN MATCHED -- reviewer's
  // blocker on #2105. The pattern's `(\S...)` makes a bare `Hand-run:` fail to match, so the bare form
  // was already `null`; but `**Hand-run: **` MATCHES, capturing the closing `**` as the reason, and the
  // strip above then empties it. Returning `""` there is worse than either answer taken alone, because
  // THE TWO READERS OF THIS FUNCTION DISAGREE ABOUT THE SAME BODY: `handRunAcceptanceReason` asks
  // `!== null` and files the row clean, while `runOneCommand` reads the reason for TRUTHINESS and refuses
  // it -- so the row passes the gate that exists to catch it early and fails the one that costs a
  // rewrite, which is precisely the #879 sequence this row was filed to end. An empty reason is a
  // declaration of nothing: it names no one and says nothing, so it falls through to the near-miss rule
  // below and the author meets ONE refusal naming the actual problem.
  return reason === "" ? null : reason;
}

// #2099: the strip above, and why the pattern cannot do it alone. `**Hand-run: whoever holds the admin
// credential**` closes its bold AFTER the reason, and a lazy capture that stops before `**` would eat a
// reason genuinely ending in an emphasis (`the **admin** credential`). Capturing greedily and trimming a
// trailing marker keeps both readings: the wrapper is dropped, an interior `**` is not.

/**
 * #2118: THE OUTPUT A DECLARED HAND-RUN ASSERTS SOMEBODY PRODUCED -- the text under this body's own
 * `Hand-run output` section, or `null` when there is none.
 *
 * WHICH OF #2118's TWO SHAPES THIS IS, AND WHY THE OTHER WAS REFUSED. The row offered a NAMED SECTION
 * whose body is non-empty, or the command's own output QUOTED VERBATIM AND MATCHED against the declared
 * command string. This is the first. The second is refused on its own terms rather than on cost: the only
 * half of it a machine here can check is the COMMAND STRING, because nothing in this job holds the
 * credential, so nothing here can re-run the command and compare its output to anything. Matching on that
 * string is a proxy that fails in BOTH directions -- it REFUSES a correct body whose paste wraps a
 * continuation-joined command across lines, or redacts a token out of it, and it PASSES a body that
 * pasted the command and no output at all. It would buy a false refusal and no additional truth: the
 * stronger-sounding name on the same check, which is the one thing #2118 said not to ship.
 *
 * SO THIS PROVES EXACTLY ONE THING: that a human wrote something under that heading. It cannot tell
 * whether the text is the declared command's output, and every message it produces says so in its own
 * words. Do not reword them into something that sounds like verification.
 *
 * EVERY HEADING, NEVER THE FIRST -- the explicit decision this file's own header comment demands of any
 * new section reader, and it lands on #527's side rather than #540's. A second `Acceptance:` is a
 * DUPLICATE because "which one do I run" is a real question with different answers; evidence has no such
 * question. Two pasted runs are two pasted runs, so reading every one of them guesses at nothing.
 */
export function handRunEvidence(body: string | null | undefined): string | null {
  const lines = String(body ?? "").split(/\r\n|\r|\n/);
  const collected = [];
  let inside = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const header = handRunOutputHeader(trimmed);
    if (header.matched) {
      inside = true;
      if (header.inline !== "") collected.push(header.inline);
      continue;
    }
    // #438's stop rule, unchanged: a section ends where the next one begins, whether that is a markdown
    // heading or another field's bare header.
    if (inside && (/^#{1,6}\s/.test(trimmed) || isSectionHeaderLine(trimmed))) inside = false;
    if (inside) collected.push(line);
  }
  const text = collected.join("\n");
  return pastedSomething(text) ? text.trim() : null;
}

// #2118: TWO SPELLINGS, for the reason #1036 recorded one level up -- an unrecognised spelling does not
// read as "no evidence was pasted", it reads as a refusal about something the author did not do, and they
// go looking for a fault that is not there. `## Hand-run output` is the shape the refusal names and the
// one every neighbouring section in a PR body uses; `**Hand-run output:**` is the bold/plain form this
// parser already accepts for every other field (`sectionHeaderPatterns`), and bodies here reach for it
// constantly.
const HAND_RUN_OUTPUT_HEADING = /^#{1,6}\s+Hand-run\s+output\b/i;
const HAND_RUN_OUTPUT_PLAIN = /^(?:\*\*|__)?Hand-run\s+output:(?:\*\*|__)?/i;

/**
 * #2118: is this line the evidence section's header, and does it carry evidence on its own line?
 *
 * A HEADING'S TRAILING TEXT IS A TITLE, NEVER CONTENT -- #506's rule, which this file paid for once
 * already on `## Acceptance — old read vs new`. `## Hand-run output (2026-09-23)` names the section; it
 * is not somebody's pasted run, and counting it would make the heading its own evidence. The plain form
 * has no such ambiguity: its colon is required to match at all, so anything after it was meant as content.
 */
function handRunOutputHeader(trimmed: string): { matched: boolean; inline: string; } {
  if (HAND_RUN_OUTPUT_HEADING.test(trimmed)) return { matched: true, inline: "" };
  const plain = HAND_RUN_OUTPUT_PLAIN.exec(trimmed);
  if (!plain) return { matched: false, inline: "" };
  return { matched: true, inline: trimmed.slice(plain[0].length).replace(/(?:\*\*|__)\s*$/, "").trim() };
}

/**
 * #2118: is there anything under the heading that a human actually typed there?
 *
 * FENCES AND HTML COMMENTS ARE NOT CONTENT. A heading followed by an empty ``` fence has pasted nothing,
 * and GitHub's own template convention hides its guidance in `<!-- ... -->` -- which every author leaves
 * in place. Counting either would make the heading the evidence for itself, which is the emptiest form of
 * the very shape this check exists to refuse.
 */
function pastedSomething(text: string): boolean {
  return text.replace(/<!--[\s\S]*?-->/g, "").split(/\r\n|\r|\n/)
    .some((line) => line.trim() !== "" && !line.trim().startsWith("```"));
}

/**
 * #2099: does this command need a GitHub credential to be anything but an error? PURE -- a function of
 * the command string alone, no closure walk and no file existence question (those are `deriveClosureRequirements`'s
 * and #2035's).
 *
 * THE FIRST REAL TOKEN, never a substring match. `\bgh\b` over the line would match `gh` inside a path,
 * a jq filter or a branch name -- #1860 is this repo's own record of that exact mistake costing a file
 * that refused itself for being named after the thing it fixed. A command that reaches `gh` DEEPER than
 * its first token (a script that spawns it) is already `SPAWNS_GH`'s question, answered by the closure
 * walk with the chain that found it.
 */
export function needsToken(command: string): boolean {
  const token = firstRealToken(command);
  return token !== undefined && token.replace(/^['"]|['"]$/g, "") === "gh";
}

/**
 * #2099: the `token` refusal for a command, or `null` when this job can honestly attempt it. Extracted
 * rather than inlined in `classifyCommand`, which sits AT the complexity gate -- a called function's
 * branches are not the caller's, the same reason `isHistoryDeclarationLine` exists next door.
 */
export function tokenRefusal(command: string, capabilities: JobCapabilities, section?: "ACCEPTANCE" | "REFUTATION"): Classification | null {
  if (capabilities.token || !needsToken(command)) return null;
  return { verdict: "refused", reason: noTokenReason(command, section) };
}

/**
 * #2099: the one wording for "this command needs a credential this job does not have".
 *
 * THE REMEDY IS SECTION-SPECIFIC BECAUSE THE DECLARATION IS. `Hand-run:` speaks for the Acceptance
 * commands alone (`handRunAcceptanceReason` reads `extractAcceptanceSection`), so offering it under
 * `Refutation:` would name a way out that does not work -- the author adds the line, the refutation line
 * is refused exactly as before, and #1116's rule is broken in the direction that teaches people the
 * declaration is decorative. The FACT is one string either way; only the sentence that says what to do
 * next differs.
 */
function noTokenReason(command: string, section?: "ACCEPTANCE" | "REFUTATION") {
  const remedy = section === "REFUTATION"
    ? "A `Hand-run:` declaration does NOT cover this line -- it speaks for the Acceptance commands only. "
      + "Paste the run's real output under an unparsed heading (#504), or move the line to `Acceptance:` "
      + "and declare it there"
    : "Run it by hand and declare it: a `Hand-run: <who runs it and why>` line in the body makes this "
      + "line report `NOT RUN` naming your reason, instead of dying on a missing credential";
  return `needs \`token\`, which this job does not have -- \`${firstRealToken(command)}\` authenticates `
    + "against GitHub, and the `acceptance` job is given no credential at all because it alone executes "
    + `commands taken from an untrusted PR body. ${remedy}`;
}

/**
 * What THIS acceptance job can offer a test that names a requirement (#510). `token`/`fleet` are fixed
 * facts about the job itself; `history` is the one thing a PR body can change. `docs/pipeline.md` states
 * this in prose (#511); this is the same fact read by code, never re-typed.
 */
export function jobCapabilities(body: string | null | undefined): JobCapabilities {
  // `corpus: false` unconditionally -- `runs/` is gitignored, so a GitHub-hosted runner never has one
  // (CLAUDE.md: "A GATE THAT READS runs/ IS NOT YOURS TO REPORT"), the identical structural fact `token`
  // and `fleet` already state for this job.
  return { history: hasFullHistoryDeclaration(body), token: false, fleet: false, corpus: false };
}

// The header convention `generate-commands-doc.mjs`'s `commandHeader` already uses for `// command:`,
// applied to a different question on a different population (a TEST FILE's own environment needs, not a
// SCRIPT's description). No line-count window here, unlike that one -- a script's header sits in its
// first few lines by convention, but this repo's own test files often carry long doc-comment headers
// (see `pre-push-resolve-toward-main.test.ts`), so the marker is found anywhere in the file rather than
// assuming how far down it landed.
const REQUIRES_HEADER = /^\/\/\s*requires:\s*(.+)$/m;

/**
 * A test file's own declared requirements, split on commas, UNFILTERED against any known vocabulary --
 * an unrecognised word (a typo, a future capability this job has not learned) must never be silently
 * dropped, because that would make a mistyped requirement read as "needs nothing," exactly the silent-pass
 * shape this row exists to end. `unmetRequirements` below is where an unknown word is judged, not here.
 */
export function testFileRequirements(text: string): string[] {
  const match = REQUIRES_HEADER.exec(text);
  if (!match) return [];
  return match[1].split(",").map((s) => s.trim()).filter(Boolean);
}

// #731: `runsRoot()` MEANS TWO DIFFERENT THINGS, and the closure walk below could only ask one question of
// it -- "does this file call `runsRoot()`" -- which reads BOTH as "needs the corpus". `git-fixture-cache.mjs`
// (#660) calls it to CHOOSE A LOCATION IT CREATES ITSELF (a cache it rebuilds on a miss); it never reads
// pre-existing evidence there. #718 merged that file, and #722 -- a PR that never touched it -- inherited a
// refusal for a chain it does not own, because the closure's `corpus` verdict is unconditional on the call
// alone.
//
// `// writes: runs/<subdir>` is the write-side counterpart to `// requires: <list>` above, and it is
// DECLARED, THEN VERIFIED, NEVER SUBSTITUTED FOR THE CLOSURE'S OWN ANSWER: a file naming this header still
// has its `runsRoot()` hit inspected exactly as before, and the declaration is trusted only when the same
// file's own text actually names the declared subdirectory AND contains a real write call there. A rule
// that skipped verification would let ANY file talking its way out of `corpus` by adding a comment; a rule
// that only widened the pattern (matching on "write-shaped" runsRoot calls generally) would still be asking
// the closure to guess intent from shape, the exact defect this row exists to end. So the file's own
// declaration is what decides -- and when a file claims a write path its own code does not actually use,
// that mismatch is named as A WRONG DECLARATION, a DIFFERENT and MORE SPECIFIC refusal than plain `corpus`,
// rather than the closure silently trusting or silently overriding it either way.
//
// #731, THE BUG FOUND WHILE FIXING THE BUG: a verified write-only hit that is merely SKIPPED (not
// recorded) lets the walk carry on into that file's OWN imports -- and `runsRoot()` is not only CALLED by
// a writer, it is also DEFINED, in `dataset-paths.mjs`, whose `export function runsRoot() {` line matches
// the identical call-shaped pattern as any real call. The first version of this fix skipped
// `git-fixture-cache.mjs`'s own verified hit and let the walk recurse into its imports as normal, which
// reached `dataset-paths.mjs` next and matched ITS definition line as a fresh, unexempted `corpus` hit --
// reproducing the exact refusal this row exists to end, one hop further down the identical chain. A regex
// for a call shape matching the definition of the function it looks for fails in the direction that looks
// like success: the exemption appears to work, and the walk quietly finds the same requirement one hop
// later. THE PROPERTY IS ABOUT THE CHAIN, NOT ABOUT A LINE -- so `deriveClosureRequirements`'s own
// `exemptCorpus` flag marks the WHOLE closure exempt once a verified write is found, rather than
// suppressing one file's occurrence and leaving the requirement free to be rediscovered downstream.
const WRITES_HEADER = /^\/\/\s*writes:\s*(\S+)\s*$/m;

/**
 *
 * @returns the declared path (e.g. `runs/git-fixture-cache`), or null if undeclared.
 */
function declaredWritePath(text: string): string | null {
  const match = WRITES_HEADER.exec(text);
  return match ? match[1] : null;
}

// A REAL write, not a path merely computed and never used. Deliberately narrow -- built to catch a WRONG
// declaration (a `// writes:` line naming a location this file's code does not actually touch), never to
// enumerate every way a file could write, so it only needs to recognise the shapes this repo's own
// runs/-writing code actually takes: `mkdirSync`/`writeFileSync` for a plain cache file, or a spawned `git
// bundle create` for `git-fixture-cache.mjs` itself.
const WRITE_CALL_PATTERN = /\b(?:mkdirSync|writeFileSync|createWriteStream)\s*\(|\bbundle\b[^)]*\bcreate\b/;

/**
 * Does `writesPath`'s claim actually hold of `codeOnly` -- the declared subdirectory is one this file's own
 * `runsRoot()`-based path construction names, AND the file genuinely writes there? Both must hold, or the
 * declaration is wrong rather than merely unverifiable: naming a real subdirectory this file never writes
 * to is exactly as wrong as naming one it does not even mention.
 */
function writeDeclarationHolds(codeOnly: string, writesPath: string) {
  const subdir = writesPath.replace(/^runs\//, "");
  return subdir.length > 0 && codeOnly.includes(subdir) && WRITE_CALL_PATTERN.test(codeOnly);
}

// #621: DERIVED, NOT DECLARED. `board-style.test.ts` reaches `gh` with no `// requires:` header at all --
// the fourth instance in two days of the identical shape #382 already named: "an opt-in declaration
// cannot catch the file whose author did not know there was something to declare, which is the whole
// population that matters." So this job's capability check no longer trusts the header alone; it walks
// the SAME local-import closure `gh-token-jobs.test.ts` already walks (`packages/guards/src/local-import-closure.ts`,
// shared rather than reimplemented -- see that module's header) and asks each file in it a factual
// question about what it DOES, never about what it merely mentions.
//
// KEYED ON THE OPERATION, NOT THE WORD -- AND THIS FILE IS ITS OWN COUNTEREXAMPLE. Every pattern below
// requires a real call/identifier shape, never a bare substring a comment could contain just as easily as
// a spawn -- and it was STILL wrong on its first run: this file's own comments, describing the patterns in
// prose, contain the literal identifiers `GH_TOKEN`, `RUNS_ROOT`/`A11Y_RUNS_ROOT` and
// `--is-shallow-repository`, so `acceptance-commands.test.ts` (which imports this file) derived `token`
// from ITS OWN closure walking back into the module that defines the check. `stripCommentsForMatching`
// below is the fix: patterns run against comment-stripped text, so describing an operation in prose can
// never again be mistaken for performing it. Caught by #419 form 4's own pre-existing test -- a file
// naming ITSELF as an Acceptance command must still run, and it stopped running the moment this landed.
// #621, SECOND-ORDER SELF-REFERENCE: `stripComments` alone is not enough for a pattern whose OWN REGEX
// LITERAL spells the exact identifier it searches for -- that text is real CODE, not a comment, so it
// survives stripping and matches itself every time this file is walked as part of its own test's closure.
// Measured live: `\bRUNS_ROOT|A11Y_RUNS_ROOT\b` and `--is-shallow-repository` both self-matched on THIS
// FILE after comment-stripping alone fixed the `GH_TOKEN`/`import { collect }` instances. `fingerprint`
// below builds each pattern from CONCATENATED fragments, so the searched-for substring never appears
// contiguously in this file's own source -- the file that defines "what counts as a real read" cannot
// itself read as one.
const fingerprint = (a: string, b: string): string => a + b;

/**
 * `typescript`, LOADED ONLY WHEN A CLOSURE IS ACTUALLY SCANNED -- and this is not a style choice.
 *
 * A STATIC import breaks two pre-install entries, and `pre-install-import-graph.test.ts` said so by name
 * rather than my assuming the CI ordering held everywhere: `arm-pr.ts` and `workflow-run-liveness.ts`
 * both reach this module for `extractClosesDeclaration` -- one function that touches none of this -- and
 * both run before `pnpm install`, where a package specifier dies with ERR_MODULE_NOT_FOUND. The acceptance job
 * itself runs after `pnpm install --ignore-scripts` and `pnpm run build`, so the parser is there when needed.
 *
 * AND WHEN IT IS NOT, THE FALLBACK OVER-CHARGES RATHER THAN UNDER-CHARGES: no parser means the old
 * full-text scan, which refuses more than it should. That is the safe direction for a guard whose other
 * failure would be a test running in CI with no corpus and reading `runs/`. #1340: the over-charge reached `pr:open` from a worktree with no
 * `node_modules` (the exact row #1327 closed was refused again) and read as a finding about the file, so a `corpus` hit found without a parser
 * carries `noParser` and `closureRequirementMessage` names the fallback and why there was no parser.
 *
 * `acorn` was the alternative and is deliberately not used: it resolves here only as another package's
 * transitive dependency, which would make this guard hostage to somebody else's tree.
 */
let typescriptResolution: TypescriptResolution | undefined = undefined;

function loadResolution(memo: ClosureMemo): TypescriptResolution {
  if (memo.parser !== undefined) return memo.parser;
  typescriptResolution ??= tryResolveTypescript();
  return typescriptResolution;
}

/**
 * #1636: WHAT AN IMPORT REACHES, NOT WHAT A MODULE'S IMPORT STATEMENTS NAME.
 *
 * #967 kept the bodies of the declarations an importer names, and the walk then followed EVERY import of that
 * module carrying every name it binds. So a test importing one pure function (`floorRows`, #1634) was charged
 * `corpus` because the same script imports `realCorpusRoot` for a `main()` the test never runs: the name was
 * bound at file level, not reached by anything that executes. Measured on #1634's branch at `485a86f2`:
 * `claim-excludes-recompute.test.ts` -> `calibrate-abstention.mjs` -> `dataset-paths.mjs:178`.
 *
 * So what is kept is what can RUN, grown to a fixpoint: the module's top level, the bodies of the declarations
 * the importer names, and any function those reach by name -- a kept body calling a local helper keeps the
 * helper, or a read two calls down would go uncharged. `referenced` is every identifier that kept code uses,
 * and the walk follows an import's names only where they appear in it.
 *
 * TWO THINGS DO NOT COUNT AS REACHING: an import or export declaration (it binds or lists a name and runs
 * nothing), and a top-level `if` on `import.meta.url` -- the entry guard this repo's scripts use, whose body
 * runs only when the file IS the entry, never on import.
 *
 * With no parser there is no reachability to read, so `referenced` is `null` and the walk follows every bound name -- the old
 * over-charge, the safe direction. The entry is the exception: see `entryScope`.
 *
 * PARSED, NOT BRACE-MATCHED. `typescript` is a declared devDependency and this script runs after `pnpm install`
 * in `reusable-acceptance.yml`, so the module's own statements come from `ts.createSourceFile`. A
 * hand-rolled brace matcher would have to survive template literals and regex literals containing braces,
 * and a wrong one fails in the direction that looks like success -- the #731 trap, one layer over.
 *
 * OFFSETS ARE PRESERVED: a body is replaced by spaces of the same length, keeping newlines, exactly as
 * `stripComments` does. So `lineNumberOf` still reports the real line of whatever survives.
 *
 * @param codeOnly the file's text, comments already stripped
 * @param fileName for the parser's diagnostics only
 * @param imported the names the importing file's reachable code uses from this module
 *
 * @param [memo] the parse is kept here, so a file reached from many entries is parsed once
 */
function reachableScope(codeOnly: string, fileName: string, imported: Set<string>, memo: ClosureMemo = createClosureMemo()): { scope: string; codeScope: string; referenced: Set<string> | null; } {
  const { typescript: ts } = loadResolution(memo);
  // no parser: scan everything, follow every name, and read string content as code too -- the safe direction (and named on the refusal, #1340)
  if (ts === null) return { scope: codeOnly, codeScope: codeOnly, referenced: null };
  const source = parsedSource(memo, ts, fileName, codeOnly);
  const kept = new Set(imported);
  for (let size = -1; size !== kept.size;) {
    size = kept.size;
    for (const name of referencedNames(ts, source, kept)) kept.add(name);
  }
  const scope = blankUnkept(ts, source, codeOnly, kept);
  return { scope, codeScope: blankStringContent(ts, source, scope), referenced: referencedNames(ts, source, kept) };
}

/**
 * The ENTRY's scope: the entry is scanned whole, as #967 decided, so its `referenced` is every identifier in it. Without a
 * parser there is nothing to read, and the answer is the same as {@link reachableScope}'s.
 */
function entryScope(codeOnly: string, fileName: string, memo: ClosureMemo): { scope: string; codeScope: string; referenced: Set<string> | null; } {
  const { typescript: ts } = loadResolution(memo);
  if (ts === null) return { scope: codeOnly, codeScope: codeOnly, referenced: null };
  const source = parsedSource(memo, ts, fileName, codeOnly);
  return { scope: codeOnly, codeScope: blankStringContent(ts, source, codeOnly), referenced: referencedNames(ts, source, null) };
}

/**
 * The text with the CONTENT of every string literal and template literal blanked: quotes, delimiters and newlines are kept, so
 * offsets and `lineNumberOf` still hold. #1327: a call-shaped pattern matched on this copy, so a sentence that names `runsRoot()`
 * inside a string is not charged as a read. A `${ ... }` substitution is code, not content, and stays as it was.
 */
function blankStringContent(ts: typeof import("typescript"), source: import("typescript").SourceFile, text: string): string {
  const spans: [number, number][] = [];
  const visit = (node: import("typescript").Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) spans.push([node.getStart(source) + 1, node.getEnd() - 1]);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) spans.push([node.getStart(source) + 1, node.getEnd() - 2]);
    else if (ts.isTemplateTail(node)) spans.push([node.getStart(source) + 1, node.getEnd() - 1]);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  let out = "";
  let from = 0;
  for (const [start, end] of spans) {
    out += text.slice(from, start) + text.slice(start, end).replace(/[^\n]/g, " ");
    from = end;
  }
  return out + text.slice(from);
}

/**
 * Every identifier the code that can run uses -- skipping import and export declarations, and, when `kept` is
 * given, a top-level function declaration nobody reaches and the entry guard. `kept === null` is the entry: all
 * of it runs.
 */
function referencedNames(ts: typeof import("typescript"), source: import("typescript").SourceFile, kept: Set<string> | null): Set<string> {
  const names: Set<string> = new Set();
  for (const { identifiers, isGuard, functionName, isFunction } of topLevelStatements(ts, source)) {
    if (kept !== null && isGuard) continue;
    if (kept !== null && isFunction && !(functionName !== null && kept.has(functionName))) continue;
    for (const identifier of identifiers) names.add(identifier);
  }
  return names;
}

export type StatementFacts = { identifiers: string[], isGuard: boolean, functionName: string | null, isFunction: boolean };
/**
 * (#3549) What `referencedNames` needs of each top-level statement, read off the tree ONCE per parse: `reachableScope` asks it again for every step of
 * its fixpoint, for every set of names an importer reaches, and re-walking the whole tree each time was the largest cost left in the scan. Keyed on
 * the parsed source itself, so a changed file (a new parse) can never read an old answer. Import and export declarations are not statements here:
 * they bind or list a name and run nothing.
 */
const statementFacts: WeakMap<import("typescript").SourceFile, StatementFacts[]> = new WeakMap();

function topLevelStatements(ts: typeof import("typescript"), source: import("typescript").SourceFile) {
  const held = statementFacts.get(source);
  if (held !== undefined) return held;
  const facts: StatementFacts[] = [];
  ts.forEachChild(source, (statement) => {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) return;
    const identifiers: string[] = [];
    const collect = (node: import("typescript").Node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      if (ts.isIdentifier(node)) identifiers.push(node.text);
      ts.forEachChild(node, collect);
    };
    collect(statement);
    const isFunction = ts.isFunctionDeclaration(statement);
    facts.push({
      identifiers, isGuard: isEntryGuard(ts, statement, source), isFunction,
      functionName: isFunction && statement.name ? statement.name.text : null,
    });
  });
  statementFacts.set(source, facts);
  return facts;
}

/**
 * A top-level `if` whose condition reads `import.meta.url` -- `if (import.meta.url === pathToFileURL(...).href)
 * main();` -- runs its body only when the module is the entry, so nothing in it is reached by an import.
 */
function isEntryGuard(ts: typeof import("typescript"), node: import("typescript").Node, source: import("typescript").SourceFile) {
  return ts.isIfStatement(node) && node.expression.getText(source).includes("import.meta.url");
}

/**
 * The module's text with every body `kept` does not reach blanked -- #967's rule, now keyed on reachability.
 */
function blankUnkept(ts: typeof import("typescript"), source: import("typescript").SourceFile, codeOnly: string, kept: Set<string>): string {
  const bodies: [number, number][] = [];
  const visit = (node: import("typescript").Node) => {
    const body = (node as { body?: import("typescript").Node }).body;
    // A DECLARATION IS BLANKED WHOLE, SIGNATURE INCLUDED. `export function runsRoot() {` is top-level text
    // and matches a call-shaped pattern exactly as a real call does -- measured: blanking bodies alone left
    // the constant-only import charged at `dataset-paths.mjs:93`, the definition line. Nothing in a function
    // declaration executes at import beyond binding the name, so none of it belongs in this scan.
    if (body && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
      || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node)
      || ts.isSetAccessorDeclaration(node))) {
      // KEPT when something that runs reaches it by name (#1636): the importer's names, and what those reach.
      const reached = ts.isFunctionDeclaration(node) && node.name && kept.has(node.name.text);
      if (!reached) bodies.push([node.getStart(source), node.getEnd()]);
      return;
    }
    // An expression's BODY only: what surrounds it may be top-level code that really does run, as in
    // `const root = runsRoot();` or `export const x = (() => runsRoot())();`.
    if (body && (ts.isFunctionExpression(node) || ts.isArrowFunction(node))) {
      bodies.push([body.getStart(source), body.getEnd()]);
      return; // a nested function inside a blanked body needs no separate blanking
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  // Sliced, not spread into a character array (#3549): this runs once per file per set of names reached, and the spread of a whole module was the
  // largest single cost left in the scan. A body is blanked to spaces with its newlines kept, as before.
  let out = "";
  let from = 0;
  for (const [start, end] of bodies) {
    out += codeOnly.slice(from, start) + codeOnly.slice(start, end).replace(/[^\n]+/g, (run) => " ".repeat(run.length));
    from = end;
  }
  return out + codeOnly.slice(from);
}

/**
 * The spawns the `token` charge below recognises by a string `gh` target. #1140's no-token check reads the same
 * list plus the two spellings a DECLARATION must also answer for, so the charged set can never grow past it.
 */
const CHARGED_SPAWNS = ["execFileSync", "execSync", "execFile", "spawnSync", "spawn", "run"];
const DECLARED_SPAWNS = [...CHARGED_SPAWNS, "npmCliInvocation"];

/**
 * #1449: A `gh` SPAWN, NOT THE TWO LETTERS -- one of `CHARGED_SPAWNS` with `gh` as its whole quoted first argument.
 * The ONE copy: the token charge below uses it, and `gh-token-jobs.test.ts` imports it, so the spawns that make a
 * test need a token and the spawns that make a CI job need GH_TOKEN cannot drift apart. `execFile` joined it on #1449;
 * `npmCliInvocation` did not, because it runs only npm's own CLIs (`npm-cli-executable.ts`), never `gh`.
 */
export const SPAWNS_GH = new RegExp(`(?:${CHARGED_SPAWNS.join("|")})\\s*\\(\\s*(['"\`])gh\\1`);

const CLOSURE_REQUIREMENT_PATTERNS =
  ([
    // A `gh` invocation (`SPAWNS_GH` above, the one copy gh-token-jobs.test.ts imports) or a direct read
    // of the token itself -- either means the file's operation needs a real GH_TOKEN to behave honestly.
    [SPAWNS_GH, "token"],
    [new RegExp(`\\b${fingerprint("GH_TO", "KEN")}\\b`), "token"],
    // `runsRoot()` (packages/lab/src/dataset-paths.mjs) is the ONE function this repo reads `runs/`
    // through; its two documented override env vars are the ONE other door. Reading `runs/` any other way
    // would be a second, undocumented door CLAUDE.md's own corpus rule does not know about.
    // #1327: the call is matched in CODE, never in string content: a sentence that names `runsRoot()` reads nothing. The env-var
    // spellings are NOT given that treatment -- `process.env["A11Y_RUNS_ROOT"]` is a real read spelled as a string.
    [/\brunsRoot\s*\(/, "corpus", "code"],
    [new RegExp(`\\b(?:${fingerprint("RUNS_R", "OOT")}|${fingerprint("A11Y_RUNS_R", "OOT")})\\b`), "corpus"],
    // The shallow-checkout question this repo's own idiom asks (pre-push-resolve-toward-main.test.ts,
    // pre-push-stale-base.test.ts) -- a file asking it needs a real answer, which only a full-history
    // checkout can honestly give it.
    [new RegExp(fingerprint("--is-shallow-repo", "sitory") + "\\b"), "history"],
  ] as [RegExp, "token" | "corpus" | "history", "code"?][]);

// #827: THE MIRROR OF `// writes:`, ON THE TEST FILE RATHER THAN THE FILE THAT CALLS THE RISKY FUNCTION --
// `board-markdown.test.ts` and `board-achievement-retirement.test.ts` each import only `document` from
// `board-document.ts`, render it from a literal fixture object, and pass 5/5 and 7/7 with `gh` stubbed to
// exit 4 on every call. Neither calls `todaysReleaseExists` (`board-document.ts`'s own `gh release view`
// spawn, line ~1190) -- but the walk scans the WHOLE FILE'S text for every requirement pattern, not the
// one export a caller actually imports, so any test reaching `board-document.ts` at all is charged for
// EVERY spawn anywhere in it, including ones its own import never uses.
//
// `// writes:` sits where the RISKY CALL lives (git-fixture-cache.mjs calls `runsRoot()` itself, so its own
// declaration is checked right there, mid-walk). `token`'s risky call lives in an IMPORTED file the test
// does not control, so the declaration cannot live beside the call the same way -- it has to live on the
// file that actually knows which of its own imports it exercises: the entry itself. So `// no-token: <fn>`
// is checked ONCE, against `entry`'s own text, before the walk begins, rather than incrementally at each
// file the way `// writes:` is -- the shape differs because WHERE the two declarations can honestly live
// differs, not because the discipline does: declared, then verified, never substituted, exactly as #731's
// own rule states it. A file naming a function it does not itself call is judged wrong the same way a file
// naming a subdirectory it does not itself write to is -- a DIFFERENT, MORE SPECIFIC refusal than plain
// `token`, never a silent pass and never a silent override.
//
// #1465: A `// no-token:` LINE IS READ, OR REFUSED -- NEVER SILENTLY IGNORED. The declaration was one regex whose
// name had to end the line, applied once: `// no-token: gh -- every command here is git` was not a declaration,
// and a file's SECOND header line (enumeration-completeness.test.ts, queue-table.test.ts) was never read. Both
// were harmless where they stood and neither said so, so the next file written that way would have been refused
// with the remedy "declare `// no-token:`", which its author would read as done. Now every line that starts like
// a declaration (`NO_TOKEN_CANDIDATE`, any case, any indent) must match `NO_TOKEN_DECLARATION` -- the name, then
// optionally ` -- <reason>` -- or it is refused at its own line; and every declaration read must hold.
const NO_TOKEN_CANDIDATE = /^[ \t]*\/\/[ \t]*no-token\b/i;
const NO_TOKEN_DECLARATION = /^\/\/[ \t]*no-token:[ \t]*(\S+)(?:[ \t]+--[ \t].*)?[ \t]*$/;

/**
 * Every line of `text` that starts like a `// no-token:` declaration, with the name it declares -- `fn: null`
 * when the line cannot be read as one.
 */
function noTokenHeaders(text: string): { line: number; fn: string | null; }[] {
  return text.split("\n").flatMap((raw, i) => {
    if (!NO_TOKEN_CANDIDATE.test(raw)) return [];
    const match = NO_TOKEN_DECLARATION.exec(raw.replace(/\r$/, ""));
    return [{ line: i + 1, fn: match ? match[1] : null }];
  });
}

/**
 * Does `entry`'s own code genuinely never call the function it claims not to need -- a real call SHAPE
 * (`calleeName(`), never a bare mention a comment or a string could contain just as easily. Shallow, exactly
 * as `writeDeclarationHolds` is shallow: this proves the declaring file's OWN text does not call it, not
 * that nothing it calls calls it in turn -- the same scope #731's own write-side check keeps.
 *
 * #1140: A DECLARED COMMAND IS USED BY BEING SPAWNED, NOT CALLED. `// no-token: gh` over
 * `execFileSync("gh", [...])` held, because that text contains no `gh(` -- the declaration went false in
 * substance while its check kept passing. So the name as the WHOLE quoted first argument of a spawn is a use
 * too. It stays a SHAPE, never a mention: `gh` in prose, in an identifier, or as a later argument to a spawn
 * of another command still holds.
 */
function noTokenDeclarationHolds(entryCodeOnly: string, calleeName: string) {
  const called = new RegExp(`\\b${calleeName}\\s*\\(`).test(entryCodeOnly);
  const spawned = new RegExp(`\\b(?:${DECLARED_SPAWNS.join("|")})\\s*\\(\\s*(['"\`])${calleeName}\\1`).test(entryCodeOnly);
  return !called && !spawned;
}

/**
 * Where in `text` a 1-indexed line number sits for a given match index.
 */
function lineNumberOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

export type ClosureHit = { requirement: "token" | "corpus" | "history", file: string, line: number, chain: string[], wrongDeclaration?: boolean, malformedDeclaration?: boolean,
  /** #1340: set on a `corpus` hit found by the fallback full-text scan: why there was no parser. The hit may be a sentence in a string, not a read. */
  noParser?: string };

/**
 * #1636: the names of `bound` that reachable code actually uses -- or every bound name when there was no parser to say (`referenced === null`),
 * which over-charges.
 */
function keepReferenced(bound: string[], referenced: Set<string> | null): Set<string> {
  return new Set(referenced === null ? bound : bound.filter((name) => referenced.has(name)));
}

/**
 * `visited` is every file each entry's walk read: an entry's answer can only change if one of those did, which is what lets a caller reuse it.
 */
export type ClosureMemo = { sources: Map<string, { text: string, codeOnly: string }>, parsed: Map<string, import("typescript").SourceFile>, scopes: Map<string, { scope: string, codeScope: string, referenced: Set<string> | null, matches: Map<number, RegExpExecArray | null> }>, edges: Map<string, { target: string, names: Set<string> }[]>, visited: Map<string, Set<string>>,
  /** #1340: the parser answer to use instead of resolving `typescript` from this process's cwd and the tool's tree. A caller that knows it has none says so here. */
  parser?: TypescriptResolution };
/**
 * (#3549) WHAT ONE SCAN OF MANY ENTRIES SHARES. `deriveClosureRequirements` over a whole directory of tests walks the SAME modules once per entry, and
 * each visit read the file, stripped its comments, parsed it and blanked its bodies again: measured at 182 CPU-s for one pass over 190 files, nearly
 * all of it re-doing work on text it had already seen. A memo holds those results per FILE, for as long as the caller says the tree is not changing.
 *
 * IT IS PASSED, NEVER GLOBAL, and that is the whole safety argument: `acceptance-commands.test.ts` rewrites a fixture at the same path and asks
 * again, so a module-level cache would answer for the old text. A caller that omits it gets a fresh memo per call, which is what it always had.
 * `scopes` and `matches` are keyed by what decides them (the file, the names reached in it, whether it is the entry), not by the entry that asked.
 */
export function createClosureMemo({ parser }: { parser?: TypescriptResolution; } = {}): ClosureMemo {
  return { sources: new Map(), parsed: new Map(), scopes: new Map(), edges: new Map(), visited: new Map(), ...(parser === undefined ? {} : { parser }) };
}

function sourceOf(memo: ClosureMemo, file: string): { text: string; codeOnly: string; } {
  let held = memo.sources.get(file);
  if (held === undefined) {
    const text = readFileSync(file, "utf8");
    held = { text, codeOnly: stripComments(text) };
    memo.sources.set(file, held);
  }
  return held;
}

function parsedSource(memo: ClosureMemo, ts: typeof import("typescript"), file: string, codeOnly: string) {
  let source = memo.parsed.get(file);
  if (source === undefined) {
    source = ts.createSourceFile(file, codeOnly, ts.ScriptTarget.Latest, false); // no parent pointers: nothing here walks upward
    memo.parsed.set(file, source);
  }
  return source;
}

/**
 * `reachableScope` for one visit, kept by what decides it: the file, the names reached in it, and whether it is the entry. Two entries that reach the
 * same module by the same names read one answer, and that sharing is the whole saving.
 */
function scopeFor(memo: ClosureMemo, { file, codeOnly, names, isEntry }: { file: string; codeOnly: string; names: Set<string>; isEntry: boolean; }) {
  const key = `${isEntry ? "entry" : "module"}\0${file}\0${[...names].sort().join(",")}`;
  let held = memo.scopes.get(key);
  if (held === undefined) {
    held = { ...(isEntry ? entryScope(codeOnly, file, memo) : reachableScope(codeOnly, file, names, memo)), matches: new Map() };
    memo.scopes.set(key, held);
  }
  return held;
}

/**
 * `pattern` over `text`, answered once per scope: the patterns carry no `g` flag, so a match is a pure function of the text.
 */
function matchOf({ matches }: { matches: Map<number, RegExpExecArray | null>; }, { index, pattern, text }: { index: number; pattern: RegExp; text: string; }) {
  if (!matches.has(index)) matches.set(index, pattern.exec(text));
  return matches.get(index);
}

/**
 * Every file `file` imports that the closure walk follows, with the names it reaches in each: the relative imports, and (#3103) the tool's own
 * `agent-org/src/...` ones, which a project reaches it through and `localImports` cannot see.
 */
function closureEdges(file: string, referenced: Set<string> | null, memo: ClosureMemo = createClosureMemo()): { target: string; names: Set<string>; }[] {
  let bound = memo.edges.get(file);
  if (bound === undefined) {
    // What each import BINDS depends on the file alone; which of those names are reached depends on who asked, so only the first is kept.
    bound = [
      ...localImports(file).map((target) => ({ target, names: new Set(importedNamesFor(file, target)) })),
      ...toolImports(file).map(({ target, names }) => ({ target, names: new Set(names) })),
    ];
    memo.edges.set(file, bound);
  }
  return bound.map(({ target, names }) => ({ target, names: keepReferenced([...names], referenced) }));
}

/**
 * Is `path` a FILE -- the question every closure read asks, where `existsSync` answered a different one.
 * A directory exists, so `existsSync(dir)` is true and `readFileSync(dir)` throws `EISDIR` (#3026): a
 * directory is "no entry to walk", exactly as a missing path is, never a file to read and never an error to
 * swallow. `throwIfNoEntry: false` so a missing path answers false rather than throwing `ENOENT`.
 */
export function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

/**
 * Every requirement reachable from `entry`'s local-import closure, each named by the FIRST file (in walk
 * order) that proves it, the line it was found on, and the full chain of files from `entry` down to it --
 * #621's own stated acceptance is naming the HOP, not just the capability: "this test needs a token" sends
 * a reader to the test; naming the module that spawns `gh` sends them to the cause.
 *
 * #731: A `corpus` HIT IS CHECKED AGAINST THAT SAME FILE'S OWN `// writes:` DECLARATION before being
 * recorded -- a file whose `runsRoot()` call is verified as choosing a location it creates itself is not
 * corpus-dependent at all, and is skipped rather than recorded. A file that DECLARES `// writes:` but whose
 * own text does not bear it out is still recorded as `corpus`, flagged `wrongDeclaration: true` -- named as
 * a bad declaration, never silently trusted and never silently overridden.
 *
 * #827: `token`'s mirror, checked once against `entry` itself before the walk begins -- see `NO_TOKEN_DECLARATION`'s
 * own header for why the declaration cannot live beside the risky call the way `// writes:` does.
 * @param entry absolute path to the entry file
 * @param [memo] (#3549) shared across entries by a caller scanning a tree that is not changing under it; see `createClosureMemo`
 */
export function deriveClosureRequirements(entry: string, memo: ClosureMemo = createClosureMemo()): ClosureHit[] {
  const found: Map<string, ClosureHit> = new Map();
  // A VERIFIED WRITE-ONLY `corpus` HIT MARKS THE WHOLE CLOSURE EXEMPT, not just this one file's own match.
  // `runsRoot()` is not only called by a writer -- it is also DEFINED, in dataset-paths.mjs, and that
  // definition's `export function runsRoot() {` line matches the identical "call-shaped" pattern as any
  // real call. Skipping a verified hit without recording anything left the requirement "not yet found," so
  // the walk carried on into git-fixture-cache.mjs's own imports, reached dataset-paths.mjs, and matched
  // its definition site as a fresh, unexempted `corpus` hit -- reproducing the exact refusal this fix
  // exists to remove, one hop further down the same chain. `exemptCorpus` records that the closure has
  // already answered "corpus" honestly and nothing further in this walk may reopen it.
  let exemptCorpus = false;
  // #827: the `token` counterpart, decided ONCE before the walk starts (see `NO_TOKEN_DECLARATION`'s header for
  // why token's declaration is checked at the entry rather than incrementally like `// writes:` is).
  let exemptToken = false;
  if (isFile(entry)) {
    const entryText = readFileSync(entry, "utf8");
    const entryCodeOnly = stripComments(entryText);
    const headers = noTokenHeaders(entryText);
    const unreadable = headers.find((h) => h.fn === null);
    const wrong = headers.find((h) => h.fn !== null && !noTokenDeclarationHolds(entryCodeOnly, h.fn));
    if (unreadable) {
      found.set("token", { requirement: "token", file: entry, line: unreadable.line, chain: [entry], malformedDeclaration: true });
    } else if (wrong) {
      found.set("token", { requirement: "token", file: entry, line: wrong.line, chain: [entry], wrongDeclaration: true });
    } else if (headers.length > 0) {
      exemptToken = true;
    }
  }
  /**
   * One match, classified and recorded -- extracted from the walk so that loop stays readable (#967: it
   * crossed the complexity budget when the top-level scope was added, which is the budget doing its job).
   * A `corpus` hit is checked against the file's own `// writes:` declaration first: verified, it exempts
   * the WHOLE closure (#731); claimed but not borne out, it is recorded as a wrong declaration rather than
   * silently trusted or silently overridden.
   */
  const recordHit = ({ requirement, file, text, codeOnly, match, chain }: {
          requirement: "token" | "corpus" | "history"; file: string; text: string; codeOnly: string;
          match: RegExpExecArray; chain: string[];
      }) => {
    const hit = { requirement, file, line: lineNumberOf(text, match.index), chain };
    if (requirement !== "corpus") { found.set(requirement, hit); return; }
    const writesPath = declaredWritePath(text);
    // #1340: only a corpus hit depends on the parser (it decides what string content and unreached bodies count); `token` and `history` read the text whole
    const { rejected } = loadResolution(memo);
    if (writesPath === null) { found.set(requirement, rejected === null ? hit : { ...hit, noParser: rejected }); return; }
    if (writeDeclarationHolds(codeOnly, writesPath)) { exemptCorpus = true; return; }
    found.set(requirement, { ...hit, wrongDeclaration: true });
  };
  // #1636: `seen` maps a file to the names already scanned for it. A second edge bringing a name the first did not
  // is scanned again with the union, so the order imports are met in can never hide a reachable body.
  const walk = (file: string, chain: string[], seen: Map<string, Set<string>>, names: Set<string>) => {
    const prior = seen.get(file);
    if ((prior && [...names].every((name) => prior.has(name))) || !isFile(file)) return;
    const union = new Set([...(prior ?? []), ...names]);
    seen.set(file, union);
    const { text, codeOnly } = sourceOf(memo, file);
    // #967: THE ENTRY IS SCANNED WHOLE; AN IMPORTED MODULE ONLY AT ITS TOP LEVEL.
    //
    // The two are different questions and conflating them is the defect. The ENTRY is the command about to
    // run: its own `runsRoot()` call sits inside a `test(...)` callback, the runner invokes it, and it
    // genuinely needs the corpus -- so the whole file counts, and `dataset-paths.test.ts:149` and
    // `lab-fetch-paths.test.ts:66` are still refused, measured. An IMPORTED module is only executed as far
    // as its top level, so charging it for what its function bodies would do if called is charging the
    // import for the call. That is what made three pull requests move code into new modules.
    //
    // CORPUS ONLY, deliberately. `token` has the identical over-charge and `// no-token:` (#827) is the
    // declaration written to work around it -- two of them were added tonight. Widening this to `token`
    // would make those declarations no-ops and change two merged pull requests' behaviour, which is a
    // second row, not a quiet extra in this one.
    const reach = scopeFor(memo, { file, codeOnly, names: union, isEntry: file === entry });
    const hereChain = [...chain, file];
    CLOSURE_REQUIREMENT_PATTERNS.forEach(([pattern, requirement, subject], index) => {
      if (found.has(requirement) || (requirement === "corpus" && exemptCorpus)
        || (requirement === "token" && exemptToken)) return;
      const matchedText = requirement !== "corpus" ? codeOnly : subject === "code" ? reach.codeScope : reach.scope;
      const match = matchOf(reach, { index, pattern, text: matchedText });
      if (match) recordHit({ requirement, file, text, codeOnly, match, chain: hereChain });
    });
    for (const { target, names: edgeNames } of closureEdges(file, reach.referenced, memo)) walk(target, hereChain, seen, edgeNames);
  };
  const seen = new Map();
  walk(entry, [], seen, new Set());
  memo.visited.set(entry, new Set(seen.keys()));
  return [...found.values()];
}

/**
 * The human-facing form of a `ClosureHit` -- `"board-style.test.ts requires token via collect →
 * board-data.ts:72"` for a one-hop chain, matching #621's own worked example verbatim. A direct hit (the
 * entry file itself matches, zero hops) reads as `"<entry> requires <req>, at <entry>:<line>"`.
 *
 * #731: A `wrongDeclaration` HIT SAYS SO, naming the file's OWN claim as the thing that failed -- a reader
 * fixing a plain `corpus` refusal edits the test; a reader fixing a wrong `// writes:` (or, #827, `// no-
 * token:`) edits the comment that no longer describes what the file does, a different fix at a different
 * spot.
 */
export function closureRequirementMessage(hit: ClosureHit): string {
  const { requirement, file, line, chain, wrongDeclaration, malformedDeclaration, noParser } = hit;
  const entryLabel = basename(chain[0]);
  const fileLabel = basename(file);
  const suffix = malformedDeclaration
    ? ` -- ${fileLabel}:${line} is not a \`// no-token:\` declaration: the name must end the line, or be followed by `
      + "\" -- <reason>\"; refusing rather than ignoring it"
    : !wrongDeclaration ? noParserNote(noParser) : requirement === "token"
    ? ` -- ${fileLabel} declares \`// no-token:\` a function its own code DOES call or spawn; refusing rather than `
      + "trusting an unverified claim"
    : ` -- ${fileLabel} declares \`// writes:\` a path its own code does not bear out; refusing rather `
      + "than trusting an unverified claim";
  if (chain.length <= 1) return `${entryLabel} requires ${requirement}, at ${fileLabel}:${line}${suffix}`;
  const hops = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const names = importedNamesFor(chain[i], chain[i + 1]);
    hops.push(names[0] ?? basename(chain[i + 1]));
  }
  return `${entryLabel} requires ${requirement} via ${hops.join(" → ")} → ${fileLabel}:${line}${suffix}`
    + noTokenRemedy(hit, hops);
}

/**
 * #1340: A REFUSAL THAT CAME FROM THE FALLBACK NAMES THE FALLBACK. With no parser the scan reads a sentence naming the resolver call in a string, or in a function
 * nothing reaches, as a corpus read: the refusal then says something about the scan and nothing certain about the file, and `needs corpus` alone reads
 * as the second. `rejected` is the resolver's own account of each place it looked.
 */
function noParserNote(rejected: string | undefined): string {
  if (rejected === undefined) return "";
  return " -- found by the FALLBACK full-text scan, because no TypeScript parser could be loaded: a call to the corpus resolver named in a string or in an unreached "
    + "function is charged as a read here, so this may not be a finding about this file. Make `typescript` resolvable and run it again. "
    + rejected;
}

/**
 * #1116: NAME THE REMEDY, NOT ONLY THE FAULT.
 *
 * The refusal named the chain and never named the way out, so an author learned `// no-token:` existed
 * only by MISUSING it -- the `wrongDeclaration` branch above is the single place this file mentions it.
 * Measured on #1009: the author (me) spent the fix moving assertions between files, and the declaration
 * that would have answered it was four hundred lines from the message that refused them.
 *
 * **A guard message must be followable**, and this one told you what was wrong without telling you what
 * to do about it.
 *
 * OFFERED ONLY WHEN IT WOULD ACTUALLY HOLD. The suggestion is checked with `noTokenDeclarationHolds`
 * against the entry's own comment-stripped code before it is made, so a file that really does call the
 * function is never told to declare that it does not. **Advice a reader cannot follow is worse than
 * none** -- it is the shape #1059 was filed about, where `doctor`'s `next:` line sent a reader to a
 * script that had just refused them.
 *
 * THE MECHANICAL PRECONDITION IS NOT THE DISCRIMINATING ONE -- worker-judge reviewing #1132, and #1009
 * is the counter-example with an author attached. There every input WAS injected and `gh` never
 * executed, so the first half of this sentence was satisfied and the declaration would still have been
 * wrong: those assertions go through `mergeReadiness` **because that is what makes them consumer
 * assertions**. Same mechanical facts as a pure-function test, opposite answer.
 *
 * So the message asks the question a checker cannot: **is reaching the tool part of what this file
 * tests?** A remedy offered without its exception is how a verified-true flag gets taken by an author
 * under a red CI -- the failure mode of advice rather than of checkers.
 *
 * TOKEN ONLY. `// writes:` is checked incrementally per file rather than once at the entry, so the same
 * sentence would be wrong about where it goes; naming one remedy correctly beats naming two loosely.
 */
function noTokenRemedy(hit: { requirement: string; chain: string[]; wrongDeclaration?: boolean; malformedDeclaration?: boolean; }, hops: string[]): string {
  if (hit.requirement !== "token" || hit.wrongDeclaration || hit.malformedDeclaration) return "";
  const fn = hops[hops.length - 1];
  const entry = hit.chain[0];
  if (!fn || !isFile(entry)) return "";
  const text = readFileSync(entry, "utf8");
  if (noTokenHeaders(text).length > 0) return "";
  if (!noTokenDeclarationHolds(stripComments(text), fn)) return "";
  return `. This file never calls \`${fn}\` itself, so if every input it passes is injected AND reaching `
    + `\`${fn}\` is not part of what this file tests, it may declare \`// no-token: ${fn}\` on its first `
    + "line -- #827's mechanism, verified against this file's own code rather than trusted. A CONSUMER "
    + `assertion reaches \`${fn}\` ON PURPOSE, and declaring otherwise makes it a unit test wearing a `
    + "consumer test's name";
}

/**
 * Which of `entry`'s closure-derived requirements this job's `capabilities` do NOT satisfy, each with the
 * human-facing chain message -- the derived counterpart to `unmetRequirements`, which only ever sees what
 * a header DECLARED.
 */
export function unmetClosureRequirements(entry: string, capabilities: JobCapabilities): { requirement: string; message: string; }[] {
  return deriveClosureRequirements(entry)
    .filter((hit) => (capabilities as Record<string, boolean>)[hit.requirement] !== true)
    .map((hit) => ({ requirement: hit.requirement, message: closureRequirementMessage(hit) }));
}

/**
 * Which of `requirements` this job's `capabilities` do NOT satisfy -- named, not counted, because "needs
 * history" and "needs a token" send an author to opposite fixes (#510's own acceptance). A requirement
 * word `capabilities` has no key for reads as unmet, never as satisfied by default.
 */
export function unmetRequirements(requirements: string[], capabilities: JobCapabilities): string[] {
  return requirements.filter((req) => (capabilities as Record<string, boolean>)[req] !== true);
}

/**
 * THE `package.json` SCRIPT NAMES THAT RUN A WHOLE SUITE, longest-first so the alternation below matches
 * `test:all` rather than `test` and then failing its own lookahead.
 *
 * A LITERAL LIST, PINNED AGAINST `package.json` BY `acceptance-commands.test.ts` rather than derived from
 * it: the scripts file also carries `test:python` (a pytest tree, not this population), `test:changed`
 * (no fixed glob) and `test:nightly` (a different tree), so "every script starting with test" is the
 * wrong set and deriving it would quietly widen with the next script anybody adds. The list is the
 * decision; the pin is what stops it drifting from the scripts it names.
 */
export const SUITE_SCRIPTS = ["test:ts", "test:org", "test:all", "test"];

// `(?![:\w-])` AND NOT `\b`: `\b` after `test` matches `pnpm run test:python`, whose population is the
// pytest tree rather than the `.test.ts` glob this function's callers walk. Refusing that command for a
// requirement declared by a TypeScript file would be a refusal about a population it never runs.
// `g` AND `matchAll` ONLY, NEVER `exec`/`test` (#2207): a chained command names more than one script,
// and a global regex driven by `exec` carries `lastIndex` between calls, so the second caller would start
// reading in the middle of a different command. `matchAll` works on a copy and leaves this one alone.
export const SUITE_COMMAND = new RegExp(
  `(?:^|&&|\\|\\||;)\\s*p?npm\\s+(?:run\\s+)?(${SUITE_SCRIPTS.join("|")})(?![:\\w-])`, "g");

// #3026: `cd <dir> &&` AT THE START OF A COMMAND -- the one shape the org's own rows use to run a test from
// another checkout (#2907). Its directory is an argument to `cd`, never to the runner.
export const LEADING_CD = /^\s*cd\s+(?:"([^"]*)"|'([^']*)'|([^\s&;|]+))\s*&&\s*/;

/**
 * `command` without a leading `cd <dir> &&`. Before #3026 the `tsx --test` arm took EVERY non-flag token, so
 * the `cd` target was read as a test file, and a directory that exists reached `readFileSync` (`EISDIR`).
 */
export function stripLeadingCd(command: string): string {
  return command.replace(LEADING_CD, "");
}

// The full set of field names this parser recognises as SECTION HEADERS -- shared between the header
// pattern (where a section starts) and the stop pattern (where it ends), so the two can never disagree
// about what a header looks like. #438 added "Refutation" here rather than inventing a second parser: a
// bare `Refutation:` line has to end an in-progress `Acceptance:` block exactly the way `Mutation:`
// already did, or the refutation commands would be silently swallowed as more acceptance commands.
const SECTION_FIELD_NAMES = [ACCEPTANCE_FIELD, "Refutation", "Mutation"];

/**
 * #438's stop rule, as a predicate: is this line another section's bare header? Named because
 * `blockEndAfter` has to ask the identical question the loop asks, and a second regex that could disagree
 * about what ends a block is this repository's most-recorded shape one level up.
 */
export function isSectionHeaderLine(trimmed: string): boolean {
  // #2118: `Hand-run output` joins the stop set through its OWN predicate rather than through
  // `SECTION_FIELD_NAMES`, because its name carries a space and the pattern built from that list would
  // demand exactly one. The rule it is here for is #438's unchanged: a bare `**Hand-run output:**` line
  // under an in-progress `Acceptance:` block ends that block instead of being read as one more command --
  // which is precisely what happened to `History: full` in #1036, and the whole reason that record exists.
  return handRunOutputHeader(trimmed).matched
    || SECTION_FIELD_NAMES.some((name) => new RegExp(`^(?:\\*\\*|__)?${name}:(?:\\*\\*|__)?`, "i").test(trimmed));
}
