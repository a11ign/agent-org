// @ts-check
// command: remove fully-merged, clean linked worktrees, and name every other one as dirty
// WORKTREE LIFECYCLE, AS A COMMAND -- not a discipline somebody has to remember.
//
// The rule ("prune after every merge") existed as prose from 2026-09-06, `dispatcher` pruned 28 stale
// trees by hand, and 36 remained the next day: 4.4 GB, 38 real `node_modules` directories. A rule
// maintained by hand is a rule that lapses.
//
// FIVE POPULATIONS, and conflating them is the whole risk in this file:
//   - LIST every worktree whose HEAD is merged into origin/main -- by branch where there is one, and
//     by the commit itself where there is not (#696); a detached HEAD answers `merge-base
//     --is-ancestor` exactly as well as a named branch does (a "gone" branch -- deleted outright --
//     is the same population read a different way: nothing to lose either way).
//   - REMOVE the ones that are also CLEAN -- no uncommitted changes, no commits origin/main does not have.
//   - NAME the DIRTY ones, with their branch, and remove NOTHING from that set.
//   - NAME (never remove) the CHERRY-PICKED ones -- added after `dispatcher`'s own manual pass measured
//     them as real, not hypothetical (25 removed, 3.4 GB freed, 4 refused, one genuine near-miss):
//       CHERRY-PICKED: `merge-base --is-ancestor` says NOT merged forever for a branch whose commits were
//       cherry-picked onto main rather than merged -- same CONTENT, different SHAs, ahead by that reading
//       for as long as the branch exists (measured: `agent/same-document-resolved-url`, 10 "ahead", every
//       commit's content already on main). Reported as its own state and left for a human, never folded
//       into "dirty" (which reads as real, uncaptured work) or auto-removed (which would be right most of
//       the time and catastrophic the one time a cherry-pick left something behind it did not carry).
//       INCONCLUSIVE: merge or clean status could not be DETERMINED at all -- `origin/main` missing, a
//       corrupt ref, an unreadable working tree. A dispatcher's own manual pass had exactly this bug:
//       `[ "$(git rev-list --count origin/main..branch 2>/dev/null)" != 0 ]` reads an EMPTY (errored)
//       result the same as a real nonzero count, silently treating "could not tell" as "not merged".
//       Reported and left for a human -- never folded into "not merged" or "dirty" by a default that only
//       looks safe.
//
// A dirty worktree holds uncommitted work, which is exactly the case where deletion is unrecoverable --
// this project has one recorded near-miss already (`git checkout main` refused in the primary over
// sixteen uncommitted lines; a forcing flag would have taken them silently). A prune that removes a dirty
// tree is worse than no prune at all, because this runs unattended after every merge. **A branch that
// reads MERGED can still have an unmerged working tree** -- measured directly (`a11y-wt-realpage`: 0
// commits ahead of main, 5 modified files, 2 untracked) -- which is why `isWorkingTreeClean` is asked
// unconditionally and never short-circuited by a clean merge status.
//
// NEVER TOUCHES THE PRIMARY CHECKOUT -- the fleet-driving tree. Identified structurally, not by path or
// list position: the primary's `.git` is a real DIRECTORY; every linked worktree's `.git` is a text file
// (`gitdir: <path>`) pointing into the primary's `.git/worktrees/<name>`. That is git's own mechanism for
// telling the two apart, not a guess about naming conventions or where this checkout happens to live.
//
// `git worktree remove` WITHOUT `--force` IS ITSELF A GUARD, not merely this file's own check restated --
// measured: it refused three trees on its own in the manual pass. Never pass `--force`; a dirty tree this
// file's own classification somehow missed is exactly the case that guard exists to catch anyway.
//
// #220: "CLEAN" IS NOT "FINISHED". `worker-capture` ran `git stash -u` to switch branches, which makes a
// working tree momentarily clean -- a real prune ran inside that window and deleted the directory out from
// under them mid-command. Nothing was lost only because a stash lives in the repository's COMMON git dir,
// not the worktree; an uncommitted (never-stashed) edit would have gone with it.
//
// So "remove" now also requires the worktree to show NO RECENT GIT ACTIVITY -- the mtime of its own
// PRIVATE gitdir (`.git/worktrees/<name>/{index,HEAD,logs/HEAD}`, resolved via `git rev-parse
// --absolute-git-dir`, never guessed from the path) must be older than `ACTIVITY_WINDOW_MS`. Measured
// directly (see the test file): `git stash -u` and `git add` both touch `index`'s mtime; a plain `git
// status` on an already-modified-but-unstaged file does not. That is this signal's NAMED failure mode --
// a session editing files through a non-git tool, with no `git add`/`stash`/`commit`/`checkout` in the
// window, is invisible to it and could still be pruned. Chosen anyway as the cheapest of the three
// candidates the row named (mtime / a lock file / an open PR): it directly covers the incident that
// happened (mid-stash), needs no new file for every session to write and clean up (a lock file's own
// failure mode -- a crashed session's lock never clears), and does not require a PR to exist yet (the
// incident happened before one did). A genuinely abandoned tree still gets removed once the window
// passes, which is `ACCEPTANCE step 3`'s own requirement -- this narrows the remove window, it does not
// disable it.
export const ACTIVITY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes: survives a stash-then-checkout gap; still sweeps
                                            // a truly abandoned tree well within an hour of prune runs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";

