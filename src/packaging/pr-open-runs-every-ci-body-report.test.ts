// no-token: gh -- `main` here is handed `run`, `git`, `runAcceptance`, `prHead` and `rowBody` as seams, so nothing reaches the real `gh`
/**
 * #3209: `pr:open` AND `pr:edit` RUN EVERY REPORT CI'S ACCEPTANCE JOB RUNS, because both iterate one exported list.
 *
 * `checkBody` composed two reports (Acceptance, Closes) while the CI entry composed four (plus `Mutation:` and
 * `## Measured`), so a body passed `pr:open` and went red in CI: 8 of the 9 acceptance failures sampled on #928 were
 * `MUTATION: MISSING`. That is paperwork, knowable before the pull request exists.
 *
 * THE ROW'S ITEM 2 SAYS "a count claim outside a `## Measured` block is REFUSED", AND CI DOES NOT DO THAT.
 * `measuredSectionReport` is scoped to a DECLARED section on purpose (its own header: "a machine cannot find the
 * numbers in prose"), so a claim in no block reads `MEASURED: NOT DECLARED` and passes. What CI refuses is a
 * `## Measured` section that holds no command with its output, and that is what is pinned below: the same line, from
 * `checkBody`. Refusing prose claims would be a new CI rule and not a shift-left of an existing one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CI_BODY_REPORTS, runCiBodyReports, mutationRecordReport, measuredSectionReport }
  from "../acceptance-commands.ts";
import { checkBody, main, EXIT_NOTHING_SENT } from "../pr-open.ts";
import { COMMANDS, FIXED_ARGS } from "../commands.mjs";

const ACCEPTANCE = 'Acceptance: node -e "process.exit(0)"';
const CLOSES = "Closes: none — a reason";
const withTest = { ok: true as const, files: ["src/packaging/example.test.ts"] };
const noTests = { ok: true as const, files: ["src/example.mjs"] };
const body = (...extra: string[]) => [ACCEPTANCE, CLOSES, ...extra].join("\n\n");
const check = (text: string, diff: typeof withTest) => checkBody(text, { run: () => 0, diff });

test("#3209 (1), as amended by a11ign/a11ign#3282: a body with no `Mutation:` record over a diff that changes a test prints CI's own line and OPENS", () => {
  const diff = withTest;
  const printed = check(body(), diff);
  const ciLine = mutationRecordReport({ body: body(), diff }).line;
  assert.equal(printed.ok, true, "a missing record is paperwork, and CI no longer fails a pull request for it");
  assert.match(ciLine, /^MUTATION: MISSING \(printed, not failing\)/, "the line under comparison is the printed omission, not an empty match");
  assert.ok(printed.lines.includes(ciLine), `checkBody prints the line the CI entry prints:\n${printed.lines.join("\n")}`);

  const accepted = check(body("Mutation: none -- the example only renames a fixture"), diff);
  assert.equal(accepted.ok, true);
  assert.ok(accepted.lines.some((line) => line.startsWith("MUTATION: NONE")));

  const twice = check(body("Mutation: a", "Mutation: b"), diff);
  assert.equal(twice.ok, false, "POSITIVE CONTROL: the report can still say no -- a duplicated header is refused");
  assert.ok(twice.lines.some((line) => line.startsWith("MUTATION: DUPLICATE")));
});

test("#3209 (1): a diff with no test file owes no record, so the ordinary case still opens", () => {
  const result = check(body(), noTests);
  assert.equal(result.ok, true);
  assert.ok(result.lines.some((line) => line.startsWith("MUTATION: NOT REQUIRED")));
});

test("#3209 (1): a diff that could not be read is UNCHECKED and not a refusal, as in CI", () => {
  const result = checkBody(body(), { run: () => 0, diff: { ok: false, why: "git said: boom" } });
  assert.equal(result.ok, true);
  assert.ok(result.lines.some((line) => line.startsWith("MUTATION: UNCHECKED")));
  const none = checkBody(body(), { run: () => 0 });
  assert.ok(none.lines.some((line) => line.startsWith("MUTATION: UNCHECKED")), "a caller handing no diff is told so");
});

test("#3209 (2): a `## Measured` section with no command and its output is REFUSED with CI's own line", () => {
  const claim = "## Measured\n\n25 of 57 runs failed on acceptance.";
  const refused = check(body(claim), noTests);
  const ciLine = measuredSectionReport(body(claim)).line;
  assert.equal(refused.ok, false);
  assert.match(ciLine, /^MEASURED: MALFORMED/);
  assert.ok(refused.lines.includes(ciLine), `checkBody prints the line the CI entry prints:\n${refused.lines.join("\n")}`);

  const recorded = "## Measured\n\n```\n$ node -e \"console.log(25)\"\n25\n```";
  const accepted = check(body(recorded), noTests);
  assert.equal(accepted.ok, true, "POSITIVE CONTROL: the same claim with a command and its output passes");
  assert.ok(accepted.lines.includes("MEASURED: RECORDED"));
});

test("#3209 (3): the CLI entry and `checkBody` run ONE exported list, and it holds five reports today", () => {
  assert.equal(CI_BODY_REPORTS.length, 5, "POSITIVE CONTROL for the emptiness: a refactor that empties the list fails here");
  assert.deepEqual(CI_BODY_REPORTS.map((entry) => entry.name), ["acceptance", "closes", "class", "mutation", "measured"]);
});

test("#3209 (3): a report added to the list is run by `checkBody` with no second edit", () => {
  const added = { name: "sixth", report: () => ({ ok: false, lines: ["SIXTH: REFUSED -- added to the one list"] }) };
  CI_BODY_REPORTS.push(added);
  try {
    const result = check(body(), noTests);
    assert.equal(result.ok, false);
    assert.ok(result.lines.includes("SIXTH: REFUSED -- added to the one list"));
    assert.deepEqual(runCiBodyReports({ body: body(), run: () => 0, diff: noTests }), result,
      "the function the CLI entry calls gives the same answer as the one `pr:open` calls");
  } finally {
    CI_BODY_REPORTS.splice(CI_BODY_REPORTS.indexOf(added), 1);
  }
  assert.equal(CI_BODY_REPORTS.length, 5, "the list is restored, so no other test sees the sixth");
});

test("#3209 (3): neither `checkBody` nor the CLI entry spells its own list of reports", async () => {
  const { readFileSync } = await import("node:fs");
  const strip = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8")
    .split("\n").filter((line) => !/^\s*(?:\/\/|\*|\/\*\*)/.test(line)).join("\n");
  const prOpen = strip("../pr-open.ts");
  const reports = ["acceptanceReport", "closesDeclarationReport", "mutationRecordReport", "measuredSectionReport", "defectClassReport"];
  for (const name of reports) {
    assert.ok(!prOpen.includes(`${name}(`), `pr-open.ts calls ${name} itself, a second spelling of the list`);
  }
  const acceptance = strip("../acceptance-commands.ts");
  const main = acceptance.slice(acceptance.indexOf("\nfunction main() {"));
  for (const name of reports) {
    assert.ok(!main.includes(`${name}(`), `acceptance-commands.ts's main() calls ${name} itself, a second spelling`);
  }
  assert.ok(main.includes("runCiBodyReports("), "the positive control: main() does run the list");
});

test("#3209 (4): `pr:edit` is `pr-open.ts edit`, and `main` runs the same `checkBody` for it", () => {
  assert.equal(COMMANDS["pr:edit"], COMMANDS["pr:open"], "the same file");
  assert.deepEqual(FIXED_ARGS["pr:edit"], ["edit"]);
  assert.deepEqual(FIXED_ARGS["pr:open"], ["create"]);

  const malformed = body("## Measured\n\nA claim with no command.");
  for (const [mode, text, expected] of [["edit", malformed, EXIT_NOTHING_SENT], ["create", malformed, EXIT_NOTHING_SENT],
    ["edit", body("Mutation: none -- the example only renames a fixture"), 0], ["edit", body(), 0]] as const) {
    const sent: string[][] = [];
    const err: string[] = [];
    const code = main([mode, ...(mode === "edit" ? ["7"] : ["--head", "agent/x"]), "--body", text], {
      run: (args) => { sent.push(args); },
      git: (args) => (args[0] === "diff" ? withTest.files.join("\0") : args.includes("--abbrev-ref") ? "agent/x" : "deadbeef"),
      prHead: () => ({ ref: "agent/x", oid: "deadbeef" }),
      runAcceptance: () => 0,
      runMutation: () => 0,
      owner: () => null,
      out: () => {},
      err: (line) => { err.push(line); },
    });
    assert.equal(code, expected, `${mode}: ${err.join("")}`);
    assert.equal(sent.length > 0, expected === 0, `${mode}: sends exactly when the body passes`);
  }
});
