/**
 * #438: A GUARD CAN ONLY BE SHOWN TO BITE BY A COMMAND WHOSE SUCCESS IS A NON-ZERO EXIT, and
 * `acceptanceReport` hardcoded `passed = code === 0` -- so #418's own `Acceptance:` line, demonstrating
 * `trunk-revert-guard.mjs` correctly REFUSING a known-bad merge, was reported as this job's own failure
 * for doing exactly what the PR set out to prove.
 *
 * ceo's ruling: a separate `Refutation:` section, sharing `Acceptance:`'s own parser rather than a second
 * dialect (this repo's own reason: that parser has already been fixed five times for forms authors keep
 * writing -- #419, #424, #432 -- and a second one would need every fix again, silently). Every command in
 * it must exit non-zero to pass, and -- the rule that matters most -- a `Refutation:` command that exits 0
 * FAILS the job, because a guard shown NOT to bite is the finding. `npm run mutate` already encodes the
 * identical idea for a mutation check; this is the same verdict applied to a PR body.
 *
 * #516: THAT LAST SENTENCE IS THE TRAP, NOT JUST AN ANALOGY. `npm run mutate`'s own contract is exit 0 =
 * the guard bites -- the OPPOSITE of `Refutation:`'s success-is-non-zero convention this file tests. Naming
 * `mutate` on a `Refutation:` line inverts the verdict, and the dangerous half is silent: a guard that did
 * NOT bite exits 1, which `Refutation:` reads as REFUSED -- the passing state. `classifyCommand` now refuses
 * (parse time, never runs it) rather than misreading it; see `MUTATE_PATTERN` there and the tests below.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractAcceptanceSection, extractRefutationSection, acceptanceReport, classifyCommand,
} from "../../../../scripts/acceptance-commands.mjs";

// --- extractRefutationSection: same parser, a different field name ---

test("extractRefutationSection: no Refutation: line anywhere is MISSING -- and that is fine, it is optional", () => {
  assert.deepEqual(extractRefutationSection("Acceptance:\nnpm test\n"), { kind: "missing" });
});

test("extractRefutationSection: an inline command on the header's own line", () => {
  assert.deepEqual(extractRefutationSection("Refutation: node script.mjs --bad-input"),
    { kind: "commands", commands: ["node script.mjs --bad-input"] });
});

test("extractRefutationSection: a `## Refutation` markdown heading is a header, exactly as `## Acceptance` is", () => {
  const body = "## Refutation\n\nnode script.mjs --bad-input\n";
  assert.deepEqual(extractRefutationSection(body), { kind: "commands", commands: ["node script.mjs --bad-input"] });
});

test("extractRefutationSection: a stated none carries its reason", () => {
  assert.deepEqual(extractRefutationSection("Refutation: none — nothing this PR refuses"),
    { kind: "none", reason: "nothing this PR refuses" });
});

test("extractRefutationSection: a bare Refutation: line ends an in-progress Acceptance: block, "
  + "not swallowed as one more acceptance command", () => {
  const body = "Acceptance:\nnpm test\nRefutation:\nnode script.mjs --bad-input\n";
  assert.deepEqual(extractAcceptanceSection(body), { kind: "commands", commands: ["npm test"] });
  assert.deepEqual(extractRefutationSection(body), { kind: "commands", commands: ["node script.mjs --bad-input"] });
});

// --- #540: DUPLICATE applies to Refutation: too, sharing the one parser with Acceptance: (#438's rule) ---

test("#540 extractRefutationSection: two Refutation: sections are DUPLICATE, not silently the first", () => {
  const body = "Refutation: node a.mjs\n\ntext\n\nRefutation: node b.mjs";
  assert.deepEqual(extractRefutationSection(body), {
    kind: "duplicate",
    occurrences: [
      { line: 1, text: "Refutation: node a.mjs" },
      { line: 5, text: "Refutation: node b.mjs" },
    ],
  });
});

test("#540 acceptanceReport: a DUPLICATE Refutation: fails the job even though Refutation: is otherwise "
  + "optional -- an ambiguous body is not the same as an absent one", () => {
  // NOT `npm test`, since 2026-09-09: a whole-suite command is now REFUSED by the capability gate in a
  // job without the corpus or a token, so it would report REFUSED rather than RAN and this test would be
  // asserting about the capability gate instead of about Refutation:'s ambiguity, which is its subject.
  const body = 'Acceptance: node -e "process.exit(0)"\n\nRefutation: node a.mjs\n\ntext\n\nRefutation: node b.mjs';
  const report = acceptanceReport(body, () => 0);
  assert.equal(report.ok, false);
  assert.ok(report.lines.some((l) => l.startsWith("REFUTATION: DUPLICATE")));
});

test("#540 acceptanceReport: a DUPLICATE Refutation: still reports the Acceptance: result, "
  + "since the two sections are independent facts about the same body", () => {
  // NOT `npm test`, since 2026-09-09: a whole-suite command is now REFUSED by the capability gate in a
  // job without the corpus or a token, so it would report REFUSED rather than RAN and this test would be
  // asserting about the capability gate instead of about Refutation:'s ambiguity, which is its subject.
  const body = 'Acceptance: node -e "process.exit(0)"\n\nRefutation: node a.mjs\n\ntext\n\nRefutation: node b.mjs';
  const report = acceptanceReport(body, () => 0);
  assert.ok(report.lines.some((l) => l.startsWith("ACCEPTANCE: RAN")),
    "the valid Acceptance: section must still run and report, independent of Refutation:'s ambiguity");
});

// --- acceptanceReport: the composed verdict, with Refutation: in the mix ---

test("acceptanceReport: no Refutation: section at all -- no REFUTATION line, ok unaffected", () => {
  const report = acceptanceReport('Acceptance: node -e "process.exit(0)"', () => 0);
  assert.equal(report.ok, true);
  assert.deepEqual(report.lines, ['ACCEPTANCE: RAN node -e "process.exit(0)" -> pass (exit 0)']);
});

test("acceptanceReport: THE #438 PROOF -- a Refutation: command that exits NON-ZERO passes, printed as refused", () => {
  const body = 'Acceptance: node -e "process.exit(0)"\nRefutation: node -e "process.exit(1)"';
  const report = acceptanceReport(body, (cmd) => (cmd.includes('"process.exit(1)"') ? 1 : 0));
  assert.equal(report.ok, true);
  assert.match(report.lines[1], /^REFUTATION: RAN .* -> refused \(exit 1\)$/);
});

test("acceptanceReport: MUTATION TARGET -- a Refutation: command that exits ZERO FAILS the report, "
  + "because a guard shown not to bite is the finding this section exists to catch", () => {
  const body = 'Acceptance: node -e "process.exit(0)"\nRefutation: node -e "process.exit(0)"';
  const report = acceptanceReport(body, () => 0);
  assert.equal(report.ok, false, "an unrefuted Refutation: command must fail the whole report");
  assert.match(report.lines[1], /^REFUTATION: RAN .* -> fail \(did not refuse\) \(exit 0\)$/);
});

test("acceptanceReport: an ordinary Acceptance: command is unaffected in both directions -- "
  + "exit 0 still passes, exit non-zero still fails, exactly as before #438", () => {
  const passing = acceptanceReport('Acceptance: node -e "process.exit(0)"', () => 0);
  assert.equal(passing.ok, true);
  assert.match(passing.lines[0], /-> pass \(exit 0\)$/);

  const failing = acceptanceReport('Acceptance: node -e "process.exit(1)"', () => 1);
  assert.equal(failing.ok, false);
  assert.match(failing.lines[0], /-> fail \(exit 1\)$/);
});

test("acceptanceReport: a stated Refutation: none is ok:true and names the reason, printed as its own line", () => {
  const body = 'Acceptance: node -e "process.exit(0)"\nRefutation: none — nothing this PR refuses';
  const report = acceptanceReport(body, () => 0);
  assert.equal(report.ok, true);
  assert.deepEqual(report.lines[1], "REFUTATION: NONE -> nothing this PR refuses");
});

test("acceptanceReport: a REFUSED Refutation: command (fleet/lab/corpus) never calls run(), "
  + "and does not fail the report on its own", () => {
  let called = false;
  const body = 'Acceptance: node -e "process.exit(0)"\nRefutation:\nnpm run fleet:deploy\n';
  const report = acceptanceReport(body, (cmd) => { if (cmd.includes("fleet")) called = true; return 0; });
  assert.equal(called, false, "a refused refutation command must never actually execute");
  assert.equal(report.ok, true);
  assert.match(report.lines[1], /^REFUTATION: REFUSED npm run fleet:deploy -> /);
});

test("acceptanceReport: Acceptance: MISSING still fails the whole report even when Refutation: is present "
  + "and would otherwise pass -- Acceptance is mandatory, Refutation is not", () => {
  const body = "Refutation: node -e \"process.exit(1)\"";
  const report = acceptanceReport(body, () => 1);
  assert.equal(report.ok, false);
  assert.equal(report.lines[0], "ACCEPTANCE: MISSING");
});

test("acceptanceReport: multiple Refutation: commands, one refused and one not -- "
  + "the unrefused one decides, the refused one is still reported on its own line", () => {
  const body = 'Acceptance: node -e "process.exit(0)"\nRefutation:\n'
    + 'node -e "process.exit(1)"\nnode -e "process.exit(0)"\n';
  const report = acceptanceReport(body, (cmd) => (cmd.includes('"process.exit(1)"') ? 1 : 0));
  assert.equal(report.ok, false);
  assert.equal(report.lines.length, 3);
  assert.match(report.lines[1], /-> refused \(exit 1\)$/);
  assert.match(report.lines[2], /-> fail \(did not refuse\) \(exit 0\)$/);
});

// --- #516: `mutate` on a `Refutation:` line inverts the verdict -- classifyCommand must refuse it ---

test("classifyCommand: MUTATION TARGET -- `npm run mutate` on a Refutation: section is REFUSED, named, "
  + "never treated as a runnable command whose exit code Refutation: could misread (#516's own stated "
  + "acceptance: refused, not runnable)", () => {
  const result = classifyCommand("npm run mutate -- --file=x --mutate='...' --test='...'",
    { section: "REFUTATION" });
  assert.equal(result.verdict, "refused");
  assert.match((/** @type {{reason:string}} */(result)).reason, /inverts the Refutation: verdict/);
});

