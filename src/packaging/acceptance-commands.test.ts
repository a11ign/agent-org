/**
 * NOTHING HAS EVER RUN A ROW'S ACCEPTANCE COMMAND -- pipeline unit 2, #353. Every PR body carries an
 * `Acceptance:` line; the only thing that has ever executed it is the author, reporting in prose.
 *
 * Three outcomes, and the tests below exist because they must never collapse into two: RAN (the command
 * actually executed, exit code is the verdict), REFUSED (needs the fleet/lab/runs/, named, never gates),
 * MISSING (no acceptance line at all -- must FAIL, never read as a pass).
 */
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyCommand, extractAcceptanceSection, acceptanceReport, testFileArgumentsResolve,
  testFileRequirements, unmetRequirements, unmetCommandRequirements,
  hasFullHistoryDeclaration, jobCapabilities,
  deriveClosureRequirements, closureRequirementMessage, unmetClosureRequirements,
  unmetCommandClosureRequirements,
  singleNodeInvocation,
  runsTheWholeSuite,
  suiteTestFiles,
  suiteScriptsFor,
  SUITE_SCRIPTS,
  SPAWNS_GH,
  endsInsideQuote,
  endsInOperator,
  handRunDeclaration, handRunAcceptanceReason, handRunEvidence,
  testFilesAmong, mutationRecordReport, changedFilesOfThisPullRequest, measuredSectionReport,
  acceptancePathsReason, declaredNewFiles, unresolvedAcceptancePaths,
  declaredFleetAnswer,
} from "../acceptance-commands.mjs";
import { withGitSandbox, sandboxGitEnv } from "../lib/git-sandbox.ts";

// A file known to exist, relative to the repo root -- where every real invocation of this command runs
// from. This test file names itself, so it cannot go stale independently of being renamed.
const REAL_FILE = "packages/lab/src/packaging/acceptance-commands.test.ts";

// The REAL fixture #510/#497 exist for: `pre-push-resolve-toward-main.test.ts` genuinely carries
// `// requires: history` (its own `shallowHere()`/`t.skip()` guards need full git history), so testing
// against it exercises the actual mechanism rather than an invented stand-in.
const HISTORY_FIXTURE = "packages/lab/src/packaging/pre-push-resolve-toward-main.test.ts";

const NO_HISTORY = { history: false, token: false, fleet: false };
const WITH_HISTORY = { history: true, token: false, fleet: false };

// #621's own worked example: reaches `gh` with NO `// requires:` header at all -- `resolveChromeBinary()`,
// imported from `packages/agent-org/src/board-document.mjs`, is what actually shells out. The header-only mechanism
// (#510) cannot see this file; the closure-derived one is built specifically because it must.
//
// board-style.test.ts (the ORIGINAL worked example, via `collect()` in `packages/agent-org/src/board-data.mjs`) retired
// 2026-09-10 in guard triage 4 of 6 (#906) -- this file has the identical shape (no header, reaches `gh`
// only through a local import) and survives that row. Values below re-derived directly from
// `deriveClosureRequirements`/`closureRequirementMessage` against this fixture, not carried over from the
// old one.
const BOARD_STYLE_FIXTURE = "packages/lab/src/packaging/board-document-chrome-resolver.test.ts";
const NO_TOKEN = { history: true, token: false, fleet: true, corpus: true };
const WITH_TOKEN = { history: true, token: true, fleet: true, corpus: true };

/**
 * #1458: WHERE `board-document.mjs` SPAWNS `gh`, BY SHAPE -- the first `SPAWNS_GH` line inside
 * `function publishToDraftRelease(`, provided it is also the file's first. The #621 tests below used to write
 * that line as a literal number, so any edit above the function failed all three, and #1345's builder had to
 * hold the file's line count to keep them true. `null` when the shape is not there, which fails the tests
 * rather than guessing a line.
 */
const BOARD_DOCUMENT = "packages/agent-org/src/board-document.mjs";
function spawnLineOf(source: string): number | null {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^function publishToDraftRelease\(/.test(line));
  if (start < 0) return null;
  const nextTop = lines.findIndex((line, i) => i > start && /^(?:export\s+)?(?:async\s+)?function\s/.test(line));
  const end = nextTop < 0 ? lines.length : nextTop;
  const inFunction = lines.findIndex((line, i) => i > start && i < end && SPAWNS_GH.test(line));
  const inFile = lines.findIndex((line) => SPAWNS_GH.test(line));
  return inFunction >= 0 && inFunction === inFile ? inFunction + 1 : null;
}
const boardDocumentSpawnLine = (): number => {
  const line = spawnLineOf(readFileSync(BOARD_DOCUMENT, "utf8"));
  assert.ok(line !== null, "board-document.mjs's first gh spawn is no longer inside publishToDraftRelease -- "
    + "re-locate the #621 fixture rather than pin a line");
  return line;
};

// --- classifyCommand ---

test("classifyCommand: an ordinary test/build command is runnable", () => {
  assert.deepEqual(classifyCommand("npx tsx --test packages/lab/src/packaging/foo.test.ts"),
    { verdict: "runnable" });
});

test("classifyCommand: THE #353 RESOURCE BAN -- every fleet/lab pattern is refused, named", () => {
  const cases = [
    "npm run fleet:deploy",
    "npm run lab:job -- -e job=capture",
    "npm run training:capture",
    "npm run worker:deploy",
    "npm run evidence:check -- http://worker",
    "npm run gate:stability",
    "npm run capture:check -- --worker=http://x",
  ];
  for (const command of cases) {
    const result = classifyCommand(command);
    assert.equal(result.verdict, "refused", `expected ${command} to be refused`);
    assert.ok((/** @type {{reason:string}} */(result)).reason.length > 0, `${command} must name a reason`);
  }
});

test("classifyCommand: THE #353 CORPUS BAN -- every runs/-reading gate is refused, named", () => {
  const cases = [
    "npm run rules:gate",
    "npm run rules:coverage",
    "npm run training:check-signals",
    "npm run corpus:starvation",
    "npm run scorer:shortcuts",
  ];
  for (const command of cases) {
    const result = classifyCommand(command);
    assert.equal(result.verdict, "refused", `expected ${command} to be refused`);
  }
});

test("classifyCommand: #2473 the check-signals GATE stays refused in every spelling that runs it", () => {
  // The positive control for the runnable case below: the anchored pattern must still bite the gate.
  for (const command of [
    "npm run check-signals",
    "npm run check-signals -- --require-complete",
    "npm run training:check-signals:complete",
    "node packages/lab/src/training/check-signals.mjs",
    "node packages/lab/src/training/check-signals.mjs --require-complete",
  ]) {
    assert.equal(classifyCommand(command).verdict, "refused", `expected ${command} to be refused`);
  }
});

test("classifyCommand: #2473 a test FILE whose name merely begins `check-signals-` is runnable -- `-` is a "
  + "word boundary, so the bare word refused it as \"reads runs/\" though its closure never reaches runs/", () => {
  for (const command of [
    "npx tsx --test packages/lab/src/training/check-signals-pipe.test.ts",
    "npx tsx --test packages/lab/src/training/check-signals.test.ts",
  ]) {
    assert.deepEqual(classifyCommand(command), { verdict: "runnable" }, `expected ${command} to be runnable`);
  }
});

test("classifyCommand: a command that merely MENTIONS a banned word without the pattern is still runnable", () => {
  // `worker-fleet` contains "worker" but not the `worker:` script-name shape this bans.
  assert.deepEqual(classifyCommand("npx tsx --test packages/worker-fleet/src/cli-flags.test.ts"),
    { verdict: "runnable" });
});

test("classifyCommand: #1860 a genuine corpus-backup invocation is still refused, named", () => {
  for (const command of [
    "node packages/lab/scripts/corpus-backup.mjs",
    "npm run corpus:backup",
    "A11Y_CORPUS_REMOTE=/mnt/pve/backup/a11y npm run corpus:backup",
  ]) {
    const result = classifyCommand(command);
    assert.equal(result.verdict, "refused", `expected ${command} to be refused`);
    assert.match((/** @type {{reason:string}} */(result)).reason, /corpus backup/);
  }
});

test("classifyCommand: #1860 a test file merely NAMED after corpus-backup is still runnable -- the exact "
  + "false positive that refused #1860's own acceptance command on `corpus-backup.test.ts`", () => {
  assert.deepEqual(
    classifyCommand("npx rstest run --config scripts/rstest/rstest.config.mjs "
      + "--include packages/lab/src/packaging/corpus-backup.test.ts"),
    { verdict: "runnable" });
});

// --- extractAcceptanceSection ---

test("extractAcceptanceSection: no Acceptance: line anywhere is MISSING", () => {
  assert.deepEqual(extractAcceptanceSection("Just a PR body with no acceptance section."), { kind: "missing" });
});

test("extractAcceptanceSection: undefined/null body is MISSING, never a crash", () => {
  assert.deepEqual(extractAcceptanceSection(undefined), { kind: "missing" });
  assert.deepEqual(extractAcceptanceSection(null), { kind: "missing" });
});

test("extractAcceptanceSection: THE #353 PROOF SHAPE -- an inline command on the header's own line", () => {
  assert.deepEqual(extractAcceptanceSection('Acceptance: node -e "process.exit(1)"'),
    { kind: "commands", commands: ['node -e "process.exit(1)"'] });
});

test("extractAcceptanceSection: a bare header followed by one command on the next line", () => {
  const body = "## What\n\nSome prose.\n\nAcceptance:\nnpx tsx --test packages/lab/src/packaging/foo.test.ts\n\nMutation:\nnpm run mutate -- --file=x\n";
  assert.deepEqual(extractAcceptanceSection(body),
    { kind: "commands", commands: ["npx tsx --test packages/lab/src/packaging/foo.test.ts"] });
});

test("extractAcceptanceSection: multiple commands, one per line, stop at the blank line", () => {
  const body = "Acceptance:\nnpx tsx --test a.test.ts\nnpx tsx --test b.test.ts\n\nMore prose after a blank line.";
  assert.deepEqual(extractAcceptanceSection(body),
    { kind: "commands", commands: ["npx tsx --test a.test.ts", "npx tsx --test b.test.ts"] });
});

test("extractAcceptanceSection: stops at a Mutation: header even with no blank line between", () => {
  const body = "Acceptance:\nnpx tsx --test a.test.ts\nMutation:\nnpm run mutate -- --file=x";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["npx tsx --test a.test.ts"] });
});

test("extractAcceptanceSection: stops at a markdown heading", () => {
  const body = "Acceptance:\nnpx tsx --test a.test.ts\n## Next section\nmore text";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["npx tsx --test a.test.ts"] });
});

test("extractAcceptanceSection: fenced code delimiters are stripped, not treated as commands", () => {
  const body = "Acceptance:\n```shell\nnpx tsx --test a.test.ts\n```\n";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["npx tsx --test a.test.ts"] });
});

test("extractAcceptanceSection: comment lines INSIDE A FENCE are skipped, not run as commands", () => {
  // Unfenced, a `#`-line reads as a markdown heading and ends the section (see the heading test above);
  // fenced, it is a shell comment annotating the block -- the real shape #331's own issue body used.
  const body = "Acceptance:\n```shell\n# 1. explain what this does\nnpx tsx --test a.test.ts\n# 2. a second note\n```\n";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["npx tsx --test a.test.ts"] });
});

test("extractAcceptanceSection: ACCEPTANCE (follow-up) -- an unfilled HTML-comment template is MISSING, "
  + "never a command", () => {
  // GitHub's own PR-template convention (`<!-- one command per line -->`) is exactly what a real,
  // well-meaning template guidance under this header looks like -- and it must never reach `execSync`.
  const body = "Acceptance:\n<!-- one command per line -->";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "missing" });
});

test("extractAcceptanceSection: MUTATION TARGET -- an HTML comment is stripped even OUTSIDE a fence, "
  + "unlike `#` which reads as a heading there", () => {
  const body = "Acceptance:\n<!-- one command per line -->\nnpx tsx --test a.test.ts";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["npx tsx --test a.test.ts"] });
});

test("extractAcceptanceSection: a MULTI-LINE HTML comment is stripped in full, not just its first line", () => {
  const body = "Acceptance:\n<!--\n  one command per line\n  see CONTRIBUTING.md\n-->\nnpx tsx --test a.test.ts";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["npx tsx --test a.test.ts"] });
});

test('extractAcceptanceSection: "Acceptance: none — <reason>" is a deliberate, honest opt-out', () => {
  assert.deepEqual(extractAcceptanceSection("Acceptance: none — this PR only reorders comments, nothing to run"),
    { kind: "none", reason: "this PR only reorders comments, nothing to run" });
});

test('extractAcceptanceSection: "none" with a plain hyphen is accepted the same way', () => {
  assert.deepEqual(extractAcceptanceSection("Acceptance: none - docs only"), { kind: "none", reason: "docs only" });
});

test("extractAcceptanceSection: MUTATION TARGET -- \"none\" with NO reason is MISSING, not a free pass", () => {
  assert.deepEqual(extractAcceptanceSection("Acceptance: none"), { kind: "missing" });
  assert.deepEqual(extractAcceptanceSection("Acceptance: none —"), { kind: "missing" });
});

test("extractAcceptanceSection: a bare header with nothing usable under it is MISSING", () => {
  assert.deepEqual(extractAcceptanceSection("Acceptance:\n\nMutation:\nnpm run mutate -- --file=x"),
    { kind: "missing" });
  assert.deepEqual(extractAcceptanceSection("Acceptance:\n# only a comment, no real command\n"),
    { kind: "missing" });
});

test("extractAcceptanceSection: bolded/markdown-emphasised headers are recognised too", () => {
  assert.deepEqual(extractAcceptanceSection('**Acceptance:** node -e "process.exit(0)"'),
    { kind: "commands", commands: ['node -e "process.exit(0)"'] });
});

// --- acceptanceReport: the composed verdict ---

test("acceptanceReport: MISSING -> ok:false, exactly the MISSING line, and `run` is never called", () => {
  let called = false;
  const report = acceptanceReport("no acceptance section here", () => { called = true; return 0; });
  assert.equal(report.ok, false);
  assert.deepEqual(report.lines, ["ACCEPTANCE: MISSING"]);
  assert.equal(called, false, "a MISSING body must never invoke run() at all");
});

test("acceptanceReport: a stated none is ok:true and names the reason", () => {
  const report = acceptanceReport("Acceptance: none — nothing to run", () => 0);
  assert.equal(report.ok, true);
  assert.deepEqual(report.lines, ["ACCEPTANCE: NONE -> nothing to run"]);
});

test("acceptanceReport: THE #353 PROOF -- a command that exits nonzero fails the whole report", () => {
  const report = acceptanceReport('Acceptance: node -e "process.exit(1)"', () => 1);
  assert.equal(report.ok, false);
  assert.match(report.lines[0], /^ACCEPTANCE: RAN .* -> fail \(exit 1\)$/);
});

test("acceptanceReport: a command that exits zero passes the report", () => {
  const report = acceptanceReport('Acceptance: node -e "process.exit(0)"', () => 0);
  assert.equal(report.ok, true);
  assert.match(report.lines[0], /^ACCEPTANCE: RAN .* -> pass \(exit 0\)$/);
});

test("acceptanceReport: a REFUSED command never calls run(), and does not fail the report on its own", () => {
  // PAIRED WITH A RUNNABLE COMMAND since 2026-09-09. A section in which NOTHING ran now fails on its own,
  // because 55 of the 145 PRs merged that day reported success having executed no command. This test's
  // subject is unchanged: a refused command must never EXECUTE, and must not by itself sink a section
  // that examined something.
  /** @type {string[]} */
  const called: string[] = [];
  const report = acceptanceReport(
    "Acceptance:\nnpm run fleet:deploy\nnode -e \"process.exit(0)\"\n",
    (cmd) => { called.push(cmd); return 0; });
  assert.deepEqual(called.filter((c) => c.includes("fleet")), [],
    "a refused command must never actually execute");
  assert.equal(report.ok, true,
    "REFUSED is not a pass and not a failure -- beside a command that RAN it must not block a merge");
  assert.match(report.lines[0], /^ACCEPTANCE: REFUSED npm run fleet:deploy -> /);
});

test("acceptanceReport: REFUSED and a real failure together -- the real failure decides, REFUSED is still just named", () => {
  const body = "Acceptance:\nnpm run fleet:deploy\nnode -e \"process.exit(1)\"\n";
  const report = acceptanceReport(body, (cmd) => (cmd.includes("fleet") ? 0 : 1));
  assert.equal(report.ok, false, "the real, runnable command failing must still fail the whole report");
  assert.equal(report.lines.length, 2);
  assert.match(report.lines[0], /^ACCEPTANCE: REFUSED/);
  assert.match(report.lines[1], /^ACCEPTANCE: RAN .* -> fail/);
});

test("acceptanceReport: multiple runnable commands all pass -> ok:true, one line each", () => {
  const body = "Acceptance:\nnode -e \"process.exit(0)\"\nnode -e \"process.exit(0)\"\n";
  let calls = 0;
  const report = acceptanceReport(body, () => { calls += 1; return 0; });
  assert.equal(report.ok, true);
  assert.equal(calls, 2);
  assert.equal(report.lines.length, 2);
});

// --- testFileArgumentsResolve: the fifth hazard, found on #350 ---

test("testFileArgumentsResolve: a non-tsx command is untouched -- ok:true, never inspects its arguments", () => {
  assert.deepEqual(testFileArgumentsResolve("npm run lint"), { ok: true });
  assert.deepEqual(testFileArgumentsResolve("node -e \"process.exit(0)\""), { ok: true });
});

test("testFileArgumentsResolve: a real file resolves -- ok:true", () => {
  assert.deepEqual(testFileArgumentsResolve(`npx tsx --test ${REAL_FILE}`), { ok: true });
});

test("testFileArgumentsResolve: THE #350 SHAPE -- a glob matching nothing is caught, never silently ok", () => {
  const result = testFileArgumentsResolve(
    'npx tsx --test "packages/lab/src/packaging/nothing-matches-this-*.test.ts"');
  assert.equal(result.ok, false);
  // #728: NARROWED, not cast. This was `(/** @type {{missing:string[]}} */(result)).missing` -- a
  // `.mjs`-style inline JSDoc cast in a `.ts` file, which TypeScript ignores entirely, so it was inert
  // from the day it was written. Widening the return type surfaced it: `tsc` had nothing to disagree
  // with while the union had one `ok: false` member.
  assert.ok("missing" in result && result.missing.length > 0);
});

test("testFileArgumentsResolve: a literal missing path is caught the same way as a missing glob", () => {
  const result = testFileArgumentsResolve("npx tsx --test packages/lab/src/packaging/does-not-exist.test.ts");
  assert.equal(result.ok, false);
});

test("testFileArgumentsResolve: MUTATION TARGET -- one real file mixed with one missing file must still be caught", () => {
  // This is the exact shape dispatcher measured: `tsx --test` on its own exits 1 with "Could not find" for
  // a solitary missing file, but MIXED with a real one it exits 0 -- so the check must fail on ANY
  // unresolved argument, not just when every argument is missing.
  const result = testFileArgumentsResolve(
    `npx tsx --test ${REAL_FILE} packages/lab/src/packaging/does-not-exist.test.ts`);
  assert.equal(result.ok, false);
  // #728: narrowed rather than cast -- see the note above; the cast here was inert for the same reason.
  assert.ok("missing" in result, "a mixed real/missing line is a FILE failure, not an unparseable one");
  assert.deepEqual(result.missing, ["packages/lab/src/packaging/does-not-exist.test.ts"]);
});

test("testFileArgumentsResolve: flags are never treated as file arguments", () => {
  assert.deepEqual(testFileArgumentsResolve(`npx tsx --test --test-concurrency=4 ${REAL_FILE}`), { ok: true });
});

test("acceptanceReport: a tsx --test command matching nothing fails the report WITHOUT calling run()", () => {
  let called = false;
  const body = 'Acceptance:\nnpx tsx --test "packages/lab/src/packaging/nothing-matches-this-*.test.ts"\n';
  const report = acceptanceReport(body, () => { called = true; return 0; });
  assert.equal(report.ok, false);
  assert.equal(called, false, "a command already known to be bogus must never actually run");
  assert.match(report.lines[0], /matched no file/);
});

// --- #419: four forms authors keep writing, each measured against the real parser and hit by a real PR ---

// Form 1: a markdown heading is the header too.

test("#419 form 1: `## Acceptance` (bare heading, no colon) is a header, not MISSING", () => {
  const body = "## Acceptance\nnpx tsx --test a.test.ts\n";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["npx tsx --test a.test.ts"] });
});

test("#419 form 1: `## Acceptance:` (heading with colon) is a header", () => {
  const body = "## Acceptance:\nnpx tsx --test a.test.ts\n";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["npx tsx --test a.test.ts"] });
});

test("#419 form 1: `### Acceptance:` (a deeper heading level) is a header", () => {
  const body = "### Acceptance:\nnpx tsx --test a.test.ts\n";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["npx tsx --test a.test.ts"] });
});

test("#419 form 1: an inline command on the heading's own line still works", () => {
  assert.deepEqual(extractAcceptanceSection('## Acceptance: node -e "process.exit(0)"'),
    { kind: "commands", commands: ['node -e "process.exit(0)"'] });
});

test("#419 form 1: a later markdown heading (e.g. `## Mutation`) still ends the block as before", () => {
  const body = "## Acceptance\nnpx tsx --test a.test.ts\n## Mutation\nnpm run mutate -- --file=x\n";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["npx tsx --test a.test.ts"] });
});

test("#419 MUTATION TARGET (form 1): narrowing the header pattern back to the bare form must make every "
  + "heading case above read MISSING again", () => {
  const bareHeaderPattern = /^\s*(?:\*\*|__)?Acceptance:(?:\*\*|__)?\s*(.*)$/;
  assert.equal(bareHeaderPattern.test("## Acceptance"), false,
    "documents the exact regression this row exists to prevent -- the bare-only pattern cannot see a heading");
});

// Form 2: a backticked command is still the command.

test("#419 form 2: a WHOLE command wrapped in backticks, inline on the header, is unwrapped", () => {
  assert.deepEqual(extractAcceptanceSection("Acceptance: `npx tsx --test a.test.ts`"),
    { kind: "commands", commands: ["npx tsx --test a.test.ts"] });
});

test("#419 form 2: a WHOLE command wrapped in backticks, on its own line, is unwrapped", () => {
  const body = "Acceptance:\n`npx tsx --test a.test.ts`\n";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["npx tsx --test a.test.ts"] });
});

test("#419 form 2: a backticked command actually RUNS unwrapped, never as a literal backtick token", () => {
  let seen = "";
  const report = acceptanceReport("Acceptance: `node -e \"process.exit(0)\"`", (cmd) => { seen = cmd; return 0; });
  assert.equal(report.ok, true);
  assert.equal(seen, 'node -e "process.exit(0)"', "run() must never see the wrapping backticks");
});

test("#419 form 2: partial backticks INSIDE a command (the author's own quoting) are preserved", () => {
  assert.deepEqual(extractAcceptanceSection("Acceptance: node -e \"console.log(`template`)\""),
    { kind: "commands", commands: ['node -e "console.log(`template`)"'] });
});

test("#419 MUTATION TARGET (form 2): restoring the backtick-blind tokenizer must reproduce the exact "
  + "`fail (matched no file: \\`npx, ...)` shape this row exists to end", () => {
  const stillBackticked = "`npx tsx --test a.test.ts`";
  const result = testFileArgumentsResolve(stillBackticked);
  assert.equal(result.ok, false, "documents that the FILE CHECK alone cannot fix this -- unwrapping must "
    + "happen at extraction, before testFileArgumentsResolve ever sees the command");
});

// #658: a closing backtick is an end-of-command marker even when it is not the last character on the
// line, and a bare command's trailing em-dash commentary must never reach argv.

test("#658 THE REAL REGRESSION -- a backticked command followed by prose after the closing backtick "
  + "used to keep the leading backtick attached, reading as a missing executable", () => {
  const body = "Acceptance: `npx tsx --test a.test.ts` — 12/12 passing, was 7";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["npx tsx --test a.test.ts"] });
  assert.equal(classifyCommand("npx tsx --test a.test.ts").verdict, "runnable");
});

test("#658 the identical shape on its own line (not inline on the header) unwraps the same way", () => {
  const body = "Acceptance:\n`npx tsx --test a.test.ts` — 12/12 passing, was 7\n";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["npx tsx --test a.test.ts"] });
});

test("#658 a backticked command with trailing prose actually RUNS unwrapped, prose and all discarded", () => {
  let seen = "";
  const report = acceptanceReport(
    "Acceptance: `node -e \"process.exit(0)\"` — 12/12 passing", (cmd) => { seen = cmd; return 0; });
  assert.equal(report.ok, true);
  assert.equal(seen, 'node -e "process.exit(0)"',
    "run() must see neither the backticks nor the trailing commentary");
});

test("#658 THE MORE EXPENSIVE HALF -- a BARE command with trailing em-dash commentary must never reach "
  + "argv, even though extraction keeps the raw text (heading-title-not-command.test.ts's own contract)", () => {
  const body = "Acceptance: npx tsx --test a.test.ts — 12/12 passing";
  // Extraction stays literal -- this is the SAME rule heading-title-not-command.test.ts already pins for
  // a bare "none — nothing to run" command line, so this row's fix must not special-case away from it.
  assert.deepEqual(extractAcceptanceSection(body),
    { kind: "commands", commands: ["npx tsx --test a.test.ts — 12/12 passing"] });
  let seen = null;
  const report = acceptanceReport(body, (cmd) => { seen = cmd; return 0; });
  assert.equal(seen, null,
    "run() must never be called with a fabricated test file -- the file check must refuse first, "
    + "against the TRUNCATED command, before execution is ever attempted");
  assert.equal(report.ok, false, "a body that could not resolve to a real file must fail the report");
  assert.match(report.lines[0], /fail \(matched no file: a\.test\.ts\)/,
    "the failure must name the missing FILE, not blame npx or report a confusing executable-not-found");
});

