// command: `npm run check:changed` -- one check of the change a worker is making: lint on the changed files, typecheck of the whole program, and the tests that cover it (A11-307)
//
// WHAT RAN IS PRINTED, WITH THE REASON. The change is everything since the merge base with the default branch: committed, staged, unstaged and untracked files together.
// Lint is ESLint with `--cache` on the changed files (`lint-cache.ts` keys the cache by the config, the lockfile and the plugin versions, so none of them can leave a stale pass).
// Typecheck is `tsc --noEmit` over the WHOLE program, incrementally (`node_modules/.cache/tsc`), because a type error is in the file that uses the changed one.
// Tests are every test file that imports a changed file at any depth, names its path, or is itself changed (`scripts/rstest/select-tests.ts`), never tests matched by name.
// A change the import graph cannot judge (the runner's files, a shared fixture, a config, the manifest, the lockfile) FALLS BACK: the whole suite and the whole lint run, and the output says which path did it.
//
// CI IS UNCHANGED AND IS THE GATE: it runs every suite on every push. This command is what a worker runs while it works, so that it does not re-run everything after each edit.
//
// THE SUITE NEEDS A PROJECT TO RUN AGAINST (`AGENT_ORG_HOST`, see AGENTS.md): when the caller has not set one, this makes the same copy of the fixture project CI's `suite` job makes, in a
// temporary directory it removes afterwards.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "../src/lib/git-env.ts";
import { eslintEntryOf, lintCacheDirectory, lintCacheKey, runKeyedEslint } from "./lint-cache.ts";
import { LINT_TARGETS } from "./lint.ts";
import { buildImporterMap, loadSources } from "./rstest/import-graph.ts";
import { type LintScope, selectLintScope, selectTests, suiteTestFiles, type TestSelection } from "./rstest/select-tests.ts";

const SOURCE_FILE = /\.(ts|tsx|mjs|js)$/;
const GRAPH_ROOTS = ["src/", "plugins/", "scripts/"] as const;
const RSTEST_CONFIG = "scripts/rstest/rstest.config.ts";
const FIXTURE_PROJECT = "src/packaging/fixtures/project-tree";
const DEFAULT_BRANCHES = ["origin/main", "main"] as const;

/** Everything one run decided before it ran anything. */
export interface CheckPlan { base: string; changed: string[]; lint: LintScope; tests: TestSelection }

