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
// no-token: gh
//
// #1477: carry-branch.mjs spawns `gh` in `noteCarryOnPr`, so the acceptance classifier charges this whole file
// for a token -- measured, it refused this row's own acceptance command on origin/main as filed. No test here
// reaches that spawn: every `noteCarryOnPr` and `carryMain` test injects its own `run`, and the real-git carry
// tests call `carryBranch` with the default `run`, which only ever spawns `git`. Re-proved behind a `gh` shim
// that logs and exits 1, with GH_TOKEN and GITHUB_TOKEN unset: 19 pass, and the shim is invoked ZERO times.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxGitEnv } from "../../../guards/src/git-env.mjs";
import { carryBranch, branchCheckedOutLocally, noteCarryOnPr, carryMain, EXIT } from "../../../../scripts/carry-branch.mjs";
import { stripComments } from "@a11ign/evidence/source-text";
import { declareTreeWideGuard } from "../../../guards/src/tree-wide-guard.mjs";

// #716/#704: this file's own population is the whole tracked tree, not one file -- declared here
// rather than inferred from its source, per ceo's ruling (2026-09-09) that the tree-wide-guard
// population must be derived from a real import, never from scanning source text.
declareTreeWideGuard();

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

type Topology = {
  root: string; origin: string; primary: string; owner: string; branch: string;
  mainSha: string; branchSha: string;
};

/**
 * #716: Three real repositories, wired together exactly like the real incident -- a bare `origin`, a
 * `primary` checkout of it, and an `owner` LINKED WORKTREE off `primary` holding `agent/<branch>` checked
 * out, the actual shape that made `git worktree add` refuse for the dispatcher on #614 -- built ONCE for
 * the whole file (`before`, below) rather than once per test. `resetTopology` (below) is what makes reuse
 * safe: every test starts from the identical pristine state regardless of what an earlier test did to
 * origin's refs or the working trees, proven by the ACCEPTANCE test near the end of this file that reads
 * origin's refs back after several mutating tests have already run.
 */
function buildTopology(): Topology {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "carry-branch-topo-")));
  const origin = join(root, "origin.git");
  const primary = join(root, "primary");
  const owner = join(root, "owner");
  const branch = "agent/held-branch-test";
  execFileSync("git", ["init", "--quiet", "--bare", origin], { env: sandboxGitEnv() });
  execFileSync("git", ["clone", "--quiet", origin, primary], { env: sandboxGitEnv() });
  // `init.defaultBranch` differs by host (`main` locally, `master` on a GitHub Actions runner) -- this
  // repo's own `pre-push-stale-base.test.ts` records the identical trap. Cloning a truly EMPTY bare
  // repo leaves an UNBORN HEAD named by whatever the clone's own default is, so the branch this test
  // means by "main" is forced explicitly rather than assumed, before the first commit exists to rename.
  git(primary, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  commit(primary, "README.md", "primary\n", "initial commit on main");
  git(primary, ["push", "-q", "-u", "origin", "main"]);
  const mainSha = git(primary, ["rev-parse", "main"]).trim();
  git(primary, ["checkout", "-q", "-b", branch]);
  commit(primary, "owner-work.txt", "the owner's own work\n", "start the branch");
  git(primary, ["push", "-q", "-u", "origin", branch]);
  const branchSha = git(primary, ["rev-parse", branch]).trim();
  git(primary, ["checkout", "-q", "main"]);
  // THE HELD STATE: a LINKED WORKTREE off primary, holding the branch checked out -- reproduces the
  // exact fatal error #656's own header quotes when a second `worktree add` names the same branch.
  git(primary, ["worktree", "add", "-q", owner, branch]);
  return { root, origin, primary, owner, branch, mainSha, branchSha };
}

/**
 * #716: Puts `topo` back to exactly the state `buildTopology` left it in -- cheap ref/tree resets, never
 * a rebuild. `origin` is bare, so its refs are moved directly; `primary` and `owner` are hard-reset and
 * cleaned of anything a test wrote. Runs before EVERY test (`beforeEach`, below), so test order can never
 * matter and a mutation from one test can never reach the next.
 */
