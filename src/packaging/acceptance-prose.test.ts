/**
 * #446: THE ACCEPTANCE RUNNER EXECUTES PROSE.
 *
 * `classifyCommand` used to refuse only fleet/lab/corpus patterns and hand everything else to
 * `/bin/bash` -- a DENYLIST, so a prose summary line under `Acceptance:` ran as a shell command.
 * `worker-config` hit the LUCKY outcome on #435: a prose line whose first word was not a real command
 * exited 127. The unlucky outcome is worse and silent: `echo full suite green, 3306 pass 0 fail` is a
 * REAL command, exits 0, and the job reports a green acceptance that ran no tests at all -- this
 * repository's signature failure, arriving through the one job whose entire purpose is proving a PR's
 * claims.
 *
 * The fix adds a THIRD `Classification` verdict, `"prose"`, for a line that is not a command at all --
 * either its first real token resolves to no executable anywhere, or it resolves to one of a small set
 * of builtins (`echo`, `true`, `:`, `test`, `time`, `[`) whose exit code can never verify anything.
 * `commandExists` is injectable so these tests never depend on what happens to be installed on whichever
 * machine runs the suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyCommand, acceptanceReport } from "../../../../scripts/acceptance-commands.mjs";

/** A fake `commandExists` that only ever finds the named tokens -- deterministic, independent of $PATH. */
function onlyResolves(...names: string[]) {
  return (token: string) => names.includes(token);
}

// --- classifyCommand: the "prose" verdict, THE MEASUREMENT ITSELF ---

test("classifyCommand: THE MEASUREMENT -- a prose summary line is prose, not runnable", () => {
  const result = classifyCommand("full suite green, 3306 pass 0 fail", { commandExists: onlyResolves() });
  assert.equal(result.verdict, "prose");
  assert.match((/** @type {{reason: string}} */ (result)).reason, /no executable "full"/);
});

test('classifyCommand: THE MEASUREMENT -- "the guard bites" is prose, no executable "the"', () => {
  const result = classifyCommand("the guard bites", { commandExists: onlyResolves() });
  assert.equal(result.verdict, "prose");
  assert.match((/** @type {{reason: string}} */ (result)).reason, /no executable "the"/);
});

test("classifyCommand: a real, resolvable command is still runnable", () => {
  const result = classifyCommand("npx tsx --test packages/lab/src/packaging/foo.test.ts",
    { commandExists: onlyResolves("npx") });
  assert.deepEqual(result, { verdict: "runnable" });
});

// --- the second half: a real executable that cannot verify anything ---

test("classifyCommand: THE ECHO CASE -- a real executable command, flagged because it cannot verify anything", () => {
  const result = classifyCommand("echo full suite green, 3306 pass 0 fail", { commandExists: onlyResolves("echo") });
  assert.equal(result.verdict, "prose", "echo IS a real executable -- command -v alone would call this runnable");
  assert.match((/** @type {{reason: string}} */ (result)).reason, /cannot verify anything/);
});

test("classifyCommand: every named unverifiable builtin is caught, not just echo", () => {
  for (const builtin of ["echo", "true", ":", "test", "time", "["]) {
    const result = classifyCommand(`${builtin} something`, { commandExists: onlyResolves(builtin) });
    assert.equal(result.verdict, "prose", `${builtin} must be flagged`);
    assert.match((/** @type {{reason: string}} */ (result)).reason, /cannot verify anything/, builtin);
  }
});

test("classifyCommand: `:` alone (no arguments) is still caught -- the exit-0-silently case", () => {
  const result = classifyCommand(":", { commandExists: onlyResolves(":") });
  assert.equal(result.verdict, "prose");
});

// --- a leading VAR=value assignment is not the command, and must not be misread as prose ---

test("classifyCommand: a leading VAR=value assignment is skipped when finding the real command", () => {
  const result = classifyCommand('A11Y_ALLOW_ARMED_PUSH="deliberate" git push',
    { commandExists: onlyResolves("git") });
  assert.deepEqual(result, { verdict: "runnable" },
    "the assignment itself must never be looked up as if it were the executable");
});

test("classifyCommand: MULTIPLE leading assignments are all skipped", () => {
  const result = classifyCommand("GH_TOKEN=x PYTHONDONTWRITEBYTECODE=1 pytest -q",
    { commandExists: onlyResolves("pytest") });
  assert.deepEqual(result, { verdict: "runnable" });
});