const git = (root: string, args: readonly string[]): string => {
  const result = spawnSync("git", args, { cwd: root, env: sandboxGitEnv(), encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
};
const lines = (text: string): string[] => text.split("\n").filter(Boolean);

/** The merge base of HEAD with the default branch (`origin/main`, else `main`), or with `base` when the caller names one. */
export function mergeBaseOf(root: string, base?: string): string {
  const candidates = base === undefined ? DEFAULT_BRANCHES : [base];
  for (const candidate of candidates) {
    const result = spawnSync("git", ["merge-base", "HEAD", candidate], { cwd: root, env: sandboxGitEnv(), encoding: "utf8" });
    if (result.status === 0) return result.stdout.trim();
  }
  throw new Error(`no merge base: none of ${candidates.join(", ")} is a commit here. Pass --base <ref>.`);
}

/** Every path changed since `base`: committed, staged and unstaged (a rename counts both sides), plus untracked files. Sorted, once each. */
export function changedSince(root: string, base: string): string[] {
  const tracked = lines(git(root, ["diff", "--name-only", "--no-renames", base]));
  const untracked = lines(git(root, ["ls-files", "--others", "--exclude-standard"]));
  return [...new Set([...tracked, ...untracked])].sort();
}

/** The lint scope: the changed files, or the whole tree when a lint input changed or the suite fell back (a whole-tree lint with a warm cache re-lints only what changed). */
function lintScopeFor(changed: string[], present: ReadonlySet<string>, tests: TestSelection): LintScope {
  const scope = selectLintScope(changed, present);
  return scope.kind === "files" && tests.kind === "fallback" ? { kind: "fallback", fallbacks: tests.fallbacks } : scope;
}

/** Decide what to run for `changed` (repo-relative) in the repository at `root`. */
export function planChecks(root: string, base: string, changed: string[]): CheckPlan {
  const present = lines(git(root, ["ls-files", "--cached", "--others", "--exclude-standard"]));
  const sources = loadSources(root, present.filter((path) => SOURCE_FILE.test(path) && GRAPH_ROOTS.some((dir) => path.startsWith(dir))));
  const tests = selectTests({ changed, testFiles: suiteTestFiles(present), importers: buildImporterMap(root, sources), sources });
  return { base, changed, lint: lintScopeFor(changed, new Set(present), tests), tests };
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The lines that say what will run and why. */
export function describePlan(plan: CheckPlan, root: string): string[] {
  const out = [`check:changed against ${plan.base.slice(0, 10)}: ${plural(plan.changed.length, "changed file")}`];
  if (plan.lint.kind === "fallback") {
    out.push("lint: FALLBACK, the whole tree", ...plan.lint.fallbacks.map((fallback) => `  ${fallback.path}: ${fallback.why}`));
  } else {
    out.push(`lint: ${plural(plan.lint.files.length, "changed file")}, cache ${lintCacheDirectory(".", lintCacheKey(root))}`);
  }
  out.push("typecheck: the whole program (tsc --noEmit, incremental in node_modules/.cache/tsc)");
  if (plan.tests.kind === "fallback") {
    out.push("tests: FALLBACK, the whole suite", ...plan.tests.fallbacks.map((fallback) => `  ${fallback.path}: ${fallback.why}`));
  } else {
    out.push(`tests: ${plan.tests.tests.length} selected`, ...plan.tests.tests.map((test) => `  ${test.file}: ${test.why}`));
    out.push(...plan.tests.unreached.map((path) => `  (no test imports or names ${path})`));
  }
  return out;
}

/** The project CI's `suite` job runs the suite against: the committed fixture copied out, `git init`ed and committed, its host declaration naming the copy. Returns the host file's path. */
export function layFixtureProject(root: string, into: string): string {
  cpSync(join(root, FIXTURE_PROJECT), into, { recursive: true });
  const hostFile = join(into, ".agent-org", "host.json");
  writeFileSync(hostFile, readFileSync(hostFile, "utf8").replaceAll("@@PROJECT@@", into));
  git(into, ["init", "-q"]);
  git(into, ["add", "-A"]);
  git(into, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "the fixture project"]);
  return hostFile;
}

const spawnInherit = (root: string, command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): number =>
  spawnSync(command, args, { cwd: root, env, stdio: "inherit" }).status ?? 1;

function runLint(root: string, scope: LintScope): number {
  if (scope.kind === "files" && scope.files.length === 0) return 0;
  const targets = scope.kind === "fallback" ? LINT_TARGETS : scope.files;
  return runKeyedEslint({ root, eslintEntry: eslintEntryOf(root), targets }).status;
}

/** Run the selected tests (or the whole suite) against the fixture project, which is removed afterwards unless the caller brought its own. */
function runTests(root: string, selection: TestSelection): number {
  const files = selection.kind === "selected" ? selection.tests.map((test) => test.file) : [];
  if (selection.kind === "selected" && files.length === 0) return 0;
  const scratch = process.env.AGENT_ORG_HOST === undefined ? mkdtempSync(join(tmpdir(), "check-changed-")) : null;
  try {
    const env = scratch === null ? process.env : { ...process.env, AGENT_ORG_HOST: layFixtureProject(root, join(scratch, "project")) };
    return spawnInherit(root, join(root, "node_modules", ".bin", "rstest"), ["run", "--config", RSTEST_CONFIG, ...files], env);
  } finally {
    if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  }
}

/** Run every stage whatever the one before it did, so a single run reports every failure. Returns the failed stages. */
export function executePlan(root: string, plan: CheckPlan): string[] {
  const stages: Array<[string, () => number]> = [
    ["lint", () => runLint(root, plan.lint)],
    ["typecheck", () => spawnInherit(root, "npm", ["run", "--silent", "typecheck"])],
    ["tests", () => runTests(root, plan.tests)],
  ];
  return stages.filter(([name, run]) => {
    console.log(`\n== ${name} ==`);
    return run() !== 0;
  }).map(([name]) => name);
}

/** The CLI: `check-changed.ts [--base <ref>] [--plan]`. `--plan` prints what would run and runs nothing. */
export function main(argv: readonly string[], root: string): number {
  const baseAt = argv.indexOf("--base");
  const unknown = argv.filter((arg, at) => arg !== "--plan" && arg !== "--base" && at !== baseAt + 1);
  if (unknown.length > 0 || (baseAt !== -1 && argv[baseAt + 1] === undefined)) {
    console.error("usage: npm run check:changed -- [--base <ref>] [--plan]");
    return 2;
  }
  const base = mergeBaseOf(root, baseAt === -1 ? undefined : argv[baseAt + 1]);
  const plan = planChecks(root, base, changedSince(root, base));
  console.log(describePlan(plan, root).join("\n"));
  if (argv.includes("--plan")) return 0;
  const failed = executePlan(root, plan);
  console.log(failed.length === 0 ? "\ncheck:changed: passed" : `\ncheck:changed: FAILED: ${failed.join(", ")}`);
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && existsSync(process.argv[1]) && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2), join(dirname(fileURLToPath(import.meta.url)), "..")));
}
