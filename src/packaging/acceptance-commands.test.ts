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

import {
  classifyCommand, extractAcceptanceSection, acceptanceReport, testFileArgumentsResolve,
} from "../../../../scripts/acceptance-commands.mjs";

// A file known to exist, relative to the repo root -- where every real invocation of this command runs
// from. This test file names itself, so it cannot go stale independently of being renamed.
const REAL_FILE = "packages/lab/src/packaging/acceptance-commands.test.ts";

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
