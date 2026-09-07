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
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ownerOf, stashLines } from "../../../../scripts/stash-whose.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const HOOK = join(REPO, "scripts/git-hooks/reference-transaction");

/** Run git in `cwd`, returning `{code, stderr}` rather than throwing — the refusal IS the result here. */
function git(cwd: string, args: string[]): { code: number; stderr: string } {
  try {
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stderr?: string };
    return { code: e.status ?? 1, stderr: String(e.stderr ?? "") };
  }
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
    const listed = execFileSync("git", ["stash", "list"], { cwd: second, encoding: "utf8" });
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
    assert.equal(execFileSync("git", ["stash", "list"], { cwd: main, encoding: "utf8" }), "",
      "and nothing reached the shared pile");
  } finally { cleanup(); }
});

test("a LABELLED stash proceeds — the guard must not stop the practice, only the anonymity", () => {
  const { main, cleanup } = twoWorktrees();
  try {
    writeFileSync(join(main, "a.txt"), "labelled work\n");
    assert.equal(git(main, ["stash", "push", "-m", "agent/my-branch: wip"]).code, 0);
    assert.match(execFileSync("git", ["stash", "list"], { cwd: main, encoding: "utf8" }),
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

test("A11Y_STASH_ANY=1 is honoured, so the guard has a named way through", () => {
  const { main, cleanup } = twoWorktrees();
  try {
    writeFileSync(join(main, "a.txt"), "deliberate\n");
    execFileSync("git", ["stash", "push"], { cwd: main, env: { ...process.env, A11Y_STASH_ANY: "1" } });
    assert.match(execFileSync("git", ["stash", "list"], { cwd: main, encoding: "utf8" }), /WIP on main/);
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
