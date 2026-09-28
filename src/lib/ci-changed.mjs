#!/usr/bin/env node
// COPIED FROM `scripts/ci-changed.mjs` at 598e883cc (#2623, child 5 of #69; ADR 0040, decision 4): the tool's own copy, so `agent-org` imports nothing outside
// its package. The product keeps its original and the two can drift, with no cross-repository pin: `agent-org-outward-edges.test.ts` compares them.
// CHANGED FROM THE ORIGINAL, 5 NAMED LINES:
// - its import of changed-files.mjs, now the tool's own copy beside it
// - its import of cli-flags.mjs, now the tool's own copy beside it
// - its import of git-env.mjs, now the tool's own copy beside it
// - its import of changed-packages.mjs, now the tool's own copy beside it
// - its import of isolation-gate.mjs, now the tool's own copy beside it
// ==== end of copy header ====
// @ts-check
// command: classify what a PR's diff touches, so CI's conditional jobs know whether to run
// WHAT CHANGED, CLASSIFIED — the one place `ci.yml`'s conditional jobs read to decide whether they run.
//
// Before this, a PR ran everything: `lint.yml` had no path filter at all, and ran lint, typecheck, the
// full TS suite and the full Python suite on a one-line docs edit exactly as it did on a capture-path
// rewrite. `changeset-check.yml` re-derived its own "does this touch a published package" answer inline
// in YAML, and `ansible-check.yml` carried a THIRD copy of "did the fleet's Ansible layer change" as a
// third `paths:` block. Three copies of "what changed", and nothing kept them agreeing — this repo's own
// most-repeated defect, aimed at its own CI.
//
// `classify` is PURE — a file list, a package list and a dependency graph in, a handful of booleans and
// two package lists out — so the categories are testable without a checkout, a diff, or a runner, and a
// category that stops matching anything is a red unit test rather than a silent CI budget regression. The
// CLI wrapper is the only impure part: it reads `git diff --name-only` against the PR's base and every
// package's `package.json` to build the dependency graph.
//
// PULL_REQUEST AND MERGE_GROUP ONLY, DELIBERATELY -- chairman's direction, 2026-09-06, widened for #156.
// This file used to also support `--event=push`, unconditionally reporting every category true for a push
// straight to `main`; `ci.yml` no longer HAS a push trigger at all (a check that runs after a merge cannot
// stop it), so that mode had no caller left and was removed rather than kept as an unused, untested escape
// hatch. Every check now runs before the merge -- on the PR itself, or on the merge-group ref a queued PR
// is tested against -- and branch protection (checks green AND up to date with `main`) is what makes the
// tested commit the one that lands.
//
// `testPackages` (touched + every workspace DEPENDENT, transitively) IS THE POINT OF THIS FILE'S SECOND
// PASS -- 2026-09-06, chairman's follow-up measuring `ci/ts` at 269s on a one-package PR. `packages`
// alone (a PR's directly touched packages) would test the changed code but not its consumers -- a
// contract change under `packages/evidence` breaking `packages/judge`'s use of it would pass a scoped run
// that only ever looked at `evidence`. `testPackages` is the transitive closure of dependents, computed
// from the real `@a11ign/*` `dependencies`/`devDependencies` in every package's own `package.json`
// -- never a hand-written map, for this file's own stated reason: three independent hand-written copies
// of "what changed" is the defect this file exists to end.
import { execFileSync } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { changedFiles } from "./changed-files.mjs";
// RELATIVE, NOT `@a11ign/worker-fleet/cli-flags` — every other root script uses the package
// specifier, and every other root script runs after `npm run build`. This one gates whether ANYTHING
// else in the workflow builds at all, so it cannot depend on a build having already happened; the file
// itself is plain JS with no TypeScript syntax, so importing straight from `src` costs nothing.
import { refuseUnknownFlags, flagValue } from "./cli-flags.mjs";
import { sandboxGitEnv } from "./git-env.mjs";
// REUSED, NOT RE-DERIVED. `changedPackages` already exists, already extracts `packages/<name>` from a
// diff, and already has its own test (`changed-packages.test.ts`) proving it against real shapes (a
// rename, a deletion, a file directly under `packages/` with no subdirectory). Writing a second copy of
// `/^packages\/([^/]+)\//` here would be the exact defect this file's own header names.
import { changedPackages } from "./changed-packages.mjs";
// REUSED FOR REAL THIS TIME. The comment on `packedFiles` below has claimed this reuse since #132 while
// the function beneath it carried its own, second `npm pack --dry-run --json` call -- two derivations of
// "what does a package actually ship" guarding the identical promise, the exact fact-stated-twice shape
// this file's own header opens with. `isolation-gate.mjs` is this repo's other, older answer to the same
// question (does a consumer's install actually work), so it is the one authority now.
import { packedFiles as packedFilesForDir } from "./isolation-gate.mjs";

