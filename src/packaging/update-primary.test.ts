/**
 * `primary:update` is the ONE sanctioned way to move the primary checkout (#126), which makes it the only
 * place a rebuild can live and be reached every time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updatePrimary, lockfileMoved } from "../../../../scripts/update-primary.mjs";
import { changedFiles } from "../../../../scripts/changed-files.mjs";
import { withGitSandbox } from "../../../../scripts/test-support/git-sandbox.ts";
import { UPDATE_PRIMARY_VERBS } from "./update-primary-argv.mjs";

/**
 * MOVING THE PRIMARY MOVES EVERY WORKTREE'S `dist`, AND NOTHING ELSE DOES.
 *
 * Every linked worktree shares the primary's `node_modules`, so a cross-package import from any of them
 * resolves to THE PRIMARY'S `dist` — CLAUDE.md states it, and `docs/operational-lessons.md` records the
 * afternoon spent finding that "resolves to dist" does not say whose. So a fast-forward advances the
 * SOURCE nine worktrees compile against while leaving the COMPILED OUTPUT wherever it last was.
 *
 * Measured 2026-09-09: the orchestrator's DOCS-ONLY push was refused by the pre-push hook on a module
 * `main` has and the primary's `dist` did not. A docs change, refused by a resolution failure, in a
 * worktree that had never been anything but current — and nothing in the message could point at the
 * primary, because the primary was not what they had touched.
 *
 * The build belongs IN the update rather than beside it: anything a human has to remember is something
 * that does not happen, and `primary:update` is already the one sanctioned way to move this checkout
 * (#126), which makes it the only place this can live and be reached every time.
 */
