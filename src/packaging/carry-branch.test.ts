/**
 * `scripts/carry-branch.mjs` — #656, ceo's own mechanism: a detached worktree merges `origin/main` into
 * a branch and pushes, without ever checking that branch NAME out locally, so it cannot collide with
 * wherever its owner already has it. See that file's own header for the incident (#614) and the
 * three limits ceo stated as the point rather than caveats.
 *
 * DEMONSTRATED AGAINST A REAL HELD BRANCH, per #656's own acceptance text ("demonstrated once against a
 * real held branch rather than argued") -- a synthetic three-actor topology (a bare `origin`, a
 * `primary` checkout, and an `owner` linked worktree holding the branch), never a mocked git layer for
 * the mechanism itself. `sandboxGitEnv` scrubs `GIT_*` throughout, for the identical reason
 * `pre-push-resolve-toward-main.test.ts` and `test-support/git-sandbox.ts` both state at length: `cwd`
 * is not isolation for a spawned git process, `GIT_DIR` is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxGitEnv } from "../../../../scripts/git-env.mjs";
import { carryBranch, branchCheckedOutLocally, noteCarryOnPr } from "../../../../scripts/carry-branch.mjs";

/** One git call, GIT_* always scrubbed -- `cwd` is not isolation, see this file's own header. */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: sandboxGitEnv() });
}

function commit(cwd: string, path: string, content: string, message: string): void {
  execFileSync("bash", ["-c", `printf '%s' ${JSON.stringify(content)} > ${JSON.stringify(path)}`], { cwd });
  git(cwd, ["add", path]);
  git(cwd, ["-c", "user.name=Carry Test", "-c", "user.email=carry-test@example.invalid",
    "commit", "-q", "-m", message]);
}

/**
 * Three real repositories, wired together exactly like the real incident: a bare `origin`, a `primary`
 * checkout of it (stays on `main` throughout, standing in for the shared control-plane checkout), and an
 * `owner` LINKED WORKTREE off `primary` holding `agent/<branch>` checked out -- the actual shape that
 * made `git worktree add` refuse for the dispatcher on #614. Torn down unconditionally.
 */