/** @type {(cmd: string, args: string[], opts: { cwd: string }) => string} */
const defaultRun = (cmd, args, opts) =>
  execFileSync(cmd, args, { ...opts, env: sandboxGitEnv(), encoding: "utf8" });

/**
 * @typedef {{ path: string, branch: string | null, detached: boolean }} WorktreeEntry
 */

/**
 * Whether `worktreePath` shows GIT ACTIVITY within `windowMs` of `now` -- the mtime of its own PRIVATE
 * gitdir's `index`, `HEAD` and `logs/HEAD` (whichever exist), newest wins. TRISTATE for the same reason
 * as `mergeStatus`/`isWorkingTreeClean`: `git rev-parse --absolute-git-dir` failing (a corrupted worktree,
 * a `.git` file pointing nowhere) must read `"unknown"`, never `false` -- collapsing "could not check"
 * into "no recent activity" is exactly the shape this row exists to close, one layer further in.
 *
 * NAMED FAILURE MODE (see this file's own header for why this signal over the other two candidates): a
 * session editing files through a non-git tool, with no `git add`/`stash`/`commit`/`checkout` inside the
 * window, is invisible to this check and could still be pruned. Narrower than the incident this closes,
 * not a claim of completeness.
 *
 * @param {string} worktreePath
 * @param {{ run?: typeof defaultRun, now?: number, windowMs?: number }} [deps]
 * @returns {boolean | "unknown"}
 */
export function recentGitActivity(worktreePath, { run = defaultRun, now = Date.now(), windowMs = ACTIVITY_WINDOW_MS } = {}) {
  /** @type {string} */
  let gitDir;
  try {
    gitDir = run("git", ["rev-parse", "--absolute-git-dir"], { cwd: worktreePath }).trim();
  } catch {
    return "unknown";
  }
  const candidates = ["index", "HEAD", join("logs", "HEAD")].map((f) => join(gitDir, f));
  let newestMtimeMs = -Infinity;
  let sawAny = false;
  for (const path of candidates) {
    try {
      const mtimeMs = statSync(path).mtimeMs;
      sawAny = true;
      if (mtimeMs > newestMtimeMs) newestMtimeMs = mtimeMs;
    } catch {
      // this particular file may legitimately not exist (e.g. no reflog yet) -- only ALL missing is unknown
    }
  }
  if (!sawAny) return "unknown";
  return now - newestMtimeMs < windowMs;
}

/**
 * Parses `git worktree list --porcelain`'s block format. Pure, given the raw text -- the shape worker-
 * capture's own tests favour, tested directly against a fixture string with no git process involved.
 *
 * @param {string} porcelain
 * @returns {WorktreeEntry[]}
 */
export function parseWorktreeList(porcelain) {
  const entries = [];
  for (const block of porcelain.split(/\n\n+/)) {
    const pathLine = /^worktree (.+)$/m.exec(block);
    if (!pathLine) continue;
    const branchLine = /^branch refs\/heads\/(.+)$/m.exec(block);
    entries.push({
      path: pathLine[1],
      branch: branchLine ? branchLine[1] : null,
      detached: /^detached$/m.test(block),
    });
  }
  return entries;
}

/**
 * git's own mechanism for telling a linked worktree from the repository it belongs to: the primary's
 * `.git` is a real directory, a linked worktree's is a text file. Never a guess from the path.
 *
 * @param {string} worktreePath
 * @returns {boolean}
 */
export function isPrimaryWorktree(worktreePath) {
  const gitPath = join(worktreePath, ".git");
  if (!existsSync(gitPath)) return false;
  return lstatSync(gitPath).isDirectory();
}

/**
 * @typedef {{
 *   path: string, branch: string | null,
 *   merge: "merged" | "not-merged" | "unknown", workingTreeClean: boolean | "unknown", contentMerged: boolean,
 *   recentlyActive: boolean | "unknown",
 * }} WorktreeAssessment
 */

/**
/**
 * #671/#696: THIS FUNCTION USED TO EXIST AND IT ASKED THE WRONG QUESTION.
 *
 * ```js
 * export function isStandingBranch(branch) { return !branch.startsWith("agent/"); }
 * ```
 *
 * It exempted 42 of 103 worktrees on the live host because their branch was `pm/`, `lead/`, `ceo/` or
 * `dispatcher/` rather than `agent/` -- a ROLE tree, "never a prune candidate at all, regardless of merge
 * or clean state." The trouble is that **merged-and-clean is not a property of a name.** A `pm/` worktree
 * whose branch landed a week ago and whose tree is spotless is exactly as removable as an `agent/` one,
 * and the evidence is that their owner removed nine of them by hand the same morning -- every one merged
 * and clean -- because the tool would not.
 *
 * `classify` below now asks only about STATE: merged into `origin/main`, clean, not recently active, not
 * the primary. There is no name clause and no prefix clause left in this file, and the STANDING bucket
 * is gone with them.
 *
 * WHAT REPLACES IT IS NOT NOTHING. A role tree is usually somebody's CURRENT WORKING DIRECTORY, which is
 * the real hazard, and a prefix never measured that either -- it protected a finished `lead/` tree and
 * left a live `agent/` one exposed. The three things that actually protect a tree somebody is standing
 * in are the ACTIVE window (#220: git activity inside the last N minutes), the announce-one-cycle rule,
 * and `--apply` being explicit (#669). All three key on what is happening rather than on what it is
 * called.
 */

