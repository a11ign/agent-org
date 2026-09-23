#!/usr/bin/env node
// @ts-check
// command: run a PR's own stated Acceptance/Refutation command(s) and report RAN/REFUSED/MISSING
// NOTHING HAS EVER RUN A ROW'S ACCEPTANCE COMMAND -- pipeline unit 2, #353. Every PR body in this repo
// carries an `Acceptance:` line and its own PR argues its case; the only thing that has ever executed it
// is the author, reporting the result in prose. `capture-check` was mandatory after any `capture-core.mjs`
// change and had never run once; `scorer:verify` was a security check on the one artefact this project
// publishes and nothing invoked it; `release:gate` was broken from the day it was written. Every one of
// those was found the first time something actually ran it. This is the thing that actually runs it.
//
// THREE OUTCOMES, AND THEY MUST NEVER COLLAPSE INTO TWO:
//
//   RAN      the command executed here, in this job, on the fork's own code with a read-only token --
//            its exit code IS the verdict.
//   REFUSED  the command needs the fleet, the lab, or `runs/` -- named, and this never gates on it. A
//            GitHub-hosted runner has no Windows worker and no Proxmox, and `runs/` is gitignored so any
//            corpus-reading gate here would examine nothing and report cleanly -- CLAUDE.md's own rule,
//            "A GATE THAT READS runs/ IS NOT YOURS TO REPORT".
//   MISSING  no acceptance line at all. THE JOB FAILS. A check that finds nothing, runs nothing and
//            reports green is this repository's most-recorded defect wearing a pipeline's clothes -- the
//            `postSubmitFields` empty on all 2,122 captures, the signal-type regex that scraped nothing
//            and asserted over an empty set, the `sweepLog` guard written against a shape nobody verified.
//
// A DELIBERATE, STATED OPT-OUT IS NOT THE SAME AS SILENCE. `Acceptance: none — <reason>` is accepted and
// treated as an honest pass (nothing to run, nothing hidden) -- but the reason is REQUIRED. "Nobody wrote
// one" and "this row deliberately has none" must read as different states, or the second becomes cover
// for the first.
//
// SCOPED TO `Acceptance:` ONLY, DELIBERATELY -- not `Mutation:`. A mutation check edits a real file (even
// restored, it is a mutating, slower operation than this job is built to gate every PR on); #353's own
// region names `packages/agent-org/src/acceptance-commands.mjs`, not a mutation runner, and folding the two together
// would make "did the acceptance command pass" wait on something with a different risk profile and cost.
//
// #471: THIS JOB ALSO REQUIRES A `Closes:` DECLARATION, on the identical shape -- `Closes #N`,
// `Closes: none — <reason>`, or the job FAILS. Built after #468 (the first PAT-armed merge) proved the
// closing pipeline works and, in the same run, exposed that a PR is allowed to declare nothing at all: its
// row stayed open while the work that closed it landed on main, and nothing said so. See
// `closesDeclarationReport` below; it NEVER infers a row from a branch name or title.
//
// THIS PARSER READS SEVERAL NAMED SECTIONS OUT OF AUTHOR-WRITTEN PROSE, AND EVERY READER OF IT MUST
// DECIDE EXPLICITLY WHETHER IT TAKES THE FIRST MATCH OR ALL OF THEM -- the default of "first" has now
// been wrong twice, in two different functions, on two different fields of the same document. #527:
// `extractClosesDeclaration`'s single `.exec()` reported only the first of two separate `Closes` lines,
// silently truncating a fact GitHub itself still honoured in full. #540 was the second: `extractSection`'s
// `lines.findIndex()` did the identical thing to a second `Acceptance:`/`Refutation:` header, except it
// failed SILENTLY rather than truncating -- fed `"Acceptance: npm test\n\ntext\n\nAcceptance: npm run
// lint"`, it reported `{commands: ["npm test"]}` with no trace the second header ever existed. Neither
// function chose "first" on purpose; it fell out of `findIndex`/`.exec()` being the obvious call, twice.
//
// #527 AND #540 CHOSE DIFFERENT REMEDIES, DELIBERATELY -- read `headerIndices`' own comment before
// assuming the fix here is "do what #527 did". `Closes #A`/`Closes #B` is a form GitHub itself accepts and
// closes both for, so concatenating every match was the honest reading of an established convention.
// Two `Acceptance:` blocks is not an established convention in this repo at all, so #540 does not guess
// that the author meant "run every command from every section" -- it reports the ambiguity as a DUPLICATE
// and fails the job, naming every occurrence, and leaves concatenation as a decision nobody has actually
// asked for yet.
//
// Read this before adding a fourth section reader.
//
// `pull_request`, NEVER `pull_request_target` -- wired in `ci.yml`, not here, but the reason belongs next
// to the code that makes it safe: this module runs the AUTHOR'S OWN commands from a PR body, so it must
// only ever run under the fork's read-only token and the fork's own checked-out code. Nothing in this
// file grants itself write access; it doesn't need to.
import { execSync } from "node:child_process";
import {
  declaredRegionFiles, extractLabeledSection, regionCovers, trackedTopLevelDirs,
} from "./region-paths.mjs";
import { pathToFileURL } from "node:url";
import { existsSync, globSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, join } from "node:path";
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
import { localImports, importedNamesFor, stripComments } from "../../guards/src/local-import-closure.mjs";

/** @typedef {{ verdict: "runnable" } | { verdict: "refused", reason: string } | { verdict: "prose", reason: string }} Classification */
/** @typedef {{ kind: "missing" } | { kind: "none", reason: string } | { kind: "commands", commands: string[] } | { kind: "duplicate", occurrences: { line: number, text: string }[] }} Section */
/** @typedef {{ kind: "missing" } | { kind: "malformed", detail: string } | { kind: "none", reason: string } | { kind: "closes", numbers: number[] }} ClosesDeclaration */
// #621: `corpus` is OPTIONAL, deliberately -- every existing capabilities literal in this file's own test
// suite (`NO_HISTORY`, `WITH_HISTORY`) predates it and names only three keys. `unmetRequirements`'s own
// rule already reads an absent key as unmet, never as satisfied by default, so making the field optional
// costs nothing: an object that never mentions `corpus` still answers "unmet" exactly as if it had named
// `corpus: false`.
/** @typedef {{ history: boolean, token: boolean, fleet: boolean, corpus?: boolean }} JobCapabilities */

// `npm run fleet:*` and its siblings -- the resource ban every worker/agent role file below `ceo` and
// `orchestrator` carries, verbatim, elsewhere in this repo. A GitHub-hosted runner is not one of the
// exceptions to it.
// #1912: THESE NAME A THING, where every other pattern below names an INVOCATION. `fleet:status` in a
// sentence is still somebody running `fleet:status`; `A11Y_PVE_KEY` in a sentence may be a unit test
// asserting what happens when the key is ABSENT -- #1911's Acceptance was a plain rstest run whose bullet
// said exactly that, and `row-file` routed it to `orchestrator`, the one session the row existed to spare.
// `fleetOrLabAcceptance` reads these outside bullet prose only; see `withoutBulletProse`.
const SYSTEMCTL = /\bsystemctl\b/;
const SYSTEMD = /\bsystemd\b/;
const PVE_KEY = /\bA11Y_PVE_KEY\b|\ba11y-pve\b/;
const CORPUS_REMOTE = /\bA11Y_CORPUS_REMOTE\b/;
const ON_THE_LAB = /\bon the lab\b/;
const NAMED_NOT_INVOKED = new Set([SYSTEMCTL, SYSTEMD, PVE_KEY, CORPUS_REMOTE, ON_THE_LAB]);

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

const FLEET_LAB_PATTERNS = /** @type {[RegExp, string][]} */ ([
  [/\bfleet:/, "reaches the fleet -- a GitHub runner has no Windows worker"],
  [/\blab:/, "reaches the lab -- a GitHub runner has no Proxmox"],
  [/\btraining:capture/, "captures real evidence, which needs the fleet"],
  [/\bworker:/, "reaches a worker VM, which does not exist on a GitHub runner"],
  [/\bevidence:check\b/, "compares live evidence against a real worker"],
  [/\bgate:stability\b/, "captures canaries against a real worker"],
  [/\bcapture:check\b/, "needs a real worker and NVDA"],
  // #1241, added after review: THE CONTROL PLANE IS ALSO NOBODY ELSE'S. The first version of this
  // deriver cited #1042 and #1234 as the cases it closed and caught NEITHER -- both are `orchestrator`'s
  // because the control plane is theirs, and neither acceptance names a `fleet:` or `lab:` command.
  // A lane deriver answering null for a row that is not `lane:any` looks exactly like one answering null
  // for a row that is, and it becomes the thing a reader trusts INSTEAD of the body.
  //
  // NAMED, never a glob: a list somebody chose is what makes routing on it safe.
  [SYSTEMCTL, "drives systemd on the control host, which only `orchestrator` reaches"],
  [SYSTEMD, "installs or reads a systemd unit on the control host"],
  [/\bgh workflow run\b/, "dispatches a workflow from the control plane, not from a checkout"],
  [/\bfleet:provision\b/, "provisions a real box"],
  [PVE_KEY, "uses the Proxmox key, which lives on the control plane"],
  // #1860: BARE `\bcorpus-backup\b` WAS WRONG -- it matched the SUBSTRING, so
  // `packages/lab/src/packaging/corpus-backup.test.ts` (a unit test that only reads source text) refused
  // itself the moment #1042's own fix added a file named after the thing it fixed. Every sibling pattern
  // above matches an INVOCATION SHAPE (a colon-suffixed script name), never a bare word a filename could
  // just as easily contain -- this is the one that didn't, and #1860 is the proof. `corpus-backup\.mjs`
  // is the real script's filename (as actually spawned: `node packages/lab/scripts/corpus-backup.mjs`);
  // `corpus:backup` is the npm script name (`npm run corpus:backup`, per package.json). Neither matches a
  // `.test.ts` path.
  [/\bcorpus-backup\.mjs\b|\bcorpus:backup\b/, "writes or verifies the corpus backup, which runs on the lab"],
  [CORPUS_REMOTE, "writes or verifies the corpus backup, which runs on the lab"],
  [ON_THE_LAB, "names work done ON the lab, which only `orchestrator` reaches"],
]);

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
 * @param {string} body a row body
 * @returns {string | null} the reason the matched command needs the fleet or lab, or null
 */
