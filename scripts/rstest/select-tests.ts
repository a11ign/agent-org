// module: which checks cover a change -- the test files, and the lint scope -- for `npm run check:changed` (A11-307)
//
// THE SELECTION IS MEANT TO NEVER MISS A TEST THAT COVERS THE CHANGE, and where it cannot know, it says so and runs everything. A test is selected when it
// is itself changed, imports a changed file directly or through the import graph, or names a changed file's path (`import-graph.ts`). It is never selected by its name.
// A change the graph cannot follow -- a fixture every test copies, the runner's own files, a config, the manifest, the lockfile, the CI workflows -- FALLS BACK:
// the whole suite (and, for the lint inputs, the whole lint) runs. Each fallback names the path and the reason, so the output says why it ran what it ran.
//
// CI RUNS EVERY SUITE ON EVERY PUSH, AND REMAINS THE GATE (`.github/workflows/ci.yml` is not changed by this). This file only decides what a worker runs while it works.
import { filesReaching, type ImporterMap, type Reach, type SourceText } from "./import-graph.ts";

const TEST_FILE = /\.test\.(ts|tsx|mjs)$/;
const MODULE_FILE = /\.(ts|tsx|mjs|js)$/;
const LINTED_FILE = /\.(ts|tsx|astro)$/;
const LINTED_ROOTS = ["src/", "scripts/", "plugins/", "ui/"] as const;
const IGNORED_FOR_LINT = ["ui/dist/", "ui/.astro/", "ui/node_modules/"] as const;
/** The directories the root suite's `include` globs reach (`scripts/rstest/rstest.config.ts`); a test in `ui/` runs under `pnpm ui:test`, not here. */
const SUITE_ROOTS = ["src/", "plugins/"] as const;
/** Paths a change to which can only be judged by running the code, not by reading it: data, notes and shell a test may read by a path it builds. */
const OPAQUE_ROOTS = ["src/", "plugins/", "scripts/", "host/"] as const;
/** Paths no test in the root suite reads by a path it builds: notes, changesets, and the UI package (which has its own `pnpm ui:test`). A change that is only these selects no test. */
const NOT_READ_BY_ROOT_SUITE = [/^\.changeset\//, /^\.acceptance\//, /^docs\//, /^CHANGELOG\.md$/, /^LICENSE$/, /^README\.md$/, /^AGENTS\.md$/, /^CLAUDE\.md$/, /^ui\//];

/** One reason the whole suite runs: the changed path, and why the import graph cannot judge it. */
export interface Fallback { path: string; why: string }

/**
 * The files the rstest config loads outside any test's imports (`globalSetup` and `setupFiles`). A test never imports them, so the graph does not reach them
 * from a test, and `check-changed-selection.test.ts` holds this list equal to the config's.
 */
export const RUNNER_SETUP_FILES = ["src/private-tmp.ts", "src/private-tmp-setup.ts", "src/offline-setup.ts"] as const;

const FALLBACK_RULES: ReadonlyArray<{ matches: (path: string) => boolean; why: string }> = [
  { matches: (path) => path.startsWith("scripts/rstest/"), why: "the test runner's own files: every test runs through them" },
  { matches: (path) => RUNNER_SETUP_FILES.some((setup) => setup === path), why: "the runner loads it into every test's worker, and no test imports it" },
  { matches: (path) => path === "package.json" || path === "pnpm-lock.yaml", why: "the manifest and the lockfile decide what every test runs against" },
  { matches: (path) => /(^|\/)tsconfig[^/]*\.json$/.test(path) || /(^|\/)[^/]+\.config\.(ts|mjs|js|json)$/.test(path), why: "a config applies to every file" },
  { matches: (path) => /(^|\/)fixtures?\//.test(path), why: "a shared fixture: any test may copy or read it by a path it builds" },
  { matches: (path) => path.startsWith(".github/") || path === ".npmrc" || path === ".gitignore", why: "CI and repository settings: tests read the workflows and the tree" },
];

/** The lint inputs whose change drops the lint cache and, with it, the narrow scope: the config, the manifest and the lockfile. */
const LINT_FALLBACK_PATHS = ["eslint.config.ts", "package.json", "pnpm-lock.yaml"] as const;

const isUnder = (path: string, roots: readonly string[]): boolean => roots.some((root) => path.startsWith(root));
const isNotReadByRootSuite = (path: string): boolean => NOT_READ_BY_ROOT_SUITE.some((pattern) => pattern.test(path));

/** Why `path` makes the whole suite run, or null when the graph can judge it. */
export function fallbackReasonFor(path: string): string | null {
  return FALLBACK_RULES.find((rule) => rule.matches(path))?.why ?? null;
}

/**
 * A changed path no import and no test naming it can account for, and that the suite may still read at run time: a non-module file under the source roots.
 * Notes and the UI package are not that (nothing in the root suite reads them by a built path), so they select nothing and say so.
 */
const isOpaqueData = (path: string): boolean => !MODULE_FILE.test(path) && !isNotReadByRootSuite(path) && isUnder(path, OPAQUE_ROOTS);

/** One selected test, with the reason a reader can check. */
export interface SelectedTest { file: string; why: string }

/** The test files that cover the change, or the reasons the whole suite must run. */
export type TestSelection =
  | { kind: "fallback"; fallbacks: Fallback[] }
  | { kind: "selected"; tests: SelectedTest[]; unreached: string[] };

const describeReach = (reach: Reach): string => {
  const [nearest, ...rest] = reach.via;
  if (reach.kind === "names") return rest.length === 0 ? `names the path of ${reach.changed} (changed)` : `imports ${nearest}, which leads to ${reach.changed} (changed), whose path it names`;
  return rest.length === 0 ? `imports ${reach.changed} (changed)` : `imports ${reach.changed} (changed) through ${reach.via.slice(0, -1).join(" -> ")}`;
};

/**
 * Select the tests that cover `changed` (repo-relative paths, deleted ones included). `testFiles` is every test file in the suite; a test that is itself in `changed`
 * is selected whatever it imports.
 */
export function selectTests(args: { changed: readonly string[]; testFiles: readonly string[]; importers: ImporterMap; sources: readonly SourceText[] }): TestSelection {
  const { changed, testFiles, importers, sources } = args;
  const fallbacks = changed.flatMap((path) => {
    const why = fallbackReasonFor(path);
    return why === null ? [] : [{ path, why }];
  });
  if (fallbacks.length > 0) return { kind: "fallback", fallbacks };

  const suite = new Set(testFiles);
  const reached = filesReaching(importers, sources, changed);
  const tests: SelectedTest[] = changed.filter((path) => suite.has(path)).map((file) => ({ file, why: "changed itself" }));
  const chosen = new Set(tests.map((test) => test.file));
  for (const file of testFiles) {
    const reach = reached.get(file);
    if (reach !== undefined && !chosen.has(file)) tests.push({ file, why: describeReach(reach) });
  }
  const reachedFrom = new Set([...reached.values()].map((reach) => reach.changed));
  const opaque = changed.filter((path) => isOpaqueData(path) && !reachedFrom.has(path));
  if (opaque.length > 0) {
    return { kind: "fallback", fallbacks: opaque.map((path) => ({ path, why: "no test imports or names it, and it is data the suite may read by a path it builds" })) };
  }
  const unreached = changed.filter((path) => !suite.has(path) && !reachedFrom.has(path));
  return { kind: "selected", tests: tests.sort((a, b) => a.file.localeCompare(b.file)), unreached };
}

/** Keep only the tests the root suite's `include` globs reach: `src/` and `plugins/`. */
export const suiteTestFiles = (paths: readonly string[]): string[] => paths.filter((path) => TEST_FILE.test(path) && isUnder(path, SUITE_ROOTS));

/** The lint scope: the changed files ESLint has a config for, or the whole tree when a lint input changed. */
export type LintScope = { kind: "fallback"; fallbacks: Fallback[] } | { kind: "files"; files: string[] };

/** `existing` is the set of paths still on disk: a deleted file has nothing to lint. */
export function selectLintScope(changed: readonly string[], existing: ReadonlySet<string>): LintScope {
  const fallbacks = changed
    .filter((path) => LINT_FALLBACK_PATHS.some((input) => input === path))
    .map((path) => ({ path, why: "it is an input of the lint cache and of every rule's result" }));
  if (fallbacks.length > 0) return { kind: "fallback", fallbacks };
  const files = changed.filter((path) => existing.has(path) && LINTED_FILE.test(path) && isUnder(path, LINTED_ROOTS) && !isUnder(path, IGNORED_FOR_LINT));
  return { kind: "files", files };
}
