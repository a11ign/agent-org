/**
 * `packages/agent-org/src/prune-worktrees.ts` removes a stale worktree only when it is BOTH merged into `origin/main`
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
 * `packages/guards/src/git-env.mjs` exists), an unscrubbed git call in a fixture helper would redirect onto whatever
 * `GIT_DIR` names instead of the intended disposable `/tmp` repo -- the identical class of defect closed
 * elsewhere today, caught here by `git-spawn-classification.test.ts`'s own discovery before this file
 * ever shipped.
 */
// no-token: gh -- every `pruneWorktrees` call passes its own `claim`, and the tests of `claimRefusal` hand it a stub `gh`; proven by running this file with `gh` shimmed to exit 4.
import { TSX_IMPORT } from "../tsx-import.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  parseWorktreeList, isPrimaryWorktree, classify, detachedMergeStatus, mergeStatus, isContentMerged,
  isWorkingTreeClean, pruneWorktrees as pruneWorktreesWithClaims, recentGitActivity, ACTIVITY_WINDOW_MS,
  cleanliness, ignoredByAuthority,
  strandedWork, formatStranded, trackedChanges, unverifiedRecords, formatReport,
  heldByOwner, deliveredOwnCommit, mainLineCommits, hasOwnBranch,
} from "../prune-worktrees.ts";
import { stampWorktree } from "../worktree-owner.ts";
import { sandboxGitEnv } from "../lib/git-env.ts";
import {
  claimRefusal, nestedWorktrees, recordRemoval, removalLogPath, REMOVAL_LOG_ENV, rowCandidates, rowsClosed, worktreeBranch,
} from "../worktree-removal.ts";
import { tmpDir, tmpDirForFile } from "../lib/tmp-fixture.ts";

// #2782: EVERY REMOVAL WRITES A LINE AND READS THE ROW'S CLAIM, and a fixture must do neither to the host: a fixture branch
// named `agent/delivered-1948` would otherwise read the real #1948 over `gh`, and every removal would land in the real log.
// The tests that ARE about either pass their own `claim` and `record` and read the log they pointed this at.
process.env[REMOVAL_LOG_ENV] = join(tmpDirForFile("prune-removal-log-"), "worktree-removals");
const NOBODY_CLAIMS: () => { refused: false } = () => ({ refused: false });
const pruneWorktrees = (root: string, deps: NonNullable<Parameters<typeof pruneWorktreesWithClaims>[1]> = {}) =>
  pruneWorktreesWithClaims(root, { claim: NOBODY_CLAIMS, ...deps });

// The CLI is spawned as a real process below, so the argv path -- the only place `dryRun` is
// decided -- is exercised rather than reasoned about.
const PRUNE_CLI = new URL("../prune-worktrees.ts", import.meta.url).pathname;

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
 *   - dispatcher/merge        -- a ROLE branch, merged and clean: REMOVE since #671, and the
 *                                 fixture is unchanged -- only the question it is asked
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

// --- #671/#696: THE PREDICATE IS ABOUT STATE, AND THERE IS NO NAME CLAUSE LEFT ---
//
// `isStandingBranch(branch) { return !branch.startsWith("agent/"); }` is GONE, and so is
// `classify`'s `if (branch === null) return "dirty"`. Between them they exempted 54 of 103 worktrees on
// the live host -- 42 by prefix, 12 by detachment -- and neither exemption was about whether removing
// the tree was safe. The tests below assert the inversion directly, so restoring either clause fails
// here rather than in six weeks on somebody's disk.

test("#671/#696: `classify` CANNOT BE TOLD a branch name -- the strongest form the fix has", () => {
  // The obvious test here would be `classify({ ...C, branch: "lead/x" })` against every role prefix and
  // against null, asserting the name is ignored. IT DOES NOT COMPILE, and that is a better result than
  // any assertion: the parameter type no longer has a `branch` field, so a future clause reading one
  // cannot be written without changing the signature -- which is a diff a reviewer sees. A runtime
  // assertion that a value is ignored can be defeated by adding the value back; a type cannot.
  //
  // What remains testable is that state alone decides, which is the whole predicate:
  assert.equal(classify({ ...C }), "remove");
  assert.equal(classify({ ...C, merge: "not-merged" }), "dirty");
  assert.equal(classify({ ...C, workingTreeClean: false }), "dirty");
  assert.equal(classify({ ...C, merge: "unknown" }), "inconclusive");
  assert.equal(classify({ ...C, recentlyActive: true }), "active");
  assert.equal(classify({ ...C, merge: "not-merged", contentMerged: true }), "cherry-picked");
});