test("#658 a BARE command with trailing prose, naming a REAL file, runs with the prose stripped from argv", () => {
  let seen = null;
  const body = "Acceptance: npx tsx --test packages/lab/src/packaging/acceptance-commands.test.ts — 12/12 passing";
  const report = acceptanceReport(body, (cmd) => { seen = cmd; return 0; });
  assert.equal(seen, "npx tsx --test packages/lab/src/packaging/acceptance-commands.test.ts",
    "the em-dash and everything after it must never reach argv");
  assert.equal(report.ok, true);
  // The REPORTED line still shows the ORIGINAL text, em-dash and all -- an author sees exactly what they
  // wrote, not a silently-edited version, even though a different string was what actually ran.
  assert.match(report.lines[0], /RAN npx tsx --test packages\/lab\/src\/packaging\/acceptance-commands\.test\.ts — 12\/12 passing -> pass/);
});

test("#658 CONTROL: heading-title-not-command.test.ts's own em-dash fixture is unaffected -- a bare "
  + "command line containing an em-dash, with no `Acceptance:`/`Refutation:` header at all, extracts "
  + "with its literal text intact", () => {
  // Reproduces that file's own fixture shape here too, so a future change to stripTrailingCommentary's
  // call site cannot silently regress this without a failure in THIS file as well as that one.
  const body = "## Acceptance — a title\n\nnone — nothing to run\n";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["none — nothing to run"] });
});

test("#658 ASCII `--` in a real command's own flags is never treated as a delimiter", () => {
  const body = "Acceptance: npm run build -- --production";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["npm run build -- --production"] });
  let seen = null;
  acceptanceReport(body, (cmd) => { seen = cmd; return 0; });
  assert.equal(seen, "npm run build -- --production",
    "an ASCII double-hyphen is real, common flag syntax and must reach argv unchanged");
});

test("#658 MUTATION TARGET: restoring the closing-backtick-must-be-last-character rule reproduces the "
  + "exact `no executable \"`npx\"` shape this row exists to end", () => {
  const original = "`npx tsx --test a.test.ts` — 12/12 passing, was 7";
  const stillAttached = /^`[^`]+`$/.test(original) ? original.slice(1, -1) : original;
  const classification = classifyCommand(stillAttached);
  assert.equal(classification.verdict, "prose",
    "the pre-fix tokenizer leaves the leading backtick attached to the executable name");
  assert.match((/** @type {{reason:string}} */(classification)).reason, /no executable "`npx"/,
    "documents the exact misleading message this row exists to end");
});

// Form 3: a `\` line continuation is one command, not two.

test("#419 form 3: a two-line continuation joins into ONE command", () => {
  const body = "Acceptance:\nnpx tsx --test \\\n  a.test.ts\n";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["npx tsx --test a.test.ts"] });
});

test("#419 form 3: a THREE-line continuation chain joins in full, not just the first pair", () => {
  const body = "Acceptance:\nnpx tsx --test \\\n  a.test.ts \\\n  b.test.ts\n";
  assert.deepEqual(extractAcceptanceSection(body),
    { kind: "commands", commands: ["npx tsx --test a.test.ts b.test.ts"] });
});

test("#419 form 3: a continuation is followed correctly by a SECOND, separate command", () => {
  const body = "Acceptance:\nnpx tsx --test \\\n  a.test.ts\nnpx tsx --test b.test.ts\n";
  assert.deepEqual(extractAcceptanceSection(body),
    { kind: "commands", commands: ["npx tsx --test a.test.ts", "npx tsx --test b.test.ts"] });
});

test("#419 form 3: a continuation inside a fenced block joins too", () => {
  const body = "Acceptance:\n```shell\nnpx tsx --test \\\n  a.test.ts\n```\n";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["npx tsx --test a.test.ts"] });
});

test("#419 MUTATION TARGET (form 3): a line NOT ending in a continuation must never be joined onto the next", () => {
  const body = "Acceptance:\nnpx tsx --test a.test.ts\nnpx tsx --test b.test.ts\n";
  const result = extractAcceptanceSection(body);
  assert.equal(result.kind, "commands");
  assert.equal((/** @type {{commands:string[]}} */(result)).commands.length, 2,
    "documents that joining is conditional on a real trailing backslash, not merely 'the next line exists'");
});

// --- #2068: an UNCLOSED QUOTE is a continuation too -- the same fact as `\` in another spelling ---
//
// The incident: #1989's Acceptance was a four-line `node --input-type=module -e '…'` that runs correctly
// in any shell. On the runner (PR #2064, run 35832677295) it reached `/bin/bash -c` as four fragments --
// `unexpected EOF while looking for matching '`, then three lines reported as "not a command" -- so
// `acceptance` was red and `gate` red behind it on a row whose command was right. Reflowed onto one line
// with identical semantics it passed. Nothing anywhere said the shape was forbidden.
//
// The population these tests have to separate: a line that ends MID-STRING (join it) from a line that
// merely CONTAINS a quote character (leave it alone). The second is the dangerous half -- joining a
// balanced line swallows the command after it, and a bare apostrophe in a comment is the shape that
// tempts a regex into exactly that.

const MULTILINE_FENCE = "## Acceptance\n\n```bash\nnode -e 'const a = 1;\nconsole.log(a);'\n```\n";

test("#2068: a fenced command that ends inside an open quote is ONE command, not one per line", () => {
  assert.deepEqual(extractAcceptanceSection(MULTILINE_FENCE),
    { kind: "commands", commands: ["node -e 'const a = 1;\nconsole.log(a);'"] });
});

test("#2068: the join keeps the NEWLINE the author wrote, because a newline inside a quote is part of "
  + "the string -- a space would silently rewrite any `python -c` whose indentation is its syntax", () => {
  const [command] = (extractAcceptanceSection(MULTILINE_FENCE) as { commands: string[] }).commands;
  assert.ok(command.includes("\n"), "the literal newline survives extraction");
  assert.equal(endsInsideQuote(command), false, "and the joined command is closed -- bash can run it");
});

test("#2068: what RUNS is the whole command -- run() sees one string, never the leading fragment that "
  + "produced `unexpected EOF while looking for matching '` on run 35832677295", () => {
  const seen: string[] = [];
  const body = "## Acceptance\n\n```bash\nnode --input-type=module -e 'const env = 21;\nprocess.exit(env === 21 ? 0 : 1);'\n```\n";
  const report = acceptanceReport(body, (cmd) => { seen.push(cmd); return 0; });
  assert.equal(report.ok, true);
  assert.deepEqual(seen, ["node --input-type=module -e 'const env = 21;\nprocess.exit(env === 21 ? 0 : 1);'"]);
});

test("#2068 NEGATIVE CONTROL: two balanced one-line commands stay TWO -- a joiner that joins "
  + "unconditionally passes every test above and fails this one", () => {
  assert.deepEqual(extractAcceptanceSection("## Acceptance\n\n```bash\nnpm run lint\nnpm run typecheck\n```\n"),
    { kind: "commands", commands: ["npm run lint", "npm run typecheck"] });
});

test("#2068 TRAP: a bare apostrophe in a trailing comment leaves the line BALANCED -- counting quote "
  + "characters would read `# don't skip` as open and swallow the command below it", () => {
  assert.deepEqual(extractAcceptanceSection("## Acceptance\n\n```bash\nnpm run lint # don't skip this\nnpm run typecheck\n```\n"),
    { kind: "commands", commands: ["npm run lint # don't skip this", "npm run typecheck"] });
});

test("#2068 TRAP: a quote NESTED inside the other kind is balanced -- `node -e 'const s = \"a\";'` and "
  + "`echo \"it's fine\"` each close, and neither may reach for the next line", () => {
  assert.deepEqual(extractAcceptanceSection("## Acceptance\n\n```bash\nnode -e 'const s = \"a\";'\necho \"it's fine\"\nnpm run typecheck\n```\n"),
    { kind: "commands", commands: ["node -e 'const s = \"a\";'", "echo \"it's fine\"", "npm run typecheck"] });
});

test("#2068 THE RUNAWAY: a quote that is never closed stops at the CLOSING FENCE -- a real typo must "
  + "cost one malformed command, not a body read wrongly from there to the end", () => {
  const body = "## Acceptance\n\n```bash\nnode -e 'oops\n```\n\n## Mutation\n\nsomething else\n";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["node -e 'oops"] });
});

test("#2068: the same shape in a BARE (unfenced) block joins, and still stops where the block ends", () => {
  const body = "Acceptance:\nnode -e 'const a = 1;\nconsole.log(a);'\n\nMutation: flip the joiner\n";
  assert.deepEqual(extractAcceptanceSection(body),
    { kind: "commands", commands: ["node -e 'const a = 1;\nconsole.log(a);'"] });
});

// --- #2178: a TRAILING OPERATOR is the third continuation -- `&&`, `||`, `|` and `|&` never end a command ---
//
// The incident shape: `npm run build &&` on one line and `npm test` on the next reached bash as two commands.
// The first is `syntax error: unexpected end of file`; the second runs ALONE and can be green, so the
// conjunction the author wrote (the second only if the first) asserted nothing. The first fragment also
// classified `runnable`, so nothing warned at filing time.

const fenced = (...lines: string[]) => `## Acceptance\n\n\`\`\`bash\n${lines.join("\n")}\n\`\`\`\n`;

test("#2178: a fenced line ending in EACH of the four operators joins the next line -- one command, "
  + "never one per line, and never one operator standing in for the family", () => {
  for (const op of ["&&", "||", "|", "|&"]) {
    assert.deepEqual(extractAcceptanceSection(fenced(`npm run build ${op}`, "  npm test")),
      { kind: "commands", commands: [`npm run build ${op} npm test`] }, `operator ${op}`);
  }
});

test("#2178: a chain of several operator-ended lines is ONE command", () => {
  assert.deepEqual(extractAcceptanceSection(fenced("gh issue list |", "  jq length |", "  cat")),
    { kind: "commands", commands: ["gh issue list | jq length | cat"] });
});

test("#2178: what RUNS is the whole conjunction -- run() never sees the `&&` fragment", () => {
  const seen: string[] = [];
  const report = acceptanceReport(fenced("npm run lint &&", "  npm run typecheck"), (cmd) => { seen.push(cmd); return 0; },
    { commandExists: () => true });
  assert.equal(report.ok, true);
  assert.deepEqual(seen, ["npm run lint && npm run typecheck"]);
});

test("#2178 NEGATIVE CONTROLS: an operator that does not END the line, a lone `&` (background -- a complete "
  + "command), and an escaped `\\|` each leave the next line a SEPARATE command -- a joiner with no operator "
  + "test fuses every two-command Acceptance in the repository", () => {
  assert.deepEqual(extractAcceptanceSection(fenced("npm run a && npm run b", "npm run c")),
    { kind: "commands", commands: ["npm run a && npm run b", "npm run c"] });
  assert.deepEqual(extractAcceptanceSection(fenced("npm run a &", "npm run c")),
    { kind: "commands", commands: ["npm run a &", "npm run c"] });
  assert.deepEqual(extractAcceptanceSection(fenced("echo a\\|", "npm run c")),
    { kind: "commands", commands: ["echo a\\|", "npm run c"] });
});

test("#2178 THE RUNAWAY: an operator on the last line of the block stops at the CLOSING FENCE", () => {
  const body = `${fenced("npm run build &&")}\n## Mutation\n\nsomething else\n`;
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["npm run build &&"] });
});

test("#2178: the same shape in a BARE (unfenced) block joins, and still stops where the block ends", () => {
  const body = "Acceptance:\nnpm run build &&\nnpm test\n\nMutation: flip the joiner\n";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["npm run build && npm test"] });
});

test("#2178: #2068's two shapes still join beside the new one -- the positive control for the counts above", () => {
  assert.deepEqual(extractAcceptanceSection(fenced("node -e 'const a = 1;", "console.log(a);'")),
    { kind: "commands", commands: ["node -e 'const a = 1;\nconsole.log(a);'"] });
  assert.deepEqual(extractAcceptanceSection(fenced("node -e 1 \\", "  --check")),
    { kind: "commands", commands: ["node -e 1 --check"] });
});

test("#2178: the operator scanner itself", () => {
  const cases: Array<[string, boolean]> = [
    ["npm run build &&", true], ["npm run build &&  ", true], ["a ||", true], ["a |", true], ["a |&", true],
    ["a&&", true],
    ["a &", false], ["a && b", false], ["a | b", false], ["a \\|", false], ["a", false], ["", false],
  ];
  for (const [text, expected] of cases) {
    assert.equal(endsInOperator(text), expected, `endsInOperator(${JSON.stringify(text)})`);
  }
});

test("#2178: a block-opening keyword is refused for what it IS, not for a binary it lacks -- `for` is a "
  + "command to bash, and `no executable` sends the filer looking for a missing program", () => {
  for (const line of ["for f in a b; do", "while true; do", "if true; then", "case x in", "do", "fi", "{"]) {
    const verdict = classifyCommand(line);
    assert.equal(verdict.verdict, "prose", line);
    assert.doesNotMatch((verdict as { reason: string }).reason, /no executable/, line);
    assert.match((verdict as { reason: string }).reason, /keyword/, line);
  }
});

test("#2178 CONTROL: a token that is not a keyword and not on $PATH keeps the `no executable` reason, and `[[` "
  + "(a complete one-line command) is not treated as a block edge", () => {
  const missing = classifyCommand("definitely-not-a-binary --x", { commandExists: () => false });
  assert.match((missing as { reason: string }).reason, /no executable "definitely-not-a-binary"/);
  const test2 = classifyCommand("[[ -f x ]]", { commandExists: () => false });
  assert.match((test2 as { reason: string }).reason, /no executable "\[\["/);
});

test("#2068: the quote scanner itself, on the shapes that decide the two halves apart", () => {
  const cases: [string, boolean][] = [
    ["node -e 'const a = 1;", true],
    ["node -e 'const a = 1;'", false],
    ["npm run lint # don't skip", false],
    ["node -e 'const s = \"a\";'", false],
    ["echo \"it's fine\"", false],
    ["echo \"unterminated", true],
    ["echo \\' balanced-by-escape", false],
    ["node -e \"const s = \\\"a\\\";\"", false],
    ["curl http://example.test/page#anchor", false],
  ];
  for (const [text, expected] of cases) {
    assert.equal(endsInsideQuote(text), expected, `endsInsideQuote(${JSON.stringify(text)})`);
  }
});

test("#2088: a word starts after any bash METACHARACTER, not after whitespace alone -- `;# don't` is a "
  + "comment to bash, and reading it as an open quote swallowed the NEXT Acceptance command", () => {
  // Every row here returned `true` before the fix: the scanner walked into the comment text and the
  // apostrophe in `don't` opened a quote that never closed. Each was RUN through real bash as
  // `<row>\necho second`, and what settles each one is that bash never complained about an unmatched
  // quote -- the first five run clean and print `second`, and the last four are syntax errors about
  // something ELSE (a `(` with no `)`, a redirect with no target), which is only possible if bash had
  // already eaten the `#` and the apostrophe after it as comment text.
  const cases: [string, boolean][] = [
    ["echo first;# don't", false],
    ["echo first |# don't", false],
    ["echo first &&# don't", false],
    ["echo first &# don't", false],
    ["(echo first)# don't", false],
    ["echo first\t# don't", false],
    ["(echo first;# don't", false],
    ["echo first >#don't", false],
    ["echo first <#don't", false],
  ];
  for (const [text, expected] of cases) {
    assert.equal(endsInsideQuote(text), expected, `endsInsideQuote(${JSON.stringify(text)})`);
  }
});

test("#2088 THE CONTROLS, which are not optional: a fix that returns `false` more often passes the rows "
  + "above and breaks the repo -- these are the shapes where `#` is NOT a comment, or where there is no "
  + "comment at all and the quote is genuinely open", () => {
  const cases: [string, boolean][] = [
    // The green side must stay reachable: these already held before the fix and must still hold.
    ["echo first # don't", false],
    ["# don't", false],
    ["curl http://example.test/page#anchor", false],
    // A genuinely unclosed quote still JOINS -- the whole reason `endsInsideQuote` exists.
    ["node -e 'const a = 1;", true],
    // An apostrophe INSIDE a comment is comment text even when the comment opens at a metacharacter:
    // real bash runs this clean and prints `first`, so widening where a comment may start must not be
    // hedged into "join anyway when the comment looks unbalanced".
    ["echo first;# oops 'still open", false],
    // A quote does NOT end a word, so the `#` after one stays inside that word and is not a comment --
    // which leaves the `'` in `don't` a real opening quote. Real bash agrees: `unexpected EOF while
    // looking for matching '`.
    ["echo 'a'# don't", true],
    ["echo \"a\"# don't", true],
    // An ESCAPED metacharacter does not end a word either, so this `#` is text and the `'` opens for
    // real -- bash says `unexpected EOF` here too. THIS IS THE ROW THAT KILLS THE NEAR-MISS FIX: the
    // same metacharacter set, looked up against `text[i - 1]` instead of carried, sees a bare `;` here
    // and calls a comment where bash has none. Measured -- that mutant fails on this row alone.
    ["echo a\\;# don't", true],
  ];
  for (const [text, expected] of cases) {
    assert.equal(endsInsideQuote(text), expected, `endsInsideQuote(${JSON.stringify(text)})`);
  }
});

test("#2088 END TO END: the swallowed command is the cost -- `;# don't` must leave the next Acceptance "
  + "line as its own command, not appended into a quote nobody opened", () => {
  const body = "## Acceptance\n\n```bash\nnpm run lint;# don't skip this\nnpm run typecheck\n```\n";
  assert.deepEqual(extractAcceptanceSection(body),
    { kind: "commands", commands: ["npm run lint;# don't skip this", "npm run typecheck"] });
});

// Form 4: a trailing `# comment` on a `tsx --test` line is not a file argument.

test("#419 form 4: a trailing comment on a tsx --test line does not fail the file check", () => {
  assert.deepEqual(testFileArgumentsResolve(`npx tsx --test ${REAL_FILE}  # 2/2, pass`), { ok: true });
});

test("#419 form 4: the comment is stripped for TOKEN EXTRACTION only -- the command that actually RUNS "
  + "still carries it, exactly as bash would already interpret it", () => {
  let seen = "";
  const body = `Acceptance:\nnpx tsx --test ${REAL_FILE}  # 2/2, pass\n`;
  const report = acceptanceReport(body, (cmd) => { seen = cmd; return 0; });
  assert.equal(report.ok, true);
  assert.equal(seen, `npx tsx --test ${REAL_FILE}  # 2/2, pass`,
    "run() must receive the ORIGINAL command, comment included -- bash ignores it natively");
});

test("#419 form 4: a comment naming a real-looking but nonexistent file is still correctly ignored", () => {
  assert.deepEqual(
    testFileArgumentsResolve(`npx tsx --test ${REAL_FILE} # see also does-not-exist.test.ts`),
    { ok: true });
});

test("#419 MUTATION TARGET (form 4): reverting to tokenizing the RAW command must reproduce the exact "
  + "`matched no file: #, ...` shape this row exists to end", () => {
  const tokens = `npx tsx --test ${REAL_FILE}  # 2/2, pass`.split(/\s+/).filter(Boolean);
  const fileArgs = tokens.filter((t) => t !== "npx" && t !== "tsx" && t !== "--test" && !t.startsWith("-"));
  const missing = fileArgs.filter((p) => !existsSync(p));
  assert.ok(missing.length > 0, "documents that the RAW tokenizer (no comment strip) reads the comment "
    + "text itself as file arguments -- exactly the defect this row fixes");
});

// --- #419 FOLLOW-UP, form 5: a blank line after the HEADER is not the terminator, only one after a
// command is. Markdown convention puts a blank line after every heading, so `## Acceptance` -- the form
// #419 itself just made acceptable -- combined with that convention landed straight back on MISSING,
// found live on PR #413. This form is MORE likely after #419's own fix, not less. ---

test("#419b form 5: a markdown heading followed by a blank line, then the command, is NOT missing", () => {
  // The exact shape measured on #413: `## Acceptance`, a blank line, then the command.
  const body = "## Acceptance\n\nnpx tsx --test a.test.ts\n";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["npx tsx --test a.test.ts"] });
});

test("#419b form 5: the BARE header followed by a blank line is the identical shape and must work too", () => {
  const body = "Acceptance:\n\nnpx tsx --test a.test.ts\n";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["npx tsx --test a.test.ts"] });
});

test("#419b form 5: MULTIPLE leading blank lines before the first command are all skipped", () => {
  const body = "## Acceptance\n\n\nnpx tsx --test a.test.ts\n";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["npx tsx --test a.test.ts"] });
});

test("#419b form 5: a blank line AFTER a real command still ends the block, exactly as before", () => {
  const body = "Acceptance:\nnpx tsx --test a.test.ts\n\nMore prose after a blank line.";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["npx tsx --test a.test.ts"] });
});

test("#419b form 5: a header with a blank line and NOTHING after it stays MISSING -- the leading-blank "
  + "skip must not manufacture a command that was never written", () => {
  const body = "Acceptance:\n\nMutation:\nnpm run mutate -- --file=x\n";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "missing" });
});

test("#419b form 5: two commands with a blank line only before the first are both read", () => {
  const body = "## Acceptance\n\nnpx tsx --test a.test.ts\nnpx tsx --test b.test.ts\n";
  assert.deepEqual(extractAcceptanceSection(body),
    { kind: "commands", commands: ["npx tsx --test a.test.ts", "npx tsx --test b.test.ts"] });
});

test("#419b MUTATION TARGET (form 5): removing the leading-blank skip must reproduce the exact MISSING "
  + "verdict measured live on PR #413", () => {
  // The naive, pre-fix behaviour: ANY blank line ends the block immediately, including the one that
  // markdown convention puts straight after a heading.
  const naiveBreakOnAnyBlank = (trimmed: string) => trimmed === "";
  assert.equal(naiveBreakOnAnyBlank(""), true,
    "documents the exact regression this row exists to prevent -- the naive rule cannot distinguish a "
    + "leading blank (before any command) from the real terminator (after one)");
});

// --- #510: a test file declares `// requires: <capability>`; a command naming it is REFUSED, named, in
// a job that does not have that capability -- rather than reporting a green RAN that only happened to be
// true because the test's own `t.skip()` fallback quietly passed. #497 adds the one axis a PR body can
// change: `History: full` deepens the checkout that declaration asks for. ---

test("#510 testFileRequirements: parses a comma-separated `// requires:` header, trimmed", () => {
  assert.deepEqual(testFileRequirements("// requires: history, token\nrest of file"), ["history", "token"]);
});

test("#510 testFileRequirements: absent header is an empty list, not an error", () => {
  assert.deepEqual(testFileRequirements("no header here at all"), []);
});

test("#510 testFileRequirements: found ANYWHERE in the file, not windowed to the first few lines -- this "
  + "repo's own test files carry long doc-comment headers before any `//` line (see HISTORY_FIXTURE)", () => {
  const text = "/**\n * a long doc comment\n * spanning several lines\n */\n// requires: history\nimport x;";
  assert.deepEqual(testFileRequirements(text), ["history"]);
});

test("#510 unmetRequirements: an UNKNOWN requirement word reads as unmet, never silently satisfied -- a "
  + "typo must never read as \"needs nothing\"", () => {
  assert.deepEqual(unmetRequirements(["gpu"], WITH_HISTORY), ["gpu"]);
});

test("#510 unmetRequirements: a satisfied requirement is filtered out", () => {
  assert.deepEqual(unmetRequirements(["history"], WITH_HISTORY), []);
});

test("#510 unmetCommandRequirements: the REAL history fixture, against a job with no history, names "
  + "itself as the declaring file", () => {
  assert.deepEqual(
    unmetCommandRequirements(`npx tsx --test ${HISTORY_FIXTURE}`, NO_HISTORY),
    [{ requirement: "history", files: [HISTORY_FIXTURE] }]);
});

test("#510 unmetCommandRequirements: the same fixture against a job WITH history has nothing unmet", () => {
  assert.deepEqual(unmetCommandRequirements(`npx tsx --test ${HISTORY_FIXTURE}`, WITH_HISTORY), []);
});

test("#510 unmetCommandRequirements: a file with no `// requires:` header at all names nothing", () => {
  assert.deepEqual(unmetCommandRequirements(`npx tsx --test ${REAL_FILE}`, NO_HISTORY), []);
});

test("#510 unmetCommandRequirements: a non-`tsx --test` command is never inspected", () => {
  assert.deepEqual(unmetCommandRequirements("npm run lint", NO_HISTORY), []);
});

test("#510 classifyCommand: the real history fixture is REFUSED, named, when the job has no history", () => {
  // #621: the CLOSURE-derived check runs first now, and its message names the file by BASENAME (matching
  // #621's own worked example, "board-document-chrome-resolver.test.ts requires token via
  // resolveChromeBinary -> board-document.mjs:<its gh spawn's line>") -- never the full repo-relative path
  // `unmetCommandRequirements`'s header-only message used. Both are correct; they answer different
  // questions ("what does the closure prove" vs. "what file declared it").
  const result = classifyCommand(`npx tsx --test ${HISTORY_FIXTURE}`, { capabilities: NO_HISTORY });
  assert.equal(result.verdict, "refused");
  assert.match((/** @type {{reason:string}} */(result)).reason, /`history`/);
  assert.match((/** @type {{reason:string}} */(result)).reason, /pre-push-resolve-toward-main\.test\.ts/);
});

test("#510 classifyCommand: MUTATION TARGET -- the identical command is runnable once history is "
  + "available", () => {
  assert.deepEqual(classifyCommand(`npx tsx --test ${HISTORY_FIXTURE}`, { capabilities: WITH_HISTORY }),
    { verdict: "runnable" });
});

test("#510 classifyCommand: defaults to FULL_CAPABILITIES when no capabilities are passed, so every "
  + "existing caller/test that never mentions capabilities is unaffected", () => {
  assert.deepEqual(classifyCommand(`npx tsx --test ${HISTORY_FIXTURE}`), { verdict: "runnable" });
});

test("#510 classifyCommand: a hypothetical `requires: token` is refused the same way, proven at the "
  + "pure-function layer since no real file in this repo declares it yet", () => {
  const text = "// requires: token\nrest of file";
  const unmet = unmetRequirements(testFileRequirements(text), NO_HISTORY);
  assert.deepEqual(unmet, ["token"], "token is structurally false in every real job -- FULL_CAPABILITIES "
    + "in a test is the only way this requirement is ever satisfied");
});

// --- #497: `History: full` in a PR body ---

test("#497 hasFullHistoryDeclaration: a bare `History: full` line is recognised", () => {
  assert.equal(hasFullHistoryDeclaration("Closes #1\nHistory: full\n"), true);
});

test("#497 hasFullHistoryDeclaration: absent from an ordinary body", () => {
  assert.equal(hasFullHistoryDeclaration("Closes #1\nAcceptance: npm test\n"), false);
});

