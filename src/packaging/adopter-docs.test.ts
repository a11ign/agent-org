// no-token: gh -- `row-file` and `dora.ts` reach `gh` only through the stubs this file injects; nothing here runs a real one
//
// a11ign/a11ign#4084: A `dora` ENTRY'S `adopterDocs` COUNT AS ADOPTER-FACING FOR THE PRIMARY MILESTONE, AND FOR NOTHING ELSE.
//
// The primary milestone holds adopter-facing rows only (#4378), and the three documents the chairman's outcomes edit (`README.md`, `RELEASE.md`, `docs/try-it.md`) lie under no `releasablePaths`
// entry, so `row-file` refused the rows that edit them. `ceo` ruled that `releasablePaths` is NOT widened (it also decides which pull request owes a version, so every README edit would owe a
// changeset): the answer is a second list, read by `adopterRowKind` and by no one else. The cases below pin both halves, each beside its positive control:
//   - what it DOES: the Region is `org` without the key (CONTROL) and `adopter` with it, through `adopterRowKind`, `primaryMilestoneRefusal` and `milestoneClockFact`;
//   - what it must NOT: the releasable-change decision (`isShipped`, and `isReleasable` through `measureRepository`) and the 60% share (`productRegionsOf`) answer the same with and without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { productRegionsOf } from "../work-gate.ts";
import { adopterRowKind, milestoneClockFact } from "../work-gate/org-health.ts";
import { primaryMilestoneRefusal } from "../row-file.ts";
import { parseProjectDeclaration, ProjectDeclarationRefusal } from "../project-config.ts";
import { measureRepository } from "../dora.ts";
import { isShipped } from "../release-behind-main.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const PRIMARY = "v3 — Ready for a first outside adopter";
const CODE = [
  { key: "a11ign", repo: "a11ign/a11ign" }, { key: "agent-org", repo: "a11ign/agent-org" }, { key: "lab", repo: "a11ign/lab" }, { key: "toolchain", repo: "a11ign/toolchain" },
];
const TRACKERS = [{ key: "", repo: "a11ign/a11ign", board: { owner: "a11ign", number: 2 } }];
const DOCS = ["README.md", "RELEASE.md", "docs/try-it.md"];

/** The declaration as it stands (`a11ign/a11ign` releases `packages/cli/`; the tooling repositories declare `adopterFacing: false`, which is what makes the milestone rule ACTIVE), with `adopterDocs` on the named repository or none. */
const declared = (adopterDocs?: string[], on = "a11ign/a11ign"): Any => ({
  tracker: TRACKERS, code: CODE,
  dora: [
    { repo: "a11ign/a11ign", releasablePaths: ["packages/cli/"] },
    { repo: "a11ign/agent-org", releasablePaths: ["src/"] },
    { repo: "a11ign/lab", releasablePaths: ["src/"], adopterFacing: false },
    { repo: "a11ign/toolchain", releasablePaths: ["src/"], adopterFacing: false },
  ].map((entry) => (adopterDocs !== undefined && entry.repo === on ? { ...entry, adopterDocs } : entry)),
});
/** A project.json text with ONE `dora` entry, for the parser. */
const PROJECT = { schema: 1, tracker: TRACKERS, code: [{ key: "", repo: "a11ign/a11ign" }, { key: "lab", repo: "a11ign/lab" }] };
const withDora = (entry: object) => JSON.stringify({ ...PROJECT, dora: [{ repo: "a11ign/a11ign", release: { kind: "tag" }, releasablePaths: ["packages/cli/"], ...entry }] });

const WITHOUT = declared();
const WITH = declared(DOCS);

test("a docs-only Region is `org` with no adopterDocs (CONTROL) and `adopter` with the file named on the a11ign/a11ign entry", () => {
  for (const file of DOCS) {
    const before = adopterRowKind([`a11ign:${file}`], WITHOUT);
    assert.equal(before.kind, "org", `CONTROL: ${file} is org without the key`);
    assert.match(String(before.because), new RegExp(`\`a11ign:${file.replace(/\./g, "\\.")}\` lies under no releasable path of an adopter-facing repository`), "the reason a filer reads is unchanged");
    assert.deepEqual(adopterRowKind([`a11ign:${file}`], WITH), { kind: "adopter", unreadable: false, because: null }, `${file} is adopter with it`);
  }
  assert.equal(adopterRowKind(["a11ign:README.md"], declared(["README.md"])).kind, "adopter", "the one-file declaration the row names");
  assert.equal(adopterRowKind(["a11ign:docs/try-it.md"], declared(["README.md"])).kind, "org", "a file the list does not name stays org");
  assert.equal(adopterRowKind(["a11ign:docs/try-it.md"], declared(["docs/"])).kind, "adopter", "a directory prefix covers what is under it, by `regionCovers`");
  assert.equal(adopterRowKind(["a11ign:docsite/x.md"], declared(["docs/"])).kind, "org", "and not what merely shares its spelling");
});

