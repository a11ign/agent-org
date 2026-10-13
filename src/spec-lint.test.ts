// no-token: gh -- every input is injected (the lint's three machine questions, Jev's answer, the comment list); no lookup reaches GitHub.
/**
 * THE SPEC LINT (a11ign#5117, the Haiku push): a spec at promotion is refused for vague or oversized content, Jev WARNS on ambiguity, and a worker's
 * "underspecified" stop is counted by FIELD in the daily retro.
 *
 * Why the content and not the presence of sections: Haiku's runs failed on missing detail 3.3x as often as Sonnet's, and a written spec took it from 0/15 to
 * 7/9. A refusal that names no field cannot be acted on, so every test below pins WHICH field a finding names.
 *
 * Every refusal has a twin: the same fixture with the one fault repaired is clean. A rule that fires always cannot pass its twin, and a rule that never
 * fires cannot pass its refusal. The mutations run against this file are listed in the pull request, one per rule.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_FILES, SPEC_LINT_FLAG, SPEC_REVIEW_LABEL, SPEC_REVIEW_THRESHOLD, SPEC_REVIEW_WAKE, UNDERSPECIFIED_DAILY_LIMIT, UNNAMED_FIELD,
  bashParses, executableOnPath, executablesOf, fieldOf, lintRowBody, lintSpec, machineDeps, parseSpec, reviewSpec, specBlocksOf, specLintFlagOf,
  specLintRefusalReason, specReviewQuestion, specReviewVerdict, subsystemOf, underspecifiedLines, underspecifiedReading, underspecifiedStops,
  type LintDeps, type SpecValue,
} from "./spec-lint.ts";
import { buildReport, readAll, readUnderspecified, renderReport } from "./org-retro.ts";
import { commentsSince } from "./ticket-port/comments-since.ts";

// --- fixtures -----------------------------------------------------------------------------------------------------------------

const GOOD = [
  "files:",
  "  - agent-org:src/spec-lint.ts",
  "  - path: agent-org:src/spec-lint.test.ts",
  "    new: true",
  "tests:",
  "  path: agent-org:src/spec-lint.test.ts",
  "  new: true",
  "  cases:",
  "    - given: \"a spec whose case says `then: it works`\"",
  "      when: the lint runs",
  "      then: it returns a finding with rule `no-assertion` on `tests.cases[0].then`",
  "run: bash -c 'cd ~/repos/agent-org && npx rstest run src/spec-lint.test.ts'",
  "out_of_scope:",
  "  - wiring the lint into row-file",
].join("\n");

const PRESENT = new Set(["agent-org:src/spec-lint.ts", "agent-org:src/org-retro.ts", "src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts", "src/g.ts"]);
const EXECUTABLES = new Set(["bash", "npx", "node", "pnpm"]);
const deps = (over: Partial<LintDeps> = {}): LintDeps => ({
  fileExists: (path) => PRESENT.has(path),
  onPath: (name) => EXECUTABLES.has(name),
  shellParses: () => true,
  ...over,
});

const parsed = (text: string): SpecValue => {
  const result = parseSpec(text);
  if (!result.ok) throw new Error(`fixture does not parse, line ${result.line}: ${result.reason}`);
  return result.value;
};
/** The GOOD spec with `from` replaced by `to`: one fault per fixture, so a finding is attributable. */
const lintWith = (from: string, to: string, over: Partial<LintDeps> = {}) => {
  assert.ok(GOOD.includes(from), `fixture drift: ${from}`);
  return lintSpec(parsed(GOOD.replace(from, to)), deps(over));
};
const fieldsOf = (result: { findings: { field: string }[] }): string[] => result.findings.map((one) => one.field);
const rulesOf = (result: { findings: { rule: string }[] }): string[] => result.findings.map((one) => one.rule);

test("the good spec is clean, and nothing in it was left unchecked (positive control for every refusal below)", () => {
  assert.deepEqual(lintSpec(parsed(GOOD), deps()), { findings: [], unchecked: [] });
});

// --- THE READER: the subset of YAML the block is written in --------------------------------------------------------------------