function withHeldBranchTopology<T>(fn: (t: { origin: string; primary: string; owner: string; branch: string }) => T): T {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "carry-branch-topo-")));
  const origin = join(root, "origin.git");
  const primary = join(root, "primary");
  const owner = join(root, "owner");
  const branch = "agent/held-branch-test";
  try {
    execFileSync("git", ["init", "--quiet", "--bare", origin], { env: sandboxGitEnv() });
    execFileSync("git", ["clone", "--quiet", origin, primary], { env: sandboxGitEnv() });
    commit(primary, "README.md", "primary\n", "initial commit on main");
    git(primary, ["push", "-q", "-u", "origin", "main"]);
    git(primary, ["checkout", "-q", "-b", branch]);
    commit(primary, "owner-work.txt", "the owner's own work\n", "start the branch");
    git(primary, ["push", "-q", "-u", "origin", branch]);
    git(primary, ["checkout", "-q", "main"]);
    // THE HELD STATE: a LINKED WORKTREE off primary, holding the branch checked out -- reproduces the
    // exact fatal error #656's own header quotes when a second `worktree add` names the same branch.
    git(primary, ["worktree", "add", "-q", owner, branch]);
    return fn({ origin, primary, owner, branch });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("branchCheckedOutLocally: true for a branch genuinely held in a linked worktree", () => {
  withHeldBranchTopology(({ primary, branch }) => {
    assert.equal(branchCheckedOutLocally(branch, primary), true);
  });
});

test("branchCheckedOutLocally: false for a branch nothing has checked out", () => {
  withHeldBranchTopology(({ primary }) => {
    assert.equal(branchCheckedOutLocally("agent/nothing-holds-this", primary), false);
  });
});

test("REPRODUCES THE #614 COLLISION: an ordinary (non-detached) worktree add for the SAME branch name "
  + "is refused, by git itself, exactly as the issue's own header quotes", () => {
  withHeldBranchTopology(({ primary, branch }) => {
    const collidingDir = mkdtempSync(join(tmpdir(), "carry-branch-collide-"));
    try {
      assert.throws(() => git(primary, ["worktree", "add", collidingDir, branch]),
        /already used by worktree/,
        "this is the premise #656 exists to work around -- if git ever stops refusing this, the whole "
        + "row's reason for existing needs re-examining");
    } finally {
      rmSync(collidingDir, { recursive: true, force: true });
    }
  });
});

test("#656 ACCEPTANCE: carryBranch succeeds against a REAL held branch -- no collision, because the "
  + "carry never checks the branch out by NAME", () => {
  withHeldBranchTopology(({ origin, primary, branch }) => {
    // MAIN MOVES UNDER THE BRANCH, simulating the real #614 shape ("97 commits behind") in miniature --
    // one commit is enough to prove the merge actually reaches it.
    commit(primary, "main-moved-on.txt", "main advanced\n", "main moves on");
    git(primary, ["push", "-q", "origin", "main"]);
    // `primary` stays on `main` throughout -- the owner worktree already holds `branch` checked out, so
    // `primary` itself never needs (and must never attempt) to check it out too.

    const result = carryBranch(primary, branch);
    assert.equal(result.carried, true, `expected the carry to succeed; got: ${JSON.stringify(result)}`);
    assert.match((result as { diffstat: string }).diffstat, /main-moved-on\.txt/,
      "the diffstat must name what origin/main actually contributed, not just report a clean exit -- "
      + "#232's own lesson: a clean exit can still have dropped what mattered");

    // THE PUSH REALLY LANDED: fetch the branch fresh and confirm it now carries BOTH the owner's own
    // work and what main contributed.
    const check = mkdtempSync(join(tmpdir(), "carry-branch-verify-"));
    try {
      execFileSync("git", ["clone", "--quiet", "--branch", branch, origin, check], { env: sandboxGitEnv() });
      const files = git(check, ["ls-files"]);
      assert.match(files, /owner-work\.txt/, "the owner's own work must survive the carry");
      assert.match(files, /main-moved-on\.txt/, "origin/main's contribution must be present after the carry");
    } finally {
      rmSync(check, { recursive: true, force: true });
    }
  });
});

test("#656: THE ORDINARY CASE IS UNTOUCHED -- the owner's own linked worktree is unaffected by a carry, "
  + "still checked out on the branch, nothing about it disturbed", () => {
  withHeldBranchTopology(({ primary, owner, branch }) => {
    commit(primary, "main-moved-on.txt", "main advanced\n", "main moves on");
    git(primary, ["push", "-q", "origin", "main"]);

    const before = git(owner, ["rev-parse", "HEAD"]).trim();
    const result = carryBranch(primary, branch);
    assert.equal(result.carried, true);

    // The owner's checked-out branch name and working tree are exactly as they were -- a carry from a
    // detached worktree elsewhere must never reach into an already-checked-out worktree at all.
    assert.equal(git(owner, ["symbolic-ref", "--short", "HEAD"]).trim(), branch);
    assert.equal(git(owner, ["rev-parse", "HEAD"]).trim(), before,
      "the owner's own checkout must not move -- a carry updates the REMOTE ref, never a live worktree");
    assert.equal(git(owner, ["status", "--porcelain"]).trim(), "", "the owner's working tree stays clean");
  });
});

test("#656 MUTATION: the ref-lock is READ, never forced past -- a push that lands from elsewhere while "
  + "the carry is in flight is a REFUSAL, not overridden", () => {
  withHeldBranchTopology(({ origin, primary, branch }) => {
    // Simulates the race #656's own limits name: ANOTHER actor (the owner's own concurrent push, or a
    // second carry) lands on the branch ref between this carry reading it and pushing its own result --
    // driven by pushing a competing commit directly to origin from a THIRD clone, bypassing carryBranch
    // entirely, so the refusal proven here is git's own non-fast-forward protection, not a mock.
    const rival = mkdtempSync(join(tmpdir(), "carry-branch-rival-"));
    try {
      execFileSync("git", ["clone", "--quiet", "--branch", branch, origin, rival], { env: sandboxGitEnv() });
      commit(rival, "rival-push.txt", "a concurrent push\n", "the owner's own concurrent push");
      git(rival, ["push", "-q", "origin", branch]);
    } finally {
      rmSync(rival, { recursive: true, force: true });
    }

    // carryBranch's own `origin/<branch>` is now STALE relative to what is actually on the remote (it
    // opened its detached worktree from a `primary` that has not seen the rival push) -- so its eventual
    // push must be refused as non-fast-forward.
    const result = carryBranch(primary, branch);
    assert.equal(result.carried, false, "a stale carry must be refused, never forced through");
    assert.match((result as { reason: string }).reason, /push refused|ref-lock/i);

    // AND THE RIVAL'S OWN COMMIT SURVIVES -- the strongest proof nothing was forced: fetch fresh and
    // confirm the rival's file is still there, untouched by the refused carry.
    const check = mkdtempSync(join(tmpdir(), "carry-branch-verify-rival-"));
    try {
      execFileSync("git", ["clone", "--quiet", "--branch", branch, origin, check], { env: sandboxGitEnv() });
      assert.match(git(check, ["ls-files"]), /rival-push\.txt/,
        "a force-past carry would have overwritten this; its survival IS the proof");
    } finally {
      rmSync(check, { recursive: true, force: true });
    }
  });
});

test("carryBranch cleans up its own throwaway detached worktree after a successful carry", () => {
  withHeldBranchTopology(({ primary, branch }) => {
    const before = git(primary, ["worktree", "list", "--porcelain"]);
    const result = carryBranch(primary, branch);
    assert.equal(result.carried, true);
    const after = git(primary, ["worktree", "list", "--porcelain"]);
    // Exactly the pre-carry set plus the pre-existing `owner` worktree -- no new entry lingers.
    assert.equal(after.split("worktree ").length, before.split("worktree ").length,
      `a carry must not leave its own temp worktree registered. before:\n${before}\nafter:\n${after}`);
  });
});

// --- noteCarryOnPr: fake `run`, matching this package's own convention for gh-calling functions ---

test("noteCarryOnPr posts a comment naming the carrier and reason, on the branch's real open PR", () => {
  const calls: string[][] = [];
  const run = (cmd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ number: 614 }]);
    return "";
  };
  const result = noteCarryOnPr("agent/pre-push-delete-583", "dispatcher", "97 behind, past the escalation window", { run });
  assert.deepEqual(result, { commented: true, prNumber: 614 });
  const commentCall = calls.find((a) => a[0] === "pr" && a[1] === "comment");
  assert.ok(commentCall, "must post the comment");
  assert.equal(commentCall![2], "614");
  const body = commentCall![commentCall!.indexOf("--body") + 1];
  assert.match(body, /Carried by `dispatcher`/);
  assert.match(body, /97 behind, past the escalation window/);
});

test("noteCarryOnPr reports (never throws) when the branch has no open PR", () => {
  const run = () => JSON.stringify([]);
  const result = noteCarryOnPr("agent/no-pr-branch", "dispatcher", "why", { run });
  assert.equal(result.commented, false);
  assert.match((result as { reason: string }).reason, /no open PR/);
});

test("noteCarryOnPr reports (never throws) when the PR lookup itself fails", () => {
  const run = () => { throw new Error("gh: authentication required"); };
  const result = noteCarryOnPr("agent/x", "dispatcher", "why", { run });
  assert.equal(result.commented, false);
  assert.match((result as { reason: string }).reason, /authentication required/);
});
