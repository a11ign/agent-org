// no-token: gh
//
// #1015: `row-file` REFUSES A BUILD ROW WHOSE `spec` BLOCK IS MISSING A REQUIRED FIELD OR HAS AN EMPTY ONE (a11ign#5109's structured format, validation half).
//
// EVERY REFUSAL CASE GOES THROUGH `fileRefusalReason` (what `createIssue` calls) with the flag passed, so a rule that is right and not wired in is red here.
// POSITIVE CONTROLS, NAMED: `COMPLETE` is the non-empty population every refusal is a one-field mutation of, and the "optional fields absent" case is the
// negative control (a block with only the four required fields passes). The hand parser is compared with `yaml` on every block below, which is what makes it a
// reading of YAML and not a second dialect (`yaml` is a devDependency, so the rule itself cannot import it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { fileRefusalReason, parseSpecYaml, specBlockFlagOf, specBlockRefusal } from "../row-file/issue-body-and-region-checks.ts";
import { trackedTopLevelDirs } from "../region-paths.ts";

/** #1603: the packages/ rows read the project's own tracked `packages/` tree (docs/project-tree-dependency.md, row 1603). Skipped only where that tree is absent. */
const SKIP_NO_PACKAGES = trackedTopLevelDirs().includes("packages") ? false
  : "the project checkout has no tracked packages/ tree: this reader is agent-org's own product tree and belongs to row 5 of this series";

const ROW = "## Region\n\npackages/lab/src/packaging/foo.ts\n\n"
  + "## Acceptance\n\n```\nnpx tsx --test x\n```\n\n"
  + "## Open-check\n\n```\ngh issue view 735 --json state\n```\n";
const COMPLETE = `files:
  - src/row-file.ts
  - src/packaging/spec-block-refusal.test.ts
tests:
  path: src/packaging/spec-block-refusal.test.ts
  cases:
    - given: a build row whose spec block is complete
      when: row-file checks it
      then: it is accepted with no refusal
    - given: "a block that lacks \\"run\\""
      when: row-file checks it
      then: 'the refusal names \`run\` and says it is missing'
run: npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/spec-block-refusal.test.ts
out_of_scope:
  - the Ready-time lint (a11ign#5117)
`;
const withSpec = (block: string) => `${ROW}\n\`\`\`spec\n${block}\`\`\`\n`;
const refusal = (block: string) => fileRefusalReason(withSpec(block), { specBlock: true });
/** `COMPLETE` with the top-level field `name` (and its indented lines) cut out. */
const without = (name: string) => COMPLETE.replace(new RegExp(`^${name}:.*\\n(?:[ ]+.*\\n)*`, "m"), "");

test("the control block is fileable on its own, and the hand parser agrees with yaml about it", { skip: SKIP_NO_PACKAGES }, () => {
  assert.equal(refusal(COMPLETE), null);
  assert.equal(fileRefusalReason(ROW, { specBlock: true }), null, "the control row is fileable without a spec");
});

test("a block missing each required field is refused naming the field path", { skip: SKIP_NO_PACKAGES }, () => {
  for (const [name, path] of [["files", "files"], ["tests", "tests"], ["run", "run"], ["out_of_scope", "out_of_scope"]] as const) {
    const reason = String(refusal(without(name)));
    assert.match(reason, new RegExp(`${path}: missing`), name);
  }
  assert.match(String(refusal(COMPLETE.replace("  path: src/packaging/spec-block-refusal.test.ts\n", ""))), /tests\.path: missing/);
  assert.match(String(refusal(COMPLETE.replace(/^ {2}cases:\n(?: {4}.*\n| {6}.*\n)+/m, ""))), /tests\.cases: missing/);
});

test("an empty field is refused naming the field path", { skip: SKIP_NO_PACKAGES }, () => {
  assert.match(String(refusal(COMPLETE.replace(/^run: .*$/m, "run:"))), /run: empty/);
  assert.match(String(refusal(COMPLETE.replace(/^files:\n(?: {2}.*\n)+/m, "files: []\n"))), /files: empty/);
  assert.match(String(refusal(COMPLETE.replace("given: a build row whose spec block is complete", "given: ''"))), /tests\.cases\[0\]\.given: empty/);
  assert.match(String(refusal(COMPLETE.replace(/^out_of_scope:\n(?: {2}.*\n)+/m, "out_of_scope: \"\"\n"))), /out_of_scope: empty/);
});