test("#671 LIVE: a merged, clean ROLE tree is removed -- against real branches, where the name still exists", () => {
  // The type removes the name from `classify`. Only the live path can show that a real `dispatcher/*`
  // worktree is now reached at all, since `pruneWorktrees` used to intercept it before classify was
  // ever asked. `buildFixtureRepo`'s `standing` tree IS `dispatcher/merge`, merged and clean.
  const { root, standing } = buildFixtureRepo();
  try {
    const report = pruneWorktrees(root, { now: LONG_AFTER() });
    assert.ok(report.removed.map((r) => r.path).includes(standing),
      "a merged, clean dispatcher/* worktree is as removable as an agent/* one -- #671");
    assert.equal(existsSync(standing), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- classify: pure ---

const C = {
  merge: "merged" as const, workingTreeClean: true, contentMerged: false,
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
test("classify: merged but dirty working tree is DIRTY, not removed", () => {
  assert.equal(classify({ ...C, workingTreeClean: false }), "dirty");
});
test("classify: unmerged, not content-merged, even with a clean working tree, is DIRTY", () => {
  assert.equal(classify({ ...C, merge: "not-merged" }), "dirty");
});
test("#696: a detached worktree is classified on its STATE, not on having no branch name", () => {
  // Was `if (branch === null) return "dirty"` -- filed under a heading reading "uncommitted or unmerged
  // work" without either being measured. Twelve of the fifteen detached trees on the live host had
  // neither: 0 uncommitted files, 0 commits `origin/main` lacks.
  // `branch: null` is not passed here either, and cannot be -- see the type note above. The detached
  // case is proved end to end instead, by `#696 LIVE` below, which builds real detached worktrees.
  assert.equal(classify({ ...C }), "remove");
  assert.equal(classify({ ...C, workingTreeClean: false }), "dirty");
  assert.equal(classify({ ...C, merge: "not-merged" }), "dirty");
  assert.equal(classify({ ...C, merge: "unknown" }), "inconclusive");
  assert.equal(classify({ ...C, recentlyActive: true }), "active");
});
test("classify: unmerged but CONTENT-merged (cherry-picked) is its own state, not dirty and not removed", () => {
  assert.equal(classify({ ...C, merge: "not-merged", contentMerged: true }), "cherry-picked");
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
    assert.equal(isWorkingTreeClean(merged), true);

    assert.equal(mergeStatus(root, "agent/dirty-uncommitted"), "merged");
    assert.equal(isWorkingTreeClean(dirtyUncommitted), false);

    assert.equal(mergeStatus(root, "agent/dirty-unmerged"), "not-merged");
    assert.equal(isWorkingTreeClean(dirtyUnmerged), true,
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

test("pruneWorktrees removes every merged+clean tree INCLUDING the role one, names the rest, skips the primary", () => {
  // `standing` here is `dispatcher/merge` -- merged and clean, and until #671 exempt purely for not
  // being `agent/*`. It is removed now, and that IS the change: the fixture did not move, the question
  // did.
  const { root, merged, dirtyUncommitted, dirtyUnmerged, standing, cherryPicked } = buildFixtureRepo();
  try {
    const report = pruneWorktrees(root, { now: LONG_AFTER() });
    assert.deepEqual(report.removed.map((r) => r.path).sort(), [merged, standing].sort());
    assert.deepEqual(report.dirty.map((d) => d.path).sort(), [dirtyUncommitted, dirtyUnmerged].sort());
    assert.deepEqual(report.cherryPicked.map((c) => c.path), [cherryPicked]);
    assert.equal(report.skippedPrimary, root);

    assert.equal(existsSync(merged), false, "the clean, merged worktree must actually be gone from disk");
    assert.equal(existsSync(standing), false,
      "a merged, clean ROLE tree is as removable as an agent one -- #671");
    assert.equal(existsSync(dirtyUncommitted), true, "a dirty worktree must still exist afterwards");
    assert.equal(existsSync(dirtyUnmerged), true, "a dirty worktree must still exist afterwards");
    assert.equal(existsSync(cherryPicked), true, "a cherry-picked worktree must never be auto-removed");
    assert.equal(existsSync(root), true, "the primary must never be removed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#696 LIVE: a DETACHED, merged, clean worktree is removed -- and a detached UNMERGED one is not", () => {
  const { root, mergedSha, baseSha } = buildFixtureRepo();
  const detachedMerged = join(root, "wt-detached-merged");
  git(root, "worktree", "add", "--quiet", "--detach", detachedMerged, baseSha); // an ancestor of main
  const detachedAhead = join(root, "wt-detached-ahead");
  git(root, "worktree", "add", "--quiet", "--detach", detachedAhead, mergedSha);
  writeFileSync(join(detachedAhead, "only-here.txt"), "real work\n");
  git(detachedAhead, "add", "only-here.txt");
  git(detachedAhead, "commit", "-q", "-m", "a commit origin/main does not have");
  try {
    const report = pruneWorktrees(root, { now: LONG_AFTER() });
    assert.ok(report.removed.map((r) => r.path).includes(detachedMerged),
      "detached and fully merged and clean: every input to REMOVE is present, and no name is needed");
    assert.ok(report.dirty.map((d) => d.path).includes(detachedAhead),
      "detached with a commit main lacks: refused, and now for the reason that is actually true");
    assert.equal(existsSync(detachedAhead), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#696 detachedMergeStatus: merged, not-merged and unknown are three answers, not two", () => {
  const { root, mergedSha, baseSha } = buildFixtureRepo();
  const wt = join(root, "wt-status-probe");
  git(root, "worktree", "add", "--quiet", "--detach", wt, baseSha);
  try {
    assert.equal(detachedMergeStatus(wt), "merged");
    git(wt, "checkout", "-q", "--detach", mergedSha);
    writeFileSync(join(wt, "ahead.txt"), "x\n");
    git(wt, "add", "ahead.txt");
    git(wt, "commit", "-q", "-m", "ahead");
    assert.equal(detachedMergeStatus(wt), "not-merged");
    // No `origin/main` to compare against at all -- git exits 128, not 1.
    git(root, "update-ref", "-d", "refs/remotes/origin/main");
    assert.equal(detachedMergeStatus(wt), "unknown",
      "a failed comparison is never the answer `not-merged`");
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
  const { root, merged, standing } = buildFixtureRepo();
  try {
    // `merged` is already merged+clean by construction. Simulate the exact incident: a session about to
    // switch branches stashes an in-progress edit, which makes `git status --porcelain` read empty again.
    writeFileSync(join(merged, "mid-switch.txt"), "not yet committed\n");
    git(merged, "stash", "-u");
    assert.equal(isWorkingTreeClean(merged), true,
      "stashing is exactly what makes the tree read clean -- the premise of the whole incident");

    // No `now` override: this is the LIVE window, seconds after the stash, exactly like the real incident.
    const report = pruneWorktrees(root);
    assert.deepEqual(report.removed.map((r) => r.path), [],
      "must NOT be removed -- a session mid-stash is exactly the case #220 exists to catch");
    assert.deepEqual(report.active.map((r) => r.path).sort(), [merged, standing].sort(),
      "reported as ACTIVE, not silently dropped and not folded into DIRTY (there is no uncommitted work "
      + "git status can see) -- naming the real reason is the point of the fix");
    assert.equal(existsSync(merged), true, "the directory itself must still be there");

    git(merged, "stash", "pop"); // leave the fixture as buildFixtureRepo() promised it
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("after the fix, the SAME sequence removes it once the activity window has genuinely passed (acceptance step 2/3)", () => {
  const { root, merged, standing } = buildFixtureRepo();
  try {
    writeFileSync(join(merged, "mid-switch.txt"), "not yet committed\n");
    git(merged, "stash", "-u");

    const stillActive = pruneWorktrees(root, { now: Date.now() + 1000 }); // one second later: still inside the window
    assert.deepEqual(stillActive.removed, [], "one second later is still inside the window");

    const laterOn = pruneWorktrees(root, { now: LONG_AFTER() }); // the window has genuinely passed
    assert.deepEqual(laterOn.removed.map((r) => r.path).sort(), [merged, standing].sort(),
      "a GENUINELY abandoned tree -- merged, clean, and no activity for the whole window -- must still be "
      + "pruned. A prune that stops pruning is worse than the defect it fixes (this file's own header). "
      + "`standing` is here because #671 removed the prefix clause: the role tree is abandoned too.");
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
  const { root, merged, standing } = buildFixtureRepo();
  const removedPaths: string[] = [];
  try {
    pruneWorktrees(root, { now: LONG_AFTER(), remove: (p) => { removedPaths.push(p); rmSync(p, { recursive: true, force: true }); } });
    assert.ok(!removedPaths.includes(root), "the primary path must never reach the remove function");
    assert.deepEqual(removedPaths.sort(), [merged, standing].sort());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * THROUGH argv, NOT THROUGH THE EXPORT. Everything above calls `pruneWorktrees()` directly, which cannot
 * see the one thing #669 changed: which way round the DEFAULT is. `dryRun` is computed in `main()` from
 * `process.argv`, so a mutation there -- `includes("--apply")` inverted, the flag renamed, the constant
 * dropped -- passes every test above and removes three sessions' worktrees on the next unattended run.
 *
 * THESE THREE REPLACE AN ACCEPTANCE COMMAND THAT COULD NOT EXIST. #669 first stated the refusal as
 * `node packages/agent-org/src/prune-worktrees.ts --dry-run  # must be REFUSED` in its acceptance block, and the
 * acceptance runner ran it, got the exit 2 the refusal is FOR, and failed the job -- because an
 * acceptance command's verdict IS its exit code, so a command whose correct answer is nonzero cannot be
 * one. A negative case belongs where the expected exit code can be written down.
 */
const runCli = (repoRoot: string, ...args: string[]) => {
  try {
    const stdout = execFileSync(process.execPath, [...TSX_IMPORT, PRUNE_CLI, repoRoot, ...args],
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

// --- #933: uncommitted work in a retired session's worktree, enumerated ---

/**
 * A repo with the three shapes the stranded-work report has to tell apart, built fresh each time:
 *   - `agent/live`         — a MODIFIED TRACKED file, branch at main's tip: the work IS the change
 *   - `dispatcher/retired` — a tracked change on a RETIRED session's prefix, one commit ahead
 *   - `agent/noise`        — an UNTRACKED file only: the 31-of-58 case that must NOT be listed
 */
function buildStrandedFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a11y-stranded-")));
  git(root, "init", "--quiet", "-b", "main");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "Fixture");
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, "add", "base.txt");
  git(root, "commit", "-q", "-m", "base");
  git(root, "update-ref", "refs/remotes/origin/main", git(root, "rev-parse", "HEAD").trim());

  const live = join(root, "wt-live");
  git(root, "worktree", "add", "--quiet", "-b", "agent/live", live, "main");
  writeFileSync(join(live, "base.txt"), "base\nan uncommitted line\n");

  const retired = join(root, "wt-retired");
  git(root, "worktree", "add", "--quiet", "-b", "dispatcher/retired", retired, "main");
  writeFileSync(join(retired, "landed.txt"), "committed\n");
  git(retired, "add", "landed.txt");
  git(retired, "commit", "-q", "-m", "a commit origin/main does not have");
  writeFileSync(join(retired, "base.txt"), "base\nand an uncommitted one\n");

  const noise = join(root, "wt-noise");
  git(root, "worktree", "add", "--quiet", "-b", "agent/noise", noise, "main");
  writeFileSync(join(noise, ".metadata_never_index"), ""); // what macOS puts in all 58 of them
  return root;
}

test("#933: the report names worktrees with MODIFIED TRACKED files and no others", () => {
  // The whole value is the narrowing. Measured on the live host 2026-09-12: 58 worktrees, 38 with
  // something uncommitted, 7 with modified tracked files — the other 31 carry `.metadata_never_index` and
  // nothing else. A report that names 38 is a report nobody reads, and the entries that matter are
  // invisible inside it.
  const root = buildStrandedFixture();
  try {
    const { examined, stranded } = strandedWork(root);
    // THREE, NOT FOUR: `examined` counts what was examined, and the primary is skipped before the count.
    // It said four until worker-judge mutated it to `entries.length + 99` and got 0 red — the count was
    // held as PRINTED and never as COUNTING.
    assert.equal(examined, 3,
      `expected the three linked worktrees and NOT the primary, examined ${examined}`);
    const named = stranded.map((w) => w.branch).sort();
    assert.deepEqual(named, ["agent/live", "dispatcher/retired"],
      "the untracked-only worktree must NOT appear — it is the 31-of-58 noise this report exists to drop");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#933 MUTATION TARGET: dropping the tracked-file filter floods the noise back in", () => {
  // The row's own mutation, expressed as a test rather than left to a reviewer: the same fixture read with
  // a bare `git status --porcelain` predicate lists the untracked-only worktree too. If this ever fails,
  // the narrowing has been removed and the report has become the 38-entry listing nobody reads.
  const root = buildStrandedFixture();
  try {
    const tracked = strandedWork(root).stranded.map((w) => w.branch).sort();
    const anyUncommitted = ["agent/live", "agent/noise", "dispatcher/retired"];
    assert.deepEqual(tracked, ["agent/live", "dispatcher/retired"]);
    assert.notDeepEqual(tracked, anyUncommitted,
      "if these ever match, the predicate is counting untracked files and the narrowing is gone");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#933: each entry carries the branch, the line counts, the commits ahead, and the retired mark", () => {
  const root = buildStrandedFixture();
  try {
    const byBranch = new Map(strandedWork(root).stranded.map((w) => [w.branch, w]));

    const live = byBranch.get("agent/live");
    assert.ok(live);
    assert.equal(live.files, 1);
    assert.equal(live.insertions, 1, "the line counts, so a reader can tell 1 line from 45");
    assert.equal(live.commitsAhead, 0,
      "a branch at main's tip: the uncommitted change is ALL the work there is");
    assert.equal(live.retiredSession, false, "`agent/` is the live prefix and must not be marked");

    const retired = byBranch.get("dispatcher/retired");
    assert.ok(retired);
    assert.equal(retired.commitsAhead, 1,
      "COMMITS AHEAD, not merely `merged` — a branch cut from main minutes ago reads `merged` identically "
      + "to one whose commits landed a week ago, and calling the first a leftover tells a reader to "
      + "discard a live working directory. The count separates them and the boolean cannot");
    assert.equal(retired.retiredSession, true, "`dispatcher/` no longer runs — nobody to ask");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#933: the report states its EXAMINED COUNT, so a zero means something", () => {
  // A sweep that walked nothing reports no stranded work, which is the cleanest possible output and
  // indistinguishable from a clean host. The count is what makes the zero a measurement.
  const root = buildStrandedFixture();
  try {
    const text = formatStranded(strandedWork(root));
    assert.match(text, /^\d+ worktree\(s\) examined, \d+ carry uncommitted TRACKED changes/);
    assert.match(text, /NOTHING HAS BEEN REMOVED/, "and says so, because the prune beside it does remove");
    assert.match(text, /BRANCH PREFIX NAMES A RETIRED SESSION/, "the case with nobody to ask is called out");
    const empty = formatStranded({ examined: 12, stranded: [], unreadable: [] });
    assert.match(empty, /12 worktree\(s\) examined, 0 carry/,
      "and a clean host still reports what it walked — otherwise 'nothing found' and 'nothing looked at' "
      + "are the same line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#933: the report NEVER removes — asserted on the injected runner's argv", () => {
  // `pruneWorktrees` beside it does remove, so this cannot rest on the report having no reason to.
  const root = buildStrandedFixture();
  const spawned: string[][] = [];
  try {
    const run = (cmd: string, args: string[], opts?: { cwd?: string }) => {
      spawned.push([cmd, ...args]);
      return execFileSync(cmd, args, { ...opts, env: sandboxGitEnv(), encoding: "utf8" });
    };
    strandedWork(root, { run });
    assert.ok(spawned.length > 0, "this must not pass by having spawned nothing at all");
    const destructive = spawned.filter(([, ...a]) =>
      a.includes("remove") || a.includes("prune") || a.includes("clean") || a.includes("checkout"));
    assert.deepEqual(destructive, [],
      "a read-only report may run `worktree list`, `status`, `diff` and `rev-list` and nothing else");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#933: a worktree that CANNOT BE READ is counted and named, never dropped as clean", () => {
  // Found by mutation: making `trackedChanges` return 0 instead of "unknown" on an unreadable worktree was
  // **0 red**, and the comment beside it claimed the distinction mattered. A comment asserting a property
  // with nothing holding it is the shape this whole file is about. Dropping such a worktree silently makes
  // the head line ("N examined, M carry changes") true of a population quietly smaller than N.
  const root = buildStrandedFixture();
  const gone = join(root, "wt-does-not-exist");
  try {
    assert.equal(trackedChanges(gone), "unknown",
      "a path that is not a readable worktree is `unknown`, never `{ files: 0 }`");
    const read = strandedWork(root, {
      // one entry the real `git worktree list` cannot produce, to drive the branch without deleting a
      // worktree out from under git and leaving the fixture in a state the teardown cannot clean
      run: (cmd: string, args: string[], opts?: { cwd?: string }) => (args[0] === "worktree"
        ? `${execFileSync(cmd, args, { ...opts, env: sandboxGitEnv(), encoding: "utf8" })}\nworktree ${gone}\n`
        : execFileSync(cmd, args, { ...opts, env: sandboxGitEnv(), encoding: "utf8" })),
    });
    assert.deepEqual(read.unreadable, [gone], "named, so somebody can go and look at it");
    assert.ok(!read.stranded.some((w) => w.path === gone), "and not counted among the stranded");
    assert.match(formatStranded(read), /COULD NOT BE READ/,
      "and the head line says so, because 'M carry changes' out of N is false if one of the N was skipped");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#1058: a merge status nobody could read is NOT rendered as 'not an ancestor'", () => {
  // worker-judge's blocker on #1058: `mergeStatus(...) === "merged"` made `"unknown" === "merged"` false,
  // so "could not ask" and "asked, the answer is no" became one boolean — and the line then read
  // "adds no commit origin/main lacks (and is not an ancestor of it) -- the uncommitted change is ALL the
  // work there is", which is a positive claim built from an unanswerable question. Three lines from
  // `trackedChanges`, where the same distinction was already right.
  const root = buildStrandedFixture();
  try {
    const run = (cmd: string, args: string[], opts?: { cwd?: string }) => {
      // the one question that cannot be answered; everything else is the real git
      if (args[0] === "merge-base") { const e = new Error("cannot ask"); (e as { status?: number }).status = 128; throw e; }
      return execFileSync(cmd, args, { ...opts, env: sandboxGitEnv(), encoding: "utf8" });
    };
    const read = strandedWork(root, { run });
    assert.ok(read.stranded.length > 0, "this must not pass by having found nothing to report on");
    for (const w of read.stranded.filter((x) => x.branch !== null)) {
      assert.equal(w.onMain, "unknown",
        "an unreadable merge status is `unknown`, never `false` — `=== \"merged\"` is the collapse");
    }
    assert.doesNotMatch(formatStranded(read), /is not an ancestor of it/,
      "and the line must not make a positive claim about ancestry it could not establish");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- #1373: A WORKTREE'S GITIGNORED `runs/` RECORDS, AND A COMPARISON THAT MUST NOT PASS ON EMPTY READINGS. ---
// `runs/` is ignored, so every tree below is merged AND clean by git's own reading -- the verdict that removed
// it before #1373. What refuses now is only the records check, which is what each test isolates.

const RECORDS = ["runs/board-snapshots/a.json", "runs/board-snapshots/b.json", "runs/c.json"];

function plantRecord(checkout: string, file: string) {
  mkdirSync(dirname(join(checkout, file)), { recursive: true });
  writeFileSync(join(checkout, file), `{"record":"${file}"}\n`);
}

/** A primary that ignores `/runs`, ONE merged and clean linked worktree, and `files` planted in its `runs/`. */
function buildRecordsFixture(files: string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a11y-prune-records-")));
  git(root, "init", "--quiet", "-b", "main");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "Fixture");
  writeFileSync(join(root, ".gitignore"), "/runs\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-q", "-m", "base");
  git(root, "update-ref", "refs/remotes/origin/main", git(root, "rev-parse", "HEAD").trim());
  const worktree = join(root, "wt-records");
  git(root, "worktree", "add", "--quiet", "-b", "agent/records", worktree);
  for (const file of files) plantRecord(worktree, file);
  return { root, worktree };
}

test("#1373: three runs/ records ABSENT from the primary refuse the removal, naming 3 -- and all three survive", () => {
  const { root, worktree } = buildRecordsFixture(RECORDS);
  try {
    const report = pruneWorktrees(root, { now: LONG_AFTER() });
    assert.deepEqual(report.removed, [], "a worktree holding the only copies of three records must not be removed");
    assert.deepEqual(report.records.map((r) => r.path), [worktree]);
    assert.match(report.records[0].reason, /holds 3 of 3 runs\/ file\(s\)/);
    for (const file of RECORDS) assert.ok(existsSync(join(worktree, file)), `${file} must still be on disk`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#1373: the same three records PRESENT in the primary with matching sha256 -- removed", () => {
  const { root, worktree } = buildRecordsFixture(RECORDS);
  try {
    for (const file of RECORDS) plantRecord(root, file);
    const report = pruneWorktrees(root, { now: LONG_AFTER() });
    assert.deepEqual(report.records, []);
    assert.deepEqual(report.removed.map((r) => r.path), [worktree]);
    assert.equal(existsSync(worktree), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#1373 THE INCIDENT'S SHAPE: an EMPTY reading on both sides never matches -- refused, never removed", () => {
  // Present in the primary AND identical, so nothing but the reading can refuse: the operator's chain whose
  // two failed `sha256sum` reads compared "" = "" and authorised the delete.
  const { root, worktree } = buildRecordsFixture(RECORDS);
  try {
    for (const file of RECORDS) plantRecord(root, file);
    const report = pruneWorktrees(root, { now: LONG_AFTER(), hash: () => "" });
    assert.deepEqual(report.removed, [], "two EMPTY readings compared equal must never authorise a removal");
    assert.deepEqual(report.records.map((r) => r.path), [worktree]);
    assert.match(report.records[0].reason, /holds 3 of 3 runs\/ file\(s\) not present, with a matching NON-EMPTY sha256/);
    for (const file of RECORDS) assert.ok(existsSync(join(worktree, file)), `${file} must still be on disk`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#1373 CONTROL: a merged, clean worktree with NO runs/ records is removed as it always was", () => {
  const { root, worktree } = buildRecordsFixture([]);
  try {
    const report = pruneWorktrees(root, { now: LONG_AFTER() });
    assert.deepEqual(report.records, []);
    assert.deepEqual(report.removed.map((r) => r.path), [worktree]);
    assert.equal(existsSync(worktree), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#1373: a non-empty runs/ that lists ZERO files is an EMPTY reading too -- refused, never 'nothing to lose'", () => {
  const { root, worktree } = buildRecordsFixture(RECORDS);
  try {
    const result = unverifiedRecords(worktree, root, { list: () => [] });
    assert.equal(result.refused, true);
    assert.match((result as { reason: string }).reason, /is not empty but ZERO files were listed/);
    assert.deepEqual(unverifiedRecords(worktree, null), { refused: true,
      reason: `${worktree} holds 3 runs/ file(s) and no primary checkout could be found to verify them against -- `
        + "refusing to remove it" }, "no primary to compare against is a refusal, not a pass");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#1373: the report prints the refusal and its reason under its own heading, never under `removed`", () => {
  // Not through argv: the CLI takes no `now`, and its own `git status` rewrites the index `recentGitActivity`
  // dates a tree by (measured on #1373), so a fixture built moments ago always reads ACTIVE there. `main()`
  // prints exactly `formatReport(report, dryRun)`.
  const { root, worktree } = buildRecordsFixture(RECORDS);
  try {
    const text = formatReport(pruneWorktrees(root, { now: LONG_AFTER() }));
    assert.match(text, /^removed 0 worktree\(s\):\nrefused 1 worktree\(s\) holding runs\/ records not verified in the primary checkout/);
    assert.ok(text.includes(`  ${worktree}  (agent/records): ${worktree} holds 3 of 3 runs/ file(s)`));
    assert.ok(existsSync(join(worktree, RECORDS[0])));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#1373: two of three records verified is NOT enough -- the verified count must equal the listed count, naming 1 of 3", () => {
  const { root, worktree } = buildRecordsFixture(RECORDS);
  try {
    for (const file of RECORDS.slice(0, 2)) plantRecord(root, file);
    const report = pruneWorktrees(root, { now: LONG_AFTER() });
    assert.deepEqual(report.removed, []);
    assert.match(report.records[0].reason, /holds 1 of 3 runs\/ file\(s\)[^:]*: runs\/c\.json$/);
    assert.ok(existsSync(join(worktree, "runs/c.json")), "the one unverified record must still be on disk");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- #2020: A TREE A SESSION STILL HOLDS, WHICH MERGED + CLEAN + INACTIVE CANNOT SEE. ---
//
// Every tree below is merged, clean and far outside the activity window -- the verdict that removed it
// before #2020, and the verdict the live host reached on 2026-09-22 for two RUNNING sessions' role trees.
// What refuses now is only the held check, so each test isolates the one fact it adds: whether the tree
// has DELIVERED a commit of its own, or was claimed and has not.
//
// The two shapes are the row's own, built from real git rather than described:
//   - HELD (`wt-1908`'s shape): stamped, branched from origin/main and never committed, its only untracked
//     entry one the primary ignores, no git activity for hours.
//   - DELIVERED (`wt-1948`'s shape): a branch whose own commits reached origin/main through a merge, so
//     its tip is a SECOND PARENT and never a point on main's first-parent line.
// Both halves are asserted in every test that asserts either: an emptiness assertion about `held` is only
// worth reading beside a tree that is still removed.

/**
 * A primary ignoring what the real one ignores, with three linked worktrees that are all merged, clean
 * and inactive, and differ only in what #2020 asks about:
 *   - `delivered` -- STAMPED, its own commit merged into origin/main by a real merge commit: REMOVE
 *   - `held`      -- STAMPED, branched at origin/main's tip and never committed: REFUSED
 *   - `unstamped` -- the held shape with NO stamp: REMOVE, which is the named gap rather than an oversight
 */
function buildHeldFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a11y-prune-held-")));
  git(root, "init", "--quiet", "-b", "main");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "Fixture");
  // The real `.gitignore`'s own entries, for the reason each is there: `.a11y-owner` (#1128) must be
  // invisible to `git status` or every stamped tree reads DIRTY and never reaches this gate at all, and
  // `node_modules` is the one untracked entry the row measured on all 82 trees.
  writeFileSync(join(root, ".gitignore"), "node_modules\n.a11y-owner\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-q", "-m", "base");
  git(root, "update-ref", "refs/remotes/origin/main", git(root, "rev-parse", "HEAD").trim());

  // DELIVERED: commit on the branch, then merge it with --no-ff, exactly as every PR here lands. The
  // branch tip becomes the merge's SECOND parent -- reachable from origin/main, never on its own line.
  const delivered = join(root, "wt-delivered");
  git(root, "worktree", "add", "--quiet", "-b", "agent/delivered-1948", delivered);
  writeFileSync(join(delivered, "shipped.txt"), "the work\n");
  git(delivered, "add", "shipped.txt");
  git(delivered, "commit", "-q", "-m", "work that lands");
  git(root, "merge", "--no-ff", "--quiet", "-m", "Merge pull request #1948", "agent/delivered-1948");
  const mainTip = git(root, "rev-parse", "HEAD").trim();
  git(root, "update-ref", "refs/remotes/origin/main", mainTip);
  assert.notEqual(git(delivered, "rev-parse", "HEAD").trim(), mainTip,
    "the fixture is broken if the branch fast-forwarded: a delivered tip must be a second parent, or this "
    + "fixture proves nothing about the line it is meant to be off");
  stampWorktree(delivered, "worker-capture");

  // HELD: branched at the tip main already had. No commit of its own, so `origin/main..HEAD` is 0 -- the
  // same 0 the delivered tree reads, which is the whole reason that count cannot be the question.
  const held = join(root, "wt-held");
  git(root, "worktree", "add", "--quiet", "-b", "agent/held-1908", held, mainTip);
  mkdirSync(join(held, "node_modules"), { recursive: true });
  writeFileSync(join(held, "node_modules", "installed.txt"), "ignored by the primary\n");
  stampWorktree(held, "worker-capture");

  const unstamped = join(root, "wt-unstamped");
  git(root, "worktree", "add", "--quiet", "-b", "agent/unstamped-1908", unstamped, mainTip);
  return { root, delivered, held, unstamped, mainTip };
}

test("#2020: a STAMPED tree with no commit of its own is refused -- while a STAMPED delivered tree is still removed", () => {
  const { root, delivered, held } = buildHeldFixture();
  try {
    const report = pruneWorktrees(root, { now: LONG_AFTER() });
    assert.deepEqual(report.held.map((r) => r.path), [held],
      "the claimed tree must be the only one refused: it is merged, clean and hours idle, and every one of "
      + "those facts is also true of the delivered tree beside it");
    assert.ok(existsSync(held), "and it must still be on disk");
    // THE OTHER HALF, and the reason the assertion above is worth reading: without it, "refuse everything"
    // passes. #2020's own Done-when names this as the failure the fix must not become.
    assert.ok(report.removed.some((r) => r.path === delivered),
      "a branch whose own commits are merged into origin/main holds nothing anyone is waiting on -- it must "
      + "still be removed, or this is `stop pruning` wearing a better name");
    assert.equal(existsSync(delivered), false);
    assert.match(report.held[0].reason, /is stamped worker-capture and its HEAD is a commit on origin\/main's own first-parent line/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#2020: `origin/main..HEAD` reads 0 on BOTH trees -- the count cannot tell them apart, first-parent membership can", () => {
  const { root, delivered, held, mainTip } = buildHeldFixture();
  try {
    for (const tree of [delivered, held]) {
      assert.equal(git(tree, "rev-list", "--count", "origin/main..HEAD").trim(), "0",
        "the measurement this fix rests on: 'no commits ahead' is true of a finished branch AND of one that "
        + "never committed, so a remedy written on that count would refuse or remove both together");
    }
    const mainLine = mainLineCommits(root);
    assert.equal(deliveredOwnCommit(held, mainLine), false);
    assert.equal(deliveredOwnCommit(delivered, mainLine), true);
    assert.ok(mainLine?.has(mainTip), "the merge commit is on main's own line; the branch tip it merged is not");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#2020: an UNSTAMPED tree of the same shape is still removed -- the named gap, pinned rather than discovered", () => {
  // `worktree-owner.ts` refuses to invent a stamp for a tree whose owner nobody recorded, and inventing
  // one here would name whoever ran the prune. Measured on the host 2026-09-22: 6 of 97 merged linked
  // worktrees are unstamped, one of them a live session's role tree. The remedy is `worktree:stamp`, and
  // this test exists so the exposure is a decision on the record rather than a surprise.
  const { root, held, unstamped } = buildHeldFixture();
  try {
    const report = pruneWorktrees(root, { now: LONG_AFTER() });
    assert.ok(report.removed.some((r) => r.path === unstamped));
    assert.equal(existsSync(unstamped), false);
    assert.deepEqual(report.held.map((r) => r.path), [held], "and the stamped tree beside it is still refused");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#2020: a stamped tree whose delivery could not be determined is REFUSED, never guessed finished", () => {
  const { root, held } = buildHeldFixture();
  try {
    assert.equal(deliveredOwnCommit(held, null), "unknown", "no readable main line is not 'it delivered'");
    const refusal = heldByOwner(held, null);
    assert.equal(refusal.refused, true);
    assert.match((refusal as { reason: string }).reason, /could not be determined/);
    // The same collapse one step out: a `git rev-parse` that cannot answer.
    assert.equal(deliveredOwnCommit(held, new Set(["deadbeef"]), { run: () => { throw new Error("no"); } }), "unknown");
    assert.equal(mainLineCommits(realpathSync(tmpDir("a11y-no-main-"))), null,
      "a repository with no origin/main answers null -- never an empty Set, which would read as 'nothing is "
      + "on main's line' and make every stamped tree look delivered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#2020: the report prints the refusal and its owner under its own heading, never under `removed`", () => {
  const { root, held, delivered } = buildHeldFixture();
  try {
    const text = formatReport(pruneWorktrees(root, { now: LONG_AFTER() }));
    assert.match(text, /refused 1 HELD worktree\(s\) \(#2020\) -- stamped by a session and carrying no commit of their own/);
    assert.ok(text.includes(`  ${held}  (agent/held-1908): ${held} is stamped worker-capture`));
    assert.ok(text.includes(`  ${delivered}  (agent/delivered-1948)`), "and the delivered tree is named under `removed`");
    assert.doesNotMatch(text.split("refused 1 HELD")[0], new RegExp(held.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "the held tree must not appear in the removed list above the heading");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- #2149: A STANDING TREE IS HELD ON WHAT IT IS, NOT ON WHERE ITS HEAD SITS. -------------------
// `wt-2121` (stamped) read `{"refused":false}` eleven minutes after its own work merged and went from
// DIRTY to WOULD REMOVE. Standing trees (role and policy trees) are DETACHED and are reused across many rows.

/** `buildHeldFixture`, plus a STAMPED DETACHED tree whose own commit has merged -- the shape #2149 measured. */
function buildStandingFixture() {
  const fixture = buildHeldFixture();
  const { root } = fixture;
  const standing = join(root, "wt-standing");
  git(root, "worktree", "add", "--quiet", "--detach", standing, fixture.mainTip);
  writeFileSync(join(standing, "policy.txt"), "work done in a standing tree\n");
  git(standing, "add", "policy.txt");
  git(standing, "commit", "-q", "-m", "work that lands from a detached tree");
  const tip = git(standing, "rev-parse", "HEAD").trim();
  git(root, "merge", "--no-ff", "--quiet", "-m", "Merge pull request #2149", tip);
  git(root, "update-ref", "refs/remotes/origin/main", git(root, "rev-parse", "HEAD").trim());
  stampWorktree(standing, "ceo");
  return { ...fixture, standing, standingTip: tip };
}

test("#2149: a stamped DETACHED tree whose own work has merged is REFUSED -- while a delivered ROW tree and an unstamped tree are still removed", () => {
  const { root, standing, delivered, unstamped, standingTip } = buildStandingFixture();
  try {
    const mainLine = mainLineCommits(root);
    // The premise, read rather than assumed: this tree's HEAD is OFF main's line, so the position test
    // alone answers "delivered" -- which is exactly why it was removed before this fix.
    assert.equal(deliveredOwnCommit(standing, mainLine), true);
    assert.equal(mainLine?.has(standingTip), false);
    const report = pruneWorktrees(root, { now: LONG_AFTER() });
    assert.ok(report.held.some((r) => r.path === standing), "the standing tree must be refused after its work merged");
    assert.ok(existsSync(standing), "and still on disk");
    assert.match(report.held.find((r) => r.path === standing)?.reason ?? "", /stamped ceo and its HEAD is detached/);
    // THE CONTROLS: "refuse everything" passes the assertion above alone.
    assert.ok(report.removed.some((r) => r.path === delivered),
      "a stamped tree ON ITS OWN BRANCH whose work merged is a disposable row tree and must still be removed");
    assert.ok(report.removed.some((r) => r.path === unstamped), "and a tree with no claim on it is still removed");
    assert.equal(existsSync(delivered), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#2149: the same standing tree is refused straight from `heldByOwner`, with a delivered row tree as the control in one call", () => {
  const { root, standing, delivered } = buildStandingFixture();
  try {
    const mainLine = mainLineCommits(root);
    assert.equal(heldByOwner(standing, mainLine).refused, true);
    assert.deepEqual(heldByOwner(delivered, mainLine), { refused: false },
      "the gate answers at all: a branch-attached delivered tree passes through it");
    assert.equal(hasOwnBranch(standing), false);
    assert.equal(hasOwnBranch(delivered), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#2149: a stamped tree whose branch state cannot be read is REFUSED, never read as a disposable row tree", () => {
  const { root, delivered } = buildStandingFixture();
  try {
    const failing = () => { throw new Error("no"); };
    assert.equal(hasOwnBranch(delivered, { run: failing }), "unknown");
    assert.equal(hasOwnBranch(delivered, { run: () => "\n" }), "unknown");
    const refusal = heldByOwner(delivered, mainLineCommits(root), { run: failing });
    assert.equal(refusal.refused, true);
    assert.match((refusal as { reason: string }).reason, /whether it has a branch of its own could not be determined/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- #2012: A WORKTREE READS THE `.gitignore` AT ITS OWN CHECKED-OUT COMMIT. ---------------------
// The first scheduled firing of `a11ign-worktree-prune.service` (2026-09-22) examined 128 worktrees and
// refused 84 of them for a `git status --porcelain` reading exactly `?? node_modules` -- because
// #1983/#1994 widened the rule from `node_modules/` (a directory) to `node_modules` (also a symlink)
// AFTER those trees were cut, and the fix cannot reach a pinned commit. The refusal was correct for that
// tree and wrong for the question; the authority moves to the primary checkout.
//
// EVERY TEST BELOW PINS BOTH DIRECTIONS, because the fix has an obvious wrong shape --
// `--untracked-files=no` -- that would pass the first half alone while hiding #220's unrecoverable case:
// a brand-new file nobody added.

function buildPinnedIgnoreFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a11y-prune-pinned-ignore-")));
  git(root, "init", "--quiet", "-b", "main");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "Fixture");
  writeFileSync(join(root, "base.txt"), "base\n");
  // THE OLD RULE: a directory only. Every worktree below is cut at this commit and reads this line.
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  git(root, "add", "base.txt", ".gitignore");
  git(root, "commit", "-q", "-m", "base, with the anchored ignore rule");
  const baseSha = git(root, "rev-parse", "HEAD").trim();
  git(root, "update-ref", "refs/remotes/origin/main", baseSha);

  const pinned = join(root, "wt-pinned");        // only untracked entry: a `node_modules` SYMLINK
  const genuine = join(root, "wt-genuine");      // only untracked entry: a file nothing ignores
  const alsoModified = join(root, "wt-modified"); // the symlink AND a modified tracked file
  for (const [path, branch] of [[pinned, "agent/pinned"], [genuine, "agent/genuine"],
    [alsoModified, "agent/modified"]] as const) {
    git(root, "worktree", "add", "--quiet", "-b", branch, path, baseSha);
  }

  // The symlink target carries content, so "git clean removed the LINK and not what it points at" is a
  // measurement rather than a hope: on the real host these point into the PRIMARY's `node_modules`.
  const linkTarget = join(root, "shared-node-modules");
  mkdirSync(join(linkTarget, "some-package"), { recursive: true });
  writeFileSync(join(linkTarget, "some-package", "index.js"), "module.exports = 1;\n");
  for (const path of [pinned, alsoModified]) {
    execFileSync("ln", ["-s", linkTarget, join(path, "node_modules")], { encoding: "utf8" });
  }
  writeFileSync(join(genuine, "notes.txt"), "work nobody has added yet\n");
  writeFileSync(join(alsoModified, "base.txt"), "edited, and tracked\n");

  // ONLY NOW does `main` get the widened rule -- exactly the order that produced the 84.
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  git(root, "commit", "-q", "-am", "#1983/#1994: unanchored, so a symlink matches too");
  git(root, "update-ref", "refs/remotes/origin/main", git(root, "rev-parse", "HEAD").trim());
  return { root, pinned, genuine, alsoModified, linkTarget };
}

test("#2012 REPRODUCE: the pinned tree's OWN `.gitignore` lacks the rule, and that is why it read dirty", () => {
  const { root, pinned } = buildPinnedIgnoreFixture();
  try {
    assert.equal(git(pinned, "show", "HEAD:.gitignore"), "node_modules/\n",
      "the row's own check: `git show HEAD:.gitignore | grep -qx node_modules` FAILS in all 84");
    assert.equal(git(root, "show", "HEAD:.gitignore"), "node_modules\n", "while today's main has it");
    assert.equal(git(pinned, "status", "--porcelain"), "?? node_modules\n",
      "the exact string the first scheduled firing read in 84 worktrees");
    assert.equal(isWorkingTreeClean(pinned), false,
      "and with no ignore authority the answer is unchanged -- so nothing below can pass by the status "
      + "read having quietly changed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#2012: the PRIMARY's rules decide -- an ignorable-only tree is clean, and names what must be cleared", () => {
  const { root, pinned } = buildPinnedIgnoreFixture();
  try {
    const read = cleanliness(pinned, { ignoreAuthority: root });
    assert.equal(read.clean, true, "today's main ignores `node_modules`, so it is not work");
    assert.deepEqual(read.ignorable, ["node_modules"],
      "and the path is carried out, because `git worktree remove` runs its own `git status` and would "
      + "otherwise refuse the very tree this run just decided to take");
    assert.equal(classify({ merge: "merged", workingTreeClean: read.clean, contentMerged: false, recentlyActive: false }),
      "remove", "REMOVE rather than DIRTY -- the row's Done-when, at the verdict itself");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#2012 THE OTHER DIRECTION: an untracked file nothing ignores is still work, and a tracked edit still refuses", () => {
  // Without this half the fix is `--untracked-files=no` wearing a better name (the row's own words), and
  // #220's unrecoverable case -- a brand-new file nobody added -- would be deleted on an hourly timer.
  const { root, genuine, alsoModified } = buildPinnedIgnoreFixture();
  try {
    const untracked = cleanliness(genuine, { ignoreAuthority: root });
    assert.equal(untracked.clean, false, "`?? notes.txt` matches no rule in today's main: still DIRTY");
    assert.deepEqual(untracked.ignorable, [], "and nothing is offered up for deletion");
    assert.equal(ignoredByAuthority(root, "notes.txt"), false,
      "check-ignore's exit 1 is a real answer -- `no rule matched` -- not a failure to ask");

    const mixed = cleanliness(alsoModified, { ignoreAuthority: root });
    assert.equal(mixed.clean, false,
      "a MODIFIED TRACKED FILE refuses whatever else is in the tree -- the walk ends before the authority "
      + "is asked at all, so an ignorable path beside it can never launder it");
    assert.deepEqual(mixed.ignorable, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#2012: an ignore question that could NOT be asked is `unknown`, never `clean` and never `dirty`", () => {
  // `mergeStatus`'s tristate, one predicate further in. Reading "anything non-zero" as `not ignored` is
  // safe HERE -- it refuses -- and is still the collapse this file exists to stop: `inconclusive` says
  // nobody could tell, and `dirty` claims a measurement that was never made.
  const { root, pinned } = buildPinnedIgnoreFixture();
  try {
    assert.equal(ignoredByAuthority(join(root, "no-such-checkout"), "node_modules"), "unknown",
      "an authority that is not a repository cannot answer; 128 is not 1");
    assert.equal(ignoredByAuthority(root, ["..", "..", "..", "etc", "passwd"].join("/")), "unknown",
      "and neither is a path outside it");
    const unaskable = cleanliness(pinned, {
      ignoreAuthority: root,
      run: (cmd: string, args: string[], opts?: { cwd?: string }) => {
        if (args[0] === "check-ignore") { const e = new Error("cannot ask"); (e as { status?: number }).status = 128; throw e; }
        return execFileSync(cmd, args, { ...opts, env: sandboxGitEnv(), encoding: "utf8" });
      },
    });
    assert.equal(unaskable.clean, "unknown");
    assert.deepEqual(unaskable.ignorable, [], "and an unanswered question hands nothing to the deleter");
    assert.equal(classify({ merge: "merged", workingTreeClean: unaskable.clean, contentMerged: false, recentlyActive: false }),
      "inconclusive");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#2012 END TO END: the prune removes the pinned tree, refuses the other two, and never follows the symlink", () => {
  const { root, pinned, genuine, alsoModified, linkTarget } = buildPinnedIgnoreFixture();
  try {
    const report = pruneWorktrees(root, { now: LONG_AFTER() });
    assert.deepEqual(report.removed.map((r) => r.path), [pinned],
      "REMOVED, not merely reclassified -- `git worktree remove` refuses `?? node_modules` on its own "
      + "reading, so a verdict the removal cannot act on would be no fix at all");
    assert.equal(existsSync(pinned), false, "and the directory is gone");
    assert.deepEqual(report.dirty.map((r) => r.path).sort(), [genuine, alsoModified].sort(),
      "the two that carry real work are still refused, by the same run");
    assert.equal(existsSync(genuine), true);
    assert.equal(existsSync(alsoModified), true);

    // THE CATASTROPHIC ARM. On the host these symlinks point INTO the primary's `node_modules`; a
    // recursive delete that followed the link would empty it on the hourly timer.
    assert.equal(existsSync(join(linkTarget, "some-package", "index.js")), true,
      "`git clean` removes the LINK and not what it points at");

    assert.match(formatReport(report), /\[cleared, ignored by the primary checkout: node_modules\]/,
      "and the prune says what it deleted that git was not tracking -- these paths go by this tool's own "
      + "hand rather than with the worktree, and a delete nobody can see in the log is this file's subject");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#2012: a tree git already reads as clean clears NOTHING -- the ordinary path is untouched", () => {
  // The positive control for `ignorable` being empty everywhere else: `assert.deepEqual(ignorable, [])`
  // above passes on a population of one, and this is the population that must stay at zero.
  const { root, merged, standing } = buildFixtureRepo();
  try {
    assert.deepEqual(cleanliness(merged, { ignoreAuthority: root }), { clean: true, ignorable: [] },
      "nothing untracked at all, so the authority is never consulted");
    const report = pruneWorktrees(root, { now: LONG_AFTER() });
    assert.deepEqual(report.removed.map((r) => r.cleared), [[], []],
      "both removals clear nothing");
    assert.deepEqual(report.removed.map((r) => r.path).sort(), [merged, standing].sort());
    assert.doesNotMatch(formatReport(report), /cleared, ignored by the primary checkout/,
      "and the report says nothing about clearing, because nothing was cleared");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#2012: a tree whose ignorable paths could NOT be cleared is DIRTY, never removed and never forced", () => {
  // The refusal this change replaces, reached by measurement instead of by a stale rule. It matters
  // because the clearing happens by this tool's own hand: if it fails and the verdict stands, the run
  // would either abort mid-walk or reach for `--force`, and `--force` deletes whatever appeared in the
  // window between the status read and the removal. Found by mutation -- `report.dirty.push` swapped for
  // `report.removed.push` here was 0 red across the other 56 tests.
  const { root, pinned, genuine, alsoModified } = buildPinnedIgnoreFixture();
  try {
    const report = pruneWorktrees(root, {
      now: LONG_AFTER(),
      run: (cmd: string, args: string[], opts?: { cwd?: string }) => {
        if (args[0] === "clean") { const e = new Error("cannot clear"); (e as { status?: number }).status = 128; throw e; }
        return execFileSync(cmd, args, { ...opts, env: sandboxGitEnv(), encoding: "utf8" });
      },
    });
    assert.deepEqual(report.removed, [], "nothing is removed when the tree could not be made removable");
    assert.deepEqual(report.dirty.map((r) => r.path).sort(), [pinned, genuine, alsoModified].sort(),
      "and the pinned tree joins the two that carry real work -- exactly where it sat before this change");
    assert.equal(existsSync(pinned), true);
    assert.equal(existsSync(join(pinned, "node_modules")), true, "and its untracked path is still there");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- #2782: WHO DELETED IT, AND WAS ITS ROW STILL CLAIMED? `wt-2623` was deleted under a live claim twice and the prune's own
// journal could neither convict nor clear it. The fixture is #2020's: `wt-delivered` (row 1948) removes, and `wt-unstamped`
// (row 1908) is the tree whose `.a11y-owner` a claim's re-creation lost -- the exact shape #2020's check cannot see. ---

/** A `gh issue view` answering from a table: rows 1908 and 1948 by default carry whatever the test says. */
const ghRows = (rows: Record<number, string[]>) => (args: string[]) => {
  const labels = rows[Number(args[2])];
  if (labels === undefined) throw new Error("gh: row not found");
  return JSON.stringify({ state: "OPEN", labels: labels.map((name) => ({ name })) });
};
const logLines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("#2782 DONE-WHEN 3: an UNSTAMPED tree whose row still carries a session label is REFUSED, and the delivered tree beside it is still removed", () => {
  const { root, delivered, unstamped } = buildHeldFixture();
  const log = join(root, "..", `removal-${Date.now()}.log`);
  try {
    const gh = ghRows({ 1908: ["in-progress", "session:worker-1908"], 1948: [] });
    const report = pruneWorktrees(root, { now: LONG_AFTER(), claim: (tree) => claimRefusal(tree, { gh }),
      record: (line) => recordRemoval(line, { env: { [REMOVAL_LOG_ENV]: log } }) });
    assert.ok(report.held.some((r) => r.path === unstamped && /still carries session:worker-1908/.test(r.reason)),
      "the row's claim is the source of truth: #2020's owner-file check answered `unstamped`, which it reads as nobody's");
    assert.ok(existsSync(unstamped), "and the tree is still on disk");
    // THE OTHER HALF: without it, "refuse everything" passes.
    assert.ok(report.removed.some((r) => r.path === delivered), "an unclaimed row's delivered tree must still be removed");
    assert.equal(logLines(log).some((l) => l.path === unstamped), false, "a refused tree is not a removal, so it writes no removal line");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(log, { force: true }); }
});

test("#2782: a row the prune could not READ refuses the tree -- it never reads as unclaimed", () => {
  const { root, delivered } = buildHeldFixture();
  try {
    const gh = ghRows({ 1908: [] });
    const report = pruneWorktrees(root, { now: LONG_AFTER(), claim: (tree) => claimRefusal(tree, { gh }) });
    assert.ok(report.held.some((r) => r.path === delivered && /claim could not be read/.test(r.reason)));
    assert.ok(existsSync(delivered));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#2782 DONE-WHEN 1: a removal writes `removing` BEFORE the delete and `removed` after, naming the tree, branch, caller and owner file", () => {
  const { root, delivered } = buildHeldFixture();
  const log = join(root, "..", `removal-${Date.now()}-b.log`);
  try {
    const seenBeforeDelete: string[] = [];
    pruneWorktrees(root, { now: LONG_AFTER(),
      record: (line) => recordRemoval(line, { env: { [REMOVAL_LOG_ENV]: log } }),
      remove: (path, { run }) => { seenBeforeDelete.push(...logLines(log).map((l) => l.event)); run("git", ["worktree", "remove", path], { cwd: root }); } });
    const mine = logLines(log).filter((l) => l.path === delivered);
    assert.deepEqual(mine.map((l) => l.event), ["removing", "removed"]);
    assert.deepEqual(seenBeforeDelete.filter((e) => e === "removing").length > 0, true, "the line exists when the delete begins, so a crash mid-delete is still a line");
    assert.equal(mine[0].owner, "worker-capture", "the owner file is read at the moment of removal, while it still exists");
    assert.equal(mine[0].branch, "agent/delivered-1948");
    assert.equal(mine[0].caller, "prune-worktrees.ts");
    assert.match(mine[0].reason, /merged, clean, inactive and not held/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(log, { force: true }); }
});

test("#2782: a log that cannot be written REFUSES the removal -- a delete nobody can see is the defect", () => {
  const { root, delivered } = buildHeldFixture();
  try {
    const report = pruneWorktrees(root, { now: LONG_AFTER(), record: () => { throw new Error("ENOSPC"); } });
    assert.ok(existsSync(delivered), "nothing was deleted");
    assert.ok(report.held.some((r) => r.path === delivered && /removal log could not be written/.test(r.reason)));
    assert.equal(report.removed.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#2782: the DRY RUN reads the same claim and writes no removal line", () => {
  const { root, unstamped } = buildHeldFixture();
  try {
    const lines: unknown[] = [];
    const gh = ghRows({ 1908: ["session:worker-1908"], 1948: [] });
    const report = pruneWorktrees(root, { now: LONG_AFTER(), dryRun: true, claim: (tree) => claimRefusal(tree, { gh }),
      record: (line) => { lines.push(line); } });
    assert.ok(report.held.some((r) => r.path === unstamped), "the listing is the tool's own answer, claim included");
    assert.deepEqual(lines, [], "nothing was removed, so nothing is logged as removed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- #2782: THE SHARED PREDICATES (`worktree-removal.ts`), which all three removers ask. Pinned here rather than in a file of their
// own: a new test file importing `agent-org/src` moves `agent-org-extraction.test.ts`'s decision-4 count, which is #2623's to amend. THE
// HALF THAT MATTERS IS THE NEGATIVE ONE -- a claim that refuses everything is `stop pruning` wearing a better name, so each refusal
// sits beside a case that must NOT refuse. ---

/** A `gh issue view <n>` that answers from a table, and records which rows it was asked about. */
function fakeRowsGh(rows: Record<number, { state?: string; labels: string[] }>) {
  const asked: number[] = [];
  const gh = (args: string[]) => {
    const row = Number(args[2]);
    asked.push(row);
    const found = rows[row];
    if (found === undefined) throw new Error(`gh issue view ${row} exited 1: not found`);
    return JSON.stringify({ state: found.state ?? "OPEN", labels: found.labels.map((name) => ({ name })) });
  };
  return { gh, asked };
}

const scratchDir = () => mkdtempSync(join(tmpdir(), "worktree-removal-"));

test("rowCandidates reads the row off every spelling this repo has used, and off nothing else", () => {
  assert.deepEqual(rowCandidates({ path: "/r/wt-2623", branch: "agent/2623-followup-walkscope-treewide" }), [2623],
    "the prefix spelling wt-2623 actually had, and the directory, name ONE row between them");
  assert.deepEqual(rowCandidates({ path: "/r/wt-2782", branch: "agent/a-claimed-row-s-2782" }), [2782]);
  assert.deepEqual(rowCandidates({ path: "/r/wt-100", branch: "agent/other-200" }).sort(), [100, 200],
    "a tree whose two names disagree asks about both, and any claimed one refuses");
  assert.deepEqual(rowCandidates({ path: "/r/wt-2623", branch: null }), [2623], "a detached tree still has its directory");
  assert.deepEqual(rowCandidates({ path: "/r/role-engineer", branch: "dispatcher/merge" }), [],
    "a standing tree names no row, so there is no claim to read");
});

test("#3850: rowsClosed is true only when EVERY row the tree names is CLOSED, whatever labels the closed row kept", () => {
  const closed = fakeRowsGh({ 20: { state: "CLOSED", labels: ["session:worker-20"] }, 21: { state: "CLOSED", labels: [] } });
  assert.deepEqual(rowsClosed({ path: "/r/wt-20", branch: null }, { gh: closed.gh }), { closed: true },
    "a closed row's leftover session label is the debris this release exists for");
  assert.deepEqual(rowsClosed({ path: "/r/wt-20", branch: "agent/other-21" }, { gh: closed.gh }), { closed: true });
  assert.deepEqual(closed.asked.sort(), [20, 20, 21], "and each row is read");
});

test("#3850: rowsClosed is FALSE for an open row, a row that cannot be read, and a tree that names no row", () => {
  const rows = fakeRowsGh({ 30: { state: "CLOSED", labels: [] }, 31: { labels: [] } });
  const open = rowsClosed({ path: "/r/wt-30", branch: "agent/other-31" }, { gh: rows.gh });
  assert.equal(open.closed, false);
  assert.match((open as { reason: string }).reason, /row #31 is open/, "one open row among closed ones keeps the tree");
  const unreadable = rowsClosed({ path: "/r/wt-32", branch: null }, { gh: rows.gh });
  assert.equal(unreadable.closed, false);
  assert.match((unreadable as { reason: string }).reason, /row #32 could not be read/, "could not ask is never closed");
  const none = fakeRowsGh({});
  const standing = rowsClosed({ path: "/r/role-engineer", branch: "dispatcher/merge" }, { gh: none.gh });
  assert.equal(standing.closed, false);
  assert.match((standing as { reason: string }).reason, /names no row/);
  assert.deepEqual(none.asked, [], "a tree naming no row costs no API call");
});

test("claimRefusal REFUSES a tree whose open row carries a session label -- the copy in .a11y-owner is not consulted", () => {
  const { gh, asked } = fakeRowsGh({ 2623: { labels: ["in-progress", "session:worker-2623"] } });
  const refusal = claimRefusal({ path: "/r/wt-2623", branch: null }, { gh });
  assert.equal(refusal.refused, true);
  assert.match((refusal as { reason: string }).reason, /row #2623, which still carries session:worker-2623/);
  assert.deepEqual(asked, [2623]);
});

test("claimRefusal does NOT refuse an unclaimed row, a CLOSED row that kept debris labels, or the session removing its own tree", () => {
  const open = fakeRowsGh({ 10: { labels: ["ready"] } });
  assert.deepEqual(claimRefusal({ path: "/r/wt-10", branch: null }, { gh: open.gh }), { refused: false });
  const closed = fakeRowsGh({ 11: { state: "CLOSED", labels: ["session:worker-11"] } });
  assert.deepEqual(claimRefusal({ path: "/r/wt-11", branch: null }, { gh: closed.gh }), { refused: false },
    "a closed row's leftover label is debris (ready-label-audit says so); refusing on it would leak every finished tree");
  const own = fakeRowsGh({ 12: { labels: ["session:worker-12"] } });
  assert.deepEqual(claimRefusal({ path: "/r/wt-12", branch: null }, { gh: own.gh, except: "worker-12" }), { refused: false });
  const other = fakeRowsGh({ 12: { labels: ["session:worker-99"] } });
  assert.equal(claimRefusal({ path: "/r/wt-12", branch: null }, { gh: other.gh, except: "worker-12" }).refused, true,
    "`except` names ONE session; somebody else's claim on the same row still refuses");
});

test("claimRefusal: a row it could not READ is refused, never read as unclaimed -- and a tree naming no row asks nothing", () => {
  const { gh } = fakeRowsGh({});
  const refusal = claimRefusal({ path: "/r/wt-404", branch: null }, { gh });
  assert.equal(refusal.refused, true);
  assert.match((refusal as { reason: string }).reason, /claim could not be read.*unanswered question/s);
  const none = fakeRowsGh({});
  assert.deepEqual(claimRefusal({ path: "/r/role-x", branch: null }, { gh: none.gh }), { refused: false });
  assert.deepEqual(none.asked, [], "a standing tree spends no API call");
});

test("recordRemoval appends one JSON line naming the tree, the asker, the reason and the owner file's content", () => {
  const dir = scratchDir();
  try {
    const tree = join(dir, "wt-2623");
    mkdirSync(tree);
    writeFileSync(join(tree, ".a11y-owner"), "worker-2623\n");
    const env = { [REMOVAL_LOG_ENV]: join(dir, "logs", "worktree-removals") };
    recordRemoval({ path: tree, caller: "prune-worktrees.ts", reason: "merged", event: "removing", branch: "agent/x-2623" }, { env });
    recordRemoval({ path: tree, caller: "prune-worktrees.ts", reason: "merged", event: "removed" }, { env });
    const lines = readFileSync(removalLogPath(env), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2, "appended, never overwritten");
    assert.deepEqual(lines.map((l) => l.event), ["removing", "removed"]);
    assert.equal(lines[0].owner, "worker-2623");
    assert.equal(lines[0].path, tree);
    assert.equal(lines[0].caller, "prune-worktrees.ts");
    assert.match(lines[0].at, /^\d{4}-\d{2}-\d{2}T/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recordRemoval THROWS when the line cannot be written, so the caller can refuse the delete", () => {
  const dir = scratchDir();
  try {
    assert.throws(() => recordRemoval({ path: "/r/wt-1", caller: "x", reason: "y", event: "removing" },
      { env: { [REMOVAL_LOG_ENV]: join(dir, "log") }, append: () => { throw new Error("ENOSPC"); } }), /ENOSPC/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("nestedWorktrees finds a worktree at any depth a scratchpad nests it, skips node_modules, and worktreeBranch reads its branch", () => {
  const dir = scratchDir();
  try {
    const tree = join(dir, "scratchpad", "wt-2623");
    const gitdir = join(dir, "gitdirs", "wt-2623");
    mkdirSync(tree, { recursive: true });
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(tree, ".git"), `gitdir: ${gitdir}\n`);
    writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/agent/2623-followup\n");
    mkdirSync(join(dir, "scratchpad", "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "scratchpad", "node_modules", "pkg", ".git"), "gitdir: nowhere\n");
    mkdirSync(join(dir, "plain"), { recursive: true });
    assert.deepEqual(nestedWorktrees(dir), [tree], "the worktree is found; a `.git` under node_modules and a plain directory are not");
    assert.equal(worktreeBranch(tree), "agent/2623-followup");
    writeFileSync(join(gitdir, "HEAD"), "0123456789012345678901234567890123456789\n");
    assert.equal(worktreeBranch(tree), null, "a detached HEAD names no branch");
    assert.equal(worktreeBranch(join(dir, "plain")), null, "a directory that is not a worktree names none either");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