test("classifyCommand: a bare assignment with NOTHING after it is prose (no real token at all)", () => {
  const result = classifyCommand("A11Y_ALLOW_ARMED_PUSH=\"deliberate\"", { commandExists: onlyResolves() });
  assert.equal(result.verdict, "prose");
});

// --- fleet/lab/corpus refusals still take priority -- a real executable that this job must not run ---

test("classifyCommand: fleet/lab/corpus patterns are still REFUSED, never reclassified as prose", () => {
  // `npm` genuinely resolves -- the existing refusal must fire before the executable check ever runs.
  const result = classifyCommand("npm run fleet:deploy", { commandExists: onlyResolves("npm") });
  assert.equal(result.verdict, "refused");
});

// --- acceptanceReport: THE COMPOSED VERDICT, never running a prose line ---

test("acceptanceReport: THE MEASUREMENT, composed -- a prose Acceptance: line is ok:false and never run", () => {
  let called = false;
  const report = acceptanceReport("Acceptance: full suite green, 3306 pass 0 fail",
    () => { called = true; return 0; }, { commandExists: onlyResolves() });
  assert.equal(report.ok, false);
  assert.equal(called, false, "a prose line must never reach the real runner");
  assert.match(report.lines[0], /^ACCEPTANCE: "full suite green, 3306 pass 0 fail" is not a command/);
});

test("acceptanceReport: THE ECHO CASE, composed -- a bare echo under Acceptance does NOT produce ok:true", () => {
  let called = false;
  const report = acceptanceReport("Acceptance: echo full suite green, 3306 pass 0 fail",
    () => { called = true; return 0; }, { commandExists: onlyResolves("echo") });
  assert.equal(report.ok, false, "this is the exact defect #446 measured: echo exits 0 and used to read as a pass");
  assert.equal(called, false, "echo's own exit code must never be trusted as a verdict");
  assert.match(report.lines[0], /cannot verify anything/);
});

test("acceptanceReport: a real command is UNAFFECTED -- still runs, still decides the verdict by its exit code", () => {
  let seen = "";
  const report = acceptanceReport('Acceptance: node -e "process.exit(0)"',
    (cmd) => { seen = cmd; return 0; }, { commandExists: onlyResolves("node") });
  assert.equal(report.ok, true);
  assert.equal(seen, 'node -e "process.exit(0)"');
  assert.match(report.lines[0], /^ACCEPTANCE: RAN/);
});

test("acceptanceReport: a prose Refutation: line is caught the same way as an Acceptance: one", () => {
  const body = 'Acceptance: node -e "process.exit(0)"\nRefutation: it definitely refuses';
  let refutationCalled = false;
  const report = acceptanceReport(body, (cmd) => {
    if (cmd.includes("refuses")) refutationCalled = true;
    return 0;
  }, { commandExists: onlyResolves("node") });
  assert.equal(report.ok, false, "a prose Refutation line is exactly as unsupported a claim as a prose Acceptance one");
  assert.equal(refutationCalled, false);
  assert.match(report.lines[1], /^REFUTATION: "it definitely refuses" is not a command/);
});

test("acceptanceReport: prose and a real failing command together -- both are reported, both fail the report", () => {
  const body = "Acceptance:\nfull suite green\nnode -e \"process.exit(1)\"\n";
  const report = acceptanceReport(body, () => 1, { commandExists: onlyResolves("node") });
  assert.equal(report.ok, false);
  assert.equal(report.lines.length, 2);
  assert.match(report.lines[0], /is not a command/);
  assert.match(report.lines[1], /^ACCEPTANCE: RAN .* -> fail/);
});

// --- MUTATION TARGET: documents the exact regression this row exists to prevent ---

test("MUTATION TARGET: without the prose check, a real command-shaped denylist alone cannot see this defect", () => {
  // The pre-#446 shape: only FLEET_LAB_PATTERNS/CORPUS_PATTERNS refuse anything, and neither one's regex
  // has any reason to match ordinary English -- so a denylist-only classifier reads "full suite green,
  // 3306 pass 0 fail" as runnable, precisely the defect this row exists to end.
  const FLEET_LAB_LIKE = [/\bfleet:/, /\blab:/];
  const denylistOnly = (command: string) =>
    FLEET_LAB_LIKE.some((p) => p.test(command)) ? "refused" : "runnable";
  assert.equal(denylistOnly("full suite green, 3306 pass 0 fail"), "runnable",
    "documents why a denylist alone cannot catch this -- nothing about prose matches a fleet/lab pattern");
});
