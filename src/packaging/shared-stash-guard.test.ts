/**
 * THE STASH IS SHARED ACROSS WORKTREES, AND THE FIXTURE HAS TO BE TOO (#290).
 *
 * `orchestrator` stashed their own change, checked out `origin/main` to test whether a failure was
 * pre-existing, switched back, and `git stash pop` returned **somebody else's uncommitted work** — a
 * 95-line diff plus a new test file, with nothing on it saying whose it was. Their own stash was consumed
 * in the same operation.
 *
 * **A ONE-WORKTREE FIXTURE CANNOT EXPRESS THIS.** The row says so and it is the thing to get right: the
 * fault IS that `refs/stash` is in the common git dir, so a test in a single repository would pass
 * whatever the guard did. Every test here builds a real repository with a real second worktree and
 * drives real `git stash` through the real hook.
 *
 * WHY `reference-transaction`. Git has no pre-stash hook and `pre-commit` cannot see a stash — a stash is
 * a ref update, not a commit. This is the only hook that observes one, and exiting non-zero in the
 * `prepared` phase aborts the transaction with the working tree untouched. Measured before the guard was
 * written, because it decided the design.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ownerOf, stashLines } from "../stash-whose.ts";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { HOME_CHECKOUT } from "../project-config.ts";

const HOOK = join(HOME_CHECKOUT, "scripts/git-hooks/reference-transaction");

/**
 * Run git in `cwd`, returning `{code, stderr}` rather than throwing — the refusal IS the result here.
 * `spawnSync`, not `execFileSync`: the latter only hands back stderr when the process THREW (a nonzero
 * exit), so a warning the hook prints on a SUCCESSFUL pop/drop (#1872's whole point — it warns without
 * refusing) would be silently dropped by the exec-and-catch shape this helper used before.
 */
function git(cwd: string, args: string[]): { code: number; stderr: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: sandboxGitEnv() });
  return { code: result.status ?? 1, stderr: result.stderr ?? "" };
}

/**
 * A real repository, a real second worktree, and the REAL hook — copied in rather than symlinked so the
 * test exercises the shipped file and not a path that happens to resolve.
 */