test("#497 hasFullHistoryDeclaration: a MENTION mid-sentence does not count -- it must be the whole line", () => {
  assert.equal(hasFullHistoryDeclaration("This PR needs the full History: full commit graph to work."), false);
});

test("#497 jobCapabilities: history follows the body declaration; token/fleet/corpus are structurally "
  + "always false (#621: corpus joins them -- runs/ is gitignored, identical structural reason)", () => {
  assert.deepEqual(jobCapabilities("History: full"),
    { history: true, token: false, fleet: false, corpus: false });
  assert.deepEqual(jobCapabilities("Acceptance: npm test"),
    { history: false, token: false, fleet: false, corpus: false });
});

// --- #510/#497 integration through `acceptanceReport`, which is what `main()` actually calls ---

test("#510 acceptanceReport: the history fixture is REFUSED (named), not RAN, with no `History: full` "
  + "declared -- and REFUSED never fails the report on its own", () => {
  // The runnable second command is what keeps this a test about `history` rather than about a section
  // that examined nothing -- see the EXECUTED NOTHING rule below.
  const body = `Closes #1\nAcceptance:\nnpx tsx --test ${HISTORY_FIXTURE}\nnode -e "process.exit(0)"\n`;
  const report = acceptanceReport(body, () => 0);
  assert.equal(report.ok, true);
  assert.match(report.lines[0], /^ACCEPTANCE: REFUSED/);
  assert.match(report.lines[0], /`history`/);
});

test("#497 acceptanceReport: `History: full` makes the same fixture actually RUN", () => {
  const body = `Closes #1\nAcceptance: npx tsx --test ${HISTORY_FIXTURE}\nHistory: full\n`;
  const report = acceptanceReport(body, () => 0);
  assert.equal(report.ok, true);
  assert.match(report.lines[0], /^ACCEPTANCE: RAN/);
});

test("#497 acceptanceReport: `History: full` with a command that FAILS still fails the report -- the "
  + "declaration only changes whether the command runs, never whether its result counts", () => {
  const body = `Closes #1\nAcceptance: npx tsx --test ${HISTORY_FIXTURE}\nHistory: full\n`;
  const report = acceptanceReport(body, () => 1);
  assert.equal(report.ok, false);
});

test("#497 acceptanceReport: MUTATION TARGET -- `History: full` declared with NO command that uses it "
  + "gets a WARNING, and the warning never fails the report (\"worth a warning, not a refusal, since the "
  + "cost is only time\" -- #497's own stated boundary)", () => {
  const body = `Closes #1\nAcceptance: npx tsx --test ${REAL_FILE}\nHistory: full\n`;
  const report = acceptanceReport(body, () => 0);
  assert.equal(report.ok, true);
  assert.ok(report.lines.some((l) => l.startsWith("WARNING:") && l.includes("History: full")),
    "expected a WARNING line naming the unused declaration");
});

test("#497 acceptanceReport: no warning when `History: full` is declared and actually used", () => {
  const body = `Closes #1\nAcceptance: npx tsx --test ${HISTORY_FIXTURE}\nHistory: full\n`;
  const report = acceptanceReport(body, () => 0);
  assert.ok(!report.lines.some((l) => l.startsWith("WARNING:")), "no unused-declaration warning expected");
});

test("#497 acceptanceReport: no warning when `History: full` is simply absent", () => {
  const body = `Closes #1\nAcceptance: npx tsx --test ${REAL_FILE}\n`;
  const report = acceptanceReport(body, () => 0);
  assert.ok(!report.lines.some((l) => l.startsWith("WARNING:")));
});

// --- #540: a second Acceptance:/Refutation: header is DUPLICATE, never silently the first ---

test("#540 THE REAL REGRESSION -- two separate Acceptance: lines used to silently report only the first", () => {
  const body = "Acceptance: npm test\n\ntext\n\nAcceptance: npm run lint";
  assert.deepEqual(extractAcceptanceSection(body), {
    kind: "duplicate",
    occurrences: [
      { line: 1, text: "Acceptance: npm test" },
      { line: 5, text: "Acceptance: npm run lint" },
    ],
  });
});

test("#540 a single Acceptance: section is completely unaffected", () => {
  assert.deepEqual(extractAcceptanceSection("Acceptance: npm test"),
    { kind: "commands", commands: ["npm test"] });
});

test("#540 two `## Acceptance` markdown headings are ALSO caught, not just the bold/plain form", () => {
  const body = "## Acceptance\nnpm test\n\n## Acceptance\nnpm run lint";
  const section = extractAcceptanceSection(body);
  assert.equal(section.kind, "duplicate");
  assert.equal(section.occurrences.length, 2);
});

test("#540 acceptanceReport: DUPLICATE fails the job (ok: false) and names every occurrence's line and text", () => {
  const body = "Acceptance: npm test\n\ntext\n\nAcceptance: npm run lint";
  const report = acceptanceReport(body, () => 0);
  assert.equal(report.ok, false);
  assert.equal(report.lines.length, 1);
  assert.match(report.lines[0], /^ACCEPTANCE: DUPLICATE/);
  assert.match(report.lines[0], /line 1: "Acceptance: npm test"/);
  assert.match(report.lines[0], /line 5: "Acceptance: npm run lint"/);
});

test("#540 acceptanceReport: a DUPLICATE Acceptance: never runs any command from either section", () => {
  const body = "Acceptance: npm test\n\ntext\n\nAcceptance: npm run lint";
  let ran = false;
  acceptanceReport(body, () => { ran = true; return 0; });
  assert.ok(!ran, "a body this parser cannot read unambiguously must never execute anything from it");
});

test("#540 MUTATION TARGET -- restoring the old single-findIndex behaviour must make the two-section "
  + "fixture pass with ok:true, which is exactly the silent regression this row exists to end", () => {
  // Reproduces the pre-fix behaviour directly (not by re-implementing extractSection) so this test fails
  // if the real fix is ever reverted to `lines.findIndex`, without needing to touch acceptance-commands.mjs.
  const body = "Acceptance: npm test\n\ntext\n\nAcceptance: npm run lint";
  const lines = body.split(/\r\n|\r|\n/);
  const oldStyleHeaderIndex = lines.findIndex((line) => /^Acceptance:/.test(line));
  assert.equal(oldStyleHeaderIndex, 0, "the old, buggy read finds only the FIRST header");
  const currentBehaviour = extractAcceptanceSection(body);
  assert.notDeepEqual(currentBehaviour, { kind: "commands", commands: ["npm test"] },
    "the fixed parser must not silently agree with the old single-header read");
});

// --- #621: a test file's requirements are DERIVED from its import closure, not read off an opt-in
// header. board-document-chrome-resolver.test.ts has no `// requires:` header at all and reaches `gh`
// only transitively, through `resolveChromeBinary()` in packages/agent-org/src/board-document.mjs -- the fourth instance
// in two days of exactly this shape (#382), and the whole reason #510's header alone could never catch
// it: an opt-in declaration cannot catch the file whose author did not know there was something to
// declare. (Original worked example, board-style.test.ts via `collect()`, retired 2026-09-10 -- #906.) ---

test("#621 deriveClosureRequirements: board-document-chrome-resolver.test.ts reaches `gh` transitively, "
  + "via `resolveChromeBinary`, at the real line `board-document.mjs` spawns it on", () => {
  const hits = deriveClosureRequirements(BOARD_STYLE_FIXTURE);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].requirement, "token");
  assert.equal(hits[0].file.endsWith("packages/agent-org/src/board-document.mjs"), true);
  assert.equal(hits[0].line, boardDocumentSpawnLine(),
    "board-document.mjs's own gh spawn inside publishToDraftRelease, located by shape (#1458)");
});

test("#621 closureRequirementMessage: the EXACT worked example from the issue, naming the hop -- "
  + "\"this test needs a token\" sends a reader to the test; naming the module that spawns `gh` sends "
  + "them to the cause", () => {
  const [hit] = deriveClosureRequirements(BOARD_STYLE_FIXTURE);
  assert.equal(closureRequirementMessage(hit),
    `board-document-chrome-resolver.test.ts requires token via resolveChromeBinary → board-document.mjs:${boardDocumentSpawnLine()}`);
});

test("#621 unmetClosureRequirements: refused against a job with no token, satisfied against one that "
  + "has it", () => {
  assert.deepEqual(
    unmetClosureRequirements(BOARD_STYLE_FIXTURE, NO_TOKEN).map((u) => u.requirement),
    ["token"]);
  assert.deepEqual(unmetClosureRequirements(BOARD_STYLE_FIXTURE, WITH_TOKEN), []);
});

test("#621 unmetCommandClosureRequirements: a non-`tsx --test`, non-node-script command is never inspected", () => {
  assert.deepEqual(unmetCommandClosureRequirements("npm run lint", NO_TOKEN), []);
});

// #2724: `board:settle` (`node packages/agent-org/src/settle-closed-rows.mjs`) is the row's OWN worked
// example -- an operational npm script whose module spawns `gh` directly (`execFileSync("gh", ...)` at its
// own top level, not through a `.test.ts` entry), which nothing before this row's fix ever asked
// `classifyCommand` to walk. Using the real script rather than an invented fixture keeps this test honest
// about the actual defect: a temp-dir fixture cannot be named by a `package.json` script without touching
// `package.json` itself, and the real instance already exists.
const SPAWNS_GH_SCRIPT = "packages/agent-org/src/settle-closed-rows.mjs";

test("#2724 unmetCommandClosureRequirements: `npm run board:settle` is now inspected, naming its own `gh` "
  + "spawn -- the population `testFilesRunBy` alone could never see, because the command names no "
  + "`.test.ts` file at all", () => {
  assert.ok(existsSync(SPAWNS_GH_SCRIPT), "the fixture script itself must exist for this test to mean anything");
  const unmet = unmetCommandClosureRequirements("npm run board:settle", NO_TOKEN);
  assert.equal(unmet.length, 1, JSON.stringify(unmet));
  assert.equal(unmet[0].requirement, "token");
  assert.match(unmet[0].message, /settle-closed-rows\.mjs requires token, at settle-closed-rows\.mjs:\d+/);
});

test("#2724 ACCEPTANCE: classifyCommand REFUSES `npm run board:settle` for `token`, exactly as a bare "
  + "`gh ...` line is refused today -- the shape #2724 was filed to close: `classifyCommand` used to fall "
  + "through to `runnable` for this line, and the credential-less acceptance job would have executed it "
  + "for real", () => {
  const result = classifyCommand("npm run board:settle", { capabilities: NO_TOKEN });
  assert.equal(result.verdict, "refused");
  const reason = (/** @type {{reason:string}} */ (result)).reason;
  assert.match(reason, /`token`/);
  assert.match(reason, /settle-closed-rows\.mjs requires token, at settle-closed-rows\.mjs:\d+/);
});

test("#2724 MUTATION TARGET: the identical command RUNS once the job's capabilities carry a token -- "
  + "proving the refusal above tracked the real capability, not a hard-coded no", () => {
  const withToken = { ...NO_TOKEN, token: true };
  const result = classifyCommand("npm run board:settle", { capabilities: withToken });
  assert.equal(result.verdict, "runnable");
});

test("#2724: a chain naming the operational script anywhere is still refused (#2207's own shape, "
  + "extended to a plain npm script name)", () => {
  const result = classifyCommand("npm run lint && npm run board:settle", { capabilities: NO_TOKEN });
  assert.equal(result.verdict, "refused");
  assert.match((/** @type {{reason:string}} */ (result)).reason, /settle-closed-rows\.mjs/);
});

// #2724: `singleNodeInvocation` decides which `npm run <script>` bodies resolve to a single file at all --
// crisp, falsifiable examples on the string itself, rather than leaning on whether some real script happens
// to spawn `gh` (most do not, so a wrong resolution and a correct one would print the identical `[]`).
test("#2724 singleNodeInvocation: a bare `node <file>` body resolves to the file", () => {
  assert.equal(singleNodeInvocation("node packages/agent-org/src/settle-closed-rows.mjs"),
    "packages/agent-org/src/settle-closed-rows.mjs");
});

test("#2724 singleNodeInvocation: trailing flags are ignored, leading env assignments are stripped -- the "
  + "real shapes `training:check-signals:complete` and `eval:capture` are written in", () => {
  assert.equal(singleNodeInvocation("node packages/lab/src/training/check-signals.mjs --require-complete"),
    "packages/lab/src/training/check-signals.mjs");
  assert.equal(
    singleNodeInvocation("A11Y_PYTHON=.venv/bin/python node packages/lab/src/harnesses/capture-fixtures.mjs"),
    "packages/lab/src/harnesses/capture-fixtures.mjs");
});

test("#2724 singleNodeInvocation: a script chaining a further command of its own resolves to nothing -- "
  + "the real `guards:sweep` shape (`node a.mjs | xargs node b.mjs`), which this function must not guess "
  + "at rather than picking either half", () => {
  assert.equal(singleNodeInvocation("node packages/guards/src/tree-wide-guards.mjs | xargs node "
    + "packages/guards/src/assert-glob-not-empty.mjs --min=1 --run --runner=rstest"), null);
  assert.equal(singleNodeInvocation("node a.mjs && node b.mjs"), null);
});

test("#2724 singleNodeInvocation: a non-`node` executable resolves to nothing -- the real `lint` shape "
  + "(`eslint .`)", () => {
  assert.equal(singleNodeInvocation("eslint ."), null);
});

test("#621 ACCEPTANCE: classifyCommand REFUSES board-document-chrome-resolver.test.ts, named, naming the "
  + "chain -- with NO `// requires:` header on the file at all, proving the refusal comes from the "
  + "closure and not from a declaration", () => {
  assert.ok(existsSync(BOARD_STYLE_FIXTURE), "the fixture itself must exist for this test to mean anything");
  assert.deepEqual(testFileRequirements(readFileSync(BOARD_STYLE_FIXTURE, "utf8")), [],
    "sanity: board-document-chrome-resolver.test.ts truly declares no // requires: header -- if this ever "
    + "gains one, the refusal below could be coming from #510's header path instead of #621's closure "
    + "derivation");
  const result = classifyCommand(`npx tsx --test ${BOARD_STYLE_FIXTURE}`, { capabilities: NO_TOKEN });
  assert.equal(result.verdict, "refused");
  const reason = (/** @type {{reason:string}} */ (result)).reason;
  assert.match(reason, /`token`/);
  assert.match(reason,
    new RegExp(`board-document-chrome-resolver\\.test\\.ts requires token via resolveChromeBinary → board-document\\.mjs:${boardDocumentSpawnLine()}\\b`));
});

test("#621 MUTATION TARGET: the identical command RUNS once the job's capabilities carry a token -- "
  + "proving the refusal above tracked the real capability, not a hard-coded no", () => {
  const result = classifyCommand(`npx tsx --test ${BOARD_STYLE_FIXTURE}`, { capabilities: WITH_TOKEN });
  assert.equal(result.verdict, "runnable");
});

test("#621 MUTATION direction (the issue's own instruction): WITHOUT the closure derivation, "
  + "board-document-chrome-resolver.test.ts is classified purely on its (nonexistent) header and RUNS "
  + "against a tokenless job -- reproducing, from a copy of the pre-#621 mechanism, the exact live "
  + "failure #382/#619 measured four times", () => {
  // Reproduces the OLD, header-only path directly (unmetCommandRequirements, never touching the closure
  // walk) so this fails if #621's derivation is ever bypassed or deleted, without needing to touch
  // acceptance-commands.mjs itself.
  const preClosureUnmet = unmetCommandRequirements(`npx tsx --test ${BOARD_STYLE_FIXTURE}`, NO_TOKEN);
  assert.deepEqual(preClosureUnmet, [],
    "the header-only mechanism finds NOTHING unmet here -- board-document-chrome-resolver.test.ts "
    + "declares no header, so "
    + "the pre-#621 code would have classified this command RUNNABLE against a job with no token, which "
    + "is precisely the defect this row exists to close");
});

// NOTE ON THIS TEST'S OWN NAME: deliberately does not spell out, verbatim, the three identifiers
// acceptance-commands.mjs's patterns search for -- this file (acceptance-commands.test.ts) is ITSELF
// walked by the test below, and a test NAME is a string literal, real code, not a comment. Spelling them
// out here reproduces the exact bug on the very test written to guard against it -- caught live on this
// row's first run, one level up from where it was already caught inside acceptance-commands.mjs.
test("#621 SELF-REFERENCE REGRESSION: acceptance-commands.mjs describes the three fingerprinted "
  + "identifiers (the GitHub token env var, the runs-root override vars, the shallow-checkout flag) in "
  + "its OWN comments and regex literals, and acceptance-commands.test.ts imports it -- the derivation "
  + "must not read its own describing code as performing the operations it describes. Found live: the "
  + "first version of this row derived a requirement from acceptance-commands.mjs's own comment prose, "
  + "and separately from its own regex-literal SOURCE TEXT (comment-stripping cannot fix that half -- the "
  + "fingerprint is real code). Both classes are fixed; this pins zero derived requirements for the file "
  + "that defines them.", () => {
  const hits = deriveClosureRequirements(REAL_FILE);
  assert.deepEqual(hits, [], `acceptance-commands.test.ts must derive NOTHING from its own closure -- `
    + `found: ${hits.map((h) => closureRequirementMessage(h)).join("; ")}`);
});

test("#621 local-import-closure.mjs's own JSDoc example is not read as a real import -- it demonstrates "
  + "`import { collect } from \"./board-data.mjs\"` as prose, and a comment-unaware walk treated that "
  + "as a genuine edge into board-data.mjs, adding a phantom \"token\" hit with a nonsensical chain "
  + "(\"classifyCommand -> localImports -> collect -> board-data.mjs\") to any file merely importing "
  + "`localImports` from it", () => {
  const hits = deriveClosureRequirements("packages/guards/src/local-import-closure.mjs");
  assert.deepEqual(hits, [], "the shared closure-walk module must derive nothing from its own docstring");
});

test("#621 anyCommandUsesHistory (via acceptanceReport): a closure-derived history need is recognised as "
  + "\"used\" even with no `// requires:` header -- pre-push-stale-base.test.ts needs history (its own "
  + "REAL ARTEFACT test asks the shallow-checkout question) but declares no header; `History: full` "
  + "naming it must not warn as unused", () => {
  const body = "Closes #1\nAcceptance: npx tsx --test "
    + "packages/lab/src/packaging/pre-push-stale-base.test.ts\nHistory: full\n";
  const report = acceptanceReport(body, () => 0);
  assert.ok(!report.lines.some((l) => /WARNING/.test(l)),
    `expected no unused-History warning; got: ${report.lines.join(" | ")}`);
});

// --- #731: `runsRoot` (the corpus-location resolver) means TWO things -- reading evidence, and choosing a
// writable location -- and the closure walk above could only ask one question of a call to it. #718
// (git-fixture-cache.mjs, a real file that called it to pick a cache location it creates itself) was the
// motivating case and was REVERTED as the incident's stopgap while this fix landed -- so it is gone from
// `main`, and a test naming it as its subject would pass or fail on whether somebody reverted that file,
// which is exactly what happened here. THE CLASSIFIER'S BEHAVIOUR IS THE SUBJECT; a file that happens to
// exercise it is not -- so every fixture below is built by the test, not borrowed from the tree, except
// `corpus-settled.mjs` (kept deliberately: a REAL file whose corpus dependency is real, the boundary that
// stops this fix becoming "never refuse").
//
// NEITHER THIS SECTION NOR ITS FIXTURES SPELL THE RESOLVER'S NAME FOLLOWED BY `(` CONTIGUOUSLY -- this file
// is itself walked by the #621 self-reference test below, and a call-shaped mention in a test NAME or a
// fixture STRING LITERAL is real code, not a comment; `stripComments` cannot fix that half. Every mention
// here either drops the trailing parenthesis (harmless in prose) or is built the same concatenated way
// `fingerprint()` builds its own patterns in acceptance-commands.mjs. ---

const REAL_JOB_CAPABILITIES = jobCapabilities("History: full");
// Matches acceptance-commands.mjs's own `fingerprint` -- concatenated so the resolver's name never
// appears contiguously in this file's own source.
const spell = (a: string, b: string) => a + b;

/**
 * A SYNTHETIC git-fixture-cache.mjs-SHAPED writer -- the general case #718 was the specific instance of: a
 * module that calls the corpus-root resolver only to choose a location it creates itself (a real
 * `mkdirSync`, at the declared subdirectory), declares that honestly, and never reads pre-existing
 * evidence there.
 */
function writeSyntheticCacheWriter(dir: string, subdir = "synthetic-cache"): string {
  const fixture = join(dir, "cache-writer.mjs");
  writeFileSync(fixture, [
    `// writes: runs/${subdir}`,
    "import { mkdirSync } from \"node:fs\";",
    "import { join } from \"node:path\";",
    `export function useCache() { mkdirSync(join(${spell("runsRo", "ot()")}, "${subdir}"), { recursive: true }); }`,
  ].join("\n"));
  return fixture;
}

