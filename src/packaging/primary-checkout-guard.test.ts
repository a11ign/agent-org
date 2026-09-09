/**
 * THE PRIMARY CHECKOUT IS READ-ONLY EXCEPT FAST-FORWARD — issue #126, ruled by `ceo` in messages, twice,
 * after three real incidents in one night: a worktree left parked on a branch, `lab:collect-promotion`
 * committing there because nothing marked the boundary between producing an artefact and committing it,
 * and a failed `cd` into a deleted merge worktree silently falling back here. None was carelessness — the
 * rule was known and written in a role file, and it broke anyway three times because nothing could REFUSE.
 * A ruling that lives only in messages is not a rule; this file is what proves the instrument that
 * replaces it actually works.
 *
 * DRIVES THE REAL, UNMODIFIED SCRIPTS, exactly like `pre-commit-hook.test.ts` — never a reimplementation
 * of either hook's logic in TypeScript, for the identical reason that file's own header gives: a second
 * copy of a decision drifts from the first, and this hook genuinely still governs every commit and
 * checkout in the shared checkout while these tests run.
 *
 * IDENTITY IS AN EXPLICIT LOCAL-CONFIG MARK, and this header used to say `.git` being a real directory.
 *
 * That was #198: a real `.git` directory is true of every ordinary CLONE, so `core.hooksPath` carried
 * `post-checkout` to the lab with a `git pull` and every `lab:job -e ref=<branch>` began failing —
 * `run-job.yml` detaches at the ref you asked for, which is how every job runs at a branch. The predicate
 * is correct for `prune-worktrees.mjs`'s question (within one repo, primary worktree or linked one?) and
 * answers nothing about WHICH MACHINE this is.
 *
 * So the sandbox now MARKS itself (`git config --local a11y.primaryCheckout true`), which is what a real
 * primary carries and what a clone cannot acquire. `markPrimary` below is that one line, and the test
 * directly beneath the marked ones asserts the other direction: an UNMARKED sandbox — the lab's exact
 * shape, real `.git` directory and all — is left alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withGitSandbox, sandboxGitEnv } from "../../../../scripts/test-support/git-sandbox.ts";
import type { GitSandbox } from "../../../../scripts/test-support/git-sandbox.ts";
import { updatePrimary } from "../../../../scripts/update-primary.mjs";
import { UPDATE_PRIMARY_ARGV } from "./update-primary-argv.mjs";

const PRE_COMMIT = fileURLToPath(new URL("../../../../scripts/git-hooks/pre-commit", import.meta.url));
const POST_CHECKOUT = fileURLToPath(new URL("../../../../scripts/git-hooks/post-checkout", import.meta.url));

type Verdict = { status: number; stderr: string };

/**
 * Runs the real `pre-commit` script, unmodified, against a commit staged in `sandbox`. `spawnSync`, not
 * `execFileSync`: the latter discards stderr entirely on a SUCCESSFUL run, and the override case needs to
 * assert the reason was printed even when the hook exits 0.
 */
/**
 * Mark a sandbox as the fleet-driving checkout, the way `npm run primary:mark -- --set` does.
 *
 * LOCAL config, i.e. `.git/config`, which is not cloned and not pulled — that is the whole property the
 * fix for #198 rests on, and using the real key here rather than a test double is what makes these tests
 * exercise the same decision production makes.
 */
function markPrimary(sandbox: GitSandbox): void {
  sandbox.run(["config", "--local", "a11y.primaryCheckout", "true"]);
}

function runPreCommit(sandbox: GitSandbox, env: Record<string, string> = {}): Verdict {
  writeFileSync(join(sandbox.dir, "f.txt"), "content\n");
  sandbox.run(["add", "f.txt"]);
  const result = spawnSync("bash", [PRE_COMMIT], {
    cwd: sandbox.dir, encoding: "utf8", env: sandboxGitEnv(env),
  });
  return { status: result.status ?? 1, stderr: result.stderr ?? "" };
}

/**
 * Runs the real `post-checkout` script, unmodified, with git's own three positional arguments — never
 * through `core.hooksPath`, because git treats a nonzero exit from THIS hook as a warning and still
 * reports the checkout that already happened as a success (post-checkout cannot veto), which would hide
 * the hook's own stderr behind whatever `git checkout` itself printed. Direct invocation is what
 * `pre-commit-hook.test.ts` already does for the identical reason.
 */
