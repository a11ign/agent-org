/**
 * PORTED from a11ign/a11ign `packages/lab/src/packaging/` at 95cb57e33 (a11ign/a11ign#3106), where the tool's source was one slice of a
 * whole-tree walk and stopped being walked once the tool left. It now walks this tool's `src/` (source AND tests, off disk: see
 * `tool-source.ts`) and classifies against this tool's two helpers. Its first run here found two real unscrubbed spawns, in
 * `close-rows-full-form.test.ts` and `release-safety.test.ts`, both fixed in the same change; the rest of this header is the original.
 *
 * EVERY place in this repo that spawns `git` must scrub `GIT_*` from its environment, or be discovered
 * and refused — not just the eleven tests that left evidence when this went wrong.
 *
 * git EXPORTS `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` into every hook environment. On 2026-09-06 the
 * pre-push hook started running `npm test` with `GIT_DIR` set — because the audit row "nothing installs
 * the git hooks" had just been CLOSED — and a test that spawned git with `cwd` alone and an inherited
 * `env` operated on the REAL repository instead of its own throwaway one: `core.bare` flipped twice,
 * stray commits landed on real refs, and a test's own `git config user.name` was written into the real
 * repo and reused as author on 15 commits, six of them real work already on `origin/main`. **A closed
 * row created the exposure.**
 *
 * ## IT CAUGHT TWO AUTHORS IN ONE HOUR, 2026-09-07, AND THE TWO CASES ARE DIFFERENT
 *
 * A guard that catches two independent authors in an hour has earned the sentence, and the second case is
 * not the one it looks like.
 *
 * The FIRST is the case this test was written for: a new `gitCommonDir()` spawn (#201) that simply did not
 * route through the helper. Caught, fixed by routing it, done.
 *
 * The SECOND (#204) was not a careless author. `sandboxGitEnv` HAD been written on all three of that
 * change's spawns and verified by a green full suite — **it never reached the commit.** `git add` had run
 * before those edits, and `git commit` with no path arguments commits the INDEX, so the older staged
 * version went in while the working tree's fixes stayed behind. **This test caught a commit that did not
 * contain the fix its author had already written and verified.**
 *
 * ## The diagnostic rule underneath it, which generalises well past this test
 *
 * **A green local suite and a red CI on the same "commit" is the signal that the thing tested and the
 * thing committed are not the same object.** `npm test` reads the WORKING TREE; CI reads the COMMIT. When
 * those two disagree about what is supposedly identical code, the OBJECT is what differs — and nothing in
 * either output says so. The natural reading is "the guard found something I missed", and on #204 that
 * reading was wrong and cost a round trip.
 *
 * CLAUDE.md records the mirror image — *"`git commit -- <paths>` commits from the WORKING TREE — a staged
 * path not listed is silently dropped"*. This is the other door: **stage, then edit, then commit without
 * paths, and the edit is dropped instead.** Both are the index and the working tree disagreeing while every
 * tool reports success about the half it happens to read. It belongs beside that line in CLAUDE.md and is
 * recorded here meanwhile, because that file is behind the authority ruling with four other units.
 *
 * Three test files (`pre-commit-hook`, `promotion-refuses-dirty`, `lab-reset-removal`) were where the
 * corruption left evidence, because they write. But eleven git-shelling tests existed, and read-only
 * ones are not exempt: a redirected `git status`/`git ls-files`/`git branch --list` does not corrupt
 * anything, it silently examines the WRONG repository and reports on it as though it were this one. And
 * the class is bigger than tests -- production code shells to git too (`code-drift.mjs`'s
 * `workerSourceDirty`, read via a redirected `git status`, would report a dirty worker checkout as
 * CLEAN). THREE is the instance; the population this test discovers is the class.
 *
 * DISCOVERED, never hand-listed: a hand-maintained "the files that spawn git" list is exactly the kind
 * of list a new call site slips past -- this repo's own recorded shape (CLAUDE.md, "A FACT STATED
 * TWICE"). Every `.ts`/`.mjs` file tracked in git is scanned, comments stripped first (the same reason
 * `exit-code-contract.test.ts`/`cli-flags.test.ts`/`rules-gate-export-divergence.test.ts` strip them: a
 * file that only MENTIONS spawning git in prose has not done it), for a call shaped
 * `<identifier>("git", ...)` -- broad enough to catch an indirected call site (`install-git-hooks.mjs`
 * calls `run("git", ...)` through an injected seam, not `execFileSync` directly) without being a list of
 * function names that a new wrapper could slip past.
 *
 * CLASSIFICATION, not a bare pass/fail: a discovered file is SAFE only if it imports one of the three
 * canonical scrubbing helpers (`packages/guards/src/git-env.mjs`, `scripts/test-support/git-sandbox.ts`, or
 * `packages/worker-fleet/src/git-safe-env.mjs` -- the last one a DELIBERATE, disclosed duplicate forced
 * by worker-fleet's publish boundary, see that file's own header) AND actually calls it, not merely
 * imports it unused. A twelfth git-shelling file that imports nothing fails this test by name until
 * somebody classifies it -- which is the whole point: this walk is a census, and a classification is
 * only as good as the population it can actually see (a sibling lesson: `evidence-fields.test.ts`
 * reads a capture's fields at the top level and cannot see one wrapped in `.capture`, so 29 real records
 * were invisible to a working guard -- the same failure mode, a reader examining less than it believes,
 * one level along).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripComments } from "../lib/source-text.ts";
import { toolSources, toolTests, type ToolFile } from "./tool-source.ts";

/**
 * The two modules a git-shelling file may import to be classified SAFE, matched by BASENAME rather than full path -- every real call site
 * imports one of these by a RELATIVE specifier (`./lib/git-env.mjs`, `../lib/git-sandbox.ts`), so matching the full path would miss every
 * real import. (The product's third, `git-safe-env.mjs`, is worker-fleet's and never reaches this tool.)
 */