test("#749 updatePrimary BUILDS after the fast-forward -- the source moves and dist must follow", () => {
  const calls: string[][] = [];
  const root = mkdtempSync(join(tmpdir(), "a11y-primary-build-"));
  try {
    mkdirSync(join(root, ".git"));
    const built: string[] = [];
    updatePrimary(root, (args) => { calls.push(args); return "abc123\n"; }, (cwd) => built.push(cwd));
    assert.deepEqual(built, [root], "the build runs, once, in the primary");
    const order = calls.map((c) => c[0]);
    // The second `rev-parse` is `moveLocalMain` reading `refs/heads/main`; this stub returns the same sha
    // for everything, so it finds the branch already at the target and stops there. The order that
    // matters is unchanged: the build runs AFTER the checkout.
    // The verbs come from the SAME list `primary-checkout-guard.test.ts` asserts in full -- see
    // `update-primary-argv.mjs` for why that is one constant rather than two.
    assert.deepEqual(order, [...UPDATE_PRIMARY_VERBS],
      "and it runs AFTER the checkout -- building the tree you are about to move is building the wrong tree");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#749 a FAILED build throws, naming what it means, and does NOT roll the checkout back", () => {
  const root = mkdtempSync(join(tmpdir(), "a11y-primary-buildfail-"));
  try {
    mkdirSync(join(root, ".git"));
    const calls: string[][] = [];
    assert.throws(
      () => updatePrimary(root, (args) => { calls.push(args); return "abc123\n"; },
        () => { throw Object.assign(new Error("boom"), { status: 2 }); }),
      /worktree resolves THIS checkout's dist/,
      "the message must say what a stale dist DOES, not merely that a build failed");
    assert.ok(calls.some((c) => c[0] === "checkout"),
      "the fast-forward already happened and is correct; a failed build must not revert a checkout "
      + "somebody else may already be reading");
    assert.ok(!calls.some((c) => c[0] === "reset" || c[0] === "revert"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#749 MUTATION TARGET: without the build call the source moves and dist does not, silently", () => {
  // The pre-#749 shape, written out: fetch, checkout, rev-parse, return. Nothing announces that every
  // worktree is now compiling against a dist one or more commits behind its own source.
  const calls: string[][] = [];
  const root = mkdtempSync(join(tmpdir(), "a11y-primary-mutation-"));
  try {
    mkdirSync(join(root, ".git"));
    const built: string[] = [];
    updatePrimary(root, (args) => { calls.push(args); return "abc123\n"; }, (cwd) => built.push(cwd));
    assert.notDeepEqual(built, [], "if this passes with an empty list, the build is no longer wired");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


// ---------------------------------------------------------------------------------------------------
// THE LOCAL `main` BRANCH IS SHARED BY EVERY WORKTREE, AND NOTHING MOVED IT.
//
// The primary is detached at `origin/main` deliberately — that is what makes it read-only except
// fast-forward. But `main` is a branch in the same `.git`, checked out nowhere. Measured 2026-09-09: it
// sat at `11d77ade` from 07 Sep while `origin/main` was `cb9dfbce`, **1405 commits behind**, and all 76
// worktrees resolve that one ref.
//
// A range against bare `main` therefore answers a two-day-old question, and the answer looks exactly
// like an answer: `rev-list --count main..<branch>` reported 502 where `origin/main..<branch>` reported
// 1, and a session called a one-commit `wip` branch an old divergent rewrite on the strength of it.

/** Drives `updatePrimary` with a scripted `run`, recording every argv. */
function driveUpdate(reply: (args: string[]) => string) {
  const calls: string[][] = [];
  const root = mkdtempSync(join(tmpdir(), "a11y-primary-main-"));
  try {
    mkdirSync(join(root, ".git"));
    updatePrimary(root, (args) => { calls.push(args); return reply(args); }, () => {});
  } finally { rmSync(root, { recursive: true, force: true }); }
  return calls;
}

test("the local `main` branch is fast-forwarded to the same sha the primary moved to", () => {
  const calls = driveUpdate((args) =>
    args[0] === "rev-parse" && args[1] === "refs/heads/main" ? "old111\n" : "new222\n");
  const update = calls.find((c) => c[0] === "update-ref");
  assert.deepEqual(update, ["update-ref", "refs/heads/main", "new222", "old111"],
    "and it passes the EXPECTED OLD VALUE, so the write refuses rather than races if another session "
    + "moved the ref first");
});

test("MUTATION: a DIVERGED local `main` is left alone -- it is somebody's unpushed work, and this "
  + "command destroys nothing", () => {
  const calls = driveUpdate((args) => {
    if (args[0] === "merge-base") throw new Error("not an ancestor");
    return args[1] === "refs/heads/main" ? "old111\n" : "new222\n";
  });
  assert.equal(calls.some((c) => c[0] === "update-ref"), false,
    "`git branch -f` would move it without complaint, which is the one thing this must not do");
});

test("CONTROL: no local `main` at all is not an error, and does not create one", () => {
  const calls = driveUpdate((args) => {
    if (args[0] === "rev-parse" && args[1] === "refs/heads/main") throw new Error("unknown revision");
    return "new222\n";
  });
  assert.equal(calls.some((c) => c[0] === "update-ref"), false);
  assert.equal(calls.some((c) => c[0] === "branch"), false, "creating one is not this command's job");
});

test("CONTROL: a `main` already at the target writes nothing -- no ref update, no merge-base", () => {
  const calls = driveUpdate(() => "same333\n");
  assert.equal(calls.some((c) => c[0] === "update-ref"), false);
  assert.equal(calls.some((c) => c[0] === "merge-base"), false);
});

/**
 * THE COPY MUST NOT COME BACK. Both argv assertions now read `update-primary-argv.mjs`; nothing stops a
 * future edit from inlining the list again, and inlining it is exactly what produced the merge-blocking
 * red on 2026-09-09 — one file updated, the other found by CI.
 *
 * So this asserts on the SOURCE of both test files: neither may contain the argv literal itself. It is a
 * text check because that is what the defect is — two copies of one fact — and no behavioural test can
 * see the difference between one constant and two identical ones.
 */
test("neither argv assertion carries its own copy of the list -- the fact is stated once", () => {
  const here = (name: string) =>
    readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
  for (const name of ["update-primary.test.ts", "primary-checkout-guard.test.ts"]) {
    const src = here(name);
    assert.match(src, /UPDATE_PRIMARY_(ARGV|VERBS)/,
      `${name} must assert THROUGH the shared list`);
    assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ""),
      /\["checkout", "--detach", "origin\/main", "--quiet"\]/,
      `${name} carries its own copy of the argv list -- that is the fact stated twice, and the copy `
      + "that survives is the one nobody is looking at");
  }
});


// ---------------------------------------------------------------------------------------------------
// #1384: A MERGE THAT MOVES THE LOCKFILE MUST INSTALL, OR EVERY WORKTREE'S PUSH FAILS.
//
// Every linked worktree resolves the primary's `node_modules`. Measured 2026-09-13: #1380 (`8fe2db08`)
// added `@rstest/core` as a root devDependency, `primary:update` moved the primary to the new lockfile and
// rebuilt, nothing installed, and every push from the host failed its pre-push typecheck with TS2307 from
// 18:46Z until `ceo` installed by hand.
//
// The expected file name is written as a literal throughout, never imported from the script: a constant
// read from the source it checks would pass with the wrong name in both places.

type Asked = { range: string[]; pathspec: string[] };

/**
 * Drives `updatePrimary` across a MOVED head: HEAD reads `old111` before the checkout and `new222` after,
 * and the shared `main` is already at `new222`. The changed-paths helper answers `changedAnswer`. Records
 * every git argv, every question put to the helper and every npm argv, and returns what was thrown rather
 * than throwing it.
 */
function driveMove(changedAnswer: string[], npm: (args: string[]) => void = () => {}) {
  const git: string[][] = [];
  const asked: Asked[] = [];
  const npmCalls: string[][] = [];
  let headReads = 0;
  let thrown: unknown;
  const root = mkdtempSync(join(tmpdir(), "a11y-primary-lockfile-"));
  try {
    mkdirSync(join(root, ".git"));
    const run = (args: string[]) => {
      git.push(args);
      if (args[0] === "rev-parse" && args[1] === "HEAD") return headReads++ === 0 ? "old111\n" : "new222\n";
      return args[0] === "rev-parse" ? "new222\n" : "";
    };
    const changed = (range: string[], pathspec: string[]) => { asked.push({ range, pathspec }); return changedAnswer; };
    try {
      updatePrimary(root, run, (_cwd, args) => { npmCalls.push(args); npm(args); }, changed);
    } catch (error) {
      thrown = error;
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
  return { git, asked, npmCalls, thrown };
}

test("#1384 ACCEPTANCE: a move that changed the lockfile runs npm install, BEFORE the build", () => {
  const { git, asked, npmCalls, thrown } = driveMove(["package-lock.json"]);
  assert.equal(thrown, undefined);
  assert.deepEqual(asked, [{ range: ["old111", "new222"], pathspec: ["package-lock.json"] }],
    "the question is asked of the commit the checkout LEFT and the one it ARRIVED at, for the root lockfile");
  assert.equal(git.some((argv) => argv[0] === "diff"), false,
    "#939: the paths come from scripts/changed-files.mjs, never from a second spelling of the diff");
  assert.deepEqual(npmCalls, [["install"], ["run", "build"]],
    "install first: a build before it compiles the new source against the old node_modules");
});

test("#1384 CONTROL: a move that did NOT change the lockfile asks the question and installs nothing", () => {
  const { asked, npmCalls, thrown } = driveMove([]);
  assert.equal(thrown, undefined);
  assert.equal(asked.length, 1,
    "the positive control for the absence below: the lockfile question WAS asked, and answered no");
  assert.deepEqual(npmCalls, [["run", "build"]]);
});

test("#1384 the install is NEVER npm ci -- it would delete node_modules from under every worktree", () => {
  const { npmCalls } = driveMove(["package-lock.json"]);
  const installs = npmCalls.filter((argv) => argv[0] !== "run");
  assert.deepEqual(installs, [["install"]], "exactly one install, and it is `npm install`");
  assert.equal(npmCalls.some((argv) => argv.includes("ci") || argv.includes("clean-install")), false,
    "`npm ci` deletes node_modules before installing, which removes it from under every running worktree");
});

test("#1384 a HEAD that did not move asks no lockfile question at all", () => {
  const npmCalls: string[][] = [];
  const asked: Asked[] = [];
  const root = mkdtempSync(join(tmpdir(), "a11y-primary-unmoved-"));
  try {
    mkdirSync(join(root, ".git"));
    updatePrimary(root, () => "same333\n", (_cwd, args) => npmCalls.push(args),
      (range, pathspec) => { asked.push({ range, pathspec }); return ["package-lock.json"]; });
  } finally { rmSync(root, { recursive: true, force: true }); }
  assert.deepEqual(asked, [], "a range from a commit to itself is empty by construction, so it is not asked");
  assert.deepEqual(npmCalls, [["run", "build"]]);
});

test("#1384 the lockfile is matched BY NAME: a nested package-lock.json in the answer does not install", () => {
  const { npmCalls } = driveMove(["packages/x/package-lock.json"]);
  assert.deepEqual(npmCalls, [["run", "build"]]);
});

test("#1384 a FAILED install throws naming the stale node_modules, skips the build, and rolls nothing back", () => {
  const { git, npmCalls, thrown } = driveMove(["package-lock.json"], (args) => {
    if (args[0] === "install") throw Object.assign(new Error("boom"), { status: 7 });
  });
  assert.ok(thrown instanceof Error, "reported, never swallowed");
  assert.match(thrown.message, /stale node_modules/, "the message says what a failed install DOES to every worktree");
  assert.match(thrown.message, /exit 7/);
  assert.match(thrown.message, /will NOT retry/, "a re-run finds HEAD at the target and asks nothing, so it must say so");
  assert.match(thrown.message, /never `npm ci`/, "the by-hand remedy must not be the one that breaks every worktree");
  assert.equal((thrown.cause as Error).message, "boom");
  assert.deepEqual(npmCalls, [["install"]], "the build does not run against a node_modules known to be stale");
  assert.ok(git.some((argv) => argv[0] === "checkout"), "the checkout already moved and is correct");
  assert.equal(git.some((argv) => argv[0] === "reset" || argv[0] === "revert" || argv.includes("old111") && argv[0] === "checkout"),
    false, "a failed install must not revert a checkout somebody else may already be reading");
});

test("#1384 lockfileMoved through the REAL changed-files helper: the root lockfile, across one commit or several", () => {
  withGitSandbox((sandbox) => {
    const commitWith = (path: string, content: string) => {
      mkdirSync(join(sandbox.dir, path, ".."), { recursive: true });
      writeFileSync(join(sandbox.dir, path), content);
      sandbox.run(["add", path]);
      sandbox.commit(`write ${path}`);
      return sandbox.run(["rev-parse", "HEAD"]).trim();
    };
    const changed = (range: string[], pathspec: string[]) => changedFiles(range, { repoRoot: sandbox.dir, pathspec });
    const first = commitWith("package-lock.json", '{"lockfileVersion":3}\n');
    const readmeOnly = commitWith("README.md", "docs\n");
    const nestedOnly = commitWith("packages/x/package-lock.json", "{}\n");
    const lockfile = commitWith("package-lock.json", '{"lockfileVersion":3,"packages":{}}\n');
    sandbox.run(["mv", "package-lock.json", "moved-lock.json"]);
    sandbox.commit("move the lockfile away");
    const movedAway = sandbox.run(["rev-parse", "HEAD"]).trim();
    assert.equal(lockfileMoved(changed, first, readmeOnly), false, "a README-only move is not a lockfile move");
    assert.equal(lockfileMoved(changed, readmeOnly, nestedOnly), false, "a nested package-lock.json is not the root one");
    assert.equal(lockfileMoved(changed, nestedOnly, lockfile), true, "the root lockfile changed");
    assert.equal(lockfileMoved(changed, first, lockfile), true, "a fast-forward spanning several commits, the real shape");
    assert.equal(lockfileMoved(changed, lockfile, movedAway), true,
      "a lockfile moved AWAY is a lockfile move. NOT a pin on #939's --no-renames: measured, this stays true with "
      + "the flag removed from changed-files.mjs, because the pathspec excludes the destination. What keeps this "
      + "read on the helper is changed-files-renames.test.ts and the ACCEPTANCE test's no-diff-through-run line");
  });
});
