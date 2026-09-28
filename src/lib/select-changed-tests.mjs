#!/usr/bin/env node
// COPIED FROM `scripts/select-changed-tests.mjs` at 598e883cc (#2623, child 5 of #69; ADR 0040, decision 4): the tool's own copy, so `agent-org` imports nothing outside
// its package. The product keeps its original and the two can drift, with no cross-repository pin: `agent-org-outward-edges.test.ts` compares them.
// CHANGED FROM THE ORIGINAL, 7 NAMED LINES:
// - its import of cli-flags.mjs, now the tool's own copy beside it
// - its import of git-env.mjs, now the tool's own copy beside it
// - its import of changed-files.mjs, now the tool's own copy beside it
// - its import of walk-scope-declaration.mjs, now the tool's own copy beside it
// - its import of @a11ign/evidence/source-text, now the tool's own copy beside it
// - node:fs import, adding realpathSync (#1086: the entry guard below needs it)
// - its entry guard, now realpath'd (#1086: the plain form is a known-bad ratchet baseline; a NEW file
//   must not add to it, so this copy does not inherit the original's still-grandfathered form)
// ==== end of copy header ====
// @ts-check
// command: pick only the test files that reference a changed file, narrower than package scoping
// A1B: THE PR `ts` JOB AND `trunk-guard` RAN THE SAME SUITE, TWICE, ON EVERY MERGE.
//
// Chairman, verbatim: "the trunk guard is running all of the unit tests. this takes just as long as the
// pr one. so we should change the pr unit tests to only run on the files changed for pr efficiency and
// ci efficiency." Measured: PR `ts` 83-155s, `trunk-guard` 144-155s -- close enough that the existing
// PACKAGE-level scoping (`ci-changed.mjs`'s `testPackages`, the transitive closure of dependent
// PACKAGES) was not narrowing much: a change to a package many others depend on already selects nearly
// every test in the repo at package granularity, even when only one FILE in it actually matters.
//
// THIS FILE NARROWS ONE STEP FURTHER, TO FILES: which TEST FILES actually reference -- directly, or
// through any number of other files -- a changed file. `ci-changed.mjs`'s package-level `testPackages` is
// still the SEARCH SCOPE and the SAFETY NET (unchanged): this only refines what runs WITHIN it.
//
// A1C: PACKAGE SOURCE WAS NEVER THE ONLY THING A TEST CAN DEPEND ON. A1b covered `packages/*/src/` by
// IMPORT and left everything else to a single `BROAD` fallback -- correct, but wide enough that the
// chairman opened a git-hook PR (#479, `scripts/git-hooks/pre-push`) expecting the narrow path and saw
// the full suite, because every conflict-fix row in flight that night was exactly this shape. Two more
// reference kinds are covered now, so `BROAD` narrows to what genuinely has no better answer:
//
//   `scripts/*.mjs`            BY IMPORT -- the SAME reverse index as packages/*/src/, since
//                              `sourceClosure`'s relative-import walk was never package-restricted; a
//                              test reaching `scripts/foo.mjs` via `../../../../scripts/foo.mjs` was
//                              already IN the index, just never looked up for a script's own changes.
//   hooks, workflow files      BY PATH STRING -- `scripts/git-hooks/pre-push` has no extension a module
//   (other than ci.yml)        resolver would ever touch, and `.github/workflows/*.yml` is never
//                              `import`ed, so no walk can reach them. `pathStringReferences` searches
//                              comment-stripped test source for the changed file's path inside a real
//                              quoted literal -- never a bare substring match against the WHOLE file,
//                              which would also fire on a doc comment merely discussing the path (this
//                              repo's own `` `scripts/foo.mjs` `` markdown convention). A test that
//                              DISCUSSES a file is not a test that exercises it.
//
// `BROAD` now applies to exactly two things: `.github/workflows/ci.yml` itself (a job definition can
// affect anything the job runs) and `ci-changed.mjs`'s own `ROOT_TS_FILES` (a root config or lockfile
// change that touches how everything builds). Reused from there rather than a second hand-typed list --
// this file's own most-repeated lesson, one row up.
//
// THE ZERO-TESTS FALLBACK IS THE LOAD-BEARING HALF, not the narrowing. "Run only what changed" is the
// easy half; "notice when that set is empty and say so" is what stops this shipping as a job that passes
// having run nothing -- CLAUDE.md's own most-recorded defect, and this is the job that gates every PR. A
// changed `packages/*/src/` file no test's import closure reaches falls back to ITS OWN PACKAGE's full
// suite; a changed `scripts/*.mjs` or hook/workflow file with no reference anywhere falls back to EVERY
// implicated package's full suite (there is no "its own package" for a file outside `packages/`) --
// either way, named, never silent.
//
// THE WALK MUST BE TRANSITIVE OR THE ROW IS WORSE THAN USELESS. A source file with no test of its own,
// imported by a test three hops away, must still select that test -- `sourceClosure` below walks the
// full reachable set from each test file, not one level of its own imports.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stripComments } from "./source-text.ts";
import { refuseUnknownFlags, flagValue } from "./cli-flags.mjs";
import { sandboxGitEnv } from "./git-env.mjs";
import { changedFiles } from "./changed-files.mjs";
import { knownPackages, readWorkspaceDependencyGraph, classify, ROOT_TS_FILES } from "./ci-changed.mjs";
// The parser only: importing `walk-scope.mjs` would install its read observer in this process.
import { parseWalkScope, inScope } from "./walk-scope-declaration.mjs";

/**
 * `import ... from "<spec>"` specifiers, in source order -- identical regex to
 * `pre-install-import-graph.test.ts`'s `specifiersOf`, which this repo already relies on to find every
 * import a script or test carries, `from` included as optional for a bare `import "./side-effect.mjs"`.
 *
 * #1527: AND `import("<spec>")`, the DYNAMIC form. The static regex needs whitespace after `import`, so
 * `await import("../../scripts/check-real-page-findings.ts")` (`relocated-fixture-key.test.ts`) yielded no
 * specifier, the walk never reached the script, and a change to it never selected that test (#1526).
 * @param {string} source
 * @returns {string[]}
 */