const CANONICAL_HELPER_BASENAMES = ["git-env.mjs", "git-sandbox.ts"];
const CANONICAL_HELPERS = ["src/lib/git-env.mjs", "src/lib/git-sandbox.ts"];

/**
 * Every `.ts`/`.mjs` file in the tool's `src/`: its source AND its tests, a test that spawns git being the original motive. The canonical
 * helpers and their OWN tests are exempt from needing to import themselves -- they either ARE the sanitizer or exist to prove it.
 */
function trackedSourceFiles(): ToolFile[] {
  return [...toolSources(), ...toolTests()]
    .filter((f) => !CANONICAL_HELPERS.includes(f.path) && !/\/git-(env|sandbox)\.test\.(ts|mjs)$/.test(f.path));
}

/**
 * `<identifier>("git", ...)`, comments stripped first. Deliberately not anchored to `execFileSync` /
 * `spawnSync` / `execFile` / `spawn` by name: `install-git-hooks.mjs` calls `run("git", ...)` through an
 * injected seam precisely so it is testable without a real git binary, and a discovery anchored to the
 * four node:child_process names would miss exactly that indirection -- the same "static derivation
 * cannot be trusted" lesson CLAUDE.md already records for CLI flag scraping.
 */
/**
 * WHAT THIS POPULATION IS NOT, MEASURED 2026-09-09 AFTER IT MISSED A REAL COLLISION (#890).
 *
 * `trunk-revert-guard.test.ts` spawned `node packages/agent-org/src/trunk-revert-guard.ts` with `cwd` set to the real
 * checkout. That script runs `git fetch origin` unconditionally, so a `npm test` in any worktree fetched
 * into the SHARED primary `.git` and could collide with another worktree doing the same on the
 * remote-tracking refs. A test mutating the checkout that drives the fleet.
 *
 * THIS GUARD COULD NOT SEE IT, AND IS NOT WRONG. `SPAWNS_GIT_DIRECTLY` asks whether a file's own text
 * spawns `git`, because what it classifies is ENV SCRUBBING AT THE CALL SITE -- a question that only has
 * an answer where the call is. That file's first argument is `"node"`.
 *
 * WIDENING IT IS THE WRONG FIX, and the number says so. Following one hop -- a file naming a
 * `scripts/*.mjs` that itself spawns git -- adds 75 files to a population of 82, and most are false:
 * naming a script path in prose, a glob or an assertion is not spawning it. A classification everyone has
 * to argue with is one nobody maintains.
 *
 * THE HAZARD IS A DIFFERENT ONE AND NEEDS ITS OWN GUARD: a test that runs REAL code against the REAL
 * checkout, whatever the code spawns. 16 test files pass `cwd: REPO`-style to a spawn across 29 sites,
 * and most are harmless because the thing they run only reads. Separating the writers from the readers
 * is a row of its own, not a regex here.
 */