function resetTopology(topo: Topology): void {
  const { origin, primary, owner, branch, mainSha, branchSha } = topo;
  execFileSync("git", ["update-ref", "refs/heads/main", mainSha], { cwd: origin, env: sandboxGitEnv() });
  execFileSync("git", ["update-ref", `refs/heads/${branch}`, branchSha], { cwd: origin, env: sandboxGitEnv() });
  git(primary, ["checkout", "-q", "main"]);
  git(primary, ["reset", "-q", "--hard", mainSha]);
  git(primary, ["clean", "-q", "-fd"]);
  git(primary, ["worktree", "prune"]);
  git(owner, ["reset", "-q", "--hard", branchSha]);
  git(owner, ["clean", "-q", "-fd"]);
}

let topo: Topology;
before(() => { topo = buildTopology(); });
beforeEach(() => { resetTopology(topo); });
after(() => { rmSync(topo.root, { recursive: true, force: true }); });

test("branchCheckedOutLocally: true for a branch genuinely held in a linked worktree", () => {
  assert.equal(branchCheckedOutLocally(topo.branch, topo.primary), true);
});

test("branchCheckedOutLocally: false for a branch nothing has checked out", () => {
  assert.equal(branchCheckedOutLocally("agent/nothing-holds-this", topo.primary), false);
});

test("REPRODUCES THE #614 COLLISION: an ordinary (non-detached) worktree add for the SAME branch name "
  + "is refused, by git itself, exactly as the issue's own header quotes", () => {
  const collidingDir = mkdtempSync(join(tmpdir(), "carry-branch-collide-"));
  try {
    assert.throws(() => git(topo.primary, ["worktree", "add", collidingDir, topo.branch]),
      /already used by worktree/,
      "this is the premise #656 exists to work around -- if git ever stops refusing this, the whole "
      + "row's reason for existing needs re-examining");
  } finally {
    rmSync(collidingDir, { recursive: true, force: true });
  }
});

