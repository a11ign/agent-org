/**
 * #744: `trunk-guard.yml`'s #616 parent re-check used to print `tail -40 /tmp/parent-test.log` when the
 * parent failed the suite now. A `node:test` TAP log's last forty lines are the trailing PASSING
 * subtests, never the failure -- measured live on #718 (2026-09-09): a genuine failure produced a step
 * output of `ok 4180`, `ok 4181`, `ok 4182`, not one of them a failure, and `decideRevert` correctly
 * declined to act on a verdict naming no cause. A real revert was refused and main stayed red for ninety
 * minutes on a fix anyone could have reverted in one command, had the evidence named it.
 *
 * `summarizeTestLog` fixes the confirmed defect: it reads the TAP summary (`# fail N`) and the individual
 * `not ok <n>` lines, wherever they sit in the log, and reports `unknown` -- never `fail` -- when it
 * cannot actually name a failing subtest. `trunk-revert.mjs`'s own `revertVerdict` already treats a
 * `parentRecheck` that is not literally `"pass"` or `"fail"` as `null` (CANNOT_ASK), so `unknown` was
 * already the safe answer this function needed to be ABLE to give; it just could not, because `tail -40`
 * never told it "I don't know", it told it "fail" with the wrong evidence attached.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeTestLog } from "../../../../scripts/parent-recheck-summary.mjs";
import { sandboxGitEnv } from "../../../../scripts/git-env.mjs";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * A REALISTIC node:test TAP log shape: a failure near the TOP (this is the whole point -- #718's own
 * incident had the failure buried among thousands of later-passing subtests), then thousands of passing
 * lines, then the real TAP summary at the end.
 */
function tapLogWithEarlyFailure(): string {
  const lines = ["TAP version 13", "# Subtest: some suite"];
  lines.push("not ok 7 - the summary states WHEN it was written, and that time is within 60 minutes of the render");
  lines.push("  ---");
  lines.push("  error: |-");
  lines.push("    expected 'stale' to equal 'fresh'");
  lines.push("  ...");
  for (let i = 8; i <= 4182; i++) lines.push(`ok ${i} - some passing subtest ${i}`);
  lines.push("# tests 4182");
  lines.push("# pass 4181");
  lines.push("# fail 1");
  return lines.join("\n");
}

test("#744 ACCEPTANCE: a failure near the TOP of a long log is still found and named -- the exact #718 shape", () => {
  const report = summarizeTestLog(tapLogWithEarlyFailure());
  assert.equal(report.verdict, "fail");
  assert.equal(report.failCount, 1);
  assert.equal(report.notOkLines.length, 1);
  assert.match(report.notOkLines[0], /not ok 7 - the summary states WHEN it was written/);
});