export function fleetOrLabAcceptance(body) {
  // THE RAW SECTION, not `extractAcceptanceSection`'s commands -- and that is the correction review
  // forced. That function returns the first COMMAND LINE; for #1042 and #1234 it returns one line of
  // prose, so the numbered clauses naming systemd and `gh workflow run` were never looked at. The two
  // rows this deriver was filed on both answered null, and a lane deriver answering null for a row that
  // is NOT lane:any looks exactly like one answering null for a row that is.
  //
  // Running a command and CLASSIFYING a row are different questions over the same text: `pr-open` needs
  // the runnable lines, this needs everything the section says it will take.
  const section = extractLabeledSection(body, "Acceptance");
  if (section === null) return null;
  const named = namedPatternText(section);
  for (const [pattern, reason] of FLEET_LAB_PATTERNS) {
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
 * @param {string} section @returns {string}
 */
function namedPatternText(section) {
  return withoutBulletProse(withoutScopeDisclaimer(section));
}

/**
 * #1912, widened by #1988: the reason a NAMED pattern would have given when it appears ONLY in text the
 * deriver trims, and WHICH trim swallowed it -- `row-file` prints both, so neither rule can get a row
 * wrong in silence. #1912 made silence the defect; a second silent trim would re-make it.
 *
 * The form is derived, not assumed: the pattern is re-tested against the span with only the disclaimer
 * removed, so a mention that survives that is the bullet rule's and one that does not is this row's.
 * @param {string} body a row body
 * @returns {{ reason: string, form: "bullet" | "scope disclaimer" } | null}
 */
export function untrimmedFleetMention(body) {
  const section = extractLabeledSection(body, "Acceptance");
  if (section === null || fleetOrLabAcceptance(body) !== null) return null;
  const hit = FLEET_LAB_PATTERNS.find(([pattern]) => NAMED_NOT_INVOKED.has(pattern) && pattern.test(section));
  if (!hit) return null;
  const survivesDisclaimerTrim = hit[0].test(withoutScopeDisclaimer(section));
  return { reason: hit[1], form: survivesDisclaimerTrim ? "bullet" : "scope disclaimer" };
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
 * @param {string} section
 * @returns {string}
 */
function withoutScopeDisclaimer(section) {
  let inFence = false;
  let inDisclaimer = false;
  let afterBlank = false;
  return section.split(/\r\n|\r|\n/).filter((line) => {
    const isFence = /^\s*(```|~~~)/.test(line);
    if (isFence) { inFence = !inFence; inDisclaimer = false; }
    if (inFence || isFence) return true;
    if (SCOPE_DISCLAIMER.test(line)) { inDisclaimer = true; afterBlank = false; return false; }
    if (line.trim() === "") { afterBlank = inDisclaimer; return true; }
    if (inDisclaimer && !endsLazyBlock(line, afterBlank)) return false;
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
 * @param {string} section
 * @returns {string}
 */
function withoutBulletProse(section) {
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
    if (inItem && !endsLazyBlock(line, afterBlank)) return false;
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
 * @param {string} line a non-blank line outside any fence @param {boolean} afterBlank
 */
function endsLazyBlock(line, afterBlank) {
  if (/^\s/.test(line)) return false;
  return afterBlank || /^(\d+[.)]\s|#)/.test(line);
}

// `runs/` is gitignored -- a GitHub runner never has a corpus, so these read nothing and report cleanly.
// CLAUDE.md: "A GATE THAT READS runs/ IS NOT YOURS TO REPORT."
const CORPUS_PATTERNS = /** @type {[RegExp, string][]} */ ([
  [/\brules:gate\b/, "reads runs/, which is gitignored and absent in CI"],
  [/\brules:coverage\b/, "reads runs/, which is gitignored and absent in CI"],
  [/\bcheck-signals\b/, "reads runs/, which is gitignored and absent in CI"],
  [/\bcorpus:starvation\b/, "reads runs/, which is gitignored and absent in CI"],
  [/\bscorer:shortcuts\b/, "reads runs/, which is gitignored and absent in CI"],
]);

// #516: `npm run mutate` (`packages/guards/src/mutation-check.mjs`) AND `Refutation:` HAVE OPPOSITE EXIT CONVENTIONS.
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
const MUTATE_PATTERN = /\bnpm run mutate\b|\bmutation-check\.mjs\b/;

// #446: A LEADING `VAR=value` ASSIGNMENT IS NOT THE COMMAND. This repo's own Acceptance/Mutation lines
// routinely start with one -- `A11Y_ALLOW_ARMED_PUSH="..." git push`, `GH_TOKEN=... gh pr view`,
// `PYTHONDONTWRITEBYTECODE=1 pytest ...` -- and the executable check below must look PAST it, or every
// one of those legitimate, real commands would misclassify as prose over an assignment that was never
// meant to be looked up on `$PATH`.
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;

// #446's OWN STATED SECOND HALF: `command -v` finds these because they genuinely ARE executable, so no
// existence check can catch a line that merely starts with one. Flagged by name instead -- the identical
// shape `FLEET_LAB_PATTERNS`/`CORPUS_PATTERNS` already use, for the identical reason: a check that can
// answer "is this refusable" cannot also answer "is this claim supportable", so it needs its own list.
const UNVERIFIABLE_BUILTINS = new Set(["echo", "true", ":", "test", "time", "["]);

/**
 * The first token of a command that could plausibly BE the command -- skipping any leading `VAR=value`
 * assignments (#446). `undefined` for an empty or whitespace-only line.
 * @param {string} command
 * @returns {string | undefined}
 */
function firstRealToken(command) {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
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
 * @param {string} token
 * @returns {boolean}
 */
function commandExists(token) {
  const isExecutableFile = (/** @type {string} */ path) => {
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
const FULL_CAPABILITIES =
  /** @type {JobCapabilities} */ ({ history: true, token: true, fleet: true, corpus: true });

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
 * @param {string} trimmed
 * @returns {boolean}
 */
function isHistoryDeclarationLine(trimmed) {
  return HISTORY_FULL_PATTERN.test(trimmed) || HISTORY_ISH_PATTERN.test(trimmed);
}

/**
 * Does the PR body ask for this run's checkout to carry full history (#497)? A PR carrying the line with
 * no historical fixture in its Acceptance command pays only time, never a wrong verdict -- see this
 * file's own header and #497's own "what it must not become" for why that asymmetry is deliberate.
 * @param {string | null | undefined} body
 * @returns {boolean}
 */
export function hasFullHistoryDeclaration(body) {
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

/** #2099: is this line an attempt at the `Hand-run:` declaration, recognised or not? @param {string} trimmed */
function isHandRunDeclarationLine(trimmed) {
  return HAND_RUN_PATTERN.test(trimmed) || HAND_RUN_ISH_PATTERN.test(trimmed);
}

/**
 * #2099: is this line a DECLARATION rather than a command -- `History: full` or `Hand-run: <reason>`,
 * recognised or near-miss? One function so `commandLinesAfter` pays ONE branch for the whole family: the
 * caller sits at this repo's complexity gate, and every declaration added since has had to be free there
 * (`isHistoryDeclarationLine` was extracted for exactly this, and says so).
 * @param {string} trimmed
 * @returns {boolean}
 */
function isDeclarationLine(trimmed) {
  return isHistoryDeclarationLine(trimmed) || isHandRunDeclarationLine(trimmed);
}

/**
 * #2099: the row's or PR's own statement that its Acceptance is run BY HAND, and why -- or `null`.
 *
 * The reason is returned rather than a boolean, because every message this declaration produces quotes
 * it: a `NOT RUN` line naming no reason is the prose it replaces with extra steps.
 * @param {string | null | undefined} body
 * @returns {string | null}
 */
export function handRunDeclaration(body) {
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
 *
 * @param {string | null | undefined} body
 * @returns {string | null}
 */
export function handRunEvidence(body) {
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
 * @param {string} trimmed
 * @returns {{ matched: boolean, inline: string }}
 */
function handRunOutputHeader(trimmed) {
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
 * @param {string} text
 * @returns {boolean}
 */
function pastedSomething(text) {
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
 * @param {string} command
 * @returns {boolean}
 */
function needsToken(command) {
  const token = firstRealToken(command);
  return token !== undefined && token.replace(/^['"]|['"]$/g, "") === "gh";
}

/**
 * #2099: the `token` refusal for a command, or `null` when this job can honestly attempt it. Extracted
 * rather than inlined in `classifyCommand`, which sits AT the complexity gate -- a called function's
 * branches are not the caller's, the same reason `isHistoryDeclarationLine` exists next door.
 * @param {string} command
 * @param {JobCapabilities} capabilities
 * @param {"ACCEPTANCE" | "REFUTATION"} [section]
 * @returns {Classification | null}
 */
function tokenRefusal(command, capabilities, section) {
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
 * @param {string} command @param {"ACCEPTANCE" | "REFUTATION"} [section]
 */
function noTokenReason(command, section) {
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
 * @param {string | null | undefined} body
 * @returns {JobCapabilities}
 */
export function jobCapabilities(body) {
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
 * @param {string} text
 * @returns {string[]}
 */
export function testFileRequirements(text) {
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
 * @param {string} text
 * @returns {string | null} the declared path (e.g. `runs/git-fixture-cache`), or null if undeclared.
 */
function declaredWritePath(text) {
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
 * @param {string} codeOnly
 * @param {string} writesPath
 */
function writeDeclarationHolds(codeOnly, writesPath) {
  const subdir = writesPath.replace(/^runs\//, "");
  return subdir.length > 0 && codeOnly.includes(subdir) && WRITE_CALL_PATTERN.test(codeOnly);
}

// #621: DERIVED, NOT DECLARED. `board-style.test.ts` reaches `gh` with no `// requires:` header at all --
// the fourth instance in two days of the identical shape #382 already named: "an opt-in declaration
// cannot catch the file whose author did not know there was something to declare, which is the whole
// population that matters." So this job's capability check no longer trusts the header alone; it walks
// the SAME local-import closure `gh-token-jobs.test.ts` already walks (`packages/guards/src/local-import-closure.mjs`,
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
/** @param {string} a @param {string} b @returns {string} */
const fingerprint = (a, b) => a + b;

/**
 * `typescript`, LOADED ONLY WHEN A CLOSURE IS ACTUALLY SCANNED -- and this is not a style choice.
 *
 * A STATIC import breaks two pre-install entries, and `pre-install-import-graph.test.ts` said so by name
 * rather than my assuming the CI ordering held everywhere: `arm-pr.mjs` and `workflow-run-liveness.mjs`
 * both reach this module for `extractClosesDeclaration` -- one function that touches none of this -- and
 * both run before `npm ci`, where a package specifier dies with ERR_MODULE_NOT_FOUND. The acceptance job
 * itself runs after `npm ci --ignore-scripts` and `npm run build`, so the parser is there when needed.
 *
 * AND WHEN IT IS NOT, THE FALLBACK OVER-CHARGES RATHER THAN UNDER-CHARGES: no parser means the old
 * full-text scan, which refuses more than it should. That is the safe direction for a guard whose other
 * failure would be a test running in CI with no corpus and reading `runs/`. Stated here because a silent
 * fallback to a DIFFERENT answer is the shape this repository keeps finding in its own tooling.
 *
 * `acorn` was the alternative and is deliberately not used: it resolves here only as another package's
 * transitive dependency, which would make this guard hostage to somebody else's tree.
 * @type {typeof import("typescript") | null | undefined}
 */
let typescriptModule = undefined;

/** @returns {typeof import("typescript") | null} */
function loadTypescript() {
  if (typescriptModule !== undefined) return typescriptModule;
  try {
    typescriptModule = /** @type {typeof import("typescript")} */ (createRequire(import.meta.url)("typescript"));
  } catch (error) {
    void error; // pre-install: the caller falls back to the full-text scan, which over-charges
    typescriptModule = null;
  }
  return typescriptModule;
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
 * The ENTRY is scanned whole, as #967 decided; its `referenced` is every identifier in it. With no parser there
 * is no reachability to read, so `referenced` is `null` and the walk follows every bound name -- the old
 * over-charge, the safe direction.
 *
 * PARSED, NOT BRACE-MATCHED. `typescript` is a declared devDependency and this script runs after `npm ci`
 * in `reusable-acceptance.yml`, so the module's own statements come from `ts.createSourceFile`. A
 * hand-rolled brace matcher would have to survive template literals and regex literals containing braces,
 * and a wrong one fails in the direction that looks like success -- the #731 trap, one layer over.
 *
 * OFFSETS ARE PRESERVED: a body is replaced by spaces of the same length, keeping newlines, exactly as
 * `stripComments` does. So `lineNumberOf` still reports the real line of whatever survives.
 *
 * @param {string} codeOnly the file's text, comments already stripped
 * @param {string} fileName for the parser's diagnostics only
 * @param {Set<string>} imported the names the importing file's reachable code uses from this module
 * @param {boolean} isEntry
 * @returns {{ scope: string, referenced: Set<string> | null }}
 */
function reachableScope(codeOnly, fileName, imported, isEntry) {
  const ts = loadTypescript();
  if (ts === null) return { scope: codeOnly, referenced: null }; // no parser: scan everything, follow every name
  const source = ts.createSourceFile(fileName, codeOnly, ts.ScriptTarget.Latest, true);
  if (isEntry) return { scope: codeOnly, referenced: referencedNames(ts, source, null) };
  const kept = new Set(imported);
  for (let size = -1; size !== kept.size;) {
    size = kept.size;
    for (const name of referencedNames(ts, source, kept)) kept.add(name);
  }
  return { scope: blankUnkept(ts, source, codeOnly, kept), referenced: referencedNames(ts, source, kept) };
}

/**
 * Every identifier the code that can run uses -- skipping import and export declarations, and, when `kept` is
 * given, a top-level function declaration nobody reaches and the entry guard. `kept === null` is the entry: all
 * of it runs.
 * @param {typeof import("typescript")} ts
 * @param {import("typescript").SourceFile} source
 * @param {Set<string> | null} kept
 * @returns {Set<string>}
 */
function referencedNames(ts, source, kept) {
  /** @type {Set<string>} */
  const names = new Set();
  /** @param {import("typescript").Node} node */
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (kept !== null && ts.isSourceFile(node.parent) && isEntryGuard(ts, node, source)) return;
    if (kept !== null && ts.isSourceFile(node.parent) && ts.isFunctionDeclaration(node)
      && !(node.name && kept.has(node.name.text))) return;
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return names;
}

/**
 * A top-level `if` whose condition reads `import.meta.url` -- `if (import.meta.url === pathToFileURL(...).href)
 * main();` -- runs its body only when the module is the entry, so nothing in it is reached by an import.
 * @param {typeof import("typescript")} ts @param {import("typescript").Node} node
 * @param {import("typescript").SourceFile} source
 */
function isEntryGuard(ts, node, source) {
  return ts.isIfStatement(node) && node.expression.getText(source).includes("import.meta.url");
}

/**
 * The module's text with every body `kept` does not reach blanked -- #967's rule, now keyed on reachability.
 * @param {typeof import("typescript")} ts
 * @param {import("typescript").SourceFile} source
 * @param {string} codeOnly
 * @param {Set<string>} kept
 * @returns {string}
 */
function blankUnkept(ts, source, codeOnly, kept) {
  /** @type {[number, number][]} */
  const bodies = [];
  /** @param {import("typescript").Node} node */
  const visit = (node) => {
    const body = /** @type {{ body?: import("typescript").Node }} */ (node).body;
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
  const chars = [...codeOnly];
  for (const [start, end] of bodies) {
    for (let i = start; i < end; i += 1) if (chars[i] !== "\n") chars[i] = " ";
  }
  return chars.join("");
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
 * `npmCliInvocation` did not, because it runs only `npx` or `npm` (`npm-cli-executable.mjs`), never `gh`.
 */
export const SPAWNS_GH = new RegExp(`(?:${CHARGED_SPAWNS.join("|")})\\s*\\(\\s*(['"\`])gh\\1`);

const CLOSURE_REQUIREMENT_PATTERNS =
  /** @type {[RegExp, "token" | "corpus" | "history"][]} */ ([
    // A `gh` invocation (`SPAWNS_GH` above, the one copy gh-token-jobs.test.ts imports) or a direct read
    // of the token itself -- either means the file's operation needs a real GH_TOKEN to behave honestly.
    [SPAWNS_GH, "token"],
    [new RegExp(`\\b${fingerprint("GH_TO", "KEN")}\\b`), "token"],
    // `runsRoot()` (packages/lab/src/dataset-paths.mjs) is the ONE function this repo reads `runs/`
    // through; its two documented override env vars are the ONE other door. Reading `runs/` any other way
    // would be a second, undocumented door CLAUDE.md's own corpus rule does not know about.
    [/\brunsRoot\s*\(/, "corpus"],
    [new RegExp(`\\b(?:${fingerprint("RUNS_R", "OOT")}|${fingerprint("A11Y_RUNS_R", "OOT")})\\b`), "corpus"],
    // The shallow-checkout question this repo's own idiom asks (pre-push-resolve-toward-main.test.ts,
    // pre-push-stale-base.test.ts) -- a file asking it needs a real answer, which only a full-history
    // checkout can honestly give it.
    [new RegExp(fingerprint("--is-shallow-repo", "sitory") + "\\b"), "history"],
  ]);

// #827: THE MIRROR OF `// writes:`, ON THE TEST FILE RATHER THAN THE FILE THAT CALLS THE RISKY FUNCTION --
// `board-markdown.test.ts` and `board-achievement-retirement.test.ts` each import only `document` from
// `board-document.mjs`, render it from a literal fixture object, and pass 5/5 and 7/7 with `gh` stubbed to
// exit 4 on every call. Neither calls `todaysReleaseExists` (`board-document.mjs`'s own `gh release view`
// spawn, line ~1190) -- but the walk scans the WHOLE FILE'S text for every requirement pattern, not the
// one export a caller actually imports, so any test reaching `board-document.mjs` at all is charged for
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
 * @param {string} text
 * @returns {{ line: number, fn: string | null }[]}
 */
function noTokenHeaders(text) {
  return text.split("\n").flatMap((raw, i) => {
    if (!NO_TOKEN_CANDIDATE.test(raw)) return [];
    const match = NO_TOKEN_DECLARATION.exec(raw.replace(/\r$/, ""));
    return [{ line: i + 1, fn: match ? match[1] : null }];
  });
}

/**
 * Does `entry`'s own code genuinely never call the function it claims not to need -- a real call SHAPE
 * (`fnName(`), never a bare mention a comment or a string could contain just as easily. Shallow, exactly
 * as `writeDeclarationHolds` is shallow: this proves the declaring file's OWN text does not call it, not
 * that nothing it calls calls it in turn -- the same scope #731's own write-side check keeps.
 *
 * #1140: A DECLARED COMMAND IS USED BY BEING SPAWNED, NOT CALLED. `// no-token: gh` over
 * `execFileSync("gh", [...])` held, because that text contains no `gh(` -- the declaration went false in
 * substance while its check kept passing. So the name as the WHOLE quoted first argument of a spawn is a use
 * too. It stays a SHAPE, never a mention: `gh` in prose, in an identifier, or as a later argument to a spawn
 * of another command still holds.
 * @param {string} entryCodeOnly
 * @param {string} fnName
 */
function noTokenDeclarationHolds(entryCodeOnly, fnName) {
  const called = new RegExp(`\\b${fnName}\\s*\\(`).test(entryCodeOnly);
  const spawned = new RegExp(`\\b(?:${DECLARED_SPAWNS.join("|")})\\s*\\(\\s*(['"\`])${fnName}\\1`).test(entryCodeOnly);
  return !called && !spawned;
}

/**
 * Where in `text` a 1-indexed line number sits for a given match index.
 * @param {string} text
 * @param {number} index
 * @returns {number}
 */
function lineNumberOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** @typedef {{ requirement: "token" | "corpus" | "history", file: string, line: number, chain: string[],
 *              wrongDeclaration?: boolean, malformedDeclaration?: boolean }} ClosureHit */

/**
 * #1636: the names `file` binds from `next` that its reachable code actually uses -- or every bound name when there
 * was no parser to say (`referenced === null`), which over-charges.
 * @param {string} file @param {string} next @param {Set<string> | null} referenced
 * @returns {Set<string>}
 */
function reachedNames(file, next, referenced) {
  const bound = importedNamesFor(file, next);
  return new Set(referenced === null ? bound : bound.filter((name) => referenced.has(name)));
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
 * @param {string} entry absolute path to the entry file
 * @returns {ClosureHit[]}
 */
export function deriveClosureRequirements(entry) {
  /** @type {Map<string, ClosureHit>} */
  const found = new Map();
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
  if (existsSync(entry)) {
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
   * @param {{ requirement: "token" | "corpus" | "history", file: string, text: string, codeOnly: string,
   *           match: RegExpExecArray, chain: string[] }} found_
   */
  const recordHit = ({ requirement, file, text, codeOnly, match, chain }) => {
    const hit = { requirement, file, line: lineNumberOf(text, match.index), chain };
    if (requirement !== "corpus") { found.set(requirement, hit); return; }
    const writesPath = declaredWritePath(text);
    if (writesPath === null) { found.set(requirement, hit); return; }
    if (writeDeclarationHolds(codeOnly, writesPath)) { exemptCorpus = true; return; }
    found.set(requirement, { ...hit, wrongDeclaration: true });
  };
  // #1636: `seen` maps a file to the names already scanned for it. A second edge bringing a name the first did not
  // is scanned again with the union, so the order imports are met in can never hide a reachable body.
  /** @param {string} file @param {string[]} chain @param {Map<string, Set<string>>} seen @param {Set<string>} names */
  const walk = (file, chain, seen, names) => {
    const prior = seen.get(file);
    if ((prior && [...names].every((name) => prior.has(name))) || !existsSync(file)) return;
    const union = new Set([...(prior ?? []), ...names]);
    seen.set(file, union);
    const text = readFileSync(file, "utf8");
    const codeOnly = stripComments(text);
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
    const { scope: corpusScope, referenced } = reachableScope(codeOnly, file, union, file === entry);
    const hereChain = [...chain, file];
    for (const [pattern, requirement] of CLOSURE_REQUIREMENT_PATTERNS) {
      if (found.has(requirement) || (requirement === "corpus" && exemptCorpus)
        || (requirement === "token" && exemptToken)) continue;
      const match = pattern.exec(requirement === "corpus" ? corpusScope : codeOnly);
      if (match) recordHit({ requirement, file, text, codeOnly, match, chain: hereChain });
    }
    for (const next of localImports(file)) walk(next, hereChain, seen, reachedNames(file, next, referenced));
  };
  walk(entry, [], new Map(), new Set());
  return [...found.values()];
}

/**
 * The human-facing form of a `ClosureHit` -- `"board-style.test.ts requires token via collect →
 * board-data.mjs:72"` for a one-hop chain, matching #621's own worked example verbatim. A direct hit (the
 * entry file itself matches, zero hops) reads as `"<entry> requires <req>, at <entry>:<line>"`.
 *
 * #731: A `wrongDeclaration` HIT SAYS SO, naming the file's OWN claim as the thing that failed -- a reader
 * fixing a plain `corpus` refusal edits the test; a reader fixing a wrong `// writes:` (or, #827, `// no-
 * token:`) edits the comment that no longer describes what the file does, a different fix at a different
 * spot.
 * @param {ClosureHit} hit
 * @returns {string}
 */
export function closureRequirementMessage(hit) {
  const { requirement, file, line, chain, wrongDeclaration, malformedDeclaration } = hit;
  const entryLabel = basename(chain[0]);
  const fileLabel = basename(file);
  const suffix = malformedDeclaration
    ? ` -- ${fileLabel}:${line} is not a \`// no-token:\` declaration: the name must end the line, or be followed by `
      + "\" -- <reason>\"; refusing rather than ignoring it"
    : !wrongDeclaration ? "" : requirement === "token"
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
 *
 * @param {{requirement: string, chain: string[], wrongDeclaration?: boolean, malformedDeclaration?: boolean}} hit
 * @param {string[]} hops
 * @returns {string}
 */
function noTokenRemedy(hit, hops) {
  if (hit.requirement !== "token" || hit.wrongDeclaration || hit.malformedDeclaration) return "";
  const fn = hops[hops.length - 1];
  const entry = hit.chain[0];
  if (!fn || !existsSync(entry)) return "";
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
 * @param {string} entry
 * @param {JobCapabilities} capabilities
 * @returns {{ requirement: string, message: string }[]}
 */
export function unmetClosureRequirements(entry, capabilities) {
  return deriveClosureRequirements(entry)
    .filter((hit) => /** @type {Record<string, boolean>} */ (capabilities)[hit.requirement] !== true)
    .map((hit) => ({ requirement: hit.requirement, message: closureRequirementMessage(hit) }));
}

/**
 * Which of `requirements` this job's `capabilities` do NOT satisfy -- named, not counted, because "needs
 * history" and "needs a token" send an author to opposite fixes (#510's own acceptance). A requirement
 * word `capabilities` has no key for reads as unmet, never as satisfied by default.
 * @param {string[]} requirements
 * @param {JobCapabilities} capabilities
 * @returns {string[]}
 */
export function unmetRequirements(requirements, capabilities) {
  return requirements.filter((req) => /** @type {Record<string, boolean>} */ (capabilities)[req] !== true);
}

/**
 * A COMMAND THAT RUNS THE WHOLE SUITE, which the capability gate could not see until 2026-09-09.
 *
 * `unmetCommandRequirements` and `unmetCommandClosureRequirements` both opened with
 * `if (!/tsx --test/.test(command)) return []`, so they asked whether the command NAMED a file needing a
 * capability. `npm test` names none and runs them all.
 *
 * THAT IS THE ADJACENT-PROPERTY SHAPE AGAIN, and it cost the whole afternoon's PR checks. #513 split
 * `row-claim-live.test.ts` out precisely so a `tsx --test` command naming it could be refused, and that
 * half worked. The half nobody had is the command everybody actually types: on 2026-09-09 four PRs at
 * once were red on `acceptance / run`, every one of them for `gh: To use GitHub CLI in a GitHub Actions
 * workflow, set the GH_TOKEN environment variable`, in a job that passes no token BY DESIGN because it
 * runs commands taken from a stranger's PR body. None of the four had touched the code that failed.
 *
 * The failure mode is the bad one: not a refusal naming the capability, but a red check naming the
 * PR's author for a line they never wrote. Refused, it is green with a printed reason.
 *
 * A whole-suite command requires the UNION of what every file it runs requires -- so the predicate and
 * the population must answer about the SAME script, which until #2153 they did not. This said `npm test`
 * runs "the recursive `.test.ts` glob under every package's `src`", and that premise stopped being true
 * when the org tooling was split out: `test:ts` globs eight product packages, `test:org` the four org
 * ones, `test:all` every package. Reading the wide glob for the narrow command charged `npm test` 419
 * files it cannot load and refused it for one of them; not knowing `test:org`/`test:all` by name let the
 * command that DOES run all of them through the gate having been charged nothing, which is the
 * 2026-09-09 failure above in the other direction. So this is no longer a bare yes/no: `suiteScriptsFor`
 * names the scripts, and `testFilesRunBy` charges the union of their own globs.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function runsTheWholeSuite(command) {
  return suiteScriptsFor(command).length > 0;
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

// `(?![:\w-])` AND NOT `\b`: `\b` after `test` matches `npm run test:python`, whose population is the
// pytest tree rather than the `.test.ts` glob this function's callers walk. Refusing that command for a
// requirement declared by a TypeScript file would be a refusal about a population it never runs.
// `g` AND `matchAll` ONLY, NEVER `exec`/`test` (#2207): a chained command names more than one script,
// and a global regex driven by `exec` carries `lastIndex` between calls, so the second caller would start
// reading in the middle of a different command. `matchAll` works on a copy and leaves this one alone.
const SUITE_COMMAND = new RegExp(
  `(?:^|&&|\\|\\||;)\\s*npm\\s+(?:run\\s+)?(${SUITE_SCRIPTS.join("|")})(?![:\\w-])`, "g");

/**
 * EVERY `package.json` script a command invokes, in the order it invokes them -- empty when it is not a
 * whole-suite command at all.
 *
 * THE RESOLUTION IS THE POINT (#2153). `npm test` and `npm run test:all` are not the same population and
 * must not be charged the same one; naming the script is what lets `suiteTestFiles` read that script's
 * OWN glob instead of a single hard-wired one. `npm test` resolves to the `test` script, and
 * `suiteTestFiles` follows its `npm run` delegation from there -- this function does not decide that
 * `test` means `test:ts`, because `package.json` already says so.
 *
 * PLURAL, AND #2207 IS WHY. This returned the FIRST match, from one non-global `exec`. The pattern's own
 * `(?:^|&&|\|\||;)` alternation exists to recognise a whole-suite call anywhere in a CHAIN, so
 * `npm run test:ts && npm run test:org` is a command this grammar accepts -- and it was charged
 * `test:ts`'s 220 files while the shell ran both scripts' 641. The org half's token requirement went
 * unread and the chain classified `runnable` in a job with no token: the 2026-09-09 failure again, from
 * the direction #2153 left open. A command runs every script it names, so it is charged every script it
 * names, and the union is `testFilesRunBy`'s to take.
 *
 * Deduplicated, because `npm test && npm test` runs one population twice and requires it once.
 *
 * @param {string} command
 * @returns {string[]}
 */
export function suiteScriptsFor(command) {
  return [...new Set([...command.trim().matchAll(SUITE_COMMAND)].map((match) => match[1]))];
}

/**
 * A whole TOKEN that is shaped like a repo-relative path -- glob metacharacters INCLUDED, deliberately.
 *
 * `*`, `?`, `[`, `]`, `{` and `}` are in the class so that `packages/**\/*.test.ts` MATCHES here and is
 * then exempted by name below. Leaving them out would exempt globs by accident, which reads identically
 * in the output and cannot be shown to be doing anything -- the exemption has to be a decision a mutation
 * can remove.
 *
 * ANCHORED WHOLE-TOKEN, never scanned out of the middle of one. `node -e "import('./packages/x/y.mjs')"`
 * carries a path inside a quoted argument this does not see, and that is the intended limit: a path this
 * cannot isolate is a path it must not make claims about (#728's rule, one function down).
 */
const ACCEPTANCE_PATH_TOKEN = /^[A-Za-z0-9_.@,+{}[\]*?-]+(?:\/[A-Za-z0-9_.@,+{}[\]*?-]+)+$/;
/** The metacharacters that make a token a pattern a RUNNER expands, rather than a file anyone can open. */
const GLOB_METACHARACTERS = /[*?[\]{}]/;
/** A trailing extension -- what separates `packages/lab/x.test.ts` from a ref like `origin/main`. */
const FILE_EXTENSION = /\.[A-Za-z0-9]{1,10}$/;
/** The one file that states where every fetchable artifact lives on the lab -- #1973, `labFetchArtifacts`. */
const LAB_FETCH_PLAYBOOK = "packages/control/ansible/lab-fetch.yml";

/**
 * One raw whitespace-delimited token, reduced to the repo-relative path it names, or `null`.
 * @param {string} rawToken
 * @returns {string | null}
 */
function acceptancePathToken(rawToken) {
  const unquoted = rawToken.replace(/^['"`]+/, "").replace(/['"`]+$/, "");
  // `--config=packages/x.ts` and `A11Y_PYTHON=.venv/bin/python` both carry their path after the LAST `=`.
  const assigned = unquoted.includes("=") ? unquoted.slice(unquoted.lastIndexOf("=") + 1) : unquoted;
  const token = assigned.replace(/^['"`]+/, "").replace(/^\.\//, "");
  if (token.startsWith("-") || !ACCEPTANCE_PATH_TOKEN.test(token)) return null;
  if (GLOB_METACHARACTERS.test(token)) return null;
  if (!FILE_EXTENSION.test(token)) return null;
  return token;
}

/**
 * THE REPO-RELATIVE FILES A COMMAND NAMES -- #1943, and NARROWER THAN "every path-shaped argument".
 *
 * `testFileArgumentsResolve` below refuses to generalise past `tsx --test`, and its stated reason is the
 * right one: *"treating every argument to every command as a file path would produce false refusals on
 * the many acceptance commands that take URLs, flags, or option values that merely look like paths."*
 * This does not overturn that; it narrows what counts as a path until the false refusals are gone, and
 * then MEASURES the result rather than asserting it.
 *
 * Three filters, each earning its place against a real token measured over the 28 open rows carrying an
 * Acceptance section on 2026-09-22:
 *
 *   a GLOB          `packages/lab/src/**\/*.test.ts` is expanded by a runner. Nothing can `stat` it, and
 *                   neither of the two remedies a refusal would offer applies to it.
 *   NO EXTENSION    `origin/main`, `a11ign/a11y-witness`, `.venv/bin/python` are path-SHAPED and name no
 *                   file in this tree. The same `\.[A-Za-z]{2,4}` discipline `pathInProse` already uses.
 *   AN UNTRACKED    `runs/model-candidate/acceptance-report.json` (#1929's own Acceptance) is PRODUCED by
 *   TOP-LEVEL DIR   the two commands above it, and `runs/` is gitignored -- so it can never exist in a
 *                   fresh checkout and can never be declared in a `## Region`, which declares tracked
 *                   files a PR will touch. A refusal whose two remedies are both unavailable is the shape
 *                   #741 ruled against. `trackedTopLevelDirs()` is the repo's own derived answer to which
 *                   roots are real (#1158), not a second hand-written list.
 *
 * WHAT THIS THEREFORE DOES NOT CATCH, and it is a silent miss rather than a wrong answer: a typo in the
 * FIRST segment (`package/lab/x.ts`), a path inside a quoted argument, and an extensionless script like
 * `scripts/git-hooks/pre-push`. Each is a real file this cannot speak about; none of them is refused
 * wrongly.
 *
 * @param {string} command
 * @param {{ trackedDirs?: string[] }} [options] the tree's top-level directories; a test passes its own
 *   so the rule can be checked without reading the repository it runs in
 * @returns {string[]} deduplicated, in the order the command names them
 */
export function acceptancePathTokens(command, { trackedDirs = trackedTopLevelDirs() } = {}) {
  const tracked = new Set(trackedDirs);
  return commandPathTokens(command)
    .filter((token) => tracked.has(token.slice(0, token.indexOf("/"))));
}

/**
 * The same extraction WITHOUT the tracked-directory filter -- every repo-relative-looking path a command
 * names, including the `runs/` ones `acceptancePathTokens` drops.
 *
 * #1973 SPLIT THIS OUT rather than copying it. `acceptancePathTokens`' three filters exist to keep a
 * refusal followable (see its own header), and the untracked-root one is the reason a `runs/` path is
 * exempt from the EXISTENCE check -- correctly, since it is produced rather than committed. But the
 * lab-fetch check below is about a path that is WRONG rather than absent, and its remedy is a rename the
 * filer can make without a corpus, so it must see exactly the tokens that filter removes. Two spellings
 * of "which words in this command are paths" is the drift #959 is about, one document along.
 *
 * @param {string} command
 * @returns {string[]} deduplicated, in the order the command names them
 */
function commandPathTokens(command) {
  // #419's rule, unchanged: bash ignores an unquoted `#` and everything after it, so token extraction
  // must too, or a prose tail becomes a list of files nothing on disk could ever match.
  const withoutTrailingComment = command.replace(/(?:^|\s)#.*$/, "");
  const named = withoutTrailingComment.split(/\s+/).filter(Boolean)
    .map((raw) => acceptancePathToken(raw))
    .filter((token) => token !== null);
  return [...new Set(/** @type {string[]} */ (named))];
}

/**
 * EVERY PATH A ROW'S ACCEPTANCE NAMES THAT NEITHER EXISTS ON DISK NOR IS DECLARED IN ITS OWN `## Region`
 * -- #1943, and the Region half is what makes this a guard rather than a wall.
 *
 * A row legitimately names files it will CREATE; that is most rows. What separates those from a typo is
 * already this repository's own discipline, so this asks it rather than inventing a second one: a file
 * the row will write is declared in the Region, where B4 reserves it and the lane labels can see it. A
 * stale name is in neither place. Measured 2026-09-22 over the 28 open rows carrying an Acceptance
 * section, this refuses ONE (#20, `board-summary-origin.test.ts`, against the real
 * `board-summary-check.test.ts`) -- a guard, not a wall.
 *
 * THE REGION IS READ ONLY WHEN SOMETHING IS ABSENT, and that ordering is deliberate rather than an
 * optimisation: `declaredRegionFiles` spawns git for the tree's root files, and the overwhelmingly common
 * case (every path exists) must not pay for it or depend on it.
 *
 * @param {string} body a row body
 * @param {{ exists?: (path: string) => boolean, trackedDirs?: string[], regionEntries?: string[] }} [deps]
 * @returns {{ path: string, command: string }[]} each absent path with the command that named it
 */
export function unresolvedAcceptancePaths(body, deps = {}) {
  const { exists = existsSync, trackedDirs, regionEntries } = deps;
  const section = extractAcceptanceSection(body);
  if (section.kind !== "commands") return [];
  /** @type {{ path: string, command: string }[]} */
  const absent = [];
  for (const command of section.commands) {
    for (const path of acceptancePathTokens(command, trackedDirs ? { trackedDirs } : {})) {
      if (!exists(path) && !absent.some((seen) => seen.path === path)) absent.push({ path, command });
    }
  }
  if (absent.length === 0) return [];
  const region = regionEntries ?? declaredRegionFiles(body) ?? [];
  return absent.filter(({ path }) => !region.some((entry) => regionCovers(entry, path)));
}

/**
 * The refusal `row-file` prints, or `null` when every path resolves. NAMES THE PATH AND BOTH WAYS OUT:
 * #741's ruling is that a refusal stating no way forward is not a refusal a filer can follow, and here
 * there are exactly two, because the rule itself has exactly two arms.
 * @param {string} body @param {string} tool the CLI to name in the refusal
 * @param {{ exists?: (path: string) => boolean, trackedDirs?: string[], regionEntries?: string[] }} [deps]
 * @returns {string | null}
 */
export function acceptancePathsReason(body, tool, deps = {}) {
  const unresolved = unresolvedAcceptancePaths(body, deps);
  if (unresolved.length === 0) return null;
  const named = unresolved.map(({ path, command }) => `\`${path}\` (named by \`${command}\`)`).join("; ");
  return `${tool}: REFUSING -- the Acceptance names ${unresolved.length} path(s) that neither exist in `
    + `this checkout nor appear in this row's \`## Region\`: ${named}. There are two ways to satisfy `
    + "this and one of them is right: FIX THE SPELLING, if the file already exists under another name -- "
    + "or DECLARE IT IN THE `## Region`, if this row is going to create it, which is how a row reserves a "
    + "file it has not written yet and what B4 reads to keep two rows off it. `Acceptance:` has been "
    + "merge-blocking since 2026-09-17, so a command naming a path that is neither does not merge red, it "
    + "does not merge -- and by then the fix costs a rewrite by somebody with less context than you have "
    + "now. Globs, paths outside the tree's tracked top-level directories, and names with no file "
    + "extension are not checked here, so a path missing from this list was not confirmed to exist.";
}

/**
 * THE FETCH MAPPING, WHICH IS THE WHOLE REASON #1973 IS CHECKABLE AT FILING TIME.
 *
 * `lab-fetch.yml` DECLARES, as data, where each artifact lives ON THE LAB -- and its own
 * "Name it after what it actually is" task writes the copy somewhere else entirely. Both halves are in a
 * checked-in file, so a row that names the lab side can be caught with a string comparison, no corpus and
 * no lab. See `labFetchLocalPath` for the destination half.
 *
 * READ WITHOUT A YAML PARSER, DELIBERATELY. `@a11ign/agent-org` declares no dependencies at all and
 * imports nothing outside the workspace; `yaml` is a dependency of `lab`, `cli` and `worker-fleet`, and
 * reaching it from here would work only by hoisting -- an undeclared dependency that resolves until the
 * day the tree is installed differently. The block is a flat map of `name: "path"` at one indent, so this
 * reads exactly that and nothing else: no anchors, no nesting, no multi-line scalars.
 *
 * A HAND PARSER IS ONLY SAFE BECAUSE SOMETHING COMPARES IT TO THE REAL ONE. `packages/lab` HAS `yaml`, so
 * `acceptance-check-at-filing.test.ts` parses the same file both ways and asserts the two maps are equal
 * -- which is what makes this a reading of the playbook rather than a second statement of it. If that
 * test fails, this function is wrong and the playbook is right.
 *
 * @param {string} playbook the text of `lab-fetch.yml`
 * @returns {Record<string, string>} artifact name -> its path on the lab, values unquoted
 */
export function labFetchArtifacts(playbook) {
  const lines = playbook.split("\n");
  const start = lines.findIndex((line) => /^\s*lab_artifacts:\s*$/.test(line));
  if (start < 0) {
    throw new Error("acceptance-commands: `lab-fetch.yml` has no `lab_artifacts:` map -- its shape "
      + "changed. Refusing to report an empty mapping, which would silently pass every row this check "
      + "exists to refuse.");
  }
  const headerIndent = /** @type {RegExpMatchArray} */ (lines[start].match(/^\s*/))[0].length;
  /** @type {Record<string, string>} */
  const map = {};
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const indent = /** @type {RegExpMatchArray} */ (line.match(/^\s*/))[0].length;
    if (indent <= headerIndent) break;
    const entry = /^\s*([A-Za-z0-9_-]+):\s*(.+?)\s*$/.exec(line);
    if (entry) map[entry[1]] = entry[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return map;
}

/**
 * `lab-fetch.yml`'s own `{{ ... }}` parameters and `*` globs, as a pattern a concrete path matches.
 * @param {string} labPath @returns {RegExp}
 */
function labPathPattern(labPath) {
  // SPLIT on the placeholders rather than substituting a sentinel through them: a sentinel has to be a
  // character no path contains, and every such character is one a regex literal may not carry (`no-
  // control-regex`). Splitting leaves only real literal text to escape.
  const escaped = labPath.split(/\{\{[^}]*\}\}|\*/)
    .map((/** @type {string} */ literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[A-Za-z0-9._+-]+");
  return new RegExp(`^${escaped}$`);
}

/**
 * Where `lab:fetch` actually writes, from the playbook's own "Name it after what it actually is" task:
 * `runs/fetched/<out>.<artifact><extension of the source>`.
 *
 * The extension comes from the LAB path for the reason that task states -- every artifact was JSON until
 * `promoted-weights` (safetensors) and `promoted-changeset` (markdown), and a hardcoded `.json` here would
 * name a file after a format it is not. A globbed source keeps the extension after its last dot.
 *
 * @param {string} artifact @param {string} out @param {string} labPath
 * @returns {string}
 */
function labFetchLocalPath(artifact, out, labPath) {
  const extension = /(\.[A-Za-z0-9]+)$/.exec(labPath)?.[1] ?? ".json";
  return `runs/fetched/${out}.${artifact}${extension}`;
}

/**
 * Every `-e artifact=<name>` a `lab:fetch` invocation carries, with that same command's `-e out=`.
 * @param {string[]} commands @returns {{ artifact: string, out: string, command: string }[]}
 */
function labFetchesIn(commands) {
  /** @type {{ artifact: string, out: string, command: string }[]} */
  const fetches = [];
  for (const command of commands) {
    if (!/\blab:fetch\b/.test(command)) continue;
    const out = /-e\s+out=([A-Za-z0-9._-]+)/.exec(command)?.[1] ?? "candidate";
    for (const [, artifact] of command.matchAll(/-e\s+artifact=([A-Za-z0-9._-]+)/g)) {
      fetches.push({ artifact, out, command });
    }
  }
  return fetches;
}

/**
 * EVERY ACCEPTANCE READ THAT NAMES THE LAB'S PATH FOR AN ARTIFACT THE SAME ACCEPTANCE FETCHES -- #1973.
 *
 * `jq -e` exits 1 on a FALSE predicate and 2 on a MISSING FILE, and a shell `&&` chain cannot tell them
 * apart. So a row whose data genuinely failed its bound and a row that read the wrong path both surface as
 * "the Acceptance did not pass", and only the second is an apparatus fault. #1929 had exactly that: it
 * fetched `artifact=acceptance-report` and then read `runs/model-candidate/acceptance-report.json`, which
 * is where that file lives ON THE LAB -- locally the fetch had written
 * `runs/fetched/candidate.acceptance-report.json`, and the `jq` never evaluated its own predicate.
 *
 * NARROW ON PURPOSE, and each condition is load-bearing rather than defensive:
 *
 *   the SAME Acceptance must fetch it   a row may legitimately read a lab path in a command that runs ON
 *                                       the lab. The defect is only ever the pairing.
 *   the path must EQUAL the mapping     a pure string comparison against a checked-in file, which is what
 *                                       makes this answerable with no corpus and no lab. A path that
 *                                       merely looks lab-ish is not refused.
 *   EVERY command is scanned,          including the fetch's own. Skipping it was written first and
 *   including the fetch's own          MUTATION TESTING KILLED NOTHING: `-e artifact=<name>` names a NAME,
 *                                      never a path, so the fetch line already cannot be its own offender
 *                                      -- and the skip silently LOST the `fetch && read` one-liner, which
 *                                      is a shape this repo's Acceptance sections use routinely.
 *
 * WHAT IT THEREFORE DOES NOT CATCH: a read of some OTHER artifact's lab path, and a read whose path sits
 * inside a quoted argument `acceptancePathToken` cannot isolate. Both are silent misses, not wrong answers.
 *
 * @param {string} body a row body
 * @param {{ playbook?: string }} [deps] the playbook text, so the rule can be checked without the file
 * @returns {{ artifact: string, labPath: string, localPath: string, command: string }[]}
 */
export function labFetchPathHits(body, deps = {}) {
  const section = extractAcceptanceSection(body);
  if (section.kind !== "commands") return [];
  const fetches = labFetchesIn(section.commands);
  if (fetches.length === 0) return [];
  const artifacts = labFetchArtifacts(deps.playbook ?? readFileSync(LAB_FETCH_PLAYBOOK, "utf8"));
  /** @type {{ artifact: string, labPath: string, localPath: string, command: string }[]} */
  const hits = [];
  for (const { artifact, out } of fetches) {
    const labPath = artifacts[artifact];
    if (!labPath) continue;
    const pattern = labPathPattern(labPath);
    for (const command of section.commands) {
      for (const path of commandPathTokens(command).filter((token) => pattern.test(token))) {
        hits.push({ artifact, labPath: path, localPath: labFetchLocalPath(artifact, out, labPath), command });
      }
    }
  }
  return hits;
}

/**
 * The refusal `row-file` prints, or `null`. NAMES THE PATH MEANT, because that is the whole remedy: there
 * is exactly one right answer here, unlike the two-armed rule above, and a refusal that made the filer go
 * and read an Ansible playbook to find it would be followable only in principle (#741).
 * @param {string} body @param {string} tool the CLI to name in the refusal
 * @param {{ playbook?: string }} [deps]
 * @returns {string | null}
 */
export function labFetchPathReason(body, tool, deps = {}) {
  const hits = labFetchPathHits(body, deps);
  if (hits.length === 0) return null;
  const named = hits.map(({ labPath, localPath, artifact }) =>
    `\`${labPath}\` (where \`${artifact}\` lives ON THE LAB) should be \`${localPath}\``).join("; ");
  return `${tool}: REFUSING -- the Acceptance fetches ${hits.length === 1 ? "an artifact" : "artifacts"} `
    + `with \`lab:fetch\` and then reads the LAB's path for ${hits.length === 1 ? "it" : "them"}, not the `
    + `path the fetch writes here: ${named}. \`lab-fetch.yml\`'s own "Name it after what it actually is" `
    + "task renames every artifact to `runs/fetched/<out>.<artifact><ext>` so two candidates cannot "
    + "overwrite each other. This matters because of the DIRECTION OF THE ERROR: `jq -e` exits 1 on a "
    + "false predicate and 2 on a missing file, and a shell `&&` chain cannot tell them apart -- so a run "
    + "whose data genuinely failed its bound and this typo both read as \"the Acceptance did not pass\", "
    + "and only one of them is your code. Use the path named above.";
}

/**
 * #2099: THE SAME VERDICT, AT FILING TIME. `pr-open` already writes a refusal a reader can follow; what
 * it cannot do is write it before a builder has claimed the row and built the change. This is that
 * refusal moved to where the filer still has the context -- #879's shape, which `npm test` (see
 * `wholeSuiteAcceptanceReason`) has had since #1943 and `gh` has not.
 *
 * A DECLARATION, NEVER A BLANKET REFUSAL, and the ruling is `product-manager`'s on this row: #2084 is a
 * CORRECTLY FILED row whose Acceptance is a deliberate hand-run `gh` command, named per the template's
 * own rule for a command a runner cannot make. Refusing every `gh` Acceptance would refuse a correct row
 * -- and the template already solved exactly this for `fleet` with a declaration rather than a refusal.
 *
 * ONLY THE BARE SPELLING, deliberately. A `$ `-prefixed line classifies `prose` and keeps the
 * `EXECUTED NOTHING` refusal it already gets, which is correct and is not what this row changes: the
 * fault there is that the line was never written as a command, and it needs a different fix from this one.
 *
 * @param {string} body a row body @param {string} tool the CLI to name in the refusal
 * @returns {string | null}
 */
export function handRunAcceptanceReason(body, tool) {
  const section = extractAcceptanceSection(body);
  if (section.kind !== "commands" || handRunDeclaration(body) !== null) return null;
  const hits = section.commands.filter((command) => needsToken(stripTrailingCommentary(command)));
  if (hits.length === 0) return null;
  return `${tool}: REFUSING to file -- the Acceptance section names ${hits.map((c) => `\`${c}\``).join(", ")}, `
    + "and the `acceptance` job that runs a PR body's commands is given NO credential at all, because it "
    + "alone executes commands taken from an untrusted PR body. Run by it, a `gh` line dies on the "
    + "missing credential; `pr-open` refuses the same string later, when it costs a rewrite by somebody "
    + "with less context than you have now. If a human is meant to run it -- which is a perfectly good "
    + "row -- say so in the body: a `Hand-run: <who runs it and why>` line, the `Acceptance:`/`Closes:`/"
    + "`Not-before:` family, makes the job report `NOT RUN` naming your reason instead. The PR that "
    + "closes the row must then paste that run under a `## Hand-run output` heading (#2118) -- a declared "
    + "hand-run with no pasted output is refused, so know the cost now rather than at `pr-open`. "
    + "Otherwise name a command this job can run.";
}

/** @type {Map<string, string[]>} */
const suiteFilesCache = new Map();

/**
 * Every `.test.ts` glob a `package.json` script runs, INCLUDING the ones it delegates to.
 *
 * `test` carries no glob of its own -- it is `npm run test:ts && npm run test:python` -- so resolving it
 * means following what it invokes. Doing that here rather than hard-wiring `test -> test:ts` keeps the
 * mapping where `package.json` already states it: the day `test` stops delegating to `test:ts`, this
 * follows, and a retyped pair would not. A delegate with no glob (`test:python`, whose population is the
 * pytest tree) contributes nothing, which is the right answer rather than a special case.
 *
 * `seen` is cycle protection, not memoisation: `a -> b -> a` in a scripts file would otherwise recurse
 * forever, and a scripts file is not this module's to trust.
 *
 * @param {Record<string, unknown> | undefined} scripts @param {string} name @param {Set<string>} seen
 * @returns {string[]}
 */
function suiteGlobsOf(scripts, name, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const script = scripts?.[name];
  if (typeof script !== "string") return [];
  const own = [...script.matchAll(/"([^"]*\*[^"]*\.test\.ts)"/g)].map((match) => match[1]);
  const delegated = [...script.matchAll(/npm\s+run\s+([\w:-]+)/g)]
    .flatMap((match) => suiteGlobsOf(scripts, match[1], seen));
  return [...own, ...delegated];
}

/**
 * Every test file ONE named suite script runs, FROM THAT SCRIPT'S OWN GLOB rather than a second copy of it.
 *
 * TAKES THE SCRIPT NAME, AND #2153 IS WHY. This used to read `test:all`'s glob for every caller while
 * `runsTheWholeSuite` recognised only `npm test`/`npm run test:ts` -- so the narrow commands were charged
 * the wide population (419 of 641 files they never load, one of which refused them) and the wide ones
 * were not recognised at all and charged nothing. The predicate names the script now, and the population
 * comes from that same script: one fact, read once, in the file that already states it.
 *
 * The glob is read out of `package.json` because a hand-written copy here would be the same fact in two
 * places -- and the copy that drifts is the one that decides whether a PR's check goes red. If the file
 * cannot be read, or the named script resolves to no glob at all, this THROWS rather than returning `[]`:
 * an empty population would make that whole-suite command pass the capability gate, which is exactly the
 * hole this function was added to close -- and an unrecognised script name must reach that throw rather
 * than fall through to "this command names no test files", which is how `npm run test:all` used to pass.
 *
 * @param {string} script a `package.json` script name, e.g. `test`, `test:ts`, `test:org`, `test:all`
 * @returns {string[]}
 */
export function suiteTestFiles(script) {
  const cached = suiteFilesCache.get(script);
  if (cached) return cached;
  let scripts;
  try {
    scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  } catch (cause) {
    throw new Error("acceptance-commands: could not read package.json to find what `npm run " + script
      + "` runs -- refusing to report a whole-suite command as needing nothing.", { cause });
  }
  const globs = suiteGlobsOf(scripts, script);
  if (globs.length === 0) {
    throw new Error(`acceptance-commands: \`${script}\` names no \`*.test.ts\` glob and delegates to no `
      + "script that does, so the suite's population is unknown. Refusing to treat that as an empty "
      + "population -- that acceptance command would then pass the capability gate having examined "
      + "nothing.");
  }
  const files = [...new Set(globs.flatMap((glob) => globSync(glob)))];
  suiteFilesCache.set(script, files);
  return files;
}

/**
 * The files a command runs: the ones it NAMES, or -- for a whole-suite command -- the UNION over every
 * script it invokes. NOT `runsTheWholeSuite` + a fixed population (#2153): the same command string decides
 * both halves, so they cannot answer about different suites. The union rather than the first script
 * (#2207): a chain runs each of them, and charging it one leaves the rest's requirements unread.
 * @param {string} command
 * @returns {string[]}
 */
function testFilesRunBy(command) {
  const scripts = suiteScriptsFor(command);
  if (scripts.length === 0) return tsxTestFileArgs(command);
  return [...new Set(scripts.flatMap((script) => suiteTestFiles(script)))];
}

/**
 * The literal file/glob arguments of a `tsx --test <...>` command, in order -- split out of
 * `testFileArgumentsResolve` so the #510 requirements check below reads the SAME tokenisation rather than
 * risking a second, independently-written answer to "what files does this command name" (this file's own
 * most-repeated lesson, one row up).
 * @param {string} command
 * @returns {string[]}
 */
function tsxTestFileArgs(command) {
  const withoutTrailingComment = command.replace(/(?:^|\s)#.*$/, "");
  const tokens = withoutTrailingComment.split(/\s+/).filter(Boolean);
  return tokens
    .filter((token) => token !== "npx" && token !== "tsx" && token !== "--test" && !token.startsWith("-"))
    .map((token) => token.replace(/^['"]|['"]$/g, ""));
}

/**
 * For a `tsx --test <file(s)>` command, every requirement a REAL file it names declares that this job's
 * `capabilities` do not satisfy -- grouped by requirement, naming every declaring file, so a refusal reads
 * as a fact about the tests rather than an opaque code. Glob arguments and files that do not exist are
 * skipped here on purpose: whether a file exists at all is `testFileArgumentsResolve`'s own question, and
 * a glob's members are not individually readable without expanding it, which this check does not attempt.
 * @param {string} command
 * @param {JobCapabilities} capabilities
 * @returns {{ requirement: string, files: string[] }[]}
 */
export function unmetCommandRequirements(command, capabilities) {
  if (!/\btsx\s+--test\b/.test(command) && !runsTheWholeSuite(command)) return [];
  /** @type {Map<string, string[]>} */
  const byRequirement = new Map();
  for (const fileArg of testFilesRunBy(command)) {
    if (/[*?[{]/.test(fileArg) || !existsSync(fileArg)) continue;
    const text = readFileSync(fileArg, "utf8");
    for (const req of unmetRequirements(testFileRequirements(text), capabilities)) {
      if (!byRequirement.has(req)) byRequirement.set(req, []);
      /** @type {string[]} */ (byRequirement.get(req)).push(fileArg);
    }
  }
  return [...byRequirement.entries()].map(([requirement, files]) => ({ requirement, files }));
}

/**
 * The #621 counterpart to `unmetCommandRequirements` above -- CLOSURE-DERIVED rather than header-declared,
 * so it catches `board-style.test.ts` (no `// requires:` header at all) the same way it catches a file
 * that declared one honestly. Checked FIRST in `classifyCommand`, because a header that under-declares is
 * itself a refusal (#621's own framing): whatever the header says, the closure is what actually runs.
 * @param {string} command
 * @param {JobCapabilities} capabilities
 * @returns {{ requirement: string, message: string }[]}
 */
export function unmetCommandClosureRequirements(command, capabilities) {
  if (!/\btsx\s+--test\b/.test(command) && !runsTheWholeSuite(command)) return [];
  /** @type {{ requirement: string, message: string }[]} */
  const out = [];
  for (const fileArg of testFilesRunBy(command)) {
    if (/[*?[{]/.test(fileArg) || !existsSync(fileArg)) continue;
    out.push(...unmetClosureRequirements(fileArg, capabilities));
    // SHORT-CIRCUIT ON THE FIRST, and only for the whole-suite case: `classifyCommand` prints one
    // refusal, and walking ~700 files' import closures to collect the other 699 is time spent producing
    // a message nobody reads. A named command still reports every one of the few files it names.
    if (out.length > 0 && runsTheWholeSuite(command)) break;
  }
  return out;
}

/**
 * Does ANY real `tsx --test` file named across `commands` actually declare `// requires: history`? #497's
 * own stated boundary: "a PR carrying `History: full` and no historical fixture is asking for something it
 * does not use -- worth a warning, not a refusal, since the cost is only time." So this is checked
 * independent of `unmetCommandRequirements` (which asks whether a declared requirement is SATISFIED, not
 * whether the declaration exists at all) -- a file naming `requires: history` always counts as "used" here,
 * whether or not `capabilities.history` happens to be true.
 *
 * #621: ALSO true when the CLOSURE reaches `history` with no header at all -- a file whose `// requires:`
 * header omits `history` but whose real dependency needs it is exactly the shape this whole row exists
 * to stop reading as "unused." Checked via `deriveClosureRequirements` directly, not `capabilities`: this
 * question is "does the command use it," never "does the job have it."
 * @param {string[]} commands
 * @returns {boolean}
 */
function anyCommandUsesHistory(commands) {
  return commands.some((command) => {
    if (!/\btsx\s+--test\b/.test(command)) return false;
    return tsxTestFileArgs(command).some((fileArg) => {
      if (/[*?[{]/.test(fileArg) || !existsSync(fileArg)) return false;
      if (testFileRequirements(readFileSync(fileArg, "utf8")).includes("history")) return true;
      return deriveClosureRequirements(fileArg).some((hit) => hit.requirement === "history");
    });
  });
}

/**
 * Pure. Never executes anything -- just decides whether this command is this job's to run.
 *
 * #446: A THIRD VERDICT, "prose", for a line that was never a command at all -- either its first token
 * resolves to no executable anywhere (`"full suite green, 3306 pass 0 fail"` -> no `full`), or it resolves
 * to one of a small set of builtins whose exit code can never verify anything (`echo`, `true`, `:`, `test`,
 * `time`, `[`). Checked AFTER the existing fleet/lab/corpus refusals, deliberately: `npm run fleet:deploy`
 * has a perfectly real executable (`npm`) as its first token, and must still be REFUSED for the reason
 * already named there, not reclassified as prose for having a valid executable.
 *
 * `commandExists` IS INJECTABLE (`deps.commandExists`), defaulting to the real, subprocess-free `$PATH`
 * check above -- so a test can assert on a specific token resolving or not without depending on what
 * happens to be installed on whichever machine runs the suite.
 *
 * #510: `capabilities` defaults to `FULL_CAPABILITIES` -- every existing caller that never mentions the
 * new parameter keeps behaving exactly as before, because nothing is unmet against a job that can do
 * everything. `main()` passes the REAL job's capabilities; a test passes whatever it wants to exercise.
 *
 * #516: `section` IS OPTIONAL AND DEFAULTS TO `undefined` -- naming `mutate` is perfectly valid on an
 * `Acceptance:` line, where success-is-exit-0 already agrees with `mutate`'s own contract; the inversion
 * (see `MUTATE_PATTERN`'s own comment) exists only under `Refutation:`. Checked FIRST, alongside the
 * fleet/lab/corpus refusals and with the identical verdict (`"refused"`, `ok: true`) -- #516's own stated
 * acceptance is that this is the SAME mechanism, a new pattern in the seam that already refuses a command
 * this job cannot honestly interpret, not a new one. `UNNEGATED` only: `! npm run mutate ...` already
 * un-inverts the exit code at the shell level, so it is left alone -- refusing it too would be enforcing
 * an opinion about the rejected #386/#440 idiom rather than catching the actual collision.
 *
 * @param {string} command
 * @param {{ commandExists?: (token: string) => boolean, capabilities?: JobCapabilities,
 *           section?: "ACCEPTANCE" | "REFUTATION" }} [deps]
 * @returns {Classification}
 */
export function classifyCommand(command,
  { commandExists: exists = commandExists, capabilities = FULL_CAPABILITIES, section } = {}) {
  if (section === "REFUTATION" && MUTATE_PATTERN.test(command) && !/^!\s/.test(command.trim())) {
    return { verdict: "refused",
      reason: "inverts the Refutation: verdict -- mutate's exit 0 means the guard BITES, but Refutation: "
        + "reads success as any NON-ZERO exit (#438), so a guard that did NOT bite (exit 1) would read as "
        + "REFUSED, the passing state. Paste mutate's real output under an unparsed heading instead "
        + "(#504), or move this line to Acceptance: if exit-0-is-good is genuinely what you mean" };
  }
  for (const [pattern, reason] of [...FLEET_LAB_PATTERNS, ...CORPUS_PATTERNS]) {
    if (pattern.test(command)) return { verdict: "refused", reason };
  }
  // #2099: THE FOURTH CAPABILITY, CHECKED THE WAY THE OTHER THREE ARE. A bare `gh ...` line classified
  // `runnable`, so the job RAN it and it died on the missing credential -- the job knows it has no token
  // and the classifier never asked. Beside the fleet/lab/corpus patterns because it is the same kind of
  // fact: a command this job cannot honestly attempt, refused by name rather than by exit code.
  //
  // GUARDED BY `capabilities.token`, for #510's reason: `FULL_CAPABILITIES` is the default, so every
  // caller that never mentions capabilities keeps classifying `gh` exactly as before.
  const noToken = tokenRefusal(command, capabilities, section);
  if (noToken) return noToken;
  // #621: CLOSURE-DERIVED, CHECKED FIRST -- whatever the header says. `board-style.test.ts` has no
  // `// requires:` header at all and is refused here regardless; a file that DOES declare one correctly
  // is refused here too, on the identical evidence, so declaring honestly never changes which branch a
  // command takes -- only whether the message happens to also match a hand-written comma list.
  const [firstUnmetClosure] = unmetCommandClosureRequirements(command, capabilities);
  if (firstUnmetClosure) {
    return { verdict: "refused",
      reason: `needs \`${firstUnmetClosure.requirement}\`, which this job does not have -- `
        + firstUnmetClosure.message };
  }
  const [firstUnmet] = unmetCommandRequirements(command, capabilities);
  if (firstUnmet) {
    return { verdict: "refused",
      reason: `needs \`${firstUnmet.requirement}\`, which this job does not have -- declared by `
        + firstUnmet.files.join(", ") };
  }
  const token = firstRealToken(command);
  if (!token) {
    return { verdict: "prose", reason: "is not a command (the line is empty)" };
  }
  const bareToken = token.replace(/^['"]|['"]$/g, "");
  if (UNVERIFIABLE_BUILTINS.has(bareToken)) {
    return { verdict: "prose",
      reason: `cannot verify anything -- \`${bareToken}\`'s exit code says nothing about whether the `
        + "claim in this line is true" };
  }
  if (!exists(token)) {
    return { verdict: "prose", reason: `is not a command (no executable "${token}")` };
  }
  return { verdict: "runnable" };
}

/**
 * #728: the shell construct that makes a line's `tsx --test` arguments something other than this
 * command's argv, or null when there is none.
 *
 * NAMED RATHER THAN COUNTED, because the message has to be followable: "it contains a pipe" sends the
 * reader to the right character, where "cannot parse" sends them to re-read the whole line.
 *
 * Deliberately NOT a shell parser. This is the list of constructs that relocate the arguments, and
 * anything outside it is still tokenised as before -- a guard that refuses what it does not recognise
 * would refuse every ordinary command the moment someone added a new flag.
 *
 * @param {string} command
 * @returns {string | null}
 */
function unparseableConstruct(command) {
  const withoutTrailingComment = command.replace(/(?:^|\s)#.*$/, "");
  for (const [pattern, name] of /** @type {[RegExp, string][]} */ ([
    [/\|\|/, "a `||`"],
    [/&&/, "an `&&`"],
    [/\|/, "a pipe"],
    [/\$\(|`/, "a subshell"],
    [/[<>]/, "a redirection"],
    [/;/, "a `;`"],
  ])) if (pattern.test(withoutTrailingComment)) return name;
  return null;
}

/**
 * DOES A `tsx --test` COMMAND'S FILE/GLOB ARGUMENT ACTUALLY MATCH ANYTHING? -- #353's fifth hazard, found
 * on #350 an hour before this shipped: `npx tsx --test "packages/lab/src/packaging/nothing-matches-*"`
 * exits 0 with NO diagnostic at all when the pattern matches nothing, and a typo'd path MIXED with one
 * real file exits 0 too -- so "the command exited 0" is not proof the tests it claims to run ever ran.
 * Checked BEFORE running, never inferred from the exit code, because the exit code is exactly the thing
 * this hazard makes unreliable.
 *
 * Scoped to `tsx --test` specifically (never generalised to "any command with a path-shaped argument"):
 * that is the concrete, measured defect, and treating every argument to every command as a file path
 * would produce false refusals on the many acceptance commands that take URLs, flags, or option values
 * that merely look like paths.
 *
 * #419: A TRAILING `# comment` IS NOT A FILE ARGUMENT. Bash itself already treats an unquoted `#` as
 * starting a comment, so `npx tsx --test foo.test.ts  # 2/2, pass` runs perfectly for real -- but this
 * check tokenised the whole line and read `#`, `2/2` and `pass` as file arguments nothing on disk could
 * ever match. Stripped for TOKEN EXTRACTION only, never from the command that actually runs: bash was
 * always going to ignore it, so removing it here only makes this check agree with what execution already
 * does.
 *
 * @param {string} command
 * @returns {{ ok: true } | { ok: false, missing: string[] } | { ok: false, unparseable: string }}
 */
export function testFileArgumentsResolve(command) {
  if (!/\btsx\s+--test\b/.test(command)) return { ok: true };
  // #728: WHAT THIS CANNOT PARSE, IT MUST NOT MAKE CLAIMS ABOUT.
  //
  // `tsxTestFileArgs` splits the WHOLE line on whitespace, so on
  // `node packages/guards/src/tree-wide-guards.mjs | xargs npx tsx --test` it reported
  // `matched no file: node, |, xargs` -- a claim about the filesystem, and a false one. `|` is not a
  // filename at all, and a reader following that message goes looking for missing test files.
  //
  // #419 closed the BACKTICK form of this and the pipe form was never considered. The refusal is right;
  // the assertion about what it checked is the defect -- the same class as `row-reachability` reporting
  // a Region-scoped search as a whole-tree one (#719).
  const construct = unparseableConstruct(command);
  if (construct) return { ok: false, unparseable: construct };
  const missing = tsxTestFileArgs(command).filter((pattern) => {
    if (/[*?[{]/.test(pattern)) {
      try {
        return globSync(pattern).length === 0;
      } catch {
        return true;
      }
    }
    return !existsSync(pattern);
  });
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

// The full set of field names this parser recognises as SECTION HEADERS -- shared between the header
// pattern (where a section starts) and the stop pattern (where it ends), so the two can never disagree
// about what a header looks like. #438 added "Refutation" here rather than inventing a second parser: a
// bare `Refutation:` line has to end an in-progress `Acceptance:` block exactly the way `Mutation:`
// already did, or the refutation commands would be silently swallowed as more acceptance commands.
const SECTION_FIELD_NAMES = ["Acceptance", "Refutation", "Mutation"];

/**
 * #506: A MARKDOWN HEADING'S TRAILING TEXT IS A TITLE, NOT A COMMAND -- unless a colon follows the field
 * name, which is the one shape the inline-command form actually means (`Acceptance: <command>`, the shape
 * #353's own acceptance test uses). The single pattern this used to be could not tell the two apart: `##
 * Acceptance:?` and `(.*)` shared one capture group, so `## Acceptance -- old read vs new` and `##
 * Acceptance: npm test` produced the identical shape, and `extractSection` ran the FIRST as a command.
 * Caught live on PR #500: `## Acceptance — old read vs new, on the live queue` sent `— old read vs new, on
 * the live queue` to bash. Before #446 this would have been silently EXECUTED (a real word like `test` at
 * the front exits 0 on any non-empty string, a green acceptance that ran nothing -- #446's own defect,
 * arriving through the heading instead of a body line); after #446 it is a loud but wrongly-attributed
 * refusal, naming the missing executable rather than the heading that produced it.
 *
 * Two separate patterns, because a heading and the bold/plain form disagree about what "no colon" means:
 * a bare `## Acceptance` heading with no colon at all is the ESTABLISHED (#419) "commands come from the
 * lines below" shape, so a heading with prose after it and no colon must read the identical way, never as
 * a command. The bold/plain form has no such ambiguity -- `Acceptance:` always requires the colon to match
 * at all, so anything it captures was always meant as inline.
 *
 * THE LINE-START ANCHOR (`^\s*`) IS DELIBERATE, AND #522 IS THE PROOF -- both directions at once. #506
 * (above) is a heading whose trailing text was wrongly taken as a command; the mirror fault is prose
 * ABOUT the field being wrongly taken as its header. #522's own PR body says "an Acceptance/Refutation
 * command's file actually declares..." mid-sentence, and this parser correctly reads that as prose, not a
 * header -- which is also why that same PR shipped with no real `Acceptance:` section at all (a body full
 * of correctly-ignored mentions is indistinguishable, to an author skimming it, from one that declares a
 * real command). Widening the match to be more forgiving of one direction reliably breaks the other; both
 * behaviours are currently correct and in tension, which is why the anchor stays exactly this strict.
 * @param {string} fieldName
 * @returns {{ heading: RegExp, plain: RegExp }}
 */
function sectionHeaderPatterns(fieldName) {
  return {
    heading: new RegExp(`^\\s*#{1,6}\\s+${fieldName}(:)?\\s*(.*)$`),
    plain: new RegExp(`^\\s*(?:\\*\\*|__)?${fieldName}:(?:\\*\\*|__)?\\s*(.*)$`),
  };
}

/**
 * Whether `line` is this field's header, and -- the fact `sectionHeaderPatterns` alone cannot answer --
 * whether its trailing text is a command at all. `inline: null` means "matched, but nothing here is a
 * command" (a title-only heading); `inline: ""` and a non-empty string are both real captures, exactly as
 * the bare-header and inline-command shapes already behaved.
 * @param {string} fieldName
 * @param {string} line
 * @returns {{ matched: false } | { matched: true, inline: string | null }}
 */
function matchSectionHeader(fieldName, line) {
  const { heading, plain } = sectionHeaderPatterns(fieldName);
  const headingMatch = heading.exec(line);
  if (headingMatch) {
    const hasColon = headingMatch[1] === ":";
    return { matched: true, inline: hasColon ? headingMatch[2].trim() : null };
  }
  const plainMatch = plain.exec(line);
  if (plainMatch) return { matched: true, inline: plainMatch[1].trim() };
  return { matched: false };
}

/**
 * Every line index where `fieldName`'s header matches -- ALL of them, never just the first. #540:
 * `extractSection` used to stop at `lines.findIndex`'s first hit, so a second `Acceptance:`/`Refutation:`
 * header was invisible -- not truncated, not warned about, simply never looked at again. See this file's
 * own header comment for why the remedy here is to report the ambiguity (a new DUPLICATE outcome) rather
 * than to concatenate every section the way #527 concatenates repeated `Closes:` lines.
 * @param {string} fieldName
 * @param {string[]} lines
 * @returns {number[]}
 */
function headerIndices(fieldName, lines) {
  return lines
    .map((line, index) => (matchSectionHeader(fieldName, line).matched ? index : -1))
    .filter((index) => index !== -1);
}

/**
 * Pure. Finds a named section (`Acceptance:` or `Refutation:`) of a PR body and returns what it says,
 * never what it should say. One parser for both fields -- #438's own rule, because this parser has
 * already been fixed five times for forms authors keep writing (#419, #424, #432), and a second dialect
 * would need every one of those fixes again, silently, one form at a time.
 *
 * Supports two shapes, both seen in real PR bodies in this repo: the command INLINE on the header's own
 * line (`Acceptance: node -e "process.exit(1)"` -- the exact shape #353's own acceptance test uses), or a
 * bare header followed by one command per subsequent non-empty, non-comment line, up to a blank line, a
 * markdown heading, a fenced-code delimiter (stripped, not treated as a command), or another section's
 * header, whichever comes first.
 *
 * #419: A MARKDOWN HEADING IS THE HEADER TOO. `## Acceptance`, `## Acceptance:` and `### Acceptance:` all
 * used to parse as MISSING, because the pattern was anchored at the START of the line with no notion of a
 * `#` prefix -- and every OTHER section in this repo's own PR template uses `## ` headings, so that is the
 * natural shape an author reaches for. Four of seven open PRs failed on it at once. There is no reading in
 * which `## Acceptance` means something other than the field, so it is accepted rather than warned about --
 * "anything relying on a human to remember does not happen" applied to a parser instead of a person.
 *
 * #540: MORE THAN ONE HEADER RETURNS `{ kind: "duplicate" }` -- naming every occurrence's line number and
 * raw text -- rather than picking one silently. THE JOB FAILS on it, same as MISSING, because a body this
 * parser cannot read unambiguously is not one it should guess at.
 *
 * @param {string} fieldName
 * @param {string | null | undefined} body
 * @returns {Section}
 */
function extractSection(fieldName, body) {
  const text = body ?? "";
  const lines = text.split(/\r\n|\r|\n/);
  const indices = headerIndices(fieldName, lines);
  if (indices.length === 0) return { kind: "missing" };
  if (indices.length > 1) {
    return { kind: "duplicate",
      occurrences: indices.map((index) => ({ line: index + 1, text: lines[index].trim() })) };
  }
  const [headerIndex] = indices;

  const headerMatch = matchSectionHeader(fieldName, lines[headerIndex]);
  // `inline === null` is a title-only heading (#506) -- there is nothing here to run, and it must fall
  // through to `commandLinesAfter` exactly like a bare `## Acceptance` with nothing on its own line.
  const inline = (headerMatch.matched ? headerMatch.inline : null) ?? "";

  const noneMatch = /^none\b\s*[-—]?\s*(.*)$/i.exec(inline);
  if (noneMatch) {
    const reason = noneMatch[1].trim();
    // A STATED reason is what makes "deliberately none" different from silence -- without one, this is
    // not an honest opt-out, it is the missing case wearing the word "none" as a disguise.
    return reason.length > 0 ? { kind: "none", reason } : { kind: "missing" };
  }

  if (inline.length > 0) return { kind: "commands", commands: [unwrapBackticks(inline)] };

  const commands = commandLinesAfter(lines, headerIndex);
  return commands.length > 0 ? { kind: "commands", commands } : { kind: "missing" };
}

/**
 * @param {string | null | undefined} body
 * @returns {Section}
 */
export function extractAcceptanceSection(body) {
  return extractSection("Acceptance", body);
}

/**
 * #438: A GUARD CAN ONLY BE SHOWN TO BITE BY A COMMAND WHOSE SUCCESS IS A NON-ZERO EXIT, and
 * `acceptanceReport` hardcoded `passed = code === 0` -- so a PR demonstrating a refusal (the guard
 * correctly refusing a known-bad input) was reported as this job's own failure for doing exactly what it
 * set out to prove. Optional, unlike `Acceptance:` -- most PRs never refuse anything, so its absence is
 * not a MISSING verdict, it just means there is nothing more to run.
 * @param {string | null | undefined} body
 * @returns {Section}
 */
export function extractRefutationSection(body) {
  return extractSection("Refutation", body);
}

/**
 * #419: A BACKTICKED COMMAND IS STILL THE COMMAND. This repository's own prose convention wraps a command
 * in single backticks (`` `like this` ``), and that is exactly wrong for a line the extractor hands
 * verbatim to bash -- the backticks stayed attached, so the file check saw `` `npx `` as a token and
 * reported it missing for a command that runs perfectly. Stripped only when they wrap the WHOLE command
 * (start and end), never partial backticks inside one, which are the author's own quoting to preserve.
 *
 * #658: A CLOSING BACKTICK IS ALSO AN UNAMBIGUOUS END-OF-COMMAND MARKER ON ITS OWN, even when it is not
 * the LAST character of the line -- "`npx tsx --test x.test.ts` — 12/12 passing, was 7" used to fail the
 * whole-line-wrap test above (the backtick was no longer at the end), so the leading backtick stayed
 * attached and became part of the executable name: `is not a command (no executable "`npx")`, a message
 * that sends a reader to check whether npx is installed, never to suspect a stray backtick. A line that
 * OPENS with a backtick and has a later closing one is still exactly the #419 shape; everything after the
 * close is discarded the same way `extractSection`'s own inline-command form already discards everything
 * before a header's colon -- a boundary the author drew, not text this parser gets to keep by default.
 * @param {string} command
 * @returns {string}
 */
function unwrapBackticks(command) {
  if (/^`[^`]+`$/.test(command)) return command.slice(1, -1);
  const trailingProseAfterClose = /^`([^`]+)`/.exec(command.trim());
  return trailingProseAfterClose ? trailingProseAfterClose[1] : command;
}

// #658: TRAILING PROSE AFTER AN EM-DASH (U+2014 "—", never the ASCII "--") IS COMMENTARY, NEVER PART OF
// THE COMMAND -- for a BARE line with no backticks at all, which has no delimiter as unambiguous as a
// closing backtick. Real Acceptance lines write their own result this way --
// "npx tsx --test x.test.ts — 12/12 passing" -- and a BARE command in this shape used to classify
// `runnable` with the prose going straight into argv: the command RAN, for real, with
// "— 12/12 passing" as extra arguments, and failed on a file that does not exist -- a genuine command
// failure that blames the test rather than the body that produced it, which is the more expensive half of
// #658 and the one that was not noticed first.
//
// Deliberately NOT done inside `unwrapBackticks`/`extractSection` -- `heading-title-not-command.test.ts`
// pins that a bare line's raw text (including one that happens to contain an em-dash, like a literal
// command named "none — nothing to run") survives EXTRACTION unchanged, and that only `classifyCommand`
// decides whether it is runnable. So this strips at the point a command is actually turned into argv and
// run, in `runOneCommand` below, never at extraction -- the reported line still shows the ORIGINAL text
// so an author can see exactly what was written, while only the truncated form is classified and executed.
//
// The em-dash is the safe, unambiguous marker for THIS purpose: a real shell command practically never
// contains that exact Unicode character, unlike the ASCII `--`, which is common, real flag syntax
// (`npm run build -- --production`) and must NEVER be treated as a delimiter here -- truncating there
// would silently drop a command's own arguments.
const TRAILING_COMMENTARY = /\s+—.*$/;

/**
 * @param {string} command
 * @returns {string}
 */
function stripTrailingCommentary(command) {
  return command.replace(TRAILING_COMMENTARY, "").trimEnd();
}

// #2088: THE CHARACTERS THAT END A WORD, so a `#` immediately after one of them starts a NEW word and
// therefore a comment. This is bash's own METACHARACTER set, named here rather than left as a regex
// class because the MEMBERSHIP is the whole point and has to be readable back:
//
//   - Whitespace is only five of the ten. `;`, `|`, `&`, `(`, `)`, `<` and `>` end a word just as hard,
//     which is why `echo a;# don't` is two commands in bash and was one swallowed command here.
//   - A QUOTE IS NOT IN HERE AND NEEDS NO ENTRY, which is a claim about the loop rather than the set.
//     A quote does not end a word -- `echo 'a'# don't` leaves the `#` inside the same word, so the `'`
//     in `don't` opens for real and bash says `unexpected EOF while looking for matching '`. The scan
//     gets that right because every quote character is consumed by a branch that `continue`s before
//     word state is updated, so this set is never consulted for one. Adding `'` and `"` to it is
//     therefore INERT -- measured, not assumed: that mutant survives the whole suite. What is NOT
//     inert is looking the set up against `text[i - 1]` instead of carrying the state; that mutant is
//     killed by the escape row in `#2088 THE CONTROLS`.
const WORD_ENDING_METACHARACTERS = new Set(["|", "&", ";", "(", ")", "<", ">", " ", "\t", "\n"]);

/**
 * #2068: DOES THIS TEXT END WITH A QUOTE STILL OPEN? -- the second spelling of "this command is not
 * finished yet", and the reason it has to be scanned rather than matched by a regex.
 *
 * A regex counting quotes cannot tell an APOSTROPHE from an opening quote, and this repository's own
 * Acceptance lines are full of both: `npm run x # don't skip` is balanced and must never join, while
 * `node -e 'const a = 1;` is not and must. Tracking state across the line answers both with one rule, and
 * it is bash's own rule -- inside `'`, nothing escapes and `"` is literal; inside `"`, `\` escapes the
 * next character and `'` is literal; outside both, `\` escapes and an unquoted `#` starting a word begins
 * a comment that runs to end of line, so a `'` inside it is text rather than syntax.
 *
 * #2088: THAT EXAMPLE USED TO BE STATED TOO BROADLY, and the overstatement was the defect. `npm run x #
 * don't skip` is balanced ONLY because of the space before the `#`: the scanner asked whether the
 * previous character was WHITESPACE, so `npm run x;# don't skip` -- two commands to bash, one comment
 * and an apostrophe inside it -- walked into the comment text, opened a quote on the `'`, never closed
 * it, and JOINED the next Acceptance command onto this one. `acceptance` then reported on a command
 * nobody wrote. A word begins after any of `WORD_ENDING_METACHARACTERS`, not after whitespace alone.
 *
 * Word start is CARRIED rather than looked back at, because `text[i - 1]` cannot see an escape: in
 * `echo a\;# x` the `;` is literal, the word never ended, and bash keeps the `#` as text -- so reading
 * the raw previous character would call a comment where there is none, the mirror of the bug above.
 *
 * It is deliberately NOT a full shell parser: `$(…)`, backticks and heredocs also span lines, and none of
 * them is the measured shape (#1989's four-line `node --input-type=module -e '…'`). A shape this does not
 * recognise is read exactly as it was before -- one line, one command -- rather than guessed at.
 * @param {string} text
 * @returns {boolean}
 */
export function endsInsideQuote(text) {
  /** @type {string | null} */
  let quote = null;
  // The start of the text is the start of a word; everything else is decided as the scan passes it.
  let atWordStart = true;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote === "'") { if (char === "'") quote = null; continue; }
    if (quote === '"') {
      if (char === "\\") { i += 1; continue; }
      if (char === '"') quote = null;
      continue;
    }
    if (char === "\\") { i += 1; atWordStart = false; continue; }
    if (char === "'" || char === '"') { quote = char; atWordStart = false; continue; }
    // An unquoted `#` at the start of a word is a comment: everything after it is text, so nothing in it
    // can open a quote. Returning here rather than breaking states that an open quote BEFORE a comment is
    // impossible by construction -- `quote` is null on this branch.
    if (char === "#" && atWordStart) return false;
    atWordStart = WORD_ENDING_METACHARACTERS.has(char);
  }
  return quote !== null;
}

/**
 * #419: A `\` LINE CONTINUATION IS ONE COMMAND, NOT TWO. Read line by line, a shell continuation split the
 * command in half: the first half ended in a dangling backslash and the second half became its OWN
 * "command" -- a bare filename or flag that fails the moment it is run on its own. Joins forward from
 * `startIndex` while the accumulated text still ends in `\`, so an author can chain any number of
 * continuation lines exactly as they would in a real shell script.
 *
 * #2068: AN UNCLOSED QUOTE IS THE SAME FACT IN ANOTHER SPELLING, and it cost a red `acceptance` and a red
 * `gate` on a row whose command was correct (#1989 on PR #2064, run 35832677295): a four-line
 * `node --input-type=module -e '…'` reached `/bin/bash -c` as four fragments, the first of them
 * `unexpected EOF while looking for matching '`. bash itself would have kept reading, so this does --
 * JOINING rather than refusing, because unlike #540's two `Acceptance:` headers there is exactly one
 * reading of an unclosed quote, and an author who reflows nothing gets the command they wrote.
 *
 * THE TWO JOINS ARE NOT THE SAME JOIN, because the author wrote different things. A `\` continuation is
 * bash's own "pretend the newline is not there", so the lines are joined by a SPACE with the backslash
 * dropped. A newline inside a quote is a LITERAL newline in the string -- what `python -c` indentation and
 * any multi-line here-string depend on -- so those lines are joined by the newline itself, and the
 * continuation keeps its leading whitespace for the same reason.
 *
 * `limit` is exclusive and stops the scan at the end of the block (the closing fence, or whatever ends a
 * bare one). Without it an unclosed quote -- a real typo, not a continuation -- would swallow the closing
 * fence and every section after it, turning one malformed command into a body this parser reads wrongly
 * end to end.
 * @param {string[]} lines
 * @param {number} startIndex
 * @param {string} firstLine
 * @param {number} limit exclusive index past which no line may be consumed
 * @returns {{ command: string, consumed: number }}
 */
function joinContinuations(lines, startIndex, firstLine, limit) {
  let command = firstLine;
  let consumed = 0;
  while (startIndex + consumed + 1 < limit) {
    const next = lines[startIndex + consumed + 1];
    // Quote state first: a trailing `\` INSIDE a single-quoted string is a literal backslash, never a
    // continuation, so asking about the quote before the backslash is what keeps that one intact.
    if (endsInsideQuote(command)) command = `${command}\n${next.replace(/\s+$/, "")}`;
    else if (/\\\s*$/.test(command)) command = `${command.replace(/\\\s*$/, "").trimEnd()} ${next.trim()}`;
    else break;
    consumed += 1;
  }
  return { command, consumed };
}

/**
 * #2068: THE EXCLUSIVE INDEX AT WHICH THE BLOCK A COMMAND STARTED IN ENDS -- where `joinContinuations` must
 * stop. Inside a fence that is the closing fence; in a bare block it is the first line that would have
 * ended the block anyway (blank, markdown heading, or another section's header), so a continuation can
 * never consume a line the loop itself would have stopped at.
 * @param {string[]} lines
 * @param {number} startIndex
 * @param {boolean} inFence
 * @returns {number}
 */
function blockEndAfter(lines, startIndex, inFence) {
  for (let i = startIndex + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (inFence ? trimmed.startsWith("```") : (trimmed === "" || /^#{1,6}\s/.test(trimmed)
      || isSectionHeaderLine(trimmed))) return i;
  }
  return lines.length;
}

/**
 * #438's stop rule, as a predicate: is this line another section's bare header? Named because
 * `blockEndAfter` has to ask the identical question the loop asks, and a second regex that could disagree
 * about what ends a block is this repository's most-recorded shape one level up.
 * @param {string} trimmed
 * @returns {boolean}
 */
function isSectionHeaderLine(trimmed) {
  // #2118: `Hand-run output` joins the stop set through its OWN predicate rather than through
  // `SECTION_FIELD_NAMES`, because its name carries a space and the pattern built from that list would
  // demand exactly one. The rule it is here for is #438's unchanged: a bare `**Hand-run output:**` line
  // under an in-progress `Acceptance:` block ends that block instead of being read as one more command --
  // which is precisely what happened to `History: full` in #1036, and the whole reason that record exists.
  return handRunOutputHeader(trimmed).matched
    || SECTION_FIELD_NAMES.some((name) => new RegExp(`^(?:\\*\\*|__)?${name}:(?:\\*\\*|__)?`, "i").test(trimmed));
}

/**
 * The lines of a bare `Acceptance:` block, one command per line -- split out of `extractAcceptanceSection`
 * purely to keep that function's complexity within this repo's ESLint budget; the two are one algorithm.
 *
 * FENCE-AWARE, because `#` is ambiguous outside one: a bare `# 1. explain this` at the top level of a PR
 * body reads as a markdown heading and correctly ends the section, but the identical text inside a
 * ```shell fence is a shell comment annotating the command below it (real shape: #331's own issue body
 * used exactly this). The same character means opposite things depending on where it sits, so this has to
 * track that rather than guess from the character alone.
 *
 * HTML-COMMENT-AWARE, for the same reason and a sharper cost. GitHub's own PR-template convention is an
 * HTML comment (`<!-- one command per line -->`) left under a field as unfilled guidance, so a template
 * built from this repo's own `.github/pull_request_template.md` produces exactly that shape under
 * `Acceptance:`. Unlike `#`, `<!--` is never ambiguous with a heading -- it is always a comment, fenced or
 * not -- so it is stripped in both places rather than only inside a fence. Left unstripped, that line
 * reached `execSync` with `shell: "/bin/bash"`: bash reads `<!--` as a redirect from a file named `--`,
 * which errors loudly rather than doing something silent -- but the failure was baffling to an author who
 * never wrote a command at all, on the exact PR-body shape GitHub's own convention encourages.
 *
 * #419 FOLLOW-UP: A BLANK LINE AFTER THE HEADER IS NOT THE TERMINATOR -- ONLY A BLANK LINE AFTER A COMMAND
 * IS. Markdown convention puts a blank line after every heading (every other `## ` section in this repo's
 * own PR template has one), so `## Acceptance` -- the very form #419 just made acceptable -- combined with
 * that convention landed straight back on MISSING: the block "ended" at the blank line before a single
 * command was ever read. `Acceptance:` followed by a blank line has the identical shape. So a blank line
 * is skipped while NO command has been found yet, and still ends the block the moment one has -- which
 * keeps `Acceptance:` + blank + `Mutation:` reading as MISSING (correct: the block never gains a command)
 * while letting `## Acceptance` + blank + a real command through.
 *
 * @param {string[]} lines
 * @param {number} headerIndex
 * @returns {string[]}
 */
function commandLinesAfter(lines, headerIndex) {
  const commands = [];
  let inFence = false;
  let inHtmlComment = false;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (inHtmlComment) {
      if (trimmed.includes("-->")) inHtmlComment = false;
      continue;
    }
    if (trimmed.startsWith("<!--")) {
      if (!trimmed.includes("-->")) inHtmlComment = true;
      continue;
    }
    if (trimmed.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) {
      if (trimmed !== "" && !trimmed.startsWith("#")) {
        // A continuation is understood to still be part of the command that started it, whatever it looks
        // like on its own -- the stop rules below apply only to where a command BEGINS.
        const { command, consumed } = joinContinuations(lines, i, trimmed, blockEndAfter(lines, i, true));
        commands.push(unwrapBackticks(command));
        i += consumed;
      }
      continue;
    }
    if (trimmed === "") {
      if (commands.length === 0) continue; // leading blank, before any command -- not the terminator
      break;
    }
    if (/^#{1,6}\s/.test(trimmed)) break;
    // #1035: `History: full` IS A DECLARATION, NOT A COMMAND, wherever it sits. It is read from the WHOLE
    // body by `hasFullHistoryDeclaration`, so a line inside a section is still honoured -- but this loop
    // used to take it as a command AND, being followed by a blank line, terminate on the next one, so the
    // fenced block below it was never reached. Measured:
    //
    //     INSIDE  the section:  commands = ["History: full"]     <- the prose line, and nothing else
    //     OUTSIDE the section:  commands = ["npx tsx --test …"]
    //
    // The tool then reported "every command above was refused" (true, of a command the author never wrote
    // as one) and "`History: full` is declared, but no named test file declares `// requires: history`"
    // (the named file declares it on line 13) -- one placement, two messages, neither naming it. Skipping
    // rather than refusing, because the declaration is position-independent by design and honouring it
    // wherever it lands is the behaviour the author already expects.
    // #2099: `Hand-run:` joins it, for the identical reason and against the identical measured failure --
    // a declaration is position-independent, so a row that writes it under `## Acceptance` (the natural
    // place, next to the command it is about) must not have it taken as a command that then terminates
    // the scan before the real command below it. Both are asked in one call; see `isDeclarationLine`.
    if (isDeclarationLine(trimmed)) continue;

    // #438: stops on ANY of the three known section headers, not just Mutation:, so a bare (non-heading)
    // `Refutation:` line ends an in-progress Acceptance: block instead of being read as one more command.
    if (isSectionHeaderLine(trimmed)) break;
    const { command, consumed } = joinContinuations(lines, i, trimmed, blockEndAfter(lines, i, false));
    commands.push(unwrapBackticks(command));
    i += consumed;
  }
  return commands;
}

/**
 * Runs one command and produces its report line and pass/fail -- shared between `Acceptance:` (success is
 * exit 0) and `Refutation:` (success is any NON-zero exit, #438), so classification and the file-argument
 * check cannot drift between the two the way a second, independently-written parser would risk.
 *
 * @param {string} command
 * @param {(command: string) => number} run
 * @param {{ prefix: "ACCEPTANCE" | "REFUTATION", isPass: (code: number) => boolean,
 *           commandExists?: (token: string) => boolean, capabilities?: JobCapabilities,
 *           handRun?: string | null }} options
 * @returns {{ line: string, ok: boolean, executed: boolean, handRun?: boolean }}
 */
function runOneCommand(command, run, { prefix, isPass, commandExists: exists, capabilities, handRun }) {
  // #658: truncate for CLASSIFICATION AND EXECUTION only. `command` itself is never reassigned, so every
  // reported line below still shows the ORIGINAL text an author wrote, even on the RAN branch (where
  // "executable" and "command" can now legitimately differ) -- seeing exactly what was written next to
  // what actually ran is what makes this line something a reader can act on, per #655's own rule.
  const executable = stripTrailingCommentary(command);
  const classification = classifyCommand(executable, { commandExists: exists, capabilities, section: prefix });
  // #2099: A DECLARED HAND-RUN IS ITS OWN LINE SHAPE -- not RAN, not REFUSED, not prose. `REFUSED` reads
  // as "not this job's to run and nobody's problem"; this line says a human owes a run and names who and
  // why, which is the whole content of the declaration. `branch-protection.test.ts`'s opt-in live read
  // already prints exactly this word for the identical situation (a check nothing here performed), so the
  // reader meets one vocabulary rather than two.
  //
  // ACCEPTANCE ONLY, and the boundary is what the declaration SAYS rather than a convenience
  // (reviewer-2's blocker on #2105). `handRunAcceptanceReason` reads `extractAcceptanceSection` alone, so
  // `Hand-run:` is a claim about the Acceptance commands and nothing else -- the filer was never asked
  // about the Refutation ones, and nobody promised to run them by hand. Honouring it under `Refutation:`
  // would let one line in the body convert an unrelated `gh` refutation into `NOT RUN ... declared
  // hand-run`, attributing to a human a run they never declared. `Refutation:` keeps its own verdict
  // semantics: a `gh` line there is REFUSED for `token`, exactly as before this row.
  if (prefix === "ACCEPTANCE" && handRun && classification.verdict === "refused"
      && !capabilities?.token && needsToken(executable)) {
    return { executed: false, handRun: true, ok: true,
      line: `${prefix}: NOT RUN ${command} -> declared hand-run: ${handRun}. This job has no credential `
        + "and did not attempt it; nothing here verified this command. Paste the run into the PR body "
        + "under a `## Hand-run output` heading -- #2118: a body that declares a hand-run and pastes "
        + "nothing is now REFUSED, because the declaration alone is a claim with no evidence behind it." };
  }
  if (classification.verdict === "refused") {
    // A WHOLE-SUITE COMMAND IS THE ONE REFUSAL THAT FAILS. Every other REFUSED is a legitimate "not this
    // job's to run": the author named a file, and this job cannot run that particular file. `npm test`
    // names nothing -- so a refusal of it means the PR has declared no acceptance this job can act on at
    // all, and reporting that as a pass is how "verified" comes to mean "unexamined" (ceo, 2026-09-09).
    // The message names the fix rather than the state, because a refusal a reader cannot follow is one
    // they route around.
    if (runsTheWholeSuite(executable)) {
      return { executed: false, line: `${prefix}: REFUSED ${command} -> ${classification.reason}\n`
        + "  Name the files this change is verified by. This job has no token and no corpus, and it runs "
        + "commands taken from a PR body, so it cannot run the whole suite -- a PR whose author cannot "
        + "name a file that verifies it has no acceptance.", ok: false };
    }
    return { executed: false, line: `${prefix}: REFUSED ${command} -> ${classification.reason}`, ok: true };
  }
  // #446: A THIRD, DISTINCT LINE SHAPE -- neither RAN nor REFUSED, so it cannot be mistaken for either.
  // Unlike REFUSED (`ok: true`, a legitimate "not this job's to run"), this IS a failure: the line made a
  // claim the PR body cannot support, and CLAUDE.md's own rule applies -- two different faults ("your
  // command failed" and "that line was never a command") must not print the same word, because they need
  // opposite fixes. Never run -- there is nothing honest a line that was never a command could report by
  // being executed anyway.
  if (classification.verdict === "prose") {
    return { executed: false, line: `${prefix}: "${command}" ${classification.reason}`, ok: false };
  }
  // CHECKED BEFORE RUNNING, never inferred from the exit code -- an unresolved test file/glob is
  // exactly the shape whose exit code cannot be trusted (#353's fifth hazard). Failing this here means
  // the real command never runs at all: there is nothing honest it could report.
  const fileCheck = testFileArgumentsResolve(executable);
  if (!fileCheck.ok) {
    // `executed: true`: the command was ATTEMPTED and answered. A glob matching nothing is a real
    // failure of this line, not a capability this job lacks -- the section examined something and found
    // it wanting, which is the opposite of examining nothing.
    // #728: AN UNPARSEABLE LINE IS `REFUSED`, NOT `RAN`. The command was never attempted, so saying
    // `RAN ... -> fail` is the same false confidence as the message this row replaced, one level up:
    // it reports a verdict about a command that did not execute. `ok: true` because the line may be
    // perfectly good -- this check cannot tell, and failing a PR for containing a pipe is a behaviour
    // this row did not ask for. The section still reports having executed nothing, which is the honest
    // answer and is what stops it reading as a pass.
    if ("unparseable" in fileCheck) {
      return { executed: false, ok: true,
        line: `${prefix}: REFUSED ${command} -> cannot check this line: it contains ${fileCheck.unparseable}, `
          + "so the arguments to `tsx --test` are not this command's argv" };
    }
    return { executed: true,
      line: `${prefix}: RAN ${command} -> fail (matched no file: ${fileCheck.missing.join(", ")})`, ok: false };
  }
  const code = run(executable);
  const passed = isPass(code);
  const verb = prefix === "ACCEPTANCE"
    ? (passed ? "pass" : "fail")
    // #438's own point: a Refutation: command that exits 0 is the FAILURE that matters -- the guard was
    // never shown to bite. "fail" here, not "pass", is what makes that absence loud instead of quiet.
    : (passed ? "refused" : "fail (did not refuse)");
  return { executed: true, line: `${prefix}: RAN ${command} -> ${verb} (exit ${code})`, ok: passed };
}

/**
 * #540: the report line for a DUPLICATE section -- every occurrence's line number and raw text, so an
 * author can find and consolidate them without re-reading the whole body to work out where "the" header
 * even is anymore. Shared between `Acceptance:` and `Refutation:` for the same reason `runOneCommand` is:
 * one wording, never two independently-drifting ones.
 * @param {"ACCEPTANCE" | "REFUTATION"} prefix
 * @param {{ occurrences: { line: number, text: string }[] }} section
 * @returns {string}
 */
function duplicateSectionLine(prefix, section) {
  const named = section.occurrences.map((o) => `line ${o.line}: "${o.text}"`).join(", ");
  return `${prefix}: DUPLICATE -- ${section.occurrences.length} sections found (${named}) -- consolidate `
    + "into one; this parser refuses to guess whether you meant to run every one of them (see this file's "
    + "own header comment for why #540 is not #527's remedy)";
}

/**
 * #2118: THE REFUSAL, AND IT SAYS WHAT IT CHECKED AND WHAT IT DID NOT -- in that order, because a reader
 * who takes only the first sentence must not come away believing more was verified than was.
 *
 * FOLLOWABLE (#1116): it names the exact heading to add, not merely the state it found. A refusal whose
 * remedy the author has to infer is one they route around -- and the route around this one is to delete
 * the `Hand-run:` line, which costs the row the declaration that made it honest.
 * @param {"ACCEPTANCE" | "REFUTATION"} prefix
 * @returns {string}
 */
function missingHandRunOutputLine(prefix) {
  return `${prefix}: NO HAND-RUN OUTPUT -- every command above is a declared hand-run and this body `
    + "pastes no output, so the only thing asserting the run happened is the line declaring that it "
    + "should. Add a `## Hand-run output` heading (or a `**Hand-run output:**` line) and paste under it "
    + "what you ran and what it printed.\n"
    + "  WHAT THIS CHECKED: that such a section exists and is not empty -- that a human wrote something "
    + "there. WHAT IT DID NOT CHECK: whether that text is this command's output. Nothing in this job "
    + "holds the credential, so nothing here can re-run the command and compare; a human reads it.";
}

/**
 * Runs every command in a `{ kind: "commands" }` section and reports each line, folding failures into
 * `ok`. Split out of `acceptanceReport` purely to keep that function's complexity within this repo's
 * ESLint budget -- the Acceptance and Refutation branches were one algorithm with a different `isPass`,
 * duplicated as two loops.
 * @param {string[]} commands
 * @param {(command: string) => number} run
 * @param {{ prefix: "ACCEPTANCE" | "REFUTATION", isPass: (code: number) => boolean,
 *           commandExists?: (token: string) => boolean, capabilities?: JobCapabilities,
 *           handRun?: string | null, handRunEvidence?: string | null }} options
 * @returns {{ lines: string[], ok: boolean }}
 */
function runSectionCommands(commands, run, options) {
  let ok = true;
  const lines = [];
  let ran = 0;
  let handRun = 0;
  for (const command of commands) {
    const result = runOneCommand(command, run, options);
    lines.push(result.line);
    if (result.executed) ran += 1;
    if (result.handRun) handRun += 1;
    if (!result.ok) ok = false;
  }
  // #2099: THE ONE CASE THE BRANCH BELOW WAS WRONG ABOUT, AND ONLY IT. That comment's stated assumption --
  // "an Acceptance section has no such case: every refusal there is a capability this job lacks" -- is
  // still true of `token`; what it missed is that a row CAN now say a human holds the credential and will
  // run it, which is a fourth thing a section can honestly report.
  //
  // EVERY COMMAND, never merely one. If a declared hand-run could silence this beside an undeclared
  // fleet refusal, the declaration becomes the line people add to turn a red check green -- the exact
  // failure `History: full` is kept a warning to avoid. A fleet refusal next to it keeps the section red,
  // as today.
  //
  // `ok` STAYS TRUE ONLY WHEN THE RUN IS PASTED -- #2118 closed the half #2099 left open. The trade this
  // comment used to describe was between a check that is green and loud and a row that is unmergeable
  // (#2084 is the live case), and it took the first: the line below says NOT RUN and says nothing was
  // verified, "the PR carries the pasted run, and a reviewer reads both". NOTHING REQUIRED THE PASTED RUN
  // TO EXIST. `Hand-run:` is the one positive claim on this path -- `Acceptance: none -- <reason>` says
  // nothing was run, while this says a human DID run something -- and it was the only one nothing checked.
  // The trade survives intact: a declared, EVIDENCED hand-run is still green and loud and still merges.
  if (options.prefix === "ACCEPTANCE" && commands.length > 0 && ran === 0 && handRun === commands.length) {
    lines.push(`${options.prefix}: NOTHING RAN HERE -- every command above is a declared hand-run, so `
      + "this job verified NOTHING and is not claiming otherwise. The verdict is the output pasted into "
      + "the PR body by whoever holds the credential, read by a human; this line is not a pass.");
    if (options.handRunEvidence) return { lines, ok };
    lines.push(missingHandRunOutputLine(options.prefix));
    return { lines, ok: false };
  }
  // A SECTION THAT EXECUTED NOTHING IS NOT A SECTION THAT PASSED. This is `evidence:check`'s
  // examined-nothing shape (`2 compared: 2 same` on a 48-case sample) in the acceptance job: every
  // command REFUSED, no command RAN, and the job concluding success.
  //
  // MEASURED, 2026-09-09: 55 of the 145 PRs merged that day had an acceptance job that executed no
  // command, almost all of them `tsx --test packages/lab/src/packaging/<x>.test.ts` refused for `token`
  // -- the tracker and pipeline tooling, which is exactly the code everything else now relies on. Three
  // were found by the PM re-running the declared commands at the merge commit by hand; the shape is
  // generic to the closure walk, not to those three.
  //
  // A REFUSED LINE PASSES ONLY BESIDE A RAN LINE. Refusing one named file while another actually runs is
  // a legitimate partial answer; refusing every one of them is no answer at all.
  // ACCEPTANCE ONLY, and the boundary is #516's rather than a convenience. `Refutation:` is optional and
  // this repo's own rule tells authors to declare `npm run mutate` there, which the classifier refuses BY
  // DESIGN -- mutate's exit 0 means the guard BITES and `Refutation:` reads success as non-zero, so
  // running it would invert the verdict. Failing a section for executing nothing when the tree told the
  // author to write exactly that would refuse the body its own rule asks for. An Acceptance section has
  // no such case: every refusal there is a capability this job lacks.
  if (options.prefix === "ACCEPTANCE" && commands.length > 0 && ran === 0) {
    lines.push(`${options.prefix}: EXECUTED NOTHING -- every command above was refused, so this job `
      + "verified nothing and must not report success. Declare at least one command this job can "
      + "actually run: it has no token, no fleet and no corpus, and it runs commands taken from a PR "
      + "body. A refusal beside a command that RAN is a partial answer; a refusal beside no command at "
      + "all is the absence of one.");
    ok = false;
  }
  return { lines, ok };
}

/**
 * THE VERDICT, driven by an injectable `run` so every outcome (including a real exit code) is testable
 * without a subprocess. `run` returns the exit code; it is never asked to interpret one.
 *
 * `Acceptance:` is mandatory -- its absence is the MISSING verdict this whole job exists to catch.
 * `Refutation:` is optional (#438): most PRs demonstrate nothing refusing, so its absence just means
 * there is nothing more to run, never a failure in its own right. A DUPLICATE of either (#540) fails the
 * job exactly like MISSING does -- an ambiguous body is not one this parser should guess at.
 *
 * @param {string | null | undefined} body
 * @param {(command: string) => number} run
 * @param {{ commandExists?: (token: string) => boolean, capabilities?: JobCapabilities }} [deps] forwarded
 *   to `classifyCommand` (#446/#510) -- `commandExists` defaults to the real `$PATH` check; `capabilities`
 *   defaults to `jobCapabilities(body)`, so `main()` needs no changes at all to pick up the real job's
 *   environment, and a test overrides either to stay independent of what happens to be true of the machine
 *   or body the suite runs against.
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function acceptanceReport(body, run, deps = {}) {
  // #2099: `handRun` is read from the body and is NOT overridable by `deps` -- unlike `capabilities`,
  // which a test overrides to exercise a job it is not running in. The declaration is a fact the body
  // states about itself, and a caller that could pass one the body does not carry could report `NOT RUN`
  // for a row that never declared anything.
  // #2118: `handRunEvidence` is read the same way and for the sharper version of the same reason. It is
  // the one field here that decides whether a POSITIVE claim about work a human performed is believed, so
  // a caller able to supply it could report a run as evidenced by text that is in no body at all.
  const resolvedDeps = { capabilities: jobCapabilities(body), ...deps,
    handRun: handRunDeclaration(body), handRunEvidence: handRunEvidence(body) };
  const section = extractAcceptanceSection(body);
  if (section.kind === "missing") {
    return { ok: false, lines: ["ACCEPTANCE: MISSING"] };
  }
  if (section.kind === "duplicate") {
    return { ok: false, lines: [duplicateSectionLine("ACCEPTANCE", section)] };
  }

  let ok = true;
  const lines = [];
  if (section.kind === "none") {
    lines.push(`ACCEPTANCE: NONE -> ${section.reason}`);
  } else {
    const result = runSectionCommands(section.commands, run,
      { prefix: "ACCEPTANCE", isPass: (code) => code === 0, ...resolvedDeps });
    lines.push(...result.lines);
    if (!result.ok) ok = false;
  }

  const refutation = extractRefutationSection(body);
  if (refutation.kind === "duplicate") {
    lines.push(duplicateSectionLine("REFUTATION", refutation));
    ok = false;
  } else if (refutation.kind === "none") {
    lines.push(`REFUTATION: NONE -> ${refutation.reason}`);
  } else if (refutation.kind === "commands") {
    const result = runSectionCommands(refutation.commands, run,
      { prefix: "REFUTATION", isPass: (code) => code !== 0, ...resolvedDeps });
    lines.push(...result.lines);
    if (!result.ok) ok = false;
  }
  // refutation.kind === "missing" -> nothing to report; the section is optional.

  // #497's OWN STATED BOUNDARY: "a PR carrying `History: full` and no historical fixture is asking for
  // something it does not use -- worth a warning, not a refusal, since the cost is only time." So this
  // never touches `ok` -- the one thing it must not become is a flag people add to make a red check green,
  // and a warning that could fail the job would be exactly that in the other direction.
  if (hasFullHistoryDeclaration(body)) {
    const allCommands = [
      ...(section.kind === "commands" ? section.commands : []),
      ...(refutation.kind === "commands" ? refutation.commands : []),
    ];
    if (!anyCommandUsesHistory(allCommands)) {
      lines.push("WARNING: `History: full` is declared, but no named test file declares "
        + "`// requires: history` -- this checkout is being deepened for nothing this PR uses.");
    }
  }

  return { ok, lines };
}

/**
 * Runs a command for real, via a shell (these are arbitrary shell strings out of a PR body, potentially
 * carrying flags/pipes/quoting -- the same trust boundary `merge-guard.mjs`'s `--ci-gate` and this
 * project's other CI-invoked scripts already accept, contained by `pull_request`'s read-only token and
 * fork checkout rather than by refusing shell syntax).
 * @param {string} command
 * @returns {number}
 */
function runForReal(command) {
  try {
    execSync(command, { stdio: "inherit", shell: "/bin/bash" });
    return 0;
  } catch (error) {
    const status = /** @type {{ status?: number }} */ (error).status;
    return typeof status === "number" ? status : 1;
  }
}

// #471: A PR MUST DECLARE WHAT IT CLOSES, and an unrecognised body must not read as an honest opt-out.
// #468 -- the first merge armed under the PAT -- proved the pipeline works and produced this gap in the
// same run: `close-rows` correctly closed nothing, because the PR body declared nothing, and A0's own row
// stayed open while the work that closes it landed on main. The fix is the same shape #446 already built
// for `Acceptance:` -- "nobody wrote one" and "this deliberately has none" must read as different states --
// applied to the other half of the body.
//
// `Closes: none` with NO reason is MALFORMED, never folded into the opt-out -- the identical rule
// `extractSection`'s own `noneMatch` applies to `Acceptance:`, reused rather than re-derived.
//
// NEVER INFERS. Guessing the row from a branch name or a title would close the wrong issue the day the
// guess is wrong, and a wrongly-closed row is worse than an open one -- it leaves work that looks done.
// The declaration is the author's, in the body, or this reports MISSING/MALFORMED and the job fails.
const CLOSES_NONE_PATTERN = /\bCloses:\s*none\b([^\n]*)/i;
const CLOSES_LIST_PATTERN = /\bCloses:?\s*(#\d+(?:\s*(?:,|and)\s*#\d+)*)/i;
// #527: GLOBAL, because an author writing `Closes #510` on one line and `Closes #497` on another -- a
// form GitHub itself accepts and closes both for -- is a SECOND, independent match of the same pattern,
// not a continuation of the first. `CLOSES_LIST_PATTERN` stays singular (`.exec()` reads naturally as
// "does this line have one"); this is the walk that must never stop after the first hit.
const CLOSES_LIST_PATTERN_GLOBAL = new RegExp(CLOSES_LIST_PATTERN.source, `${CLOSES_LIST_PATTERN.flags}g`);
const CLOSES_MENTIONED_PATTERN = /\bCloses\b/i;

/**
 * Pure. Never infers a row from anything but the words the author wrote.
 *
 * Three shapes, and only three: `Closes #451` (also `Closes #451, #452`), `Closes: none — <reason>` (a
 * deliberate opt-out, reason required), and neither -- MISSING. A fourth shape exists and must not be
 * folded into any of those: the word "Closes" present but unparseable (prose with no number, or a number
 * that isn't digits) is MALFORMED, distinct from MISSING for the same reason `Acceptance:`'s own malformed
 * "none" is distinct from silence -- a check that cannot tell "wrote something wrong" from "wrote nothing"
 * cannot tell an author who tried from one who never noticed the field.
 *
 * @param {string | null | undefined} body
 * @returns {ClosesDeclaration}
 */
export function extractClosesDeclaration(body) {
  const text = body ?? "";
  const noneMatch = CLOSES_NONE_PATTERN.exec(text);
  if (noneMatch) {
    const reason = noneMatch[1].replace(/^[\s:—-]+/, "").trim();
    return reason.length > 0
      ? { kind: "none", reason }
      : { kind: "malformed", detail: "`Closes: none` names no reason" };
  }
  // #527: EVERY match, not the first. `.exec()` once made `Closes #510\nCloses #497` report only #510 --
  // both close for real (`close-rows-for-merged-pr.mjs` reads GitHub's own `closingIssuesReferences`,
  // never this regex), so the gate was silently under-reporting a fact GitHub and this file both see.
  const listMatches = [...text.matchAll(CLOSES_LIST_PATTERN_GLOBAL)];
  if (listMatches.length > 0) {
    const numbers = listMatches.flatMap((match) =>
      [...match[1].matchAll(/#(\d+)/g)].map((m) => Number(m[1])));
    return { kind: "closes", numbers };
  }
  if (CLOSES_MENTIONED_PATTERN.test(text)) {
    return { kind: "malformed",
      detail: "mentions \"Closes\" but names no `#<number>` and no `none — <reason>` opt-out" };
  }
  return { kind: "missing" };
}

/**
 * THE VERDICT. `ok: false` on both MISSING and MALFORMED -- deliberately the same boolean, because both
 * mean this job cannot tell what the PR closes, and a job that fails on one but not the other invites an
 * author to reach for the vaguer of the two whenever the precise one is inconvenient.
 * @param {string | null | undefined} body
 * @returns {{ ok: boolean, line: string }}
 */
export function closesDeclarationReport(body) {
  const declaration = extractClosesDeclaration(body);
  if (declaration.kind === "missing") {
    return { ok: false,
      line: "CLOSES: MISSING -- no `Closes #N` or `Closes: none — <reason>` declaration" };
  }
  if (declaration.kind === "malformed") {
    return { ok: false, line: `CLOSES: MALFORMED -- ${declaration.detail}` };
  }
  if (declaration.kind === "none") {
    return { ok: true, line: `CLOSES: NONE -> ${declaration.reason}` };
  }
  return { ok: true, line: `CLOSES: #${declaration.numbers.join(", #")}` };
}

/**
 * Does this command re-run a suite that `ci.yml`'s `ts` job is already running?
 *
 * NOT `runsTheWholeSuite`, AND THE DIFFERENCE IS THE POINT -- the first version of this reused it and
 * silently missed the case it was written for. That predicate asks "what population does this command
 * execute", to decide which CAPABILITIES it needs, and its own comment explains why it deliberately
 * excludes `test:python`: a pytest tree is not the `.test.ts` glob its callers walk. This asks a
 * different question -- "is this work `ts` has already done" -- and `test:org` and `test:all` answer yes
 * to it while answering no to the other. Two questions, two predicates; widening the capability one to
 * serve this would break the gate it exists for.
 *
 * @param {string} command
 */
function duplicatesTheTsJob(command) {
  return /(?:^|&&|\|\||;)\s*npm\s+(?:run\s+)?(?:test|test:ts|test:org|test:all)(?![:\w-])/
    .test(command.trim());
}

/**
 * A NOTE, NEVER A REFUSAL, when a PR's Acceptance re-runs what `ts` is already running.
 *
 * `ci.yml`'s `ts` job runs every test the diff reaches, IN PARALLEL WITH THIS JOB, on the same tree. So a
 * suite-wide command here runs tests that are already running. Measured 2026-09-19 over four runs: `ts`
 * 154-176 s beside `acceptance` 186-193 s for one change -- roughly half the wall clock of landing
 * anything, and it was the chairman's own habit in every PR written that day.
 *
 * IT IS A NOTE AND NOT A REFUSAL ON PURPOSE. A suite-wide command is genuinely right for a runner
 * upgrade, a dependency bump, or a config change with no single owner, and nothing here can tell those
 * from a habit. Guessing at intent is the defect this file warns about elsewhere, so it states the cost
 * and leaves the judgment with the author -- the way `no-magic-numbers` is a warning in this repo rather
 * than an error.
 *
 * @param {string[]} commands the Acceptance commands as declared
 * @returns {string[]} zero or one note line
 */
export function wholeSuiteNote(commands) {
  const offenders = commands.filter((command) => duplicatesTheTsJob(command));
  if (offenders.length === 0) return [];
  return [`NOTE: Acceptance re-runs a suite ci.yml's \`ts\` job is already running in parallel on this `
    + `same tree (${offenders.join("; ")}) -- about 190s paid twice. Name what proves THIS row instead, `
    + "unless the row's claim really is \"the whole suite still passes\" (a runner or dependency "
    + "change), in which case say so on the row."];
}

function main() {
  refuseUnknownFlags([], { entry: import.meta.url, command: "node packages/agent-org/src/acceptance-commands.mjs" });
  // FROM AN ENV VAR, NEVER ARGV -- a PR body is adversarial input (anyone can open a PR), and passing it
  // as a shell argument would put it on a command line for something else to misinterpret. GitHub Actions'
  // own `env:` mapping is what keeps it a single opaque string here, never re-parsed as shell.
  const body = process.env.PR_BODY ?? "";
  const report = acceptanceReport(body, runForReal);
  for (const line of report.lines) console.log(line);
  const declared = extractAcceptanceSection(body);
  if (declared.kind === "commands") {
    for (const line of wholeSuiteNote(declared.commands)) console.log(line);
  }
  const closes = closesDeclarationReport(body);
  console.log(closes.line);
  process.exit(report.ok && closes.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