const SPAWNS_GIT_DIRECTLY = /\b\w+\(\s*["']git["']/;

/**
 * FILES WHERE THE LITERAL `"git"` IS DATA, NOT A SPAWN -- classified, never silently skipped.
 *
 * `SPAWNS_GIT_DIRECTLY` is deliberately broad: `<identifier>("git", ...)`, so an indirected call site
 * (`run("git", ...)` through an injected seam) cannot slip past a list of function names. The price of
 * that breadth is that it also matches a call passing the STRING `"git"` as an argument -- a fixture
 * asking "would this token resolve to an executable?", which spawns nothing at all.
 *
 * That price came due 2026-09-08T08:00:30Z: `acceptance-prose.test.ts` landed via #446 and turned trunk
 * RED on `onlyResolves("git")`, a two-line local predicate (`(token) => names.includes(token)`) in a file
 * whose ONLY imports are `node:test`, `node:assert/strict` and the module under test. It cannot spawn
 * anything; it has no `node:child_process` import to spawn with.
 *
 * **The wrong remedy was available and would have looked like a fix**: adding `sandboxGitEnv` to a file
 * that spawns no git. That satisfies the guard, ships a meaningless import, and teaches the next author
 * that the helper is a formality rather than a scrub -- which is how a real guard becomes a ritual. The
 * repository's own rule applies: a check must never demand a remedy for something it has not shown to be
 * a fault.
 *
 * So the exemption is EXPLICIT and carries its reason, the same shape `cli-flags.test.ts` uses for
 * `check-schema-migration.mjs`. It is not a bypass: every entry is asserted below to name a real tracked
 * file that genuinely imports no spawning capability, so an entry added to silence a REAL offender fails
 * on its own terms rather than passing quietly.
 */
const GIT_IS_DATA_NOT_A_SPAWN: Record<string, string> = {
  "src/packaging/acceptance-prose.test.ts":
    'passes the string "git" to `onlyResolves()`, a local predicate standing in for the injected '
    + "`commandExists` seam -- the file imports node:test, node:assert/strict and the module under test, "
    + "and has no node:child_process import at all (a11ign/a11ign#446, trunk red 2026-09-08T08:00:30Z)",
  "src/wake-review-recheckout.test.ts":
    'its `git` is an injected fake seam (`checkout: { git, exists, link, root, repoRoot }`) that records each call '
    + "and answers from a map of tree heads -- the file imports node:test, node:assert/strict, node:fs/os/path and "
    + "the modules under test, and has no node:child_process import, so nothing here can spawn (#2771)",
};

/** The spawning capability a file must import before it can spawn anything, whatever the callee is named. */
const CAN_SPAWN = /from\s+["']node:child_process["']|require\(\s*["']node:child_process["']/;

/**
 * A file spawns git either directly (matched above) or through `withGitSandbox`, which never appears as
 * a literal `"git"` call at the SITE it is used from -- `pre-commit-hook.test.ts`, `promotion-refuses-
 * dirty.test.ts` and `lab-reset-removal.test.ts` all migrated to it and, correctly, no longer contain the
 * literal string. Missing this second form would silently shrink the discovered population by exactly the
 * three files that motivated writing this test in the first place -- the "reader examining less than it
 * believes" failure named in this file's header, caught here by testing the discovery against the real
 * fixed files rather than trusting the regex on sight.
 */
/**
 * #1185: THE PER-SPAWN CHECK MOVED TO `local/git-spawn-scrubbed`. WHAT STAYS HERE, AND WHY.
 *
 * The rule asks, of each `execFileSync("git", …)`, whether its file imports AND calls a canonical helper,
 * and reports **at the spawn's line** on every lint run. That is strictly better than this sweep for that
 * question: the sweep runs once in the PR suite and fails far from the call.
 *
 * **Two things it cannot do, and they are why this file is not deleted:**
 *
 * 1. **THE POPULATION.** A rule sees one file at a time and has no census, so it cannot notice that the
 *    discovery pattern itself broke and matched nothing. `the discovery finds a non-trivial population`
 *    below is that guard, and a lint rule reporting zero is indistinguishable from a lint rule that
 *    matches nothing — which is #1165's shape and exactly what this repository files rows about.
 * 2. **THE EXEMPTIONS ARE VERIFIED, not merely listed.** `GIT_IS_DATA_NOT_A_SPAWN`'s test proves each
 *    entry names a tracked file that genuinely trips the pattern, does NOT import `node:child_process`,
 *    and carries a reason longer than a placeholder. The rule's `dataNotASpawn` option can only be a list;
 *    an exemption nobody checks is a bypass, and #1167's `guarded-by <symbol>` learned the same lesson.
 *
 * So: the rule holds the line per spawn, and this file holds the claims ABOUT THE SET. Measured at the
 * conversion: 79 files spawn git and 79 scrub, so neither has a finding to make today.
 */
function spawnsGit(executable: string): boolean {
  return SPAWNS_GIT_DIRECTLY.test(executable) || /\bwithGitSandbox\(/.test(executable);
}

/** Imports one of the canonical helpers (by basename, since real imports are relative) AND actually calls it. */
function usesCanonicalHelper(executable: string): boolean {
  const importsHelper = CANONICAL_HELPER_BASENAMES.some((basename) => executable.includes(basename));
  if (!importsHelper) return false;
  return /\bsandboxGitEnv\(/.test(executable) || /\bwithGitSandbox\(/.test(executable);
}

test("the discovery finds a non-trivial population -- vacuity guard for the walk itself", () => {
  const files = trackedSourceFiles();
  assert.ok(files.length > 200, `only found ${files.length} .ts/.mjs files in the tool -- the walk is broken`);
  const spawningGit = files.filter((f) => spawnsGit(stripComments(f.text)));
  // MEASURED at a11ign/a11ign#3106 (this port, on the tool at agent-org 268dd20+): 379 files before the helpers are set aside, 78 of them spawn git. A lower bound, not a
  // pin -- a NEW git-spawning file legitimately raises the count, and the test below is what catches one that is not classified. This
  // guard exists only to catch the OTHER failure: the regex itself breaking and matching nothing.
  assert.ok(spawningGit.length >= 60,
    `only found ${spawningGit.length} git-spawning file(s), fewer than the 78 measured at the port -- the `
    + `discovery pattern itself is probably broken, not the population shrinking`);
});

test("every GIT_IS_DATA_NOT_A_SPAWN entry names a real file that genuinely CANNOT spawn -- the exemption "
  + "is not a bypass", () => {
  const tracked = new Map(trackedSourceFiles().map((f) => [f.path, f.text]));
  for (const [file, reason] of Object.entries(GIT_IS_DATA_NOT_A_SPAWN)) {
    assert.ok(tracked.has(file),
      `${file} is exempted but is not a tracked source file -- a stale exemption hides the next real one`);
    const executable = stripComments(tracked.get(file) ?? "");
    assert.ok(spawnsGit(executable),
      `${file} is exempted from a rule it no longer trips -- delete the entry rather than carrying it`);
    assert.ok(!CAN_SPAWN.test(executable),
      `${file} DOES import node:child_process, so "the literal is data" is false and this exemption is `
      + "hiding a real unscrubbed spawn -- the exact failure this whole test exists to prevent");
    assert.ok(reason.trim().length > 40,
      `${file}'s exemption needs a reason a reader can check, not a placeholder`);
  }
});

test("every git-spawning file imports and USES a canonical GIT_* scrubbing helper", () => {
  const files = trackedSourceFiles();
  const unclassified: string[] = [];
  for (const { path: file, text } of files) {
    const executable = stripComments(text);
    if (!spawnsGit(executable)) continue;
    // #446/trunk-red: a declared "the literal is data" file is classified, not skipped -- see
    // GIT_IS_DATA_NOT_A_SPAWN, and the test below that proves each entry genuinely cannot spawn.
    if (file in GIT_IS_DATA_NOT_A_SPAWN) continue;
    if (!usesCanonicalHelper(executable)) unclassified.push(file);
  }
  assert.deepEqual(unclassified, [],
    `${unclassified.length} file(s) spawn git without scrubbing GIT_* through a canonical helper -- this `
    + "is the exact shape that let a leaked GIT_DIR redirect a spawned git call onto the real repository "
    + `on 2026-09-06 (docs/backlog.md, 'a closed row created the exposure'):\n`
    + unclassified.map((f) => `  ${f}`).join("\n"));
});

// --- The guard must be shown to fail, or it proves nothing (CLAUDE.md: "a guard must be shown to fail
// before it is trusted") ---

test("MUTATION: a file spawning git with no helper import is CAUGHT, not silently passed", () => {
  const fixture = 'import { execFileSync } from "node:child_process";\n'
    + 'execFileSync("git", ["status"], { cwd: "/tmp" });\n';
  assert.ok(spawnsGit(stripComments(fixture)), "the discovery pattern must match a plain git spawn");
  assert.ok(!usesCanonicalHelper(stripComments(fixture)),
    "a file with no canonical-helper import must not be classified SAFE");
});

test("MUTATION: an import with no actual call is NOT classified SAFE -- 'imported' is not 'used'", () => {
  const fixture = 'import { execFileSync } from "node:child_process";\n'
    + 'import { sandboxGitEnv } from "../lib/git-env.mjs";\n'
    // sandboxGitEnv is imported but never called -- the git spawn below is still bare.
    + 'execFileSync("git", ["status"], { cwd: "/tmp" });\n';
  assert.ok(spawnsGit(stripComments(fixture)));
  assert.ok(!usesCanonicalHelper(stripComments(fixture)),
    "importing sandboxGitEnv without calling it must not satisfy the check -- an unused import guards nothing");
});

test("MUTATION: an indirected call through an injected seam is still discovered", () => {
  // install-git-hooks.mjs's own shape: the literal "git" is the first argument to a locally-named `run`,
  // never to execFileSync directly. A discovery anchored to node:child_process function names would miss
  // this exact file.
  const fixture = 'const run = (cmd, args, opts) => execFileSync(cmd, args, opts);\n'
    + 'run("git", ["config", "core.hooksPath", "x"], { cwd: "/repo" });\n';
  assert.ok(spawnsGit(stripComments(fixture)),
    "the discovery must see through a one-level indirection to the literal git call");
});

test("CONTROL: a correctly classified file passes", () => {
  const fixture = 'import { execFileSync } from "node:child_process";\n'
    + 'import { sandboxGitEnv } from "../lib/git-env.mjs";\n'
    + 'execFileSync("git", ["status"], { cwd: "/tmp", env: sandboxGitEnv() });\n';
  assert.ok(spawnsGit(stripComments(fixture)));
  assert.ok(usesCanonicalHelper(stripComments(fixture)),
    "a file importing AND calling sandboxGitEnv must be classified SAFE, or every real file would fail too");
});

test("MUTATION: a file using withGitSandbox with no literal git call is still discovered, not invisible", () => {
  // Exactly the shape pre-commit-hook.test.ts, promotion-refuses-dirty.test.ts and lab-reset-removal.test.ts
  // took after migrating: the literal "git" string disappears behind `sandbox.run`/`sandbox.commit`, and a
  // discovery anchored ONLY to a literal git call would silently shrink the population by these three --
  // the exact "reader examining less than it believes" failure this file's header names.
  const fixture = 'import { withGitSandbox } from "../lib/git-sandbox.ts";\n'
    + 'withGitSandbox((sandbox) => { sandbox.run(["status"]); });\n';
  assert.ok(spawnsGit(stripComments(fixture)),
    "a file that spawns git only through withGitSandbox, with no literal git call of its own, must still "
    + "be discovered -- and must also be classified SAFE, since going through the sandbox IS the fix");
  assert.ok(usesCanonicalHelper(stripComments(fixture)));
});

test("CONTROL: a file that never spawns git is simply not part of the population", () => {
  const fixture = 'export function addOne(n: number) { return n + 1; }\n';
  assert.ok(!spawnsGit(stripComments(fixture)));
});