/**
 * Pure: given what is already known about a worktree, which of the FIVE populations is it in?
 *
 * ORDER MATTERS, and the two clauses that used to come first are gone (#671, #696): a detached worktree
 * was refused before anything was measured, and a non-`agent/*` branch was refused unconditionally after
 * it. Both asked about a NAME. What is left asks only about state, and `"unknown"` on ANY of `merge`, `workingTreeClean` or `recentlyActive` is
 * checked before "remove" becomes reachable at all -- INCONCLUSIVE, never silently folded into "not
 * merged" or "dirty". That collapse is a real, measured incident, not a hypothetical: a manual prune
 * script's own `[ "$(git rev-list --count origin/main..branch 2>/dev/null)" != 0 ]` compares an EMPTY
 * result (the count errored) against `0` as unequal, treating "could not tell" as "definitely not merged"
 * -- the same shape this project has paid for repeatedly elsewhere, here inside the very tool meant to
 * enforce hygiene. Only past all three does "cherry-picked" get checked, before the general "dirty"
 * fallback, so a content-identical branch is never lumped in with real, uncaptured work.
 *
 * `recentlyActive` is checked LAST, after merge+clean would otherwise say "remove" -- #220: a tree that is
 * merged and clean but shows GIT ACTIVITY inside the window (see `recentGitActivity`'s own header) is
 * ACTIVE, not removed, because "clean" can mean "finished" or "mid-stash", and only recency tells them
 * apart.
 *
 * IT NO LONGER TAKES `branch` AT ALL, and that is the change stated as plainly as it can be. Two clauses
 * used to read a name -- `if (branch === null) return "dirty"` and `if (isStandingBranch(branch))` -- and
 * between them they decided 54 of 103 worktrees on the live host without consulting a single fact about
 * what those trees contained. Every input to this verdict is now a measurement.
 *
 * @param {Pick<WorktreeAssessment, "merge" | "workingTreeClean" | "contentMerged" | "recentlyActive">} assessment
 * @returns {"remove" | "dirty" | "cherry-picked" | "inconclusive" | "active"}
 */
export function classify({ merge, workingTreeClean, contentMerged, recentlyActive }) {
  if (merge === "unknown" || workingTreeClean === "unknown" || recentlyActive === "unknown") return "inconclusive";
  if (merge === "merged" && workingTreeClean) return recentlyActive ? "active" : "remove";
  if (merge === "not-merged" && contentMerged) return "cherry-picked";
  return "dirty";
}

/**
 * Whether `branch` is fully merged into `origin/main` -- so no commit on it is missing from history. A
 * branch that no longer exists at all (deleted since `git worktree list` last ran, or by another agent
 * moments ago) is treated as merged: nothing on it can be lost by removing a worktree pointing nowhere.
 *
 * TRISTATE, deliberately, not a boolean: `git merge-base --is-ancestor` exits 1 for its own documented
 * "not an ancestor" answer, and exits with anything ELSE (128, most commonly) when it could not even ask
 * the question -- `origin/main` missing, a corrupt ref, a repo mid-operation. Reading "anything non-zero"
 * as "not merged" is exactly the collapse measured in the incident this function's caller documents;
 * `"unknown"` keeps that third state visible instead of guessing which of the other two it must be.
 *
 * @param {string} repoRoot
 * @param {string} branch
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {"merged" | "not-merged" | "unknown"}
 */