function twoWorktrees(): { main: string; second: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "stash-guard-"));
  const main = join(root, "main");
  mkdirSync(main);
  git(main, ["init", "-q", "-b", "main", "."]);
  git(main, ["config", "user.email", "t@example.com"]);
  git(main, ["config", "user.name", "t"]);
  writeFileSync(join(main, "a.txt"), "one\n");
  git(main, ["add", "a.txt"]);
  git(main, ["commit", "-qm", "first"]);

  const hooks = join(main, "hooks");
  mkdirSync(hooks);
  // `copyFileSync` + `chmodSync`, NOT `cpSync(..., {mode})` -- that `mode` is a copy-behaviour flag
  // (0-7), not file permissions, and passing 0o755 throws ERR_OUT_OF_RANGE. The hook must be executable
  // or git ignores it silently, which would make every test here pass having exercised nothing.
  const installed = join(hooks, "reference-transaction");
  copyFileSync(HOOK, installed);
  chmodSync(installed, 0o755);
  git(main, ["config", "core.hooksPath", hooks]);

  const second = join(root, "second");
  git(main, ["worktree", "add", "-q", "-b", "other", second]);
  return { main, second, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("THE PREMISE: refs/stash is SHARED — a stash made in one worktree is visible in the other", () => {
  // If this ever stops being true the guard is unnecessary, so it is asserted rather than assumed.
  const { main, second, cleanup } = twoWorktrees();
  try {
    writeFileSync(join(main, "a.txt"), "changed in main\n");
    assert.equal(git(main, ["stash", "push", "-m", "main: mine"]).code, 0);
    const listed = execFileSync("git", ["stash", "list"], { cwd: second, encoding: "utf8", env: sandboxGitEnv() });
    assert.match(listed, /main: mine/,
      "the second worktree can see -- and therefore pop -- a stash the first one made");
  } finally { cleanup(); }
});

test("an UNLABELLED stash is refused, and the change stays in the working tree", () => {
  const { main, cleanup } = twoWorktrees();
  try {
    writeFileSync(join(main, "a.txt"), "unsaved work\n");
    const result = git(main, ["stash", "push"]);
    assert.notEqual(result.code, 0, "an unlabelled stash must not succeed");
    assert.match(result.stderr, /carries no message/);
    assert.match(result.stderr, /SHARED between all worktrees/, "it must say WHY, not just refuse");
    assert.match(result.stderr, /git stash push -m/, "and name the exact remedy");
    // THE HALF THAT MATTERS: refusing must not cost the work.
    const content = execFileSync("cat", [join(main, "a.txt")], { encoding: "utf8" });
    assert.equal(content, "unsaved work\n", "the working tree keeps the change when the stash is refused");
    assert.equal(execFileSync("git", ["stash", "list"], { cwd: main, encoding: "utf8", env: sandboxGitEnv() }), "",
      "and nothing reached the shared pile");
  } finally { cleanup(); }
});

test("a LABELLED stash proceeds — the guard must not stop the practice, only the anonymity", () => {
  const { main, cleanup } = twoWorktrees();
  try {
    writeFileSync(join(main, "a.txt"), "labelled work\n");
    assert.equal(git(main, ["stash", "push", "-m", "agent/my-branch: wip"]).code, 0);
    assert.match(execFileSync("git", ["stash", "list"], { cwd: main, encoding: "utf8", env: sandboxGitEnv() }),
      /agent\/my-branch: wip/);
  } finally { cleanup(); }
});

test("pop, drop and clear are NOT refused — the first version broke all three", () => {
  // A blanket refusal on `refs/stash` transactions looks right and makes the stash unusable: `clear`,
  // `pop` and `drop` all update that ref. Found by running it, not by reading it.
  const { main, cleanup } = twoWorktrees();
  try {
    writeFileSync(join(main, "a.txt"), "work\n");
    git(main, ["stash", "push", "-m", "agent/x: one"]);
    assert.equal(git(main, ["stash", "pop"]).code, 0, "pop must work");
    git(main, ["stash", "push", "-m", "agent/x: two"]);
    assert.equal(git(main, ["stash", "drop"]).code, 0, "drop must work");
    writeFileSync(join(main, "a.txt"), "work again\n");
    git(main, ["stash", "push", "-m", "agent/x: three"]);
    assert.equal(git(main, ["stash", "clear"]).code, 0, "clear must work");
  } finally { cleanup(); }
});

test("a pop whose named branch is checked out LIVE in another worktree right now is REFUSED -- #1896", () => {
  // `main` never leaves its branch, so at the moment `second` pops, git worktree list --porcelain says
  // unambiguously that 'main' is checked out elsewhere -- exactly #1866's and #1896's own incident shape.
  //
  // WHAT THIS CANNOT PROTECT, VERIFIED RATHER THAN ASSUMED: `git stash pop` applies the entry to the
  // working tree BEFORE it ever touches `refs/stash` -- applying is a working-tree/index write, not a ref
  // update, so no hook sees it and refusing the drop that follows cannot undo it. And `git stash drop`'s
  // own reflog rewrite (what makes an entry disappear from `git stash list`) happens as a side effect
  // that reference-transaction never observes either -- the ONLY refs/stash transaction this hook is
  // asked about is the final pointer delete, confirmed by instrumenting the hook to log every phase it
  // received. Refusing THAT still leaves the pointer itself intact (the commit is not orphaned), which is
  // the one thing this hook can actually hold the line on.
  const { main, second, cleanup } = twoWorktrees();
  try {
    writeFileSync(join(main, "a.txt"), "mine on main\n");
    assert.equal(git(main, ["stash", "push", "-m", "quick fix"]).code, 0);
    writeFileSync(join(second, "b.txt"), "second's own unrelated work\n");

    const result = git(second, ["stash", "pop"]);
    assert.notEqual(result.code, 0, "a pop taking a LIVE worktree's own branch must not succeed silently");
    assert.match(result.stderr, /REFUSED/);
    assert.match(result.stderr, /'main'/, "names the branch the stash was actually made on");
    assert.match(result.stderr, new RegExp(main.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "names A's worktree path, not just its branch");
    assert.match(result.stderr, /stash:whose/);

    // The pointer this hook actually protects: refs/stash still resolves to the stash commit, so the
    // data is recoverable (`git stash apply <that sha>`) even though `git stash list` no longer shows it.
    assert.doesNotThrow(() => execFileSync("git", ["rev-parse", "-q", "--verify", "refs/stash"],
      { cwd: main, encoding: "utf8", env: sandboxGitEnv() }),
      "the stash commit itself survives the refused delete -- nothing was garbage-collected");

    // Unrelated, untracked files in B are untouched -- the apply only ever touches paths the stash itself
    // named.
    assert.equal(execFileSync("cat", [join(second, "b.txt")], { encoding: "utf8" }), "second's own unrelated work\n",
      "an unrelated file in B's working tree is untouched by the refused pop");
  } finally { cleanup(); }
});

test("the identical pop, once A has switched off that branch, warns but still succeeds -- unchanged from #1872", () => {
  const { main, second, cleanup } = twoWorktrees();
  try {
    writeFileSync(join(main, "a.txt"), "mine on main\n");
    assert.equal(git(main, ["stash", "push", "-m", "quick fix"]).code, 0);
    assert.equal(git(main, ["checkout", "-q", "--detach", "HEAD"]).code, 0,
      "main releases the branch -- 'main' is no longer checked out anywhere");

    const result = git(second, ["stash", "pop"]);
    assert.equal(result.code, 0, "the pop still succeeds -- #305 already ruled out refusing the general case");
    assert.match(result.stderr, /WARNING/);
    assert.doesNotMatch(result.stderr, /REFUSED/);
    assert.match(result.stderr, /'main'/, "names the branch the stash was actually made on");
    assert.match(result.stderr, /'other'/, "names the branch popping it now");
    assert.match(result.stderr, /stash:whose/, "points at the manual check #305 already named");
  } finally { cleanup(); }
});

test("a SAME-branch pop stays quiet -- nothing new to say", () => {
  const { main, cleanup } = twoWorktrees();
  try {
    writeFileSync(join(main, "a.txt"), "mine\n");
    assert.equal(git(main, ["stash", "push", "-m", "quick fix"]).code, 0);
    const result = git(main, ["stash", "pop"]);
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stderr, /WARNING/);
  } finally { cleanup(); }
});

test("a subject the #290 parser cannot read warns about nothing -- 'cannot tell' isn't 'mismatch'", () => {
  const { main, cleanup } = twoWorktrees();
  try {
    // Neither `WIP on <branch>: ` nor `On <branch>: ` -- the shape #290 never produced and #1872's own
    // parser must therefore refuse to guess at, the same as `ownerOf` does for `stashLines`.
    const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const sha = execFileSync("git", ["commit-tree", "-m", "not a stash-shaped subject at all", EMPTY_TREE],
      { cwd: main, encoding: "utf8", env: sandboxGitEnv() }).trim();
    assert.equal(git(main, ["update-ref", "refs/stash", sha]).code, 0,
      "creation is refused only for the default 'WIP on' subject, not any other text");
    const result = git(main, ["update-ref", "-d", "refs/stash"]);
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stderr, /WARNING/);
  } finally { cleanup(); }
});