test("classifyCommand: the identical `mutate` command is untouched on Acceptance: (or with no section at "
  + "all) -- the inversion is specific to Refutation:'s success-is-non-zero convention", () => {
  const command = "npm run mutate -- --file=x --mutate='...' --test='...'";
  assert.deepEqual(classifyCommand(command, { section: "ACCEPTANCE" }), { verdict: "runnable" });
  assert.deepEqual(classifyCommand(command), { verdict: "runnable" });
});

test("classifyCommand: a bare invocation of scripts/mutation-check.mjs is caught the same way, "
  + "not just the npm script alias", () => {
  const result = classifyCommand("node scripts/mutation-check.mjs --file=x --mutate='...' --test='...'",
    { section: "REFUTATION" });
  assert.equal(result.verdict, "refused");
});

test("classifyCommand: a command that merely contains the word MUTATE inside an unrelated path is not "
  + "caught -- the pattern matches the invocation shape, not the bare word", () => {
  assert.deepEqual(classifyCommand("npx tsx --test packages/lab/src/packaging/mutate-fixture.test.ts",
    { section: "REFUTATION" }), { verdict: "runnable" });
});

test("classifyCommand: an already-NEGATED `! npm run mutate ...` is not caught by THIS check -- the "
  + "negation already un-inverts the exit code at the shell level, so this guard exists to catch the "
  + "unnegated collision, not to police the rejected #386/#440 negation idiom. `!` itself is not a real "
  + "executable, so classifyCommand's ordinary logic still calls it prose -- for an unrelated reason, "
  + "never `MUTATE_PATTERN`'s", () => {
  const result = classifyCommand("! npm run mutate -- --file=x --mutate='...' --test='...'",
    { section: "REFUTATION" });
  assert.notEqual(result.verdict, "refused", "the mutate/Refutation refusal must not fire on a negated line");
  assert.doesNotMatch("reason" in result ? result.reason : "", /inverts the Refutation: verdict/);
});