export function mergeStatus(repoRoot, branch, { run = defaultRun } = {}) {
  try {
    run("git", ["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: repoRoot });
  } catch {
    return "merged"; // the branch itself is gone -- nothing left to merge or lose
  }
  try {
    run("git", ["merge-base", "--is-ancestor", branch, "origin/main"], { cwd: repoRoot });
    return "merged";
  } catch (error) {
    const status = /** @type {{ status?: number }} */ (error).status;
    return status === 1 ? "not-merged" : "unknown";
  }
}

/**
 * The merge status of a DETACHED worktree, asked of its HEAD commit rather than of a branch name.
 *
 * Identical in shape and in tristate to `mergeStatus`, and identical in what it refuses to guess: exit 1
 * is a real "not an ancestor", anything else is `"unknown"` and reaches INCONCLUSIVE. Asked in the
 * worktree itself, because `HEAD` means a different commit in every one.
 *
 * @param {string} worktreePath
 * @param {{ run?: typeof defaultRun }} deps
 * @returns {"merged" | "not-merged" | "unknown"}
 */
export function detachedMergeStatus(worktreePath, { run = defaultRun } = {}) {
  try {
    run("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], { cwd: worktreePath });
    return "merged";
  } catch (error) {
    const status = /** @type {{ status?: number }} */ (error).status;
    return status === 1 ? "not-merged" : "unknown";
  }
}

/**
 * Whether every commit `branch` carries beyond its merge-base with `origin/main` has an EQUIVALENT patch
 * already on `origin/main` -- a cherry-pick, not a merge, so `isMergedIntoMain`'s ancestor check reads
 * NOT merged forever even though nothing on the branch is actually missing from history.
 *
 * `git cherry origin/main <branch>` prefixes each commit `-` (patch-id already upstream) or `+` (genuinely
 * new). Only called when `isMergedIntoMain` has already said false, so an EMPTY result here (no commits
 * ahead at all) would itself be a contradiction -- treated as "not content-merged" rather than guessed at,
 * since that shape means something is wrong with the two checks agreeing, not that the branch is clean.
 *
 * @param {string} repoRoot
 * @param {string} branch
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {boolean}
 */
export function isContentMerged(repoRoot, branch, { run = defaultRun } = {}) {
  /** @type {string} */
  let out;
  try {
    out = run("git", ["cherry", "origin/main", branch], { cwd: repoRoot });
  } catch {
    return false; // could not determine -- refuse to call it content-merged
  }
  const lines = out.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return false; // nothing ahead at all is isMergedIntoMain's case, not this one
  return lines.every((l) => l.startsWith("-"));
}

/**
 * Whether a worktree's working directory has no uncommitted changes -- exactly `git status --porcelain`,
 * nothing more. Deliberately NOT also checking for commits `origin/main` lacks: that is `mergeStatus`'s
 * question, asked once, so a worktree with a real unmerged commit but a clean `git status` (committed,
 * just not yet integrated) is not read as "clean" here and "unmerged" there -- `classify` requires BOTH
 * facts true to remove, so either check alone catches that case, and folding "ahead of origin/main" into
 * this function too would just be the same fact asked twice.
 *
 * TRISTATE for the same reason as `mergeStatus`: an unreadable working tree (permissions, a corrupted
 * index, the directory vanishing mid-run) must read as `"unknown"`, never as `false` -- collapsing "could
 * not check" into "dirty" is a safer-LOOKING default that still hides the same failure this file exists
 * to stop hiding.
 *
 * @param {string} worktreePath
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {boolean | "unknown"}
 */
export function isWorkingTreeClean(worktreePath, { run = defaultRun } = {}) {
  // #696, THE THIRD SITE, and THE PARAMETER IS GONE WITH IT. This took a `branch` and said
  // `if (branch === null) return false` -- asserting a detached worktree is DIRTY without running
  // `git status`, which takes no branch name and answers identically either way. Keeping the parameter
  // unused would leave the next reader believing the answer depends on it.
  try {
    const status = run("git", ["status", "--porcelain"], { cwd: worktreePath });
    return status.trim() === "";
  } catch {
    return "unknown";
  }
}

/**
 * #1373: THE RECORDS A WORKTREE HOLDS THAT GIT CANNOT SEE, AND A COMPARISON THAT MUST NOT PASS ON NOTHING.
 *
 * `runs/` is gitignored, so `git status` reads a worktree full of board snapshots as CLEAN, and `git worktree
 * remove` -- WITHOUT `--force` -- deletes them with the directory. Reproduced on #1373 at `57cbddc4`: this tool
 * and `row-claim decline` each removed a fixture worktree holding three `runs/` files the primary did not
 * have, and the three were gone. The row's own instance was an operator's chain in which `cp` failed, both
 * `sha256sum` reads failed, and `"" = ""` authorised the delete of the only copies.
 *
 * So a worktree whose `runs/` holds files is removable only when EVERY file sits at the same relative path in
 * the primary checkout with the same sha256, and each way of passing on nothing refuses instead:
 *   - a hash that is EMPTY (a failed read, a missing file) never matches, not even another empty one;
 *   - a non-empty `runs/` that lists ZERO files is a failed listing, not "nothing to lose";
 *   - no primary to compare against is a refusal, not a pass;
 *   - the verified count must equal the listed count.
 * A worktree with no `runs/` files is untouched by all of this and removed exactly as before.
 */
export const RECORDS_DIR = "runs";

/** @param {string} file @returns {string} the file's sha256, hex; THROWS when it cannot be read */
export function sha256OfFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Every non-directory entry under `<root>/runs/`, as a path relative to `root`, sorted. `[]` when there is no
 * `runs/` -- which `unverifiedRecords` checks against the directory itself before believing it.
 * @param {string} root
 * @returns {string[]}
 */
export function listRecordFiles(root) {
  const dir = join(root, RECORDS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

/**
 * The primary checkout of the repository `worktreePath` belongs to -- `git worktree list` always names it
 * first. `null` when git cannot say, which `unverifiedRecords` refuses on whenever there is anything to verify.
 * @param {string} worktreePath
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {string | null}
 */
export function primaryWorktreeOf(worktreePath, { run = defaultRun } = {}) {
  try {
    const porcelain = run("git", ["-C", worktreePath, "worktree", "list", "--porcelain"], { cwd: worktreePath });
    return parseWorktreeList(porcelain)[0]?.path ?? null;
  } catch {
    return null; // "could not find the primary" -- a refusal downstream, never a pass
  }
}

/**
 * A hash, or `""` for a file that is absent or unreadable -- with the failure kept for the refusal to name.
 * @param {(file: string) => string} hash
 * @param {string} file
 * @param {string[]} failures
 */
function hashOrEmpty(hash, file, failures) {
  if (!existsSync(file)) return "";
  try {
    return hash(file);
  } catch (error) {
    failures.push(`${file} (${/** @type {Error} */ (error).message})`);
    return "";
  }
}

/**
 * @param {string} worktreePath
 * @param {(root: string) => string[]} list
 * @returns {{ files: string[] } | { reason: string }}
 */
function listedRecords(worktreePath, list) {
  const dir = join(worktreePath, RECORDS_DIR);
  let files;
  try {
    files = list(worktreePath);
  } catch (error) {
    return { reason: `${dir} could not be listed (${/** @type {Error} */ (error).message}) -- refusing to remove ${worktreePath}` };
  }
  if (files.length === 0 && existsSync(dir) && readdirSync(dir).length > 0) {
    return { reason: `${dir} is not empty but ZERO files were listed -- an empty listing of a non-empty directory `
      + `is a failed read, never "nothing to lose"; refusing to remove ${worktreePath}` };
  }
  return { files };
}

/**
 * #1373: whether `worktreePath`'s `runs/` records forbid removing it -- see `RECORDS_DIR`'s header.
 * @param {string} worktreePath
 * @param {string | null} primaryPath
 * @param {{ hash?: (file: string) => string, list?: (root: string) => string[] }} [deps]
 * @returns {{ refused: false, listed: number } | { refused: true, reason: string }}
 */
export function unverifiedRecords(worktreePath, primaryPath, { hash = sha256OfFile, list = listRecordFiles } = {}) {
  const listing = listedRecords(worktreePath, list);
  if ("reason" in listing) return { refused: true, reason: listing.reason };
  const listed = listing.files;
  if (listed.length === 0) return { refused: false, listed: 0 };
  if (primaryPath === null) {
    return { refused: true, reason: `${worktreePath} holds ${listed.length} ${RECORDS_DIR}/ file(s) and no primary `
      + "checkout could be found to verify them against -- refusing to remove it" };
  }
  /** @type {string[]} */
  const failures = [];
  const verified = listed.filter((file) => {
    const here = hashOrEmpty(hash, join(worktreePath, file), failures);
    const there = hashOrEmpty(hash, join(primaryPath, file), failures);
    return here !== "" && there !== "" && here === there;
  });
  if (verified.length === listed.length) return { refused: false, listed: listed.length };
  const unverified = listed.filter((file) => !verified.includes(file));
  return { refused: true, reason: `${worktreePath} holds ${unverified.length} of ${listed.length} ${RECORDS_DIR}/ `
    + `file(s) not present, with a matching NON-EMPTY sha256, in the primary checkout ${primaryPath} -- refusing `
    + `to remove it: ${unverified.join(", ")}${failures.length > 0 ? `; unreadable: ${failures.join("; ")}` : ""}` };
}

/**
 * @typedef {{ path: string, branch: string | null }} ReportedWorktree
 * @typedef {{
 *   removed: ReportedWorktree[],
 *   records: (ReportedWorktree & { reason: string })[],
 *   dirty: ReportedWorktree[],
 *   cherryPicked: ReportedWorktree[],
 *   inconclusive: ReportedWorktree[],
 *   active: ReportedWorktree[],
 *   skippedPrimary: string | null,
 * }} PruneReport
 */

/**
 * The four facts `classify` needs about one non-primary worktree entry.
 *
 * `contentMerged` is only computed when `merge` is `"not-merged"` (a real, resolved "no") -- `git cherry`
 * is meaningless for a detached, already-merged, or UNKNOWN-status worktree, and skipping it there is not
 * an optimisation, it is avoiding a question that does not apply, or that the first question already
 * failed to answer.
 *
 * `recentlyActive` (#220) is only computed when `merge === "merged"` and `workingTreeClean` -- the ONLY
 * case where its answer changes the verdict (`classify` never reads it otherwise). Defaults to `false`
 * (never "unknown") when skipped, so a dirty or cherry-picked entry is never misread as inconclusive over
 * a question that does not apply to it.
 *
 * @param {string} repoRoot
 * @param {WorktreeEntry} entry
 * @param {{ run: typeof defaultRun, now: number }} deps
 * @returns {Pick<WorktreeAssessment, "merge" | "workingTreeClean" | "contentMerged" | "recentlyActive">}
 */
function assessWorktree(repoRoot, entry, { run, now }) {
  // #696: THIS SAID `: "not-merged"` FOR A DETACHED WORKTREE -- an assertion, not a measurement, and
  // false for twelve of the fifteen detached trees on the live host (0 uncommitted, 0 commits
  // `origin/main` lacks). A commit's merged-ness needs no branch NAME: `merge-base --is-ancestor` takes
  // the commit directly. Detachment makes the STANDING question unanswerable, and made nothing else so.
  const merge = entry.branch !== null
    ? mergeStatus(repoRoot, entry.branch, { run })
    : detachedMergeStatus(entry.path, { run });
  const workingTreeClean = isWorkingTreeClean(entry.path, { run });
  const contentMerged = entry.branch !== null && merge === "not-merged"
    && isContentMerged(repoRoot, entry.branch, { run });
  const recentlyActive = merge === "merged" && workingTreeClean === true
    ? recentGitActivity(entry.path, { run, now })
    : false;
  return { merge, workingTreeClean, contentMerged, recentlyActive };
}

/**
 * THE SESSION PREFIXES THAT NO LONGER RUN -- #933.
 *
 * A branch prefix names the session that cut it, and a worktree whose prefix names a RETIRED session is the
 * case with nobody to ask: the work is stranded rather than in progress. Measured on this host 2026-09-12,
 * three of the seven worktrees holding uncommitted tracked work were `dispatcher`'s.
 *
 * A CONSTANT AND NOT A DERIVATION, deliberately. The org's shape is a decision, not a fact in the tree --
 * deriving it would mean asking GitHub which `session:` labels are in use, which makes a local report
 * depend on the network and on a tracker state that lags the decision. The reason lives here instead:
 * `dispatcher` and `lead` were retired when the org moved to five sessions (ceo, product-manager,
 * orchestrator, worker-capture, worker-judge); `agent/` is the live prefix every one of them uses.
 */
const RETIRED_BRANCH_PREFIXES = ["dispatcher/", "lead/"];

/**
 * The uncommitted work in one worktree, counted over MODIFIED TRACKED FILES ONLY.
 *
 * **This is the whole value of the report and it is a narrowing, not a filter of convenience.** Measured
 * on this host 2026-09-12: 58 worktrees, **38** with something uncommitted, **7** with modified tracked
 * files, and the other 31 carry `.metadata_never_index` and nothing else -- macOS Spotlight, in every
 * worktree, for ever. A report that names 38 is a report nobody reads, and the six entries that matter are
 * invisible inside it.
 *
 * `??` lines are EXCLUDED, which is the narrowing, and that is a real loss: a brand-new file nobody has
 * added is uncommitted work too. It is taken deliberately, because the noise is 100% untracked and the
 * signal would be buried. `git add -N` promotes such a file into this report, which is the documented way
 * to make it visible.
 * @param {string} worktreePath
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {{ files: number, insertions: number, deletions: number } | "unknown"}
 */
export function trackedChanges(worktreePath, { run = defaultRun } = {}) {
  try {
    const status = run("git", ["status", "--porcelain"], { cwd: worktreePath });
    const files = status.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("??")).length;
    if (files === 0) return { files: 0, insertions: 0, deletions: 0 };
    // `HEAD` covers staged AND unstaged together: a worktree with everything staged is exactly the case
    // #933 found twice, and a bare `git diff` reports zero for it.
    const shortstat = run("git", ["diff", "--shortstat", "HEAD"], { cwd: worktreePath });
    const insertions = Number(/(\d+) insertion/.exec(shortstat)?.[1] ?? 0);
    const deletions = Number(/(\d+) deletion/.exec(shortstat)?.[1] ?? 0);
    return { files, insertions, deletions };
  } catch {
    return "unknown"; // never 0: "could not ask" and "nothing there" are different reports
  }
}

/**
 * How many commits `branch` has that `origin/main` does not. `"unknown"` when the question cannot be asked
 * -- never 0, because "no commits ahead" and "could not compare" are the two answers this repository has
 * most often conflated, and here they are the difference between "this is all the work there is" and
 * "I have no idea what this is".
 * @param {string} repoRoot
 * @param {string} branch
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {number | "unknown"}
 */
export function commitsNotOnMain(repoRoot, branch, { run = defaultRun } = {}) {
  try {
    const count = Number(run("git", ["rev-list", "--count", `origin/main..${branch}`], { cwd: repoRoot }).trim());
    return Number.isInteger(count) ? count : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * `mergeStatus`'s three answers, preserved as three. `=== "merged"` is the shape that destroyed it:
 * `"unknown" === "merged"` is `false`, so a merge status nobody could read became "the answer is no".
 * @param {string} status
 * @returns {boolean | "unknown"}
 */
const mergedTristate = (status) => (status === "unknown" ? "unknown" : status === "merged");

/**
 * @typedef {{ path: string, branch: string | null, files: number, insertions: number, deletions: number,
 *   onMain: boolean | "unknown", commitsAhead: number | "unknown", retiredSession: boolean
 * }} StrandedWorktree
 */

/**
 * Every worktree holding uncommitted tracked work, with what a reader needs to dispose of it.
 *
 * **It reports and never deletes.** `pruneWorktrees` already refuses a dirty worktree correctly; the gap
 * #933 names is that nobody hears the refusal, so this is a separate read over the same list.
 *
 * AND IT DOES NOT TOUCH `isWorkingTreeClean`, which is the tempting change and the wrong one: that
 * predicate decides REMOVAL, and narrowing it to tracked files would turn "refused, there are untracked
 * files here" into "removed". A narrowing that is right for a report is a deletion when it is wired to a
 * delete.
 * @param {string} repoRoot
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {{ examined: number, stranded: StrandedWorktree[], unreadable: string[] }}
 */
export function strandedWork(repoRoot, { run = defaultRun } = {}) {
  const entries = parseWorktreeList(run("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot }));
  /** @type {StrandedWorktree[]} */
  const stranded = [];
  /** @type {string[]} */
  const unreadable = [];
  // EXAMINED COUNTS WHAT WAS EXAMINED. `entries.length` included the primary checkout, which the loop
  // skips -- so the head line said 58 of a population of 57. worker-judge: the count was held as PRINTED
  // and never as COUNTING, and `entries.length + 99` was 0 red across all 37 tests.
  let examined = 0;
  for (const entry of entries) {
    if (isPrimaryWorktree(entry.path)) continue;
    examined += 1;
    const { branch } = entry;
    const changes = trackedChanges(entry.path, { run });
    // A WORKTREE WE COULD NOT READ IS NOT A CLEAN ONE. Dropping it silently would make the head line
    // ("N examined, M carry changes") true of a population quietly smaller than N -- the exact defect this
    // report exists to end, one level in. It is counted separately because it needs a different action:
    // a stranded change needs a disposition, an unreadable worktree needs looking at.
    if (changes === "unknown") { unreadable.push(entry.path); continue; }
    if (changes.files === 0) continue;
    stranded.push({
      path: entry.path,
      branch: entry.branch,
      ...changes,
      // COMMITS THE BRANCH HAS THAT `origin/main` LACKS, not merely "is it merged".
      //
      // The row asked for the boolean and the boolean is ambiguous in the commonest case, which I found by
      // running this against the live host: a branch cut from `main` minutes ago with uncommitted work in
      // it reads `merged`, identically to a branch whose commits landed a week ago. One is work in
      // progress and the other is a leftover, and calling the first a leftover is the report telling a
      // reader to discard a session's live working directory. The COUNT separates them and the boolean
      // cannot. A detached worktree has no branch to ask about, so both are `"unknown"`.
      // THE TRISTATE SURVIVES THE COMPARISON. `mergeStatus` returns "merged" | "not-merged" | "unknown",
      // and `=== "merged"` collapsed the last two into one `false` -- so a merge status nobody could read
      // rendered as "is not an ancestor of origin/main", a positive claim from an unanswerable question.
      // worker-judge, reviewing #1058, and it is `trackedChanges`'s own rule turned on me: "could not
      // ask" and "the answer is no" are different reports.
      onMain: branch === null ? "unknown" : mergedTristate(mergeStatus(repoRoot, branch, { run })),
      commitsAhead: entry.branch === null ? "unknown" : commitsNotOnMain(repoRoot, entry.branch, { run }),
      retiredSession: branch !== null && RETIRED_BRANCH_PREFIXES.some((prefix) => branch.startsWith(prefix)),
    });
  }
  return { examined, stranded, unreadable };
}

/**
 * Which `PruneReport` bucket a `classify` verdict other than `"remove"` lands in.
 * @type {Record<"dirty" | "cherry-picked" | "inconclusive" | "active",
 *   "dirty" | "cherryPicked" | "inconclusive" | "active">}
 */
const VERDICT_BUCKET = {
  active: "active", "cherry-picked": "cherryPicked", inconclusive: "inconclusive", dirty: "dirty",
};

/**
 * The whole flow: list, classify, remove the clean+merged, name the rest, never touch the primary.
 *
 * @param {string} repoRoot the repository whose `git worktree list` is authoritative
 * @param {{ run?: typeof defaultRun, remove?: (path: string, deps: { run: typeof defaultRun }) => void,
 *   now?: number, dryRun?: boolean, hash?: (file: string) => string }} [deps] `dryRun` skips the removal
 *   and nothing else -- same walk, same predicate, same buckets, so the listing is the tool's own answer
 *   rather than a second one. `hash` reads a `runs/` record's sha256 (#1373).
 * @returns {PruneReport}
 */
export function pruneWorktrees(repoRoot, { run = defaultRun, remove, now = Date.now(), dryRun = false, hash } = {}) {
  const porcelain = run("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
  const entries = parseWorktreeList(porcelain);
  const primaryPath = entries.find((entry) => isPrimaryWorktree(entry.path))?.path ?? null;
  /** @type {PruneReport} */
  const report = {
    removed: [], records: [], dirty: [], cherryPicked: [], inconclusive: [], active: [], skippedPrimary: null,
  };
  const doRemove = remove ?? ((path, { run: r }) => {
    r("git", ["worktree", "remove", path], { cwd: repoRoot });
  });

  for (const entry of entries) {
    if (isPrimaryWorktree(entry.path)) {
      report.skippedPrimary = entry.path;
      continue;
    }
    const reported = { path: entry.path, branch: entry.branch };
    const assessment = assessWorktree(repoRoot, entry, { run, now });
    const verdict = classify(assessment);
    if (verdict === "remove") {
      // #1373: merged and clean is a fact about what GIT tracks; the gitignored records go with the directory.
      const held = unverifiedRecords(entry.path, primaryPath, { hash });
      if (held.refused) {
        report.records.push({ ...reported, reason: held.reason });
        continue;
      }
      // `dryRun` SKIPS THE REMOVAL AND NOTHING ELSE -- same walk, same predicate, same buckets. The
      // listing has to come from the tool that owns the decision, because the alternative was measured:
      // a hand-rolled re-implementation of this predicate reported 99 of 114 worktrees "unmerged" on a
      // tree where a directly-tested branch was merged. A uniform answer across a varied set is a broken
      // checker, and re-implementing a predicate beside the thing that owns it is this repository's
      // fact-stated-twice shape, arriving through a listing.
      //
      // AND THE TOOL'S SAFETY AND THE HAZARD ARE ABOUT DIFFERENT THINGS. This guarantees the BRANCH is
      // merged and the TREE is clean. The hazard is about the SESSION: whether anyone is standing in that
      // directory. A merged, clean worktree can still be somebody's current working directory, and no
      // branch-level check can see that -- their next `cd` fails and the command runs in the PRIMARY
      // checkout instead, which is the fleet-driving tree `assertFleetRunsThisCheckout` hashes.
      if (!dryRun) doRemove(entry.path, { run });
      report.removed.push(reported);
    } else {
      report[VERDICT_BUCKET[verdict]].push(reported);
    }
  }
  return report;
}

/** Appends a header plus one indented line per entry -- and nothing at all when `entries` is empty.
 * @param {string[]} lines @param {ReportedWorktree[]} entries @param {string} header */
function pushSection(lines, entries, header) {
  if (entries.length === 0) return;
  lines.push(header);
  for (const e of entries) lines.push(`  ${e.path}  (${e.branch ?? "detached"})`);
}

/**
 * What `main()` prints. EXPORTED for #1373's test: a fixture cannot be made to look inactive through argv,
 * because the CLI's own `git status` rewrites the index `recentGitActivity` dates it by.
 * @param {PruneReport} report
 */
export function formatReport(report, dryRun = false) {
  // WOULD REMOVE versus REMOVED, never the same word. A listing that says "removed" is indistinguishable
  // from a run that removed, and the whole purpose of the dry run is that a session can read the list one
  // cycle before its directory disappears.
  const lines = [dryRun
    ? `WOULD REMOVE ${report.removed.length} worktree(s) -- nothing has been removed; pass --apply to `
      + "remove them, and announce the list one cycle first so no session loses its working directory:"
    : `removed ${report.removed.length} worktree(s):`];
  for (const r of report.removed) lines.push(`  ${r.path}  (${r.branch ?? "detached"})`);
  if (report.records.length > 0) {
    lines.push(`refused ${report.records.length} worktree(s) holding ${RECORDS_DIR}/ records not verified in the `
      + "primary checkout (#1373) -- nothing removed:");
    for (const r of report.records) lines.push(`  ${r.path}  (${r.branch ?? "detached"}): ${r.reason}`);
  }
  pushSection(lines, report.dirty,
    `refused ${report.dirty.length} DIRTY worktree(s) -- uncommitted or unmerged work, named, nothing removed:`);
  pushSection(lines, report.active,
    `${report.active.length} ACTIVE worktree(s) -- merged and clean, but git activity inside the last `
    + `${Math.round(ACTIVITY_WINDOW_MS / 60000)} minute(s); a session may be mid-command, nothing removed:`);
  pushSection(lines, report.inconclusive,
    `${report.inconclusive.length} INCONCLUSIVE worktree(s) -- merge, clean or activity status could not `
    + `be determined; never guessed at, nothing removed:`);
  pushSection(lines, report.cherryPicked,
    `${report.cherryPicked.length} CHERRY-PICKED worktree(s) -- content already on main under different `
    + `commits, not a literal ancestor; a human decides, nothing removed:`);
  if (report.skippedPrimary) lines.push(`primary checkout, never touched: ${report.skippedPrimary}`);
  return lines.join("\n");
}

/**
 * The stranded-work report, with its EXAMINED COUNT in the first line -- #933.
 *
 * "6 of 81 worktrees" and "6" are different claims, and only the first can be wrong in a way a reader
 * notices: a sweep that walked nothing reports no stranded work, which is the cleanest possible output and
 * indistinguishable from a clean host. The count is the part that makes the zero mean something.
 * @param {ReturnType<typeof strandedWork>} read
 * @returns {string}
 */
export function formatStranded({ examined, stranded, unreadable = [] }) {
  const head = `${examined} worktree(s) examined, ${stranded.length} carry uncommitted TRACKED changes`
    + (unreadable.length > 0 ? `, ${unreadable.length} COULD NOT BE READ (${unreadable.join(", ")})` : "")
    + " (untracked-only trees are not listed: macOS writes `.metadata_never_index` into every one)";
  if (stranded.length === 0) return `${head}.`;
  const lines = [`${head} -- NOTHING HAS BEEN REMOVED, this section only reports:`];
  for (const w of stranded) {
    const where = w.commitsAhead === "unknown" ? "detached, no branch to place"
      : w.commitsAhead === 0
        ? `its branch adds no commit origin/main lacks${w.onMain ? "" : " (and is not an ancestor of it)"}`
          + " -- the uncommitted change is ALL the work there is"
        : `its branch has ${w.commitsAhead} commit(s) origin/main lacks`
          + (w.onMain ? ", though its tip is an ancestor" : " -- an unfinished unit");
    lines.push(`  ${w.path}`);
    lines.push(`    ${w.branch ?? "detached"} -- ${w.files} tracked file(s), +${w.insertions} -${w.deletions}; ${where}`
      + (w.retiredSession ? "; BRANCH PREFIX NAMES A RETIRED SESSION -- nobody to ask" : ""));
  }
  return lines.join("\n");
}

async function main() {
  // Guarded per #164: positional repo root; git flags go onward.
  refuseUnknownFlags(["--apply"],
    { entry: import.meta.url, command: "node packages/agent-org/src/prune-worktrees.mjs" });
  // THE DEFAULT IS THE LISTING, AND IT IS THE WRONG WAY ROUND UNTIL IT IS NOT. Measured 2026-09-09: a
  // session ran `npm run worktrees:prune` to READ its breakdown before writing a row about worktree
  // accounting, and it removed three worktrees belonging to three other sessions. No work was lost -- the
  // tool refuses anything dirty or unmerged -- but a command whose name reads as a report, on a host with
  // nine live sessions, is one somebody runs to look.
  //
  // `lab:reset` already has this shape (`-e apply=true`) and for the same reason: it exists because the
  // manual alternative once destroyed release-eligible weights.
  const dryRun = !process.argv.includes("--apply");
  const positional = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const repoRoot = positional ?? process.cwd();
  const root = statSync(repoRoot).isDirectory() ? repoRoot : process.cwd();
  const report = pruneWorktrees(root, { dryRun });
  process.stdout.write(formatReport(report, dryRun) + "\n");
  // #933: PRINTED ON EVERY RUN, INCLUDING `--apply`, and after the removals rather than instead of them.
  // The prune already refuses a dirty worktree; the gap this closes is that nobody hears the refusal, so
  // the report has to be in the output somebody already reads rather than behind a flag they would have to
  // know about.
  process.stdout.write(`\n${formatStranded(strandedWork(root))}\n`);
}

import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
// #1373: RELATIVE, not `@a11ign/worker-fleet/cli-flags` -- `row-claim.mjs` imports this file now, and
// `close-rows-for-merged-pr.mjs`, `close-rows-sweep.mjs` and `workflow-run-liveness.mjs` run it before
// `npm ci`, where a package specifier dies (`pre-install-import-graph.test.ts`).
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  main();
}