test("A11Y_STASH_ANY=1 is honoured, so the guard has a named way through", () => {
  const { main, cleanup } = twoWorktrees();
  try {
    writeFileSync(join(main, "a.txt"), "deliberate\n");
    execFileSync("git", ["stash", "push"],
      { cwd: main, env: { ...sandboxGitEnv(), A11Y_STASH_ANY: "1" } });
    assert.match(execFileSync("git", ["stash", "list"], { cwd: main, encoding: "utf8", env: sandboxGitEnv() }), /WIP on main/);
  } finally { cleanup(); }
});

test("the guard fires in the SECOND worktree too — it is the common dir, not one checkout", () => {
  const { second, cleanup } = twoWorktrees();
  try {
    writeFileSync(join(second, "a.txt"), "work in the second tree\n");
    const result = git(second, ["stash", "push"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /carries no message/);
  } finally { cleanup(); }
});

test("stash:whose reads the branch out of BOTH subject shapes", () => {
  assert.deepEqual(ownerOf("WIP on agent/foo: abc1234 some commit"), { branch: "agent/foo", label: null });
  assert.deepEqual(ownerOf("On agent/foo: my message"), { branch: "agent/foo", label: "my message" });
  assert.deepEqual(ownerOf("something else entirely"), { branch: null, label: null },
    "an unrecognised shape must not be guessed at -- 'cannot tell' and 'no branch' differ");
});

test("stash:whose calls out an unlabelled stash, since the guard cannot reach ones already made", () => {
  const lines = stashLines([{ ref: "stash@{0}", subject: "WIP on agent/foo: abc1234 c" }]);
  assert.match(lines[0], /on agent\/foo/);
  assert.match(lines[0], /NO MESSAGE/);
  assert.match(stashLines([])[0], /No stashes/,
    "empty must read as empty rather than as an error");
});
