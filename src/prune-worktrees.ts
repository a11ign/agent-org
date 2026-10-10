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
// #4620 (incident #3846), THE ONE RULING THAT NARROWS THE PARAGRAPH ABOVE: a DIRTY tree is removable once its work is a REF
// this tool can name and read back. Deleting another session's uncommitted work stays refused; deleting a directory whose work
// is a branch (`git worktree remove` never deletes the branch) or a `refs/salvage/*` commit is not "deleting work". Two cases
// only, both behind `removeByRef` (the RUN's policy, set by `main()` like the removal limit) and behind every refusal a merged
// tree meets (ACTIVE, HELD, `runs/`, the row's claim): a tracked-clean tree whose HEAD reads back as its branch ref, and a tree
// with tracked edits, SALVAGED first (`git stash create`, so an untracked `node_modules` pile is not swept in, then
// `update-ref refs/salvage/...` and a read-back). Whatever cannot be read back stays DIRTY and says why. Never `--force`.
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
//
// #2020: THE WINDOW TIMES A COMMAND, AND A CLAIM IS NOT A COMMAND. An org session is IDLE BETWEEN WAKES
// by design -- woken by the gate, it works, and then waits hours. Ten minutes does not span that, and the
// unit fires hourly, so a tree somebody still holds gets eight attempts a night. Measured on this host
// 2026-09-22 from the tool's own dry run: `wt-capture-policy` and `wt-tooling-rows` -- the live role trees
// of two running sessions -- were merged, clean, and inside the window by luck alone; nothing else stood
// between them and removal. `heldByOwner` below adds the fact the window cannot carry: whether the tree
// has DELIVERED anything yet. It is not a wider window (see that predicate's header for why widening was
// refused) and it does not touch the window at all.
export const ACTIVITY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes: survives a stash-then-checkout gap; still sweeps
                                            // a truly abandoned tree well within an hour of prune runs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { sandboxGitEnv } from "./lib/git-env.ts";
// RELATIVE for the same reason as `cli-flags.ts` below (#1373): `row-claim.ts` imports this file before
// `pnpm install`, where a package specifier dies.
import { worktreeOwner } from "./worktree-owner.ts";
import { claimRefusal, recordRemoval, rowsClosed } from "./worktree-removal.ts";

/**
 * #3850: HOW LONG A TREE WHOSE ROW HAS CLOSED MUST BE UNTOUCHED BEFORE ITS STAMP STOPS HOLDING IT. `heldByOwner` reads `.a11y-owner`,
 * a COPY of a claim nobody releases, so a tree whose row closed and whose session ended stayed HELD for ever: the 2026-10-06 run
 * refused 269 of 336 worktrees for that reason. The row's state is the fact and the stamp is the copy, so a CLOSED row plus this much
 * git quiet is "the session is gone". SIX HOURS IS A CHOICE, NOT A MEASUREMENT: it is longer than the ten-minute window that guards
 * a command (#220) and than the idle of a session between wakes that #2020 describes in hours, and short enough that a finished tree
 * does not stand through a working day of new claims. The row being closed, not the clock, is what makes a tree finished.
 */
