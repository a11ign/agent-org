// no-token: gh -- this file drives merge-queue.ts only through its pure exports and the fake code host; its own code never calls or spawns gh (#1482, route (a))
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
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { refusalFor, wantedPrNumber, orphanedCommitsFrom, runMergeQueue, EXIT } from "../merge-queue.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";

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
  assert.equal(wantedPrNumber(["node", "merge-queue.ts", "--merge=156"]), "156");
});

test("--merge <n> (space form) still works — the fix must not break the shape that already worked", () => {
  assert.equal(wantedPrNumber(["node", "merge-queue.ts", "--merge", "156"]), "156");
});

test("both shapes produce the IDENTICAL wanted value for the same PR", () => {
  const equals = wantedPrNumber(["node", "merge-queue.ts", "--merge=156"]);
  const space = wantedPrNumber(["node", "merge-queue.ts", "--merge", "156"]);
  assert.equal(equals, space);
});

test("no --merge flag at all means list mode, not a crash", () => {
  assert.equal(wantedPrNumber(["node", "merge-queue.ts"]), null);
});

test("--merge as the last argument, with nothing after it, is null rather than a stray flag string", () => {
  assert.equal(wantedPrNumber(["node", "merge-queue.ts", "--merge"]), null);
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

// --- #1482: the ENTRY POINT, driven on the fake code host ------------------------------------------------------------
//
// worker-judge's #1399 sweep: the merge lands, then the local orphaned-branch log write throws, and Node exited 1 -- this
// script's "NOT mergeable" -- for a PR that merged. These drive `runMergeQueue`, the path `--merge` runs. What the dispatcher asks of
// the code host (the open pull requests, the merge, the comparison with `main`, the branch's deletion) is the code host's `rows`
// (A11-160, step 5), so the world is the fake's: no GitHub answer is stubbed here. How the GitHub plugin sends those four and reads
// their answers is `plugins/github/rows/merge-guard-reads.test.ts`'s. Nothing here calls or spawns the real command.

type Seed = { prs?: object[]; compare?: { ahead_by?: number; commits?: { sha: string; commit?: { message?: string } }[] } | Error };

/** The fake code host with the open pull requests seeded, the way GitHub would list them for the queue. */
function queueWorld({ prs = [PR77], compare }: Seed = {}) {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  for (const given of prs as Array<ReturnType<typeof pr> & { title?: string; headRefName: string }>) {
    world.pulls.set(given.number, { number: given.number, body: "", headRefName: given.headRefName, labels: [], isDraft: given.isDraft, armed: false, merged: false, mergedAt: null,
      createdAt: "2026-09-07T00:00:00Z", comments: [], title: given.title, mergeable: given.mergeable, mergeStateStatus: given.mergeStateStatus, rollup: given.statusCheckRollup });
  }
  if (compare !== undefined) world.compare.set("agent/x-77", compare);
  substituteCodeHost(host);
  return world;
}

const PR77 = { ...pr({ number: 77 }), title: "a row", headRefName: "agent/x-77" };

afterEach(() => forgetActivation());

/** Runs `--merge 77` through the entry point, capturing its output, errors and log appends. */
function queue({ appendFails = false } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const appended: string[] = [];
  const code = runMergeQueue({ argv: ["node", "merge-queue.ts", "--merge", "77"],
    logPath: () => "/tmp/orphaned-branch-log.jsonl",
    append: (_path: string, data: string) => { if (appendFails) throw new Error("EROFS: read-only file system"); appended.push(data); },
    out: (text: string) => { out.push(text); }, err: (text: string) => { err.push(text); } });
  return { code, out: out.join(""), err: err.join(""), appended };
}

const mergeCall = (calls: string[]) => calls.findIndex((c) => c.startsWith("mergeQueuedPull"));
const deleteCall = (calls: string[]) => calls.findIndex((c) => c.startsWith("deleteBranchOf"));

test("#1482 ACCEPTANCE: the log write fails AFTER the merge landed -- exit 3, naming the merged PR and what was not done", () => {
  const world = queueWorld();
  const { code, out, err } = queue({ appendFails: true });
  assert.equal(code, EXIT.MERGED_THEN_STEP_FAILED, "not 1: that is NOT mergeable, and this PR merged");
  assert.ok(mergeCall(world.calls) >= 0, "the merge was made");
  assert.equal(world.pulls.get(77)!.merged, true, "and the pull request is merged");
  assert.equal(deleteCall(world.calls), -1, "and the branch was not deleted on an unrecorded check");
  assert.deepEqual(world.deletedBranches, []);
  assert.match(out, /merged #77/, "the merge's own output is still printed");
  assert.match(err, /#77 MERGED/);
  assert.match(err, /EROFS: read-only file system/, "the underlying error is quoted");
  assert.match(err, /orphaned-branch record for `agent\/x-77` was NOT written/);
  assert.match(err, /compare\/main\.\.\.agent\/x-77/, "and the check to run by hand is named");
});

test("#1482 CONTROL: a PR refused BEFORE the merge exits NOT_MERGEABLE, and nothing is merged", () => {
  const world = queueWorld({ prs: [{ ...PR77, isDraft: true }] });
  const { code, err } = queue();
  assert.equal(code, EXIT.NOT_MERGEABLE);
  assert.match(err, /REFUSING to merge #77: draft/);
  assert.equal(mergeCall(world.calls), -1);
  assert.equal(world.pulls.get(77)!.merged, false);
});

/** The queue run with `operation` refused by the code host with `failure`. */
function queueRefusing(operation: string, failure: Error, seed: Seed = {}) {
  const world = queueWorld(seed);
  world.failures.set(operation, failure);
  return { world, ...queue() };
}

test("#1482 CONTROL: a queue that cannot be read exits CANNOT_TELL, and nothing is merged -- whether gh refused or its answer could not be parsed at all (A11-160: never an uncaught throw that exits as NOT_MERGEABLE)", () => {
  for (const failure of [new Error("HTTP 502 on pr list"), new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON")]) {
    const { world, code, err } = queueRefusing("openPullsForQueue", failure);
    assert.equal(code, EXIT.CANNOT_TELL, failure.message);
    assert.match(err, new RegExp(`could not ask GitHub for the queue: ${failure.message.slice(0, 16).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(mergeCall(world.calls), -1);
  }
});

test("#1482 CONTROL: every call succeeds -- exit 0, the record written, the absorbed branch deleted", () => {
  const world = queueWorld();
  const { code, appended } = queue();
  assert.equal(code, EXIT.DONE);
  assert.equal(appended.length, 1);
  assert.equal(JSON.parse(appended[0]).prNumber, 77);
  assert.equal(JSON.parse(appended[0]).orphanedCommitCount, 0);
  assert.ok(deleteCall(world.calls) > mergeCall(world.calls), "deleted after the merge");
  assert.deepEqual(world.deletedBranches, ["agent/x-77"]);
});

test("#152: a branch with commits the merge never absorbed is KEPT, the record counts them, and nothing is deleted", () => {
  const world = queueWorld({ compare: { ahead_by: 1, commits: [{ sha: "23a2a3e2abcdef", commit: { message: "late work\n\nbody" } }] } });
  const { code, err, appended } = queue();
  assert.equal(code, EXIT.DONE);
  assert.equal(JSON.parse(appended[0]).orphanedCommitCount, 1);
  assert.match(err, /WARNING: `agent\/x-77` has 1 commit\(s\) beyond what #77 just merged\. NOT deleting it/);
  assert.match(err, /23a2a3e2ab late work/);
  assert.deepEqual(world.deletedBranches, []);
});

test("#152: a comparison that cannot be read is recorded as unknown (null), the branch is left undeleted, and the exit is still DONE", () => {
  const world = queueWorld({ compare: new Error("HTTP 502 on compare") });
  const { code, err, appended } = queue();
  assert.equal(code, EXIT.DONE);
  assert.equal(JSON.parse(appended[0]).orphanedCommitCount, null, "a lookup failure is never a clean answer");
  assert.match(err, /could not verify `agent\/x-77` was fully absorbed by #77/);
  assert.deepEqual(world.deletedBranches, []);
});

test("#1482: a branch that cannot be deleted after a clean merge is SAID, and the merge still stands (exit DONE)", () => {
  const { world, code, err } = queueRefusing("deleteBranchOf", new Error("HTTP 422: Reference does not exist"));
  assert.equal(code, EXIT.DONE);
  assert.match(err, /merged #77 cleanly, but could not delete `agent\/x-77`: HTTP 422/);
  assert.equal(world.pulls.get(77)!.merged, true);
});

test("#1482 CONTROL: a merge that itself fails still throws -- nothing landed, and nothing is recorded", () => {
  const world = queueWorld();
  world.failures.set("mergeQueuedPull", new Error("GraphQL: Pull request is not mergeable"));
  let appended: string[] = [];
  assert.throws(() => { appended = queue().appended; }, /not mergeable/);
  assert.deepEqual(appended, []);
  assert.equal(world.pulls.get(77)!.merged, false);
});

/** Runs the entry point with `argv` and the default seams, capturing what it said. */
function runWith(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runMergeQueue({ argv: ["node", "merge-queue.ts", ...argv], logPath: () => "/tmp/x", append: () => undefined, out: (text) => { out.push(text); }, err: (text) => { err.push(text); } });
  return { code, out: out.join(""), err: err.join("") };
}

test("the list mode names every open PR as READY or HELD with the reason, and merges nothing", () => {
  const world = queueWorld({ prs: [PR77, { ...pr({ number: 78 }), title: "b", headRefName: "agent/y-78", isDraft: true }] });
  const { code, out } = runWith([]);
  assert.equal(code, EXIT.DONE);
  assert.match(out, /READY {2}#77 {2}agent\/x-77/);
  assert.match(out, /HELD {3}#78 {2}agent\/y-78\n\s+draft/);
  assert.equal(mergeCall(world.calls), -1);
});

test("a repository with no open pull requests is CANNOT_TELL, not an empty queue that read clean", () => {
  queueWorld({ prs: [] });
  const { code, err } = runWith([]);
  assert.equal(code, EXIT.CANNOT_TELL);
  assert.match(err, /INCONCLUSIVE: no open PRs/);
});

test("--merge <n> names a pull request that is not open: NOT_MERGEABLE, and nothing is merged", () => {
  const world = queueWorld({ prs: [{ ...PR77, number: 5, headRefName: "agent/z-5" }] });
  const { code, err } = runWith(["--merge", "77"]);
  assert.equal(code, EXIT.NOT_MERGEABLE);
  assert.match(err, /#77 is not an open PR/);
  assert.equal(mergeCall(world.calls), -1);
});

test("#1482: the header documents every exit code, the merged-then-failed code included", () => {
  assert.deepEqual(EXIT, { DONE: 0, NOT_MERGEABLE: 1, CANNOT_TELL: 2, MERGED_THEN_STEP_FAILED: 3 });
  const header = readFileSync(new URL("../merge-queue.ts", import.meta.url), "utf8").split("*/")[0];
  for (const code of Object.values(EXIT)) assert.match(header, new RegExp(`\\*\\s+${code}\\s{2}\\S`), `the header documents ${code}`);
});