function runPostCheckout(sandbox: GitSandbox, args: {
  prevHead: string; newHead: string; isBranchCheckout: "0" | "1"; env?: Record<string, string>;
}): Verdict {
  const result = spawnSync("bash", [POST_CHECKOUT, args.prevHead, args.newHead, args.isBranchCheckout], {
    cwd: sandbox.dir, encoding: "utf8", env: sandboxGitEnv(args.env ?? {}),
  });
  return { status: result.status ?? 1, stderr: result.stderr ?? "" };
}

/** `git symbolic-ref --short -q HEAD` exits 1 (quietly) when HEAD is detached — that is success, not a
 *  thrown error, so this reads it the way the hook script itself does (`|| true`). */
function currentBranch(sandbox: GitSandbox): string {
  const result = spawnSync("git", ["symbolic-ref", "--short", "-q", "HEAD"],
    { cwd: sandbox.dir, encoding: "utf8", env: sandboxGitEnv() });
  return (result.stdout ?? "").trim();
}

/** A linked worktree off `sandbox`, on its own branch — torn down by the caller. */
function addWorktree(sandbox: GitSandbox, branch: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "a11y-git-sandbox-wt-")));
  rmSync(dir, { recursive: true, force: true }); // `git worktree add` must create the directory itself
  sandbox.run(["worktree", "add", "-b", branch, dir]);
  return dir;
}

test("pre-commit REFUSES a commit in the primary (marked, and .git is a directory)", () => {
  withGitSandbox((sandbox) => {
    markPrimary(sandbox);
    const result = runPreCommit(sandbox);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /REFUSING.*fleet-driving checkout.*commit in a worktree/i);
  });
});

test("pre-commit ALLOWS the override, and PRINTS the reason rather than swallowing it", () => {
  withGitSandbox((sandbox) => {
    markPrimary(sandbox);
    const result = runPreCommit(sandbox, { A11Y_PRIMARY_COMMIT_REASON: "deliberate test exception" });
    assert.equal(result.status, 0, `expected the override to pass, got: ${result.stderr}`);
    assert.match(result.stderr, /overridden: deliberate test exception/);
  });
});

test("pre-commit does NOT fire in a linked worktree (.git is a file there)", () => {
  withGitSandbox((sandbox) => {
    sandbox.commit("init", ["--allow-empty"]);
    markPrimary(sandbox);
    const wt = realpathSync(mkdtempSync(join(tmpdir(), "a11y-git-sandbox-wt-")));
    rmSync(wt, { recursive: true, force: true });
    try {
      sandbox.run(["worktree", "add", "-b", "feature", wt]);
      writeFileSync(join(wt, "g.txt"), "content\n");
      execFileSync("git", ["add", "g.txt"], { cwd: wt, env: sandboxGitEnv() });
      execFileSync("bash", [PRE_COMMIT], { cwd: wt, encoding: "utf8", env: sandboxGitEnv() });
      // No throw is the assertion: the hook must exit 0 and never reach the primary-only refusal.
    } finally {
      sandbox.run(["worktree", "remove", "--force", wt]).toString(); // ignore result; cleanup only
    }
  });
});

test("post-checkout SELF-CORRECTS a branch landing in the primary, back to detached origin/main", () => {
  withGitSandbox((sandbox) => {
    sandbox.commit("init", ["--allow-empty"]);
    markPrimary(sandbox);
    const mainSha = sandbox.run(["rev-parse", "HEAD"]).trim();
    sandbox.run(["update-ref", "refs/remotes/origin/main", mainSha]);
    sandbox.run(["checkout", "--detach", mainSha]);
    // The checkout git would already have performed by the time it invokes the hook:
    sandbox.run(["checkout", "-b", "stray-branch"]);

    const result = runPostCheckout(sandbox, { prevHead: mainSha, newHead: mainSha, isBranchCheckout: "1" });
    assert.equal(result.status, 1, "a branch left in the primary must be reported as a refusal");
    assert.match(result.stderr, /REFUSING.*only be detached at origin\/main/i);
    assert.match(result.stderr, /stray-branch/);

    assert.equal(currentBranch(sandbox), "", "the hook must have detached HEAD again, not merely complained");
    const headSha = sandbox.run(["rev-parse", "HEAD"]).trim();
    assert.equal(headSha, mainSha, "and it must land exactly back on origin/main, not just anywhere");
  });
});

