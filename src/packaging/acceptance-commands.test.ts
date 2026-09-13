/**
 * NOTHING HAS EVER RUN A ROW'S ACCEPTANCE COMMAND -- pipeline unit 2, #353. Every PR body carries an
 * `Acceptance:` line; the only thing that has ever executed it is the author, reporting in prose.
 *
 * Three outcomes, and the tests below exist because they must never collapse into two: RAN (the command
 * actually executed, exit code is the verdict), REFUSED (needs the fleet/lab/runs/, named, never gates),
 * MISSING (no acceptance line at all -- must FAIL, never read as a pass).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyCommand, extractAcceptanceSection, acceptanceReport, testFileArgumentsResolve,
  testFileRequirements, unmetRequirements, unmetCommandRequirements,
  hasFullHistoryDeclaration, jobCapabilities,
  deriveClosureRequirements, closureRequirementMessage, unmetClosureRequirements,
  unmetCommandClosureRequirements,
  runsTheWholeSuite,
  suiteTestFiles
} from "../../../../scripts/acceptance-commands.mjs";

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
// imported from `scripts/board-document.mjs`, is what actually shells out. The header-only mechanism
// (#510) cannot see this file; the closure-derived one is built specifically because it must.
//
// board-style.test.ts (the ORIGINAL worked example, via `collect()` in `scripts/board-data.mjs`) retired
// 2026-09-10 in guard triage 4 of 6 (#906) -- this file has the identical shape (no header, reaches `gh`
// only through a local import) and survives that row. Values below re-derived directly from
// `deriveClosureRequirements`/`closureRequirementMessage` against this fixture, not carried over from the
// old one.
const BOARD_STYLE_FIXTURE = "packages/lab/src/packaging/board-document-chrome-resolver.test.ts";
const NO_TOKEN = { history: true, token: false, fleet: true, corpus: true };
const WITH_TOKEN = { history: true, token: true, fleet: true, corpus: true };

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

test("classifyCommand: a command that merely MENTIONS a banned word without the pattern is still runnable", () => {
  // `worker-fleet` contains "worker" but not the `worker:` script-name shape this bans.
  assert.deepEqual(classifyCommand("npx tsx --test packages/worker-fleet/src/cli-flags.test.ts"),
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
  // resolveChromeBinary -> board-document.mjs:1204") -- never the full repo-relative path
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
// only transitively, through `resolveChromeBinary()` in scripts/board-document.mjs -- the fourth instance
// in two days of exactly this shape (#382), and the whole reason #510's header alone could never catch
// it: an opt-in declaration cannot catch the file whose author did not know there was something to
// declare. (Original worked example, board-style.test.ts via `collect()`, retired 2026-09-10 -- #906.) ---

test("#621 deriveClosureRequirements: board-document-chrome-resolver.test.ts reaches `gh` transitively, "
  + "via `resolveChromeBinary`, at the real line `board-document.mjs` spawns it on", () => {
  const hits = deriveClosureRequirements(BOARD_STYLE_FIXTURE);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].requirement, "token");
  assert.equal(hits[0].file.endsWith("scripts/board-document.mjs"), true);
  assert.equal(hits[0].line, 1204, "board-document.mjs's own execFileSync(\"gh\", ...) call site -- if "
    + "this moves, the fixture line below must move with it");
});

test("#621 closureRequirementMessage: the EXACT worked example from the issue, naming the hop -- "
  + "\"this test needs a token\" sends a reader to the test; naming the module that spawns `gh` sends "
  + "them to the cause", () => {
  const [hit] = deriveClosureRequirements(BOARD_STYLE_FIXTURE);
  assert.equal(closureRequirementMessage(hit),
    "board-document-chrome-resolver.test.ts requires token via resolveChromeBinary → board-document.mjs:1204");
});

test("#621 unmetClosureRequirements: refused against a job with no token, satisfied against one that "
  + "has it", () => {
  assert.deepEqual(
    unmetClosureRequirements(BOARD_STYLE_FIXTURE, NO_TOKEN).map((u) => u.requirement),
    ["token"]);
  assert.deepEqual(unmetClosureRequirements(BOARD_STYLE_FIXTURE, WITH_TOKEN), []);
});

test("#621 unmetCommandClosureRequirements: a non-`tsx --test` command is never inspected", () => {
  assert.deepEqual(unmetCommandClosureRequirements("npm run lint", NO_TOKEN), []);
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
    /board-document-chrome-resolver\.test\.ts requires token via resolveChromeBinary → board-document\.mjs:1204/);
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
  const hits = deriveClosureRequirements("scripts/local-import-closure.mjs");
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
 * union of requirements empty, `npm test` reads as needing nothing, and the gate passes having examined
 * nothing -- the failure this whole mechanism exists to prevent, reintroduced one layer up.
 *
 * `suiteTestFiles` throws rather than returning `[]` for the same reason, and this proves the glob it
 * reads out of `package.json` actually resolves against this tree.
 */