test("the reader reads mappings, lists, `- key:` items, quoted values, booleans, flow lists and comments", () => {
  const value = parsed([
    "# a comment line",
    "files: [src/a.ts, \"src/b, c.ts\"]",
    "tests:",
    "  path: src/a.test.ts",
    "  cases:",
    "  - given: 'it''s one'",
    "    when: \"two\\tthree\"",
    "    then: `x` is returned   # trailing comment",
    "  - given: a",
    "    when: b",
    "    then: null",
    "empty:",
    "flag: true",
    "off: false",
  ].join("\n").replace("then: `x` is returned", "then: \"`x` is returned\""));
  assert.deepEqual(JSON.parse(JSON.stringify(value)), {
    files: ["src/a.ts", "src/b, c.ts"],
    tests: { path: "src/a.test.ts", cases: [{ given: "it's one", when: "two\tthree", then: "`x` is returned" }, { given: "a", when: "b", then: null }] },
    empty: null, flag: true, off: false,
  });
});

test("a Region-style `repo:path` value is a scalar, not a `key: value` pair", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(parsed("files:\n  - agent-org:src/x.ts\n  - path: agent-org:src/y.ts\n    new: true"))),
    { files: ["agent-org:src/x.ts", { path: "agent-org:src/y.ts", new: true }] });
});

test("the reader REFUSES what it cannot read, naming the line, and never guesses", () => {
  const refused = (text: string) => {
    const result = parseSpec(text);
    assert.equal(result.ok, false, text);
    return result.ok ? { line: 0, reason: "" } : result;
  };
  assert.equal(refused("run: |\n  npx rstest").line, 1, "a block scalar");
  assert.match(refused("files:\n\t- a").reason, /tab/);
  assert.equal(refused("a: 1\na: 2").line, 2, "a duplicate key");
  assert.match(refused("then: returns: x").reason, /quote it/, "a plain value holding `: `");
  assert.match(refused("then: `x` is returned").reason, /reserves/, "a backtick start, which YAML reserves");
  assert.match(refused("a: \"never closed").reason, /not closed/);
  assert.match(refused("a: &anchor x").reason, /reserves/);
  assert.match(refused("a: {b: 1}").reason, /reserves/, "a flow mapping");
  assert.equal(refused("").reason, "the block is empty");
  assert.match(refused("a: 1\n    b: 2").reason, /indentation/);
});

test("`spec` blocks are found by their fence, and only a fence named exactly `spec`", () => {
  const body = `## What\n\n\`\`\`spec\nfiles:\n  - a\n\`\`\`\n\n\`\`\`yaml\nfiles: []\n\`\`\`\n\n\`\`\`spec\nrun: x\n\`\`\`\n`;
  assert.deepEqual(specBlocksOf(body), ["files:\n  - a\n", "run: x\n"]);
});

// --- THE SIX REFUSALS, each naming its field -----------------------------------------------------------------------------------

test("a listed file that does not exist and is not `new: true` is refused, naming its entry", () => {
  const result = lintWith("agent-org:src/spec-lint.ts", "agent-org:src/ghost.ts");
  assert.deepEqual(fieldsOf(result), ["files[0]"]);
  assert.deepEqual(rulesOf(result), ["file-absent"]);
  assert.match(result.findings[0].message, /ghost\.ts/);
});

test("the same absent file marked `new: true` is clean (the twin), and an unreadable checkout is UNCHECKED, never a refusal", () => {
  assert.deepEqual(lintWith("  - agent-org:src/spec-lint.ts", "  - path: agent-org:src/ghost.ts\n    new: true").findings, []);
  const unknown = lintWith("agent-org:src/spec-lint.ts", "agent-org:src/ghost.ts", { fileExists: () => null });
  assert.deepEqual(unknown.findings, []);
  assert.deepEqual(unknown.unchecked.map((one) => one.field), ["files[0]"]);
});

test("an existing test path is not required to be `new`, and an absent one that is not new is refused as `tests.path`", () => {
  const result = lintWith("  path: agent-org:src/spec-lint.test.ts\n  new: true", "  path: agent-org:src/no-such.test.ts");
  assert.deepEqual(fieldsOf(result).filter((field) => field === "tests.path"), ["tests.path"]);
});

