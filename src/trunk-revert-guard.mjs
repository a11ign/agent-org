#!/usr/bin/env node
// @ts-check
// command: compare main's before/after state on a merge and refuse one that silently deletes prior work
// #411: A MERGE CAN DELETE WORK ALREADY ON `main`, AND EVERY CHECK PASSES.
//
// 2026-09-07: PR #232's branch merged `main` in, resolved conflicts by taking its own side, and reverted
// four units that had already merged -- #363, #340, #376 and #158. `main` carried the loss for over an
// hour, and nothing caught it:
//
//   - CI ran #232's own diff and its own tests. Nothing asserts "this branch did not revert someone else".
//   - `gate` was green because the reverted work was removed CONSISTENTLY -- source and tests together --
//     so no test was left pointing at a deleted function. A partial revert would have been caught; a
//     complete one is invisible.
//   - `merge-guard`/`mergeSafety` read the PR, not what its conflict resolution discarded.
//   - The merge is a normal, legal git merge. There is nothing malformed to detect.
//
// ## THE ROOT CAUSE IS NOT WHERE IT LOOKS -- traced live against f2cdfaf3, not assumed
//
// The obvious check -- `git merge-tree` the merge's own two direct parents and see whether the auto-
// computed clean merge disagrees with what was actually committed -- FAILS on this exact incident. The
// branch's tip (f2cdfaf3^2) had already permanently lost `furniture-heading-guard.test.ts` several
// commits earlier, at its OWN internal "merge origin/main into the branch" step (3d38dbf0) -- so by the
// time the FINAL merge into `main` happens, a clean re-merge of its two direct parents produces the
// SAME missing file, because the branch's history has already baked the loss in. The defect can live
// arbitrarily many internal syncs deep, not only at the outermost merge.
//
// So can GitHub's own `gh pr view --json files` -- it reports the SAME file, because GitHub computes a
// PR's compare diff the same way: everything that differs between the base and the branch tip, including
// collateral damage. That is not a distinguishing signal; it is a description of the same aggregate.
//
// ## THE ACTUAL DISCRIMINATOR, VERIFIED AGAINST BOTH FIXTURES
//
// A path deleted by the merge (present in the merge's first parent, absent in the merge result) is
// EXPLAINED if and only if some non-merge commit UNIQUE TO THE BRANCH (reachable from the second parent,
// not from the first) actually touched that path -- `git log --no-merges <first>..<second> -- <path>`.
// Empty means nothing on the branch's own real work ever mentions the file; its disappearance can only
// be an artefact of how a merge conflict was resolved, however many internal syncs deep.
//
//   furniture-heading-guard.test.ts (the incident): EMPTY -- #189's own branch never touched it. UNEXPLAINED.
//   build-bootstrap-no-workspace-imports.test.ts (#354, a deliberate consolidation): `ca922204 test: one
//     guard for pre-install imports, not two` -- a real commit, on the branch, naming the deletion. EXPLAINED.
//
// Merge commits are excluded from that log (`--no-merges`) on purpose: a commit that is ITSELF a sync
// merge proves nothing about intent -- it is exactly the kind of commit whose own conflict resolution is
// what this guard exists to catch, and counting it as "the branch explained this" would let the incident
// explain itself.
//
// ## WHAT THIS DOES NOT YET COVER, STATED RATHER THAN HIDDEN
//
// Three of the seven paths in the real incident were reverted in CONTENT rather than deleted (`docs/
// coverage.md` among them). This first version reads only D (deleted) lines from `git diff --name-status
// <merge>^1 <merge>` -- a file whose content was silently reverted without disappearing is out of scope
// and the refusal/pass message says so, per this repo's own rule that an unstated bound reads as
// completeness.
//
// ## RIDES trunkGate, NOT A NEW JOB -- ceo's ruling: REVERT, never warn
//
// This runs as an added STEP inside `trunk.yml`'s existing `trunkGate` job, never a separate one.
// A refusal here fails that job exactly like a failing test would, which is what makes `decideRevert`
// (`if: needs.trunkGate.result == 'failure'`) fire and drive `trunk-revert.mjs` -- the EXISTING revert
// machinery, unmodified. Unit 3 already reverts a push that fails `gate`; this is the identical class,
// not a new mechanism needing its own revert path.
//
// `git fetch origin` runs immediately before the diff below, not only at checkout -- worker-contracts'
// finding, 2026-09-07: a stale local `origin/main` made a legitimate file read as an unexplained
// deletion, a false alarm from the guard's OWN stale ref rather than from the merge under test. Put in
// the script, not left to the workflow's checkout step to get right.
//
// Exit codes are the contract:
//   0  PASS -- no unexplained deletion, or nothing to check (not a real merge)
//   1  REFUSE -- one or more deleted paths are unexplained by the branch's own history. NAMED, never counted.
//   2  a lookup failed. INCONCLUSIVE, never "fine".
//
//   node packages/agent-org/src/trunk-revert-guard.mjs --merge=<sha>
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags, flagValue } from "../../worker-fleet/src/cli-flags.mjs";
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";

export const EXIT = { PASS: 0, REFUSE: 1, CANNOT_ASK: 2 };

/**
 * PURE. Which deleted paths are unexplained by the branch's own non-merge commits.
 * @param {{ deletedPaths: string[], branchTouchedPaths: Set<string> }} input
 * @returns {string[]}
 */