function specifiersOf(source) {
  const staticSpecs = [...source.matchAll(/\bimport\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g)].map((m) => m[1]);
  const dynamicSpecs = [...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  return [...staticSpecs, ...dynamicSpecs];
}

/**
 * Every `@a11ign/*` (and the unscoped `a11ign`) package's own name -> { dir, exportsMap }, so a bare
 * workspace specifier can be resolved back to a SOURCE file rather than the `dist/*.js` its own
 * `exports` field actually points a real Node resolution at -- this walk answers "what does a test
 * import", which for a workspace package means its SOURCE, not its build output.
 * @param {string} repoRoot
 * @param {string[]} packageDirs
 * @returns {Map<string, { dir: string, exportsMap: Record<string, unknown> }>}
 */
export function packageIndex(repoRoot, packageDirs) {
  const index = new Map();
  for (const dir of packageDirs) {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "packages", dir, "package.json"), "utf8"));
    index.set(manifest.name, { dir, exportsMap: manifest.exports ?? {} });
  }
  return index;
}

/**
 * The literal export target string for one subpath -- `exports` values are either a bare string
 * (`nvda-worker`'s no-build-step packages, ADR 0031) or `{types, default}` (every `tsc --build` package),
 * and only `default` is ever a real runtime resolution target.
 * @param {unknown} value
 * @returns {string | null}
 */
function exportTarget(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (/** @type {any} */ (value)).default === "string") {
    return /** @type {any} */ (value).default;
  }
  return null;
}

/**
 * One `dist/*.js` (or `dist/*.d.ts`) export target back to its SOURCE counterpart, mirroring
 * `candidatePackedPaths`'s inverse in `ci-changed.mjs`: every `tsc --build` package here uses
 * `rootDir: src`, `outDir: dist`, so `dist/foo.js` is built from `src/foo.ts`. A package shipping `src`
 * RAW (`nvda-worker`) has no `dist/` in its own targets at all, so the swap is a no-op and the literal
 * target -- already a real source file -- is tried as-is.
 * @param {string} target relative to the package root, e.g. "./dist/wcag.js"
 * @returns {string[]} candidate paths, relative to the package root, most-likely first
 */
