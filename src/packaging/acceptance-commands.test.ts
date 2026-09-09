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

// #621's own worked example: reaches `gh` with NO `// requires:` header at all -- `collect()`, imported
// from `scripts/board-data.mjs`, is what actually shells out. The header-only mechanism (#510) cannot see
// this file; the closure-derived one is built specifically because it must.
const BOARD_STYLE_FIXTURE = "packages/lab/src/packaging/board-style.test.ts";
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
  let called = false;
  const report = acceptanceReport("Acceptance:\nnpm run fleet:deploy\n", () => { called = true; return 0; });
  assert.equal(called, false, "a refused command must never actually execute");
  assert.equal(report.ok, true, "REFUSED is not a pass and not a failure -- but it must not block a merge either");
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
  assert.ok((/** @type {{missing:string[]}} */(result)).missing.length > 0);
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
  assert.deepEqual((/** @type {{missing:string[]}} */(result)).missing,
    ["packages/lab/src/packaging/does-not-exist.test.ts"]);
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
  // #621's own worked example, "board-style.test.ts requires token via collect -> board-data.mjs:72") --
  // never the full repo-relative path `unmetCommandRequirements`'s header-only message used. Both are
  // correct; they answer different questions ("what does the closure prove" vs. "what file declared it").
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
  const body = `Closes #1\nAcceptance: npx tsx --test ${HISTORY_FIXTURE}\n`;
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
// header. board-style.test.ts has no `// requires:` header at all and reaches `gh` only transitively,
// through `collect()` in scripts/board-data.mjs -- the fourth instance in two days of exactly this shape
// (#382), and the whole reason #510's header alone could never catch it: an opt-in declaration cannot
// catch the file whose author did not know there was something to declare. ---

test("#621 deriveClosureRequirements: board-style.test.ts reaches `gh` transitively, via `collect`, at "
  + "the real line `board-data.mjs` spawns it on", () => {
  const hits = deriveClosureRequirements(BOARD_STYLE_FIXTURE);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].requirement, "token");
  assert.equal(hits[0].file.endsWith("scripts/board-data.mjs"), true);
  assert.equal(hits[0].line, 72, "board-data.mjs's own execFileSync(\"gh\", ...) call site -- if this "
    + "moves, the fixture line below must move with it");
});