test("acceptanceReport: MUTATION TARGET -- a Refutation: line naming `npm run mutate` is REFUSED and "
  + "never calls run() for THAT command, rather than letting a real exit code be misread. Refused, like "
  + "a fleet/lab/corpus pattern, keeps ok:true -- this is the SAME mechanism, per #516's own acceptance", () => {
  let mutateCalled = false;
  const body = 'Acceptance: node -e "process.exit(0)"\nRefutation:\n'
    + "npm run mutate -- --file=x --mutate='...' --test='...'\n";
  const report = acceptanceReport(body, (cmd) => {
    if (cmd.includes("mutate")) { mutateCalled = true; return 1; }
    return 0;
  });
  assert.equal(mutateCalled, false, "a refused refutation command must never actually execute");
  assert.equal(report.ok, true, "a REFUSED command is an honest \"not this job's to judge by\", like fleet/lab/corpus");
  assert.match(report.lines[1], /^REFUTATION: REFUSED npm run mutate .* -> inverts the Refutation: verdict/);
});

/**
 * AND `pr:open` MEETS THE AUTHOR BEFORE CI DOES, with NO SECOND PARSER: `checkBody` already calls
 * `acceptanceReport`, and `jobCapabilities` already describes the JOB (`token`/`fleet`/`corpus` false
 * unconditionally) rather than the machine the author is typing on. So the same body that fails in CI
 * fails at open time, by construction rather than by a second copy of the rule that could drift.
 *
 * This test exists because "by construction" is exactly the kind of claim that stops being true silently.
 */
test("pr:open refuses a whole-suite acceptance line at open time, through the SAME report CI runs", async () => {
  const { checkBody } = await import("../../../../scripts/pr-open.mjs");
  const refused = checkBody("Acceptance: npm test\n\nCloses: none — a reason", { run: () => 0 });
  assert.equal(refused.ok, false);
  assert.match(refused.lines.join("\n"), /Name the files this change is verified by/);

  const accepted = checkBody(
    'Acceptance: node -e "process.exit(0)"\n\nCloses: none — a reason', { run: () => 0 });
  assert.equal(accepted.ok, true, "the ordinary case must still open, or this refuses everything");
});
