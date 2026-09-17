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
import { extractLabeledSection } from "./region-paths.mjs";
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
  [/\bsystemctl\b/, "drives systemd on the control host, which only `orchestrator` reaches"],
  [/\bsystemd\b/, "installs or reads a systemd unit on the control host"],
  [/\bgh workflow run\b/, "dispatches a workflow from the control plane, not from a checkout"],
  [/\bfleet:provision\b/, "provisions a real box"],
  [/\bA11Y_PVE_KEY\b|\ba11y-pve\b/, "uses the Proxmox key, which lives on the control plane"],
  [/\bcorpus-backup\b|\bA11Y_CORPUS_REMOTE\b/, "writes or verifies the corpus backup, which runs on the lab"],
  [/\bon the lab\b/, "names work done ON the lab, which only `orchestrator` reaches"],
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
  for (const [pattern, reason] of FLEET_LAB_PATTERNS) if (pattern.test(section)) return reason;
  return null;
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
 * #967: A MODULE'S TOP LEVEL IS WHAT AN IMPORT EXECUTES -- everything else runs only when called.
 *
 * The closure walk scanned every imported file's whole text, so `dataset-paths.mjs` was charged `corpus`
 * by any test that imported it, including one importing `REPO_ROOT` and nothing else. Measured before the
 * fix: the hit was its `export function runsRoot() {` DEFINITION at :93, and removing the definition from
 * the pattern only moved the hit to :116 -- the file calls `runsRoot()` five times (116, 178, 188, 203,
 * 246) and every one is inside a function body. Its top level is two constants, so importing it runs none
 * of them and reads nothing. **Three pull requests moved code into new corpus-free modules to get around
 * this** (#943, #955, #966), which is an import rule shaping the code's structure.
 *
 * PARSED, NOT BRACE-MATCHED. `typescript` is a declared devDependency and this script runs after `npm ci`
 * in `reusable-acceptance.yml`, so the module's own statements come from `ts.createSourceFile`. A
 * hand-rolled brace matcher would have to survive template literals and regex literals containing braces,
 * and a wrong one fails in the direction that looks like success -- the #731 trap, one layer over.
 *
 * OFFSETS ARE PRESERVED: a body is replaced by spaces of the same length, keeping newlines, exactly as
 * `stripComments` does. So `lineNumberOf` still reports the real line of whatever survives.
 *
 * WHAT THE IMPORTER ACTUALLY IMPORTED IS KEPT TOO, and leaving it out was a defect this file's own #731
 * boundary test caught: `corpus-settled.mjs` imports `datasetRoot` from `dataset-paths.mjs` and CALLS it,
 * so it genuinely needs the corpus — while its own text names `runsRoot` only in a comment. A rule of
 * "top level only" reported it as needing nothing. So the kept span is the module's top level PLUS the
 * bodies of the declarations whose names this importer names, which is the same question #827 asks for
 * tokens: charge for the export a caller actually imports, not for every spawn anywhere in the file.
 *
 * @param {string} codeOnly the file's text, comments already stripped
 * @param {string} fileName for the parser's diagnostics only
 * @param {Set<string>} imported the names the importing file took from this module
 * @returns {string} the same text with unreachable bodies blanked
 */
function topLevelCode(codeOnly, fileName,
  imported = new Set()) {
  const ts = loadTypescript();
  if (ts === null) return codeOnly; // no parser: scan everything, which refuses more, never less
  const source = ts.createSourceFile(fileName, codeOnly, ts.ScriptTarget.Latest, true);
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
      // KEPT when the importer named it: calling an imported function runs its body, so its requirements
      // are the caller's. Blanked otherwise -- an import does not execute what nobody asked for.
      const named = ts.isFunctionDeclaration(node) && node.name && imported.has(node.name.text);
      if (!named) bodies.push([node.getStart(source), node.getEnd()]);
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
  /** @param {string} file @param {string[]} chain @param {Set<string>} seen */
  const walk = (file, chain, seen) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
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
    const corpusScope = file === entry
      ? codeOnly
      : topLevelCode(codeOnly, file, new Set(importedNamesFor(chain[chain.length - 1], file)));
    const hereChain = [...chain, file];
    for (const [pattern, requirement] of CLOSURE_REQUIREMENT_PATTERNS) {
      if (found.has(requirement) || (requirement === "corpus" && exemptCorpus)
        || (requirement === "token" && exemptToken)) continue;
      const match = pattern.exec(requirement === "corpus" ? corpusScope : codeOnly);
      if (match) recordHit({ requirement, file, text, codeOnly, match, chain: hereChain });
    }
    for (const next of localImports(file)) walk(next, hereChain, seen);
  };
  walk(entry, [], new Set());
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
 * `npm test` is `pretest` (build) then `test:ts` then `test:python`; `test:ts` runs
 * the recursive `.test.ts` glob under every package's `src`. So the suite's population is that glob,
 * and a whole-suite command
 * requires the UNION of what every file in it requires.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function runsTheWholeSuite(command) {
  // `(?![:\w-])` AND NOT `\b`: `\b` after `test` matches `npm run test:python`, whose population is the
  // pytest tree rather than the `.test.ts` glob this function's callers walk. Refusing that command for a
  // requirement declared by a TypeScript file would be a refusal about a population it never runs.
  return /(?:^|&&|\|\||;)\s*npm\s+(?:run\s+)?(?:test:ts|test)(?![:\w-])/.test(command.trim());
}

/** @type {string[] | null} */
let suiteFilesCache = null;
/**
 * Every test file the WHOLE suite runs, FROM `test:all`'s OWN GLOB rather than a second copy of it.
 *
 * `test:all`, not `test:ts`: since the org tooling became @a11ign/agent-org, `test:ts` is the PRODUCT
 * suite a contributor runs and `test:all` is every package. The token charge is about what CI executes
 * across the tree, so reading the narrower glob would under-charge -- it would stop seeing the org's own
 * tests, which are the ones that spawn `gh`.
 *
 * The glob is read out of `package.json`'s `test:all` script, because a hand-written copy here would be
 * the same fact in two places -- and the copy that drifts is the one that decides whether a PR's check
 * goes red. If the script cannot be read or carries no glob this THROWS rather than returning `[]`: an
 * empty population would make every whole-suite command pass the capability gate, which is exactly the
 * hole this function was added to close.
 *
 * @returns {string[]}
 */
export function suiteTestFiles() {
  if (suiteFilesCache) return suiteFilesCache;
  let script;
  try {
    script = JSON.parse(readFileSync("package.json", "utf8")).scripts?.["test:all"];
  } catch (cause) {
    throw new Error("acceptance-commands: could not read package.json to find what `npm test` runs -- "
      + "refusing to report a whole-suite command as needing nothing.", { cause });
  }
  const glob = typeof script === "string" ? /"([^"]*\*[^"]*\.test\.ts)"/.exec(script)?.[1] : null;
  if (!glob) {
    throw new Error("acceptance-commands: `test:ts` names no `*.test.ts` glob, so the suite's population "
      + "is unknown. Refusing to treat that as an empty population -- every `npm test` acceptance would "
      + "then pass the capability gate having examined nothing.");
  }
  suiteFilesCache = globSync(glob);
  return suiteFilesCache;
}

/**
 * The files a command runs: the ones it NAMES, or -- for a whole-suite command -- all of them.
 * @param {string} command
 * @returns {string[]}
 */
function testFilesRunBy(command) {
  return runsTheWholeSuite(command) ? suiteTestFiles() : tsxTestFileArgs(command);
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

/**
 * #419: A `\` LINE CONTINUATION IS ONE COMMAND, NOT TWO. Read line by line, a shell continuation split the
 * command in half: the first half ended in a dangling backslash and the second half became its OWN
 * "command" -- a bare filename or flag that fails the moment it is run on its own. Joins forward from
 * `startIndex` while the accumulated text still ends in `\`, so an author can chain any number of
 * continuation lines exactly as they would in a real shell script.
 * @param {string[]} lines
 * @param {number} startIndex
 * @param {string} firstLine
 * @returns {{ command: string, consumed: number }}
 */
function joinContinuations(lines, startIndex, firstLine) {
  let command = firstLine;
  let consumed = 0;
  while (/\\\s*$/.test(command) && startIndex + consumed + 1 < lines.length) {
    consumed += 1;
    command = `${command.replace(/\\\s*$/, "").trimEnd()} ${lines[startIndex + consumed].trim()}`;
  }
  return { command, consumed };
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
        const { command, consumed } = joinContinuations(lines, i, trimmed);
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
    if (isHistoryDeclarationLine(trimmed)) continue;

    // #438: stops on ANY of the three known section headers, not just Mutation:, so a bare (non-heading)
    // `Refutation:` line ends an in-progress Acceptance: block instead of being read as one more command.
    if (SECTION_FIELD_NAMES.some((name) => new RegExp(`^(?:\\*\\*|__)?${name}:(?:\\*\\*|__)?`, "i").test(trimmed))) break;
    const { command, consumed } = joinContinuations(lines, i, trimmed);
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
 *           commandExists?: (token: string) => boolean, capabilities?: JobCapabilities }} options
 * @returns {{ line: string, ok: boolean, executed: boolean }}
 */
function runOneCommand(command, run, { prefix, isPass, commandExists: exists, capabilities }) {
  // #658: truncate for CLASSIFICATION AND EXECUTION only. `command` itself is never reassigned, so every
  // reported line below still shows the ORIGINAL text an author wrote, even on the RAN branch (where
  // "executable" and "command" can now legitimately differ) -- seeing exactly what was written next to
  // what actually ran is what makes this line something a reader can act on, per #655's own rule.
  const executable = stripTrailingCommentary(command);
  const classification = classifyCommand(executable, { commandExists: exists, capabilities, section: prefix });
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
 * Runs every command in a `{ kind: "commands" }` section and reports each line, folding failures into
 * `ok`. Split out of `acceptanceReport` purely to keep that function's complexity within this repo's
 * ESLint budget -- the Acceptance and Refutation branches were one algorithm with a different `isPass`,
 * duplicated as two loops.
 * @param {string[]} commands
 * @param {(command: string) => number} run
 * @param {{ prefix: "ACCEPTANCE" | "REFUTATION", isPass: (code: number) => boolean,
 *           commandExists?: (token: string) => boolean, capabilities?: JobCapabilities }} options
 * @returns {{ lines: string[], ok: boolean }}
 */
function runSectionCommands(commands, run, options) {
  let ok = true;
  const lines = [];
  let ran = 0;
  for (const command of commands) {
    const result = runOneCommand(command, run, options);
    lines.push(result.line);
    if (result.executed) ran += 1;
    if (!result.ok) ok = false;
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
  const resolvedDeps = { capabilities: jobCapabilities(body), ...deps };
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

function main() {
  refuseUnknownFlags([], { entry: import.meta.url, command: "node packages/agent-org/src/acceptance-commands.mjs" });
  // FROM AN ENV VAR, NEVER ARGV -- a PR body is adversarial input (anyone can open a PR), and passing it
  // as a shell argument would put it on a command line for something else to misinterpret. GitHub Actions'
  // own `env:` mapping is what keeps it a single opaque string here, never re-parsed as shell.
  const body = process.env.PR_BODY ?? "";
  const report = acceptanceReport(body, runForReal);
  for (const line of report.lines) console.log(line);
  const closes = closesDeclarationReport(body);
  console.log(closes.line);
  process.exit(report.ok && closes.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
