/**
 * `scripts/prune-worktrees.mjs` removes a stale worktree only when it is BOTH merged into `origin/main`
 * and has a clean working tree, names everything else as DIRTY without touching it, and never touches the
 * PRIMARY checkout. See that file's own header for the incident (36 worktrees, 4.4 GB, a rule maintained
 * by hand).
 *
 * DRIVEN AGAINST REAL GIT FIXTURES, never against the live worktree tree, per the acceptance criteria's
 * own explicit requirement -- a prune that removes a dirty worktree is unrecoverable, so this proves the
 * logic against disposable repositories built and destroyed entirely under `/tmp`, structurally unable to
 * reach the real checkout this test itself runs from.
 *
 * GIT_* SCRUBBED on every spawn, including this file's own fixture-building `git()` helper: if `GIT_DIR`
 * happened to be set (this hook exports it into a hook environment, which is exactly why
 * `scripts/git-env.mjs` exists), an unscrubbed git call in a fixture helper would redirect onto whatever
 * `GIT_DIR` names instead of the intended disposable `/tmp` repo -- the identical class of defect closed
 * elsewhere today, caught here by `git-spawn-classification.test.ts`'s own discovery before this file
 * ever shipped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseWorktreeList, isPrimaryWorktree, classify, isStandingBranch, mergeStatus, isContentMerged,
  isWorkingTreeClean, pruneWorktrees, recentGitActivity, ACTIVITY_WINDOW_MS,
} from "../../../../scripts/prune-worktrees.mjs";
import { sandboxGitEnv } from "../../../../scripts/git-env.mjs";

// The CLI is spawned as a real process below, so the argv path -- the only place `dryRun` is
// decided -- is exercised rather than reasoned about.
const PRUNE_CLI = new URL("../../../../scripts/prune-worktrees.mjs", import.meta.url).pathname;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: sandboxGitEnv(), encoding: "utf8" });

// Every fixture below is built moments before its assertions run, so its gitdir's `index`/`HEAD` mtimes
// are always "now" -- real, not contrived. Existing REMOVE assertions therefore pass a `now` this far
// past fixture construction, standing in for "nobody has touched this tree since it finished" -- the
// LIVE window is exercised by its own dedicated tests below, against real elapsed wall-clock time.
const LONG_AFTER = () => Date.now() + ACTIVITY_WINDOW_MS + 60_000;

/**
 * A disposable "primary" repo with three linked worktrees, each demonstrating one shape:
 *   - agent/merged-clean      -- fully merged into origin/main, no uncommitted changes: REMOVE
 *   - agent/dirty-uncommitted -- merged, but an uncommitted file sits in the working tree: DIRTY
 *   - agent/dirty-unmerged    -- a real commit `origin/main` does not have, working tree itself clean: DIRTY
 *   - dispatcher/merge        -- a ROLE branch, merged and clean: STANDING (never removed regardless)
 *   - agent/cherry-picked     -- content landed on origin/main via a DIFFERENT commit (cherry-pick), so
 *                                `merge-base --is-ancestor` reads NOT merged forever: CHERRY-PICKED
 * `refs/remotes/origin/main` is set directly (no real remote needed) so "merged" is a fact this fixture
 * controls precisely, not something inferred from a network round-trip.
 */