test("the suite population is real -- a floor, because every check above passes vacuously over an empty one", () => {
  const files = suiteTestFiles();
  assert.ok(files.length >= 300,
    `only ${files.length} test file(s) found; \`test:ts\` itself asserts --min=300, so fewer means the `
    + "glob no longer resolves and this gate is answering about a population it never examined");
  assert.ok(files.some((f: string) => f.endsWith("row-claim-live.test.ts")),
    "the file whose token requirement started this must be IN the population, or the gate cannot have "
    + "caught it");
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

test("EXECUTED NOTHING FAILS: every command refused and none run is the absence of an answer, not a pass", () => {
  const caps = { history: false, token: false, fleet: false, corpus: false };
  const report = acceptanceReport(
    "Acceptance: npx tsx --test packages/lab/src/packaging/row-claim-live.test.ts", () => 0,
    { capabilities: caps });
  assert.equal(report.ok, false);
  assert.ok(report.lines.some((l) => l.startsWith("ACCEPTANCE: EXECUTED NOTHING")),
    "the verdict must be its own line, not a modifier on the refusal -- a reader scanning for a failure "
    + "reads line starts");
  assert.match(report.lines.join("\n"), /no token, no fleet and no corpus/,
    "and it must say what this job cannot do, or the author reads it as the tool being broken");
});

test("A REFUSED LINE PASSES ONLY BESIDE A RAN LINE -- refusing one named file while another actually "
  + "runs is a partial answer; refusing every one is no answer at all", () => {
  const caps = { history: false, token: false, fleet: false, corpus: false };
  const mixed = acceptanceReport(
    'Acceptance:\nnpx tsx --test packages/lab/src/packaging/row-claim-live.test.ts\n'
    + 'node -e "process.exit(0)"\n', () => 0, { capabilities: caps });
  assert.equal(mixed.ok, true, "one command ran, so the section examined something");
  assert.ok(!mixed.lines.some((l) => l.startsWith("ACCEPTANCE: EXECUTED NOTHING")));
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
  const report = acceptanceReport(
    'Acceptance:\nnode -e "process.exit(0)"\n'
    + "Refutation:\nnpx tsx --test packages/lab/src/packaging/row-claim-live.test.ts\n", () => 0,
    { capabilities: caps });
  assert.equal(report.ok, true);
  assert.ok(!report.lines.some((l) => /EXECUTED NOTHING/.test(l)));
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

test("#967 KNOWN LIMITATION, asserted so a future fix has something to flip: one hop through a local helper", () => {
  // `syntactically at the module top level` and `executed by an import` are DIFFERENT properties, and this
  // is where they part. A top-level call into a local helper whose BODY calls the corpus reader really is
  // executed at import time, and a top-level scan cannot see it: the helper's body is blanked, and the
  // top-level call names the helper rather than the function being looked for.
  //
  // Full reachability is a bigger question than this row (it is #827's unsolved half, one requirement
  // over). This records the miss AS A FAILING CASE RATHER THAN A PARAGRAPH: when someone fixes it, this
  // test tells them by going red — the opposite of a comment naming an ambiguity above code that resolves
  // it by assumption.
  const dir = tempFixture({
    "indirect.mjs": `function helper() { return ${CORPUS_FN}(); }\n`
      + `export function ${CORPUS_FN}() { return 1; }\nexport const ROOT = helper();\n`,
    "entry.test.ts": 'import { ROOT } from "./indirect.mjs";\nvoid ROOT;\n',
  });
  try {
    assert.deepEqual(deriveClosureRequirements(join(dir, "entry.test.ts")), [],
      "IF THIS FAILS, the walk has learned to follow a top-level call into a local helper -- which is the "
      + "fix, not a regression. Delete this test and say so in the row that did it.");
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
    chain: ["packages/lab/src/packaging/merge-guard.test.ts", "scripts/merge-guard.mjs"] };
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
// `node scripts/tree-wide-guards.mjs | xargs npx tsx --test`, and the runner reported
// `fail (matched no file: node, |, xargs)` -- a claim about the filesystem, and a false one. `|` is not
// a filename at all, and a reader following that message goes looking for missing test files.
//
// #419 closed the BACKTICK form and the pipe form was never considered; #727 is the first acceptance
// command in the repository to contain a pipe. The REFUSAL is correct -- a guard that cannot verify a
// line must not pass it. What was wrong is what it said.

test("#728: a piped line is REFUSED as unparseable, never reported as missing files", () => {
  const result = testFileArgumentsResolve("node scripts/tree-wide-guards.mjs | xargs npx tsx --test");
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
  assert.deepEqual(testFileArgumentsResolve("npx tsx --test scripts/acceptance-commands.mjs"), { ok: true },
    "and a real file must still pass");
});

test("#728: an ordinary command with no relocating construct is untouched", () => {
  // The list is the constructs that RELOCATE the arguments, not everything unfamiliar. A guard that
  // refused what it did not recognise would refuse every ordinary command the moment a flag was added.
  assert.deepEqual(testFileArgumentsResolve("npx tsx --test --test-concurrency=4 scripts/acceptance-commands.mjs"),
    { ok: true });
  assert.deepEqual(testFileArgumentsResolve("npm run lint"), { ok: true },
    "and a line with no `tsx --test` is never inspected at all");
});