export const CLOSED_ROW_RELEASE_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * #3850: THE MOST TREES ONE RUN REMOVES. Deleting a tree is a `node_modules` unlink, and 336 of them at once is the I/O burst that
 * helped hang the host on 2026-10-06 (#3846). A backlog drains over the hourly runs instead: 25 a run clears the 269 refused in
 * about eleven, and the unit runs niced.
 */
export const MAX_REMOVALS_PER_RUN = 25;

/**
 * #3850: the pause between two removals in one run, so the unlinks do not arrive back to back. SHORT ON PURPOSE: the unit's `Nice=19` and
 * `IOSchedulingClass=idle` are what keep a removal from competing with a session; this only stops twenty-five of them queueing as one burst.
 */
export const PAUSE_BETWEEN_REMOVALS_MS = 250;

/** @type {(ms: number) => void} A synchronous sleep: the whole tool is synchronous, and the pause is the point of the run's shape. */
const sleep: (ms: number) => void = (ms): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** What the removal log names as the asker: this file's own CLI, run hourly by `a11ign-worktree-prune.service`. */
const CALLER = "prune-worktrees.ts";

const defaultRun: (cmd: string, args: string[], opts: { cwd: string; }) => string = (cmd, args, opts): string =>
  execFileSync(cmd, args, { ...opts, env: sandboxGitEnv(), encoding: "utf8" });

export type WorktreeEntry = { path: string, branch: string | null, detached: boolean };

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
export function recentGitActivity(worktreePath: string, { run = defaultRun, now = Date.now(), windowMs = ACTIVITY_WINDOW_MS }: { run?: typeof defaultRun; now?: number; windowMs?: number; } = {}): boolean | "unknown" {
  let gitDir: string;
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
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
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
export function isPrimaryWorktree(worktreePath: string): boolean {
  const gitPath = join(worktreePath, ".git");
  if (!existsSync(gitPath)) return false;
  return lstatSync(gitPath).isDirectory();
}

export type WorktreeAssessment = { path: string, branch: string | null, merge: "merged" | "not-merged" | "unknown", workingTreeClean: boolean | "unknown", contentMerged: boolean, recentlyActive: boolean | "unknown", ignorable: string[], };

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
export function classify({ merge, workingTreeClean, contentMerged, recentlyActive }: Pick<WorktreeAssessment, "merge" | "workingTreeClean" | "contentMerged" | "recentlyActive">): "remove" | "dirty" | "cherry-picked" | "inconclusive" | "active" {
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
export function mergeStatus(repoRoot: string, branch: string, { run = defaultRun }: { run?: typeof defaultRun; } = {}): "merged" | "not-merged" | "unknown" {
  try {
    run("git", ["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: repoRoot });
  } catch {
    return "merged"; // the branch itself is gone -- nothing left to merge or lose
  }
  try {
    run("git", ["merge-base", "--is-ancestor", branch, "origin/main"], { cwd: repoRoot });
    return "merged";
  } catch (error) {
    const status = (error as { status?: number }).status;
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
export function detachedMergeStatus(worktreePath: string, { run = defaultRun }: { run?: typeof defaultRun; } = {}): "merged" | "not-merged" | "unknown" {
  try {
    run("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], { cwd: worktreePath });
    return "merged";
  } catch (error) {
    const status = (error as { status?: number }).status;
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
export function isContentMerged(repoRoot: string, branch: string, { run = defaultRun }: { run?: typeof defaultRun; } = {}): boolean {
  let out: string;
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
export function isWorkingTreeClean(worktreePath: string, deps: { run?: typeof defaultRun; } = {}): boolean | "unknown" {
  // #696, THE THIRD SITE, and THE PARAMETER IS GONE WITH IT. This took a `branch` and said
  // `if (branch === null) return false` -- asserting a detached worktree is DIRTY without running
  // `git status`, which takes no branch name and answers identically either way. Keeping the parameter
  // unused would leave the next reader believing the answer depends on it.
  return cleanliness(worktreePath, deps).clean;
}

/**
 * #2012: WHOSE IGNORE RULES DECIDE, AND WHY THE TREE'S OWN ARE THE WRONG ONES.
 *
 * A linked worktree reads the `.gitignore` AT ITS OWN CHECKED-OUT COMMIT. #1983/#1994 widened this
 * repository's rule from `node_modules/` (a directory only) to `node_modules` (also a SYMLINK), and that
 * fix cannot reach a tree cut before it -- so `git status --porcelain` in 84 of the 128 worktrees the
 * first scheduled prune examined (2026-09-22) read exactly `?? node_modules`, and will read it at every
 * firing for as long as the tree exists. That is not a prune defect: the answer git gave was correct for
 * that tree. It is the wrong tree to have asked.
 *
 * So the PRIMARY checkout is asked instead -- `git check-ignore` run at today's `main`. The file already
 * consults the primary for exactly this class of judgement (`unverifiedRecords` compares `runs/` records
 * against it, #1373), so this is a move the module already makes rather than a new dependency.
 *
 * THE TRISTATE, from `mergeStatus`'s own shape: `check-ignore` exits 1 for its documented "no rule
 * matched" answer and 128 when it could not ask at all (a path outside the repository, an unreadable
 * authority). Reading "anything non-zero" as "not ignored" would be safe HERE -- it refuses -- and would
 * still be the collapse this file exists to stop, so 128 is `"unknown"` and reaches INCONCLUSIVE.
 *
 * NOT `--no-index`, deliberately. Without it, a path the primary TRACKS reads as not-ignored even when a
 * rule also matches it, so a force-added file is refused rather than removed. The conservative arm is the
 * default arm.
 *
 * @param {string} authorityPath the checkout whose ignore rules decide -- the primary, in every real call
 * @param {string} path a path relative to the worktree root, as `git status --porcelain` printed it
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {boolean | "unknown"}
 */
export function ignoredByAuthority(authorityPath: string, path: string, { run = defaultRun }: { run?: typeof defaultRun; } = {}): boolean | "unknown" {
  try {
    run("git", ["check-ignore", "-q", "--", path], { cwd: authorityPath });
    return true;
  } catch (error) {
    const status = (error as { status?: number }).status;
    return status === 1 ? false : "unknown";
  }
}

/**
 * `isWorkingTreeClean`'s answer PLUS the untracked paths that produced it -- because a verdict of
 * "removable" is worth nothing here unless the removal can then happen. `git worktree remove` runs its
 * OWN `git status` inside the tree and refuses on `?? node_modules` exactly as this predicate used to
 * (verified: `fatal: ... contains modified or untracked files, use --force to delete it`). `ignorable`
 * names the paths `pruneWorktrees` must clear first, so git's second guard stays ARMED rather than being
 * waved through with `--force`: anything that appears between the read and the removal still refuses.
 *
 * `ignorable` is EMPTY on every answer but a clean one reached through the authority, so the ordinary
 * path -- a tree git already reads as clean -- clears nothing and behaves exactly as before.
 *
 * WHAT THIS IS NOT: `--untracked-files=no`. An untracked path that today's `main` does not ignore is
 * still work, and still refuses; #220's unrecoverable case is a brand-new file nobody added, which no
 * ignore rule matches. A TRACKED modification refuses whatever else is in the tree, because a single
 * non-`??` entry ends the walk before the authority is asked at all.
 *
 * `--porcelain -z` rather than `--porcelain`: the LF form C-quotes a path containing a space or a
 * quote, and a quoted path is not the path `check-ignore` needs. A rename's second (original) field is
 * not `??`-prefixed, so it lands in the tracked count and the tree reads dirty -- which is correct.
 *
 * @param {string} worktreePath
 * @param {{ run?: typeof defaultRun, ignoreAuthority?: string | null }} [deps]
 * @returns {{ clean: boolean | "unknown", ignorable: string[] }}
 */
export function cleanliness(worktreePath: string, { run = defaultRun, ignoreAuthority = null }: { run?: typeof defaultRun; ignoreAuthority?: string | null; } = {}): { clean: boolean | "unknown"; ignorable: string[]; } {
  let status: string;
  try {
    status = run("git", ["status", "--porcelain", "-z"], { cwd: worktreePath });
  } catch {
    return { clean: "unknown", ignorable: [] };
  }
  const entries = status.split("\0").filter((entry) => entry !== "");
  if (entries.length === 0) return { clean: true, ignorable: [] };
  const untracked = entries.filter((entry) => entry.startsWith("?? ")).map((entry) => entry.slice(3));
  // A single tracked change, or no authority to ask, and the old answer stands unchanged.
  if (untracked.length !== entries.length || ignoreAuthority === null) return { clean: false, ignorable: [] };
  const ignorable: string[] = [];
  for (const path of untracked) {
    const ignored = ignoredByAuthority(ignoreAuthority, path, { run });
    if (ignored === "unknown") return { clean: "unknown", ignorable: [] };
    if (ignored === false) return { clean: false, ignorable: [] };
    ignorable.push(path);
  }
  return { clean: true, ignorable };
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
export function sha256OfFile(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Every non-directory entry under `<root>/runs/`, as a path relative to `root`, sorted. `[]` when there is no
 * `runs/` -- which `unverifiedRecords` checks against the directory itself before believing it.
 * @param {string} root
 * @returns {string[]}
 */
export function listRecordFiles(root: string): string[] {
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
export function primaryWorktreeOf(worktreePath: string, { run = defaultRun }: { run?: typeof defaultRun; } = {}): string | null {
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
function hashOrEmpty(hash: (file: string) => string, file: string, failures: string[]) {
  if (!existsSync(file)) return "";
  try {
    return hash(file);
  } catch (error) {
    failures.push(`${file} (${(error as Error).message})`);
    return "";
  }
}

/**
 * @param {string} worktreePath
 * @param {(root: string) => string[]} list
 * @returns {{ files: string[] } | { reason: string }}
 */
function listedRecords(worktreePath: string, list: (root: string) => string[]): { files: string[]; } | { reason: string; } {
  const dir = join(worktreePath, RECORDS_DIR);
  let files;
  try {
    files = list(worktreePath);
  } catch (error) {
    return { reason: `${dir} could not be listed (${(error as Error).message}) -- refusing to remove ${worktreePath}` };
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
export function unverifiedRecords(worktreePath: string, primaryPath: string | null, { hash = sha256OfFile, list = listRecordFiles }: { hash?: (file: string) => string; list?: (root: string) => string[]; } = {}): { refused: false; listed: number; } | { refused: true; reason: string; } {
  const listing = listedRecords(worktreePath, list);
  if ("reason" in listing) return { refused: true, reason: listing.reason };
  const listed = listing.files;
  if (listed.length === 0) return { refused: false, listed: 0 };
  if (primaryPath === null) {
    return { refused: true, reason: `${worktreePath} holds ${listed.length} ${RECORDS_DIR}/ file(s) and no primary `
      + "checkout could be found to verify them against -- refusing to remove it" };
  }
  const failures: string[] = [];
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
 * #2020: A TREE A SESSION STILL HOLDS, WHICH MERGED+CLEAN+INACTIVE CANNOT SEE.
 *
 * A claim (`row-claim.ts`) makes a worktree and stamps it (`.a11y-owner`, #1128) BEFORE any work
 * happens in it. Until that session's first commit, the tree's HEAD is still a commit on `origin/main`,
 * so `merge-base --is-ancestor` answers MERGED, `git status` answers CLEAN once the ignored entries are
 * discounted, and the only thing left is the activity window -- which times a COMMAND, while a claim is
 * measured in hours. That is not a hypothetical: the two trees the 2026-09-22 dry run named ACTIVE were
 * the role trees of two running sessions, and the ten minutes was luck.
 *
 * THE FACT THAT SEPARATES A HELD TREE FROM A FINISHED ONE IS WHETHER IT HAS DELIVERED ANYTHING, and both
 * halves are on disk, so THIS CHECK spends no API budget (#1950 ruled the prune unit gh-free on that ground; #2782 later added
 * ONE `gh issue view` per otherwise-removable tree in `claimThenRemove`, after the wt-2623 incident showed that this check reads
 * only the COPY of a claim -- see that function and `worktree-prune.service.in`):
 *   - it is STAMPED -- some session said this tree is theirs;
 *   - and its HEAD is a commit on `origin/main`'s OWN FIRST-PARENT LINE, so the branch has produced no
 *     commit of its own. A branch whose work landed is reached by main only THROUGH the merge that
 *     brought it, which makes its tip a second parent and never a point on that line.
 *
 * `commitsNotOnMain` cannot tell these apart and that is why it is not used here: a branch that never
 * committed and a branch whose commits merged both read 0 ahead. First-parent membership is the question
 * that separates "main already contained this commit" from "main had to merge this commit".
 *
 * WHAT THIS DOES NOT PROTECT, said plainly rather than left to be discovered:
 *   - an UNSTAMPED tree, which is every tree made before #1128 and any made without the stamp. Measured
 *     here 2026-09-22: 6 of the 97 merged linked worktrees, one of them a live session's role tree.
 *     `worktree-owner.ts` refuses to invent a stamp for a tree whose owner nobody recorded, and
 *     inventing one here would name whoever ran the prune; the remedy is `pnpm run worktree:stamp`.
 *   - a stamped tree whose owner finished and never released it, which is now refused for ever. That is
 *     the cost, and it is bounded by measurement rather than by hope: on this host 8 of 129 linked trees
 *     are held, 83 of the 91 stamped-and-merged ones still remove. This is not "stop pruning" wearing a
 *     better name, which is the failure the row's own Done-when guards against.
 *   - a repository that merges by FAST-FORWARD or rebase, where a delivered branch's own commits DO land
 *     on the first-parent line, so a finished tree would read as held. The error is a leaked directory
 *     rather than a deleted one, which is the direction this file chooses everywhere else. Every PR here
 *     merges as a merge commit.
 *
 * WIDENING `ACTIVITY_WINDOW_MS` INSTEAD WAS REFUSED, and by the row rather than by preference: a window
 * wide enough for an overnight idle is wide enough to stop the prune doing anything, against a measured
 * leak of about 15 trees a day (#2000). This adds a fact; it does not blunt the clock.
 *
 * #2149: A STANDING TREE IS HELD ON WHAT IT IS, NOT ON WHERE ITS HEAD SITS. Everything above holds a tree
 * only until its own work merges, which is right for a tree made for ONE row and wrong for a tree a session
 * keeps across many: the minute its own commit landed it read `delivered` and sat ten quiet minutes from
 * `--apply`. Work landing is not the session finishing with the tree, and for a standing tree they are
 * weeks apart. THE GROUND, STATED: a tree with NO BRANCH OF ITS OWN -- a detached HEAD -- is a standing
 * checkout. `row-claim` makes every row tree with `-b agent/<slug>-<row>`, so a row tree always has a
 * branch whose delivery can mean "this row is done"; the role and policy trees (`role-*`, `wt-*-policy`,
 * `wt-*-rows`, measured 2026-09-24: all ten stamped, all detached) are moved between rows with
 * `git checkout --detach`, so they have no branch and nothing whose merge could finish them. Detachment is
 * read from git and does not move when a commit merges, which is the property the position test lacked.
 *
 * WHAT THIS COSTS, and what it does not: a row tree its owner detached after delivering is now refused
 * whatever its position (on main's line it already was) -- a leaked directory, the direction this file
 * chooses everywhere. A row tree that stays on its branch still removes once delivered, and that is
 * deliberate rather than a gap: it is disposable, and this row asks for a better question, not a longer
 * timer. An UNSTAMPED standing tree is still unprotected, for the reason given above.
 */

/**
 * Every commit on `origin/main`'s own first-parent line, as a Set -- the commits main HAS rather than the
 * commits main has MERGED. `null` when the walk could not be made at all, which `heldByOwner` treats as a
 * refusal for a stamped tree and never as "it has delivered": the tristate this file keeps everywhere.
 *
 * Asked ONCE per prune run rather than once per worktree, because it is the same answer for all of them.
 *
 * @param {string} repoRoot
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {Set<string> | null}
 */
export function mainLineCommits(repoRoot: string, { run = defaultRun }: { run?: typeof defaultRun; } = {}): Set<string> | null {
  try {
    const out = run("git", ["rev-list", "--first-parent", "origin/main"], { cwd: repoRoot });
    return new Set(out.split("\n").map((line) => line.trim()).filter((line) => line !== ""));
  } catch {
    return null; // could not ask -- never "yes, it delivered"
  }
}

/**
 * Whether this worktree's HEAD is a commit its own branch produced (one main reached by MERGING it),
 * rather than a commit that was already on main's line when the tree was made.
 *
 * @param {string} worktreePath
 * @param {Set<string> | null} mainLine
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {boolean | "unknown"}
 */
export function deliveredOwnCommit(worktreePath: string, mainLine: Set<string> | null, { run = defaultRun }: { run?: typeof defaultRun; } = {}): boolean | "unknown" {
  if (mainLine === null) return "unknown";
  try {
    const head = run("git", ["rev-parse", "HEAD"], { cwd: worktreePath }).trim();
    return head === "" ? "unknown" : !mainLine.has(head);
  } catch {
    return "unknown";
  }
}

/**
 * Whether this worktree's HEAD names a branch. A DETACHED HEAD is the mark of a standing tree (#2149): it
 * was never given a branch, so no merge can mean it is finished.
 *
 * `rev-parse --abbrev-ref HEAD` prints `HEAD` for a detached checkout and the branch name otherwise; a
 * failure is `"unknown"`, never `true` -- an unanswered question must not read as "a disposable row tree".
 *
 * @param {string} worktreePath
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {boolean | "unknown"}
 */
export function hasOwnBranch(worktreePath: string, { run = defaultRun }: { run?: typeof defaultRun; } = {}): boolean | "unknown" {
  try {
    const name = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath }).trim();
    return name === "" ? "unknown" : name !== "HEAD";
  } catch {
    return "unknown";
  }
}

/**
 * #2020: whether `worktreePath` is a tree a session still holds -- see the block header above.
 *
 * @param {string} worktreePath
 * @param {Set<string> | null} mainLine
 * @param {{ run?: typeof defaultRun, owner?: typeof worktreeOwner }} [deps]
 * @returns {{ refused: false } | { refused: true, reason: string }}
 */
export function heldByOwner(worktreePath: string, mainLine: Set<string> | null, { run = defaultRun, owner = worktreeOwner }: { run?: typeof defaultRun; owner?: typeof worktreeOwner; } = {}): { refused: false; } | { refused: true; reason: string; } {
  const who = owner(worktreePath);
  // UNSTAMPED IS "NOBODY SAID", NOT "NOBODY IS THERE" (#1128) -- and it is not a hold either. This gate
  // speaks only about trees whose owner is recorded; the honest gap is named in the header, not papered
  // over by treating an absent stamp as an owner.
  if (who === null) return { refused: false };
  // #2149 FIRST, because it does not depend on the answer below: a standing tree stays held after its
  // own work merges. An unanswered question refuses too -- the tristate this file keeps everywhere.
  const branched = hasOwnBranch(worktreePath, { run });
  if (branched !== true) {
    return { refused: true, reason: `${worktreePath} is stamped ${who} and ${branched === false
      ? "its HEAD is detached -- it has no branch of its own, so it is a STANDING checkout a session moves "
        + "between rows, and its work merging does not mean the session has finished with it (#2149)"
      : "whether it has a branch of its own could not be determined"}. Refusing to remove it` };
  }
  const delivered = deliveredOwnCommit(worktreePath, mainLine, { run });
  if (delivered === true) return { refused: false };
  if (delivered === "unknown") {
    return { refused: true, reason: `${worktreePath} is stamped ${who} and whether its branch has delivered a `
      + "commit of its own could not be determined -- refusing to remove a stamped tree on an unanswered "
      + "question, never guessing that it is finished" };
  }
  return { refused: true, reason: `${worktreePath} is stamped ${who} and its HEAD is a commit on origin/main's own `
    + "first-parent line -- the branch has delivered no commit of its own, so this is a tree a session "
    + "CLAIMED and has not finished with, not one whose work has landed. Refusing to remove it" };
}

/** `recovery` is the line a removed DIRTY tree prints (#4620) and `salvaged` the refs it was pinned under; `reason` is why a DIRTY one stayed. */
export type ReportedWorktree = { path: string, branch: string | null, cleared?: string[], recovery?: string, salvaged?: string[], reason?: string };
export type PruneReport = { removed: ReportedWorktree[], records: (ReportedWorktree & { reason: string })[], held: (ReportedWorktree & { reason: string })[], dirty: ReportedWorktree[], cherryPicked: ReportedWorktree[], inconclusive: ReportedWorktree[], active: ReportedWorktree[], skippedPrimary: string | null, unexamined: number, };

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
 * `ignoreAuthority` (#2012) is the checkout whose ignore rules decide whether an untracked path is work
 * -- the primary, so a tree pinned at a commit predating an ignore-rule fix is not refused for ever over
 * a rule `main` has had since. `null` restores the pre-#2012 reading exactly.
 *
 * @param {string} repoRoot
 * @param {WorktreeEntry} entry
 * @param {{ run: typeof defaultRun, now: number, ignoreAuthority?: string | null }} deps
 * @returns {Pick<WorktreeAssessment,
 *   "merge" | "workingTreeClean" | "contentMerged" | "recentlyActive" | "ignorable">}
 */
function assessWorktree(repoRoot: string, entry: WorktreeEntry, { run, now, ignoreAuthority = null }: { run: typeof defaultRun; now: number; ignoreAuthority?: string | null; }): Pick<WorktreeAssessment, "merge" | "workingTreeClean" | "contentMerged" | "recentlyActive" | "ignorable"> {
  // #696: THIS SAID `: "not-merged"` FOR A DETACHED WORKTREE -- an assertion, not a measurement, and
  // false for twelve of the fifteen detached trees on the live host (0 uncommitted, 0 commits
  // `origin/main` lacks). A commit's merged-ness needs no branch NAME: `merge-base --is-ancestor` takes
  // the commit directly. Detachment makes the STANDING question unanswerable, and made nothing else so.
  const merge = entry.branch !== null
    ? mergeStatus(repoRoot, entry.branch, { run })
    : detachedMergeStatus(entry.path, { run });
  const { clean: workingTreeClean, ignorable } = cleanliness(entry.path, { run, ignoreAuthority });
  const contentMerged = entry.branch !== null && merge === "not-merged"
    && isContentMerged(repoRoot, entry.branch, { run });
  const recentlyActive = merge === "merged" && workingTreeClean === true
    ? recentGitActivity(entry.path, { run, now })
    : false;
  return { merge, workingTreeClean, contentMerged, recentlyActive, ignorable };
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
export function trackedChanges(worktreePath: string, { run = defaultRun }: { run?: typeof defaultRun; } = {}): { files: number; insertions: number; deletions: number; } | "unknown" {
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
export function commitsNotOnMain(repoRoot: string, branch: string, { run = defaultRun }: { run?: typeof defaultRun; } = {}): number | "unknown" {
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
const mergedTristate = (status: string): boolean | "unknown" => (status === "unknown" ? "unknown" : status === "merged");

export type StrandedWorktree = { path: string, branch: string | null, files: number, insertions: number, deletions: number, onMain: boolean | "unknown", commitsAhead: number | "unknown", retiredSession: boolean };

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
export function strandedWork(repoRoot: string, { run = defaultRun }: { run?: typeof defaultRun; } = {}): { examined: number; stranded: StrandedWorktree[]; unreadable: string[]; } {
  const entries = parseWorktreeList(run("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot }));
  const stranded: StrandedWorktree[] = [];
  const unreadable: string[] = [];
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
 * #2012: remove the untracked paths `cleanliness` established today's `main` ignores, so `git worktree
 * remove` -- which runs its own `git status` in the tree -- does not refuse the very tree this run just
 * decided to take. `false` when git could not clear them, which the caller buckets as DIRTY: a tree that
 * cannot be made removable is refused, never forced.
 *
 * ONE PATHSPEC PER PATH, and `-x` because these paths are ignored by the authority but not necessarily by
 * the tree -- `git clean` reads the tree's own rules, which are the stale ones. The pathspec is what keeps
 * this honest: nothing outside the list `cleanliness` returned can be reached.
 *
 * VERIFIED, because the alternative would be catastrophic here: a worktree's `node_modules` is a SYMLINK
 * into the primary's, and `git clean` removes the LINK and not its target (reproduced with content behind
 * the link, 2026-09-23). A recursive delete that followed the link would empty the primary's
 * `node_modules` on the hourly timer.
 *
 * @param {string} worktreePath
 * @param {string[]} ignorable
 * @param {{ run: typeof defaultRun }} deps
 * @returns {boolean} whether the tree is now clear of them
 */
function clearIgnorable(worktreePath: string, ignorable: string[], { run }: { run: typeof defaultRun; }): boolean {
  if (ignorable.length === 0) return true;
  try {
    run("git", ["clean", "-fdx", "--", ...ignorable], { cwd: worktreePath });
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear first, then remove -- and report a tree whose ignorable paths could not be cleared as NOT removed,
 * so the caller buckets it exactly where the stale rule used to put it. A tree that cannot be made
 * removable is refused; it is never forced.
 *
 * @param {string} worktreePath
 * @param {string[]} ignorable
 * @param {{ run: typeof defaultRun, remove: (path: string, deps: { run: typeof defaultRun }) => void }} deps
 * @returns {boolean}
 */
function removeWorktree(worktreePath: string, ignorable: string[], { run, remove }: { run: typeof defaultRun; remove: (path: string, deps: { run: typeof defaultRun; }) => void; }): boolean {
  if (!clearIgnorable(worktreePath, ignorable, { run })) return false;
  remove(worktreePath, { run });
  return true;
}

/**
 * #4620: WHERE A DIRTY TREE'S WORK IS PINNED BEFORE THE TREE IS REMOVED, and the one place this tool writes a ref. `refs/salvage/*` is
 * never pruned by this tool (nor read as a branch by anything here): the ref is the work, and a person decides when it goes.
 */
export const SALVAGE_REF_PREFIX = "refs/salvage/";

/** A salvage commit is authored by the tool, so a host with no git identity configured can still make one and the author names its origin. */
const SALVAGE_IDENTITY = ["-c", "user.name=prune-worktrees", "-c", "user.email=prune-worktrees@localhost"];

/** What a DIRTY tree needs before removal: `salvage` is whether tracked edits must be pinned first; `ignorable` is `cleanliness`'s. */
export type Recovery = { head: string, branch: string | null, salvage: boolean, ignorable: string[] };
export type RecoveryVerdict = { into: "recoverable", recovery: Recovery } | { into: "dirty", reason: string } | { into: "active" } | { into: "inconclusive" };

/**
 * #4620: THE TRACKED CHANGES IN A TREE, SEPARATED FROM ITS UNTRACKED PATHS. `cleanliness` answers one question (is it removable as
 * it stands); a salvage needs two: how many tracked entries there are, and whether any untracked path is WORK (not ignored by the
 * primary). Untracked work is never salvaged -- `stash create` does not carry it and `git worktree remove` refuses it -- so a tree
 * holding it stays DIRTY BEFORE a ref is written, and an hourly run does not leave one salvage ref per hour for a tree git will refuse.
 *
 * @param {string} worktreePath
 * @param {{ run?: typeof defaultRun, ignoreAuthority?: string | null }} [deps]
 * @returns {{ tracked: number, untrackedWork: boolean, ignorable: string[] } | "unknown"}
 */
export function trackedStatus(worktreePath: string, { run = defaultRun, ignoreAuthority = null }: { run?: typeof defaultRun; ignoreAuthority?: string | null; } = {}): { tracked: number; untrackedWork: boolean; ignorable: string[]; } | "unknown" {
  let status: string;
  try {
    status = run("git", ["status", "--porcelain", "-z"], { cwd: worktreePath });
  } catch {
    return "unknown";
  }
  const entries = status.split("\0").filter((entry) => entry !== "");
  const untracked = entries.filter((entry) => entry.startsWith("?? ")).map((entry) => entry.slice(3));
  const ignorable: string[] = [];
  let untrackedWork = false;
  for (const path of untracked) {
    const ignored = ignoreAuthority === null ? false : ignoredByAuthority(ignoreAuthority, path, { run });
    if (ignored === "unknown") return "unknown";
    if (ignored) ignorable.push(path);
    else untrackedWork = true;
  }
  return { tracked: entries.length - untracked.length, untrackedWork, ignorable };
}

/** `git rev-parse --verify <rev>^{commit}`'s sha; THROWS when the name does not resolve to a commit. */
function readCommit(cwd: string, rev: string, run: typeof defaultRun): string {
  return run("git", ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { cwd }).trim();
}

/**
 * #4620: DOES A DIRTY TREE'S WORK LIVE IN A REF, AND IS THE TREE OTHERWISE FREE TO GO? Called only for a `classify` verdict of
 * `"dirty"` (a cherry-picked tree is a human's, and an inconclusive one is not guessed at). It asks, in this order, and a tree
 * that fails one is reported in the bucket the question names and never salvaged:
 *   1. ACTIVE: git activity inside the window -- asked HERE because `assessWorktree` only asks it of a merged, clean tree, and
 *      a tree with a tracked edit is the one a session is most likely standing in. A tree it cannot ask about is INCONCLUSIVE.
 *   2. untracked work (see `trackedStatus`): DIRTY, nothing written.
 *   3. HEAD read back: a named branch must resolve, as `refs/heads/<branch>`, to the SAME sha as HEAD -- the ref a surviving
 *      branch is. A branch whose ref is missing or elsewhere is DIRTY; so is a DETACHED tree with no tracked edit, whose commits
 *      no ref names (that population is not this row's: only edits are pinned there).
 * A detached tree WITH tracked edits is recoverable: `salvageTracked` pins its HEAD and the edits.
 *
 * @param {string} repoRoot
 * @param {WorktreeEntry} entry
 * @param {{ run: typeof defaultRun, now: number, ignoreAuthority: string | null }} deps
 * @returns {RecoveryVerdict}
 */
export function recoveryFor(repoRoot: string, entry: WorktreeEntry, { run, now, ignoreAuthority }: { run: typeof defaultRun; now: number; ignoreAuthority: string | null; }): RecoveryVerdict {
  const active = recentGitActivity(entry.path, { run, now });
  if (active === "unknown") return { into: "inconclusive" };
  if (active) return { into: "active" };
  const status = trackedStatus(entry.path, { run, ignoreAuthority });
  if (status === "unknown") return { into: "inconclusive" };
  if (status.untrackedWork) {
    return { into: "dirty", reason: "it holds untracked files the primary checkout does not ignore, which no ref carries and `git worktree remove` refuses" };
  }
  let head = "";
  try {
    head = readCommit(entry.path, "HEAD", run);
  } catch {
    // left empty: the refusal below is the same for a HEAD that does not resolve and one that prints nothing
  }
  if (head === "") return { into: "dirty", reason: "its HEAD does not resolve to a commit, so there is nothing to read back" };
  if (entry.branch === null) {
    if (status.tracked === 0) {
      return { into: "dirty", reason: `its HEAD is detached at ${head.slice(0, 12)} and no ref holds it, and it has no tracked edit to pin` };
    }
    return { into: "recoverable", recovery: { head, branch: null, salvage: true, ignorable: status.ignorable } };
  }
  let named = "";
  try {
    named = readCommit(repoRoot, `refs/heads/${entry.branch}`, run);
  } catch {
    // an unresolved name is the same answer as one that resolves elsewhere: no ref reads back as HEAD
  }
  if (named === "" || named !== head) {
    return { into: "dirty", reason: `refs/heads/${entry.branch} ${named === "" ? "does not resolve" : `reads ${named.slice(0, 12)}`}, not HEAD ${head.slice(0, 12)}, so no surviving ref holds its commits` };
  }
  return { into: "recoverable", recovery: { head, branch: entry.branch, salvage: status.tracked > 0, ignorable: status.ignorable } };
}

/** A tree's directory name as one ref component: what git allows, nothing it could mistake for a range, a lock or a hidden name. */
function salvageTreeName(worktreePath: string): string {
  const name = basename(worktreePath).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".").replace(/^[.-]+/, "");
  return name === "" ? "tree" : name;
}

/** Creates `ref` at `sha` (refusing to move one that exists) and reads it back; THROWS unless it reads back as `sha`. */
function pinRef(repoRoot: string, ref: string, sha: string, run: typeof defaultRun): string {
  run("git", ["check-ref-format", ref], { cwd: repoRoot });
  run("git", ["update-ref", ref, sha, ""], { cwd: repoRoot });
  const back = readCommit(repoRoot, ref, run);
  if (back !== sha) throw new Error(`${ref} reads back as ${back === "" ? "nothing" : back}, not ${sha}`);
  return ref;
}

/**
 * #4620: THE SALVAGE. Pins what the tree holds that no branch does, READS EACH REF BACK, and only then reports the refs the caller
 * may remove the tree on. A DETACHED head is pinned first (`<name>-head-<epoch>`); tracked edits are `git stash create`d (tracked
 * only: no `-u`, so an untracked pile is never swept in) and pinned as `<name>-<epoch>`. Nothing here moves the working tree, the
 * index or any existing ref.
 *
 * IDEMPOTENT, because the prune is hourly and git has guards of its own: a tree salvaged, then refused by `git worktree remove`
 * (a lock, a submodule) is looked at again an hour later, and writing a second ref for work already pinned would leave 24 a day.
 * An existing ref for the same tree whose commit has the SAME tree object and the same first parent is the same work and is reused.
 *
 * @param {string} worktreePath
 * @param {string} repoRoot
 * @param {Recovery} recovery
 * @param {{ run: typeof defaultRun, now: number }} deps
 * @returns {{ refs: string[], edits: string } | { reason: string }} the refs and the commit holding the edits (the one the tree is
 *   then held to, see `discardPinnedEdits`), or why none could be trusted -- the tree then stands, DIRTY
 */
export function salvageTracked(worktreePath: string, repoRoot: string, recovery: Recovery, { run, now }: { run: typeof defaultRun; now: number; }): { refs: string[]; edits: string; } | { reason: string; } {
  const epoch = Math.floor(now / 1000);
  const name = salvageTreeName(worktreePath);
  const mine = new RegExp(`^${SALVAGE_REF_PREFIX}${name.replace(/[.]/g, "\\.")}-(head-)?\\d+$`);
  try {
    const listed = run("git", ["for-each-ref", "--format=%(refname) %(objectname) %(tree) %(parent)", `${SALVAGE_REF_PREFIX}${name}-*`], { cwd: repoRoot })
      .split("\n").filter((line) => line.trim() !== "").map((line) => line.split(" "))
      .filter(([ref]) => mine.test(ref));
    const refs: string[] = [];
    if (recovery.branch === null) {
      const pinned = listed.find(([ref, sha]) => /-head-\d+$/.test(ref) && sha === recovery.head);
      refs.push(pinned !== undefined ? pinned[0] : pinRef(repoRoot, `${SALVAGE_REF_PREFIX}${name}-head-${epoch}`, recovery.head, run));
    }
    const created = run("git", [...SALVAGE_IDENTITY, "stash", "create"], { cwd: worktreePath }).trim();
    if (created === "") {
      return { reason: "`git stash create` printed no commit for a tree that reads as carrying tracked changes, so there is nothing to read back" };
    }
    const createdTree = run("git", ["rev-parse", "--verify", `${created}^{tree}`], { cwd: repoRoot }).trim();
    const same = listed.find(([ref, , tree, parent]) => !/-head-\d+$/.test(ref) && tree === createdTree && parent === recovery.head);
    refs.push(same !== undefined ? same[0] : pinRef(repoRoot, `${SALVAGE_REF_PREFIX}${name}-${epoch}`, created, run));
    return { refs, edits: same !== undefined ? readCommit(repoRoot, same[0], run) : created };
  } catch (cause) {
    return { reason: `its work could not be pinned under ${SALVAGE_REF_PREFIX} and read back (${(cause as Error).message.split("\n")[0]})` };
  }
}

/**
 * #4620: MAKE THE TREE CLEAN BY DISCARDING EXACTLY WHAT IS PINNED, so `git worktree remove` -- WITHOUT `--force`, which the row
 * forbids and which stays the last guard -- has nothing of the tree's to refuse. Git refuses any tree with a modified tracked file
 * (measured: `contains modified or untracked files, use --force to delete it`), so a salvage that stopped at the ref could never
 * be followed by a removal. THE ORDER IS THE SAFETY: this runs only after `salvageTracked` read every ref back, and it first asks
 * git whether the working tree still EQUALS the pinned commit (`diff --quiet <commit>`: tracked paths only, staged and unstaged
 * alike), so an edit made after the salvage is a refusal rather than a discard. Untracked paths are not touched by `reset --hard`.
 *
 * @param {string} worktreePath @param {string} edits the commit `salvageTracked` pinned @param {typeof defaultRun} run
 */
function discardPinnedEdits(worktreePath: string, edits: string, run: typeof defaultRun) {
  try {
    run("git", ["diff", "--quiet", edits], { cwd: worktreePath });
  } catch {
    throw new Error(`the tree changed since its tracked edits were pinned at ${edits.slice(0, 12)}, so they are not all in a ref`);
  }
  run("git", ["reset", "--hard", "--quiet", "HEAD"], { cwd: worktreePath });
}

/**
 * #2782: THE REMOVAL, WITH ITS LINE. One `removing` line BEFORE the delete and one `removed` or `failed` after it, so the
 * log names a tree whose removal was begun and never finished, and so a crash mid-delete is still a line. A log that cannot be
 * written REFUSES the removal (`logged: false`): a delete nobody can see is the defect this row exists to end.
 *
 * @param {ReportedWorktree} reported @param {string[]} ignorable
 * @param {{ run: typeof defaultRun, remove: (path: string, deps: { run: typeof defaultRun }) => void,
 *   record: typeof recordRemoval, reason?: string }} deps `reason` is the log's: "merged, clean ..." unless #4620 removed the tree by a ref
 * @returns {{ done: true } | { done: false, logged: boolean }}
 */
function removeAndRecord(reported: ReportedWorktree, ignorable: string[], { run, remove, record, reason = "merged, clean, inactive and not held" }: {
        run: typeof defaultRun; remove: (path: string, deps: { run: typeof defaultRun; }) => void;
        record: typeof recordRemoval; reason?: string;
    }): { done: true; } | { done: false; logged: boolean; } {
  const line = { path: reported.path, branch: reported.branch, caller: CALLER, reason };
  try {
    record({ ...line, event: "removing" });
  } catch {
    return { done: false, logged: false };
  }
  try {
    const cleared = removeWorktree(reported.path, ignorable, { run, remove });
    record({ ...line, event: cleared ? "removed" : "refused", detail: cleared ? undefined : "could not clear the ignored entries" });
    return cleared ? { done: true } : { done: false, logged: true };
  } catch (cause) {
    record({ ...line, event: "failed", detail: (cause as Error).message });
    throw cause;
  }
}

/**
 * Which `PruneReport` bucket a `classify` verdict other than `"remove"` lands in.
 * @type {Record<"dirty" | "cherry-picked" | "inconclusive" | "active",
 *   "dirty" | "cherryPicked" | "inconclusive" | "active">}
 */
const VERDICT_BUCKET: Record<"dirty" | "cherry-picked" | "inconclusive" | "active", "dirty" | "cherryPicked" | "inconclusive" | "active"> = {
  active: "active", "cherry-picked": "cherryPicked", inconclusive: "inconclusive", dirty: "dirty",
};

/**
 * #2782: THE ROW'S CLAIM, LAST OF THE REFUSALS BECAUSE IT IS THE ONLY ONE THAT COSTS AN API CALL and is asked only of a tree every
 * other check has passed; then the removal itself, with its log line. `.a11y-owner` (read by `heldByOwner`) is the COPY of the claim
 * that a claim's re-creation can lose; the `session:` label on the row is the fact itself.
 *
 * @param {ReportedWorktree} reported @param {string[]} ignorable
 * @param {{ claim?: typeof claimRefusal, dryRun: boolean, run: typeof defaultRun, record?: typeof recordRemoval,
 *   remove: (path: string, deps: { run: typeof defaultRun }) => void }} deps `claim` and `record` default to the real ones
 * @returns {{ into: "removed" } | { into: "dirty" } | { into: "held", reason: string }} (#4620: with `recovery`, a refusal says why)
 */
function claimThenRemove(reported: ReportedWorktree, ignorable: string[], { claim = claimRefusal, dryRun, run, remove, record = recordRemoval, recovery = null, repoRoot = "", now = 0 }: {
        claim?: typeof claimRefusal; dryRun: boolean; run: typeof defaultRun; record?: typeof recordRemoval;
        remove: (path: string, deps: { run: typeof defaultRun; }) => void;
        recovery?: Recovery | null; repoRoot?: string; now?: number;
    }): { into: "removed"; salvaged?: string[]; } | { into: "dirty"; reason?: string; } | { into: "held"; reason: string; } {
  const claimed = claim(reported);
  if (claimed.refused) return { into: "held", reason: claimed.reason };
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
  // #2012: the paths today's `main` ignores go first, or git's own check refuses the removal. A tree
  // that cannot be cleared is DIRTY -- the refusal this replaces, reached by measurement rather than
  // by a stale rule.
  if (dryRun) return { into: "removed" };
  if (recovery !== null) return removeByRecovery(reported, ignorable, recovery, { run, remove, record, repoRoot, now });
  const removal = removeAndRecord(reported, ignorable, { run, remove, record });
  if (removal.done) return { into: "removed" };
  return removal.logged ? { into: "dirty" }
    : { into: "held", reason: "the removal log could not be written -- a delete nobody can see is refused (#2782)" };
}

/**
 * #4620: THE REMOVAL OF A DIRTY TREE, AFTER ITS WORK IS A REF. The salvage comes AFTER the row's claim (a tree the claim refuses is
 * never salvaged, so no ref is left for a tree that stays) and BEFORE the log line, so the line names the refs; the pinned edits are
 * then discarded (`discardPinnedEdits`) so git's own guard, which refuses a modified tree, is satisfied without `--force`. A removal git
 * refuses (a lock, a submodule, an edit that arrived since the salvage) buckets the tree as DIRTY with git's own words: it never
 * ends the run, which would put the same tree at the front of every hour's walk and starve the ones behind it.
 *
 * @param {ReportedWorktree} reported @param {string[]} ignorable @param {Recovery} recovery
 * @param {{ run: typeof defaultRun, remove: (path: string, deps: { run: typeof defaultRun }) => void, record: typeof recordRemoval,
 *   repoRoot: string, now: number }} deps
 * @returns {{ into: "removed", salvaged?: string[] } | { into: "dirty", reason: string } | { into: "held", reason: string }}
 */
function removeByRecovery(reported: ReportedWorktree, ignorable: string[], recovery: Recovery, { run, remove, record, repoRoot, now }: {
        run: typeof defaultRun; remove: (path: string, deps: { run: typeof defaultRun; }) => void;
        record: typeof recordRemoval; repoRoot: string; now: number;
    }): { into: "removed"; salvaged?: string[]; } | { into: "dirty"; reason: string; } | { into: "held"; reason: string; } {
  let salvaged: string[] | undefined;
  let edits: string | null = null;
  if (recovery.salvage) {
    const made = salvageTracked(reported.path, repoRoot, recovery, { run, now });
    if ("reason" in made) return { into: "dirty", reason: made.reason };
    salvaged = made.refs;
    edits = made.edits;
  }
  const reason = salvaged !== undefined
    ? `dirty tree removed once its tracked changes were pinned under ${salvaged.join(", ")} (#4620)`
    : `dirty tree removed once its commits read back as refs/heads/${recovery.branch} at ${recovery.head} (#4620)`;
  try {
    // The discard runs INSIDE the logged removal -- after its `removing` line, before git's own removal -- so a destructive step is a line.
    const discardThenRemove = (path: string, deps: { run: typeof defaultRun; }) => {
      if (edits !== null) discardPinnedEdits(path, edits, run);
      remove(path, deps);
    };
    const removal = removeAndRecord(reported, ignorable, { run, remove: discardThenRemove, record, reason });
    if (removal.done) return { into: "removed", salvaged };
    return removal.logged ? { into: "dirty", reason: "the ignored entries could not be cleared" }
      : { into: "held", reason: "the removal log could not be written -- a delete nobody can see is refused (#2782)" };
  } catch (cause) {
    const refs = salvaged !== undefined ? `; its work stays at ${salvaged.join(", ")}` : "";
    return { into: "dirty", reason: `git refused the removal (${(cause as Error).message.split("\n")[0]})${refs}` };
  }
}

/**
 * #3850: THE OWNER'S HOLD, UNLESS THE ROW HAS RELEASED IT. `heldByOwner` refuses a stamped tree whose branch has delivered nothing or
 * which is detached; this lifts that refusal only when BOTH the tree has been quiet for `CLOSED_ROW_RELEASE_AGE_MS` and every row it
 * names is CLOSED. The quiet is asked first because it is local and the row costs an API call; an unanswered quiet question keeps the
 * hold, as does an unreadable row. Dirty and unmerged trees never get here -- `classify` has already refused them.
 *
 * @param {WorktreeEntry} entry
 * @param {PruneContext} ctx
 * @returns {{ refused: false } | { refused: true, reason: string }}
 */
function heldUnlessReleased(entry: WorktreeEntry, ctx: PruneContext): { refused: false; } | { refused: true; reason: string; } {
  const held = heldByOwner(entry.path, ctx.mainLine, { run: ctx.run });
  if (!held.refused) return held;
  const quiet = recentGitActivity(entry.path, { run: ctx.run, now: ctx.now, windowMs: CLOSED_ROW_RELEASE_AGE_MS });
  if (quiet !== false) return held;
  const row = ctx.rowsClosed(entry);
  return row.closed ? { refused: false } : { refused: true, reason: `${held.reason}. ${row.reason}` };
}

export type PruneContext = { repoRoot: string, run: typeof defaultRun, now: number, dryRun: boolean, primaryPath: string | null, mainLine: Set<string> | null, report: PruneReport, hash?: (file: string) => string, rowsClosed: typeof rowsClosed, pause: () => void, remove: (path: string, deps: { run: typeof defaultRun }) => void, claim?: typeof claimRefusal, record?: typeof recordRemoval, removeByRef: boolean, };

/**
 * One non-primary tree: assess it, then put it in exactly one bucket of `ctx.report`, removing it when nothing refuses.
 *
 * @param {WorktreeEntry} entry
 * @param {PruneContext} ctx
 */
function pruneEntry(entry: WorktreeEntry, ctx: PruneContext) {
  const { report, run } = ctx;
  const reported: ReportedWorktree = { path: entry.path, branch: entry.branch };
  const assessment = assessWorktree(ctx.repoRoot, entry, { run, now: ctx.now, ignoreAuthority: ctx.primaryPath });
  const verdict = classify(assessment);
  // #4620: a DIRTY tree whose work is (or can be made) a ref goes on through every refusal below as a removable one does.
  let recovery: Recovery | null = null;
  if (verdict === "dirty" && ctx.removeByRef) {
    const found = recoveryFor(ctx.repoRoot, entry, { run, now: ctx.now, ignoreAuthority: ctx.primaryPath });
    if (found.into === "recoverable") recovery = found.recovery;
    else {
      if (found.into === "dirty") report.dirty.push({ ...reported, reason: found.reason });
      else report[found.into].push(reported);
      return;
    }
  } else if (verdict !== "remove") {
    report[VERDICT_BUCKET[verdict]].push(reported);
    return;
  }
  const ignorable = recovery !== null ? recovery.ignorable : assessment.ignorable;
  // #2020 BEFORE #1373, and only because it is the cheaper question and the more actionable answer --
  // a tree that is both held and holding records reports the owner who is standing in it. Either
  // refusal removes nothing, so the order decides which reason is printed and nothing else.
  const stillHeld = heldUnlessReleased(entry, ctx);
  if (stillHeld.refused) {
    report.held.push({ ...reported, reason: stillHeld.reason });
    return;
  }
  // #1373: merged and clean is a fact about what GIT tracks; the gitignored records go with the directory.
  const held = unverifiedRecords(entry.path, ctx.primaryPath, { hash: ctx.hash });
  if (held.refused) {
    report.records.push({ ...reported, reason: held.reason });
    return;
  }
  // #3850: the pause sits BEFORE every removal but the run's first, so a run that removes one tree waits for nothing.
  if (!ctx.dryRun && report.removed.length > 0) ctx.pause();
  const outcome = claimThenRemove(reported, ignorable,
    { claim: ctx.claim, dryRun: ctx.dryRun, run, remove: ctx.remove, record: ctx.record, recovery, repoRoot: ctx.repoRoot, now: ctx.now });
  if (outcome.into === "held") report.held.push({ ...reported, reason: outcome.reason });
  else if (outcome.into === "dirty") report.dirty.push(outcome.reason === undefined ? reported : { ...reported, reason: outcome.reason });
  else report.removed.push({ ...reported, cleared: ignorable, ...recoveryNote(recovery, outcome.salvaged, ctx.dryRun) });
}

/**
 * #4620: the report's words for a tree removed by a ref -- `{}` for an ordinary removal -- so the work is findable from the line
 * that says its directory is gone. A dry run has made no ref, so it says one WOULD be.
 * @param {Recovery | null} recovery @param {string[] | undefined} salvaged @param {boolean} dryRun
 * @returns {Pick<ReportedWorktree, "recovery" | "salvaged">}
 */
function recoveryNote(recovery: Recovery | null, salvaged: string[] | undefined, dryRun: boolean): Pick<ReportedWorktree, "recovery" | "salvaged"> {
  if (recovery === null) return {};
  if (!recovery.salvage) return { recovery: `its commits stay on branch ${recovery.branch} at ${recovery.head.slice(0, 12)}` };
  if (dryRun || salvaged === undefined) return { recovery: `tracked changes would first be pinned under ${SALVAGE_REF_PREFIX}` };
  return { recovery: `tracked changes salvaged to ${salvaged.join(", ")}`, salvaged };
}

/**
 * The whole flow: list, classify, remove the clean+merged, name the rest, never touch the primary.
 *
 * @param {string} repoRoot the repository whose `git worktree list` is authoritative
 * @param {{ run?: typeof defaultRun, remove?: (path: string, deps: { run: typeof defaultRun }) => void,
 *   now?: number, dryRun?: boolean, hash?: (file: string) => string, claim?: typeof claimRefusal,
 *   record?: typeof recordRemoval, rowsClosed?: typeof rowsClosed, maxRemovals?: number, pauseMs?: number,
 *   pause?: (ms: number) => void, removeByRef?: boolean }} [deps] `dryRun` skips the removal
 *   and nothing else -- same walk, same predicate, same buckets, so the listing is the tool's own answer
 *   rather than a second one. `hash` reads a `runs/` record's sha256 (#1373). `claim` reads the ROW's claim
 *   (#2782) and `record` writes the removal's log line. `rowsClosed` reads whether the rows a HELD tree names
 *   have closed (#3850). `maxRemovals` ends the walk once that many trees are removed (or, in a dry run, would
 *   be) and counts the trees it did not reach in `unexamined`; it defaults to no limit, because the limit is
 *   a property of a RUN and `main()` is the run. `pauseMs` is the wait between removals, also `main()`'s. `removeByRef`
 *   (#4620) lets a DIRTY tree go once its work is a ref read back (see the file header); it is the run's policy for the same
 *   reason, and a caller that does not name it keeps today's reading of every dirty tree.
 * @returns {PruneReport}
 */
export function pruneWorktrees(repoRoot: string, deps: {
    run?: typeof defaultRun; remove?: (path: string, deps: { run: typeof defaultRun; }) => void;
    now?: number; dryRun?: boolean; hash?: (file: string) => string; claim?: typeof claimRefusal;
    record?: typeof recordRemoval; rowsClosed?: typeof rowsClosed; maxRemovals?: number; pauseMs?: number;
    pause?: (ms: number) => void; removeByRef?: boolean;
} = {}): PruneReport {
  const { run = defaultRun, remove, now = Date.now(), maxRemovals = Infinity, pauseMs = 0, pause = sleep, removeByRef = false } = deps;
  const porcelain = run("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
  const entries = parseWorktreeList(porcelain);
  const primaryPath = entries.find((entry) => isPrimaryWorktree(entry.path))?.path ?? null;
  const report: PruneReport = {
    removed: [], records: [], held: [], dirty: [], cherryPicked: [], inconclusive: [], active: [],
    skippedPrimary: null, unexamined: 0,
  };
  const ctx: PruneContext = {
    repoRoot, run, now, dryRun: deps.dryRun ?? false, primaryPath, report, hash: deps.hash, claim: deps.claim,
    record: deps.record, rowsClosed: deps.rowsClosed ?? rowsClosed, pause: () => pause(pauseMs), removeByRef,
    // #2020: one walk for the whole run, not one per worktree -- it is the same answer for every tree.
    mainLine: mainLineCommits(repoRoot, { run }),
    remove: remove ?? ((path, { run: r }) => { r("git", ["worktree", "remove", path], { cwd: repoRoot }); }),
  };
  for (const entry of entries) {
    if (isPrimaryWorktree(entry.path)) report.skippedPrimary = entry.path;
    else if (report.removed.length >= maxRemovals) report.unexamined += 1;
    else pruneEntry(entry, ctx);
  }
  return report;
}

/** Appends a header plus one indented line per entry -- and nothing at all when `entries` is empty.
 * @param {string[]} lines @param {ReportedWorktree[]} entries @param {string} header */
function pushSection(lines: string[], entries: ReportedWorktree[], header: string) {
  if (entries.length === 0) return;
  lines.push(header);
  for (const e of entries) lines.push(`  ${e.path}  (${e.branch ?? "detached"})${e.reason === undefined ? "" : `: ${e.reason}`}`);
}

/**
 * What `main()` prints. EXPORTED for #1373's test: a fixture cannot be made to look inactive through argv,
 * because the CLI's own `git status` rewrites the index `recentGitActivity` dates it by.
 * @param {PruneReport} report
 */
export function formatReport(report: PruneReport, dryRun = false) {
  // WOULD REMOVE versus REMOVED, never the same word. A listing that says "removed" is indistinguishable
  // from a run that removed, and the whole purpose of the dry run is that a session can read the list one
  // cycle before its directory disappears.
  const lines = [dryRun
    ? `WOULD REMOVE ${report.removed.length} worktree(s) -- nothing has been removed; pass --apply to `
      + "remove them, and announce the list one cycle first so no session loses its working directory:"
    : `removed ${report.removed.length} worktree(s):`];
  // NAMING WHAT WAS DELETED THAT GIT WAS NOT TRACKING (#2012). These paths are removed by the prune
  // itself rather than by `git worktree remove`, and a delete nobody can see in the log is the shape this
  // whole file is about.
  for (const r of report.removed) {
    const cleared = r.cleared !== undefined && r.cleared.length > 0
      ? `  [cleared, ignored by the primary checkout: ${r.cleared.join(", ")}]` : "";
    const recovered = r.recovery !== undefined ? `  [${r.recovery}]` : "";
    lines.push(`  ${r.path}  (${r.branch ?? "detached"})${cleared}${recovered}`);
  }
  if (report.held.length > 0) {
    lines.push(`refused ${report.held.length} HELD worktree(s) (#2020) -- stamped by a session and carrying no `
      + "commit of their own, or standing (detached, #2149), and no closed row has released them (#3850), so the claim is open rather than finished; nothing removed:");
    for (const r of report.held) lines.push(`  ${r.path}  (${r.branch ?? "detached"}): ${r.reason}`);
  }
  if (report.records.length > 0) {
    lines.push(`refused ${report.records.length} worktree(s) holding ${RECORDS_DIR}/ records not verified in the `
      + "primary checkout (#1373) -- nothing removed:");
    for (const r of report.records) lines.push(`  ${r.path}  (${r.branch ?? "detached"}): ${r.reason}`);
  }
  if (report.unexamined > 0) {
    lines.push(`stopped at the per-run removal limit (#3850): ${report.unexamined} worktree(s) not `
      + "examined this run, left for the next one -- a backlog drains over several runs, never in one burst");
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
export function formatStranded({ examined, stranded, unreadable = [] }: ReturnType<typeof strandedWork>): string {
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
    { entry: import.meta.url, command: "node packages/agent-org/src/prune-worktrees.ts" });
  // THE DEFAULT IS THE LISTING, AND IT IS THE WRONG WAY ROUND UNTIL IT IS NOT. Measured 2026-09-09: a
  // session ran `pnpm run worktrees:prune` to READ its breakdown before writing a row about worktree
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
  const report = pruneWorktrees(root, { dryRun, maxRemovals: MAX_REMOVALS_PER_RUN, pauseMs: PAUSE_BETWEEN_REMOVALS_MS, removeByRef: true });
  process.stdout.write(formatReport(report, dryRun) + "\n");
  // #933: PRINTED ON EVERY RUN, INCLUDING `--apply`, and after the removals rather than instead of them.
  // The prune already refuses a dirty worktree; the gap this closes is that nobody hears the refusal, so
  // the report has to be in the output somebody already reads rather than behind a flag they would have to
  // know about.
  process.stdout.write(`\n${formatStranded(strandedWork(root))}\n`);
}

import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
// #1373: RELATIVE, not `@a11ign/screenreader-fleet/cli-flags` -- `row-claim.ts` imports this file now, and
// `close-rows-for-merged-pr.ts`, `close-rows-sweep.ts` and `workflow-run-liveness.ts` run it before
// `pnpm install`, where a package specifier dies (`pre-install-import-graph.test.ts`).
import { refuseUnknownFlags } from "./lib/cli-flags.ts";
if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  main();
}