test("a test case without a concrete assertion is refused, naming the case and the part", () => {
  const vague = lintWith("then: it returns a finding with rule `no-assertion` on `tests.cases[0].then`", "then: it works correctly");
  assert.deepEqual(fieldsOf(vague), ["tests.cases[0].then"]);
  assert.deepEqual(rulesOf(vague), ["no-assertion"]);
  for (const concrete of ["returns null", "exit code 1", "prints \"refused\"", "the count is 7", "the list is empty", "the flag is true"]) {
    assert.deepEqual(lintWith("then: it returns a finding with rule `no-assertion` on `tests.cases[0].then`", `then: ${concrete}`).findings, [], concrete);
  }
});

test("a case missing `given`, `when` or `then`, or a spec with no cases, names that part", () => {
  assert.deepEqual(fieldsOf(lintWith("      when: the lint runs\n", "")), ["tests.cases[0].when"]);
  assert.deepEqual(fieldsOf(lintWith("      then: it returns a finding with rule `no-assertion` on `tests.cases[0].then`", "      then: \"\"")), ["tests.cases[0].then"]);
  assert.deepEqual(fieldsOf(lintWith("  cases:\n    - given: \"a spec whose case says `then: it works`\"\n      when: the lint runs\n      then: it returns a finding with rule `no-assertion` on `tests.cases[0].then`", "  cases: []")),
    ["tests.cases"]);
});

test("a `run:` that does not parse, whose program is not on PATH, or that never names the tests is refused, each on `run`", () => {
  const unparsed = lintWith("run: bash -c", "run: bash -c", { shellParses: () => false });
  assert.deepEqual([fieldsOf(unparsed), rulesOf(unparsed)], [["run"], ["run-not-executable"]]);
  const missingProgram = lintWith("npx rstest", "pnpx rstest");
  assert.deepEqual([fieldsOf(missingProgram), rulesOf(missingProgram)], [["run"], ["run-not-executable"]]);
  assert.match(missingProgram.findings[0].message, /pnpx/, "names the program found missing INSIDE `bash -c '...'`");
  const misses = lintWith("npx rstest run src/spec-lint.test.ts", "npx rstest run src/other.test.ts");
  assert.deepEqual([fieldsOf(misses), rulesOf(misses)], [["run"], ["run-misses-tests"]]);
  const unknown = lintWith("run: bash -c", "run: bash -c", { shellParses: () => null, onPath: () => null });
  assert.deepEqual(unknown.findings, [], "could-not-tell is not a refusal");
  assert.ok(unknown.unchecked.length >= 2);
});

test("`run:` is ONE command: a second line is refused", () => {
  const spec = "files:\n  - src/a.ts\ntests:\n  path: src/a.test.ts\n  new: true\n  cases:\n    - given: g\n      when: w\n      then: returns 1\nrun: \"npx rstest src/a.test.ts\\nnpx rstest src/a.test.ts\"\nout_of_scope:\n  - x";
  assert.deepEqual(rulesOf(lintSpec(parsed(spec), deps())), ["run-not-executable"]);
});

test("the executables of a command line: segments, `VAR=` prefixes, builtins skipped, and the inside of `bash -c`", () => {
  assert.deepEqual(executablesOf("cd ~/x && A=1 B=2 npx rstest run f.ts | tee out.txt"), ["npx", "tee"]);
  assert.deepEqual(executablesOf("bash -c 'cd ~/x && pnpm test; node -e \"1\"'"), ["bash", "pnpm", "node"]);
  assert.deepEqual(executablesOf("echo 'a && b' && node x.js"), ["node"], "an operator inside a quote does not split");
});

test("TBD, etc., as appropriate and handle edge cases are refused WITHOUT a list, naming the field that says them", () => {
  for (const [text, phrase] of [["TBD", "TBD"], ["the callers, etc.", "etc."], ["escape as appropriate", "as appropriate"], ["handle edge cases", "handle edge cases"]] as const) {
    const result = lintWith("  - wiring the lint into row-file", `  - ${text}`);
    assert.deepEqual(fieldsOf(result), ["out_of_scope[0]"], text);
    assert.deepEqual(rulesOf(result), ["vague"], text);
    assert.ok(result.findings[0].message.includes(phrase), text);
  }
  const inCase = lintWith("when: the lint runs", "when: the lint runs, etc.");
  assert.deepEqual(fieldsOf(inCase), ["tests.cases[0].when"], "the path names the case and the part");
});