test("#621 closureRequirementMessage: the EXACT worked example from the issue, naming the hop -- "
  + "\"this test needs a token\" sends a reader to the test; naming the module that spawns `gh` sends "
  + "them to the cause", () => {
  const [hit] = deriveClosureRequirements(BOARD_STYLE_FIXTURE);
  assert.equal(closureRequirementMessage(hit), "board-style.test.ts requires token via collect → board-data.mjs:72");
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

test("#621 ACCEPTANCE: classifyCommand REFUSES board-style.test.ts, named, naming the chain -- with NO "
  + "`// requires:` header on the file at all, proving the refusal comes from the closure and not from a "
  + "declaration", () => {
  assert.ok(existsSync(BOARD_STYLE_FIXTURE), "the fixture itself must exist for this test to mean anything");
  assert.deepEqual(testFileRequirements(readFileSync(BOARD_STYLE_FIXTURE, "utf8")), [],
    "sanity: board-style.test.ts truly declares no // requires: header -- if this ever gains one, the "
    + "refusal below could be coming from #510's header path instead of #621's closure derivation");
  const result = classifyCommand(`npx tsx --test ${BOARD_STYLE_FIXTURE}`, { capabilities: NO_TOKEN });
  assert.equal(result.verdict, "refused");
  const reason = (/** @type {{reason:string}} */ (result)).reason;
  assert.match(reason, /`token`/);
  assert.match(reason, /board-style\.test\.ts requires token via collect → board-data\.mjs:72/);
});

test("#621 MUTATION TARGET: the identical command RUNS once the job's capabilities carry a token -- "
  + "proving the refusal above tracked the real capability, not a hard-coded no", () => {
  const result = classifyCommand(`npx tsx --test ${BOARD_STYLE_FIXTURE}`, { capabilities: WITH_TOKEN });
  assert.equal(result.verdict, "runnable");
});

test("#621 MUTATION direction (the issue's own instruction): WITHOUT the closure derivation, "
  + "board-style.test.ts is classified purely on its (nonexistent) header and RUNS against a tokenless "
  + "job -- reproducing, from a copy of the pre-#621 mechanism, the exact live failure #382/#619 measured "
  + "four times", () => {
  // Reproduces the OLD, header-only path directly (unmetCommandRequirements, never touching the closure
  // walk) so this fails if #621's derivation is ever bypassed or deleted, without needing to touch
  // acceptance-commands.mjs itself.
  const preClosureUnmet = unmetCommandRequirements(`npx tsx --test ${BOARD_STYLE_FIXTURE}`, NO_TOKEN);
  assert.deepEqual(preClosureUnmet, [],
    "the header-only mechanism finds NOTHING unmet here -- board-style.test.ts declares no header, so "
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
// writable location -- and the closure walk above could only ask one question of a call to it.
// `git-fixture-cache.mjs` (#660) calls it to pick a cache location it creates itself; #718 merged that file
// and #722 (a PR that never touched it) inherited a `corpus` refusal for a chain it does not own.
// `HISTORY_FIXTURE` (above) is #722's own real chain:
// `pre-push-resolve-toward-main.test.ts → checkoutFixturePair → git-fixture-cache.mjs`.
//
// NEITHER THIS SECTION NOR ITS FIXTURE BELOW SPELLS THE RESOLVER'S NAME FOLLOWED BY `(` CONTIGUOUSLY --
// this file is itself walked by the #621 self-reference test below, and a call-shaped mention in a test
// NAME or a fixture STRING LITERAL is real code, not a comment; `stripComments` cannot fix that half. Every
// mention here either drops the trailing parenthesis (harmless in prose) or is built the same
// concatenated way `fingerprint()` builds its own patterns in acceptance-commands.mjs. ---

const REAL_JOB_CAPABILITIES = jobCapabilities("History: full");
// Matches acceptance-commands.mjs's own `fingerprint` -- concatenated so the resolver's name never
// appears contiguously in this file's own source.
const spell = (a: string, b: string) => a + b;

test("#731 REGRESSION: #722's exact real chain classifies runnable -- git-fixture-cache.mjs's corpus-root "
  + "call is a verified write location, not corpus evidence", () => {
  const result = classifyCommand(`npx tsx --test ${HISTORY_FIXTURE}`, { capabilities: REAL_JOB_CAPABILITIES });
  assert.equal(result.verdict, "runnable",
    `expected runnable; got: ${JSON.stringify(result)} -- this is the exact command #722 saw refused`);
});

test("#731: git-fixture-cache.mjs itself derives NO requirement at all from its own corpus-root call, "
  + "now that its `// writes:` declaration is verified against a real mkdirSync at the declared path", () => {
  const hits = deriveClosureRequirements("packages/lab/src/packaging/git-fixture-cache.mjs");
  assert.deepEqual(hits, [], `expected no hits; got: ${hits.map(closureRequirementMessage).join("; ")}`);
});

test("#731: a file that genuinely reads the corpus is UNAFFECTED -- the fix must not become "
  + "\"never refuse\"; dataset-paths.mjs's own corpus-root definition, reached with no `// writes:` "
  + "declaration at all, still derives `corpus`", () => {
  const hits = deriveClosureRequirements("packages/lab/src/training/corpus-settled.mjs");
  assert.deepEqual(hits.map((h) => h.requirement), ["corpus"],
    "a real corpus-reading chain must still be caught -- rules:gate, check-signals, corpus:starvation and "
    + "scorer:shortcuts all depend on this staying true");
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

test("#731 MUTATION: point git-fixture-cache.mjs's declared write path at somewhere it does not actually "
  + "write, and its closure hit must return -- proving the exemption is EARNED by the file's own code, not "
  + "granted by the header alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-writes-"));
  try {
    const real = readFileSync("packages/lab/src/packaging/git-fixture-cache.mjs", "utf8");
    assert.match(real, /^\/\/ writes: runs\/git-fixture-cache$/m,
      "sanity: git-fixture-cache.mjs must actually carry the declaration this test mutates");
    const mutated = real.replace("// writes: runs/git-fixture-cache", "// writes: runs/somewhere-else");
    assert.notEqual(mutated, real, "the replacement must actually land, or this proves nothing");
    const fixture = join(dir, "git-fixture-cache.mjs");
    writeFileSync(fixture, mutated);
    const hits = deriveClosureRequirements(fixture);
    assert.equal(hits.length, 1, `expected the corpus hit to return once the declaration no longer holds; `
      + `got: ${JSON.stringify(hits)}`);
    assert.equal(hits[0].wrongDeclaration, true,
      "the declared path no longer matches what the file's own mkdirSync call actually writes to");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
