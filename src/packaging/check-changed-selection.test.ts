// no-token: none -- reads and writes files in temporary directories and runs `git` in repositories this file builds; nothing reaches `gh`, `herdr` or the network
/**
 * `npm run check:changed` CHECKS A CHANGE AND NOT THE WHOLE TREE (A11-307), AND THE TESTS IT SELECTS CANNOT MISS ONE THAT COVERS THE CHANGE.
 *
 * `scripts/rstest/import-graph.ts` and `select-tests.ts` choose the test files. Each case here builds a small tree in a temporary directory and names what is selected, and why:
 *   - a leaf module's change selects every test that imports it, directly or through any number of files (the three-hop chain is the case a one-hop walk fails);
 *   - a changed test runs itself, a test that names a changed file's path runs, a deleted file is still found through the specifier its importers kept;
 *   - a change the graph cannot follow FALLS BACK to the whole suite, one case per fallback, and the runner's setup files equal the rstest config's (a new one cannot be forgotten);
 *   - the lint scope is the changed files ESLint has a config for, and the whole tree when a lint input changed;
 *   - on a real git repository: committed, staged, unstaged, untracked and deleted files are all changed, and the output says which test ran for which reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { testEach } from "../lib/test-each.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import rstestConfig from "../../scripts/rstest/rstest.config.ts";
import { buildImporterMap, loadSources } from "../../scripts/rstest/import-graph.ts";
import { fallbackReasonFor, RUNNER_SETUP_FILES, selectLintScope, selectTests, suiteTestFiles, type TestSelection } from "../../scripts/rstest/select-tests.ts";
import { changedSince, describePlan, mergeBaseOf, planChecks } from "../../scripts/check-changed.ts";

type Tree = Record<string, string>;

/** Write `files` under a new temporary directory and return it. */
function writeTree(files: Tree): string {
  const root = tmpDir("check-changed-tree-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Select the tests for `changed` over a tree of `files`; a path in `changed` that is not in `files` is a deleted file. */
function select(files: Tree, changed: string[]): TestSelection {
  const root = writeTree(files);
  const paths = Object.keys(files).filter((path) => /\.(ts|mjs)$/.test(path));
  const sources = loadSources(root, paths);
  return selectTests({ changed, testFiles: suiteTestFiles(paths), importers: buildImporterMap(root, sources), sources });
}

const selectedFiles = (selection: TestSelection): string[] => {
  assert.equal(selection.kind, "selected", `expected a selection, got ${JSON.stringify(selection)}`);
  return selection.kind === "selected" ? selection.tests.map((entry) => entry.file) : [];
};

const CHAIN: Tree = {
  "src/leaf.ts": "export const leaf = 1;\n",
  "src/mid.ts": 'import { leaf } from "./leaf.ts";\nexport const mid = leaf + 1;\n',
  "src/top.ts": 'import { mid } from "./mid.ts";\nexport const top = mid + 1;\n',
  "src/direct.test.ts": 'import { leaf } from "./leaf.ts";\nleaf;\n',
  "src/deep.test.ts": 'import { top } from "./top.ts";\ntop;\n',
  "src/unrelated.test.ts": 'import { other } from "./other.ts";\nother;\n',
  "src/other.ts": "export const other = 1;\n",
};

test("a leaf module's change selects the tests that import it directly and the ones that reach it through any number of files, and no other", () => {
  assert.deepEqual(selectedFiles(select(CHAIN, ["src/leaf.ts"])), ["src/deep.test.ts", "src/direct.test.ts"]);
});

test("a test that reaches the leaf three hops away says through which files", () => {
  const selection = select(CHAIN, ["src/leaf.ts"]);
  assert.equal(selection.kind, "selected");
  const why = selection.kind === "selected" ? selection.tests.find((entry) => entry.file === "src/deep.test.ts")?.why : undefined;
  assert.equal(why, "imports src/leaf.ts (changed) through src/top.ts -> src/mid.ts");
});

test("a changed test file runs itself even when it imports nothing that changed", () => {
  assert.deepEqual(selectedFiles(select(CHAIN, ["src/unrelated.test.ts"])), ["src/unrelated.test.ts"]);
});

test("a test that imports a test helper is selected when the helper's own import changes", () => {
  const files: Tree = { ...CHAIN, "src/helper.test.ts": 'import { leaf } from "./leaf.ts";\nleaf;\n' };
  assert.deepEqual(selectedFiles(select(files, ["src/leaf.ts"])), ["src/deep.test.ts", "src/direct.test.ts", "src/helper.test.ts"]);
});

test("an import inside a comment is not an edge", () => {
  const files: Tree = { ...CHAIN, "src/commented.test.ts": '// import { leaf } from "./leaf.ts";\n/* import("./leaf.ts") */\nexport {};\n' };
  assert.deepEqual(selectedFiles(select(files, ["src/leaf.ts"])), ["src/deep.test.ts", "src/direct.test.ts"]);
});

test("an export-from and a dynamic import are edges", () => {
  const files: Tree = {
    "src/leaf.ts": "export const leaf = 1;\n",
    "src/barrel.ts": 'export * from "./leaf.ts";\n',
    "src/barrel.test.ts": 'import { leaf } from "./barrel.ts";\nleaf;\n',
    "src/lazy.test.ts": 'const load = () => import("./leaf.ts");\nload;\n',
  };
  assert.deepEqual(selectedFiles(select(files, ["src/leaf.ts"])), ["src/barrel.test.ts", "src/lazy.test.ts"]);
});

test("an extensionless specifier and a directory's index are resolved", () => {
  const files: Tree = {
    "src/lib/index.ts": "export const lib = 1;\n",
    "src/x.mjs": "export const x = 1;\n",
    "src/a.test.ts": 'import { lib } from "./lib";\nlib;\n',
    "src/b.test.ts": 'import { x } from "./x";\nx;\n',
  };
  assert.deepEqual(selectedFiles(select(files, ["src/lib/index.ts"])), ["src/a.test.ts"]);
  assert.deepEqual(selectedFiles(select(files, ["src/x.mjs"])), ["src/b.test.ts"]);
});

test("a deleted file is found through the specifier its importers still carry", () => {
  const files: Tree = { ...CHAIN };
  delete files["src/leaf.ts"];
  assert.deepEqual(selectedFiles(select(files, ["src/leaf.ts"])), ["src/deep.test.ts", "src/direct.test.ts"]);
});

test("a test that names a changed data file's path is selected for it, and a data file nothing names falls back", () => {
  const reader: Tree = { "src/reader.test.ts": 'import { readFileSync } from "node:fs";\nreadFileSync("src/skills/note.md");\n' };
  assert.deepEqual(selectedFiles(select({ ...reader, "src/skills/note.md": "x\n" }, ["src/skills/note.md"])), ["src/reader.test.ts"]);
  const orphan = select({ ...reader, "src/skills/other.md": "x\n" }, ["src/skills/other.md"]);
  assert.equal(orphan.kind, "fallback");
});

test("a test that imports a changed test helper's data reader reaches it through the helper", () => {
  const files: Tree = {
    "src/lib/reads-note.ts": 'export const note = "src/skills/note.md";\n',
    "src/skills.test.ts": 'import { note } from "./lib/reads-note.ts";\nnote;\n',
  };
  assert.deepEqual(selectedFiles(select(files, ["src/lib/reads-note.ts"])), ["src/skills.test.ts"]);
});

test("notes, changesets and the UI package select no test and do not fall back", () => {
  for (const path of [".changeset/a-change.md", ".acceptance/a-branch.md", "docs/guide.md", "README.md", "AGENTS.md", "ui/src/page.astro"]) {
    const selection = select(CHAIN, [path]);
    assert.deepEqual(selectedFiles(selection), [], path);
    assert.deepEqual(selection.kind === "selected" ? selection.unreached : [], [path]);
  }
});

/** One fallback per case: the whole suite runs, and the output names the path and why. */
const FALLBACKS = [
  { name: "a shared fixture project", path: "src/packaging/fixtures/project-tree/package.json" },
  { name: "a shared fixture beside the install tests", path: "src/install/fixtures/host.json" },
  { name: "the rstest config", path: "scripts/rstest/rstest.config.ts" },
  { name: "the selection itself", path: "scripts/rstest/select-tests.ts" },
  { name: "the import graph", path: "scripts/rstest/import-graph.ts" },
  { name: "package.json", path: "package.json" },
  { name: "the lockfile", path: "pnpm-lock.yaml" },
  { name: "the ESLint config", path: "eslint.config.ts" },
  { name: "the TypeScript config", path: "tsconfig.json" },
  { name: "a workflow", path: ".github/workflows/ci.yml" },
  ...RUNNER_SETUP_FILES.map((path) => ({ name: `the runner's setup file ${path}`, path })),
];

testEach("a change the graph cannot follow runs the whole suite", FALLBACKS, ({ path }) => {
  const selection = select(CHAIN, ["src/leaf.ts", path]);
  assert.equal(selection.kind, "fallback");
  assert.deepEqual(selection.kind === "fallback" ? selection.fallbacks.map((fallback) => fallback.path) : [], [path]);
  assert.match(fallbackReasonFor(path) ?? "", /\S/);
});

test("the runner's setup files are the rstest config's globalSetup and setupFiles", () => {
  const config = rstestConfig as { globalSetup?: string[]; setupFiles?: string[] };
  assert.deepEqual([...RUNNER_SETUP_FILES].sort(), [...(config.globalSetup ?? []), ...(config.setupFiles ?? [])].sort());
});

test("a source file that only a test imports is not a fallback, and a file under scripts/ other than the runner's is followed by the graph", () => {
  assert.equal(fallbackReasonFor("src/lib/test-each.ts"), null);
  assert.equal(fallbackReasonFor("scripts/ui-asset.ts"), null);
});

test("the lint scope is the changed files ESLint lints, and a deleted or non-source file is left out", () => {
  const existing = new Set(["src/a.ts", "ui/src/b.tsx", "ui/src/c.astro", "README.md", "ui/dist/d.ts", "docs/x.ts"]);
  const changed = ["src/a.ts", "src/deleted.ts", "ui/src/b.tsx", "ui/src/c.astro", "README.md", "ui/dist/d.ts", "docs/x.ts"];
  assert.deepEqual(selectLintScope(changed, existing), { kind: "files", files: ["src/a.ts", "ui/src/b.tsx", "ui/src/c.astro"] });
});

testEach("a change to a lint input lints the whole tree", [{ name: "the config", path: "eslint.config.ts" }, { name: "the manifest", path: "package.json" }, { name: "the lockfile", path: "pnpm-lock.yaml" }], ({ path }) => {
  const scope = selectLintScope(["src/a.ts", path], new Set(["src/a.ts", path]));
  assert.equal(scope.kind, "fallback");
  assert.deepEqual(scope.kind === "fallback" ? scope.fallbacks.map((fallback) => fallback.path) : [], [path]);
});

/** A git repository holding `files` on `main`, with a `feature` branch checked out. */
function repository(files: Tree): { root: string; git: (...args: string[]) => string } {
  const root = writeTree(files);
  const env = sandboxGitEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
  const git = (...args: string[]): string => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, env, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("add", "-A");
  git("commit", "--quiet", "-m", "base");
  git("checkout", "--quiet", "-b", "feature");
  return { root, git };
}

test("the changed files are every path since the merge base: committed, staged, unstaged, untracked and deleted", () => {
  const { root, git } = repository({ ...CHAIN, "src/gone.ts": "export const gone = 1;\n", "src/staged.ts": "export const s = 1;\n", "src/loose.ts": "export const l = 1;\n" });
  writeFileSync(join(root, "src/leaf.ts"), "export const leaf = 2;\n");
  git("commit", "--quiet", "-am", "committed");
  writeFileSync(join(root, "src/staged.ts"), "export const s = 2;\n");
  git("add", "src/staged.ts");
  writeFileSync(join(root, "src/loose.ts"), "export const l = 2;\n");
  writeFileSync(join(root, "src/new.ts"), "export const n = 1;\n");
  rmSync(join(root, "src/gone.ts"));
  assert.deepEqual(changedSince(root, mergeBaseOf(root, "main")), ["src/gone.ts", "src/leaf.ts", "src/loose.ts", "src/new.ts", "src/staged.ts"]);
});

test("a base that is not a commit is refused with the flag that fixes it", () => {
  const { root } = repository(CHAIN);
  assert.throws(() => mergeBaseOf(root, "no-such-branch"), /Pass --base <ref>/);
});

/** The lines `describePlan` prints for the change in `root` since `main`. */
function planLines(root: string): string[] {
  const base = mergeBaseOf(root, "main");
  return describePlan(planChecks(root, base, changedSince(root, base)), root);
}

test("the plan for a leaf change lists the tests it will run and why, the lint scope, and the whole-program typecheck", () => {
  const { root } = repository(CHAIN);
  writeFileSync(join(root, "src/leaf.ts"), "export const leaf = 2;\n");
  const lines = planLines(root);
  assert.match(lines[1], /^lint: 1 changed file, cache node_modules\/\.cache\/eslint\/[0-9a-f]{16}$/);
  assert.deepEqual(lines.slice(2), [
    "typecheck: the whole program (tsc --noEmit, incremental in node_modules/.cache/tsc)",
    "tests: 2 selected",
    "  src/deep.test.ts: imports src/leaf.ts (changed) through src/top.ts -> src/mid.ts",
    "  src/direct.test.ts: imports src/leaf.ts (changed)",
  ]);
});

/** A changed lint input falls the suite back too; a changed fixture falls the suite back and, with it, the lint (a warm cache makes the whole-tree lint cheap). */
const FALLBACK_PLANS = [
  { name: "a lint input", path: "package.json" },
  { name: "a shared fixture", path: "src/packaging/fixtures/project-tree/README.md" },
];

testEach("the plan for a fallback says the whole suite and the whole tree run, and names the path that did it", FALLBACK_PLANS, ({ path }) => {
  const { root } = repository({ ...CHAIN, [path]: "base\n" });
  writeFileSync(join(root, path), "changed\n");
  const lines = planLines(root);
  assert.ok(lines.includes("lint: FALLBACK, the whole tree"), lines.join("\n"));
  assert.ok(lines.includes("tests: FALLBACK, the whole suite"), lines.join("\n"));
  assert.ok(lines.some((line) => line.startsWith(`  ${path}: `)), lines.join("\n"));
});