/**
 * Every top-level package directory this repo has, read once rather than hardcoded twice.
 * @param {string} repoRoot
 */
export function knownPackages(repoRoot) {
  const pkg = JSON.parse(readFileSync(`${repoRoot}/package.json`, "utf8"));
  const patterns = pkg.workspaces ?? ["packages/*"];
  // This repo has exactly one workspace glob, `packages/*`; a second would need a real glob library.
  // `ci-changed.test.ts` asserts that shape holds against the real package.json, so a future second
  // workspace glob fails a unit test rather than silently only ever seeing the first entry.
  if (patterns.length !== 1 || patterns[0] !== "packages/*") {
    throw new Error(`ci-changed.mjs assumes a single "packages/*" workspace glob; package.json now says `
      + `${JSON.stringify(patterns)} — update knownPackages() before trusting this script's output`);
  }
  return execFileSync("git", ["ls-files", "packages"], { cwd: repoRoot, env: sandboxGitEnv(), encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    // A file tracked directly under `packages/` (`packages/README.md`) has only two path segments and is
    // not a package -- pre-existing and harmless as long as nothing tried to read `packages/<name>/
    // package.json` for every returned "name". `readWorkspaceDependencyGraph` is the first thing that
    // does, and crashed on exactly this (`ENOTDIR: not a directory, open './packages/README.md/
    // package.json'`) the first time it ran against the real repo. A real package always has at least
    // one file NESTED under its directory, so three-or-more segments is what distinguishes it.
    .filter((f) => f.split("/").length > 2)
    .map((f) => f.split("/")[1])
    .filter((name, index, all) => name && all.indexOf(name) === index)
    .sort();
}

/**
 * Every package directory's own workspace dependencies, as directory names -- not by convention (e.g.
 * assuming `@a11ign/<dir>`), because `packages/cli`'s own `package.json` name is the UNSCOPED
 * `"a11ign"`, and `packages/lab` genuinely depends on it. Each directory's real declared `name` is
 * read and used as the lookup key, so a future package with an unconventional name is still resolved
 * correctly rather than silently dropped from the graph.
 *
 * @param {string} repoRoot
 * @param {string[]} allPackages every package directory name
 * @returns {Record<string, string[]>} directory name -> the directory names of its workspace dependencies
 */
export function readWorkspaceDependencyGraph(repoRoot, allPackages) {
  /** @type {Record<string, string>} */
  const nameToDir = {};
  /** @type {Record<string, any>} */
  const manifests = {};
  for (const dir of allPackages) {
    const manifest = JSON.parse(readFileSync(`${repoRoot}/packages/${dir}/package.json`, "utf8"));
    nameToDir[manifest.name] = dir;
    manifests[dir] = manifest;
  }
  /** @type {Record<string, string[]>} */
  const graph = {};
  for (const dir of allPackages) {
    const deps = Object.keys({ ...manifests[dir].dependencies, ...manifests[dir].devDependencies });
    // `.filter(Boolean)`: a dependency outside this workspace (`@guidepup/guidepup`, `typescript`, ...)
    // has no entry in `nameToDir` and resolves to `undefined` -- not every declared dependency is a
    // workspace package, and only workspace packages belong in this graph.
    graph[dir] = deps.map((name) => nameToDir[name]).filter(Boolean);
  }
  return graph;
}

/**
 * The transitive closure of `changed` plus every package that depends on one, directly or through
 * another dependent -- e.g. `evidence` changing must also test `judge` (depends on `evidence`) AND `lab`
 * (depends on `judge`), not just the packages that import `evidence` directly.
 *
 * @param {string[]} changed
 * @param {Record<string, string[]>} dependencyGraph from `readWorkspaceDependencyGraph`
 * @returns {string[]} sorted, deduplicated
 */
export function dependentsOf(changed, dependencyGraph) {
  /** @type {Record<string, Set<string>>} */
  const reverse = {};
  for (const [pkg, deps] of Object.entries(dependencyGraph)) {
    for (const dep of deps) (reverse[dep] ??= new Set()).add(pkg);
  }
  const result = new Set(changed);
  const queue = [...changed];
  while (queue.length > 0) {
    const pkg = queue.pop();
    if (pkg === undefined) continue;
    for (const dependent of reverse[pkg] ?? []) {
      if (!result.has(dependent)) {
        result.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return [...result].sort();
}

/** Root-level files a change to which must be treated as "every TS/JS package changed". */
// EXPORTED for select-changed-tests.mjs (A1c): "root configuration" is one fact, not two hand-typed
// lists that could silently disagree about what counts.
export const ROOT_TS_FILES = new Set([
  "package.json", "pnpm-lock.yaml", "tsconfig.json", "tsconfig.base.json",
  ".eslintrc.json", ".eslintrc.cjs", "eslint.config.js", "eslint.config.mjs",
]);

// Exported: `scripts/board-only-check.mjs` needs the identical set to decide "is this a doc-touching
// file", so the pre-push hook's board-only fast path asks the exact question `classify` does.
export const DOC_ROOT_FILES = new Set(["README.md", "CLAUDE.md", "CONTRIBUTING.md", "SECURITY.md", "PLAN.md"]);

/**
 * Is every one of these doc-touching files a BOARD file -- `docs/board/summaries/*.md` or
 * `docs/board/reported.json` -- the first named instance of "narrower than the general docs case", per
 * chairman's direction, 2026-09-06, the product manager's single largest recurring cost that night.
 * `docs/board/summaries/*.md` and `docs/board/reported.json` are edited far more often than anything else
 * under `docs/`, and every such edit used to pay the full `docs` job (a build, then the whole
 * `packages/lab/src/packaging/` directory) for a change no rule outside the board guards could possibly
 * react to. Exported separately from `classify` so the pre-push hook's board-only fast path can ask the
 * identical question `ci.yml`'s `board` job asks, rather than a second copy of the same two regexes.
 *
 * @param {string[]} docsFiles a list of files to check -- an EMPTY list is not "board-only", it is "no
 *   doc changed at all", and those are different questions with different callers. Two valid shapes,
 *   deliberately: `classify` pre-filters to doc-touching files only, because its `board`/`docs` decision
 *   is independent of the OTHER categories (`ts`, `python`, ...) it computes over the same diff in the
 *   same call -- a non-doc file is that diff's problem, not this function's. `isBoardOnlyDiff` (#296, since retired with
 *   the pre-push board-only path) was a single yes/no gate with no sibling categories to catch anything this function lets through, so it
 *   passes the WHOLE, unfiltered diff -- a non-doc file must fail `.every()` here, or it fails nowhere.
 */
export function boardOnly(docsFiles) {
  return docsFiles.length > 0 && docsFiles.every((f) =>
    f === "docs/board/reported.json" || /^docs\/board\/summaries\/.*\.md$/.test(f));
}

/**
 * What `npm pack --dry-run` actually ships for one package, as a `Set` of paths relative to the package
 * root. `classify` accepts an injected replacement (`getPackedFiles`) so its own tests never shell out to
 * npm; this is only the REAL one, kept at this `(repoRoot, pkgName)` shape so every existing caller and
 * test here is unaffected by where the underlying npm call actually lives.
 *
 * @param {string} repoRoot
 * @param {string} pkgName
 * @returns {Set<string>}
 */
export function packedFiles(repoRoot, pkgName) {
  return packedFilesForDir(`${repoRoot}/packages/${pkgName}`);
}

/**
 * A changed file's own path, plus its BUILT counterpart's — `src/foo.ts` also produces `dist/foo.js` and
 * `dist/foo.d.ts` for a package that ships `dist` (every `tsc --build` package here uses `rootDir: src`,
 * `outDir: dist`, one file in, the same relative name out). Checking BOTH against the packed manifest is
 * what tells a real source change from a test file without ever naming `*.test.ts` here: every package's
 * own `tsconfig.json` already excludes test files from the build ("exclude": src/**\/*.test.ts), so
 * a test file's built counterpart simply never exists to be packed — the same fact `npm pack` already
 * knows, read once rather than re-encoded as a second, driftable pattern.
 *
 * #720: EXTENSION-AGNOSTIC on purpose, not `.ts`/`.tsx` only. `worker-fleet`'s tsconfig sets
 * `"include": ["src/**\/*.ts", "src/**\/*.mjs"]` (`allowJs`, no `checkJs`) so a plain `.mjs` under `src/`
 * -- e.g. `deploy-worker.mjs` -- compiles into `dist/deploy-worker.mjs` and IS packed, exactly like a
 * `.ts` file. The old `.tsx?` regex never matched it, so `classify()` read a real, shipped source change
 * as `changeset: false`. The candidate is a PREFIX (`dist/<name>.`, trailing dot) rather than the two
 * fixed `.js`/`.d.ts` suffixes, checked by `reachesPacked` below — extension-agnostic and prefix-matched
 * is the design the stranded branch `lead/changeset-gate-asks-npm` (`consumer-visible.mjs`,
 * `reachableOutputs`) got right, ported here rather than reviving that module: "the failure direction
 * that matters is missing a real output, never having one candidate too many."
 *
 * A package that ships `src` RAW (no build step -- `nvda-worker`, and `worker-fleet`'s
 * `src/local-worker`/`src/provisioning`) needs no mapping at all: the file's own path is already a
 * candidate, and its `files` field either lists that literal path or does not.
 *
 * @param {string} relPath path relative to the package root
 * @returns {string[]}
 */
export function candidatePackedPaths(relPath) {
  const candidates = [relPath];
  const srcMatch = /^src\/(.*)\.[^./]+$/.exec(relPath);
  if (srcMatch) candidates.push(`dist/${srcMatch[1]}.`);
  return candidates;
}

/**
 * #720: does `packed` contain a file reached by any of `candidates`? A candidate ending in `.` (from
 * `candidatePackedPaths`' src->dist mapping above) matches by PREFIX -- `Set.has` alone cannot express
 * "some packed path starts with this". `.has(c)` is always tried FIRST, and only when that misses does
 * this fall back to iterating -- both because a prefix candidate could coincidentally be a literal packed
 * path too, and because `getPackedFiles` is also `everythingIsPacked` (the `changed` job's cheap
 * stand-in), whose `.has()` answers every candidate `true` and which is not itself iterable. Iterating it
 * would throw `TypeError: packed is not iterable`, and the CLI's own `runCliIn` test (no `--precise`)
 * caught exactly that on the first run of this fix.
 * @param {Set<string>} packed
 * @param {string[]} candidates
 * @returns {boolean}
 */
export function reachesPacked(packed, candidates) {
  return candidates.some((c) => {
    if (packed.has(c)) return true;
    if (!c.endsWith(".")) return false;
    for (const p of packed) if (p.startsWith(c)) return true;
    return false;
  });
}

/**
 * Whether `packages/<pkgName>` is ever published — a `private: true` package has no changeset question.
 * @param {string} repoRoot
 * @param {string} pkgName
 */
function isPublished(repoRoot, pkgName) {
  return !JSON.parse(readFileSync(`${repoRoot}/packages/${pkgName}/package.json`, "utf8")).private;
}

/**
 * A `getPackedFiles` stand-in that answers "packed" for EVERY candidate path, unconditionally. Used only
 * by the `changed` job, which runs before `npm ci` and so cannot safely call the real `npm pack` --
 * `orchestrator` reproduced `classify()` crashing there on every PR touching a published package, once
 * `packedFiles` stopped being an inert, never-actually-called comment and started being the real call
 * this file's own header always claimed it was.
 *
 * SAFE BECAUSE IT IS ONLY EVER TOO EAGER, never too quiet: `classify()`'s `changeset` output computed this
 * way is a strict SUPERSET of the precise answer -- exactly `changed` file under `packages/<published>/`,
 * the same shape `changeset-check.yml`'s old regex used before #132. That is fine for what this output
 * actually decides here: whether the `changeset` job (which has `npm ci`, and re-derives the PRECISE
 * answer with the real `packedFiles` before enforcing anything) runs at all. A false positive here costs
 * one job invocation that then finds nothing to enforce; a false negative would skip the real check
 * entirely, which is why this never goes the other way.
 *
 * @param {string} repoRoot unused -- present only to match `getPackedFiles`'s real shape
 * @param {string} pkgName unused -- present only to match `getPackedFiles`'s real shape
 * @returns {Set<string>} answers `.has(anything)` true, without ever running the real `npm pack`
 */
function everythingIsPacked(repoRoot, pkgName) {
  void repoRoot; void pkgName;
  return /** @type {Set<string>} */ (/** @type {unknown} */ ({ has: () => true }));
}

/**
 * Every literal path a test declares via the `file: "<path>"` SITES convention, mapped to the package
 * whose `ts`-job glob (`packages/<pkg>/src/**\/*.test.ts`) covers the test file making the claim — issue
 * #283, found when a board-only diff routed to the narrower `board` job (`board-*.test.ts` +
 * `public-claim.test.ts`) and skipped `repo-identity-consolidated.test.ts`, which sits in the same
 * directory but is not a board test. `classify` folds this map's matched package(s) into `packages` WHEN
 * `board` fires — see the comment at that call site for why the fold is gated rather than unconditional:
 * this map itself is not, because the same handful of literals (README.md, CLAUDE.md, ...) are also named
 * by OTHER, non-board packaging tests, and folding those in for every diff that touches them would re-run
 * the same tests under both `docs` and `ts` for nothing.
 *
 * SCOPED TO THE `file:`-KEYED CONVENTION this repo already uses for exactly this class of check
 * (`repo-identity-consolidated.test.ts`, `tracked-source-leak-guard.test.ts`, `fetch-wrapper-coverage.
 * test.ts`, `backlog-file-facts.test.ts` …) rather than a repo-wide scrape of every string literal —
 * CLAUDE.md's own caution about static derivation applies here too ("a regex reports ZERO flags" for a
 * CLI that builds its list from a variable): a looser pattern would answer a noisier question, and this
 * one is the idiom the repo already commits to as a deliberate, reviewed claim about ONE file. NOTE FOR
 * ANYONE EDITING COMMENTS NEAR THIS FUNCTION: this regex reads SOURCE TEXT and cannot tell documentation
 * of the convention from a real use of it — writing out an example as `file: "<some path>"` inside a
 * comment adds a phantom entry to the derived map (harmless, since `<some path>` never appears in a real
 * diff, but sloppy and worth avoiding; caught once already in this function's own test file).
 *
 * @param {string} repoRoot
 * @returns {Map<string, Set<string>>} literal path -> package name(s) whose ts-job glob covers a test
 *   naming it
 */
export function testDependencyMap(repoRoot) {
  const testFiles = execFileSync("git", ["ls-files", "packages"], { cwd: repoRoot, env: sandboxGitEnv(), encoding: "utf8" })
    .split("\n")
    .filter((f) => /\/src\/.*\.test\.ts$/.test(f));
  const map = new Map();
  for (const testFile of testFiles) {
    const pkgMatch = /^packages\/([^/]+)\//.exec(testFile);
    if (!pkgMatch) continue;
    const text = readFileSync(`${repoRoot}/${testFile}`, "utf8");
    for (const m of text.matchAll(/\bfile:\s*["']([^"']+)["']/g)) {
      if (!map.has(m[1])) map.set(m[1], new Set());
      map.get(m[1]).add(pkgMatch[1]);
    }
  }
  return map;
}

/**
 * Adds, IN PLACE, every package a NAMED TEST implicates for this file list — gated on `board`, per
 * `testDependencyMap`'s own comment on why the fold must not apply unconditionally. Extracted to its own
 * function so `classify` counts this as one call rather than the `if` plus two nested `for`s ESLint's
 * `complexity` rule would otherwise charge it for directly — CLAUDE.md's own remedy for this exact shape:
 * move the branching into a helper called through one line, rather than splitting it across two guards at
 * the call site (which measured WORSE, not better, the last time this file's own `rules.ts` sibling tried
 * it).
 *
 * @param {Set<string>} tsPackages mutated in place
 * @param {{ files: string[], board: boolean,
 *   getTestDependencyMap: (repoRoot: string) => Map<string, Set<string>>, repoRoot: string }} ctx
 */
function foldTestNamedPackages(tsPackages, { files, board, getTestDependencyMap, repoRoot }) {
  if (!board) return;
  const testDeps = getTestDependencyMap(repoRoot);
  for (const f of files) {
    for (const pkg of testDeps.get(f) ?? []) tsPackages.add(pkg);
  }
}

/**
 * A quoted string LITERAL that names the docs tree or a root doc, or a directory walk, or a tracked-tree
 * enumeration: the three ways a test in this repo READS docs (#2357). Built from `DOC_ROOT_FILES` rather
 * than a second hand-typed list of root docs, because "which files are docs" is `classify`'s own question.
 *
 * DELIBERATELY EAGER, NEVER TOO QUIET, like `everythingIsPacked` above: this decides only whether the `ts`
 * job is worth running for a docs diff, and `select-changed-tests.mjs` (`alwaysRunTests`) then decides
 * WHICH tests run. A false positive costs a scoped `ts` run that finds nothing; a false negative is #2329
 * (`ts=SKIPPED`, main red). It reads SOURCE TEXT and cannot tell a comment from code, so a comment quoting
 * `"docs/..."` also counts -- the safe direction. It cannot import `discoversFromTree` from
 * `select-changed-tests.mjs`: that file needs `npm ci`, and this one runs in the `changed` job before it.
 * `ci-changed.test.ts` pins that every guard `discoversFromTree` finds is in this set, so the two cannot drift.
 */
const READS_DOCS = new RegExp([
  "[\"'`](?:[^\"'`\\n]*/)?docs(?:/[^\"'`\\n]*)?[\"'`]",
  `["'\`](?:[^"'\`\\n]*/)?(?:${[...DOC_ROOT_FILES].map((f) => f.replace(".", "\\.")).join("|")})["'\`]`,
  "\\b(?:readdirSync|globSync)\\s*\\(",
  // `select-changed-tests.mjs`'s ENUMERATES_TRACKED, verbatim: any git subcommand that lists the repo's own files.
  "\\b[A-Za-z_$][\\w$]*\\(\\s*[\"']git[\"'],\\s*\\[\\s*[\"'](?:ls-files|grep|for-each-ref|branch|tag|log)[\"']",
].join("|"));

/**
 * Every `packages/*\/src/**\/*.test.ts` that reads docs -- the population a docs-only diff can break.
 * DERIVED from the tracked test files, so a test added tomorrow joins without an edit here; that is the
 * whole reason this is not a list of names (the shape #2329 slipped past).
 *
 * @param {string} repoRoot
 * @returns {string[]} repo-relative, sorted
 */
export function docsReadingTests(repoRoot) {
  return execFileSync("git", ["ls-files", "packages"], { cwd: repoRoot, env: sandboxGitEnv(), encoding: "utf8" })
    .split("\n")
    .filter((f) => /\/src\/.*\.test\.ts$/.test(f))
    .filter((f) => READS_DOCS.test(readFileSync(`${repoRoot}/${f}`, "utf8")))
    .sort();
}

/**
 * Must `ts` run for this diff because it changes docs some test reads? Only a NON-board docs diff asks:
 * `board` has its own narrower route (#283 fold above). Its own function so `classify` pays one call for it.
 *
 * @param {{ docs: boolean, getDocsReadingTests: (repoRoot: string) => string[], repoRoot: string }} ctx
 */
function docsReadersMustRun({ docs, getDocsReadingTests, repoRoot }) {
  return docs && getDocsReadingTests(repoRoot).length > 0;
}

/**
 * Which `ci.yml` jobs must run for this file list — a thin wrapper around `classify` itself, so this
 * answer and `classify`'s can never disagree about the same diff (the fact-stated-twice shape this file's
 * own header opens with, applied to itself). Exists so the #283 acceptance check can ask the CLASS
 * question standalone, with no diff or checkout: does `docs/board/reported.json` alone route to `ts`.
 *
 * @param {string[]} files
 * @param {string} [repoRoot]
 * @returns {string[]} the job names `classify` set true for this file list
 */
export function jobsFor(files, repoRoot = process.cwd()) {
  const result = classify(files, knownPackages(repoRoot), {}, { repoRoot });
  /** @type {(keyof ClassifyResult)[]} */
  const jobs = ["ts", "python", "ansible", "docs", "board", "changeset", "rulesFitness"];
  return jobs.filter((job) => result[job]);
}

/**
 * Classify a list of repo-relative changed paths into which `ci.yml` jobs must run.
 *
 * @param {string[]} files
 * @param {string[]} allPackages every package directory name, for the "a root config file changed" case
 * @param {Record<string, string[]>} [dependencyGraph] from `readWorkspaceDependencyGraph`; defaults to
 *   empty, so `testPackages` degrades to exactly `packages` when no graph is supplied (every existing
 *   call site that predates `testPackages` keeps working unchanged)
 * @param {{ repoRoot?: string, getPackedFiles?: (repoRoot: string, pkgName: string) => Set<string>,
 *   getTestDependencyMap?: (repoRoot: string) => Map<string, Set<string>>,
 *   getDocsReadingTests?: (repoRoot: string) => string[] }} [deps]
 *   `repoRoot` defaults to `process.cwd()`, `getPackedFiles` to the real `packedFiles` above,
 *   `getTestDependencyMap` to the real `testDependencyMap` above, `getDocsReadingTests` to the real
 *   `docsReadingTests` — all injectable so `classify` itself stays testable without touching disk or git.
 * @typedef {{ ts: boolean, python: boolean, ansible: boolean, docs: boolean, board: boolean,
 *   changeset: boolean, rulesFitness: boolean, packages: string[], testPackages: string[] }} ClassifyResult
 * @returns {ClassifyResult}
 */
export function classify(files, allPackages, dependencyGraph = {},
  { repoRoot = process.cwd(), getPackedFiles = packedFiles, getTestDependencyMap = testDependencyMap,
    getDocsReadingTests = docsReadingTests } = {}) {
  const rootTsChanged = files.some((f) => ROOT_TS_FILES.has(f));
  // BLUNT ON PURPOSE, matching `changedPackages`'s own stated philosophy: any file under `packages/<name>/`
  // — not only `.ts`/`.mjs`/`.json` under `src`/`bin` — marks that package touched. A second, narrower
  // definition of "touched" living beside the pre-push hook's is exactly the shape that drifts; the hook's
  // own tests already exercise renames, deletions and the no-subdirectory edge case for this function.
  const tsPackages = new Set(changedPackages(files.join("\n")));
  const rootScriptsChanged = files.some((f) => /^scripts\/.*\.mjs$/.test(f));
  // A root config file (tsconfig, eslint config, the workspace's own package.json) OR a `scripts/*.mjs`
  // file can change what EVERY package lints, typechecks or tests as — dozens of packaging tests import
  // `packages/guards/src/git-env.mjs`, `scripts/cli-flags.mjs` and their siblings directly, so a change there is not
  // scoped to any one package. Both are treated as touching every package rather than none, matching the
  // pre-push hook's own rule: an EMPTY touched-package result must read as "run everything", never as
  // "run nothing" (`scripts/git-hooks/pre-push`'s FAST/FULL split header states this for the identical
  // reason).
  if (rootTsChanged || rootScriptsChanged) for (const name of allPackages) tsPackages.add(name);

  // `requirements-ci.txt` is the CI subset; the lab's own full environment lives at
  // `packages/scorer/requirements.txt` (NOT a root `requirements.txt` — `python-ci-requirements.test.ts`
  // already pins the two equal at every shared constraint, so a change to either is a reason to re-run).
  const python = files.some((f) =>
    /^packages\/[^/]+\/(python|tests)\/.*\.py$/.test(f)
    || f === "requirements-ci.txt" || f === "packages/scorer/requirements.txt");

  const ansible = files.some((f) => f.startsWith("packages/control/ansible/"));

  const docsFiles = files.filter((f) => f.startsWith("docs/") || DOC_ROOT_FILES.has(f));
  // `board` is true, and `docs` FALSE, only when EVERY doc-touching file in the diff is a board file --
  // see `boardOnly`'s own doc comment for why. Mixing in any other doc means the ordinary, wider `docs`
  // job runs instead, because this file's own rule is "narrower than usual needs its own argument", and a
  // mixed diff has not made that argument.
  const board = docsFiles.length > 0 && boardOnly(docsFiles);
  const docs = docsFiles.length > 0 && !board;

  // #283: `board`'s glob is a strict subset of `docs`'s over the same directory -- see
  // `foldTestNamedPackages`'s own comment for why that makes this the one place a file can be classified
  // without running a test that names it, and why the fold is gated on `board` rather than unconditional.
  foldTestNamedPackages(tsPackages, { files, board, getTestDependencyMap, repoRoot });

  // ISSUE #132: the regex `changeset-check.yml` used before this file existed asked "is this file UNDER
  // a published package's src/python/models/bin", which answers a different question than the one the
  // gate means -- "CAN this file reach a consumer". `packages/worker-fleet/src/lab-job.test.ts` matched
  // that regex and blocked a real PR, measured: `npm pack --dry-run --json` on `worker-fleet` ships 153
  // files and that is not one of them. Derived from what npm actually packs instead, per-package, memoised
  // so a PR touching several files in one package still calls `npm pack` once for it.
  const packedCache = new Map();
  const changeset = files.some((f) => {
    const match = /^packages\/([^/]+)\/(.*)$/.exec(f);
    if (!match) return false;
    const [, pkgName, relPath] = match;
    if (!allPackages.includes(pkgName) || !isPublished(repoRoot, pkgName)) return false;
    if (!packedCache.has(pkgName)) packedCache.set(pkgName, getPackedFiles(repoRoot, pkgName));
    const packed = packedCache.get(pkgName);
    return reachesPacked(packed, candidatePackedPaths(relPath));
  });

  // NARROW ON PURPOSE, unlike every other category above -- chairman's direction, 2026-09-06. Coverage
  // and `gate:isolation` left the PR path entirely (release-time and nightly instead; see `ci.yml`'s and
  // `coverage.yml`'s own headers), and the rules fitness gate (`npm run rules-check`) is the one PR-time
  // check remaining that measures something repo-wide rather than a single package's own behaviour. It
  // reads fixtures scored against `packages/judge`'s rule engine over `packages/evidence`'s announcement
  // grammar, so those two are the only paths that can move its answer -- unlike `ts`, a root config or
  // `scripts/*.mjs` change does NOT imply this needs to re-run.
  const rulesFitness = files.some((f) => f.startsWith("packages/judge/") || f.startsWith("packages/evidence/"));

  const packages = [...tsPackages].sort();

  return {
    // `packages` (any file under a package dir) OR `scripts/*.mjs` OR a root config file -- the last two
    // touch nothing `changedPackages` can name, but still need `npm run lint`/`typecheck`, which are
    // whole-repo regardless of which package(s) end up in the scoped test run below.
    ts: rootTsChanged || rootScriptsChanged || tsPackages.size > 0
      // #2357: #2329 was docs-only, ts=SKIPPED, main red. NO package is implicated, so only tree readers run.
      || docsReadersMustRun({ docs, getDocsReadingTests, repoRoot }),
    python,
    ansible,
    docs,
    board,
    changeset,
    rulesFitness,
    packages,
    // The transitive closure of dependents -- see `dependentsOf`'s own doc comment. When `packages` is
    // every known package already (a root config or scripts/*.mjs change), the closure is a no-op: every
    // dependent of every package is still every package.
    testPackages: dependentsOf(packages, dependencyGraph),
  };
}

/** @param {ClassifyResult} result */
function writeOutputs(result) {
  const outFile = process.env.GITHUB_OUTPUT;
  const lines = [
    `ts=${result.ts}`,
    `python=${result.python}`,
    `ansible=${result.ansible}`,
    `docs=${result.docs}`,
    `board=${result.board}`,
    `changeset=${result.changeset}`,
    `rulesFitness=${result.rulesFitness}`,
    `packages=${result.packages.join(" ")}`,
    `testPackages=${result.testPackages.join(" ")}`,
  ];
  if (!outFile) {
    // Not inside a GitHub Actions job — print rather than fail, so this is also runnable by hand.
    console.log(lines.join("\n"));
    return;
  }
  appendFileSync(outFile, `${lines.join("\n")}\n`);
}

async function main() {
  // --precise: the `changeset` job passes this AFTER its own `npm ci`, to get the real, `npm pack`-backed
  // answer -- see `everythingIsPacked`'s own comment for why the `changed` job (no install at all) must
  // never take this path. Its ABSENCE is not "changeset: false"; it is "changeset: true whenever a
  // published package changed at all", a deliberate over-approximation that only decides whether the
  // `changeset` job runs, never whether anything is actually enforced.
  const KNOWN_FLAGS = ["--event", "--base", "--repo", "--precise"];
  refuseUnknownFlags(KNOWN_FLAGS, { entry: import.meta.url, command: "ci-changed" });

  // `--event` stays a required, explicit flag rather than being dropped outright: a caller that types
  // `--event=push` today gets a clear refusal naming why, instead of silently falling through some
  // default — the same "an ignored flag runs the default and reports success" defect `cli-flags.mjs`
  // exists to prevent, one value along. `merge_group` added for #156; the value itself is not otherwise
  // read below -- it exists only so a mistyped or reverted trigger is refused here rather than silently
  // classifying under the wrong event's assumptions.
  const event = flagValue(process.argv, "event");
  if (event !== "pull_request" && event !== "merge_group") {
    console.error(`ci-changed: --event must be "pull_request" or "merge_group", got ${JSON.stringify(event)}. `
      + "--event=push was removed: ci.yml has no push trigger left to call it from.");
    process.exit(2);
  }

  const repoRoot = flagValue(process.argv, "repo") ?? process.cwd();
  const packages = knownPackages(repoRoot);

  const base = flagValue(process.argv, "base");
  // A bare "origin/" (nothing after the prefix) is what an UNHANDLED empty `github.base_ref` produces on
  // a merge_group event -- see ci.yml's own comment on the `base` step for the shape trap this guards
  // against. Verified rather than assumed: passing that straight to `git diff` does NOT reach the
  // "returned nothing" refusal below at all -- `git diff origin/...HEAD` is a `fatal: ambiguous argument`,
  // an uncaught crash with a raw git error, not this script's own clear message. Caught here so the
  // failure names its own cause even if the workflow's base derivation ever regresses.
  if (!base || base.endsWith("/")) {
    console.error(`ci-changed: --base=${JSON.stringify(base)} is empty or a bare prefix with nothing after `
      + "it -- required for both --event values. On merge_group this is what an unhandled empty "
      + "github.base_ref looks like once \"origin/\" has been prepended to it; check the workflow's base "
      + "derivation before assuming this script is at fault.");
    process.exit(2);
  }
  // Three dots: the PULL REQUEST's own diff, against the merge base rather than the base branch's tip —
  // the same operator `changeset-check.yml` already used, for the identical reason: two dots would
  // include every commit that landed on main since the branch was cut, which is not this PR's change.
  // #939: through the one helper, so the SOURCE side of a rename is listed. Spelling the diff here was how
  // nine readers came to disagree about what "changed" means.
  const files = changedFiles([`${base}...HEAD`], { repoRoot });

  if (files.length === 0) {
    console.error(`ci-changed: changedFiles("${base}...HEAD") returned nothing — either this PR is `
      + "empty, or --base is wrong. Refusing to report every job as unnecessary on the strength of a diff "
      + "that may simply have failed to run.");
    process.exit(2);
  }

  const dependencyGraph = readWorkspaceDependencyGraph(repoRoot, packages);
  const precise = process.argv.includes("--precise");
  writeOutputs(classify(files, packages, dependencyGraph,
    { repoRoot, getPackedFiles: precise ? packedFiles : everythingIsPacked }));
}

// Only when invoked directly — importing `classify` for a test must not trigger a git subprocess.
//
// `pathToFileURL`, not a template literal. Concatenation does not percent-encode, so a checkout under a
// path containing a SPACE compares false, the guard never fires, and this exits 0 having classified
// nothing — which the workflow reads as a clean run, and every downstream job is then skipped on a PR
// that reports green. `entry-points.test.ts` has forbidden this form for a while and could not SEE this
// file, because it discovered entry points from `package.json` and `ci.yml` invokes this one directly.
// Widening that discovery is the rest of this change.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