function buildFixtureRepo() {
  // REALPATH'd: on macOS /var is a symlink to /private/var, and `git worktree list` reports paths
  // resolved -- an unresolved root here makes every path comparison in this file fail on the string,
  // never on the logic (see CLAUDE.md's own recorded instance of this exact class).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a11y-prune-fixture-")));
  git(root, "init", "--quiet", "-b", "main");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "Fixture");
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, "add", "base.txt");
  git(root, "commit", "-q", "-m", "base");
  const baseSha = git(root, "rev-parse", "HEAD").trim();
  git(root, "update-ref", "refs/remotes/origin/main", baseSha);

  const merged = join(root, "wt-merged-clean");
  git(root, "worktree", "add", "--quiet", "-b", "agent/merged-clean", merged, baseSha);
  writeFileSync(join(merged, "change.txt"), "done\n");
  git(merged, "add", "change.txt");
  git(merged, "commit", "-q", "-m", "finished work");
  const mergedSha = git(merged, "rev-parse", "HEAD").trim();
  git(root, "update-ref", "refs/remotes/origin/main", mergedSha); // "landed upstream"
  // root's OWN checked-out `main` must advance too, or a later cherry-pick done IN root (below) applies
  // on top of the stale `baseSha` instead of `mergedSha` and silently forks origin/main away from it.
  git(root, "reset", "--hard", "--quiet", mergedSha);

  const dirtyUncommitted = join(root, "wt-dirty-uncommitted");
  git(root, "worktree", "add", "--quiet", "-b", "agent/dirty-uncommitted", dirtyUncommitted, mergedSha);
  writeFileSync(join(dirtyUncommitted, "wip.txt"), "not committed\n"); // never `git add`ed

  const dirtyUnmerged = join(root, "wt-dirty-unmerged");
  git(root, "worktree", "add", "--quiet", "-b", "agent/dirty-unmerged", dirtyUnmerged, mergedSha);
  writeFileSync(join(dirtyUnmerged, "unpushed.txt"), "real work\n");
  git(dirtyUnmerged, "add", "unpushed.txt");
  git(dirtyUnmerged, "commit", "-q", "-m", "not yet merged"); // origin/main NOT advanced to include this

  const standing = join(root, "wt-standing");
  git(root, "worktree", "add", "--quiet", "-b", "dispatcher/merge", standing, mergedSha);

  // CHERRY-PICKED: commit on a branch, then apply the SAME patch onto `root`'s own checkout as a
  // genuinely different commit -- same content, different SHA, different parent -- and advance
  // origin/main to THAT commit. `agent/cherry-picked`'s own commit is provably never an ancestor of the
  // result, while `git cherry` reads it as patch-equivalent.
  //
  // An UNRELATED commit is made on root FIRST, so the cherry-pick lands on a different parent than the
  // source commit did -- cherry-picking onto the IDENTICAL parent reuses the exact same author/committer
  // timestamp and produces a byte-identical commit (same SHA), which is a real fast-forward, not the
  // "same content, different history" shape this fixture exists to demonstrate.
  const cherryPicked = join(root, "wt-cherry-picked");
  git(root, "worktree", "add", "--quiet", "-b", "agent/cherry-picked", cherryPicked, mergedSha);
  writeFileSync(join(cherryPicked, "cherry.txt"), "picked content\n");
  git(cherryPicked, "add", "cherry.txt");
  git(cherryPicked, "commit", "-q", "-m", "the change that gets cherry-picked");
  const cherrySourceSha = git(cherryPicked, "rev-parse", "HEAD").trim();

  writeFileSync(join(root, "unrelated.txt"), "unrelated upstream work\n");
  git(root, "add", "unrelated.txt");
  git(root, "commit", "-q", "-m", "unrelated upstream commit, so the cherry-pick below has a different parent");
  git(root, "cherry-pick", "--quiet", cherrySourceSha); // applied onto root's own `main`, a NEW commit
  const cherryLandedSha = git(root, "rev-parse", "HEAD").trim();
  assert.notEqual(cherryLandedSha, cherrySourceSha,
    "the fixture itself is broken if the cherry-pick reused the source SHA -- it must be a real, "
    + "different commit with equivalent content, or this fixture proves nothing");
  git(root, "update-ref", "refs/remotes/origin/main", cherryLandedSha);

  return { root, merged, dirtyUncommitted, dirtyUnmerged, standing, cherryPicked, baseSha, mergedSha };
}

// --- parseWorktreeList: pure ---

test("parseWorktreeList reads path, branch, and detached state from real porcelain output", () => {
  const porcelain = "worktree /a/b\nHEAD abc123\nbranch refs/heads/agent/x\n\n"
    + "worktree /a/c\nHEAD def456\ndetached\n";
  assert.deepEqual(parseWorktreeList(porcelain), [
    { path: "/a/b", branch: "agent/x", detached: false },
    { path: "/a/c", branch: null, detached: true },
  ]);
});

// --- isStandingBranch: pure ---