test("`handle edge cases` WITH its list is clean (the twin), and `errors:`/`examples:` are verbatim and are not scanned", () => {
  assert.deepEqual(lintWith("  - wiring the lint into row-file", "  - \"handle edge cases: an empty list, a duplicate key, a tab\"").findings, []);
  assert.deepEqual(lintSpec(parsed(`${GOOD}\nerrors: "bash: etc. TBD as appropriate"\nexamples:\n  - "etc."`), deps()).findings, []);
});

test("more than six files is refused, six is clean (the twin), and the finding names `files`", () => {
  const files = (n: number) => ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts", "src/g.ts"].slice(0, n).map((f) => `  - ${f}`).join("\n");
  const spec = (n: number) => `files:\n${files(n)}\ntests:\n  path: src/a.ts\n  cases:\n    - given: g\n      when: w\n      then: returns 1\nrun: npx rstest src/a.ts\nout_of_scope:\n  - x`;
  assert.equal(MAX_FILES, 6);
  assert.deepEqual(lintSpec(parsed(spec(MAX_FILES)), deps()).findings, []);
  const seven = lintSpec(parsed(spec(MAX_FILES + 1)), deps());
  assert.deepEqual([fieldsOf(seven), rulesOf(seven)], [["files"], ["too-many-files"]]);
  assert.match(seven.findings[0].message, /7 files/);
});

test("more than one subsystem is refused: a repository boundary, or two top directories; a test beside its source is one", () => {
  assert.equal(subsystemOf("src/x.ts"), "src");
  assert.equal(subsystemOf("agent-org:src/packaging/x.test.ts"), "agent-org:src");
  assert.equal(subsystemOf(".agent-org/roles/product-manager.md"), ".agent-org");
  assert.equal(subsystemOf("packages/lab/src/x.ts"), "packages/lab");
  assert.equal(subsystemOf("README.md"), ".");
  const split = lintWith("  - agent-org:src/spec-lint.ts", "  - agent-org:src/spec-lint.ts\n  - .agent-org/roles/product-manager.md",
    { fileExists: () => true });
  assert.deepEqual([fieldsOf(split), rulesOf(split)], [["files"], ["too-many-subsystems"]]);
  assert.deepEqual(lintWith("  - agent-org:src/spec-lint.ts", "  - agent-org:src/spec-lint.ts\n  - agent-org:src/packaging/y.test.ts", { fileExists: () => true }).findings, []);
});

test("an empty `out_of_scope` is refused in each shape of empty, and a non-empty one is clean (the twin)", () => {
  for (const [label, replacement] of [["a missing key", ""], ["an empty list", "out_of_scope: []"], ["a bare key", "out_of_scope:"], ["a blank string", "out_of_scope: \"  \""]] as const) {
    const result = lintSpec(parsed(GOOD.replace("out_of_scope:\n  - wiring the lint into row-file", replacement)), deps());
    assert.deepEqual(fieldsOf(result), ["out_of_scope"], label);
    assert.deepEqual(rulesOf(result), label === "a missing key" ? ["empty-out-of-scope"] : ["empty-out-of-scope"], label);
  }
  assert.deepEqual(lintSpec(parsed(GOOD), deps()).findings, []);
});

test("a missing required field names the field: `files`, `tests`, `run`", () => {
  const result = lintSpec(parsed("out_of_scope:\n  - x"), deps());
  assert.deepEqual(fieldsOf(result).sort(), ["files", "run", "tests"]);
  assert.ok(rulesOf(result).every((rule) => rule === "missing"));
});

// --- THE ROW BODY, THE REFUSAL TEXT, AND THE FLAG --------------------------------------------------------------------------------

const rowBody = (block: string) => `## What it is\n\nprose\n\n\`\`\`spec\n${block}\n\`\`\`\n\n## Region\nsrc/a.ts\n`;

test("a row with no block is `none`, and is refused only when the CALLER says it is a build row", () => {
  assert.deepEqual(lintRowBody("## Region\nsrc/a.ts", deps()), { status: "none" });
  assert.equal(specLintRefusalReason("## Region\nsrc/a.ts", 7, deps()), null, "a decomposition row is exempt by saying nothing");
  assert.match(specLintRefusalReason("## Region\nsrc/a.ts", 7, deps(), { requireBlock: true }) ?? "", /build row and carries no fenced `spec` block/);
});