export function unexplainedDeletions({ deletedPaths, branchTouchedPaths }) {
  return deletedPaths.filter((p) => !branchTouchedPaths.has(p));
}

/** @param {string[]} args */
function git(args) {
  return execFileSync("git", args, { encoding: "utf8", env: sandboxGitEnv() }).trim();
}

/**
 * The merge's parents, or null when `sha` is not a two-parent merge commit (an ordinary, non-merge push
 * to main -- nothing to check; this guard is about CONFLICT RESOLUTION, which only a merge can have).
 * @param {string} sha
 * @returns {{ p1: string, p2: string } | null}
 */
export function mergeParents(sha, git_ = git) {
  const parents = git_(["log", "-1", "--format=%P", sha]).split(/\s+/).filter(Boolean);
  if (parents.length !== 2) return null;
  return { p1: parents[0], p2: parents[1] };
}

/**
 * Deleted paths: present in `p1`, absent from `merge` -- the D lines of `git diff --name-status p1 merge`.
 * @param {string} p1
 * @param {string} merge
 */
export function deletedPaths(p1, merge, git_ = git) {
  return git_(["diff", "--name-status", p1, merge]).split("\n").filter(Boolean)
    .filter((line) => line.startsWith("D\t"))
    .map((line) => line.slice(2));
}

/**
 * Paths any NON-MERGE commit unique to the branch (reachable from `p2`, not from `p1`) actually touched.
 * @param {string} p1
 * @param {string} p2
 * @param {string[]} paths
 */
export function branchTouchedPaths(p1, p2, paths, git_ = git) {
  const touched = new Set();
  for (const path of paths) {
    const log = git_(["log", "--no-merges", "--oneline", `${p1}..${p2}`, "--", path]);
    if (log.length > 0) touched.add(path);
  }
  return touched;
}

function main() {
  refuseUnknownFlags(["--merge"], { entry: import.meta.url, command: "node packages/agent-org/src/trunk-revert-guard.mjs" });

  const merge = flagValue(process.argv, "merge");
  if (!merge) {
    console.error("CANNOT ASK: need --merge=<sha>.\n  node packages/agent-org/src/trunk-revert-guard.mjs --merge=<sha>");
    process.exit(EXIT.CANNOT_ASK);
  }

  try {
    execFileSync("git", ["fetch", "origin", "--quiet"], { stdio: "pipe", env: sandboxGitEnv() });
  } catch (cause) {
    console.error(`CANNOT ASK: git fetch origin failed -- ${cause instanceof Error ? cause.message : cause}`);
    process.exit(EXIT.CANNOT_ASK);
  }

  let parents;
  try {
    parents = mergeParents(merge);
  } catch (cause) {
    console.error(`CANNOT ASK: resolving ${merge}'s parents failed -- `
      + `${cause instanceof Error ? cause.message : cause}`);
    process.exit(EXIT.CANNOT_ASK);
  }

  if (!parents) {
    console.log(`TRUNK-REVERT-GUARD: ${merge} is not a two-parent merge commit -- nothing to check `
      + "(this guard is about CONFLICT RESOLUTION, which only a merge can have).");
    process.exit(EXIT.PASS);
  }

  const { p1, p2 } = parents;
  let deleted;
  try {
    deleted = deletedPaths(p1, merge);
  } catch (cause) {
    console.error(`CANNOT ASK: diffing ${p1}..${merge} failed -- `
      + `${cause instanceof Error ? cause.message : cause}`);
    process.exit(EXIT.CANNOT_ASK);
  }

  if (deleted.length === 0) {
    console.log(`TRUNK-REVERT-GUARD: ${merge} deletes nothing relative to its first parent -- PASS. `
      + "(Content reverts without deletion are out of scope for this check -- see the script's own header.)");
    process.exit(EXIT.PASS);
  }

  const touched = branchTouchedPaths(p1, p2, deleted);
  const unexplained = unexplainedDeletions({ deletedPaths: deleted, branchTouchedPaths: touched });

  if (unexplained.length === 0) {
    console.log(`TRUNK-REVERT-GUARD: ${merge} deletes ${deleted.length} path(s), and every one is `
      + "explained by a real commit on the branch that touched it -- PASS.");
    process.exit(EXIT.PASS);
  }

  console.error(`TRUNK-REVERT-GUARD: REFUSING ${merge} -- ${unexplained.length} deleted path(s) that no `
    + "non-merge commit on the branch ever touched, which can only be an artefact of how a merge conflict "
    + "was resolved:");
  for (const p of unexplained) console.error(`  ${p}`);
  console.error("Content reverts without a matching deletion are out of scope for this check -- see the "
    + "script's own header.");
  console.error("#655: this is NOT auto-reverted -- trunk.yml's decideRevert deliberately treats a "
    + "trunkGate-only failure as a question this merge's own two parents cannot answer by re-running a "
    + "suite, so it always records `pass` there and takes no automatic action. A human decides: read the "
    + "paths above against what this merge actually resolved. If the deletion was accidental (the #232 "
    + `shape), revert the merge and push: git revert -m 1 ${merge}. If it was deliberate, no action is `
    + "needed here.");
  process.exit(EXIT.REFUSE);
}

// The entry guard `merge-guard.mjs`/`auto-arm-sweep.mjs` use.
if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
