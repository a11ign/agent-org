/**
 * THE MERGE ROUTINE MUST BE ABLE TO EXPRESS THE RULE IT ENFORCES.
 *
 * 2026-09-06: the dispatcher merged two commits of a FROZEN branch onto `main` by name, while its PR was
 * open and its author was still fixing the six bugs its own first CI run had surfaced. Both rules it broke
 * had been relayed by that same dispatcher within the hour. The loop took BRANCH NAMES, so it could not
 * see a PR, a review state or a check -- and a routine that cannot express a rule will break it however
 * well the rule is known.
 *
 * `refusalFor` is the whole of the judgement, kept pure so it can be driven here. Every case below is a
 * state that has actually occurred in this repository tonight.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { refusalFor, wantedPrNumber, orphanedCommitsFrom } from "../../../../scripts/merge-queue.mjs";

/** @param {object} over */
const pr = (over: object) => ({
  number: 1, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", isDraft: false,
  statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }], ...over,
});

test("a green, conflict-free PR is the only thing that merges", () => {
  assert.equal(refusalFor(pr({})), null);
});

test("NO CHECKS IS NOT GREEN — the state that let a frozen branch through", () => {
  // Before branch protection exists, a PR with no run is indistinguishable from one whose workflow never
  // triggered. Treating "nothing failed" as "everything passed" is this repo's oldest defect.
  const why = refusalFor(pr({ statusCheckRollup: [] }));
  assert.match(String(why), /no checks have run/);
});

test("a still-running check is HELD, and says so rather than reading as failure", () => {
  const why = refusalFor(pr({ statusCheckRollup: [{ name: "ci", conclusion: null }] }));
  assert.match(String(why), /still running/);
});

test("a failing check names WHICH — a count is where an investigation stops", () => {
  const why = refusalFor(pr({ statusCheckRollup: [{ name: "ci / python", conclusion: "FAILURE" }] }));
  assert.match(String(why), /ci \/ python/);
});

test("a conflicting PR is the OWNER's to rebase, and the refusal says so", () => {
  const why = refusalFor(pr({ mergeable: "CONFLICTING" }));
  assert.match(String(why), /OWNER rebases it/);
});

test("UNKNOWN mergeability is not MERGEABLE — asked-and-answered vs not-yet-computed", () => {
  const why = refusalFor(pr({ mergeable: "UNKNOWN" }));
  assert.match(String(why), /has not computed/);
});

test("SKIPPED and NEUTRAL are not failures — a path-filtered job that did not run is fine", () => {
  // The new `ci` workflow is path-scoped, so most PRs legitimately skip most jobs. Reading a skip as a
  // failure would make the queue permanently empty, which is how a guard gets switched off.
  assert.equal(refusalFor(pr({
    statusCheckRollup: [{ name: "ci / lab", conclusion: "SKIPPED" },
      { name: "ci / lint", conclusion: "SUCCESS" }],
  })), null);
});

test("a draft is held, whatever its checks say", () => {
  assert.match(String(refusalFor(pr({ isDraft: true }))), /draft/);
});

/**
 * `--merge=<n>` AND `--merge <n>` MUST BEHAVE IDENTICALLY (#178).
 *
 * `--merge=156` fell through to the list branch silently before this fix -- a known flag, in the shape
 * every other command in this repo uses, discarded because the hand-rolled parser only matched the
 * space-separated form. On the highest-consequence CLI in the repo (it merges pull requests), that read
 * as "nothing to merge" and nothing said a merge did not happen.
 */
test("--merge=<n> (equals form) is read, not silently dropped to list mode", () => {
  assert.equal(wantedPrNumber(["node", "merge-queue.mjs", "--merge=156"]), "156");
});

test("--merge <n> (space form) still works — the fix must not break the shape that already worked", () => {
  assert.equal(wantedPrNumber(["node", "merge-queue.mjs", "--merge", "156"]), "156");
});

test("both shapes produce the IDENTICAL wanted value for the same PR", () => {
  const equals = wantedPrNumber(["node", "merge-queue.mjs", "--merge=156"]);
  const space = wantedPrNumber(["node", "merge-queue.mjs", "--merge", "156"]);
  assert.equal(equals, space);
});

test("no --merge flag at all means list mode, not a crash", () => {
  assert.equal(wantedPrNumber(["node", "merge-queue.mjs"]), null);
});

test("--merge as the last argument, with nothing after it, is null rather than a stray flag string", () => {
  assert.equal(wantedPrNumber(["node", "merge-queue.mjs", "--merge"]), null);
});

/**
 * A BRANCH'S POST-MERGE COMMITS ARE INVISIBLE, AND THE EVIDENCE THAT WOULD CATCH IT CAN ITSELF VANISH
 * (#152). Found recovering #123: commit `23a2a3e2` landed on `agent/ci-rebuild` AFTER its PR (#109) had
 * already merged an earlier point of the branch. `git log origin/<branch> --not origin/main` would have
 * caught it, but only if run before the branch ref moved again -- on a second run the ref had already
 * gone back to the exact commit that WAS merged, erasing the evidence. So the check has to run at the one
 * point it's guaranteed to see the truth: right after merging, before the branch is deleted.
 */
test("orphanedCommitsFrom: ahead_by 0 after a merge means the branch was fully absorbed", () => {
  const result = orphanedCommitsFrom({ ahead_by: 0, commits: [] });
  assert.ok(result);
  assert.equal(result.count, 0);
  assert.deepEqual(result.commits, []);
});

test("THE #123 SHAPE: commits landed on the branch that the merge never absorbed", () => {
  const result = orphanedCommitsFrom({
    ahead_by: 1,
    commits: [{ sha: "23a2a3e2abcdef", commit: { message: "add board-report/host-address coverage\n\nbody" } }],
  });
  assert.ok(result);
  assert.equal(result.count, 1);
  assert.deepEqual(result.commits, [{ sha: "23a2a3e2abcdef", message: "add board-report/host-address coverage" }]);
});

test("a failed compare lookup is INCONCLUSIVE, never read as zero orphans", () => {
  // Falling through to 0 here would mean "fully absorbed", which is the exact false confidence #152
  // exists to prevent -- a lookup failure must never look like a clean answer.
  assert.equal(orphanedCommitsFrom(null), null);
  assert.equal(orphanedCommitsFrom({}), null, "no ahead_by field at all is a malformed answer, not zero");
});

test("a missing commits array on a clean compare does not crash — ahead_by 0 needs no list", () => {
  const result = orphanedCommitsFrom({ ahead_by: 0 });
  assert.ok(result);
  assert.deepEqual(result.commits, []);
});
