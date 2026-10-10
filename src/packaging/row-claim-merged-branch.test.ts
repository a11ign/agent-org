// no-token: gh -- the injected `run` answers only `git`, in a throwaway repository; a `gh` call throws, which `branchOwnerText` reports as unreadable
/**
 * #3745: A LOCAL BRANCH THAT HOLDS NOTHING MAIN LACKS IS NOT A COLLISION. #3566 was offered and refused on 93 ticks in 24 hours by the
 * leftover first-slice branch of its own name; `ceo` deleted it by hand. The refusal is meant to protect work, so it now asks whether
 * the branch holds any: the tip an ancestor of `origin/main` AND no worktree holding the branch.
 *
 * THE FIXTURE IS A REAL REPOSITORY, because the question is git's: a bare origin, a clone, and four local branches, one per cell of
 * {merged, unmerged} x {held by a worktree, free}. A stubbed `run` would have answered the code's own guess.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxGitEnv } from "@a11ign/toolchain/lib/git-env";
import { claimWithWorktree, claimLineFor, worktreeTargetReason } from "../row-claim.ts";

const ROW = 9;
const CELLS = {
  mergedFree: `agent/merged-free-${ROW}`,
  mergedHeld: `agent/merged-held-${ROW}`,
  unmergedFree: `agent/unmerged-free-${ROW}`,
  unmergedHeld: `agent/unmerged-held-${ROW}`,
};

interface Probe { clone: string; dir: string; run: (cmd: string, args: string[]) => string; git: (...args: string[]) => string; heldTrees: string[] }

/** A bare origin holding main (two commits), and a clone with the four branches, its own checkout detached so `main` is not a fifth branch. */
function makeProbe(): Probe {
  const dir = mkdtempSync(join(tmpdir(), "merged-branch-"));
  const origin = join(dir, "origin.git");
  const clone = join(dir, "clone");
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: sandboxGitEnv() });
  sh(dir, "init", "--bare", "--initial-branch=main", origin);
  sh(dir, "clone", "--quiet", origin, clone);
  for (const [key, value] of [["user.name", "probe"], ["user.email", "probe@example.invalid"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    sh(clone, "config", key, value);
  }
  const commit = (message: string) => {
    writeFileSync(join(clone, "f.txt"), `${message}\n`);
    sh(clone, "add", "f.txt");
    sh(clone, "commit", "--quiet", "-m", message);
  };
  commit("first");
  sh(clone, "branch", CELLS.mergedFree);
  sh(clone, "branch", CELLS.mergedHeld);
  commit("second");
  sh(clone, "push", "--quiet", "origin", "main");
  for (const unmerged of [CELLS.unmergedFree, CELLS.unmergedHeld]) {
    sh(clone, "switch", "--quiet", "-c", unmerged);
    commit(`work on ${unmerged}`);
    sh(clone, "switch", "--quiet", "main");
  }
  const heldTrees = [CELLS.mergedHeld, CELLS.unmergedHeld].map((branch) => {
    const tree = join(dir, `tree-${branch.split("/")[1]}`);
    sh(clone, "worktree", "add", "--quiet", tree, branch);
    return tree;
  });
  sh(clone, "switch", "--quiet", "--detach");
  sh(clone, "branch", "-D", "main");
  const run = (cmd: string, args: string[]) => {
    if (cmd !== "git") throw new Error(`simulated: no ${cmd} in the probe`);
    return execFileSync("git", args, { cwd: clone, encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] });
  };
  return { clone, dir, run, git: (...args) => sh(clone, ...args), heldTrees };
}

const target = (branch: string) => ({ branch, worktree: "../wt-9", issueNumber: ROW });
const reasonFor = (probe: Probe, branch: string) => worktreeTargetReason(target(branch), { run: probe.run as never, exists: () => false });

test("#3745 CONTROL: the probe holds exactly four local branches, one per cell, and the cells are what they claim to be", () => {
  const probe = makeProbe();
  try {
    const branches = probe.git("for-each-ref", "--format=%(refname:short)", "refs/heads").trim().split("\n");
    assert.deepEqual(branches.sort(), Object.values(CELLS).sort(), "the population is DERIVED from git, and it is four");
    assert.equal(branches.length, 4);
    const merged = probe.git("for-each-ref", "--merged", "origin/main", "--format=%(refname:short)", "refs/heads").trim().split("\n").sort();
    assert.deepEqual(merged, [CELLS.mergedFree, CELLS.mergedHeld].sort(), "git itself calls exactly two of them merged");
    const held = probe.git("worktree", "list", "--porcelain");
    for (const branch of [CELLS.mergedHeld, CELLS.unmergedHeld]) assert.match(held, new RegExp(`branch refs/heads/${branch}\\n`));
    for (const branch of [CELLS.mergedFree, CELLS.unmergedFree]) assert.doesNotMatch(held, new RegExp(`branch refs/heads/${branch}\\n`));
  } finally {
    rmSync(probe.dir, { recursive: true, force: true });
  }
});