test("a `then` that asserts nothing is refused, with the case index in its path", { skip: SKIP_NO_PACKAGES }, () => {
  for (const vacuous of ["", "works", "Works.", "correct", "as expected", "ok", "OK"]) {
    const block = COMPLETE.replace("then: 'the refusal names `run` and says it is missing'", `then: "${vacuous}"`);
    assert.match(String(refusal(block)), /tests\.cases\[1\]\.then: (empty|`[a-z ]+` asserts nothing)/, JSON.stringify(vacuous));
  }
  assert.equal(refusal(COMPLETE.replace("then: it is accepted with no refusal", "then: it works as the table says")), null, "a longer sentence that merely contains `works` asserts something");
});

test("more than one spec block is refused", { skip: SKIP_NO_PACKAGES }, () => {
  const reason = String(fileRefusalReason(`${withSpec(COMPLETE)}\n\`\`\`spec\n${COMPLETE}\`\`\`\n`, { specBlock: true }));
  assert.match(reason, /2 `spec` fences; a build row carries ONE/);
});

test("a spec fence that is never closed, and YAML that does not read, are refused rather than passed", { skip: SKIP_NO_PACKAGES }, () => {
  assert.match(String(fileRefusalReason(`${ROW}\n\`\`\`spec\nfiles:\n  - a\n`, { specBlock: true })), /never closed/);
  assert.match(String(refusal("files: [a\nrun: x\n")), /does not read as YAML/);
  assert.match(String(refusal("files:\n  - a\n files2: b\n")), /does not read as YAML|missing/);
});

test("NEGATIVE CONTROL: a valid block with the optional fields absent passes, and with them present and filled passes", { skip: SKIP_NO_PACKAGES }, () => {
  assert.equal(refusal(COMPLETE), null);
  assert.equal(refusal(`${COMPLETE}errors:\n  - a bad path is refused with its name\nexamples:\n  - "run: x"\n`), null);
  assert.match(String(refusal(`${COMPLETE}errors:\n`)), /errors: present but empty/);
});

test("the exemption: a row with no spec fence, or a spec shown inside another fence, passes", { skip: SKIP_NO_PACKAGES }, () => {
  assert.equal(fileRefusalReason(ROW, { specBlock: true }), null);
  assert.equal(fileRefusalReason(`${ROW}\n\`\`\`\`md\n\`\`\`spec\nfiles: []\n\`\`\`\n\`\`\`\`\n`, { specBlock: true }), null);
});

test("the flag off passes everything; the flag is on only when exactly true", { skip: SKIP_NO_PACKAGES }, () => {
  assert.equal(fileRefusalReason(withSpec("files: []\n"), { specBlock: false }), null);
  assert.notEqual(specBlockRefusal(withSpec("files: []\n")), null);
  assert.equal(specBlockFlagOf('{"rows":{"specBlock":true}}'), true);
  for (const off of ['{"rows":{"specBlock":"true"}}', '{"rows":{}}', "{}", "not json", '{"rows":{"specBlock":false}}']) assert.equal(specBlockFlagOf(off), false, off);
});

test("the hand parser reads the same value `yaml` does, on forms a spec uses", () => {
  const forms = [COMPLETE, "files: [a, b]\nrun: |\n  one\n  two\nout_of_scope: >\n  folded\n  text\n",
    "a:\n- x\n- y: 1\n  z: 2\nb: 'it''s'\nc: \"q\\\"s\" # comment\nd: ~\ne: []\n", "k:\n  - a: 1\n    b:\n      - c\n      - d\n  - e\n"];
  const norm = (v: unknown): unknown => (v === null ? "" : Array.isArray(v) ? v.map(norm) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)])) : String(v));
  for (const form of forms) assert.deepEqual(parseSpecYaml(form), norm(parse(form)), form);
  assert.ok(forms.length > 0);
});