test("#731 REGRESSION: an entry that imports a write-only corpus-root user, TWO HOPS deep, classifies "
  + "runnable -- the shape #718's real chain had (a test → a helper → the resolver)", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-writes-"));
  try {
    writeSyntheticCacheWriter(dir);
    const entry = join(dir, "consumer.test.mjs");
    writeFileSync(entry, [
      "import { useCache } from \"./cache-writer.mjs\";",
      "useCache();",
    ].join("\n"));
    const result = classifyCommand(`npx tsx --test ${entry}`, { capabilities: REAL_JOB_CAPABILITIES });
    assert.equal(result.verdict, "runnable",
      `expected runnable; got: ${JSON.stringify(result)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#731: a write-only corpus-root user derives NO requirement at all from its own call, now that its "
  + "`// writes:` declaration is verified against a real mkdirSync at the declared path", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-writes-"));
  try {
    const writer = writeSyntheticCacheWriter(dir);
    const hits = deriveClosureRequirements(writer);
    assert.deepEqual(hits, [], `expected no hits; got: ${hits.map(closureRequirementMessage).join("; ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#731: a file that genuinely reads the corpus is UNAFFECTED -- the fix must not become "
  + "\"never refuse\"; dataset-paths.mjs's own corpus-root definition, reached with no `// writes:` "
  + "declaration at all, still derives `corpus`. A REAL file, deliberately: this is the boundary that "
  + "stops the fix over-reaching, and `rules:gate`/`check-signals`/`corpus:starvation`/`scorer:shortcuts` "
  + "all depend on it staying true", () => {
  const hits = deriveClosureRequirements("packages/lab/src/training/corpus-settled.mjs");
  assert.deepEqual(hits.map((h) => h.requirement), ["corpus"],
    "a real corpus-reading chain must still be caught");
  assert.equal(hits[0].wrongDeclaration, undefined, "no declaration was made here, so none can be wrong");
});

test("#731: a `// writes:` declaration that does not hold is named as WRONG, never silently trusted and "
  + "never silently overridden -- a file claiming a write location its own code never touches must still "
  + "refuse as corpus, with a message pointing at the bad declaration rather than a generic one", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-writes-"));
  try {
    const fixture = join(dir, "wrong-declaration-fixture.mjs");
    writeFileSync(fixture, [
      "// writes: runs/somewhere-this-file-never-touches",
      "export function readsCorpusButClaimsToWrite() {",
      `  const dir = ${spell("runsRo", "ot()")};`,
      "  return dir;",
      "}",
    ].join("\n"));
    const hits = deriveClosureRequirements(fixture);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].requirement, "corpus");
    assert.equal(hits[0].wrongDeclaration, true);
    assert.match(closureRequirementMessage(hits[0]), /declares `\/\/ writes:`.*does not bear out/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#731 MUTATION: point a write-only corpus-root user's declared write path at somewhere it does not "
  + "actually write, and its closure hit must return -- proving the exemption is EARNED by the file's own "
  + "code, not granted by the header alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-writes-"));
  try {
    const writer = writeSyntheticCacheWriter(dir);
    const clean = readFileSync(writer, "utf8");
    assert.match(clean, /^\/\/ writes: runs\/synthetic-cache$/m,
      "sanity: the fixture must actually carry the declaration this test mutates");
    const mutated = clean.replace("// writes: runs/synthetic-cache", "// writes: runs/somewhere-else");
    assert.notEqual(mutated, clean, "the replacement must actually land, or this proves nothing");
    writeFileSync(writer, mutated);
    const hits = deriveClosureRequirements(writer);
    assert.equal(hits.length, 1, `expected the corpus hit to return once the declaration no longer holds; `
      + `got: ${JSON.stringify(hits)}`);
    assert.equal(hits[0].wrongDeclaration, true,
      "the declared path no longer matches what the file's own mkdirSync call actually writes to");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- #827: `token` means TWO things too -- a file whose OWN operation needs it, and a file that merely
// SHARES A MODULE with one that does. `board-markdown.test.ts`/`board-achievement-retirement.test.ts` each
// import only `document` from `board-document.mjs`, render it from a literal fixture, and pass with `gh`
// stubbed to exit 4 -- but the walk scans the WHOLE FILE's text for every pattern, not the one export a
// caller actually imports, so reaching `board-document.mjs` at all charges every test for its OTHER
// export (`todaysReleaseExists`, a real `gh release view` spawn) even when that export is never imported.
//
// SAME SELF-REFERENCE DISCIPLINE AS THE #731 SECTION ABOVE: this file is walked by its own #621
// self-reference test (`REAL_FILE`, above), so nothing here spells `execFileSync("gh"` contiguously --
// every fixture builds it through `spell()`, exactly as the corpus section builds `runsRoot(`. ---

/**
 * A SYNTHETIC board-document.mjs-SHAPED module: one file exporting a SAFE function (pure, no `gh`) beside
 * a RISKY one (spawns `gh`) -- the real shape #827 fixes. `riskyFnName` is a parameter, never a shared
 * default, so a mutation test below can be sure it is naming the SAME identifier it declares against.
 */
function writeSyntheticMixedModule(dir: string, riskyFnName: string): string {
  const fixture = join(dir, "mixed-module.mjs");
  writeFileSync(fixture, [
    "import { execFileSync } from \"node:child_process\";",
    "export function safeRender(x) { return String(x); }",
    `export function ${riskyFnName}() { execFileSync("${spell("g", "h")}", ["release", "view"]); }`,
  ].join("\n"));
  return fixture;
}

test("#827 REGRESSION: an entry importing ONLY the safe export of a mixed module is STILL charged token, "
  + "with no declaration -- the exact live shape (board-markdown.test.ts before this row) proving the "
  + "fix below is earned, not merely a walk that stopped looking", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-token-"));
  try {
    writeSyntheticMixedModule(dir, "checkRelease");
    const entry = join(dir, "consumer.test.mjs");
    writeFileSync(entry, [
      "import { safeRender } from \"./mixed-module.mjs\";",
      "safeRender(1);",
    ].join("\n"));
    const hits = deriveClosureRequirements(entry);
    assert.deepEqual(hits.map((h) => h.requirement), ["token"],
      `expected a token hit with no declaration; got: ${hits.map(closureRequirementMessage).join("; ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#827: an entry that declares `// no-token: <fn>` and genuinely never calls that function derives NO "
  + "requirement at all, even though the module it imports contains a real `gh` spawn elsewhere", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-token-"));
  try {
    writeSyntheticMixedModule(dir, "checkRelease");
    const entry = join(dir, "consumer.test.mjs");
    writeFileSync(entry, [
      "// no-token: checkRelease",
      "import { safeRender } from \"./mixed-module.mjs\";",
      "safeRender(1);",
    ].join("\n"));
    const hits = deriveClosureRequirements(entry);
    assert.deepEqual(hits, [], `expected no hits; got: ${hits.map(closureRequirementMessage).join("; ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#827: `// no-token:` is checked ONCE against the entry, not per-file -- an entry TWO HOPS from the "
  + "risky module, through a pure re-export, is exempted the same way", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-token-"));
  try {
    writeSyntheticMixedModule(dir, "checkRelease");
    const helper = join(dir, "helper.mjs");
    writeFileSync(helper, [
      "export { safeRender } from \"./mixed-module.mjs\";",
    ].join("\n"));
    const entry = join(dir, "consumer.test.mjs");
    writeFileSync(entry, [
      "// no-token: checkRelease",
      "import { safeRender } from \"./helper.mjs\";",
      "safeRender(1);",
    ].join("\n"));
    const hits = deriveClosureRequirements(entry);
    assert.deepEqual(hits, [], `expected no hits two hops deep; got: ${hits.map(closureRequirementMessage).join("; ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#827: a `// no-token:` declaration naming a function the entry's OWN code DOES call is named as "
  + "WRONG, never silently trusted -- a file claiming it avoids a call it actually makes must still refuse "
  + "as token, with a message pointing at the bad declaration rather than a generic one", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-token-"));
  try {
    writeSyntheticMixedModule(dir, "checkRelease");
    const entry = join(dir, "consumer.test.mjs");
    writeFileSync(entry, [
      "// no-token: checkRelease",
      "import { checkRelease } from \"./mixed-module.mjs\";",
      "checkRelease();",
    ].join("\n"));
    const hits = deriveClosureRequirements(entry);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].requirement, "token");
    assert.equal(hits[0].wrongDeclaration, true);
    assert.match(closureRequirementMessage(hits[0]), /declares `\/\/ no-token:`.*DOES call/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#827 MUTATION: an entry that genuinely earns its exemption, then edited to also call the risky "
  + "function, must lose it -- proving the exemption is EARNED by the entry's own code, not granted by "
  + "the header alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-token-"));
  try {
    writeSyntheticMixedModule(dir, "checkRelease");
    const entry = join(dir, "consumer.test.mjs");
    const clean = [
      "// no-token: checkRelease",
      "import { safeRender, checkRelease } from \"./mixed-module.mjs\";",
      "safeRender(1);",
    ].join("\n");
    writeFileSync(entry, clean);
    assert.deepEqual(deriveClosureRequirements(entry), [], "sanity: the clean fixture must be exempt first");
    const mutated = `${clean}\ncheckRelease();\n`;
    assert.notEqual(mutated, clean, "the mutation must actually land, or this proves nothing");
    writeFileSync(entry, mutated);
    const hits = deriveClosureRequirements(entry);
    assert.equal(hits.length, 1, `expected the token hit to return; got: ${JSON.stringify(hits)}`);
    assert.equal(hits[0].wrongDeclaration, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#827: removing every runnable command from a body must still not report success -- #826's own rule, "
  + "unaffected by this row's declaration mechanism (a REFUSED-only report is its own state, never `ok`)", () => {
  const body = "Closes #1\nAcceptance: npm test\n";
  const report = acceptanceReport(body, () => 0);
  assert.equal(report.ok, false, "a whole-suite command naming no file must still fail the job");
});

// #827's own two REAL fixtures, board-markdown.test.ts and board-achievement-retirement.test.ts, retired
// 2026-09-10 in guard triage 4 of 6 (#906). No other surviving packaging test imports only a SAFE export
// of a module that also spawns `gh` elsewhere, so the acceptance test that named them directly (asserting
// their `// no-token:` declaration was honoured) is removed rather than re-pointed at a fixture that would
// not reproduce the same shape. The mechanism itself is unaffected and still proven by the REGRESSION and
// MUTATION tests above, against `writeSyntheticMixedModule` -- this test was the additional, real-world
// confirmation, and its premise (these two specific files existing) is now false.

// --- #513's OTHER HALF: the command everybody actually types ---
//
// `unmetCommandRequirements` and `unmetCommandClosureRequirements` both opened with
// `if (!/tsx --test/.test(command)) return []`, so the capability gate asked whether a command NAMED a
// file needing a capability. `npm test` names none and runs them all.
//
// Measured 2026-09-09: four PRs red on `acceptance / run` at once, every one for `gh: To use GitHub CLI
// in a GitHub Actions workflow, set the GH_TOKEN environment variable`, in a job that passes no token BY
// DESIGN because it runs commands taken from a stranger's PR body. None of the four had touched the code
// that failed; the check named their authors for a line they never wrote.
//
// #513 split `row-claim-live.test.ts` out precisely so a `tsx --test` command naming it could be refused.
// That half worked. This is the half nobody had.

test("A WHOLE-SUITE COMMAND IS SEEN BY THE CAPABILITY GATE -- `npm test` names no file and runs all of "
  + "them, and asking whether it NAMES one is a question about the adjacent property", () => {
  const caps = { history: false, token: false, fleet: false, corpus: false };
  const verdict = classifyCommand("npm test", { capabilities: caps });
  assert.equal(verdict.verdict, "refused");
  assert.match(verdict.reason, /which this job does not have/);
  assert.match(verdict.reason, /\.test\.ts/, "the refusal must NAME a file, or it is not followable");
});

test("`npm run test:ts` is the same command by another name, and the gate must not be fooled by which "
  + "spelling an author used", () => {
  const caps = { history: false, token: false, fleet: false, corpus: false };
  assert.equal(classifyCommand("npm run test:ts", { capabilities: caps }).verdict, "refused");
});

test("CONTROL: a job WITH the capabilities still runs the suite -- this gate refuses on absence, never "
  + "on the command's shape", () => {
  const caps = { history: true, token: true, fleet: true, corpus: true };
  assert.equal(classifyCommand("npm test", { capabilities: caps }).verdict, "runnable");
});

test("CONTROL: a command that merely mentions the word test is not a whole-suite command", () => {
  const caps = { history: false, token: false, fleet: false, corpus: false };
  assert.equal(runsTheWholeSuite("node scripts/test-helper.mjs"), false);
  assert.equal(runsTheWholeSuite("npm run test:python"), false,
    "python has its own population and its own skip -- widening this to every `test:` script would "
    + "refuse a command whose files this walk never examined");
  assert.equal(classifyCommand("node -e \"process.exit(0)\"", { capabilities: caps }).verdict, "runnable");
});

/**
 * THE FLOOR. Every assertion above is satisfied by finding FEWER files: an empty population makes the
 * union of requirements empty, a whole-suite command reads as needing nothing, and the gate passes having
 * examined nothing -- the failure this whole mechanism exists to prevent, reintroduced one layer up.
 *
 * `suiteTestFiles` throws rather than returning `[]` for the same reason, and this proves the glob it
 * reads out of `package.json` actually resolves against this tree. PER SCRIPT since #2153, because the
 * floor is now four populations rather than one, and a floor asserted on only the widest of them would
 * be met by three empty ones.
 */
test("every suite script's population is real -- a floor, because every check above passes vacuously "
  + "over an empty one", () => {
  for (const script of SUITE_SCRIPTS) {
    const files = suiteTestFiles(script);
    assert.ok(files.length >= 180,
      `\`${script}\` resolved to only ${files.length} test file(s); the narrowest of these scripts `
      + "asserts --min=180 for itself, so fewer means the glob no longer resolves and this gate is "
      + "answering about a population it never examined");
  }
  assert.ok(suiteTestFiles("test:all").some((f: string) => f.endsWith("row-claim-live.test.ts")),
    "the file whose token requirement started this must be IN the population, or the gate cannot have "
    + "caught it");
});

/**
 * #2153 -- THE PREDICATE AND THE POPULATION MUST ANSWER ABOUT THE SAME SCRIPT.
 *
 * `runsTheWholeSuite` said yes to `npm test`/`npm run test:ts` and no to `npm run test:org`/`test:all`,
 * while the population it selected was `test:all`'s glob for all of them. Both halves were wrong at once
 * and in opposite directions: the narrow commands were charged 419 files they never load (and refused for
 * one of them), and the wide commands were not recognised, fell through to `tsxTestFileArgs`, tokenised
 * into three words that are not files, and were handed to the runner having been charged nothing.
 *
 * MEASURED: at the head this landed on, `test:ts` resolved 220 files and `test:all` 641.
 */
test("the four suite script names are `package.json`'s OWN, not a retyped list", () => {
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
  assert.equal(SUITE_SCRIPTS.length, 4,
    "four spellings run a whole `.test.ts` suite here, and DROPPING one is the defect this row fixed -- "
    + "an unrecognised whole-suite command is charged nothing at all, not charged less");
  for (const name of SUITE_SCRIPTS) {
    assert.ok(typeof scripts[name] === "string",
      `\`${name}\` is not a script in package.json -- this list decides which commands the capability `
      + "gate charges, so a name that no longer exists charges nothing and reads as a command that needs "
      + "nothing");
    assert.deepEqual(suiteScriptsFor(`npm run ${name}`), [name],
      `\`npm run ${name}\` must resolve to \`${name}\`, or the list and the pattern built from it disagree`);
  }
  // THE COMPLEMENT, so "every name resolves" is not satisfied by a pattern that resolves everything.
  assert.deepEqual(suiteScriptsFor("npm run test:python"), [],
    "python's population is the pytest tree, not the `.test.ts` glob these callers walk");
  assert.deepEqual(suiteScriptsFor("npm run test:changed"), [],
    "`test:changed` has no fixed glob -- it is not a whole-suite command and must not be given one");
});

test("DIRECTION 1 -- `npm test` is charged the files it RUNS, never `test:all`'s wider glob", () => {
  const narrow = suiteTestFiles("test");
  const wide = suiteTestFiles("test:all");
  assert.deepEqual(suiteScriptsFor("npm test"), ["test"]);
  assert.ok(narrow.length < wide.length,
    "`npm test` runs `test:ts` (the product packages) and `test:all` runs every package, so charging "
    + "them the same population is the inversion this row fixed");
  const org = suiteTestFiles("test:org");
  assert.deepEqual(narrow.filter((f: string) => org.includes(f)), [],
    "not one file `npm test` is charged may be a file only `test:org` runs -- a refusal naming a file "
    + "the command cannot load tells its author to change a command for a reason that is not true");
  // POSITIVE CONTROL for that emptiness: the org half is real and non-empty, so the intersection above
  // is empty because the populations are disjoint rather than because one of them is missing.
  assert.ok(org.length > 0 && narrow.length > 0, "both halves must be non-empty for the disjointness to mean anything");
  assert.deepEqual([...narrow, ...org].sort(), [...wide].sort(),
    "`test:ts` and `test:org` partition `test:all` -- if they do not, one of these three globs has moved "
    + "and the charge is about a population no command runs");
});

test("DIRECTION 2 -- `npm run test:org` and `npm run test:all` are RECOGNISED and charged their own "
  + "population, rather than executed having been charged nothing", () => {
  const caps = { history: false, token: false, fleet: false, corpus: false };
  for (const command of ["npm run test:org", "npm run test:all"]) {
    assert.equal(runsTheWholeSuite(command), true,
      `${command} runs every org test file; reading it as "names no test file" is how it reached the `
      + "runner in a job with no token and no corpus");
    const verdict = classifyCommand(command, { capabilities: caps });
    assert.equal(verdict.verdict, "refused",
      `${command} must be refused, not handed to the runner -- that is the 2026-09-09 failure: a red `
      + "check naming an author for a line they never wrote");
    assert.match(verdict.reason!, /\.test\.ts/, "the refusal must NAME a file, or it is not followable");
  }
  // CONTROL: the capabilities decide it, never the command's shape.
  assert.equal(classifyCommand("npm run test:all",
    { capabilities: { history: true, token: true, fleet: true, corpus: true } }).verdict, "runnable");
});

/**
 * #2207 -- A CHAIN RUNS EVERY SCRIPT IT NAMES, SO IT IS CHARGED EVERY SCRIPT IT NAMES.
 *
 * `suiteScriptsFor` returned the FIRST match from one non-global `exec`, while the pattern's own
 * `(?:^|&&|\|\||;)` alternation exists precisely to recognise a whole-suite call inside a chain. So
 * `npm run test:ts && npm run test:org` -- a command that grammar accepts -- was charged `test:ts`'s
 * population while the shell ran both, and the org half's token requirement was never read: `runnable` in
 * a job with no token, which is the 2026-09-09 failure this whole mechanism exists to prevent, reached
 * from the direction #2153 left open.
 *
 * THE CONTROL IS THE FIRST SCRIPT ON ITS OWN. Under these same capabilities `npm run test:ts` is
 * runnable, so the refusal below is the SECOND script being read rather than a chain being refused for
 * its shape -- an assertion met by refusing every chain would pin nothing.
 */
test("a CHAINED whole-suite command is charged the UNION of every script it names, not the first", () => {
  const caps = { history: true, token: false, fleet: false, corpus: true };
  const chain = "npm run test:ts && npm run test:org";
  assert.deepEqual(suiteScriptsFor(chain), ["test:ts", "test:org"],
    "both halves run, so both must be named -- resolving only the first is how the org half's "
    + "requirements went unread");
  const verdict = classifyCommand(chain, { capabilities: caps });
  assert.equal(verdict.verdict, "refused",
    "the chain runs `test:org` in a job with no token; reading it as runnable hands the runner a command "
    + "that goes red naming an author for a line they never wrote");
  const named = verdict.reason!.match(/[\w.-]+\.test\.ts/)?.[0];
  assert.ok(named, `the refusal must NAME a file, or it is not followable: ${verdict.reason}`);
  const ts = suiteTestFiles("test:ts");
  const org = suiteTestFiles("test:org");
  assert.ok(org.some((f: string) => f.endsWith(named!)) && !ts.some((f: string) => f.endsWith(named!)),
    `${named} must come from the SECOND script's population -- a refusal sourced from \`test:ts\` alone `
    + "would pass this test while the union was still never taken");
  assert.equal(classifyCommand("npm run test:ts", { capabilities: caps }).verdict, "runnable",
    "CONTROL: the first script alone is runnable under these same capabilities, so the refusal above is "
    + "the second script being charged rather than a chain refused for its shape");
  assert.equal(classifyCommand("npm run test:org && npm run test:ts", { capabilities: caps }).verdict,
    "refused", "order must not decide it: the union is the same set either way round");
  assert.deepEqual(suiteScriptsFor("npm test && npm test"), ["test"],
    "one population named twice is required once -- charging it twice would double every walk this gate "
    + "does for no new fact");
});

test("an unrecognised script name THROWS rather than reading as a population of none", () => {
  assert.throws(() => suiteTestFiles("test:no-such-script"), /names no .* glob/,
    "returning `[]` here is exactly the hole this function exists to close: an empty population makes "
    + "the union of requirements empty, so the command passes the capability gate having examined "
    + "nothing -- and `unmetCommandRequirements` returning `[]` is indistinguishable from `this command "
    + "needs nothing`");
});

/**
 * REFUSED IS NOT GREEN FOR A WHOLE-SUITE COMMAND (ceo, 2026-09-09). "An acceptance job that passes
 * having verified nothing is how `verified` comes to mean `unexamined`."
 *
 * Every OTHER refusal stays `ok: true`, and the distinction is not a nicety: those are a legitimate "not
 * this job's to run" — the author NAMED a file, and this job cannot run that particular one. `npm test`
 * names nothing, so refusing it means the PR has declared no acceptance this job can act on at all.
 */
test("a whole-suite acceptance line FAILS the job, and the message names the fix rather than the state", () => {
  const caps = { history: false, token: false, fleet: false, corpus: false };
  const report = acceptanceReport("Acceptance: npm test", () => 0, { capabilities: caps });
  assert.equal(report.ok, false, "passing here is how `verified` comes to mean `unexamined`");
  assert.match(report.lines[0], /Name the files this change is verified by/);
  assert.match(report.lines[0], /no token and no corpus/,
    "the refusal must say WHY this job cannot, or the author reads it as the tool being broken");
});

test("CONTROL: a refusal of a NAMED file stays a pass -- the author did their part and this job cannot "
  + "run that one file. Failing both would make the two indistinguishable, and they need opposite fixes", () => {
  // #790/#878: this USED TO name a real production test file (first `queue-table.test.ts`, then
  // `row-claim-live.test.ts`) as its "a file this job refuses" fixture -- and it broke exactly the way
  // ceo named: a `// no-token:` declaration landing on that real file (for an unrelated PR) made this
  // control pass or fail on whether somebody edited it, which is #777's own fixture-fragility shape one
  // layer over. A SYNTHETIC fixture this test creates and destroys itself cannot break under a future
  // declaration on anybody else's file, ever.
  const caps = { history: false, token: false, fleet: false, corpus: false };
  const dir = mkdtempSync(join(tmpdir(), "acceptance-control-"));
  try {
    const fixture = join(dir, "needs-token.test.ts");
    writeFileSync(fixture, "// requires: token\n");
    const named = acceptanceReport(
      `Acceptance:\nnpx tsx --test ${fixture}\nnode -e "process.exit(0)"\n`, () => 0, { capabilities: caps });
    assert.equal(named.ok, true);
    assert.match(named.lines[0], /REFUSED/);
    assert.doesNotMatch(named.lines[0], /Name the files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- A SECTION THAT EXECUTED NOTHING IS NOT A SECTION THAT PASSED ---
//
// `evidence:check`'s examined-nothing shape, in the acceptance job. MEASURED 2026-09-09: 55 of the 145
// PRs merged that day had an acceptance job that executed no command and concluded success. Almost every
// one was `tsx --test packages/lab/src/packaging/<x>.test.ts` refused for `token` -- the tracker and
// pipeline tooling, which is exactly the code the rest of the org now relies on.
//
// Three of the 55 were found by the PM re-running the declared commands at the merge commit by hand. The
// shape is generic to the closure walk, not to those three, which is why this is a rule rather than
// three fixes.

/**
 * A SYNTHETIC file this job refuses, for the three tests below. #1406: they named the real
 * `row-claim-live.test.ts`, which stopped needing a token when its calls became recorded -- and two of the three
 * went on passing with nothing refused, the fixture fragility the CONTROL above already names (#790/#878).
 */
function refusedFixture(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-refused-"));
  const path = join(dir, "needs-token.test.ts");
  writeFileSync(path, "// requires: token\n");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("EXECUTED NOTHING FAILS: every command refused and none run is the absence of an answer, not a pass", () => {
  const caps = { history: false, token: false, fleet: false, corpus: false };
  const fixture = refusedFixture();
  try {
  const report = acceptanceReport(`Acceptance: npx tsx --test ${fixture.path}`, () => 0, { capabilities: caps });
  assert.equal(report.ok, false);
  assert.ok(report.lines.some((l) => l.startsWith("ACCEPTANCE: EXECUTED NOTHING")),
    "the verdict must be its own line, not a modifier on the refusal -- a reader scanning for a failure "
    + "reads line starts");
  assert.match(report.lines.join("\n"), /no token, no fleet and no corpus/,
    "and it must say what this job cannot do, or the author reads it as the tool being broken");
  } finally {
    fixture.cleanup();
  }
});

test("A REFUSED LINE PASSES ONLY BESIDE A RAN LINE -- refusing one named file while another actually "
  + "runs is a partial answer; refusing every one is no answer at all", () => {
  const caps = { history: false, token: false, fleet: false, corpus: false };
  const fixture = refusedFixture();
  try {
    const mixed = acceptanceReport(
      `Acceptance:\nnpx tsx --test ${fixture.path}\n`
      + 'node -e "process.exit(0)"\n', () => 0, { capabilities: caps });
    assert.ok(mixed.lines.some((l) => /REFUSED/.test(l)), "the positive control: one line really was refused");
    assert.equal(mixed.ok, true, "one command ran, so the section examined something");
    assert.ok(!mixed.lines.some((l) => l.startsWith("ACCEPTANCE: EXECUTED NOTHING")));
  } finally {
    fixture.cleanup();
  }
});

test("CONTROL: a section with commands that all RUN is untouched, and an empty section is not this "
  + "verdict -- MISSING and NONE are their own answers and must not be renamed", () => {
  const caps = { history: false, token: false, fleet: false, corpus: false };
  const ran = acceptanceReport('Acceptance: node -e "process.exit(0)"', () => 0, { capabilities: caps });
  assert.equal(ran.ok, true);
  assert.ok(!ran.lines.some((l) => /EXECUTED NOTHING/.test(l)));

  assert.deepEqual(acceptanceReport("no sections here", () => 0, { capabilities: caps }).lines,
    ["ACCEPTANCE: MISSING"], "MISSING is not EXECUTED NOTHING: one is a body with no declaration, the "
    + "other a declaration this job cannot act on");
});

/**
 * THE BOUNDARY, and it is #516's rather than a convenience. I wrote this test asserting the opposite
 * first -- "the rule is about a section examining nothing, not about the word Acceptance" -- and the
 * suite refused it, correctly.
 *
 * `Refutation:` is OPTIONAL, and this repo's own rule tells authors to declare `npm run mutate` there,
 * which the classifier refuses BY DESIGN: mutate's exit 0 means the guard BITES, while `Refutation:`
 * reads success as a non-zero exit, so running it would invert the verdict. A rule that failed a section
 * for executing nothing would refuse the body the tree itself asks the author to write.
 *
 * An Acceptance section has no such case: every refusal there is a capability this job lacks.
 */
test("THE BOUNDARY: a REFUTATION section that executed nothing does NOT fail -- the tree tells authors "
  + "to declare a command it refuses by design there, and refusing their body for obeying it is worse", () => {
  const caps = { history: false, token: false, fleet: false, corpus: false };
  const fixture = refusedFixture();
  try {
    const report = acceptanceReport(
      'Acceptance:\nnode -e "process.exit(0)"\n'
      + `Refutation:\nnpx tsx --test ${fixture.path}\n`, () => 0,
      { capabilities: caps });
    assert.ok(report.lines.some((l) => /REFUSED/.test(l)), "the positive control: the Refutation line really was refused");
    assert.equal(report.ok, true);
    assert.ok(!report.lines.some((l) => /EXECUTED NOTHING/.test(l)));
  } finally {
    fixture.cleanup();
  }
});

/**
 * #967: A MODULE'S TOP LEVEL IS WHAT AN IMPORT EXECUTES, and the closure walk could not tell that from a
 * function body.
 *
 * `dataset-paths.mjs` was charged `corpus` by ANY test that imported it — including one importing
 * `REPO_ROOT` and nothing else. **Three pull requests moved code into new corpus-free modules purely so
 * their acceptance test could run in CI** (#943, #955, #966), which is an import rule shaping the code.
 *
 * MEASURED BEFORE THE FIX, and the first measurement is why the row's own proposed fix was not enough:
 *
 *     constant-only import                       -> corpus @ dataset-paths.mjs:93   (the DEFINITION line)
 *     …after excluding definitions from the regex -> corpus @ dataset-paths.mjs:116  (a real call, in a body)
 *
 * The file calls `runsRoot()` five times — 116, 178, 188, 203, 246 — and every one is inside a function
 * body. Its top level is two constants. So the property needed is structural, not textual, and a pattern
 * cannot express it.
 *
 * THE ENTRY IS SCANNED WHOLE; AN IMPORTED MODULE ONLY AT ITS TOP LEVEL. Those are different questions: the
 * entry is the command about to run, and its `runsRoot()` call inside a `test(...)` callback IS executed by
 * the runner. An import executes only the top level.
 */
const tempFixture = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "a11y-967-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
};

/**
 * THE FIXTURE CANNOT NAME ITSELF, and the guards in this very file caught it doing so.
 *
 * A fixture module for these tests has to CONTAIN the identifier the scanner looks for. Written as a plain
 * literal, it lands in `acceptance-commands.test.ts`'s own text — and #621's self-reference tests classify
 * commands that name this file, so every one of them started deriving `corpus` from a string in a fixture
 * and refusing the command. Measured: five previously-passing tests went red, `actual: null` against a
 * command they expect to run.
 *
 * Concatenated, exactly as `fingerprint()` does for the token identifiers in `acceptance-commands.mjs`
 * itself. The identifier exists at runtime and never in this file's source.
 */
const CORPUS_FN = `runsR${"oot"}`;
/**
 * The same trick a second time, and it was needed a second time: `corpus-readers-are-guarded.test.ts`
 * scans every file for `datasetRoot(` among its CORPUS_ACCESSOR names, so a fixture spelling that one out
 * made THIS file a corpus-reading candidate the moment it was written.
 */
const DERIVED_FN = `dataset${"Root"}`;

test("#967: importing a module for a CONSTANT is not charged, though the module defines a corpus reader", () => {
  const dir = tempFixture({
    "paths.mjs": 'export const REPO_ROOT = "/somewhere";\n'
      + `export function ${CORPUS_FN}() { return REPO_ROOT; }\n`
      + `export function ${DERIVED_FN}() { return ${CORPUS_FN}() + "/subdir"; }\n`,
    "entry.test.ts": 'import { REPO_ROOT } from "./paths.mjs";\nconst x = REPO_ROOT;\nvoid x;\n',
  });
  try {
    assert.deepEqual(deriveClosureRequirements(join(dir, "entry.test.ts")), [],
      "the module's top level is one constant; its corpus calls are inside function bodies and an import "
      + "runs none of them");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#967 THE DEFINITION LINE: a signature is top-level text, so blanking bodies alone was not enough", () => {
  // `export function <fn>() {` sits at the module top level and matches a call-shaped pattern exactly as a
  // real call does. Measured: with bodies blanked but signatures kept, a constant-only import was still
  // charged at `dataset-paths.mjs:93`, the definition. Nothing in a function declaration executes at import
  // beyond binding a name, so a declaration the importer did not ask for is blanked WHOLE.
  //
  // The body here is EMPTY, so the signature is the only occurrence left to match — if this passes with a
  // body-only rule it would be proving nothing.
  const dir = tempFixture({
    "defines.mjs": `export const SIZE = 1;\nexport function ${CORPUS_FN}() {}\n`,
    "entry.test.ts": 'import { SIZE } from "./defines.mjs";\nvoid SIZE;\n',
  });
  try {
    assert.deepEqual(deriveClosureRequirements(join(dir, "entry.test.ts")), [],
      "the only occurrence is the declaration's own signature, and the importer never named it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#967: importing the READER ITSELF is charged -- calling it is what needs the corpus", () => {
  // The other side of the same rule, and the one that keeps it honest: an import that names the function
  // is asking to call it, so its body counts. `corpus-settled.mjs` is the real instance — it imports
  // `datasetRoot` from `dataset-paths.mjs` and calls it, while its own text names the reader only in a
  // comment. A rule of "the module's top level, full stop" reported it as needing nothing, and this file's
  // own #731 boundary test caught that.
  const dir = tempFixture({
    "defines.mjs": `export function ${CORPUS_FN}() { return 1; }\n`,
    "entry.test.ts": `import { ${CORPUS_FN} } from "./defines.mjs";\nvoid ${CORPUS_FN};\n`,
  });
  try {
    const hits = deriveClosureRequirements(join(dir, "entry.test.ts"));
    assert.equal(hits.length, 1, `expected the imported reader to be charged: ${JSON.stringify(hits)}`);
    assert.equal(hits[0].requirement, "corpus");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#967 BOTH DIRECTIONS: a module whose TOP LEVEL calls it is still charged", () => {
  const dir = tempFixture({
    "eager.mjs": `export function ${CORPUS_FN}() { return 1; }\nexport const ROOT = ${CORPUS_FN}();\n`,
    "entry.test.ts": 'import { ROOT } from "./eager.mjs";\nvoid ROOT;\n',
  });
  try {
    const hits = deriveClosureRequirements(join(dir, "entry.test.ts"));
    assert.equal(hits.length, 1, `expected the top-level call to be charged: ${JSON.stringify(hits)}`);
    assert.equal(hits[0].requirement, "corpus");
    assert.ok(hits[0].file.endsWith("eager.mjs"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#967 BOTH DIRECTIONS: a test that reads the corpus in its OWN text is still refused", () => {
  // The real files, not a fixture: these two are charged at their own line, never via an import, so the
  // change cannot have quietly exempted them. This is the row's second acceptance bullet.
  for (const file of ["packages/lab/src/dataset-paths.test.ts",
    "packages/lab/src/packaging/lab-fetch-paths.test.ts"]) {
    // Repo-relative, exactly as BOARD_STYLE_FIXTURE above is: the walk resolves against the cwd the
    // suite runs in, which is the repository root.
    const hits = deriveClosureRequirements(file);
    const corpus = hits.find((hit) => hit.requirement === "corpus");
    assert.ok(corpus, `${file} is no longer charged for the corpus, and it genuinely reads it`);
    assert.ok(corpus!.file.endsWith(file.split("/").pop()!),
      "and it must be charged at its OWN text, not through an import");
  }
});

test("#967: a template literal full of braces does not confuse the scan -- why this parses rather than matches", () => {
  // The failure a hand-rolled brace matcher fails WITH, and the reason `ts.createSourceFile` earns its
  // import: unbalanced braces inside a template literal and a regex literal. A matcher that miscounts here
  // blanks the wrong span, and it fails in the direction that looks like success -- the file reads clean.
  const dir = tempFixture({
    "tricky.mjs": "export const SHAPE = `a { b ${1} c`;\nexport const RE = /[{]/;\n"
      + `export function ${CORPUS_FN}() { return 1; }\n`,
    "entry.test.ts": 'import { SHAPE } from "./tricky.mjs";\nvoid SHAPE;\n',
  });
  try {
    assert.deepEqual(deriveClosureRequirements(join(dir, "entry.test.ts")), [],
      "the braces inside the template literal and the regex are not code structure, and the parser knows it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- #1035: `History: full` IS A DECLARATION, NOT A COMMAND, WHEREVER IT SITS ---
//
// Found 2026-09-12 while opening #1034. The line is documented as position-independent -- "a bare line,
// deliberately … needs no section parser" -- and `hasFullHistoryDeclaration` reads it from the WHOLE body.
// But `commandLinesAfter` took it as a command AND, being followed by a blank line, terminated on the next
// one, so the fenced block below it was never reached:
//
//     INSIDE  the section:  commands = ["History: full"]     <- the prose line, and nothing else
//     OUTSIDE the section:  commands = ["npx tsx --test …"]
//
// The tool then printed "every command above was refused" (true, of a command nobody wrote as one) and
// "`History: full` is declared, but no named test file declares `// requires: history`" (the named file
// declares it on line 13). One placement, two messages, neither naming it -- and it cost three checks of
// things that were already right before I read the parser instead of the message.

const HISTORY_CMD = "npx tsx --test packages/lab/src/packaging/acceptance-commands.test.ts";

test("#1035 ACCEPTANCE: a bare `History: full` INSIDE the section leaves the real command intact", () => {
  const body = `## Acceptance\n\nHistory: full\n\n\`\`\`bash\n${HISTORY_CMD}\n\`\`\`\n`;
  const section = extractAcceptanceSection(body);
  assert.equal(section.kind, "commands");
  assert.deepEqual((section as { commands: string[] }).commands, [HISTORY_CMD],
    "the fenced command must survive -- it used to be dropped entirely, because the prose line both "
    + "became the command and terminated the scan on the blank line after it");
});

test("#1035: and the declaration is still HONOURED there -- skipped, not refused, because it is "
  + "position-independent by design", () => {
  const body = `## Acceptance\n\nHistory: full\n\n\`\`\`bash\n${HISTORY_CMD}\n\`\`\`\n`;
  assert.equal(hasFullHistoryDeclaration(body), true);
  assert.equal(jobCapabilities(body).history, true,
    "honouring it wherever it lands is the behaviour the author already expects; refusing the placement "
    + "would be a second rule to remember for a line that needs none");
});

test("#1035: OUTSIDE the section is unchanged -- the documented placement must keep working exactly", () => {
  const body = `History: full\n\n## Acceptance\n\n\`\`\`bash\n${HISTORY_CMD}\n\`\`\`\n`;
  assert.deepEqual((extractAcceptanceSection(body) as { commands: string[] }).commands, [HISTORY_CMD]);
  assert.equal(hasFullHistoryDeclaration(body), true);
});

test("#1035: a line that merely MENTIONS history is still a command -- the skip is anchored to the exact "
  + "declaration, not to the word", () => {
  // The declaration's own pattern is anchored (`^\s*History:\s*full\s*$`), and this asserts the skip
  // inherits that rather than widening it. A skip that swallowed any line containing "History" would
  // silently drop a real command, which is the same defect pointed the other way.
  const body = "## Acceptance\n\nnode scripts/x.mjs --History: full-run\n";
  assert.deepEqual((extractAcceptanceSection(body) as { commands: string[] }).commands,
    ["node scripts/x.mjs --History: full-run"]);
});

test("#1035: `History: full` as the ONLY thing in the section is MISSING, not a command", () => {
  // The honest verdict: an author who wrote a declaration and no command has named no acceptance, and
  // `missing` is the refusal that says so. Reading it as a command said "every command was refused",
  // which sends them to look at a command they never wrote.
  assert.equal(extractAcceptanceSection("## Acceptance\n\nHistory: full\n").kind, "missing");
});

test("#1036: a BOLDED declaration is honoured and does not eat the command -- `commandLinesAfter`'s own "
  + "stop rule six lines below already tolerates the wrapper", () => {
  // worker-capture's finding on #1035's own fix. `HISTORY_FULL_PATTERN` was strict where
  // `SECTION_FIELD_NAMES`'s rule three lines away is not (`^(?:\*\*|__)?${name}:(?:\*\*|__)?`), so
  // `**History: full**` -- a spelling these bodies reach for constantly -- was recognised NOWHERE: the
  // checkout stayed shallow AND the line became a command that terminated the scan, reproducing the exact
  // pair of misleading messages in the commit that fixed them.
  for (const decl of ["**History: full**", "__History: full__"]) {
    const body = `## Acceptance\n\n${decl}\n\n\`\`\`bash\n${HISTORY_CMD}\n\`\`\`\n`;
    assert.equal(hasFullHistoryDeclaration(body), true, `${decl} must be honoured`);
    assert.deepEqual((extractAcceptanceSection(body) as { commands: string[] }).commands, [HISTORY_CMD],
      `${decl} must not become the command`);
  }
});

test("#1036: a NEAR-MISS is skipped but NOT honoured -- one refusal, and it names the real problem", () => {
  // `History: full.` is not the declaration, so the checkout stays shallow and the command is refused for
  // needing `history` -- which is followable. What it must not also do is become a command and terminate
  // the scan, because then the only refusal is about a line the author wrote as a declaration, and the
  // real command never enters the list at all.
  for (const decl of ["History: full.", "History: shallow", "**History: full** — and why"]) {
    const body = `## Acceptance\n\n${decl}\n\n\`\`\`bash\n${HISTORY_CMD}\n\`\`\`\n`;
    assert.equal(hasFullHistoryDeclaration(body), false, `${decl} is not the declaration`);
    assert.deepEqual((extractAcceptanceSection(body) as { commands: string[] }).commands, [HISTORY_CMD],
      `${decl} must not become the command either`);
  }
});

test("#1036: the tolerance is for the WRAPPER, never for surrounding text -- a real command mentioning "
  + "History is still a command", () => {
  // The mutation guard for the widening. An unanchored or word-based skip would swallow this line, which
  // is the same defect pointed the other way: a check that silently drops a real command.
  const body = "## Acceptance\n\nnode scripts/x.mjs --History: full-run\n";
  assert.deepEqual((extractAcceptanceSection(body) as { commands: string[] }).commands,
    ["node scripts/x.mjs --History: full-run"]);
  assert.equal(hasFullHistoryDeclaration(body), false);
});

// ---------------------------------------------------------------------------------------------------
// #1116: THE REFUSAL NAMED THE FAULT AND NEVER THE REMEDY.
//
// `// no-token:` appeared in this file's messages exactly once — in the branch that fires when you get it
// WRONG. So an author learned the mechanism existed only by misusing it. Measured on #1009: the author
// spent the fix moving assertions between files, and the declaration that would have answered it was four
// hundred lines from the message that refused them.
//
// A GUARD MESSAGE MUST BE FOLLOWABLE. This one said what was wrong without saying what to do.
// ---------------------------------------------------------------------------------------------------

test("#1116: a closure refusal names `// no-token:` when that declaration would actually hold", () => {
  const hits = deriveClosureRequirements("packages/lab/src/packaging/merge-guard.test.ts");
  const token = hits.find((h: { requirement: string }) => h.requirement === "token");
  assert.ok(token, "merge-guard.test.ts reaches `gh` through mergeReadiness -- if this is empty the "
    + "fixture has changed and the rest of this test proves nothing");
  const message = closureRequirementMessage(token);

  assert.match(message, /via mergeReadiness → gh →/, "the chain is still named -- the fault half is kept");
  assert.match(message, /no-token: gh/,
    "and the REMEDY is named, with the function to declare. Without this an author learns the mechanism "
    + "exists only by getting it wrong, which is the one path that reports it");
  assert.match(message, /every input it passes is injected/,
    "and the CONDITION under which it applies, because the declaration is a claim about the test and not "
    + "a way past the check");
});

test("#1116: the remedy is NOT offered on a declaration already judged wrong", () => {
  // worker-judge's pin. `hit.wrongDeclaration` short-circuits, which is right -- telling somebody to add
  // a declaration they have just been told is wrong is #1059 twice over -- but NOTHING HELD IT, so a
  // future edit could start doing exactly that. Driven over the shape rather than a real file, because
  // no tracked file carries a wrong declaration and one planted here would be a fixture of the defect.
  const wrong = { requirement: "token" as const, file: "x.mjs", line: 1, wrongDeclaration: true,
    chain: ["packages/lab/src/packaging/merge-guard.test.ts", "packages/agent-org/src/merge-guard.mjs"] };
  const message = closureRequirementMessage(wrong);
  assert.match(message, /DOES call/, "the wrong-declaration refusal itself is unchanged");
  assert.doesNotMatch(message, /may declare/,
    "and it must NOT then suggest declaring the same thing -- advice that contradicts the sentence it is "
    + "attached to is worse than none");
});

test("#1116: the remedy names the DISCRIMINATING condition, not only the mechanical one", () => {
  // worker-judge's should-fix, and #1009 is the counter-example with an author attached: every input was
  // injected and `gh` never executed, so "if every input it passes is injected" was SATISFIED and the
  // declaration would still have been wrong. The mechanical precondition does not discriminate the case
  // it needs to discriminate.
  const token = deriveClosureRequirements("packages/lab/src/packaging/merge-guard.test.ts")
    .find((h: { requirement: string }) => h.requirement === "token");
  assert.ok(token, "the fixture must still reach `gh`, or this proves nothing");
  const message = closureRequirementMessage(token);
  assert.match(message, /not part of what this file tests/,
    "the question a checker cannot answer must be asked of the author");
  assert.match(message, /unit test wearing a consumer test's name/,
    "and the exception must be NAMED -- a remedy offered without it is how a verified-true flag gets "
    + "taken by an author under a red CI");
});

test("#1116: the remedy is offered only when it would HOLD — advice a reader cannot follow is worse than none", () => {
  // #1059's shape: `doctor`'s `next:` line once sent a reader to a script that had just refused them.
  // The suggestion is checked against the entry's own comment-stripped code before it is made, so a file
  // that really does call the function is never told to declare that it does not.
  const already = deriveClosureRequirements("packages/lab/src/packaging/update-branch-sweep.test.ts");
  assert.deepEqual(already, [],
    "this file already declares `// no-token: gh`, so it has no token requirement to be advised about -- "
    + "the control that the advice is not simply appended to everything");
});

// --- #728: what this cannot parse, it must not make claims about ---------------------------------
//
// Measured on #727. The acceptance command was
// `node packages/guards/src/tree-wide-guards.mjs | xargs npx tsx --test`, and the runner reported
// `fail (matched no file: node, |, xargs)` -- a claim about the filesystem, and a false one. `|` is not
// a filename at all, and a reader following that message goes looking for missing test files.
//
// #419 closed the BACKTICK form and the pipe form was never considered; #727 is the first acceptance
// command in the repository to contain a pipe. The REFUSAL is correct -- a guard that cannot verify a
// line must not pass it. What was wrong is what it said.

test("#728: a piped line is REFUSED as unparseable, never reported as missing files", () => {
  const result = testFileArgumentsResolve("node packages/guards/src/tree-wide-guards.mjs | xargs npx tsx --test");
  assert.deepEqual(result, { ok: false, unparseable: "a pipe" },
    "the pipe form must name the construct rather than assert about the filesystem: `node`, `|` and "
    + "`xargs` are not files the author asked for, and one of them is not a filename at all");
});

test("#728: the constructs are NAMED, because a message has to be followable", () => {
  // "it contains a pipe" sends the reader to the right character; "cannot parse" sends them to re-read
  // the whole line. Each construct relocates the arguments in a different way and each says which.
  const named = (command: string) => {
    const r = testFileArgumentsResolve(command);
    return "unparseable" in r ? r.unparseable : null;
  };
  assert.equal(named("a | xargs npx tsx --test"), "a pipe");
  assert.equal(named("a && npx tsx --test x.test.ts"), "an `&&`");
  assert.equal(named("a || npx tsx --test x.test.ts"), "a `||`");
  assert.equal(named("npx tsx --test $(ls) "), "a subshell");
  assert.equal(named("npx tsx --test x.test.ts > out.txt"), "a redirection");
  assert.equal(named("a ; npx tsx --test x.test.ts"), "a `;`");
});

test("#728 THE CONTROL: the guard #419 built still discriminates -- this must not pass by refusing less", () => {
  // A fix that stopped reporting shell words by reporting NOTHING would satisfy the row's first line
  // and kill the check. These two are the row's own positive control, and they are why its open-check
  // reads as a measurement rather than a guess.
  const missing = testFileArgumentsResolve("npx tsx --test packages/lab/src/definitely-not-here.test.ts");
  assert.deepEqual(missing, { ok: false, missing: ["packages/lab/src/definitely-not-here.test.ts"] },
    "a genuinely missing file must still be named");
  assert.deepEqual(testFileArgumentsResolve("npx tsx --test packages/agent-org/src/acceptance-commands.mjs"), { ok: true },
    "and a real file must still pass");
});

test("#728: an ordinary command with no relocating construct is untouched", () => {
  // The list is the constructs that RELOCATE the arguments, not everything unfamiliar. A guard that
  // refused what it did not recognise would refuse every ordinary command the moment a flag was added.
  assert.deepEqual(testFileArgumentsResolve("npx tsx --test --test-concurrency=4 packages/agent-org/src/acceptance-commands.mjs"),
    { ok: true });
  assert.deepEqual(testFileArgumentsResolve("npm run lint"), { ok: true },
    "and a line with no `tsx --test` is never inspected at all");
});

// --- #1140: a declaration naming a COMMAND is judged by whether the entry spawns it by string ---

/** An entry declaring `// no-token: <name>` whose own code is `lines`, derived in a scratch directory. */
function deriveDeclaredEntry(name: string, lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-token-"));
  try {
    const entry = join(dir, "consumer.test.mjs");
    writeFileSync(entry, [`// no-token: ${name}`, "import { execFileSync, execSync, execFile, spawnSync, spawn } from \"node:child_process\";", ...lines].join("\n"));
    return deriveClosureRequirements(entry);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#1140: `// no-token: gh` on an entry that SPAWNS gh by string is WRONG, in every spawn spelling this repo "
  + "charges and every quote -- `execFileSync(\"gh\", ...)` contains no `gh(`, which is how it held", () => {
  const gh = spell("g", "h");
  const spellings = ["execFileSync", "execSync", "execFile", "spawnSync", "spawn", "run", "npmCliInvocation"];
  const quotes = ["\"", "'", "`"];
  let examined = 0;
  for (const verb of spellings) {
    for (const quote of quotes) {
      const hits = deriveDeclaredEntry(gh, [`${verb}(${quote}${gh}${quote}, ["issue", "list"]);`]);
      assert.equal(hits.length, 1, `${verb}(${quote}${gh}${quote}, ...) must refuse; got ${JSON.stringify(hits)}`);
      assert.equal(hits[0].requirement, "token");
      assert.equal(hits[0].wrongDeclaration, true, `${verb} spawning the declared command is a wrong declaration`);
      assert.match(closureRequirementMessage(hits[0]), /declares `\/\/ no-token:` a function its own code DOES call or spawn/);
      examined++;
    }
  }
  assert.equal(examined, spellings.length * quotes.length, "every spelling and quote was driven");
});

test("#1140 CONTROL: `// no-token: gh` still HOLDS where gh is only MENTIONED -- prose in a string, an identifier "
  + "containing it, and an argument to a spawn of a DIFFERENT command -- a mention is not a use", () => {
  const gh = spell("g", "h");
  const mentions: [string, string][] = [
    ["prose", `const note = "run ${gh} issue list by hand";`],
    ["identifier", `const ${gh}ost = 1; console.log(${gh}ost);`],
    // The other command is spelled too: a literal git spawn here reads, to the tree's spawn-classification guards,
    // as this test file spawning git.
    ["a later argument", `execFileSync("${spell("gi", "t")}", ["log", "--grep", "${gh}"]);`],
    ["a bare string", `console.log("${gh}");`],
  ];
  for (const [shape, line] of mentions) {
    assert.deepEqual(deriveDeclaredEntry(gh, [line]), [], `${shape}: \`${line}\` mentions ${gh} and never spawns it`);
  }
});

// --- #1449: the token CHARGE recognises `execFile`, and the spawns it reads are one list ---

test("#1449 ACCEPTANCE: an undeclared entry that spawns gh through `execFile` is charged token", () => {
  const gh = spell("g", "h");
  const dir = mkdtempSync(join(tmpdir(), "acceptance-token-"));
  try {
    const entry = join(dir, "consumer.test.mjs");
    writeFileSync(entry, ["import { execFile } from \"node:child_process\";", `execFile("${gh}", ["issue", "list"], () => {});`].join("\n"));
    const hits = deriveClosureRequirements(entry);
    assert.deepEqual(hits.map((h) => h.requirement), ["token"], `execFile("${gh}", ...) must be charged; got ${JSON.stringify(hits)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#1449 CONTROL: `execFile` of a DIFFERENT command is not charged", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-token-"));
  try {
    const entry = join(dir, "consumer.test.mjs");
    writeFileSync(entry, ["import { execFile } from \"node:child_process\";", `execFile("${spell("gi", "t")}", ["status"], () => {});`].join("\n"));
    assert.deepEqual(deriveClosureRequirements(entry), [], "only a gh spawn is a token requirement");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- #1458: the spawn is located by SHAPE, so an edit above it moves the expectation with it ---

/** How many lines the moved control inserts above `publishToDraftRelease`. */
const PADDING_LINES = 7;

/** A temporary tree holding `board-document-chrome-resolver.test.ts` and a given `board-document.mjs`. */
function withBoardDocumentTree<T>(boardDocument: string, body: (entry: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-1458-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    // board-document.mjs lives in @a11ign/agent-org now, so the sandbox needs that directory too --
    // BOARD_DOCUMENT below is written into it.
    mkdirSync(join(dir, "packages/agent-org/src"), { recursive: true });
    mkdirSync(join(dir, "packages/lab/src/packaging"), { recursive: true });
    writeFileSync(join(dir, BOARD_DOCUMENT), boardDocument);
    const entry = join(dir, BOARD_STYLE_FIXTURE);
    writeFileSync(entry, readFileSync(BOARD_STYLE_FIXTURE, "utf8"));
    return body(entry);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#1458 CONTROL: lines inserted above publishToDraftRelease move the shape lookup, the derived hit and the "
  + "message together", () => {
  const real = readFileSync(BOARD_DOCUMENT, "utf8");
  const moved = real.replace(/^function publishToDraftRelease\(/m, "// #1458 padding\n".repeat(PADDING_LINES) + "function publishToDraftRelease(");
  assert.notEqual(moved, real, "the insertion must land");
  const realLine = spawnLineOf(real);
  assert.ok(realLine !== null, "the real file must have the shape before a moved copy can");
  const expected = spawnLineOf(moved);
  assert.equal(expected, realLine + PADDING_LINES, "the shape lookup moves by exactly the inserted lines");
  withBoardDocumentTree(moved, (entry) => {
    const hits = deriveClosureRequirements(entry);
    assert.equal(hits.length, 1);
    const [hit] = hits;
    assert.ok(hit);
    assert.equal(hit.line, expected, "and the deriver's hit moves with it");
    assert.equal(closureRequirementMessage(hit),
      `board-document-chrome-resolver.test.ts requires token via resolveChromeBinary → board-document.mjs:${expected}`);
  });
});

test("#1458 CONTROL: the shape lookup finds nothing when the function's spawns are gone, or when an earlier spawn "
  + "precedes the function -- a location that cannot be followed refuses rather than guesses", () => {
  const real = readFileSync(BOARD_DOCUMENT, "utf8");
  const gh = spell("g", "h");
  const spawnsGone = real.replace(new RegExp(SPAWNS_GH.source, "g"), `execFileSync("${spell("tr", "ue")}"`)
    + `\nfunction laterSpawn() { return execFileSync("${gh}", []); }\n`;
  assert.notEqual(spawnsGone, real, "the replacement must land");
  assert.equal(spawnLineOf(spawnsGone), null,
    "no gh spawn inside publishToDraftRelease; a spawn in a LATER function is not this one");
  const earlier = real.replace(/^function publishToDraftRelease\(/m,
    `const earlier = () => execFileSync("${gh}", []);\nfunction publishToDraftRelease(`);
  assert.notEqual(earlier, real, "the insertion must land");
  assert.equal(spawnLineOf(earlier), null,
    "the deriver would report the earlier spawn, which is not publishToDraftRelease's");
});

// --- #1465: a `// no-token:` line is read, or refused -- never silently ignored ---

/** An entry in a scratch directory whose first lines are `headers`, importing the mixed module's SAFE export. */
function deriveWithHeaders(headers: string[], extraCode: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-1465-"));
  try {
    writeSyntheticMixedModule(dir, "checkRelease");
    const entry = join(dir, "consumer.test.mjs");
    writeFileSync(entry, [...headers, "import { safeRender } from \"./mixed-module.mjs\";", "safeRender(1);", ...extraCode].join("\n"));
    const hits = deriveClosureRequirements(entry);
    return { hits, messages: hits.map(closureRequirementMessage) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#1465 ACCEPTANCE: a declaration with its reason after ` -- ` on the same line is READ, and exempts", () => {
  const { hits, messages } = deriveWithHeaders(["// no-token: checkRelease -- every input here is injected"]);
  assert.deepEqual(hits, [], `a reason beside the name is the habit ceo wants; got ${messages.join("; ")}`);
});

test("#1465 CONTROL: the bare header still exempts, and an entry with NO header is still charged", () => {
  assert.deepEqual(deriveWithHeaders(["// no-token: checkRelease"]).hits, []);
  assert.deepEqual(deriveWithHeaders([]).hits.map((h) => h.requirement), ["token"],
    "without a declaration the mixed module's spawn charges the entry -- so the two exemptions above are earned");
});

test("#1465: a `// no-token:` line the declaration grammar cannot read is REFUSED, naming the file and line", () => {
  for (const malformed of [
    "// no-token: checkRelease because the inputs are injected",
    "// no-token:",
    "// No-Token: checkRelease",
    "  // no-token: checkRelease",
  ]) {
    const { hits, messages } = deriveWithHeaders(["// an ordinary first line", malformed]);
    assert.equal(hits.length, 1, `${JSON.stringify(malformed)} must be refused, not ignored; got ${JSON.stringify(hits)}`);
    assert.equal(hits[0].requirement, "token");
    assert.equal(hits[0].line, 2, "the refusal names the line the unreadable declaration is on");
    assert.match(messages[0], /consumer\.test\.mjs:2 .*not a `\/\/ no-token:` declaration/,
      `the message names the file and line and says why; got ${messages[0]}`);
  }
  const belowReadable = deriveWithHeaders(["// no-token: gitLike", "// no-token: checkRelease because the inputs are injected"]);
  assert.equal(belowReadable.hits.length, 1, `refused even below a declaration that holds; got ${JSON.stringify(belowReadable.hits)}`);
  assert.equal(belowReadable.hits[0].line, 2, "the refusal names the unreadable line, not the first header's");
});

test("#1465: EVERY header line is verified -- a wrong SECOND declaration is named at its own line", () => {
  const cmd = spell("chec", "kRelease");
  const { hits } = deriveWithHeaders(["// no-token: safeRender2", "// no-token: checkRelease"],
    ["import { checkRelease } from \"./mixed-module.mjs\";", `${cmd}();`]);
  assert.equal(hits.length, 1, `the second declaration names a function the entry calls; got ${JSON.stringify(hits)}`);
  assert.equal(hits[0].wrongDeclaration, true);
  assert.equal(hits[0].line, 2, "flagged at the second header's own line, not the first's");
  assert.deepEqual(deriveWithHeaders(["// no-token: safeRender2", "// no-token: gitLike"]).hits, [],
    "CONTROL: two declarations that both hold exempt, as enumeration-completeness and queue-table rely on");
});

test("#1465: the one real header with a reason, row-claim-stale-rule.test.ts:1, derives no requirement and is not refused", () => {
  const f = "packages/lab/src/packaging/row-claim-stale-rule.test.ts";
  assert.match(readFileSync(f, "utf8").split("\n")[0], /^\/\/ no-token: gh -- /, "the fixture's premise: its header carries a reason");
  assert.deepEqual(deriveClosureRequirements(f), []);
});

// --- #1636: the closure charge follows what the importer's code REACHES, not every name a module imports ---

/**
 * #1634's shape, SYNTHETIC. `calibrate.mjs` exports a pure function and imports a corpus reader that only its
 * entry-guarded `main()` uses -- as `packages/lab/scripts/calibrate-abstention.mjs` imports `realCorpusRoot` for
 * its own `main()` while `claim-excludes-recompute.test.ts` imports only `floorRows`. `extra` adds exports.
 */
const reader = () => `export function readCorpus() { return ${CORPUS_FN}(); }\n`;
const calibrate = (extra = "") => 'import { readCorpus } from "./reader.mjs";\n'
  + "export function pure(rows) { return rows.length; }\n" + extra
  + "function main() { return readCorpus(); }\n"
  + "if (import.meta.url === `file://${process.argv[1]}`) main();\n";
const corpusHits = (entry: string) => deriveClosureRequirements(entry).filter((hit) => hit.requirement === "corpus");

test("#1636 ACCEPTANCE: a test importing only a pure function is NOT charged, though its module imports a corpus "
  + "reader that only an entry-guarded main() uses", () => {
  const dir = tempFixture({
    "reader.mjs": reader(),
    "calibrate.mjs": calibrate(),
    "entry.test.ts": 'import { pure } from "./calibrate.mjs";\nvoid pure([]);\n',
  });
  try {
    assert.deepEqual(deriveClosureRequirements(join(dir, "entry.test.ts")), [],
      "nothing the test runs reaches readCorpus: the import binds it, and only main() -- which an import never runs -- calls it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#1636 CONTROL: importing a function whose body calls the reader IS charged, through one more import", () => {
  const dir = tempFixture({
    "reader.mjs": reader(),
    "calibrate.mjs": calibrate("export function usesReader() { return readCorpus(); }\n"),
    "entry.test.ts": 'import { usesReader } from "./calibrate.mjs";\nvoid usesReader;\n',
  });
  try {
    const hits = corpusHits(join(dir, "entry.test.ts"));
    assert.equal(hits.length, 1, `expected the reached reader to be charged: ${JSON.stringify(hits)}`);
    assert.ok(hits[0].file.endsWith("reader.mjs"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#1636 CONTROL: a local helper that a reached body calls is followed too -- reachability never under-charges "
  + "a read two calls down", () => {
  const dir = tempFixture({
    "reader.mjs": reader(),
    "calibrate.mjs": calibrate("function helper() { return readCorpus(); }\nexport function viaHelper() { return helper(); }\n"),
    "entry.test.ts": 'import { viaHelper } from "./calibrate.mjs";\nvoid viaHelper;\n',
  });
  try {
    assert.equal(corpusHits(join(dir, "entry.test.ts")).length, 1, "viaHelper -> helper -> readCorpus reads the corpus");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#1636 CONTROL: a module whose TOP LEVEL reaches the reader -- through a local function -- is charged on any "
  + "import, because an import runs the top level", () => {
  const dir = tempFixture({
    "reader.mjs": reader(),
    "calibrate.mjs": 'import { readCorpus } from "./reader.mjs";\nexport function pure(rows) { return rows; }\n'
      + "function warm() { return readCorpus(); }\nexport const WARM = warm();\n",
    "entry.test.ts": 'import { pure } from "./calibrate.mjs";\nvoid pure;\n',
  });
  try {
    assert.equal(corpusHits(join(dir, "entry.test.ts")).length, 1, "WARM = warm() runs at import and reaches readCorpus");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#1636: a module reached by two imports keeps the UNION of what each reaches -- the order they are met in "
  + "cannot hide a read", () => {
  for (const order of [["a", "b"], ["b", "a"]]) {
    const imports = { a: 'import { pure } from "./a.mjs";\n', b: 'import { usesReader } from "./b.mjs";\n' };
    const dir = tempFixture({
      "reader.mjs": reader(),
      "a.mjs": calibrate(),
      "b.mjs": 'import { readCorpus } from "./reader.mjs";\nexport function usesReader() { return readCorpus(); }\n',
      "entry.test.ts": order.map((key) => imports[key as "a" | "b"]).join("") + "void pure;\nvoid usesReader;\n",
    });
    try {
      assert.equal(corpusHits(join(dir, "entry.test.ts")).length, 1, `imports met in order ${order.join(", ")}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// --- #2099: `token` IS THE FOURTH CAPABILITY AND A ROW CAN NOW DECLARE IT ---
//
// `jobCapabilities()` names four capabilities the acceptance job can lack. A row could declare three:
// `history` in the body, `fleet` by the template's required dropdown, `corpus` by the template's prose
// rule. `token` had nothing, so a `gh` Acceptance was either RUN WITHOUT A CREDENTIAL (the bare spelling,
// classified `runnable`, dying on `set the GH_TOKEN environment variable`) or NEVER RUN AT ALL (the `$ `
// spelling, classified prose), and nothing said so until `pr-open` -- after a builder had claimed the row
// and built the change.
//
// The tests below pin BOTH DIRECTIONS of each half: the declared spelling and the undeclared one.

// #2084's real Acceptance command, the live correct-row case this row's ruling turned on: a deliberate
// hand-run `gh` read of branch protection, named per the template's own rule for a command a runner
// cannot make. Copied from the row's body at 2026-09-23, with the `$ ` prompt removed -- as filed it
// carries the prompt, which classifies prose and is NOT what this row changes (see the `$ ` test below).
const HAND_RUN_GH = "gh api repos/a11ign/a11ign/branches/main/protection --jq "
  + "'if .required_pull_request_reviews.dismiss_stale_reviews == true then \"ok\" else error(\"no\") end'";

const HAND_RUN_REASON = "whoever holds the admin credential; the acceptance job has none";

function acceptanceBody(command: string, declaration?: string): string {
  return `## Acceptance\n\n${declaration ? `Hand-run: ${declaration}\n\n` : ""}\`\`\`\n${command}\n\`\`\`\n`;
}

// #2118: the pasted run. A `$ `-prefixed command line and what it printed -- the shape a human actually
// pastes, and deliberately NOT one this parser tries to understand: it is read as text under a heading,
// which is the whole content of the ruling this row made (see `handRunEvidence`'s own comment).
const HAND_RUN_OUTPUT = `\`\`\`\n$ ${HAND_RUN_GH}\n"ok"\n\`\`\``;

function withHandRunOutput(body: string, output: string = HAND_RUN_OUTPUT): string {
  return `${body}\n## Hand-run output\n\n${output}\n`;
}

const NO_CAPABILITIES = { history: false, token: false, fleet: false, corpus: false };

test("#2099: a bare `gh` command is REFUSED for `token`, not classified runnable -- the job knows it has no "
  + "credential and the classifier now asks", () => {
  const verdict = classifyCommand(HAND_RUN_GH, { capabilities: NO_CAPABILITIES });
  assert.equal(verdict.verdict, "refused");
  assert.match(String(verdict.reason), /needs `token`/);
  // FOLLOWABLE: the refusal names the way out, per #1116. A message that states the fault without the
  // remedy is the shape that made an author learn `// no-token:` existed only by misusing it.
  assert.match(String(verdict.reason), /Hand-run:/);
});

test("#2099 CONTROL: the SAME command against a job that HAS a token is runnable -- the refusal is about this "
  + "job's credential, never about `gh` being unwelcome", () => {
  assert.deepEqual(classifyCommand(HAND_RUN_GH, { capabilities: WITH_TOKEN }), { verdict: "runnable" });
  // And the default (`FULL_CAPABILITIES`, #510's back-compatibility rule) is unchanged for every caller
  // that never mentions capabilities.
  assert.deepEqual(classifyCommand(HAND_RUN_GH), { verdict: "runnable" });
});

test("#2099 CONTROL: a command that merely CONTAINS `gh` is not a `gh` command -- the check reads the first "
  + "real token, never a substring (#1860's own lesson)", () => {
  for (const command of [
    "node packages/agent-org/src/high-water.mjs",
    "npx tsx --test packages/lab/src/packaging/gh-something.test.ts",
    "npm run lint -- --rule gh",
  ]) {
    // `runnable` rather than merely "not refused for token": a weaker assertion would pass if the
    // command were refused for some OTHER reason, which is the same green for the opposite fact.
    assert.deepEqual(classifyCommand(command, { capabilities: NO_CAPABILITIES }), { verdict: "runnable" },
      `${command} is not a gh invocation`);
  }
});

test("#2099: a LEADING ENVIRONMENT ASSIGNMENT does not hide the `gh` behind it -- `firstRealToken`'s own rule, "
  + "and the token variable is the spelling an author reaches for when they know about the credential", () => {
  // SPELT IN PIECES, for the reason this file's own subject enforces: `CLOSURE_REQUIREMENT_PATTERNS`
  // charges any file whose text carries the variable's name with requiring `token`, so writing it whole
  // here would make THIS file undeclarable and refuse the Acceptance command that runs it. Measured: it
  // did, and took four other tests red with it.
  const verdict = classifyCommand(`${["GH_TO", "KEN"].join("")}=x ${HAND_RUN_GH}`,
    { capabilities: NO_CAPABILITIES });
  assert.equal(verdict.verdict, "refused");
  assert.match(String(verdict.reason), /needs `token`/);
});

test("#2099: the `$ `-prefixed spelling keeps its EXISTING prose verdict -- that fault is the line never having "
  + "been written as a command, it needs a different fix, and this row does not change it", () => {
  const verdict = classifyCommand(`$ ${HAND_RUN_GH}`, { capabilities: NO_CAPABILITIES });
  assert.deepEqual(verdict, { verdict: "prose", reason: 'is not a command (no executable "$")' });
  // ... and at pr-open it still reaches EXECUTED NOTHING, which is correct: nothing verified anything.
  const report = acceptanceReport(acceptanceBody(`$ ${HAND_RUN_GH}`), () => 0);
  assert.equal(report.ok, false);
  assert.ok(report.lines.some((line) => line.includes("EXECUTED NOTHING")), report.lines.join("\n"));
});

test("#2099: an UNDECLARED `gh` Acceptance is refused AT FILING, quoting the command, in the wording pr-open "
  + "would later use -- #879's cost, paid at the moment the filer still has the context", () => {
  const reason = String(handRunAcceptanceReason(acceptanceBody(HAND_RUN_GH), "row-file"));
  assert.match(reason, /^row-file: REFUSING to file --/);
  assert.ok(reason.includes(HAND_RUN_GH), `the refusal quotes the command: ${reason}`);
  assert.match(reason, /Hand-run: <who runs it and why>/);
  assert.match(reason, /pr-open/);
});

test("#2099: a DECLARED hand-run Acceptance files clean -- the ruling is DECLARE, not refuse, because a blanket "
  + "refusal refuses a CORRECT row", () => {
  assert.equal(handRunAcceptanceReason(acceptanceBody(HAND_RUN_GH, HAND_RUN_REASON), "row-file"), null);
});

// The `row-file` WIRING -- that `fileRefusalReason` actually calls this rule -- is pinned in
// `row-file.test.ts` instead, and the reason is this file's own subject: importing `row-file.mjs` here
// puts a `gh` spawn in THIS file's import closure, which charges it `token` and makes the Acceptance
// command that runs it unrunnable in the acceptance job. Measured: it did, and took four other tests red
// with it. `row-file.test.ts` carries the `// no-token: gh` declaration that answers it, proved rather
// than asserted, and is where every other `fileRefusalReason` verdict already lives.

test("#2099: a declared hand-run reports NOT RUN NAMING THE DECLARATION -- never a pass, and never "
  + "EXECUTED NOTHING", () => {
  // #2118 AMENDED THE BODY, NOT THE CLAIM: this row's subject is still the NOT RUN line and its reason,
  // and the pasted output is now what keeps the report green (see the `NO HAND-RUN OUTPUT` tests below).
  // The `ok: true` assertion at the end of this test is the thing #2118 changed the precondition for --
  // it was true of the bare body when this test was written, and is true of an EVIDENCED one now.
  const report = acceptanceReport(withHandRunOutput(acceptanceBody(HAND_RUN_GH, HAND_RUN_REASON)), () => 0);
  const joined = report.lines.join("\n");
  assert.match(joined, /ACCEPTANCE: NOT RUN/);
  assert.ok(joined.includes(HAND_RUN_REASON), `the reason is quoted, not merely counted: ${joined}`);
  assert.doesNotMatch(joined, /EXECUTED NOTHING/);
  // NEVER A PASS: the report says in its own words that it verified nothing.
  assert.doesNotMatch(joined, /-> pass/);
  assert.match(joined, /verified NOTHING/);
  assert.equal(report.ok, true,
    "green and loud, because the alternative is a row whose only honest acceptance makes it unmergeable");
});

test("#2099 CONTROL: the SAME body without the declaration is the failure this row starts from -- REFUSED for "
  + "`token`, then EXECUTED NOTHING, `ok: false`", () => {
  const report = acceptanceReport(acceptanceBody(HAND_RUN_GH), () => 0);
  assert.equal(report.ok, false);
  const joined = report.lines.join("\n");
  assert.match(joined, /ACCEPTANCE: REFUSED/);
  assert.match(joined, /needs `token`/);
  assert.match(joined, /EXECUTED NOTHING/);
});

test("#2099: the declaration silences EXECUTED NOTHING only when EVERY command is a declared hand-run -- a fleet "
  + "refusal beside it keeps the section red, or the declaration becomes the line people add to turn a check "
  + "green", () => {
  const body = `## Acceptance\n\nHand-run: ${HAND_RUN_REASON}\n\n\`\`\`\n${HAND_RUN_GH}\nnpm run fleet:status\n\`\`\`\n`;
  const report = acceptanceReport(body, () => 0);
  const joined = report.lines.join("\n");
  assert.match(joined, /ACCEPTANCE: NOT RUN/, "the gh line is still reported as the declaration says");
  assert.match(joined, /reaches the fleet/, "the fleet line is still refused on its own facts");
  assert.match(joined, /EXECUTED NOTHING/, "and the section still executed nothing");
  assert.equal(report.ok, false);
});

test("#2099: a declared hand-run BESIDE a command that really runs reports both -- a partial answer is what "
  + "#2084's amended Acceptance actually is", () => {
  const body = `## Acceptance\n\nHand-run: ${HAND_RUN_REASON}\n\n\`\`\`\nnpx tsx --test ${REAL_FILE}\n${HAND_RUN_GH}\n\`\`\`\n`;
  const report = acceptanceReport(body, () => 0);
  const joined = report.lines.join("\n");
  assert.match(joined, /ACCEPTANCE: RAN/);
  assert.match(joined, /ACCEPTANCE: NOT RUN/);
  assert.doesNotMatch(joined, /EXECUTED NOTHING|NOTHING RAN HERE/);
  assert.equal(report.ok, true);
});

/**
 * REVIEWER-2'S BLOCKER ON #2105, and it is a scope fault rather than a wiring one: `handRun` is read once
 * from the whole body and handed to BOTH sections, so `runOneCommand` honouring it without asking which
 * section it was in let one line convert an unrelated `Refutation:` `gh` command into
 * `NOT RUN ... declared hand-run` -- a POSITIVE claim that a human ran something, attributed to a filer
 * who was never asked about that command. `handRunAcceptanceReason` reads `extractAcceptanceSection`
 * alone, so the declaration only ever spoke for the Acceptance commands.
 *
 * THE MATCHED PAIR IS THE POINT: the same command string, in the same body, under the two headers --
 * honoured under `Acceptance:`, refused for `token` under `Refutation:`.
 */
test("#2099: a `Refutation:` `gh` line does NOT inherit the Acceptance's `Hand-run:` declaration -- it keeps "
  + "its own REFUSED-for-`token` verdict, and nothing claims a human ran it", () => {
  const body = `Hand-run: ${HAND_RUN_REASON}\n`
    + `Acceptance:\nnpx tsx --test ${REAL_FILE}\n`
    + `Refutation:\n${HAND_RUN_GH}\n`;
  const report = acceptanceReport(body, () => 0);
  const refutation = report.lines.filter((line) => line.startsWith("REFUTATION:")).join("\n");
  assert.match(refutation, /REFUTATION: REFUSED/, `the refutation keeps its own verdict: ${refutation}`);
  assert.match(refutation, /needs `token`/);
  assert.doesNotMatch(refutation, /REFUTATION: NOT RUN/);
  // NOT MERELY THE WORD: the reason a reader acts on must not name a declaration nobody made about this
  // command, which is the whole content of the fault.
  assert.ok(!refutation.includes(HAND_RUN_REASON), `the declaration is not quoted at it: ${refutation}`);
  // AND THE REMEDY IS FOLLOWABLE HERE (#1116): the message must not send the author to add a `Hand-run:`
  // line that this section will ignore -- it says so, and names what does work instead.
  assert.match(refutation, /does NOT cover this line/);
  assert.match(refutation, /move the line to `Acceptance:`/);
  // The Acceptance half is untouched by the scoping -- it ran, so the section is a real answer.
  assert.match(report.lines.join("\n"), /ACCEPTANCE: RAN/);
  assert.equal(report.ok, true);
});

test("#2099 CONTROL for the pair above: the SAME command under `Acceptance:` IS honoured -- the difference is "
  + "the header it sits under, never the command", () => {
  // #2118: the body carries its pasted run, which is what keeps this half green now; the pair's subject
  // is unchanged -- which HEADER the command sits under, never whether it was evidenced.
  const body = withHandRunOutput(`Hand-run: ${HAND_RUN_REASON}\nAcceptance:\n${HAND_RUN_GH}\n`);
  const report = acceptanceReport(body, () => 0);
  const joined = report.lines.join("\n");
  assert.match(joined, /ACCEPTANCE: NOT RUN/, joined);
  assert.ok(joined.includes(HAND_RUN_REASON), `the declaration IS quoted here: ${joined}`);
  assert.equal(report.ok, true);
  // The other half of the same pair: UNDECLARED under `Acceptance:`, the remedy offered IS the
  // declaration, because there it really works.
  const undeclared = acceptanceReport(`Acceptance:\n${HAND_RUN_GH}\n`, () => 0).lines.join("\n");
  assert.match(undeclared, /ACCEPTANCE: REFUSED/);
  assert.match(undeclared, /Run it by hand and declare it/);
  assert.doesNotMatch(undeclared, /does NOT cover this line/);
});

test("#2099: the `Hand-run:` line is a DECLARATION wherever it lands, never a command -- #1036's measured "
  + "failure on `History: full`, which was taken as a command and terminated the scan before the real one", () => {
  const inside = `## Acceptance\n\nHand-run: ${HAND_RUN_REASON}\n\n\`\`\`\nnpx tsx --test ${REAL_FILE}\n\`\`\`\n`;
  const section = extractAcceptanceSection(inside);
  assert.equal(section.kind, "commands");
  assert.deepEqual(section.kind === "commands" ? section.commands : [], [`npx tsx --test ${REAL_FILE}`],
    "the declaration is not in the command list, and the real command below it still is");
});

test("#2099: `Hand-run:` WITH NO REASON is not a declaration -- a bare flag would be the thing people add to make "
  + "a red check green, which is why `Closes: none -- <reason>` requires one too", () => {
  assert.equal(handRunDeclaration("Hand-run:"), null);
  assert.equal(handRunDeclaration("Hand-run:   "), null);
  // ... and it is still not taken as a command (the near-miss rule, #1036): the row gets ONE refusal, and
  // it is the one that names the actual problem.
  const body = `## Acceptance\n\nHand-run:\n\n\`\`\`\n${HAND_RUN_GH}\n\`\`\`\n`;
  const section = extractAcceptanceSection(body);
  assert.deepEqual(section.kind === "commands" ? section.commands : [], [HAND_RUN_GH]);
  assert.match(String(handRunAcceptanceReason(body, "row-file")), /REFUSING to file/);
});

test("#2105: an EMPTY BOLD declaration is no declaration -- `**Hand-run: **` captured its own closing marker "
  + "as the reason, and the two readers of that body then disagreed about it", () => {
  // reviewer's blocker on #2105, and the bare spellings above are NOT its control: those never match the
  // pattern at all, while these DO -- the capture takes the closing `**` and the trailing-marker strip
  // empties it, so the emptiness has to be tested after normalization rather than inferred from the match.
  for (const spelling of ["**Hand-run: **", "__Hand-run: ____", "**Hand-run:**", "**Hand-run:   **"]) {
    assert.equal(handRunDeclaration(spelling), null, `${spelling} declares nothing and names no one`);
  }
  // THE CONTROL THAT MUST STILL PASS, differing from the first spelling above in exactly the reason:
  // the fix must not cost the bold-wrapped declaration the row actually ships.
  assert.equal(handRunDeclaration("**Hand-run: the admin holder**"), "the admin holder");

  // AND THE PROPERTY THAT BROKE IS THE TWO READERS AGREEING, not either verdict alone. Before the fix
  // `handRunAcceptanceReason` asked `!== null` and filed this body CLEAN while `acceptanceReport` read
  // the same `""` for truthiness and returned `ok: false` -- the row passed the filing gate that exists
  // to catch it early and failed the job that costs a rewrite, the exact #879 sequence #2099 ends.
  const empty = `## Acceptance\n\n**Hand-run: **\n\n\`\`\`\n${HAND_RUN_GH}\n\`\`\`\n`;
  assert.match(String(handRunAcceptanceReason(empty, "row-file")), /REFUSING to file/,
    "filing refuses it, because nothing was declared");
  // The runner RECORDS rather than returning a bare 0: a refusal that spawned the `gh` anyway would
  // report the same verdict while having made the live call the whole capability gate exists to prevent.
  const spawned: string[] = [];
  const report = acceptanceReport(empty, (cmd) => { spawned.push(cmd); return 0; });
  assert.equal(report.ok, false, "and the job refuses it too -- one story about one body");
  assert.deepEqual(spawned, [], "and it refused BEFORE spawning -- no credential-less `gh` call was made");
  // THE VERDICT IS THE LINE'S OWN PREFIX, NEVER A SUBSTRING OF THE REPORT. A `doesNotMatch(/NOT RUN/)`
  // over the joined lines fails here on the REFUSAL'S OWN REMEDY -- which offers "a `Hand-run:` line
  // makes this line report `NOT RUN` naming your reason" -- so it would read a correct refusal as the
  // bug. That is the same false read reviewer-2's blocker produced one round earlier in this file, and
  // it is worth the extra line: what is being asserted is which verdict this command GOT, and only the
  // prefix says that.
  const verdicts = report.lines.filter((line) => line.startsWith("ACCEPTANCE: "));
  assert.equal(verdicts.some((line) => line.startsWith("ACCEPTANCE: NOT RUN")), false,
    "never NOT RUN: there is no reason to name, which is why it is not a declaration");
  assert.equal(verdicts.some((line) => line.startsWith("ACCEPTANCE: REFUSED")), true);

  // ... and the declared twin, differing in exactly the reason inside the same bold wrapper, is honoured
  // by BOTH readers -- the positive control for the emptiness assertions above.
  // #2118: with its pasted run, because the bare form is now refused for the evidence rather than for the
  // declaration -- and this pair is about the DECLARATION being read, so the other refusal must be out of
  // the way for the assertion below to be about what it says it is about.
  const declared = withHandRunOutput(
    `## Acceptance\n\n**Hand-run: ${HAND_RUN_REASON}**\n\n\`\`\`\n${HAND_RUN_GH}\n\`\`\`\n`);
  assert.equal(handRunAcceptanceReason(declared, "row-file"), null);
  const declaredSpawned: string[] = [];
  const declaredReport = acceptanceReport(declared, (cmd) => { declaredSpawned.push(cmd); return 0; });
  assert.equal(declaredReport.ok, true);
  assert.deepEqual(declaredSpawned, [],
    "a declared hand-run is not run either -- that is exactly what the declaration says");
  assert.match(declaredReport.lines.join("\n"), new RegExp(`NOT RUN.*${HAND_RUN_REASON}`));
});

test("#2099: the declaration is read BOLD-TOLERANTLY and keeps an interior emphasis -- `**Hand-run: ...**` is a "
  + "spelling these bodies reach for constantly, and #1036 is the record of it being recognised nowhere", () => {
  assert.equal(handRunDeclaration("**Hand-run: the admin holder**"), "the admin holder");
  assert.equal(handRunDeclaration("Hand-run: the **admin** holder"), "the **admin** holder");
});

test("#2099: a declaration does NOT invent a credential -- `jobCapabilities` still reports `token: false`, "
  + "because the job's environment is not a thing a body can change", () => {
  assert.equal(jobCapabilities(`Hand-run: ${HAND_RUN_REASON}`).token, false);
});

test("#2099: #2084's REAL Acceptance -- the live correct-row case -- files clean, declared or not, because its "
  + "amended command is one this job can actually run", () => {
  // The row as it stands at 2026-09-23: an rstest command the job runs, plus the `$ `-prefixed hand-run
  // read named as what remains. A blanket refusal of every `gh` Acceptance would have broken this row.
  //
  // #2221: THE FILE IS NOT #2084's ANY MORE, AND THAT IS THE FINDING. That row named
  // `branch-protection.test.ts`, which declares `// requires: token`; the capability gate never read a
  // named `rstest --include` command, so a row this job could not honestly run read as one it could. The
  // gate reads it now and refuses it, so this control uses a file that needs nothing -- the point of the
  // control is the hand-run split, not which test the command names.
  const real = "## Acceptance\n\n```\nnpx rstest run --config scripts/rstest/rstest.config.mjs "
    + `--include ${REAL_FILE}\n\`\`\`\n\n`
    + "**What remains, run by hand and quoted into the PR body:**\n\n```\n$ " + HAND_RUN_GH + "\n```\n";
  assert.equal(handRunAcceptanceReason(real, "row-file"), null);
  assert.equal(handRunAcceptanceReason(`${real}\nHand-run: ${HAND_RUN_REASON}\n`, "row-file"), null);
});

test("#2099: the row template DECLARES the field -- the open-check that opened this row read `grep -ci token "
  + "backlog-row.yml` as 0, and a mechanism no filer is told about is the prose it replaced", () => {
  const template = readFileSync(".github/ISSUE_TEMPLATE/backlog-row.yml", "utf8");
  assert.match(template, /Hand-run: <who runs it and why>/);
  assert.match(template, /acceptance job/i);
  // #2118: and it names where the output goes, for the identical reason -- the filer is told about the
  // requirement in the one document they are actually reading when they write the Acceptance.
  assert.match(template, /## Hand-run output/);
});

// --- #2118: THE OTHER HALF OF #2099 -- the declaration was required, the OUTPUT was not ---
//
// #2105 gave `token` what `fleet` has: a declared field, then verified. Only the declaration half bit.
// `handRunAcceptanceReason` refused to FILE a `gh` Acceptance with no `Hand-run:` line, and after that
// NOTHING required the pasted output to exist at all: a body could declare `Hand-run:`, paste nothing,
// and merge green. Measured on the shipped module at `e1b8b7bc5`, 2026-09-23 -- `acceptanceReport` of a
// declared-hand-run body with no output anywhere returned `{ ok: true }`.
//
// THE ASYMMETRY IS WHY IT MATTERED. `Acceptance: none -- <reason>` claims nothing was run.
// `Hand-run:` asserts a human DID run something -- a positive claim about work performed, and the only
// one on this path that nothing checked.
//
// THE RULING, in the tests as well as in the code: shape 1 of the two #2118 offered -- a named
// `## Hand-run output` section that is not empty. Shape 2 (the output matched against the declared
// command string) is refused because the only half of it checkable here is the COMMAND STRING, and that
// proxy fails in both directions; `handRunEvidence`'s own comment carries the full argument. So these
// tests pin what this check DOES prove -- that a human wrote something there -- and, just as explicitly,
// that its message says what it did not.

test("#2118: a body whose Acceptance is ENTIRELY declared hand-runs and which pastes NO output is REFUSED -- "
  + "`ok: false`, and the NOTHING RAN HERE line it used to stop at is still printed beside it", () => {
  const report = acceptanceReport(acceptanceBody(HAND_RUN_GH, HAND_RUN_REASON), () => 0);
  assert.equal(report.ok, false, report.lines.join("\n"));
  const joined = report.lines.join("\n");
  assert.match(joined, /ACCEPTANCE: NO HAND-RUN OUTPUT/);
  // THE TRUE STATEMENT STAYS. `NOTHING RAN HERE` is a fact about this job regardless of the evidence, and
  // dropping it on the refusal path would trade one honest line for another instead of adding one.
  assert.match(joined, /NOTHING RAN HERE/);
  assert.match(joined, /verified NOTHING/);
});

test("#2118 CONTROL -- THE MATCHED PAIR: the SAME body carrying the pasted run is NOT refused, and the two "
  + "differ in exactly the evidence block", () => {
  const bare = acceptanceBody(HAND_RUN_GH, HAND_RUN_REASON);
  const evidenced = withHandRunOutput(bare);
  assert.equal(evidenced.replace(`\n## Hand-run output\n\n${HAND_RUN_OUTPUT}\n`, ""), bare,
    "the pair differs in the evidence block and in nothing else");

  const report = acceptanceReport(evidenced, () => 0);
  assert.equal(report.ok, true, report.lines.join("\n"));
  const joined = report.lines.join("\n");
  assert.doesNotMatch(joined, /NO HAND-RUN OUTPUT/);
  assert.match(joined, /ACCEPTANCE: NOT RUN/, "still NOT RUN: the evidence is a human's, not this job's");
  assert.match(joined, /NOTHING RAN HERE/);
  // AND THE ACCEPTANCE SECTION ITSELF IS UNTOUCHED BY THE NEW HEADING -- the evidence block must not
  // become a command, or the check would change what it is checking.
  const section = extractAcceptanceSection(evidenced);
  assert.deepEqual(section.kind === "commands" ? section.commands : [], [HAND_RUN_GH]);
});

test("#2118: the refusal is FOLLOWABLE (#1116) -- it names the exact heading to add, and says in its own "
  + "words what it checked and what it did not", () => {
  const report = acceptanceReport(acceptanceBody(HAND_RUN_GH, HAND_RUN_REASON), () => 0);
  const refusal = report.lines.find((line) => line.startsWith("ACCEPTANCE: NO HAND-RUN OUTPUT"));
  assert.ok(refusal, report.lines.join("\n"));
  // THE HEADING BY NAME, not "add a section": the author must not have to guess the spelling the parser
  // accepts, which is the whole of #1116's rule.
  assert.ok(String(refusal).includes("## Hand-run output"), `names the heading: ${refusal}`);
  assert.ok(String(refusal).includes("**Hand-run output:**"), `names the other spelling too: ${refusal}`);
  // AND IT DOES NOT OVERSTATE ITSELF. #2118's own instruction: "do not ship the stronger-sounding message
  // for the weaker check". This asserts the message names the limit, not merely that a refusal occurred.
  assert.match(String(refusal), /WHAT THIS CHECKED: that such a section exists and is not empty/);
  assert.match(String(refusal), /WHAT IT DID NOT CHECK: whether that text is this command's output/);
  assert.match(String(refusal), /nothing here can re-run the command and compare/);
  // The `NOT RUN` line the author meets FIRST carries the same remedy -- a reader who acts on the first
  // line they understand must not be sent anywhere else.
  const notRun = report.lines.find((line) => line.startsWith("ACCEPTANCE: NOT RUN"));
  assert.ok(String(notRun).includes("## Hand-run output"), `the NOT RUN line names it too: ${notRun}`);
});

test("#2118: and the FILING refusal says the cost up front -- #879's rule, which is the whole reason #2099 "
  + "moved this verdict to `row-file` in the first place", () => {
  const reason = String(handRunAcceptanceReason(acceptanceBody(HAND_RUN_GH), "row-file"));
  assert.ok(reason.includes("## Hand-run output"), `the filer is told now, not at pr-open: ${reason}`);
  assert.match(reason, /#2118/);
});

test("#2118 CONTROL, THE ONE THAT DECIDES WHETHER THIS ROW HELPED: #2084's REAL body -- the live "
  + "correct-row case -- is untouched, because something in it actually RAN", () => {
  // The row as it stands at 2026-09-23, copied in #2099's own test above: an rstest command the job runs,
  // plus a `$ `-prefixed hand-run read named as what remains. `handRun < commands.length` here -- in fact
  // `handRun === 0` -- so this row never reaches the new refusal at all, which is the point: #2118 must
  // not charge a row whose Acceptance this job can execute.
  //
  // #2221: THE FILE IS NOT #2084's ANY MORE, AND THAT IS THE FINDING. That row named
  // `branch-protection.test.ts`, which declares `// requires: token`; the capability gate never read a
  // named `rstest --include` command, so a row this job could not honestly run read as one it could. The
  // gate reads it now and refuses it, so this control uses a file that needs nothing -- the point of the
  // control is the hand-run split, not which test the command names.
  const real = "## Acceptance\n\n```\nnpx rstest run --config scripts/rstest/rstest.config.mjs "
    + `--include ${REAL_FILE}\n\`\`\`\n\n`
    + "**What remains, run by hand and quoted into the PR body:**\n\n```\n$ " + HAND_RUN_GH + "\n```\n";
  const report = acceptanceReport(real, () => 0);
  assert.equal(report.ok, true, report.lines.join("\n"));
  assert.doesNotMatch(report.lines.join("\n"), /NO HAND-RUN OUTPUT/);
});

test("#2118 CONTROL: #2084's Acceptance reduced to its hand-run half -- the shape this row DOES charge -- is "
  + "refused bare and passes once it carries its pasted run", () => {
  // The same row, had its amendment not found a command the job can run: a `gh` read of branch protection
  // and nothing else. THIS is the body #2118 is about, and the pair below is the proof that the ruling
  // leaves it mergeable rather than stranding it -- #2099's own trade, kept.
  const handRunOnly = acceptanceBody(HAND_RUN_GH, HAND_RUN_REASON);
  assert.equal(handRunDeclaration(handRunOnly), HAND_RUN_REASON, "the declaration is read in this shape");
  assert.equal(acceptanceReport(handRunOnly, () => 0).ok, false, "bare: refused");
  const evidenced = acceptanceReport(withHandRunOutput(handRunOnly), () => 0);
  assert.equal(evidenced.ok, true, evidenced.lines.join("\n"));
  assert.match(evidenced.lines.join("\n"), new RegExp(`NOT RUN.*${HAND_RUN_REASON}`));
});

test("#2118: A PARTIAL HAND-RUN IS UNTOUCHED, both directions -- `handRun < commands.length` means something "
  + "really ran, and charging it for evidence would charge a row for a command that executed", () => {
  const body = `## Acceptance\n\nHand-run: ${HAND_RUN_REASON}\n\n\`\`\`\nnpx tsx --test ${REAL_FILE}\n${HAND_RUN_GH}\n\`\`\`\n`;
  const bare = acceptanceReport(body, () => 0);
  assert.equal(bare.ok, true, bare.lines.join("\n"));
  assert.doesNotMatch(bare.lines.join("\n"), /NO HAND-RUN OUTPUT/);
  assert.match(bare.lines.join("\n"), /ACCEPTANCE: RAN/);
  // THE OTHER DIRECTION, which is what "pinned in both directions" has to mean here: adding the evidence
  // changes NOTHING about a partial section. If it did, the section's verdict would depend on a field that
  // is not supposed to speak for it, and the next reader could not tell which fact produced the green.
  const evidenced = acceptanceReport(withHandRunOutput(body), () => 0);
  assert.deepEqual(evidenced.lines, bare.lines);
  assert.equal(evidenced.ok, true);
});

test("#2118: a declared hand-run BESIDE AN UNDECLARED REFUSAL keeps EXECUTED NOTHING and never reports NO "
  + "HAND-RUN OUTPUT -- two different faults must not print the same word", () => {
  // `ran === 0` but `handRun < commands.length`: the fleet line was refused on its own facts and nobody
  // declared it. The fault is that the section declares nothing this job can run, which is EXECUTED
  // NOTHING's subject; the evidence rule has no business speaking here, and pasting a run does not help.
  const body = `## Acceptance\n\nHand-run: ${HAND_RUN_REASON}\n\n\`\`\`\n${HAND_RUN_GH}\nnpm run fleet:status\n\`\`\`\n`;
  for (const [label, text] of [["bare", body], ["evidenced", withHandRunOutput(body)]] as const) {
    const report = acceptanceReport(text, () => 0);
    assert.equal(report.ok, false, `${label}: ${report.lines.join("\n")}`);
    assert.match(report.lines.join("\n"), /EXECUTED NOTHING/, label);
    assert.doesNotMatch(report.lines.join("\n"), /NO HAND-RUN OUTPUT/, label);
  }
});

// --- #2118: `handRunEvidence` itself -- what counts as pasted, and what only looks like it ---
//
// THE POSITIVE CONTROL FOR EVERY `null` BELOW IS THE LINE BESIDE IT: each empty reading is followed by the
// same body with real text in the same place, returning it. An emptiness assertion whose control the
// writer cannot point at is this repo's own recorded defect, and these are deliberately paired rather than
// grouped so the pointing is local.

test("#2118: an EMPTY FENCE under the heading is not evidence -- and the same fence with a line in it is", () => {
  assert.equal(handRunEvidence("## Hand-run output\n\n```\n```\n"), null);
  assert.ok(handRunEvidence("## Hand-run output\n\n```\nok\n```\n"));
});

test("#2118: the TEMPLATE'S OWN HTML COMMENT is not evidence -- every author leaves it in place, so counting "
  + "it would make the heading the evidence for itself", () => {
  assert.equal(handRunEvidence("## Hand-run output\n\n<!-- paste what you ran and what it printed -->\n"), null);
  assert.ok(handRunEvidence("## Hand-run output\n\n<!-- paste it here -->\n\"ok\"\n"));
});

test("#2118: the heading ALONE is not evidence, and neither is its own title text (#506's rule, which this "
  + "parser has already paid for once)", () => {
  assert.equal(handRunEvidence("## Hand-run output\n"), null);
  assert.equal(handRunEvidence("## Hand-run output -- 2026-09-23, by the admin holder\n"), null,
    "a heading's trailing text names the section; it is not somebody's pasted run");
  assert.ok(handRunEvidence("## Hand-run output -- 2026-09-23\n\n\"ok\"\n"));
});

test("#2118: the BOLD/PLAIN spelling is accepted with its content inline -- #1036's rule, that an "
  + "unrecognised spelling produces a refusal about something the author did not do", () => {
  assert.equal(handRunEvidence('**Hand-run output:** "ok"'), '"ok"');
  assert.equal(handRunEvidence("Hand-run output:\n\"ok\"\n"), '"ok"');
  // ... and the near-miss that is NOT this field reads as absent rather than as empty evidence.
  assert.equal(handRunEvidence("## Hand run output\n\n\"ok\"\n"), null,
    "a different heading is a different section; this check is not satisfied by any heading");
});

test("#2118: the section ENDS at the next heading -- text under a later section is not this one's evidence, "
  + "and the same text under the right heading is", () => {
  assert.equal(handRunEvidence("## Hand-run output\n\n## Notes\n\n\"ok\"\n"), null);
  assert.ok(handRunEvidence("## Notes\n\n## Hand-run output\n\n\"ok\"\n"));
});

test("#2118: EVERY heading, never the first -- the explicit decision this file's header comment demands, and "
  + "it lands on #527's side rather than #540's", () => {
  // Two pasted runs are two pasted runs: unlike a second `Acceptance:`, there is no "which one did you
  // mean" to guess at, so reading both guesses at nothing. An empty FIRST section followed by a real
  // second one is the case that decides it -- `findIndex` would have read this body as unevidenced.
  const two = "## Hand-run output\n\n```\n```\n\n## Hand-run output\n\n\"ok\"\n";
  assert.ok(handRunEvidence(two), "the second section is read");
  const both = String(handRunEvidence("## Hand-run output\n\n\"first\"\n\n## Hand-run output\n\n\"second\"\n"));
  // BOTH, IN BODY ORDER -- asserted as an ordering rather than as an exact string, because the blank
  // lines between them are the author's own formatting and pinning them would make this test about
  // whitespace instead of about which sections were read.
  assert.ok(both.includes('"first"') && both.includes('"second"'), both);
  assert.ok(both.indexOf('"first"') < both.indexOf('"second"'), both);
});

test("#2118: a bare `**Hand-run output:**` line ENDS an in-progress Acceptance block rather than becoming one "
  + "more command -- #438's stop rule, and #1036's measured failure on exactly this shape", () => {
  const body = `Acceptance:\nnpx tsx --test ${REAL_FILE}\n**Hand-run output:** "ok"\n`;
  const section = extractAcceptanceSection(body);
  assert.deepEqual(section.kind === "commands" ? section.commands : [], [`npx tsx --test ${REAL_FILE}`],
    "the evidence header is not in the command list");
  assert.equal(handRunEvidence(body), '"ok"');
});

test("#2118: no such section at all is `null`, and that is the state this row was filed about -- declared, "
  + "pasted nothing", () => {
  assert.equal(handRunEvidence(acceptanceBody(HAND_RUN_GH, HAND_RUN_REASON)), null);
  assert.equal(handRunEvidence(""), null);
  assert.equal(handRunEvidence(null), null);
  assert.ok(handRunEvidence(withHandRunOutput(acceptanceBody(HAND_RUN_GH, HAND_RUN_REASON))));
});

test("#2118: the evidence is NOT overridable through `deps` -- it is the field that decides whether a "
  + "positive claim about a human's work is believed", () => {
  // `capabilities` is overridable (a test exercises a job it is not running in); this is not, for the
  // sharper version of #2099's own reason: a caller able to supply it could report a run as evidenced by
  // text that is in no body at all.
  const report = acceptanceReport(acceptanceBody(HAND_RUN_GH, HAND_RUN_REASON), () => 0,
    { handRunEvidence: "\"ok\"" } as never);
  assert.equal(report.ok, false, report.lines.join("\n"));
  assert.match(report.lines.join("\n"), /NO HAND-RUN OUTPUT/);
});

// --- #2221: THE CAPABILITY GATE IS KEYED ON THE FILES A COMMAND NAMES, NOT ON THE RUNNER'S NAME. Both
// requirement checks opened with "is this `tsx --test` or a whole suite", so `rstest run --include <file>`
// -- the spelling every row is now required to write -- was charged nothing: the same corpus-requiring
// file was refused via `npm test` and handed to the runner when named. ---

/** The file the row's own probe used: it reaches the corpus, and declares nothing. Real, so `existsSync` holds. */
const CORPUS_FILE = "packages/lab/src/abstention-regression.test.ts";
const RSTEST = "npx rstest run --config scripts/rstest/rstest.config.mjs";
/** Every spelling of "run this one file" that this repo's rows, scripts and CI use. */
const NAMING_SPELLINGS: Record<string, (file: string) => string> = {
  "rstest --include": (file) => `${RSTEST} --include ${file}`,
  "rstest --include=": (file) => `npx rstest run --include=${file}`,
  "assert-glob-not-empty --runner=rstest": (file) =>
    `node packages/guards/src/assert-glob-not-empty.mjs "${file}" --min=1 --run --runner=rstest`,
  "tsx --test (the regression control)": (file) => `npx tsx --test ${file}`,
};

test("#2221 THE CONTROL THIS ROW EXISTS FOR: a corpus-requiring file is REFUSED in every spelling that "
  + "names it, with a message naming the FILE and the REQUIREMENT -- not merely a non-empty list", () => {
  assert.equal(unmetCommandClosureRequirements("npm test", NO_CAPABILITIES).length, 1,
    "positive control: the suite spelling already refuses on `corpus` -- the population is not empty");
  for (const [spelling, command] of Object.entries(NAMING_SPELLINGS)) {
    const unmet = unmetCommandClosureRequirements(command(CORPUS_FILE), NO_CAPABILITIES);
    assert.equal(unmet.length, 1, `${spelling}: expected one refusal, got ${JSON.stringify(unmet)}`);
    assert.equal(unmet[0].requirement, "corpus", spelling);
    assert.match(unmet[0].message, /^abstention-regression\.test\.ts requires corpus via /, spelling);
    const verdict = classifyCommand(command(CORPUS_FILE), { capabilities: NO_CAPABILITIES });
    assert.equal(verdict.verdict, "refused", spelling);
    assert.match(String((verdict as { reason?: string }).reason),
      /needs `corpus`, which this job does not have -- abstention-regression\.test\.ts requires corpus/,
      spelling);
  }
});

test("#2221 THE SAME FILE, THE SAME COMMAND, once the job HAS the capability: nothing unmet -- the refusal "
  + "tracked the capability, not the spelling", () => {
  const withCorpus = { ...NO_CAPABILITIES, corpus: true };
  for (const [spelling, command] of Object.entries(NAMING_SPELLINGS)) {
    assert.deepEqual(unmetCommandClosureRequirements(command(CORPUS_FILE), withCorpus), [], spelling);
  }
});

test("#2221: `--config <file>` names a file that exists and is no test -- it is NOT read as one", () => {
  // A file-shaped argument that is not a test file must not be walked: charging a command for its
  // runner's own configuration would refuse every named row.
  assert.deepEqual(unmetCommandClosureRequirements(`${RSTEST} --include ${REAL_FILE}`, NO_CAPABILITIES), []);
  assert.deepEqual(unmetCommandRequirements(`${RSTEST} --include ${REAL_FILE}`, NO_CAPABILITIES), []);
});

test("#2221: a NAMED command reports EVERY file it names; the suite short-circuits on the first -- exactly "
  + "the split the comment in the loop states", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-2221-"));
  try {
    writeSyntheticMixedModule(dir, "checkRelease");
    const needy = ["a.test.mjs", "b.test.mjs"].map((name) => {
      const entry = join(dir, name);
      writeFileSync(entry, "import { safeRender } from \"./mixed-module.mjs\";\nsafeRender(1);\n");
      return entry;
    });
    const unmet = unmetCommandClosureRequirements(`npx rstest run --include ${needy.join(" ")}`,
      NO_CAPABILITIES);
    assert.deepEqual(unmet.map((u) => u.message.split(" ")[0]), ["a.test.mjs", "b.test.mjs"]);
    assert.equal(unmetCommandClosureRequirements("npm test", NO_CAPABILITIES).length, 1,
      "the whole-suite command still reports ONE refusal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2221: a `// no-token:` declaration STILL suppresses it for a named file, and the same file with no "
  + "declaration is refused -- #827's mechanism is the author's answer and this row does not touch it", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-2221-"));
  try {
    writeSyntheticMixedModule(dir, "checkRelease");
    const body = "import { safeRender } from \"./mixed-module.mjs\";\nsafeRender(1);\n";
    const undeclared = join(dir, "undeclared.test.mjs");
    const declared = join(dir, "declared.test.mjs");
    writeFileSync(undeclared, body);
    writeFileSync(declared, `// no-token: checkRelease\n${body}`);
    const command = (file: string) => `npx rstest run --include ${file}`;
    assert.deepEqual(
      unmetCommandClosureRequirements(command(undeclared), NO_CAPABILITIES).map((u) => u.requirement),
      ["token"], "the undeclared file needs a token and says so");
    assert.deepEqual(unmetCommandClosureRequirements(command(declared), NO_CAPABILITIES), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2221: a header-declared `// requires:` is charged for a named rstest file too", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-2221-"));
  try {
    const file = join(dir, "needs-history.test.mjs");
    writeFileSync(file, "// requires: history\nexport {};\n");
    assert.deepEqual(unmetCommandRequirements(`npx rstest run --include ${file}`, NO_CAPABILITIES),
      [{ requirement: "history", files: [file] }]);
    assert.deepEqual(
      unmetCommandRequirements(`npx rstest run --include ${file}`, { ...NO_CAPABILITIES, history: true }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2221: a command that names no test file is still never inspected, and one that names a file which "
  + "does not exist is skipped rather than throwing -- `testFileArgumentsResolve` owns that question", () => {
  assert.deepEqual(unmetCommandClosureRequirements("npm run lint", NO_CAPABILITIES), []);
  assert.deepEqual(unmetCommandClosureRequirements(
    "npx rstest run --include packages/lab/src/training/abstention-regression.test.ts", NO_CAPABILITIES), [],
    "a path that does not exist reads 0 for a reason that is NOT the hole -- the row's own first probe");
});

// ---------------------------------------------------------------------------------------------------------
// #2305: A PR THAT CHANGES A TEST MUST CARRY A `Mutation:` RECORD, or `Mutation: none -- <reason>`.
// Positive control for every emptiness below: `TEST_DIFF` names a real test file and `testFilesAmong` is
// asserted to find it, so "no test in the diff" is never a verdict reached by an empty population.
// ---------------------------------------------------------------------------------------------------------
const TEST_DIFF = { ok: true as const, files: ["packages/lab/src/packaging/x.test.ts", "README.md"] };
const SOURCE_DIFF = { ok: true as const, files: ["packages/agent-org/src/x.mjs", "README.md"] };

test("#2305: testFilesAmong finds every test-file shape this repo writes, and no source file", () => {
  assert.deepEqual(testFilesAmong(TEST_DIFF.files), ["packages/lab/src/packaging/x.test.ts"],
    "the positive control: the population the rest of this block relies on is not empty");
  const shapes = ["a/b.test.mjs", "packages/scorer/tests/test_vague_link_context.py", "a/b_test.py", "a/b.test.js"];
  assert.deepEqual(testFilesAmong(shapes), shapes);
  assert.deepEqual(testFilesAmong(["a/test-support/helper.ts", "a/contest.ts", "a/latest.mjs"]), []);
});

test("#2305: THE ROW'S OWN FAILING TEST -- a diff with a test and an empty `Mutation:` is MISSING, and fails", () => {
  for (const body of ["Closes #1\n\nMutation:\n\n## What changes", "Closes #1", "Mutation: none",
    "Mutation: <!-- what you broke -->"]) {
    const report = mutationRecordReport({ body, diff: TEST_DIFF });
    assert.equal(report.ok, false, `${JSON.stringify(body)} must not pass`);
    assert.match(report.line, /^MUTATION: MISSING/);
    assert.match(report.line, /x\.test\.ts/, "names the test file that owes the record");
  }
});

test("#2305: a record, or `Mutation: none -- <reason>`, passes; the reason is required", () => {
  const record = mutationRecordReport({ body: "Mutation: npm run mutate -- --file x.mjs", diff: TEST_DIFF });
  assert.equal(record.ok, true);
  assert.match(record.line, /^MUTATION: RECORDED/);
  const prose = mutationRecordReport({ body: "Mutation:\nDeleted the guard; the test went red.", diff: TEST_DIFF });
  assert.equal(prose.ok, true);
  const none = mutationRecordReport({ body: "Mutation: none \u2014 a rename, no behaviour", diff: TEST_DIFF });
  assert.deepEqual(none, { ok: true, line: "MUTATION: NONE -> a rename, no behaviour" });
  assert.equal(mutationRecordReport({ body: "Mutation: none -- a rename", diff: TEST_DIFF }).ok, true,
    "the ASCII spelling the row wrote is accepted too");
  assert.equal(mutationRecordReport({ body: "Mutation: none", diff: TEST_DIFF }).ok, false);
});

test("#2305: a diff with no test file owes nothing, and a body with no `Mutation:` still passes it", () => {
  const report = mutationRecordReport({ body: "Closes #1", diff: SOURCE_DIFF });
  assert.deepEqual(report, { ok: true, line: "MUTATION: NOT REQUIRED -- no test file in the diff" });
  assert.equal(mutationRecordReport({ body: null, diff: SOURCE_DIFF }).ok, true);
});

test("#2305: two `Mutation:` headers fail rather than pick one", () => {
  const report = mutationRecordReport({ body: "Mutation: a\n\nMutation: b", diff: TEST_DIFF });
  assert.equal(report.ok, false);
  assert.match(report.line, /^MUTATION: DUPLICATE/);
});

test("#2305: a diff this job could not read is UNCHECKED -- loud, and not a failure", () => {
  const report = mutationRecordReport({ body: "", diff: { ok: false, why: "git said: boom" } });
  assert.equal(report.ok, true);
  assert.match(report.line, /^MUTATION: UNCHECKED .*git said: boom/);
});

/** A base with one commit, a PR branch adding a test, base moving on, then the merge commit `checkout` builds. */
function mergedPullRequest(dir: string, run: (args: string[]) => string, commit: (message: string) => string) {
  const write = (name: string) => { mkdirSync(join(dir, "src"), { recursive: true }); writeFileSync(join(dir, name), name); };
  write("base.txt"); run(["add", "-A"]); commit("base");
  run(["branch", "-M", "main"]);
  run(["checkout", "-q", "-b", "pr"]);
  write("src/x.test.ts"); write("src/x.mjs"); run(["add", "-A"]); commit("pr work");
  run(["checkout", "-q", "main"]);
  write("base-moved-on.test.ts"); run(["add", "-A"]); commit("base moves on");
  run(["checkout", "-q", "-b", "merge-ref"]);
  run(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "merge", "--no-ff", "-q", "-m", "merge", "pr"]);
}

test("#2305: the diff is the PR's OWN files -- HEAD^1..HEAD of the merge commit, not what the base did since", () => {
  withGitSandbox(({ dir, run, commit }) => {
    mergedPullRequest(dir, run, commit);
    const reading = changedFilesOfThisPullRequest(dir);
    assert.deepEqual(reading, { ok: true, files: ["src/x.mjs", "src/x.test.ts"] },
      "base-moved-on.test.ts landed on the base and is not this PR's to answer for");
  });
});

test("#2305: a HEAD that is not a merge commit is UNREADABLE, never a diff of only its last commit", () => {
  withGitSandbox(({ dir, run, commit }) => {
    mergedPullRequest(dir, run, commit);
    run(["checkout", "-q", "pr"]);
    run(["remote", "add", "origin", dir]); // so the deepening fetch succeeds and the merge test is what refuses
    const reading = changedFilesOfThisPullRequest(dir);
    assert.equal(reading.ok, false, "a non-merge HEAD is never read as the PR's diff");
    assert.match((reading as { why: string }).why, /not a merge commit/);
  });
});

test("#2305: `main()` is WIRED -- the job exits 1 on a missing record and 0 once it is written", () => {
  withGitSandbox(({ dir, run, commit }) => {
    mergedPullRequest(dir, run, commit);
    const job = (body: string) => spawnSync("node",
      [new URL("../acceptance-commands.mjs", import.meta.url).pathname],
      { cwd: dir, encoding: "utf8", env: sandboxGitEnv({ PR_BODY: body }) });
    const base = "Acceptance: none \u2014 the test is the check\n\nCloses: none \u2014 test\n";
    const missing = job(base);
    assert.equal(missing.status, 1, missing.stdout + missing.stderr);
    assert.match(missing.stdout, /MUTATION: MISSING/);
    const written = job(`${base}\nMutation: none \u2014 a fixture rename\n`);
    assert.equal(written.status, 0, written.stdout + written.stderr);
    assert.match(written.stdout, /MUTATION: NONE/);
  });
});

// #2308: a number in a PR body sits under `## Measured`, with its command and what it printed.
const FENCE = "```";
const measuredBody = (inside: string) => `Closes #1\n\n## Measured\n\n${FENCE}\n${inside}\n${FENCE}\n\n## What changes\n`;

test("#2308: THE ROW'S OWN FAILING TEST -- a `## Measured` fence with a command and no output is MALFORMED, and one with the output pasted passes", () => {
  const bare = measuredSectionReport(measuredBody("$ gh pr list --state merged | wc -l"));
  assert.equal(bare.ok, false);
  assert.match(bare.line, /^MEASURED: MALFORMED/);
  const pasted = measuredSectionReport(measuredBody("$ gh pr list --state merged | wc -l\n25"));
  assert.deepEqual(pasted, { ok: true, line: "MEASURED: RECORDED" });
});

test("#2308: the absence of the section is not a refusal -- it is the reviewer's cue that nothing is claimed", () => {
  for (const body of ["Closes #1\n\n25 merged pull requests", "", null, undefined]) {
    const report = measuredSectionReport(body);
    assert.equal(report.ok, true, `${JSON.stringify(body)} must pass`);
    assert.match(report.line, /^MEASURED: NOT DECLARED/);
  }
});

test("#2308: prose under the heading is not a transcript, and neither is output pasted ABOVE its command", () => {
  assert.equal(measuredSectionReport("## Measured\n\n25 merged pull requests, I counted.\n").ok, false);
  assert.equal(measuredSectionReport(measuredBody("25\n$ gh pr list | wc -l")).ok, false,
    "the number sits above the command, which is how a reconstructed transcript looks");
  assert.equal(measuredSectionReport(measuredBody("$ git ls-files\n$ git ls-files | wc -l")).ok, false,
    "two commands in a row printed nothing here");
  assert.equal(measuredSectionReport(`## Measured\n\n$ git ls-files | wc -l\n412\n`).ok, false,
    "an unfenced pair is not the shape the Open-check rule reads");
});

test("#2308: unprompted commands count as commands, as in the Open-check rule", () => {
  assert.equal(measuredSectionReport(measuredBody("git ls-files | wc -l\n412")).ok, true);
  assert.equal(measuredSectionReport(measuredBody("$ echo hi\nhi")).ok, true, "a `$ ` prompt marks any first word");
});

test("#2308: a `# comment` inside the fence does not end the section, and the next heading does", () => {
  const withComment = measuredBody("# the population\n$ git ls-files | wc -l\n412");
  assert.equal(measuredSectionReport(withComment).ok, true);
  const runUnderAnotherHeading = `## Measured\n\nsee below\n\n## Evidence\n\n${FENCE}\n$ git ls-files | wc -l\n412\n${FENCE}\n`;
  assert.equal(measuredSectionReport(runUnderAnotherHeading).ok, false,
    "a transcript under a DIFFERENT heading is not this section's");
});

test("#2308: only the heading declares it -- a `Measured:` prose line, or the template's own comment, does not", () => {
  assert.match(measuredSectionReport("Measured: 25 merged PRs").line, /^MEASURED: NOT DECLARED/);
  assert.match(measuredSectionReport("<!-- put it under\n## Measured\nwith the command -->\n").line, /^MEASURED: NOT DECLARED/);
  assert.equal(measuredSectionReport("### Measured at abc123\n\nnothing").ok, true,
    "a heading that merely begins with the word is another section (`Measured at ...` names no declaration)");
});

test("#2308: two `## Measured` sections fail rather than pick one", () => {
  const twice = `${measuredBody("$ echo a\na")}\n## Measured\n\n${FENCE}\n$ echo b\nb\n${FENCE}\n`;
  const report = measuredSectionReport(twice);
  assert.equal(report.ok, false);
  assert.match(report.line, /^MEASURED: DUPLICATE/);
});

test("#2308: the CLI reads the verdict -- a malformed section exits 1 and prints its line", () => {
  const run = (body: string) => spawnSync(process.execPath, ["packages/agent-org/src/acceptance-commands.mjs"],
    { encoding: "utf8", env: { ...process.env, PR_BODY: body } });
  const bad = run(`Closes #1\n\nAcceptance: none \u2014 nothing to run\n\n${measuredBody("$ git ls-files | wc -l")}`);
  assert.match(bad.stdout, /MEASURED: MALFORMED/);
  assert.equal(bad.status, 1);
  const good = run(`Closes #1\n\nAcceptance: none \u2014 nothing to run\n\n${measuredBody("$ git ls-files | wc -l\n412")}`);
  assert.match(good.stdout, /MEASURED: RECORDED/);
});

// ---------------------------------------------------------------------------------------------------------
// #2192: A `## Region` COPY OF A WRONG ACCEPTANCE PATH VOUCHES FOR IT. Everything is injected -- `exists`,
// `regionEntries`, `trackedDirs`, `trackedFiles` -- so the rule is checked without the repository it runs in;
// the last test in the block reads the real tree, because the row's own defect was on a real path.
// ---------------------------------------------------------------------------------------------------------

const TYPO = "packages/agent-org/src/acceptance-commands.test.ts";
const REAL_TWIN = "packages/lab/src/packaging/acceptance-commands.test.ts";

/** A row whose Region and Acceptance BOTH carry `path` -- the copy-paste shape the row is about. */
function copiedIntoBoth(path: string, extra = "") {
  return `## Region\n\n${FENCE}\n${path}\n${FENCE}\n\n## Acceptance\n\n${FENCE}bash\nnpx tsx --test ${path}\n${FENCE}\n${extra}`;
}
const NOTHING_EXISTS = { exists: () => false, trackedDirs: ["packages"], regionEntries: [TYPO] };

test("#2192: an absent path the Region excuses is REFUSED when a tracked file bears its basename, and the refusal NAMES that file", () => {
  const twins = [REAL_TWIN, "packages/guards/src/unrelated.mjs"];
  const reason = acceptancePathsReason(copiedIntoBoth(TYPO), "row-file", { ...NOTHING_EXISTS, trackedFiles: twins });
  assert.ok(reason, "the copy in the Region must not vouch for a path a tracked file of the same name contradicts");
  assert.ok(reason.includes(REAL_TWIN), "the refusal must name the tracked candidate, not describe it");
  assert.ok(!reason.includes("unrelated.mjs"), "and only the files that bear the name");
  assert.match(reason, /FIX THE SPELLING/, "arm one");
  assert.match(reason, /`New-file: <path>`/, "arm two: the way through for a genuine second file of that name");
  assert.match(reason, /^row-file: /);
});

test("#2192 NEGATIVE CONTROL: a Region-excused absent path whose basename NO tracked file bears still files", () => {
  // A fix that refuses every Region-excused absent path passes the positive test above and fails this one.
  const tracked = [REAL_TWIN, "packages/guards/src/unrelated.mjs"];
  assert.equal(acceptancePathsReason(copiedIntoBoth("packages/agent-org/src/brand-new-file.test.ts"), "row-file",
    { ...NOTHING_EXISTS, regionEntries: ["packages/agent-org/src/brand-new-file.test.ts"], trackedFiles: tracked }), null);
});

test("#2192: the twin is found by BASENAME, never by directory -- a neighbour in the same directory is no twin", () => {
  // MUTATION TARGET. Match on the absent path's DIRECTORY instead and this control fires while the
  // different-directory refusal above goes quiet: the misremembered thing is the directory itself.
  const sameDirectoryOtherName = ["packages/agent-org/src/some-other-module.test.ts"];
  assert.equal(acceptancePathsReason(copiedIntoBoth(TYPO), "row-file",
    { ...NOTHING_EXISTS, trackedFiles: sameDirectoryOtherName }), null);
});

test("#2192: `New-file: <path>` declares the intent, and only for the path it names", () => {
  const tracked = [REAL_TWIN];
  const declared = copiedIntoBoth(TYPO, `\nNew-file: ${TYPO}\n`);
  assert.equal(acceptancePathsReason(declared, "row-file", { ...NOTHING_EXISTS, trackedFiles: tracked }), null,
    "a row really creating a second file of that name says so and files");
  const wrongPath = copiedIntoBoth(TYPO, "\nNew-file: packages/somewhere/else.test.ts\n");
  assert.ok(acceptancePathsReason(wrongPath, "row-file", { ...NOTHING_EXISTS, trackedFiles: tracked }),
    "a declaration for ANOTHER path excuses nothing here");
});

test("#2192: `declaredNewFiles` reads the plain, bold, backticked and reasoned forms, and every line", () => {
  assert.deepEqual(declaredNewFiles("New-file: a/b.ts"), ["a/b.ts"]);
  assert.deepEqual(declaredNewFiles("**New-file:** `a/b.ts`"), ["a/b.ts"]);
  assert.deepEqual(declaredNewFiles("New-file: a/b.ts -- a second reader beside the first"), ["a/b.ts"]);
  assert.deepEqual(declaredNewFiles("x\nNew-file: a/b.ts\n\nNew-file: c/d.ts\n"), ["a/b.ts", "c/d.ts"]);
  assert.deepEqual(declaredNewFiles("a prose mention of New-file: a/b.ts mid-sentence\nNew-file:\n"), [],
    "a bare label, or one that does not open its line, declares nothing");
});

test("#2192: several tracked twins are ALL named -- ambiguity is not guessed at", () => {
  const both = ["packages/a/x.test.ts", "packages/b/x.test.ts"];
  const hits = unresolvedAcceptancePaths(copiedIntoBoth("packages/c/x.test.ts"),
    { ...NOTHING_EXISTS, regionEntries: ["packages/c/x.test.ts"], trackedFiles: both });
  assert.deepEqual(hits.map((hit) => hit.twins), [both]);
});

test("#2192: a path the Region does NOT cover keeps its original refusal, and the two halves can appear together", () => {
  const body = `## Region\n\n${FENCE}\n${TYPO}\n${FENCE}\n\n## Acceptance\n\n${FENCE}bash\n`
    + `npx tsx --test ${TYPO} packages/agent-org/src/typo-not-declared.test.ts\n${FENCE}\n`;
  const reason = acceptancePathsReason(body, "row-file", { ...NOTHING_EXISTS, trackedFiles: [REAL_TWIN] })!;
  assert.match(reason, /neither exist in this checkout nor appear in this row's `## Region`: `packages\/agent-org\/src\/typo-not-declared\.test\.ts`/);
  assert.match(reason, /excused only by this row's own `## Region`/);
});

test("#2192: a path that EXISTS is never refused for having a twin", () => {
  assert.equal(acceptancePathsReason(copiedIntoBoth(TYPO), "row-file",
    { ...NOTHING_EXISTS, exists: () => true, trackedFiles: [REAL_TWIN] }), null);
});

test("#2192: on the REAL tree, #2068's own body is refused and names the real test file", () => {
  assert.ok(existsSync(REAL_FILE), "this test reads the real tree with repo-relative paths, so it runs from the repository root");
  assert.ok(!existsSync(TYPO), "the typo is only a control while the file is genuinely absent");
  const reason = acceptancePathsReason(copiedIntoBoth(TYPO), "row-file", { regionEntries: [TYPO] });
  assert.ok(reason?.includes(REAL_TWIN));
});

/**
 * #2175: THE ROW'S OWN ANSWER TO "Does the acceptance need the fleet or the lab?" IS READ, AND ONLY WHEN IT
 * IS UNAMBIGUOUS.
 *
 * The forms below are the ones the filed population uses -- measured 2026-09-25 over the 400 most recent
 * rows (151 carry the section): the template's own three dropdown lines, a bold-led `**No.**`, and the
 * `**Neither.**` / `**Both**` / `The lab only` prose the template does not offer. NAMED, not inferred: the
 * first word decides, from a short list somebody chose, because a reader that guesses at prose is the
 * lane deriver's own defect (#1241) moved one section along.
 */
const FLEET_HEADING = "## Does the acceptance need the fleet or the lab?\n\n";

test("#2175: a leading No/Neither reads as no, and a leading Yes/Both reads as yes, in every form the population uses", () => {
  const declared = {
    "No — completable offline, start now": "no",
    "**No.** Everything is driven through injected seams.": "no",
    "No. One source file and its test, both offline.": "no",
    "**Neither.** The change is to the evaluator and its unit tests.": "no",
    "Yes — cannot start until the orchestrator frees a worker": "yes",
    "**Yes: one guest.** orchestrator's to run.": "yes",
    "**Both, and in that order.** Clause 1 needs a CAPTURE.": "yes",
    "no": "no",
  } as const;
  for (const [answer, expected] of Object.entries(declared)) {
    assert.equal(declaredFleetAnswer(`${FLEET_HEADING}${answer}\n`), expected, answer);
  }
});

test("#2175: anything that is not an unambiguous No or Yes is UNDECLARED, never guessed at", () => {
  // The positive control for every null below is the previous test: the same reader, over the same
  // heading, answers `no` and `yes` for the forms that ARE unambiguous.
  const undeclared = [
    "Partly — offline step given above, fleet step named as what remains",
    "The lab only -- `training:generate` touches no worker.",
    "**It needs the corpus and the scorer, not a Windows worker.**",
    "Reading which fields are affected does not (this row's evidence is offline).",
    "Not applicable.",
    "Nobody reaches a worker from this row.",
    "No-op on the fleet, real on the lab.",
    "None.",
    "",
  ];
  for (const answer of undeclared) {
    assert.equal(declaredFleetAnswer(`${FLEET_HEADING}${answer}\n`), null, JSON.stringify(answer));
  }
});

test("#2175: the answer is read from ITS section only -- a body without the section, or with the answer under another heading, is undeclared", () => {
  assert.equal(declaredFleetAnswer("## Acceptance\n\n```\nnpx rstest run\n```\n"), null, "no section at all");
  assert.equal(declaredFleetAnswer(`${FLEET_HEADING}## Open-check\n\nNo.\n`), null,
    "an empty section is not answered by the `No.` under the NEXT heading");
  assert.equal(declaredFleetAnswer("## Acceptance\n\nNo. This is the Acceptance and not the question.\n"), null,
    "a `No.` elsewhere in the body is not the declaration");
  assert.equal(declaredFleetAnswer("## Does the acceptance need the fleet or the lab\n\nYes.\n"), "yes",
    "and the heading without its question mark is still the heading -- the control for the nulls above");
  assert.equal(declaredFleetAnswer(undefined as unknown as string), null, "an absent body is undeclared, never a crash");
});

// ---- #3026: `cd <dir> && <runner> <file>` -- the directory is a `cd` argument, never a file to read -------

// The fixtures' directories are throwaway temp directories, not the control plane's checkout, so the command is
// assembled here rather than written as a literal `cd <dir>` that `control-plane-checkout-is-one-fact.test.ts`
// reads as a second spelling of the checkout.
const afterCd = (dir: string, command: string) => ["cd", dir, "&&", command].join(" ");

test("#3026: classifyCommand does not throw on `cd <dir> && tsx --test <file>` -- the `cd` target was read as a "
  + "test file, and a directory that exists reached readFileSync (EISDIR)", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-3026-"));
  try {
    const file = "packages/lab/src/packaging/host-units.test.ts";
    for (const command of [
      afterCd(dir, `pnpm exec tsx --test ${file}`),
      afterCd(process.cwd(), `pnpm exec tsx --test ${file}`),
      afterCd(tmpdir(), `pnpm exec tsx --test ${file}`),
      afterCd(`"${dir}"`, `npx rstest run --include ${file}`),
      `pnpm exec tsx --test ${file}`,
    ]) {
      assert.doesNotThrow(() => classifyCommand(command), command);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#3026: a directory is no entry to walk -- deriveClosureRequirements and the requirement readers return "
  + "nothing for one, where a missing path and a directory used to differ by a throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-3026-"));
  try {
    assert.deepEqual(deriveClosureRequirements(dir), []);
    assert.deepEqual(deriveClosureRequirements(join(dir, "missing.test.ts")), []);
    assert.deepEqual(unmetClosureRequirements(dir, NO_CAPABILITIES), []);
    assert.deepEqual(unmetCommandRequirements(`npx rstest run --include ${dir}/x.test.ts`, NO_CAPABILITIES), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#3026 positive control: the file after a `cd` is the file the command runs -- resolved against the `cd` "
  + "target and still charged its declared and derived requirements, so `returns nothing` is not `finds nothing`", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-3026-"));
  try {
    writeFileSync(join(dir, "needs-history.test.mjs"), "// requires: history\nexport {};\n");
    const absolute = join(dir, "needs-history.test.mjs");
    for (const command of [
      afterCd(dir, "npx tsx --test needs-history.test.mjs"),
      afterCd(`"${dir}"`, "npx rstest run --include needs-history.test.mjs"),
      `npx tsx --test ${absolute}`,
    ]) {
      assert.deepEqual(unmetCommandRequirements(command, NO_CAPABILITIES),
        [{ requirement: "history", files: [absolute] }], command);
    }
    const [hit] = deriveClosureRequirements(BOARD_STYLE_FIXTURE);
    assert.equal(hit.requirement, "token", "a real file entry's closure charge is still found");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#3026: the `cd` target is an argument to `cd`, never a test file -- even when it names a file that would "
  + "be charged, so the strip is pinned by itself and not only by the isFile backstop", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-3026-"));
  try {
    const decoy = join(dir, "decoy.test.mjs");
    writeFileSync(decoy, "// requires: history\nexport {};\n");
    assert.deepEqual(unmetCommandRequirements(afterCd(decoy, "npx tsx --test missing.test.mjs"), NO_CAPABILITIES), []);
    assert.deepEqual(unmetCommandRequirements(`npx tsx --test ${decoy}`, NO_CAPABILITIES),
      [{ requirement: "history", files: [decoy] }], "positive control: the same file as an argument IS charged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#3026: the runner's own prefix is no file argument -- `pnpm exec tsx --test <file>` resolves exactly as "
  + "`npx tsx --test <file>` does, and a file that is missing is still reported", () => {
  const file = new URL(import.meta.url).pathname; // this file: it exists wherever the tool is checked out
  for (const prefix of ["pnpm exec", "npx", "NODE_ENV=test pnpm exec"]) {
    assert.deepEqual(testFileArgumentsResolve(`${prefix} tsx --test ${file}`), { ok: true }, prefix);
    assert.deepEqual(testFileArgumentsResolve(`${prefix} tsx --test ${file} nothing-here.test.ts`),
      { ok: false, missing: ["nothing-here.test.ts"] }, `${prefix}: positive control`);
  }
});

// ---- #3058: a leading `cd <dir> &&` is skipped by the first-token reading, so the TAIL is what is classified ---

// `cd`'s own exit code proves nothing; the command after the `&&` is the thing that runs. Every tail below is
// classified bare AND behind a `cd`, because "unchanged" is a reading to be made, not an absence to be assumed.
const knownTools = new Set(["node", "npm", "echo"]);
const exists = (token: string) => knownTools.has(token);
const classifyBehindCd = (tail: string, deps: Parameters<typeof classifyCommand>[1] = {}) => ({
  bare: classifyCommand(tail, { commandExists: exists, ...deps }),
  behindCd: classifyCommand(afterCd(tmpdir(), tail), { commandExists: exists, ...deps }),
});

test("#3058: a runnable tail is runnable behind a `cd`, exactly as the bare line is", () => {
  for (const tail of ["node --test x.test.ts", "npm run lint", "FOO=1 node --test x.test.ts"]) {
    const { bare, behindCd } = classifyBehindCd(tail);
    assert.deepEqual(bare, { verdict: "runnable" }, `positive control, the bare line: ${tail}`);
    assert.deepEqual(behindCd, bare, tail);
  }
  assert.deepEqual(classifyCommand(afterCd(`"${tmpdir()}"`, "node --test x.test.ts"), { commandExists: exists }),
    { verdict: "runnable" }, "a quoted directory is the same leading `cd`");
});

test("#3058: a refused tail keeps its refusal behind a `cd` -- the fleet, the corpus and the missing credential", () => {
  const noToken = { capabilities: NO_CAPABILITIES };
  for (const [tail, deps] of [
    ["npm run fleet:status", {}],
    ["npm run gate:stability", {}],
    ["gh pr view 1", noToken],
  ] as const) {
    const { bare, behindCd } = classifyBehindCd(tail, deps);
    assert.equal(bare.verdict, "refused", `positive control, the bare line: ${tail}`);
    assert.deepEqual(behindCd, bare, tail);
  }
});

test("#3058: a prose tail is prose behind a `cd`, and the reason names the TAIL's token, never `cd`", () => {
  for (const [tail, reason] of [
    ["echo done", "cannot verify anything -- `echo`'s exit code says nothing about whether the claim in this line is true"],
    ["nonexistent-tool --flag", 'is not a command (no executable "nonexistent-tool")'],
  ]) {
    const { bare, behindCd } = classifyBehindCd(tail);
    assert.deepEqual(bare, { verdict: "prose", reason }, `positive control, the bare line: ${tail}`);
    assert.deepEqual(behindCd, bare, tail);
    assert.doesNotMatch(behindCd.verdict === "prose" ? behindCd.reason : "", /"cd"/);
  }
});

test("#3058: only a LEADING `cd <dir> &&` is skipped -- a mid-line `cd`, a `;`, and a `cd` with no `&&` are unchanged", () => {
  const dir = tmpdir();
  for (const [line, token] of [
    [`true; cd ${dir}`, "true"], // the first token is `true`, as before: not a `cd` at all
    [`cd ${dir} ; node --test x.test.ts`, "cd"], // `;` is no `&&`: the line still starts with a builtin
    [`cd ${dir}`, "cd"], // a `cd` with nothing after it
    [`cd ${dir} || node --test x.test.ts`, "cd"],
  ]) {
    const got = classifyCommand(line, { commandExists: exists });
    assert.equal(got.verdict, "prose", line);
    assert.match(got.verdict === "prose" ? got.reason : "", new RegExp(`\`?"?${token}"?\`?`), line);
  }
  // The skip is once: a second `cd` is the first token of what remains, which is the unchanged reading.
  const twice = classifyCommand(afterCd(dir, afterCd(dir, "node --test x.test.ts")), { commandExists: exists });
  assert.equal(twice.verdict, "prose");
  assert.match(twice.verdict === "prose" ? twice.reason : "", /"cd"/);
});