test("#3745 ACCEPTANCE: exactly the merged-and-free branch lets the claim go ahead; the other three are refused, saying why", () => {
  const probe = makeProbe();
  try {
    assert.equal(reasonFor(probe, CELLS.mergedFree), null, "merged into origin/main and held by no worktree: nothing to lose");
    const unmergedFree = String(reasonFor(probe, CELLS.unmergedFree));
    assert.match(unmergedFree, /ALREADY EXISTS locally .*NOT merged into origin\/main, 1 commit\(s\) ahead\. Refusing before any write\./);
    assert.doesNotMatch(unmergedFree, /held by the worktree/);
    const mergedHeld = String(reasonFor(probe, CELLS.mergedHeld));
    assert.match(mergedHeld, /merged into origin\/main, and held by the worktree .*tree-merged-held-9\. Refusing before any write\./);
    assert.doesNotMatch(mergedHeld, /NOT merged/);
    const unmergedHeld = String(reasonFor(probe, CELLS.unmergedHeld));
    assert.match(unmergedHeld, /NOT merged into origin\/main, 1 commit\(s\) ahead, and held by the worktree .*tree-unmerged-held-9\./);
    assert.equal(reasonFor(probe, `agent/no-such-branch-${ROW}`), null, "CONTROL: a name nobody holds is not refused by this rule either");
  } finally {
    rmSync(probe.dir, { recursive: true, force: true });
  }
});

test("#3745 a merge state git cannot read is a refusal, never a free branch", () => {
  const probe = makeProbe();
  try {
    const noMain = (cmd: string, args: string[]) => {
      if (args[0] === "merge-base" || args[0] === "rev-list") throw Object.assign(new Error("fatal: Not a valid object name origin/main"), { status: 128 });
      return probe.run(cmd, args);
    };
    const reason = String(worktreeTargetReason(target(CELLS.mergedFree), { run: noMain as never, exists: () => false }));
    assert.match(reason, /NOT known to be merged into origin\/main \(git could not say: fatal: Not a valid object name origin\/main\)/);
    const noList = (cmd: string, args: string[]) => {
      if (args[0] === "worktree") throw new Error("fatal: worktree list refused");
      return probe.run(cmd, args);
    };
    assert.match(String(worktreeTargetReason(target(CELLS.mergedFree), { run: noList as never, exists: () => false })),
      /held by the worktree \(git could not list the worktrees: fatal: worktree list refused\)/);
  } finally {
    rmSync(probe.dir, { recursive: true, force: true });
  }
});

test("#3745 THE CLAIM recreates the merged-and-free name at origin/main, keeps the old tip reachable, and says what it replaced", () => {
  const probe = makeProbe();
  try {
    const oldTip = probe.git("rev-parse", CELLS.mergedFree).trim();
    const main = probe.git("rev-parse", "origin/main").trim();
    assert.notEqual(oldTip, main, "CONTROL: the leftover is behind main, so recreating it is visible");
    const worktree = join(probe.dir, "wt-9");
    const claimed = claimWithWorktree(ROW, "worker-9", {
      branch: CELLS.mergedFree, worktree, run: probe.run as never, stamp: () => undefined,
      claim: (() => ({ claimed: true, statusMoved: true })) as never,
    });
    assert.equal(claimed.claimed, true);
    assert.equal((claimed as { replacedTip?: string }).replacedTip, oldTip, "the old tip's sha is in the claim's output");
    assert.equal(probe.git("rev-parse", CELLS.mergedFree).trim(), main, "the name now sits at the new start point");
    probe.git("merge-base", "--is-ancestor", oldTip, "origin/main"); // throws if the old tip was lost
    assert.match(claimLineFor("claim", ROW, "worker-9", { branch: CELLS.mergedFree, worktree, replacedTip: oldTip }), new RegExp(`old tip ${oldTip}`));
    assert.doesNotMatch(claimLineFor("claim", ROW, "worker-9", { branch: CELLS.mergedFree, worktree }), /old tip/);
  } finally {
    rmSync(probe.dir, { recursive: true, force: true });
  }
});

test("#3745 THE CLAIM over each of the other three refuses before any write and moves no branch", () => {
  const probe = makeProbe();
  try {
    const before = probe.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");
    for (const branch of [CELLS.mergedHeld, CELLS.unmergedFree, CELLS.unmergedHeld]) {
      const worktree = join(probe.dir, `wt-${branch.split("/")[1]}`);
      const got = claimWithWorktree(ROW, "worker-9", {
        branch, worktree, run: probe.run as never, stamp: () => assert.fail("a refused claim stamps nothing"),
        claim: (() => assert.fail("a refused claim claims nothing")) as never,
      });
      assert.equal(got.claimed, false, branch);
      assert.match((got as { reason: string }).reason, /ALREADY EXISTS locally/);
    }
    assert.equal(probe.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"), before);
  } finally {
    rmSync(probe.dir, { recursive: true, force: true });
  }
});