test("post-checkout SELF-CORRECTS a detach at the wrong commit, back to origin/main", () => {
  withGitSandbox((sandbox) => {
    sandbox.commit("init", ["--allow-empty"]);
    markPrimary(sandbox);
    const mainSha = sandbox.run(["rev-parse", "HEAD"]).trim();
    sandbox.run(["update-ref", "refs/remotes/origin/main", mainSha]);
    sandbox.commit("a second, non-origin commit", ["--allow-empty"]);
    const otherSha = sandbox.run(["rev-parse", "HEAD"]).trim();
    sandbox.run(["checkout", "--detach", otherSha]);

    const result = runPostCheckout(sandbox, { prevHead: mainSha, newHead: otherSha, isBranchCheckout: "1" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not origin\/main/i);
    assert.equal(sandbox.run(["rev-parse", "HEAD"]).trim(), mainSha);
  });
});

test("post-checkout is SILENT when already detached at origin/main — the correct resting state", () => {
  withGitSandbox((sandbox) => {
    sandbox.commit("init", ["--allow-empty"]);
    markPrimary(sandbox);
    const mainSha = sandbox.run(["rev-parse", "HEAD"]).trim();
    sandbox.run(["update-ref", "refs/remotes/origin/main", mainSha]);
    sandbox.run(["checkout", "--detach", mainSha]);

    const result = runPostCheckout(sandbox, { prevHead: mainSha, newHead: mainSha, isBranchCheckout: "1" });
    assert.equal(result.status, 0, `expected silence, got: ${result.stderr}`);
    assert.equal(result.stderr, "");
  });
});

test("post-checkout ALLOWS the override, and PRINTS the reason rather than correcting silently", () => {
  withGitSandbox((sandbox) => {
    sandbox.commit("init", ["--allow-empty"]);
    markPrimary(sandbox);
    const mainSha = sandbox.run(["rev-parse", "HEAD"]).trim();
    sandbox.run(["update-ref", "refs/remotes/origin/main", mainSha]);
    sandbox.run(["checkout", "--detach", mainSha]);
    sandbox.run(["checkout", "-b", "deliberate-branch"]);

    const result = runPostCheckout(sandbox, { prevHead: mainSha, newHead: mainSha, isBranchCheckout: "1",
      env: { A11Y_PRIMARY_CHECKOUT_REASON: "deliberate test exception" } });
    assert.equal(result.status, 0, `expected the override to pass, got: ${result.stderr}`);
    assert.match(result.stderr, /overridden: deliberate test exception/);
    assert.equal(sandbox.run(["symbolic-ref", "--short", "-q", "HEAD"]).trim(), "deliberate-branch",
      "the override must leave the checkout exactly as it landed, not correct it anyway");
  });
});

test("post-checkout ignores a FILE-level checkout — flag 0 never moves HEAD and is not its business", () => {
  withGitSandbox((sandbox) => {
    sandbox.commit("init", ["--allow-empty"]);
    markPrimary(sandbox);
    const mainSha = sandbox.run(["rev-parse", "HEAD"]).trim();
    sandbox.run(["update-ref", "refs/remotes/origin/main", mainSha]);
    sandbox.run(["checkout", "-b", "some-branch"]); // deliberately left on a branch
    const result = runPostCheckout(sandbox, { prevHead: mainSha, newHead: mainSha, isBranchCheckout: "0" });
    assert.equal(result.status, 0, `expected silence on a file checkout, got: ${result.stderr}`);
    assert.equal(sandbox.run(["symbolic-ref", "--short", "-q", "HEAD"]).trim(), "some-branch",
      "a file-level checkout must not trigger a correction at all");
  });
});

test("post-checkout does NOT fire in a linked worktree (.git is a file there)", () => {
  withGitSandbox((sandbox) => {
    sandbox.commit("init", ["--allow-empty"]);
    markPrimary(sandbox);
    const mainSha = sandbox.run(["rev-parse", "HEAD"]).trim();
    sandbox.run(["update-ref", "refs/remotes/origin/main", mainSha]);
    const wt = addWorktree(sandbox, "wt-branch");
    try {
      execFileSync("bash", [POST_CHECKOUT, mainSha, mainSha, "1"],
        { cwd: wt, encoding: "utf8", env: sandboxGitEnv() });
      // No throw, and the worktree must still be on its own branch — the hook must never have acted.
      const branch = execFileSync("git", ["symbolic-ref", "--short", "-q", "HEAD"],
        { cwd: wt, encoding: "utf8", env: sandboxGitEnv() }).trim();
      assert.equal(branch, "wt-branch");
    } finally {
      sandbox.run(["worktree", "remove", "--force", wt]);
    }
  });
});

test("post-checkout is silent before any fetch has ever populated origin/main", () => {
  withGitSandbox((sandbox) => {
    sandbox.commit("init", ["--allow-empty"]);
    markPrimary(sandbox);
    const sha = sandbox.run(["rev-parse", "HEAD"]).trim();
    sandbox.run(["checkout", "-b", "no-origin-yet"]); // no refs/remotes/origin/main exists at all
    const result = runPostCheckout(sandbox, { prevHead: sha, newHead: sha, isBranchCheckout: "1" });
    assert.equal(result.status, 0, `nothing to enforce against yet; expected silence, got: ${result.stderr}`);
  });
});

/**
 * `scripts/update-primary.mjs` — "the ONE npm script updates the primary: fetch, then detach at
 * origin/main. Nothing else" (issue #126's acceptance, verbatim). Tested through its injectable `run`
 * seam, the same shape `install-git-hooks.mjs`'s `installHooks` already uses, so this never needs a real
 * network fetch to prove the two calls happen, in order, and nothing else does.
 */
test("updatePrimary refuses outside the primary (a linked worktree)", () => {
  withGitSandbox((sandbox) => {
    sandbox.commit("init", ["--allow-empty"]);
    markPrimary(sandbox);
    const wt = addWorktree(sandbox, "feature");
    try {
      assert.throws(() => updatePrimary(wt), /not the primary checkout/);
    } finally {
      sandbox.run(["worktree", "remove", "--force", wt]);
    }
  });
});

test("updatePrimary in the primary calls fetch, then checkout --detach origin/main, then moves the "
  + "shared local `main` -- and nothing else", () => {
  withGitSandbox((sandbox) => {
    // Injected run(), never a real fetch: `updatePrimary` must not need a network to be proven correct.
    // The BUILD is injected for the same reason (#749 added it after the checkout) -- and this test's
    // subject is unchanged by that: it pins the GIT calls, and a build is not one.
    //
    // THE FOURTH CALL IS `moveLocalMain` READING `refs/heads/main`, and it stops there because this
    // stub answers every `rev-parse` with the same sha -- the branch is already at the target, so
    // nothing is written. The DIVERGED and BEHIND paths are driven in `update-primary.test.ts`; what
    // this list pins is that no OTHER command crept in.
    //
    // The local `main` branch is shared by every worktree and nothing had ever moved it: measured
    // 2026-09-09 at 1405 commits behind `origin/main`, so `rev-list main..<branch>` had been answering
    // a two-day-old question in all 76 of them.
    const calls: string[][] = [];
    const run = (args: string[]) => { calls.push(args); return "abc123\n"; };
    const sha = updatePrimary(sandbox.dir, run, () => {});
    assert.equal(sha, "abc123");
    // THE LIST IS OWNED BY `update-primary-argv.mjs`, not written here. It was written in two files, and
    // when `moveLocalMain` added a fourth call the other one was updated and this was found by CI.
    assert.deepEqual(calls, UPDATE_PRIMARY_ARGV.map((argv) => [...argv]),
      "fetch, detach at origin/main, read the result, then ask where the shared `main` is -- nothing else");
  });
});

test("neither hook fires in an UNMARKED clone — the lab's exact shape, and #198", () => {
  // `withGitSandbox`'s repository is a plain `git init`: a real `.git` DIRECTORY, which is what the old
  // predicate keyed on and what every ordinary clone has. Without the mark it must be left entirely alone.
  //
  // This is the case that broke the lab. `core.hooksPath` is committed, so `post-checkout` arrived there
  // with a `git pull`, and `run-job.yml` detaches at the ref you asked for — which is how every job runs
  // at a branch. Every `lab:job -e ref=<branch>` failed; `-e ref=main` still worked, so it presented as
  // "branches are broken" rather than as a hook.
  withGitSandbox((sandbox) => {
    sandbox.commit("init", ["--allow-empty"]);
    // deliberately NOT marked
    const commit = runPreCommit(sandbox);
    assert.equal(commit.status, 0,
      `an unmarked clone must be free to commit; the lab and every colleague's checkout is one. ${commit.stderr}`);
    sandbox.commit("second", ["--allow-empty"]);
    const head = sandbox.run(["rev-parse", "HEAD"]).trim();
    const before = sandbox.run(["rev-parse", "HEAD~1"]).trim();
    // The REAL parameter names. The first version of this test passed `{previous, next, branchCheckout}`,
    // which `runPostCheckout` ignores — so `isBranchCheckout` was undefined, the hook saw "0", exited 0 on
    // its very first line, and the assertion passed having exercised NOTHING. Lint and the unit run were
    // both green; `tsc` caught it. A test written against a shape you did not verify, in the test for the
    // guard that had just been fixed for the same class of mistake.
    const checkout = runPostCheckout(sandbox, { prevHead: before, newHead: head, isBranchCheckout: "1" });
    assert.equal(checkout.status, 0,
      `an unmarked clone must be free to detach at any ref; that is how every lab job runs. ${checkout.stderr}`);
  });
});