test("#744 MUTATION: reproducing the OLD tail -40 behaviour against the SAME log names no failure -- proves "
  + "the confirmed defect was real, not assumed", () => {
  // The exact command the workflow used to run: `tail -40 /tmp/parent-test.log`.
  const log = tapLogWithEarlyFailure();
  const last40 = log.split("\n").slice(-40);
  assert.ok(!last40.some((line) => /^not ok \d+/.test(line)),
    "the last 40 lines of this fixture must contain zero failing subtests, reproducing #718's real evidence gap");
  assert.ok(last40.every((line) => /^ok \d+|^#/.test(line)),
    "the last 40 lines must be entirely passing subtests and the TAP summary, the exact shape that read as "
    + "\"fail\" with no named cause");
});

test("a log with NO not-ok line and NO fail-count summary is unknown, never fail -- there is nothing to attribute", () => {
  const report = summarizeTestLog("some unrelated crash output\nnode:internal/process/promises\n");
  assert.equal(report.verdict, "unknown");
  assert.match(report.reason ?? "", /cannot be named|cannot determine/);
});

test("#744 ACCEPTANCE: a '# fail N' summary with N > 0 but no matching not-ok line is unknown -- the summary "
  + "and the detail disagree, so neither is trusted alone", () => {
  const report = summarizeTestLog("TAP version 13\nok 1 - something\n# tests 1\n# pass 0\n# fail 3\n");
  assert.equal(report.verdict, "unknown");
  assert.match(report.reason ?? "", /names no "not ok" line/);
});

test("'# fail 0' with no not-ok lines reads as unknown (there is nothing to name), never as a false fail", () => {
  const report = summarizeTestLog("TAP version 13\nok 1 - x\n# tests 1\n# pass 1\n# fail 0\n");
  assert.equal(report.verdict, "unknown");
});

test("CONTROL: a clean, real-shaped log with several genuine failures names every one, in order", () => {
  const log = "TAP version 13\nnot ok 3 - first failure\nok 4 - fine\nnot ok 5 - second failure\n"
    + "ok 6 - fine\n# tests 6\n# pass 4\n# fail 2\n";
  const report = summarizeTestLog(log);
  assert.equal(report.verdict, "fail");
  assert.equal(report.failCount, 2);
  assert.deepEqual(report.notOkLines, ["not ok 3 - first failure", "not ok 5 - second failure"]);
});

// --- CLI: the real script, invoked exactly as the workflow invokes it ---

function withTempLog(content: string, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "parent-recheck-summary-"));
  const logPath = join(dir, "parent-test.log");
  writeFileSync(logPath, content);
  try {
    fn(logPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("CLI: a real failing log prints the not-ok lines, the fail count, and RECHECK_RESULT=fail", () => {
  withTempLog(tapLogWithEarlyFailure(), (logPath) => {
    const out = execFileSync("node", [realpathSync(`${REPO}scripts/parent-recheck-summary.mjs`), logPath],
      { encoding: "utf8" });
    assert.match(out, /^# fail 1$/m);
    assert.match(out, /not ok 7 - the summary states WHEN it was written/);
    assert.match(out, /^RECHECK_RESULT=fail$/m);
  });
});

test("CLI: an undeterminable log prints UNKNOWN and RECHECK_RESULT=unknown, never RECHECK_RESULT=fail", () => {
  withTempLog("a crash with no TAP shape at all\n", (logPath) => {
    const out = execFileSync("node", [realpathSync(`${REPO}scripts/parent-recheck-summary.mjs`), logPath],
      { encoding: "utf8" });
    assert.match(out, /^UNKNOWN:/m);
    assert.match(out, /^RECHECK_RESULT=unknown$/m);
    assert.doesNotMatch(out, /RECHECK_RESULT=fail/);
  });
});

// --- THE UNCONFIRMED HYPOTHESIS, CHECKED FIRST, WITH A REAL REPRODUCTION ---
//
// #744's own acceptance: "the moving-origin/main hypothesis ... is checked first with a test that
// reproduces it." The #616 re-check pins the WORKING TREE at the parent commit (`git worktree add /tmp/
// parent "$BEFORE" --detach`) but shares the same underlying repository -- objects and refs, including
// `refs/remotes/origin/main` -- with the checkout that created it. Pinning a tree does not pin a ref.

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: sandboxGitEnv() });
}

/**
 * The identical three-commit shape both #744's hypothesis test and #775's fix-proof test need: BEFORE
 * (the commit a re-check will pin at, standing in for the commit immediately preceding a red push whose
 * own trunk-guard run was genuinely green), the push under investigation, and main moving on again
 * (anything landing between the original trunk-guard run and the re-check running now). Returns the real
 * repo paths and shas so each test can drive its own re-check mechanism against them.
 */
