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
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseWorktreeList, isPrimaryWorktree, classify, isStandingBranch, isMergedIntoMain, isContentMerged,
  isWorkingTreeClean, pruneWorktrees,
} from "../../../../scripts/prune-worktrees.mjs";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

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

const C = { branch: "agent/x", mergedIntoMain: true, workingTreeClean: true, contentMerged: false };

test("classify: merged and clean is REMOVE", () => {
  assert.equal(classify(C), "remove");
});
test("classify: merged but dirty working tree is DIRTY, not removed", () => {
  assert.equal(classify({ ...C, workingTreeClean: false }), "dirty");
});
test("classify: unmerged, not content-merged, even with a clean working tree, is DIRTY", () => {
  assert.equal(classify({ ...C, mergedIntoMain: false }), "dirty");
});
test("classify: a detached worktree is DIRTY regardless of the other facts", () => {
  assert.equal(classify({ ...C, branch: null }), "dirty");
});
test("classify: a STANDING branch is never REMOVE, even merged and clean", () => {
  assert.equal(classify({ ...C, branch: "dispatcher/merge" }), "standing");
});
test("classify: unmerged but CONTENT-merged (cherry-picked) is its own state, not dirty and not removed", () => {
  assert.equal(classify({ ...C, mergedIntoMain: false, contentMerged: true }), "cherry-picked");
});
test("classify: standing beats cherry-picked -- a role branch is never auto-classified either way", () => {
  assert.equal(classify({ ...C, branch: "lead/x", mergedIntoMain: false, contentMerged: true }), "standing");
});

// --- Live, against real disposable fixtures ---

test("isPrimaryWorktree tells a real primary (.git dir) from a real linked worktree (.git file)", () => {
  const { root, merged } = buildFixtureRepo();
  try {
    assert.equal(isPrimaryWorktree(root), true);
    assert.equal(isPrimaryWorktree(merged), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("isMergedIntoMain and isWorkingTreeClean read the three fixture shapes correctly", () => {
  const { root, merged, dirtyUncommitted, dirtyUnmerged } = buildFixtureRepo();
  try {
    assert.equal(isMergedIntoMain(root, "agent/merged-clean"), true);
    assert.equal(isWorkingTreeClean(merged, "agent/merged-clean"), true);

    assert.equal(isMergedIntoMain(root, "agent/dirty-uncommitted"), true);
    assert.equal(isWorkingTreeClean(dirtyUncommitted, "agent/dirty-uncommitted"), false);

    assert.equal(isMergedIntoMain(root, "agent/dirty-unmerged"), false);
    assert.equal(isWorkingTreeClean(dirtyUnmerged, "agent/dirty-unmerged"), true,
      "the FILES are clean -- the unmerged commit is what must be caught, independently of file state");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("isContentMerged: TRUE for a cherry-picked branch, FALSE for a genuinely unmerged one", () => {
  const { root } = buildFixtureRepo();
  try {
    assert.equal(isMergedIntoMain(root, "agent/cherry-picked"), false,
      "a cherry-pick must NOT read as a literal ancestor -- that is the whole reason this state exists");
    assert.equal(isContentMerged(root, "agent/cherry-picked"), true);

    assert.equal(isContentMerged(root, "agent/dirty-unmerged"), false,
      "a genuinely unmerged branch must not be mistaken for a cherry-picked one");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pruneWorktrees removes the merged+clean fixture, names dirty/standing/cherry-picked separately, skips the primary", () => {
  const { root, merged, dirtyUncommitted, dirtyUnmerged, standing, cherryPicked } = buildFixtureRepo();
  try {
    const report = pruneWorktrees(root);
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

    const after = pruneWorktrees(root, { remove: (p) => rmSync(p, { recursive: true, force: true }) });
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

    const after = pruneWorktrees(root, { remove: (p) => rmSync(p, { recursive: true, force: true }) });
    assert.ok(after.removed.some((r) => r.path === dirtyUnmerged),
      "once origin/main actually includes the commit, the same fixture must now be removed");
    assert.equal(existsSync(dirtyUnmerged), false);
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
    pruneWorktrees(root, { remove: (p) => { removedPaths.push(p); rmSync(p, { recursive: true, force: true }); } });
    assert.ok(!removedPaths.includes(root), "the primary path must never reach the remove function");
    assert.deepEqual(removedPaths, [merged]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