test("two blocks, and a block the reader cannot read, are refused on `spec` with the reader's line", () => {
  const two = lintRowBody(`${rowBody(GOOD)}\n${rowBody(GOOD)}`, deps());
  assert.deepEqual(two.status === "linted" ? rulesOf(two) : null, ["multiple-blocks"]);
  const broken = lintRowBody(rowBody("files:\n  - a\nrun: |\n  x"), deps());
  if (broken.status !== "linted") throw new Error("a block was present, so the row must have been linted");
  assert.deepEqual([fieldsOf(broken), rulesOf(broken)], [["spec"], ["unreadable"]]);
  assert.match(broken.findings[0].message, /^line 3: /);
});

test("the refusal reads as row-file's own, names every field, and says nothing was changed; a clean row is `null`", () => {
  assert.equal(specLintRefusalReason(rowBody(GOOD), 5117, deps()), null);
  const reason = specLintRefusalReason(rowBody(GOOD.replace("out_of_scope:\n  - wiring the lint into row-file", "")
    .replace("then: it returns a finding with rule `no-assertion` on `tests.cases[0].then`", "then: it works")), 5117, deps()) ?? "";
  assert.match(reason, /^row-file: REFUSING to promote -- #5117's `spec` block fails the spec lint \(rows\.specLint\), 2 finding\(s\):/);
  assert.match(reason, /- tests\.cases\[0\]\.then \(no-assertion\)/);
  assert.match(reason, /- out_of_scope \(empty-out-of-scope\)/);
  assert.match(reason, /Nothing was changed\.$/);
});

test("`rows.specLint` is on only when exactly `true`: absent, false, a string, and unreadable text are all off", () => {
  assert.equal(SPEC_LINT_FLAG, "rows.specLint");
  assert.equal(specLintFlagOf('{"rows":{"specLint":true}}'), true);
  for (const text of ['{}', '{"rows":{}}', '{"rows":{"specLint":false}}', '{"rows":{"specLint":"true"}}', "not json", ""]) assert.equal(specLintFlagOf(text), false, text);
});

// --- THE DEFAULT ANSWERS: bash, PATH and the checkout ---------------------------------------------------------------------------------

test("the machine's answers: `bash -n` parses without running, PATH finds node and not a ghost, a prefix with no root is `null`", () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-lint-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "x.ts"), "");
    assert.equal(bashParses("echo ok && true"), true);
    assert.equal(bashParses("if then fi ("), false);
    assert.equal(executableOnPath("node"), true);
    assert.equal(executableOnPath("definitely-not-a-program-5117"), false);
    const real = machineDeps({ "": dir, other: dir });
    assert.equal(real.fileExists("src/x.ts"), true);
    assert.equal(real.fileExists("other:src/x.ts"), true);
    assert.equal(real.fileExists("src/gone.ts"), false);
    assert.equal(real.fileExists("unknown-repo:src/x.ts"), null, "no checkout declared for the prefix: could not tell, which is not absent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- JEV: A WARNING, NEVER A BLOCK ------------------------------------------------------------------------------------------------------

test("below the threshold the verdict warns: it labels `spec:review` and wakes product-manager", () => {
  assert.equal(SPEC_REVIEW_THRESHOLD, 3);
  for (const score of [1, 2]) {
    const verdict = specReviewVerdict({ value: score, fellBack: false });
    assert.ok(verdict.warn && verdict.label === SPEC_REVIEW_LABEL && verdict.wake === SPEC_REVIEW_WAKE && verdict.score === score);
  }
  assert.equal(SPEC_REVIEW_LABEL, "spec:review");
  assert.equal(SPEC_REVIEW_WAKE, "product-manager");
});

test("at or above the threshold, on a fallback, on no answer and on a value that is no score, there is NO warning (the twins)", () => {
  for (const score of [3, 4, 5]) assert.equal(specReviewVerdict({ value: score, fellBack: false }).warn, false, String(score));
  assert.equal(specReviewVerdict({ value: 1, fellBack: true }).warn, false, "a fallback is no reading, whatever number it carries");
  assert.equal(specReviewVerdict(null).warn, false);
  for (const value of ["low", 0, 6, Number.NaN]) assert.equal(specReviewVerdict({ value, fellBack: false }).warn, false, String(value));
});

test("the question is the row's sentence over five levels, and its fallback is not a warning", () => {
  const question = specReviewQuestion();
  assert.equal(question.type, "score");
  assert.equal(question.levels.length, 5);
  assert.match(question.instructions, /Could an engineer who has never seen this repo build this from the spec alone, with no questions\?/);
  assert.ok(question.fallback >= SPEC_REVIEW_THRESHOLD);
});

test("`reviewSpec` asks once with the question and the spec, returns the verdict, and a throwing provider is no warning and no throw", async () => {
  const seen: string[] = [];
  const low = await reviewSpec("the spec", async (question, text) => {
    seen.push(question.type, text);
    return { value: 2, fellBack: false };
  });
  assert.deepEqual(seen, ["score", "the spec"]);
  assert.ok(low.warn);
  const down = await reviewSpec("the spec", async () => {
    throw new Error("503 from the provider\nstack");
  });
  assert.equal(down.warn, false);
  assert.match(down.reason, /could not be asked \(503 from the provider\)/);
});

// --- THE FEEDBACK LOOP --------------------------------------------------------------------------------------------------------------

const NOW = Date.parse("2026-10-11T18:00:00Z");
const WINDOW = { since: NOW - 24 * 60 * 60 * 1000, until: NOW };
const comment = (body: string, at = "2026-10-11T12:00:00Z", row = 6001) => ({ body, created_at: at, issue_url: `https://api.github.com/repos/a11ign/a11ign/issues/${row}` });

test("a field token is normalised to the spec vocabulary, and anything else is `unnamed`", () => {
  assert.equal(fieldOf("`tests.cases[2].then`"), "tests.cases");
  assert.equal(fieldOf("Files"), "files");
  assert.equal(fieldOf("out_of_scope"), "out_of_scope");
  assert.equal(fieldOf("tests"), "tests");
  assert.equal(fieldOf("the vibes"), UNNAMED_FIELD);
});

test("stops are the `Underspecified:` lines inside the window, one per named field, with the row they were said on", () => {
  const stops = underspecifiedStops([
    comment("done thinking\nUnderspecified: files, `tests.cases[1].then`\nmore"),
    comment("**Underspecified:** run", "2026-10-11T13:00:00Z", 6002),
    comment("Underspecified:", "2026-10-11T14:00:00Z", 6003),
    comment("Underspecified: files", "2026-10-09T12:00:00Z", 6004),
    comment("no stop here"),
    null,
  ], WINDOW);
  assert.deepEqual(stops.map(({ row, field }) => [row, field]), [[6001, "files"], [6001, "tests.cases"], [6002, "run"], [6003, UNNAMED_FIELD]]);
});

test("the retro's own report line is not read back as a stop", () => {
  assert.deepEqual(underspecifiedStops([comment("- Underspecified stops by field: files 3 (3 in all)")], WINDOW), []);
});

test("a field is over the limit above two a day, not at two", () => {
  assert.equal(UNDERSPECIFIED_DAILY_LIMIT, 2);
  const stops = (field: string, n: number) => Array.from({ length: n }, () => ({ at: NOW, row: null, field }));
  assert.deepEqual(underspecifiedReading([...stops("files", 3), ...stops("run", 2)]).overLimit, ["files"]);
  assert.deepEqual(underspecifiedReading(stops("run", 2)).overLimit, []);
  assert.deepEqual(underspecifiedReading([]), { status: "read", total: 0, byField: {}, overLimit: [] });
});

test("the lines say `unknown` for a refused read, `none` for none, and the counts and the class-row offer otherwise", () => {
  assert.deepEqual(underspecifiedLines(null), ["- Underspecified stops by field: unknown (the row comments could not be read)"]);
  assert.deepEqual(underspecifiedLines(underspecifiedReading([])), ["- Underspecified stops by field: none in the 24 hours"]);
  const lines = underspecifiedLines(underspecifiedReading(["files", "files", "files", "run"].map((field) => ({ at: NOW, row: 1, field }))));
  assert.equal(lines[0], "- Underspecified stops by field: files 3, run 1 (4 in all)");
  assert.match(lines[1], /`files` is above 2 a day \(3\): file a `ready` class row to tighten the lint or the spec writer's prompt/);
  assert.equal(lines.length, 2);
});

// --- THE RETRO PRINTS IT ------------------------------------------------------------------------------------------------------------

const emptyReads = { merged: null, openPrs: null, journal: null, ledger: null, turns: null, handFixes: null };

test("the retro prints \"Underspecified stops by field\" on its next run, `unknown` when nothing was read", () => {
  const unread = renderReport(buildReport(emptyReads, NOW));
  assert.match(unread, /^- Underspecified stops by field: unknown \(the row comments could not be read\)$/m);
  const reading = underspecifiedReading(underspecifiedStops([comment("Underspecified: files"), comment("Underspecified: files", "2026-10-11T13:00:00Z", 6002),
    comment("Underspecified: files", "2026-10-11T14:00:00Z", 6003)], WINDOW));
  const text = renderReport(buildReport({ ...emptyReads, underspecified: reading }, NOW));
  assert.match(text, /^- Underspecified stops by field: files 3 \(3 in all\)$/m);
  assert.match(text, /`files` is above 2 a day/);
});

test("the live read asks each declared tracker for its comments once, and ONE refused list makes the whole reading `null`", () => {
  const declaration = { repo: "a11ign/a11ign", tracker: [{ repo: "a11ign/a11ign" }, { repo: "a11ign/agent-org" }] } as unknown as Parameters<typeof readUnderspecified>[0]["declaration"];
  const asked: string[] = [];
  const reading = readUnderspecified({ now: NOW, declaration, read: (args) => {
    asked.push(args.join(" "));
    return [[comment("Underspecified: run")]];
  } });
  assert.deepEqual(reading, { status: "read", total: 2, byField: { run: 2 }, overLimit: [] });
  assert.equal(asked.length, 2);
  assert.ok(asked[0].startsWith("api --paginate --slurp repos/a11ign/a11ign/issues/comments?since=2026-10-10T18:00:00.000Z"));
  assert.equal(readUnderspecified({ now: NOW, declaration, read: (args) => (args.join(" ").includes("agent-org") ? null : []) }), null);
});

test("`commentsSince` flattens the pages, and a refused run or an answer that is not a list of lists is `null`, never `[]`", () => {
  const page = [comment("a"), comment("b")];
  const seen: string[][] = [];
  const flat = commentsSince({ repo: "a11ign/a11ign", since: NOW, run: (args) => {
    seen.push(args);
    return [page, [comment("c")]];
  } });
  assert.deepEqual(flat?.map((one) => one.body), ["a", "b", "c"]);
  assert.deepEqual(seen[0], ["api", "--paginate", "--slurp", "repos/a11ign/a11ign/issues/comments?since=2026-10-11T18:00:00.000Z&per_page=100"]);
  assert.deepEqual(commentsSince({ repo: "r/r", since: NOW, run: () => [] }), [], "a list with no page is no comments: the read WORKED (the twin of the two nulls)");
  assert.equal(commentsSince({ repo: "r/r", since: NOW, run: () => null }), null);
  assert.equal(commentsSince({ repo: "r/r", since: NOW, run: () => [{ message: "Bad credentials" }] }), null);
});

test("`readAll` carries the read into the report's inputs through its seam", () => {
  const seen: number[] = [];
  const stateDir = mkdtempSync(join(tmpdir(), "spec-lint-state-"));
  try {
    const inputs = readAll({
      now: NOW, stateDir,
      readMergedRepositories: () => [], readHandFixes: () => ({ status: "unknown" }) as never, readUnwaited: () => null as never, readUntiered: () => null as never,
      readDoraReport: () => null, readAgentListing: () => null, readIdleHours: () => null, readOpenRowIncidents: () => null, readInertOptionReading: () => null,
      readDenials: () => null, readSharedRows: () => null, pinBumpOn: () => false, readOpenPrs: () => null, readUnderspecifiedStops: (at) => {
        seen.push(at);
        return underspecifiedReading([]);
      },
    });
    assert.deepEqual(seen, [NOW]);
    assert.deepEqual(inputs.underspecified, { status: "read", total: 0, byField: {}, overLimit: [] });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