test("ONE entry under adopterDocs is enough, and the key is the repository's: a docs entry of another repository does not count", () => {
  assert.equal(adopterRowKind(["agent-org:docs/messaging.md", "a11ign:README.md"], WITH).kind, "adopter", "one of two entries");
  assert.equal(adopterRowKind(["toolchain:README.md"], WITH).kind, "org", "README.md under toolchain is not a11ign's README.md");
  assert.equal(adopterRowKind(["a11ign:README.md"], declared(DOCS, "a11ign/toolchain")).kind, "org", "adopterDocs on the toolchain entry says nothing about a11ign's");
  assert.equal(adopterRowKind(["a11ign:README.md"], { ...WITH, code: CODE.filter((code) => code.key !== "a11ign") }).kind, "org", "a repository `code` does not key is left out, never guessed");
  assert.equal(adopterRowKind(null, WITH).unreadable, true, "an unreadable Region stays unreadable");
});

test("the same Region under an adopterFacing: false repository stays org, and declaring adopterDocs on that entry is refused", () => {
  const onTooling = declared(["README.md"], "a11ign/lab"); // built by hand, past the parser
  assert.deepEqual(adopterRowKind(["lab:README.md"], onTooling).kind, "org", "the list on a tooling repository is not read");
  assert.match(String(adopterRowKind(["lab:README.md"], onTooling).because), /lies under no releasable path of an adopter-facing repository|adopterFacing: false/);
  assert.equal(adopterRowKind(["agent-org:README.md"], declared(["README.md"], "a11ign/agent-org")).kind, "org", "the tool's own entry is no adopter's either");
  const refused = () => parseProjectDeclaration(withDora({ repo: "a11ign/lab", adopterFacing: false, adopterDocs: ["README.md"] }), "fixture");
  assert.throws(refused, ProjectDeclarationRefusal);
  assert.throws(refused, /dora\[0\]\.adopterDocs.*adopterFacing: false/);
  assert.doesNotThrow(() => parseProjectDeclaration(withDora({ repo: "a11ign/lab", adopterFacing: true, adopterDocs: ["README.md"] }), "fixture"), "CONTROL: the same list on an adopter-facing entry parses");
});

test("primaryMilestoneRefusal refuses the docs-only Region without the key and returns null with it", () => {
  const body = "## Region\n\n```\na11ign:README.md\na11ign:docs/try-it.md\n```\n";
  const deps = { primaryMilestones: () => [PRIMARY], run: () => "" } as Any;
  const refused = primaryMilestoneRefusal(["--milestone", PRIMARY], body, TRACKERS[0] as Any, WITHOUT, deps);
  assert.match(String(refused), /REFUSING to file an org row into the primary milestone/);
  assert.match(String(refused), /`a11ign:README\.md` lies under no releasable path of an adopter-facing repository/);
  assert.equal(primaryMilestoneRefusal(["--milestone", PRIMARY], body, TRACKERS[0] as Any, WITH, deps), null);
  const code = "## Region\n\n```\na11ign:src/notes.md\n```\n";
  assert.notEqual(primaryMilestoneRefusal(["--milestone", PRIMARY], code, TRACKERS[0] as Any, WITH, deps), null, "a file the list does not name is still refused with the key declared");
});

const MILESTONE = { number: 8, title: PRIMARY, description: "Primary: yes" };
const openRow = (number: number, entries: string[]) => ({
  number, title: `row ${number}`, labels: [{ name: "ready" }], milestone: MILESTONE, createdAt: "2026-10-09T02:00:00Z", updatedAt: "2026-10-09T02:00:00Z",
  body: `## Region\n\n\`\`\`\n${entries.join("\n")}\n\`\`\`\n\n## Acceptance\n\n\`\`\`\nnpx rstest run\n\`\`\`\n`,
});
const NOW = Date.parse("2026-10-09T09:00:00Z");
const counted = (declaration: Any, rows: unknown[]) => milestoneClockFact({ openRowsRead: rows, prsRead: [], now: NOW, declaration })?.rows.map((row) => row.number);

test("milestoneClockFact counts the docs-only row with adopterDocs and not without; a code row counts either way", () => {
  const rows = [openRow(4529, ["a11ign:README.md"]), openRow(4530, ["a11ign:packages/cli/src/run.ts"]), openRow(4531, ["toolchain:README.md"])];
  assert.deepEqual(counted(WITHOUT, rows), [4530], "CONTROL: without the key only the code row counts");
  assert.deepEqual(counted(WITH, rows), [4529, 4530], "with it the docs row counts too, and the tooling row still does not");
});