test("#656 ACCEPTANCE: carryBranch succeeds against a REAL held branch -- no collision, because the "
  + "carry never checks the branch out by NAME", () => {
  const { origin, primary, branch } = topo;
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

test("#656: THE ORDINARY CASE IS UNTOUCHED -- the owner's own linked worktree is unaffected by a carry, "
  + "still checked out on the branch, nothing about it disturbed", () => {
  const { primary, owner, branch } = topo;
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

test("#656 MUTATION: the ref-lock is READ, never forced past -- a push that lands from elsewhere while "
  + "the carry is in flight is a REFUSAL, not overridden", () => {
  const { origin, primary, branch } = topo;
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

test("carryBranch cleans up its own throwaway detached worktree after a successful carry", () => {
  const { primary, branch } = topo;
  const before = git(primary, ["worktree", "list", "--porcelain"]);
  const result = carryBranch(primary, branch);
  assert.equal(result.carried, true);
  const after = git(primary, ["worktree", "list", "--porcelain"]);
  // Exactly the pre-carry set plus the pre-existing `owner` worktree -- no new entry lingers.
  assert.equal(after.split("worktree ").length, before.split("worktree ").length,
    `a carry must not leave its own temp worktree registered. before:\n${before}\nafter:\n${after}`);
});

test("#716 ACCEPTANCE: the shared fixture is genuinely reset between tests -- state from an earlier "
  + "mutating test (main advanced, a branch pushed, a carry's own push) does not leak into this one", () => {
  // By this point several earlier tests have pushed new commits to origin's main and branch, and one has
  // carried the branch via carryBranch. If `resetTopology`'s `beforeEach` call were a no-op, at least one
  // of those mutations would still be visible here -- so reading origin's refs back and finding exactly
  // the pristine shas is the proof reuse did not let anything leak.
  const remoteMain = execFileSync("git", ["ls-remote", topo.origin, "refs/heads/main"],
    { encoding: "utf8", env: sandboxGitEnv() }).split(/\s+/)[0];
  assert.equal(remoteMain, topo.mainSha, "origin/main must be back at its pristine tip, not an earlier "
    + "test's \"main advanced\" commit");
  const remoteBranch = execFileSync("git", ["ls-remote", topo.origin, `refs/heads/${topo.branch}`],
    { encoding: "utf8", env: sandboxGitEnv() }).split(/\s+/)[0];
  assert.equal(remoteBranch, topo.branchSha, "origin/<branch> must be back at its pristine tip, not an "
    + "earlier carry's push");
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

test("#1128: the carry STAMPS the worktree it creates, because a failed cleanup leaves an unowned tree",
  () => {
    // worker-judge's finding on #1244: the stamp writer had no caller, so every tree answered UNSTAMPED
    // and the feature was indistinguishable from its absence. This is the machine caller. The cleanup in
    // `carryBranch`'s `finally` is best-effort BY DESIGN, so a carry tree can outlive its carry --
    // `/private/tmp/carry-742` is one on this machine today -- and that is exactly the tree somebody
    // finds later with no way to tell whose it is.
    const { primary, branch } = topo;
    const workDir = mkdtempSync(join(tmpdir(), "carry-branch-stamped-"));
    const seen: { dir: string, session: string }[] = [];
    try {
      const result = carryBranch(primary, branch,
        { workDir, stamp: (dir: string, session: string) => { seen.push({ dir, session }); } });
      assert.equal(result.carried, true, `expected the carry to succeed; got: ${JSON.stringify(result)}`);
      assert.deepEqual(seen.map((s) => s.dir), [workDir],
        "the carry must stamp the tree it created, exactly once -- and the injected stamper is what "
        + "makes this an assertion about the CALL rather than about a file this test wrote itself");
      assert.ok(seen[0].session.length > 0,
        "a stamp with an empty session would read as UNSTAMPED, which is the one answer the writer must "
        + "never produce");
    } finally {
      try { git(primary, ["worktree", "remove", "--force", workDir]); } catch { /* best effort */ }
      rmSync(workDir, { recursive: true, force: true });
    }
  });

// --- #1477: a failure AFTER the push landed exits 3, CARRIED NOT NOTED -- never 1, which this script's header
// defines as NOT CARRIED. Measured at 0830dd0e through the real CLI with a stub gh: `gh pr comment` failed after
// `git push` landed, escaped as an uncaught throw, and Node exited 1 under stdout's "CARRIED -- ... pushed." ---

const CARRIED_BRANCH = "agent/x-1477";
const FOUND_PR = JSON.stringify([{ number: 42 }]);

/** An injected `run` for the whole carry, where `failAt` picks the one call that throws. No filesystem, no remote. */
function carryRun(failAt: (cmd: string, args: string[]) => boolean) {
  const calls: string[] = [];
  const run = (cmd: string, args: string[]) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (failAt(cmd, args)) throw new Error(`simulated: ${cmd} ${args.slice(0, 2).join(" ")} failed`);
    if (cmd === "git" && args[0] === "rev-parse") return "1111111111111111111111111111111111111111\n";
    if (cmd === "git" && args[0] === "diff") return " scripts/x.mjs | 1 +\n";
    if (cmd === "gh" && args[1] === "list") return FOUND_PR;
    return "";
  };
  return { run, calls };
}

/** Drives `carryMain` -- the CLI's entry path -- with that `run`, capturing both streams. */
function driveCarry(run: (cmd: string, args: string[]) => string) {
  let out = "";
  let err = "";
  const code = carryMain([CARRIED_BRANCH, "--carrier=worker-judge", "--reason=past the escalation window"], {
    run, stamp: () => {}, workDir: "/nonexistent/carry-1477", cwd: "/nonexistent/repo-1477",
    out: (text: string) => { out += text; }, err: (text: string) => { err += text; } });
  return { code, out, err };
}

const isPush = (cmd: string, args: string[]) => cmd === "git" && args[0] === "push";
const isComment = (cmd: string, args: string[]) => cmd === "gh" && args[0] === "pr" && args[1] === "comment";

test("#1477 ACCEPTANCE: the push LANDED, then the PR note throws -- exit 3 naming the pushed branch and the PR, never 1", () => {
  const { run, calls } = carryRun(isComment);
  const { code, out, err } = driveCarry(run);
  assert.equal(code, EXIT.CARRIED_NOT_NOTED, `a failure after the push must be CARRIED NOT NOTED; got exit ${code}, stderr: ${err}`);
  assert.ok(out.includes(`CARRIED -- ${CARRIED_BRANCH} merged with origin/main and pushed.`));
  assert.match(err, /^CARRIED, NOT NOTED \(exit 3\) -- agent\/x-1477 WAS pushed; /);
  assert.match(err, /found PR #42 for agent\/x-1477, but could not post the note on it -- simulated/);
  assert.doesNotMatch(err, /NOT CARRIED:/);
  const pushAt = calls.findIndex((c) => c.startsWith("git push"));
  const commentAt = calls.findIndex((c) => c.startsWith("gh pr comment"));
  assert.ok(pushAt >= 0 && commentAt > pushAt, `the push must precede the failing note: ${JSON.stringify(calls)}`);
});

test("#1477 CONTROL: a failure BEFORE the push -- the fetch -- stays NOT CARRIED, exit 1, and nothing is pushed or noted", () => {
  const { run, calls } = carryRun((cmd, args) => cmd === "git" && args[0] === "fetch");
  const { code, out, err } = driveCarry(run);
  assert.equal(code, EXIT.NOT_CARRIED);
  assert.match(err, /^NOT CARRIED: could not fetch origin\/main -- simulated/);
  assert.equal(out, "");
  assert.ok(!calls.some((c) => c.startsWith("git push") || c.startsWith("gh ")), JSON.stringify(calls));
});

test("#1477 CONTROL: the push ITSELF refused stays NOT CARRIED, exit 1, and no note is attempted", () => {
  const { run, calls } = carryRun(isPush);
  const { code, err } = driveCarry(run);
  assert.equal(code, EXIT.NOT_CARRIED);
  assert.match(err, /^NOT CARRIED: push refused/);
  assert.ok(!calls.some((c) => c.startsWith("gh ")), JSON.stringify(calls));
});

test("#1477 CONTROL: every call succeeds -- exit 0, CARRIED and noted on the PR, nothing on stderr", () => {
  const { run } = carryRun(() => false);
  const { code, out, err } = driveCarry(run);
  assert.equal(code, EXIT.CARRIED);
  assert.ok(out.includes("Noted on PR #42."));
  assert.equal(err, "");
});

test("#1477: noteCarryOnPr reports (never throws) when the COMMENT itself fails, naming the PR it found", () => {
  const run = (cmd: string, args: string[]) => {
    if (args[1] === "comment") throw new Error("gh: GraphQL rate limit");
    return FOUND_PR;
  };
  const result = noteCarryOnPr(CARRIED_BRANCH, "worker-judge", "why", { run });
  assert.equal(result.commented, false);
  assert.match((result as { reason: string }).reason, /found PR #42 .*could not post the note on it -- gh: GraphQL rate limit/);
});

test("#1477 WIRING: `main` applies carryMain's exit code and makes no carry decision of its own", () => {
  const source = stripComments(readFileSync(new URL("../../../../scripts/carry-branch.mjs", import.meta.url), "utf8"));
  const start = source.indexOf("function main(");
  assert.ok(start >= 0, "main not found");
  const end = source.indexOf("\n}\n", start);
  const body = source.slice(start, end);
  assert.match(body, /process\.exitCode = carryMain\(process\.argv\.slice\(2\)\)/);
  assert.doesNotMatch(body, /noteCarryOnPr|carryBranch\(/, "main must not carry or note outside carryMain");
});

test("#1477: the exit codes are the ones this script's header documents -- 3 is CARRIED, NOT NOTED", () => {
  assert.deepEqual({ ...EXIT }, { CARRIED: 0, NOT_CARRIED: 1, USAGE: 2, CARRIED_NOT_NOTED: 3 });
  const header = readFileSync(new URL("../../../../scripts/carry-branch.mjs", import.meta.url), "utf8").split("import ")[0];
  assert.match(header, /^\/\/ +3 +CARRIED, NOT NOTED -- the branch WAS pushed/m, "the header must document exit 3");
});
