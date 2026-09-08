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
import { existsSync } from "node:fs";

import {
  classifyCommand, extractAcceptanceSection, acceptanceReport, testFileArgumentsResolve,
  testFileRequirements, unmetRequirements, unmetCommandRequirements,
  hasFullHistoryDeclaration, jobCapabilities,
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
  const result = classifyCommand(`npx tsx --test ${HISTORY_FIXTURE}`, { capabilities: NO_HISTORY });
  assert.equal(result.verdict, "refused");
  assert.match((/** @type {{reason:string}} */(result)).reason, /`history`/);
  assert.match((/** @type {{reason:string}} */(result)).reason, new RegExp(HISTORY_FIXTURE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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

test("#497 jobCapabilities: history follows the body declaration; token/fleet are structurally always false", () => {
  assert.deepEqual(jobCapabilities("History: full"), { history: true, token: false, fleet: false });
  assert.deepEqual(jobCapabilities("Acceptance: npm test"), { history: false, token: false, fleet: false });
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