test("isStandingBranch: an agent/* branch is NOT standing -- it is a unit tree", () => {
  assert.equal(isStandingBranch("agent/some-unit"), false);
});
test("isStandingBranch: dispatcher/* and lead/* ARE standing -- role trees, real examples", () => {
  assert.equal(isStandingBranch("dispatcher/merge"), true);
  assert.equal(isStandingBranch("lead/fleet-tree-rule"), true);
});
test("isStandingBranch: main itself is standing", () => {
  assert.equal(isStandingBranch("main"), true);
});

// --- classify: pure ---

const C = {
  branch: "agent/x", merge: "merged" as const, workingTreeClean: true, contentMerged: false,
  recentlyActive: false as boolean | "unknown",
};

test("classify: merged and clean is REMOVE", () => {
  assert.equal(classify(C), "remove");
});
test("classify: merged, clean, but RECENTLY ACTIVE is its own state (#220) -- not removed, not called dirty", () => {
  assert.equal(classify({ ...C, recentlyActive: true }), "active");
});
test("classify: activity status UNKNOWN is inconclusive, even when merge and clean both read positively", () => {
  assert.equal(classify({ ...C, recentlyActive: "unknown" }), "inconclusive");
});
test("classify: standing beats an unknown activity status too -- a role tree is never anything but standing", () => {
  assert.equal(classify({ ...C, branch: "lead/x", recentlyActive: "unknown" }), "standing");
});
test("classify: merged but dirty working tree is DIRTY, not removed", () => {
  assert.equal(classify({ ...C, workingTreeClean: false }), "dirty");
});
test("classify: unmerged, not content-merged, even with a clean working tree, is DIRTY", () => {
  assert.equal(classify({ ...C, merge: "not-merged" }), "dirty");
});
test("classify: a detached worktree is DIRTY regardless of the other facts", () => {
  assert.equal(classify({ ...C, branch: null }), "dirty");
});
test("classify: a STANDING branch is never REMOVE, even merged and clean", () => {
  assert.equal(classify({ ...C, branch: "dispatcher/merge" }), "standing");
});
test("classify: unmerged but CONTENT-merged (cherry-picked) is its own state, not dirty and not removed", () => {
  assert.equal(classify({ ...C, merge: "not-merged", contentMerged: true }), "cherry-picked");
});
test("classify: standing beats cherry-picked -- a role branch is never auto-classified either way", () => {
  assert.equal(classify({ ...C, branch: "lead/x", merge: "not-merged", contentMerged: true }), "standing");
});
test("classify: merge status UNKNOWN is its own state -- never guessed as merged or not-merged", () => {
  assert.equal(classify({ ...C, merge: "unknown" }), "inconclusive");
});
test("classify: working tree UNKNOWN is its own state, even when merge status is clean", () => {
  assert.equal(classify({ ...C, workingTreeClean: "unknown" }), "inconclusive");
});
test("classify: inconclusive beats cherry-picked -- 'could not tell' must never be folded into a resolved state", () => {
  assert.equal(classify({ ...C, merge: "unknown", contentMerged: true }), "inconclusive");
});
test("classify: standing beats inconclusive too -- a role tree is never anything but standing", () => {
  assert.equal(classify({ ...C, branch: "lead/x", merge: "unknown" }), "standing");
});

// --- Live, against real disposable fixtures ---