test("isReleasable and isShipped answer the SAME for README.md with and without adopterDocs: not releasable either way", () => {
  const repository = (adopterDocs?: string[]) => ({ repo: "a11ign/a11ign", release: { kind: "tag" }, releasablePaths: ["packages/cli/"], ...(adopterDocs === undefined ? {} : { adopterDocs }) }) as Any;
  const countedFor = (repo: Any, paths: string[]): number => {
    const readers = {
      releases: () => [], regressions: () => [], range: () => ({ status: "ahead", commits: [] }),
      mergedPrs: () => [{ number: 13, mergedAt: "2026-10-09T03:27:00Z", mergeCommit: "a".repeat(40), paths }],
    } as Any;
    return JSON.stringify(measureRepository(repo, readers, NOW)).includes("\"changes\":1") ? 1 : 0;
  };
  for (const adopterDocs of [undefined, DOCS]) {
    const repo = repository(adopterDocs);
    for (const file of DOCS) {
      assert.equal(isShipped(file, repo.releasablePaths), false, `isShipped ${file} (adopterDocs ${adopterDocs === undefined ? "absent" : "named"})`);
      assert.equal(countedFor(repo, [file]), 0, `isReleasable ${file} (adopterDocs ${adopterDocs === undefined ? "absent" : "named"})`);
    }
    assert.equal(isShipped("packages/cli/src/run.ts", repo.releasablePaths), true, "positive control: a releasable path still ships");
    assert.equal(countedFor(repo, ["packages/cli/src/run.ts"]), 1, "positive control: and the DORA reading counts it");
  }
});

test("the 60% product share is NOT widened: productRegionsOf is deepEqual with and without adopterDocs, by choice", () => {
  assert.deepEqual(productRegionsOf(WITH), productRegionsOf(WITHOUT));
  assert.deepEqual(productRegionsOf(WITH).find((region) => region.key === "a11ign")?.paths, ["packages/cli/"], "positive control: the declared entry is read, and only by its releasablePaths");
});

test("no module but the milestone rule reads adopterDocs (a marker that notices the one reader, then finds the others empty)", () => {
  const src = join(import.meta.dirname, "..");
  const reads = (file: string) => readFileSync(join(src, file), "utf8").includes("adopterDocs");
  assert.equal(reads("work-gate/org-health.ts"), true, "positive control: the marker recognises the one reader");
  for (const file of ["dora.ts", "release-behind-main.ts", "work-gate.ts"]) assert.equal(reads(file), false, `${file} never reads adopterDocs`);
});

test("(declaration) adopterDocs is read when named, absent stays absent, and every malformed shape is refused naming dora[0].adopterDocs", () => {
  const parsed = parseProjectDeclaration(withDora({ adopterDocs: DOCS }), "fixture").dora[0];
  assert.deepEqual(parsed.adopterDocs, DOCS);
  assert.equal(Object.hasOwn(parseProjectDeclaration(withDora({}), "fixture").dora[0], "adopterDocs"), false, "absent stays absent: no key is added");
  assert.equal(Object.hasOwn(parseProjectDeclaration(withDora({ adopterFacing: true }), "fixture").dora[0], "adopterDocs"), false);
  for (const bad of ["README.md", [], [""], ["README.md", ""], [1], [null], { 0: "README.md" }, null, true]) {
    assert.throws(() => parseProjectDeclaration(withDora({ adopterDocs: bad }), "fixture"), /dora\[0\]\.adopterDocs.*non-empty list/, `refused: ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parseProjectDeclaration(withDora({ adopterFacing: false, adopterDocs: DOCS }), "fixture"), /dora\[0\]\.adopterDocs.*adopterFacing: false/);
});

test("(end to end) a parsed declaration carrying adopterDocs flows through adopterRowKind: the key is read from the file, not from a hand-built object", () => {
  const text = JSON.stringify({ ...PROJECT, code: [{ key: "a11ign", repo: "a11ign/a11ign" }, { key: "lab", repo: "a11ign/lab" }], dora: [
    { repo: "a11ign/a11ign", release: { kind: "tag" }, releasablePaths: ["packages/cli/"], adopterDocs: ["README.md"] },
    { repo: "a11ign/lab", release: { kind: "tag" }, releasablePaths: ["src/"], adopterFacing: false },
  ] });
  const parsed = parseProjectDeclaration(text, "fixture") as Any;
  assert.equal(adopterRowKind(["a11ign:README.md"], parsed).kind, "adopter");
  assert.equal(adopterRowKind(["a11ign:RELEASE.md"], parsed).kind, "org", "positive control: a file the parsed list does not name");
});