function buildOriginMoveFixture(root: string) {
  const origin = join(root, "origin.git");
  const primary = join(root, "primary");
  execFileSync("git", ["init", "--quiet", "--bare", origin], { env: sandboxGitEnv() });
  execFileSync("git", ["clone", "--quiet", origin, primary], { env: sandboxGitEnv() });
  git(primary, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  const commit = (path: string, content: string, message: string) => {
    writeFileSync(join(primary, path), content);
    git(primary, ["add", path]);
    git(primary, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", message]);
  };

  commit("a.txt", "1\n", "BEFORE");
  git(primary, ["push", "-q", "-u", "origin", "main"]);
  const before = git(primary, ["rev-parse", "HEAD"]).trim();

  commit("a.txt", "2\n", "the push under investigation");
  git(primary, ["push", "-q", "origin", "main"]);

  commit("a.txt", "3\n", "main moved on, unrelated to the push under investigation");
  git(primary, ["push", "-q", "origin", "main"]);
  const currentOriginMain = git(primary, ["rev-parse", "origin/main"]).trim();

  return { origin, primary, before, currentOriginMain };
}

test("#744 HYPOTHESIS, REPRODUCED: a worktree pinned at an OLD commit still sees origin/main AS IT IS NOW, "
  + "not as it was when that commit was tested -- so a test reading origin/main directly can fail on a "
  + "tree the push under test never touched", () => {
  const root = mkdtempSync(join(tmpdir(), "parent-recheck-origin-move-"));
  try {
    const { primary, before, currentOriginMain } = buildOriginMoveFixture(root);
    const parentWorktree = join(root, "parent");

    // THE OLD RE-CHECK: pin a linked worktree at BEFORE, exactly as trunk-guard.yml's step did before #775.
    git(primary, ["worktree", "add", "--detach", parentWorktree, before]);
    const parentHead = git(parentWorktree, ["rev-parse", "HEAD"]).trim();
    assert.equal(parentHead, before, "the worktree's own tree is genuinely pinned at BEFORE");

    // THE HYPOTHESIS: origin/main, read from inside that pinned worktree, is NOT `before` -- it is
    // whatever origin/main is right now, because refs live in the shared repository, not the worktree's
    // own checked-out tree.
    const originMainFromParentWorktree = git(parentWorktree, ["rev-parse", "origin/main"]).trim();
    assert.equal(originMainFromParentWorktree, currentOriginMain,
      "origin/main read from inside the pinned parent worktree must be the CURRENT tip, confirming the "
      + "worktree pins the tree and pins nothing else");
    assert.notEqual(originMainFromParentWorktree, before,
      "and that current tip must differ from the commit the worktree is itself pinned at -- otherwise this "
      + "fixture proves nothing");

    // CONCRETELY: any test in the parent's own suite that asserts `git rev-parse origin/main` equals
    // `HEAD` (a real, common shape -- see this repo's own resolve-toward-main and tree-wide-guard checks)
    // would PASS when BEFORE was originally tested (origin/main was BEFORE, then) and FAIL now, at the
    // re-check, on a tree the push under investigation never touched.
    assert.notEqual(git(parentWorktree, ["rev-parse", "HEAD"]).trim(),
      git(parentWorktree, ["rev-parse", "origin/main"]).trim(),
      "HEAD and origin/main, read from the SAME pinned worktree, must disagree -- this is the exact "
      + "mismatch a origin/main-relative test would trip on, unrelated to anything the push under "
      + "investigation changed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- #775: THE FIX -- a fresh clone with origin/main explicitly pinned, never a linked worktree ---

/** trunk-guard.yml's own #775 fix, driven exactly as the real step now does (`git clone --quiet . /tmp/
 *  parent`, run from the checkout -- `primary` here stands in for that checkout). */
function reCheckViaClone(primary: string, before: string, parentClone: string) {
  git(primary, ["clone", "--quiet", primary, parentClone]);
  git(parentClone, ["update-ref", "refs/remotes/origin/main", before]);
  git(parentClone, ["checkout", "--quiet", "--detach", before]);
}

test("#775 ACCEPTANCE: after the fix, origin/main read from inside the parent's own clone is BEFORE, "
  + "never the current tip -- the re-check finally answers the question it was built to answer", () => {
  const root = mkdtempSync(join(tmpdir(), "parent-recheck-fix-"));
  try {
    const { primary, before } = buildOriginMoveFixture(root);
    const parentClone = join(root, "parent-clone");
    reCheckViaClone(primary, before, parentClone);

    assert.equal(git(parentClone, ["rev-parse", "HEAD"]).trim(), before,
      "the clone's own tree must still be pinned at BEFORE");
    assert.equal(git(parentClone, ["rev-parse", "origin/main"]).trim(), before,
      "origin/main, read from inside the FIXED re-check's own clone, must be BEFORE -- not the current tip "
      + "of the shared repository, which is what made #718's re-check answer a question about the wrong "
      + "moment in time");

    // The same origin/main-relative assertion the #744 test above showed WOULD fail under the old
    // mechanism now agrees, because both sides are honestly the same commit.
    assert.equal(git(parentClone, ["rev-parse", "HEAD"]).trim(),
      git(parentClone, ["rev-parse", "origin/main"]).trim(),
      "HEAD and origin/main, read from the fixed re-check's own clone, must agree -- the exact property "
      + "the old linked-worktree mechanism could never have");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#775 MUTATION: restoring the old `git worktree add --detach` form against the identical fixture "
  + "reproduces the mismatch again -- proves the fix is what closes the gap, not the fixture", () => {
  const root = mkdtempSync(join(tmpdir(), "parent-recheck-fix-mutation-"));
  try {
    const { primary, before, currentOriginMain } = buildOriginMoveFixture(root);
    const parentWorktree = join(root, "parent-old-form");

    // The OLD form, restored, against the SAME fixture the fix-proof test above used.
    git(primary, ["worktree", "add", "--detach", parentWorktree, before]);

    assert.notEqual(git(parentWorktree, ["rev-parse", "origin/main"]).trim(), before,
      "the old linked-worktree form must still fail to pin origin/main at BEFORE -- if this now passes, "
      + "the fixture stopped exercising the defect, not the fix stopped mattering");
    assert.equal(git(parentWorktree, ["rev-parse", "origin/main"]).trim(), currentOriginMain,
      "and it must read the CURRENT tip instead, the exact mismatch #775 exists to close");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