test("isPrimaryWorktree tells a real primary (.git dir) from a real linked worktree (.git file)", () => {
  const { root, merged } = buildFixtureRepo();
  try {
    assert.equal(isPrimaryWorktree(root), true);
    assert.equal(isPrimaryWorktree(merged), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mergeStatus and isWorkingTreeClean read the three fixture shapes correctly", () => {
  const { root, merged, dirtyUncommitted, dirtyUnmerged } = buildFixtureRepo();
  try {
    assert.equal(mergeStatus(root, "agent/merged-clean"), "merged");
    assert.equal(isWorkingTreeClean(merged, "agent/merged-clean"), true);

    assert.equal(mergeStatus(root, "agent/dirty-uncommitted"), "merged");
    assert.equal(isWorkingTreeClean(dirtyUncommitted, "agent/dirty-uncommitted"), false);

    assert.equal(mergeStatus(root, "agent/dirty-unmerged"), "not-merged");
    assert.equal(isWorkingTreeClean(dirtyUnmerged, "agent/dirty-unmerged"), true,
      "the FILES are clean -- the unmerged commit is what must be caught, independently of file state");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("isContentMerged: TRUE for a cherry-picked branch, FALSE for a genuinely unmerged one", () => {
  const { root } = buildFixtureRepo();
  try {
    assert.equal(mergeStatus(root, "agent/cherry-picked"), "not-merged",
      "a cherry-pick must NOT read as a literal ancestor -- that is the whole reason this state exists");
    assert.equal(isContentMerged(root, "agent/cherry-picked"), true);

    assert.equal(isContentMerged(root, "agent/dirty-unmerged"), false,
      "a genuinely unmerged branch must not be mistaken for a cherry-picked one");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mergeStatus: no origin/main to compare against is UNKNOWN, never guessed as merged or not-merged", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a11y-prune-inconclusive-")));
  git(root, "init", "--quiet", "-b", "main");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "Fixture");
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, "add", "base.txt");
  git(root, "commit", "-q", "-m", "base");
  const baseSha = git(root, "rev-parse", "HEAD").trim();
  const wt = join(root, "wt-unknown");
  // deliberately NO refs/remotes/origin/main -- merge-base --is-ancestor cannot even ask the question,
  // which is the real-world shape of a missing/renamed remote-tracking ref, not a contrived error.
  git(root, "worktree", "add", "--quiet", "-b", "agent/unknown-status", wt, baseSha);
  try {
    assert.equal(mergeStatus(root, "agent/unknown-status"), "unknown");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pruneWorktrees removes the merged+clean fixture, names dirty/standing/cherry-picked separately, skips the primary", () => {
  const { root, merged, dirtyUncommitted, dirtyUnmerged, standing, cherryPicked } = buildFixtureRepo();
  try {
    const report = pruneWorktrees(root, { now: LONG_AFTER() });
    assert.deepEqual(report.removed.map((r) => r.path), [merged]);
    assert.deepEqual(report.dirty.map((d) => d.path).sort(), [dirtyUncommitted, dirtyUnmerged].sort());
    assert.deepEqual(report.standing.map((s) => s.path), [standing]);
    assert.deepEqual(report.cherryPicked.map((c) => c.path), [cherryPicked]);
    assert.equal(report.skippedPrimary, root);

    assert.equal(existsSync(merged), false, "the clean, merged worktree must actually be gone from disk");
    assert.equal(existsSync(dirtyUncommitted), true, "a dirty worktree must still exist afterwards");
    assert.equal(existsSync(dirtyUnmerged), true, "a dirty worktree must still exist afterwards");
    assert.equal(existsSync(standing), true, "a standing (role) worktree must never be removed");
    assert.equal(existsSync(cherryPicked), true, "a cherry-picked worktree must never be auto-removed");
    assert.equal(existsSync(root), true, "the primary must never be removed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pruneWorktrees reports an UNKNOWN merge status as inconclusive, never as dirty or removed", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a11y-prune-inconclusive-e2e-")));
  git(root, "init", "--quiet", "-b", "main");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "Fixture");
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, "add", "base.txt");
  git(root, "commit", "-q", "-m", "base");
  const baseSha = git(root, "rev-parse", "HEAD").trim();
  const wt = join(root, "wt-unknown");
  git(root, "worktree", "add", "--quiet", "-b", "agent/unknown-status", wt, baseSha); // no origin/main at all
  try {
    const report = pruneWorktrees(root, { remove: () => { assert.fail("must never attempt to remove an inconclusive worktree"); } });
    assert.deepEqual(report.inconclusive.map((i) => i.path), [wt]);
    assert.deepEqual(report.removed, []);
    assert.deepEqual(report.dirty, []);
    assert.equal(existsSync(wt), true, "an inconclusive worktree must be left exactly as found");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- Mutation-check, exactly as the acceptance criteria asks: make a dirty fixture look clean, confirm
// the refusal stops firing -- proving the guard is doing real work, not just permanently refusing. ---

test("MUTATION: committing the uncommitted file turns a refused fixture into a removed one", () => {
  const { root, merged, dirtyUncommitted } = buildFixtureRepo();
  try {
    const before = pruneWorktrees(root, { remove: () => {} }); // dry: do not actually remove `merged` yet
    assert.ok(before.dirty.some((d) => d.path === dirtyUncommitted), "must start out refused");

    git(dirtyUncommitted, "add", "wip.txt");
    git(dirtyUncommitted, "commit", "-q", "-m", "actually finished");
    git(root, "update-ref", "refs/remotes/origin/main", git(dirtyUncommitted, "rev-parse", "HEAD").trim());

    const after = pruneWorktrees(root, { now: LONG_AFTER(), remove: (p) => rmSync(p, { recursive: true, force: true }) });
    assert.ok(after.removed.some((r) => r.path === dirtyUncommitted),
      "once genuinely clean and merged, the same fixture must now be removed -- proving the earlier "
      + "refusal was a real discrimination, not a fixture that could never be removed for some other reason");
    assert.equal(existsSync(dirtyUncommitted), false);
    void merged;
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("MUTATION: fast-forwarding origin/main turns an unmerged-but-clean fixture into a removed one", () => {
  const { root, dirtyUnmerged } = buildFixtureRepo();
  try {
    const before = pruneWorktrees(root, { remove: () => {} });
    assert.ok(before.dirty.some((d) => d.path === dirtyUnmerged), "must start out refused, unmerged");

    git(root, "update-ref", "refs/remotes/origin/main", git(dirtyUnmerged, "rev-parse", "HEAD").trim());

    const after = pruneWorktrees(root, { now: LONG_AFTER(), remove: (p) => rmSync(p, { recursive: true, force: true }) });
    assert.ok(after.removed.some((r) => r.path === dirtyUnmerged),
      "once origin/main actually includes the commit, the same fixture must now be removed");
    assert.equal(existsSync(dirtyUnmerged), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- #220: "clean" is not "finished" -- a stash makes a tree momentarily clean, and a prune running
// inside that window must not remove it. ---

test("recentGitActivity: true right after a git operation, false once `now` is past the window, unknown for a bad path", () => {
  const { root, merged } = buildFixtureRepo();
  try {
    assert.equal(recentGitActivity(merged), true, "the fixture's own setup commit just touched the gitdir");
    assert.equal(recentGitActivity(merged, { now: LONG_AFTER() }), false,
      "the identical gitdir state, asked about from far enough in the future, is NOT recent");
    assert.equal(recentGitActivity(join(merged, "does-not-exist")), "unknown",
      "a path `git rev-parse --absolute-git-dir` cannot resolve is UNKNOWN, never guessed as false");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("REPRODUCE (#220, acceptance step 1): touch a file, stash -u, prune runs inside the window -- removed anyway before the fix, and this is the failing shape", () => {
  const { root, merged } = buildFixtureRepo();
  try {
    // `merged` is already merged+clean by construction. Simulate the exact incident: a session about to
    // switch branches stashes an in-progress edit, which makes `git status --porcelain` read empty again.
    writeFileSync(join(merged, "mid-switch.txt"), "not yet committed\n");
    git(merged, "stash", "-u");
    assert.equal(isWorkingTreeClean(merged, "agent/merged-clean"), true,
      "stashing is exactly what makes the tree read clean -- the premise of the whole incident");

    // No `now` override: this is the LIVE window, seconds after the stash, exactly like the real incident.
    const report = pruneWorktrees(root);
    assert.deepEqual(report.removed.map((r) => r.path), [],
      "must NOT be removed -- a session mid-stash is exactly the case #220 exists to catch");
    assert.deepEqual(report.active.map((r) => r.path), [merged],
      "reported as ACTIVE, not silently dropped and not folded into DIRTY (there is no uncommitted work "
      + "git status can see) -- naming the real reason is the point of the fix");
    assert.equal(existsSync(merged), true, "the directory itself must still be there");

    git(merged, "stash", "pop"); // leave the fixture as buildFixtureRepo() promised it
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("after the fix, the SAME sequence removes it once the activity window has genuinely passed (acceptance step 2/3)", () => {
  const { root, merged } = buildFixtureRepo();
  try {
    writeFileSync(join(merged, "mid-switch.txt"), "not yet committed\n");
    git(merged, "stash", "-u");

    const stillActive = pruneWorktrees(root, { now: Date.now() + 1000 }); // one second later: still inside the window
    assert.deepEqual(stillActive.removed, [], "one second later is still inside the window");

    const laterOn = pruneWorktrees(root, { now: LONG_AFTER() }); // the window has genuinely passed
    assert.deepEqual(laterOn.removed.map((r) => r.path), [merged],
      "a GENUINELY abandoned tree -- merged, clean, and no activity for the whole window -- must still be "
      + "pruned. A prune that stops pruning is worse than the defect it fixes (this file's own header).");
    assert.equal(existsSync(merged), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CONTROL: a totally empty repo (no linked worktrees) reports nothing to remove or name", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a11y-prune-empty-")));
  git(root, "init", "--quiet", "-b", "main");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "Fixture");
  writeFileSync(join(root, "x.txt"), "x\n");
  git(root, "add", "x.txt");
  git(root, "commit", "-q", "-m", "x");
  try {
    const report = pruneWorktrees(root);
    assert.deepEqual(report.removed, []);
    assert.deepEqual(report.dirty, []);
    assert.equal(report.skippedPrimary, root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the primary is NEVER passed to remove(), even if (hypothetically) it looked mergeable", () => {
  const { root, merged } = buildFixtureRepo();
  const removedPaths: string[] = [];
  try {
    pruneWorktrees(root, { now: LONG_AFTER(), remove: (p) => { removedPaths.push(p); rmSync(p, { recursive: true, force: true }); } });
    assert.ok(!removedPaths.includes(root), "the primary path must never reach the remove function");
    assert.deepEqual(removedPaths, [merged]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * THROUGH argv, NOT THROUGH THE EXPORT. Everything above calls `pruneWorktrees()` directly, which cannot
 * see the one thing #669 changed: which way round the DEFAULT is. `dryRun` is computed in `main()` from
 * `process.argv`, so a mutation there -- `includes("--apply")` inverted, the flag renamed, the constant
 * dropped -- passes every test above and removes three sessions' worktrees on the next unattended run.
 *
 * THESE THREE REPLACE AN ACCEPTANCE COMMAND THAT COULD NOT EXIST. #669 first stated the refusal as
 * `node scripts/prune-worktrees.mjs --dry-run  # must be REFUSED` in its acceptance block, and the
 * acceptance runner ran it, got the exit 2 the refusal is FOR, and failed the job -- because an
 * acceptance command's verdict IS its exit code, so a command whose correct answer is nonzero cannot be
 * one. A negative case belongs where the expected exit code can be written down.
 */
const runCli = (repoRoot: string, ...args: string[]) => {
  try {
    const stdout = execFileSync(process.execPath, [PRUNE_CLI, repoRoot, ...args],
      { env: sandboxGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

test("#669: `--dry-run` is REFUSED BY NAME with a nonzero exit, and the message says what it does take", () => {
  const { root } = buildFixtureRepo();
  try {
    const { status, stderr } = runCli(root, "--dry-run");
    assert.notEqual(status, 0, "a refused flag must exit nonzero -- an ignored flag runs the default");
    assert.match(stderr, /unknown flag --dry-run/);
    assert.match(stderr, /--apply/, "the refusal must name the flag that does exist, not just reject");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#669 THE WHOLE POINT: the bare command REPORTS and every worktree is still on disk afterwards", () => {
  const { root, merged, dirtyUncommitted, standing } = buildFixtureRepo();
  try {
    const { status, stdout } = runCli(root);
    assert.equal(status, 0);
    assert.match(stdout, /^WOULD REMOVE /, "the default must say WOULD REMOVE, never `removed`");
    assert.match(stdout, /pass --apply to remove them/);
    for (const path of [merged, dirtyUncommitted, standing]) {
      assert.ok(existsSync(path), `the default removed ${path} -- it must remove NOTHING`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#669 MUTATION DIRECTION: `--apply` reaches dryRun -- the heading is `removed`, the word the listing may never print", () => {
  const { root } = buildFixtureRepo();
  try {
    const { status, stdout } = runCli(root, "--apply");
    assert.equal(status, 0);
    assert.match(stdout, /^removed \d+ worktree\(s\):/,
      "with --apply the heading must be `removed`; if it still says WOULD REMOVE the flag never reached dryRun");
    assert.ok(!stdout.includes("WOULD REMOVE"), "a mutating run must never print the listing's wording");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