function sourceCandidatesForExportTarget(target) {
  const stripped = target.replace(/^\.\//, "");
  const distMatch = /^dist\/(.*)\.(js|d\.ts|mjs)$/.exec(stripped);
  if (distMatch) return [`src/${distMatch[1]}.ts`, `src/${distMatch[1]}.tsx`, `src/${distMatch[1]}.mjs`];
  return [stripped];
}

/**
 * One RELATIVE specifier, from the file that imported it, to a real file on disk -- same shape as
 * `pre-install-import-graph.test.ts`'s `importGraph`, extended for `.ts` source: this repo's `.ts` files
 * import each other with the COMPILED `.js` extension (NodeNext-style TypeScript), so `./foo.js` from a
 * `.ts` file must resolve to the SOURCE `./foo.ts` that produces it, not a `dist/foo.js` that may not
 * exist yet on an unbuilt tree.
 * @param {string} spec
 * @param {string} fromFile absolute path
 * @returns {string | null} absolute path, or null if nothing on disk matches any candidate
 */
function resolveRelative(spec, fromFile) {
  const base = resolve(dirname(fromFile), spec);
  const jsMatch = /^(.*)\.(js|mjs|cjs)$/.exec(spec);
  const candidates = jsMatch
    ? [base, `${base.slice(0, -jsMatch[2].length - 1)}.ts`, `${base.slice(0, -jsMatch[2].length - 1)}.tsx`]
    : [base, `${base}.ts`, `${base}.mjs`, `${base}/index.ts`];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/**
 * One BARE `@a11ign/*` (or unscoped `a11ign`) specifier, with an optional subpath, to a source file --
 * `.` for the package root, `./x` for `exports["./x"]`. Any other bare specifier (a real npm dependency)
 * is not a workspace file and returns null.
 * @param {string} spec
 * @param {string} repoRoot
 * @param {Map<string, { dir: string, exportsMap: Record<string, unknown> }>} packages
 * @returns {string | null} absolute path
 */
function resolveWorkspacePackage(spec, repoRoot, packages) {
  const scopedMatch = /^(@[^/]+\/[^/]+)(\/.*)?$/.exec(spec);
  const pkgName = scopedMatch ? scopedMatch[1] : /^([^/@][^/]*)(\/.*)?$/.exec(spec)?.[1];
  const subpath = scopedMatch ? scopedMatch[2] : /^([^/@][^/]*)(\/.*)?$/.exec(spec)?.[2];
  const entry = pkgName ? packages.get(pkgName) : undefined;
  if (!entry) return null;
  const { dir, exportsMap } = entry;
  const key = subpath ? `.${subpath}` : ".";
  const target = exportTarget(exportsMap[key]);
  if (!target) return null;
  const pkgRoot = join(repoRoot, "packages", dir);
  for (const candidate of sourceCandidatesForExportTarget(target)) {
    const abs = join(pkgRoot, candidate);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/**
 * Everything reachable from `entryFile` by relative import or workspace-package specifier, transitively
 * -- the reverse of what `ci-changed.mjs`'s own header calls the point of ITS second pass: that file asks
 * "who depends on this PACKAGE"; this asks "which SOURCE FILES does this one TEST FILE actually reach",
 * so a change to any of them is a reason to run it.
 *
 * @param {string} entryFile absolute path
 * @param {string} repoRoot
 * @param {Map<string, { dir: string, exportsMap: Record<string, unknown> }>} packages
 * @returns {Set<string>} absolute paths, entry included
 */
export function sourceClosure(entryFile, repoRoot, packages) {
  const seen = new Set();
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = /** @type {string} */ (queue.pop());
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
      if (spec.startsWith("node:")) continue;
      const resolved = spec.startsWith(".")
        ? resolveRelative(spec, file)
        : resolveWorkspacePackage(spec, repoRoot, packages);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

/**
 * Every test file this repo's `ts` job would ever glob, for the given packages only -- the SAME pattern
 * `ci.yml`'s own step and `testDependencyMap` in `ci-changed.mjs` already use
 * (`packages/<pkg>/src/**\/*.test.ts`), so this can never select a file the shell glob it drives would not
 * also have matched.
 * @param {string} repoRoot
 * @param {string[]} pkgDirs
 * @returns {string[]} repo-relative paths
 */
export function discoverTestFiles(repoRoot, pkgDirs) {
  const dirSet = new Set(pkgDirs);
  return execFileSync("git", ["ls-files", "packages"], { cwd: repoRoot, env: sandboxGitEnv(), encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((f) => {
      const m = /^packages\/([^/]+)\/src\/.*\.test\.ts$/.exec(f);
      return m !== null && dirSet.has(m[1]);
    });
}

// #A1D: A TREE-WALKING GUARD IMPORTS NOTHING FROM THE FILE IT GOVERNS, so no amount of import-closure
// precision can ever select it. MEASURED, on main going red at `9c20dc99`:
// `git-spawn-classification.test.ts` -- a guard that walks the whole tree for files spawning `git` --
// fails on `packages/lab/src/packaging/acceptance-prose.test.ts`, which landed in a DIFFERENT PR. Run
// `34202041349` on #496 printed `select-changed-tests: 4 test file(s) selected precisely`, and the guard
// was not among the four: its population is the TREE, and the new file joined that population without
// creating a single import edge. Each PR was green alone; the merge was red. B4's intersection cannot see
// it either -- the two PRs share no file.
//
// So a whole CLASS of test is structurally unreachable by selection, and the remedy is to run that class
// unconditionally. THE SET IS DERIVED, NEVER TYPED. A hand-written "the guards that walk the tree" list
// is precisely the list a new guard slips past -- this repo's own most-recorded shape, and the reason
// `worker-code-check.test.ts` DISCOVERS its capture clients and `cli-flags.test.ts` DISCOVERS its command
// lines rather than naming them. A list here would have the same defect as the selection it is patching.
//
// TWO LEGS, and the difference between them is not fussiness -- it is the difference between a walk that
// IS a test's population and a walk that is merely the BEHAVIOUR of the module under test:
//
//   the TEST walks       any `git` enumeration, or any `readdirSync`/`globSync` -- in a test, a
//                        directory read IS the population it then asserts over.
//   a HELPER it imports  the same, but a bare `readdirSync` is not enough: the walk must NAME
//                        `node_modules`, which is the signature of walking this repository's own source
//                        and is what separates `command-line-census.mjs` and `source-walk.mjs` (shared
//                        discovery walkers, whose consumers ARE guards over the tree) from
//                        `capture-cache.mjs` and `board-data.mjs` (production modules that read one flat
//                        data directory, whose consumers are ordinary unit tests). Without that
//                        distinction the always-run set is 120 files instead of 88 and a third of it is
//                        there for the wrong reason.
//
// A WALK ROOTED IN THE CORPUS IS SUBTRACTED FROM BOTH. `runs/` is gitignored, so nothing in it can ever
// be a changed file in a PR, and a corpus reader is therefore not a guard this row is about. The
// accessors are `corpus-readers-are-guarded.test.ts`'s own (`runsRoot`, `datasetRoot`, `captureRoot`,
// `realCorpusRoot`, `repeatCapturesRoot`) rather than a second spelling of the same fact.
//
// ERRS TOWARD RUNNING TOO MUCH, deliberately. A fixture string inside a test that merely LOOKS like a git
// enumeration adds one fast file to a set of 88; a guard missed adds a red trunk that every check was
// blind to. Only one of those two failures is visible from the outside.
//
// A DISCOVERY GUARD MUST BE RUN AGAIN AFTER COMMITTING IT. THE FIRST RUN IS THE ONE THAT TELLS YOU
// NOTHING.
//
// `discoverTestFiles` walks `git ls-files`, so an UNTRACKED file is not in the population at all -- and
// that is true of every discovery in this repository, not only this one. **Every local run before
// `git add` examines a set that excludes the very file being added**, so a new guard reports cleanly on
// a population without its own subject, and CI (which reads a commit) then disagrees.
//
// Measured twice on 2026-09-08, an hour apart, by the same author:
//
//   #534's provenance guard read `always-run: 111 | mine: NOT IN SET` before `git add` and
//   `always-run: 112 | mine: walks the tree itself` after, with no change to its content.
//
//   `control-plane-checkout-is-one-fact.test.ts` passed locally 3/3 and failed in CI, because its own
//   pattern matches its own definition -- invisible while untracked, discovered the moment it was not.
//
// THE SECOND ONE HAPPENED AFTER THIS PARAGRAPH WAS WRITTEN, which is the argument for phrasing it as a
// procedure rather than a fact: knowing that `git ls-files` cannot see an untracked file did not prevent
// it, and only re-running after `git add` would have. It is the stale-`dist` lesson at a third layer --
// *"my test is weak"* and *"my test is old"* read the same, and here *"my guard passes"* and *"my guard
// cannot see the file"* read the same. The discriminator is a `git add`.
//
// A DOC CHECK'S MODULE WAS JUDGED BY THE TEST'S RULE -- #905, AND #954 RETIRED THAT. Those guards' walks
// moved out of their tests into `scripts/doc-checks/<name>.mjs`, and under the helper rule a flat
// `readdirSync` stopped counting: five guards left this set with no change to what they check, and
// `commands-documented` -- whose population is `scripts/*.mjs`, which no `docs` job catches -- stopped
// running on the very PRs it exists for (worker-capture's review of #960). The exemption fixed that.
//
// #954 then took the doc cross-reference guards off the pull-request path altogether: six test files are
// deleted and the eight that remain assert fixture logic rather than the tree, so the exemption became a
// rule about files that no longer exist. It is gone, and every imported module is judged as a helper again.
// `doc-cross-reference-report.test.ts` asserts that it is gone, and that no retired guard is still selected.
//
// WHAT IT DOES NOT REACH, said plainly rather than left to be discovered: a guard that walks ONE fixed
// tracked directory (`adr-index` over `docs/adr/`, `commands-documented` over the docs) IS in this set,
// because its walk counts -- but it is here as a member of the class, not because the selector understands
// its root. The sharper fix for those -- select a directory-walking
// guard when the diff touches the directory it walks -- is a different row and is not attempted here.

/**
 * Any git subcommand that ENUMERATES a population out of the repository itself. Matched as
 * `<identifier>("git", [...])` rather than `execFileSync`/`spawnSync` by name, which is the SAME
 * broadening `git-spawn-classification.test.ts` already had to make and for the same measured reason:
 * `isolation-gate.mjs` spawns through a local `run()` seam, and a list of function names is exactly what
 * a new wrapper slips past.
 */
const ENUMERATES_TRACKED =
  /\b[A-Za-z_$][\w$]*\(\s*["']git["'],\s*\[\s*["'](?:ls-files|grep|for-each-ref|branch|tag|log)["']/;

/** A directory walk of any kind -- the other way a population is discovered from disk. */
const WALKS_A_DIRECTORY = /\b(?:readdirSync|globSync)\s*\(/;

/**
 * A read rooted in the corpus -- BOTH spellings `corpus-readers-are-guarded.test.ts` already uses, the
 * accessors and the literal path, rather than a second version of the same fact. Using only the
 * accessors was tried first and let `announcement.corpus.test.ts` in, which roots its walk on the
 * literal `runs/screenreader-dataset/captures/`: the pair exists in that file because ONE of them is not
 * enough, and taking half of a settled pair is how a check comes to answer about the wrong population.
 * `runs/` is gitignored, so nothing under it can ever be a changed file in a PR.
 */
const CORPUS_ROOTED = /\b(?:runsRoot|datasetRoot|captureRoot|realCorpusRoot|repeatCapturesRoot)\s*\(|runs\/(?:screenreader-dataset|real-page-corpus|acceptance)/;

/**
 * A walk that names `node_modules` is walking this repository's own source tree; one that does not is
 * reading a single directory. It is the strict rule for a HELPER, and it also OVERRIDES the corpus
 * subtraction above for a test -- `real-page-corpus-freshness.test.ts` walks the tracked tree
 * (`SKIP_DIRS = node_modules, dist, .git`) to find corpus readers, so it names corpus paths constantly
 * while being exactly the kind of guard this row exists to keep running. Subtracting on a corpus mention
 * alone would have dropped it, which is the under-inclusion this whole row is about.
 */
const SKIPS_BUILD_OUTPUT = /["']node_modules["']/;

/**
 * Does this source DISCOVER a population from the repository, rather than from its own imports?
 * Comments are stripped first, for the reason every other discovery in this repo strips them: a file that
 * merely DESCRIBES a tree walk in prose has not performed one, and this file's own header would otherwise
 * classify the selector as a guard about six times over.
 *
 * @param {string} source
 * @param {{ asHelper?: boolean }} [options] `asHelper` -- apply the stricter directory-walk rule used for
 *   a module a test IMPORTS, where a flat data read must not count. Defaults to the test's own rule.
 * @returns {boolean}
 */
export function discoversFromTree(source, { asHelper = false } = {}) {
  const text = stripComments(source);
  if (ENUMERATES_TRACKED.test(text)) return true;
  if (!WALKS_A_DIRECTORY.test(text)) return false;
  // A walk that skips build output is walking this repository, whatever else the file mentions -- this
  // branch is FIRST so a tracked-tree walker is never subtracted for naming a corpus path.
  if (SKIPS_BUILD_OUTPUT.test(text)) return true;
  // A helper's flat directory read is the BEHAVIOUR of the module under test, not a population its
  // consumers assert over: `capture-cache.mjs` and `board-data.mjs` read one data directory each, and
  // their consumers are ordinary unit tests.
  if (asHelper) return false;
  // In a TEST, a flat directory read IS the population -- unless that directory is the corpus.
  return !CORPUS_ROOTED.test(text);
}

/**
 * Every test whose population is the TREE, and therefore must run whatever the diff touched -- with the
 * reason it qualified, so "we ran 88 guards" and "we ran 88 guards BECAUSE" are not the same output.
 *
 * The population is EVERY test file in the repository, never the implicated packages' own: a file added
 * anywhere can join the population of a guard living anywhere else, which is the whole defect.
 *
 * @param {string[]} testFiles repo-relative, every test file in the repo
 * @param {{ closureOf: (testFile: string) => Set<string>, repoRoot: string,
 *   readSource?: (rel: string) => string }} options
 * @returns {Array<{ test: string, why: string }>} sorted by test path
 */
export function alwaysRunTests(testFiles, { closureOf, repoRoot, readSource }) {
  const read = readSource ?? ((/** @type {string} */ rel) => readFileSync(join(repoRoot, rel), "utf8"));
  /** @type {Array<{ test: string, why: string }>} */
  const guards = [];
  for (const testFile of testFiles) {
    if (discoversFromTree(read(testFile))) {
      guards.push({ test: testFile, why: "walks the tree itself" });
      continue;
    }
    for (const abs of closureOf(testFile)) {
      const rel = relative(repoRoot, abs);
      if (rel === testFile) continue;
      // #954: the doc checks came off the pull-request path, so `scripts/doc-checks/` no longer gets the
      // TEST's rule here. Every imported module is judged as a helper again, as it was before #905.
      if (discoversFromTree(read(rel), { asHelper: true })) {
        guards.push({ test: testFile, why: `imports the tree walker ${rel}` });
        break;
      }
    }
  }
  return guards.sort((a, b) => a.test.localeCompare(b.test));
}

/**
 * WHICH ALWAYS-RUN GUARDS THIS DIFF CAN ACTUALLY REACH, by each guard's own declared walk scope -- #929.
 *
 * `alwaysRunTests` is unchanged and stays broad: *"a file added anywhere can join the population of a guard
 * living anywhere else"*, which is right for a guard whose population is the repository. This only removes
 * a guard that has DECLARED a narrower population (`export const WALK_SCOPE = [...]`, see
 * `packages/guards/src/walk-scope.mjs`) when nothing in the diff lies inside it. A guard that declares nothing is kept
 * exactly as today -- undeclared is unbounded, because the failure mode of a wrong narrowing is a guard that
 * silently stops running.
 *
 * Kept SEPARATE from `alwaysRunTests` so the predicate that decides "this walks the tree" and the declaration
 * that says "but only this much of it" are two readable facts, each with its own test.
 *
 * `declaredWalkScope` is the parse, named here because this file is where selection is decided.
 *
 * @param {Array<{ test: string, why: string }>} alwaysRun
 * @param {string[]} changedFiles repo-relative
 * @param {{ readSource: (rel: string) => string }} options
 * @returns {{ kept: Array<{ test: string, why: string }>, narrowed: Array<{ test: string, scope: string[] }> }}
 */
export function narrowByDeclaredScope(alwaysRun, changedFiles, { readSource }) {
  /** @type {Array<{ test: string, why: string }>} */
  const kept = [];
  /** @type {Array<{ test: string, scope: string[] }>} */
  const narrowed = [];
  for (const guard of alwaysRun) {
    const scope = declaredWalkScope(readSource(guard.test));
    if (scope === null) { kept.push(guard); continue; }
    if (changedFiles.some((file) => inScope(file, scope))) {
      kept.push({ test: guard.test, why: `${guard.why}; its declared walk scope (${scope.join(", ") || "none"}) is touched` });
    } else {
      narrowed.push({ test: guard.test, scope });
    }
  }
  return { kept, narrowed };
}

/** @param {string} source @returns {string[] | null} */
export function declaredWalkScope(source) {
  return parseWalkScope(source);
}

// #A1c: `.github/workflows/ci.yml` itself -- a job definition can affect anything the job runs, so
// narrowing it would mean reasoning about what the CHANGE to the job does, not what it touches.
const BROAD_ALWAYS = new Set([".github/workflows/ci.yml"]);

/**
 * A changed file with genuinely NO better answer than `ci-changed.mjs`'s existing, coarser
 * "touching every implicated package" rule: `.github/workflows/ci.yml` itself, or one of `ROOT_TS_FILES`
 * (a root config or lockfile change that touches how everything builds). Reused, not re-typed -- see this
 * file's own header for why a second hand-written list is the mistake to avoid here specifically.
 *
 * Everything else outside `packages/*\/src/` (a `scripts/*.mjs` file, a hook, a non-`ci.yml` workflow) is
 * NOT broad any more -- `selectTests` below covers it by reference instead.
 * @param {string[]} changedFiles
 * @returns {string[]} the files responsible, for the caller to report
 */
export function broadReasons(changedFiles) {
  return changedFiles.filter((f) => BROAD_ALWAYS.has(f) || ROOT_TS_FILES.has(f));
}

/**
 * Every quoted string literal's CONTENT in `source` -- single-, double- or backtick-delimited. Coarse
 * rather than a real tokenizer (an escaped quote inside one literal is not unescaped), which is fine for
 * this file's one question: does SOME literal mention this path, never what the literal's exact runtime
 * value would be.
 * @param {string} source
 * @returns {string[]}
 */
function quotedLiterals(source) {
  return [...source.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)]
    .map((m) => m[1] ?? m[2] ?? m[3]);
}

/**
 * Which of `testFiles` reference `changedFile` BY PATH STRING -- for a hook or workflow file no `import`
 * can ever name. COMMENTS ARE STRIPPED FIRST (`@a11ign/evidence/source-text`'s `stripComments`, the same
 * tool A2's `command-line-census.mjs` already uses), so a doc comment that MENTIONS a path in prose --
 * this repo's own `` `scripts/foo.mjs` `` markdown convention, never a real JS string literal -- cannot
 * be mistaken for a test that actually exercises it. A test that DISCUSSES a file is not a test that
 * reads or runs it, and collapsing the two is exactly the heading-collision shape #446 is open about.
 * @param {string} changedFile repo-relative
 * @param {string[]} testFiles repo-relative
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function pathStringReferences(changedFile, testFiles, repoRoot) {
  return testFiles.filter((testFile) =>
    literalsOf(join(repoRoot, testFile)).some((lit) => namesPath(lit, changedFile, testFile)));
}

/**
 * The narrower question `pathStringReferences` answered before #1527: which tests name `changedFile` by its
 * REPO-RELATIVE path. It still decides the non-package branch's FALLBACK, so resolving relative literals only
 * ever ADDS tests. Measured on #1525's diff before this split: `real-page-unexaminable.json` is read only through
 * `../../baselines/...`, so the relative match turned a whole-`lab` fallback into one test, and the tests that
 * reach that file through the gate script's runtime read stopped running.
 * @param {string} changedFile repo-relative
 * @param {string[]} testFiles repo-relative
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function repoPathReferences(changedFile, testFiles, repoRoot) {
  return testFiles.filter((testFile) => literalsOf(join(repoRoot, testFile)).some((lit) => lit.includes(changedFile)));
}

/**
 * Does one literal name `changedFile` -- as the repo-relative path anywhere inside it, or (#1527) as a path
 * RELATIVE TO THE TEST FILE that resolves to it exactly? `capture-age-spread.test.ts` reads the gate script as
 * `new URL("../../scripts/check-real-page-findings.ts", import.meta.url)`, a literal that never contains the
 * repo-relative path, so a change to that script never selected the test that pins its source, and on #1526 it
 * failed unseen. Exact resolution only: a relative literal naming a DIFFERENT file is not a reference.
 * @param {string} literal
 * @param {string} changedFile repo-relative
 * @param {string} testFile repo-relative
 * @returns {boolean}
 */
function namesPath(literal, changedFile, testFile) {
  if (literal.includes(changedFile)) return true;
  return /^\.\.?\//.test(literal) && join(dirname(testFile), literal) === changedFile;
}

/** @type {Map<string, string[]>} one comment-stripped read per test file, however many changed files ask */
const LITERALS = new Map();

/** @param {string} absolutePath @returns {string[]} */
function literalsOf(absolutePath) {
  // A candidate that is not on disk names nothing. `main`'s candidates come from `git ls-files`; the unit tests
  // that drive `selectTests` over a synthetic `/repo` reach this search since #1527 and read no file.
  if (!existsSync(absolutePath)) return [];
  let literals = LITERALS.get(absolutePath);
  if (!literals) {
    literals = quotedLiterals(stripComments(readFileSync(absolutePath, "utf8")));
    LITERALS.set(absolutePath, literals);
  }
  return literals;
}

/**
 * The reverse index ONCE: source file (repo-relative) -> every test file that reaches it. Never
 * restricted to `packages/*\/src/` -- a test reaching `scripts/foo.mjs` via a relative import was already
 * in here; #A1c is the first place anything LOOKS it up for a script's own changes.
 * @param {string[]} testFiles
 * @param {(testFile: string) => Set<string>} closureOf
 * @param {string} repoRoot
 * @returns {Map<string, Set<string>>}
 */
function buildReverseIndex(testFiles, closureOf, repoRoot) {
  /** @type {Map<string, Set<string>>} */
  const reverse = new Map();
  for (const testFile of testFiles) {
    for (const abs of closureOf(testFile)) {
      const rel = relative(repoRoot, abs);
      if (!reverse.has(rel)) reverse.set(rel, new Set());
      /** @type {Set<string>} */ (reverse.get(rel)).add(testFile);
    }
  }
  return reverse;
}

/**
 * One changed file's verdict: which tests select it (possibly the file itself, if it IS a test), or an
 * empty selection naming which package(s) the caller must fall back to instead. Never both empty and
 * silent -- see `selectTests`'s own header for why that is the rule this whole row exists to keep.
 *
 * @param {string} file repo-relative
 * @param {{ reverse: Map<string, Set<string>>, testFiles: string[], testPackages: string[],
 *   referenceCandidates: string[], referencesPath: (file: string, testFiles: string[]) => string[],
 *   referencesRepoPath: (file: string, testFiles: string[]) => string[] }} ctx
 * @returns {{ selectedBy: string[], fallbackPackages: string[] }}
 */
function classifyOneFile(file, ctx) {
  if (/^packages\/([^/]+)\/src\/.*\.test\.ts$/.test(file)) return { selectedBy: [file], fallbackPackages: [] };

  // #1527: EVERY BRANCH SELECTS BY BOTH KINDS OF REFERENCE. A test can depend on a file by importing it or by
  // reading it by path, whatever kind of file it is: #1526 changed `packages/lab/scripts/check-real-page-findings.ts`,
  // which the path-string branch alone decided, so `relocated-fixture-key.test.ts` (which IMPORTS it) was never
  // looked up, and a source pin elsewhere was missed the other way. Each branch keeps its OWN fallback rule,
  // unchanged -- the non-package branch's still counts only repo-relative literals (`repoPathReferences`) -- so
  // this only ever adds tests to a selection and never removes a package fallback that fired before.
  const imported = [...(ctx.reverse.get(file) ?? [])];
  const read = ctx.referencesPath(file, ctx.referenceCandidates);
  const selectedBy = [...new Set([...imported, ...read])];

  const pkgMatch = /^packages\/([^/]+)\/src\/.*$/.exec(file);
  if (pkgMatch) return { selectedBy, fallbackPackages: imported.length > 0 ? [] : [pkgMatch[1]] };

  // #A1c: `scripts/*.mjs` -- BY IMPORT, the SAME reverse index every `packages/*\/src/` lookup uses.
  // No "own package" for a file outside packages/ -- every implicated package is the honest fallback.
  if (/^scripts\/.*\.mjs$/.test(file)) return { selectedBy, fallbackPackages: imported.length > 0 ? [] : ctx.testPackages };

  // #A1c: anything else non-package, non-broad (a hook, a non-ci.yml workflow, a document) -- BY PATH STRING.
  //
  // #1358: SEARCHED ACROSS `referenceCandidates`, NOT ONLY THE IMPLICATED PACKAGES' TESTS. A test that reads a
  // file by path lives in whatever package owns the claim it checks, and nothing about the changed file
  // implicates that package. Measured on #1353's diff (README.md, two docs, a workflow, one lab test): only
  // `lab` was implicated, so `documented-criteria.test.ts` in `judge` -- which reads README.md and
  // action.yml by name -- was never a candidate, did not run on the PR, and turned main red at 16:10:46Z.
  return { selectedBy, fallbackPackages: ctx.referencesRepoPath(file, ctx.referenceCandidates).length > 0 ? [] : ctx.testPackages };
}

/**
 * THE SELECTION -- pure, given the diff and a pre-built reverse index (constructed once, real disk reads
 * bounded to the touched packages' own test files, never the whole repo).
 *
 * THE ZERO-TESTS FALLBACK IS THE LOAD-BEARING HALF, not the narrowing (see this file's own top-of-file
 * header). Every branch in `classifyOneFile` returns SOME fallback package the instant it finds no
 * selecting test, and this function's own job is to never lose that signal on the way to the output.
 *
 * @param {string[]} changedFiles repo-relative
 * @param {{ closureOf: (testFile: string) => Set<string>, testFiles: string[], repoRoot: string,
 *   testPackages?: string[], referenceCandidates?: string[],
 *   referencesPath?: (file: string, testFiles: string[]) => string[],
 *   referencesRepoPath?: (file: string, testFiles: string[]) => string[] }} options
 *   `closureOf` -- injected so the caller builds it once per test file rather than this function
 *   re-walking the same test file once per changed source line. `testFiles` -- every candidate test file
 *   (repo-relative), the population `closureOf` and `referencesPath` may report against. `testPackages`
 *   -- every implicated package (from `ci-changed.mjs`'s `classify`), the fallback target for a
 *   `scripts/*.mjs` or hook/workflow file with no reference anywhere; defaults to `[]` so an existing
 *   caller testing only `packages/*\/src/` files is unaffected. `referencesPath` -- injected the same way
 *   `closureOf` is, so a unit test never touches disk unless it deliberately wants to; defaults to the
 *   real `pathStringReferences`. `referenceCandidates` -- #1358: the population a BY-PATH-STRING file is
 *   searched across; `main` passes every test file in the repository, and it defaults to `testFiles`.
 *   `referencesRepoPath` -- #1527: the repo-relative-only search that decides the non-package fallback; defaults
 *   to the real `repoPathReferences`, or to an injected `referencesPath`, so a unit test that injects one keeps
 *   one meaning for both.
 * @returns {{ selectedTests: string[], fallbackPackages: string[], uncoveredFiles: string[] }}
 */
export function selectTests(changedFiles, options) {
  const { closureOf, testFiles, repoRoot, testPackages = [], referenceCandidates = testFiles } = options;
  const referencesPath = options.referencesPath ?? ((file, candidates) => pathStringReferences(file, candidates, repoRoot));
  const referencesRepoPath = options.referencesRepoPath ?? (options.referencesPath
    ? referencesPath : (file, candidates) => repoPathReferences(file, candidates, repoRoot));
  const reverse = buildReverseIndex(testFiles, closureOf, repoRoot);

  const selected = new Set();
  const fallbackPackages = new Set();
  /** @type {string[]} */
  const uncoveredFiles = [];
  for (const file of changedFiles) {
    const verdict = classifyOneFile(file,
      { reverse, testFiles, testPackages, referenceCandidates, referencesPath, referencesRepoPath });
    for (const t of verdict.selectedBy) selected.add(t);
    // #1527: a fallback can now ride WITH a selection (a package file read only by path still falls back to
    // its package, as it did when nothing selected it), so the fallback is read on its own, never inferred
    // from an empty selection.
    for (const pkg of verdict.fallbackPackages) fallbackPackages.add(pkg);
    if (verdict.fallbackPackages.length > 0) uncoveredFiles.push(file);
  }
  return { selectedTests: [...selected].sort(), fallbackPackages: [...fallbackPackages].sort(), uncoveredFiles };
}

/**
 * The always-run guards this run ADDED -- the ones selection did not already reach -- named with the
 * reason each qualified. Capped at `SAMPLE`, because "88 guards, here are the eight of them selection
 * missed" is a diagnostic and 88 filenames is a wall. The COUNTS are never capped.
 *
 * @param {Array<{ test: string, why: string }>} alwaysRun
 * @param {string[]} selectedTests
 * @returns {string}
 */
function describeAlwaysRun(alwaysRun, selectedTests) {
  const SAMPLE = 8;
  const already = new Set(selectedTests);
  const added = alwaysRun.filter((g) => !already.has(g.test));
  if (alwaysRun.length === 0) return "";
  const shown = added.slice(0, SAMPLE).map((g) => `${g.test} (${g.why})`);
  return `, plus ${alwaysRun.length} always-run discovery guard(s) -- a guard whose population is the `
    + `tree imports nothing from the file it governs, so no selection can reach it -- of which `
    + `${added.length} were not already selected`
    + (shown.length > 0 ? `: ${shown.join("; ")}${added.length > SAMPLE ? ", ..." : ""}` : "");
}

// #1654: `agent-org` is tested from `packages/lab/src/packaging/` by declared, long-standing convention
// (`work-tick.mjs`, `work-gate.mjs`, `wake.mjs`, ... all ship this way) -- its own `src/` carries zero
// `*.test.ts` files, so the plain per-package fallback glob below is empty for it BY CONSTRUCTION, not by
// a moved or typo'd path, and `assert-glob-not-empty.mjs` cannot tell the two apart on its own. Named
// here, once, rather than guessed at: every OTHER package keeps the plain fallback, so a genuinely
// uncovered change elsewhere still refuses.
//
// #1695: `guards` shares the exact same shape as `agent-org` -- `tooling-roots.mjs` names both as
// tooling censused from `packages/lab/src/packaging/` (`assert-glob-not-empty.test.ts`,
// `runner-is-rstest.test.ts`, ...), and its own `src/` has never carried a `*.test.ts` file.
// `nvda-speech` has no `src/` at all (a Python package tested under its own `tests/`, never by the `ts`
// job) -- also empty by construction. Neither was in this map, so a `scripts/*.mjs` change nothing
// imports (the shape that names every `testPackages` entry as a fallback) reproduced #1648 one level
// over: `packages/guards/src/**/*.test.ts` and `packages/nvda-speech/src/**/*.test.ts` both matched 0
// and the non-broad branch, unlike the broad one, has no `--drop-empty` to fall back on. Measured on
// PR #1695 (`ts / run`, run 35335772105): `scripts/release-print-versions.mjs` is a new file no test's
// declared walk scope reaches, so `fallbackPackages` names all eleven `testPackages`, including these two.
/** @type {Record<string, string>} */
const FALLBACK_TEST_GLOB = {
  "agent-org": "packages/lab/src/packaging/**/*.test.ts",
  guards: "packages/lab/src/packaging/**/*.test.ts",
  "nvda-speech": "packages/lab/src/packaging/**/*.test.ts",
};

/**
 * What the `ts` job actually runs: the precisely-selected tests, the always-run guards, and a full-suite
 * glob per package with an uncovered change -- UNIONED and DEDUPLICATED, because a guard that selection
 * already reached must not be handed to `tsx --test` twice.
 *
 * @param {{ selectedTests: string[], alwaysRun: Array<{ test: string, why: string }>,
 *   fallbackPackages: string[] }} result
 * @returns {string[]}
 */
export function testFilesToRun({ selectedTests, alwaysRun, fallbackPackages }) {
  const files = [...new Set([...selectedTests, ...alwaysRun.map((g) => g.test)])].sort();
  return [...files, ...fallbackPackages.map((p) => FALLBACK_TEST_GLOB[p] ?? `packages/${p}/src/**/*.test.ts`)];
}

/**
 * The guards a declared walk scope left out of this run, NAMED -- a narrowing that only reports a count is a
 * guard that stopped running with nothing saying which.
 * @param {Array<{ test: string, scope: string[] }>} narrowed
 */
function describeNarrowed(narrowed) {
  if (narrowed.length === 0) return "";
  const shown = narrowed.slice(0, 8).map((n) => `${n.test} (walks ${n.scope.join(", ") || "only its own imports"})`);
  return `, leaving out ${narrowed.length} guard(s) whose declared walk scope this diff does not touch: `
    + `${shown.join("; ")}${narrowed.length > 8 ? ", ..." : ""}`;
}

/** @param {{ selectedTests: string[], fallbackPackages: string[], uncoveredFiles: string[],
 *   broad: string[], alwaysRun: Array<{ test: string, why: string }>,
 *   narrowed?: Array<{ test: string, scope: string[] }> }} result */
function writeOutputs(result) {
  const testFiles = result.broad.length > 0 ? [] : testFilesToRun(result);
  const count = result.broad.length > 0 ? -1 : result.selectedTests.length;
  const outFile = process.env.GITHUB_OUTPUT;
  const lines = [
    `testFiles=${testFiles.join(" ")}`,
    `selectedCount=${count}`,
    // SEPARATE from `selectedCount` on purpose: "this diff reaches four tests" and "the repository has 88
    // guards that no diff can ever reach" are different facts, and one summed number would hide both.
    `alwaysRunCount=${result.broad.length > 0 ? -1 : result.alwaysRun.length}`,
    // AND WHAT WAS LEFT OUT, never folded into the count above: "134 guards ran" and "131 ran because 3
    // declared a scope this diff does not touch" are different facts, and only the second can be checked.
    `alwaysRunNarrowed=${result.broad.length > 0 ? -1 : (result.narrowed ?? []).length}`,
    `fallbackPackages=${result.fallbackPackages.join(" ")}`,
    `broad=${result.broad.length > 0}`,
  ];
  console.log(`select-changed-tests: ${result.broad.length > 0
    ? `BROAD -- ${result.broad.length} file(s) outside the by-reference search (ci.yml itself or a root `
      + `config): (${result.broad.slice(0, 5).join(", ")}${result.broad.length > 5 ? ", ..." : ""}), `
      + "falling back to ci-changed.mjs's existing package-level scope, which already runs every guard"
    : `${result.selectedTests.length} test file(s) selected precisely`
      + describeAlwaysRun(result.alwaysRun, result.selectedTests)
      + describeNarrowed(result.narrowed ?? [])
      + (result.fallbackPackages.length > 0
        ? `, plus the full suite of ${result.fallbackPackages.length} package(s) with an uncovered change `
          + `(${result.uncoveredFiles.join(", ")})`
        : "")}`);
  if (!outFile) { console.log(lines.join("\n")); return; }
  appendFileSync(outFile, `${lines.join("\n")}\n`);
}

// #939: the copy that lived here is now `packages/guards/src/changed-files.mjs`, which every reader of "which paths did
// this change touch" imports. #938 wrote it here for `narrowByDeclaredScope` (#929), which needs the side a
// file LEFT -- and eight other readers were still asking bare, one of them a lane-check bypass.


/**
 * THE SELECTION `main` REPORTS FOR A NON-BROAD DIFF, exported so a test drives the wiring `main` uses rather
 * than a hand-assembled copy of it. #1358, measured by mutation: with `main` no longer passing
 * `referenceCandidates`, every test that called `selectTests` directly stayed green while the CLI selected
 * nothing again.
 *
 * @param {string[]} files repo-relative
 * @param {{ repoRoot: string, allPackages: string[], testPackages: string[] }} scope
 */
export function selectionFor(files, { repoRoot, allPackages, testPackages }) {
  const packages = packageIndex(repoRoot, allPackages);
  const testFiles = discoverTestFiles(repoRoot, testPackages);
  const closureOf = (/** @type {string} */ testFile) =>
    sourceClosure(join(repoRoot, testFile), repoRoot, packages);
  // EVERY test file in the repository, not `testFiles` -- that one is scoped to the implicated packages,
  // and a guard in `packages/worker-fleet` governs a file added to `packages/judge`. Measured at ~0.7s
  // for all 453 test files when #A1d landed, which is why the whole population is affordable to walk here.
  // The count grows with the tree and the time was not re-measured since; `git ls-files
  // 'packages/*/src/**/*.test.ts' | wc -l` gives today's count. #1358: the same population is where a
  // document's by-path readers are searched for.
  const everyTestFile = discoverTestFiles(repoRoot, allPackages);
  const selected = selectTests(files, { closureOf, testFiles, repoRoot, testPackages, referenceCandidates: everyTestFile });
  // #2277: `changedFiles` keeps BOTH sides of a rename (`--no-renames`), so a test moved to another package
  // arrives here as its OLD path, and `classifyOneFile` selects a changed test file as itself. That path is not on
  // disk, so `assert-glob-not-empty` refused the run as "matched 0" and the `ts` job went red on a PR that moved a
  // test and nothing else wrong. The NEW path is in `files` too and selects the moved test; the old one names
  // nothing to run. Filtered here, where `repoRoot` is known, rather than in the pure `selectTests`.
  const result = { ...selected, selectedTests: selected.selectedTests.filter((t) => existsSync(join(repoRoot, t))) };
  return { result, closureOf, everyTestFile };
}

async function main() {
  refuseUnknownFlags(["--base", "--repo"], { entry: import.meta.url, command: "select-changed-tests" });
  const repoRoot = flagValue(process.argv, "repo") ?? process.cwd();
  const base = flagValue(process.argv, "base");
  if (!base || base.endsWith("/")) {
    console.error(`select-changed-tests: --base=${JSON.stringify(base)} is empty or a bare prefix -- `
      + "same shape ci-changed.mjs refuses, for the identical reason.");
    process.exit(2);
  }
  const files = changedFiles([`${base}...HEAD`], { repoRoot });
  if (files.length === 0) {
    console.error(`select-changed-tests: "git diff --name-only --no-renames ${base}...HEAD" returned nothing.`);
    process.exit(2);
  }

  const allPackages = knownPackages(repoRoot);
  const depGraph = readWorkspaceDependencyGraph(repoRoot, allPackages);
  const { testPackages } = classify(files, allPackages, depGraph, { repoRoot });
  const broad = broadReasons(files);

  if (broad.length > 0) {
    // BROAD is deliberately unaffected by #A1d: it already runs every test in every implicated package,
    // which is a superset of the always-run set. Adding guards here would be a second answer to a
    // question that already has one.
    writeOutputs({ selectedTests: [], fallbackPackages: testPackages, uncoveredFiles: [], broad, alwaysRun: [] });
    return;
  }

  const { result, closureOf, everyTestFile } = selectionFor(files, { repoRoot, allPackages, testPackages });
  const everyGuard = alwaysRunTests(everyTestFile, { closureOf, repoRoot });
  const { kept: alwaysRun, narrowed } = narrowByDeclaredScope(everyGuard, files,
    { readSource: (rel) => readFileSync(join(repoRoot, rel), "utf8") });
  writeOutputs({ ...result, broad: [], alwaysRun, narrowed });
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  main();
}
