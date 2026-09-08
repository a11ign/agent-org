/**
 * A RUNNING GATE MAY MEAN "THE AUTHOR IS PUSHING RIGHT NOW" — #488.
 *
 * The sweep's predicate was *armed, gate green or still running, and behind main*. An author who has just
 * pushed a fix HAS a running gate, so the train synced under them, their next push was rejected
 * non-fast-forward, and they had to merge a commit the pipeline made on their behalf — twice on #485.
 * The hand rule is *"the author holds the branch while its check is red"*; this puts it in the predicate.
 *
 * ## Narrowing is the dangerous direction, so the mutations run that way
 *
 * A sweep that syncs too LITTLE is indistinguishable from a quiet queue — which is exactly how #498 hid
 * for hours while two green PRs went 16 and 6 commits behind. So the mutation that matters here is not
 * "does it skip a fresh head"; it is **does it still sync a quiet, behind, green-or-running head**. Both
 * directions are driven below.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { updateBranchDecision, headQuietSeconds, newestConclusion, HEAD_QUIET_SECONDS }
  from "../../../../scripts/update-branch-sweep.mjs";

const NOW = new Date("2026-09-08T09:00:00Z");
const decide = (gateConclusion: string | null, quietSeconds: number | null) =>
  updateBranchDecision({ armed: true, gateConclusion, behind: true, quietSeconds });

test("running + head quiet six minutes → UPDATE; a slow CI on a still head is the case to sync", () => {
  assert.equal(decide(null, 360).update, true);
});

test("running + head moved a minute ago → SKIP, and the reason names the elapsed time", () => {
  const d = decide(null, 60);
  assert.equal(d.update, false);
  assert.match(d.reason, /head moved 60s ago/,
    "a skip that does not say how long ago cannot be checked by the author it affects");
  assert.match(d.reason, /author mid-push holds their own branch/);
});

test("green + behind → UPDATE, unchanged, and the quiet window is NOT applied to it", () => {
  // A green gate means CI has finished, so nobody is mid-push. Narrowing this case would reintroduce
  // #498's stall by another route — and #498's cost was two green PRs invisible for hours.
  assert.equal(decide("SUCCESS", 1).update, true, "one second of quiet, green gate: still eligible");
});

test("failure → SKIP, unchanged", () => {
  assert.equal(decide("FAILURE", 9999).update, false);
});

test("THE BOUNDARY IS INCLUSIVE AT 300s — 299 skips, 300 and 301 update", () => {
  // Said in a test rather than left to whoever next reads `<` versus `>=`.
  assert.equal(decide(null, 299).update, false);
  assert.equal(decide(null, HEAD_QUIET_SECONDS).update, true);
  assert.equal(decide(null, 301).update, true);
});

test("a head that cannot say when it appeared is REFUSED, not assumed quiet", () => {
  const d = decide(null, null);
  assert.equal(d.update, false);
  assert.match(d.reason, /NOTHING ON THE HEAD SAYS WHEN IT APPEARED/);
  // The asymmetry is the argument: waiting a cycle costs a cycle; pushing under an author costs them a
  // rejected push and a merge they did not make.
  assert.match(d.reason, /cost of waiting a cycle is a cycle/);
});

/**
 * THE ZERO DATE AND THE EMPTY CONCLUSION — found by driving the real API for this row, and they are
 * #498's own defect surviving its own fix.
 *
 * GitHub reports an IN_PROGRESS check run as `completedAt: "0001-01-01T00:00:00Z"` and `conclusion: ""` —
 * neither of which is null. Recorded 2026-09-08 from PR #505:
 *
 *     {"name":"arm","status":"IN_PROGRESS","startedAt":"2026-09-08T08:50:31Z",
 *      "completedAt":"0001-01-01T00:00:00Z","conclusion":""}
 *
 * `??` does not treat a zero date as missing, so a still-running run sorted as the OLDEST thing on the
 * head and lost to any completed one — including exactly the stale failure #498 was written to stop
 * winning. This lands where #488 lives: an author who has just pushed HAS a running gate.
 */
test("a RUNNING newest gate beats a completed older failure — the zero date is absence", () => {
  const runs = [
    { name: "gate", conclusion: "FAILURE", completedAt: "2026-09-08T07:32:37Z", startedAt: "2026-09-08T07:30:00Z" },
    { name: "gate", conclusion: "", completedAt: "0001-01-01T00:00:00Z", startedAt: "2026-09-08T08:50:31Z" },
  ];
  assert.equal(newestConclusion(runs, "gate"), null,
    "the newest run is IN_PROGRESS, so there is no verdict yet — not the older FAILURE, and not the "
    + "empty string, which `updateBranchDecision` would read as 'not SUCCESS' and skip as failing");
});

test("#500's own measured case still reads SUCCESS — this fix does not undo that one", () => {
  assert.equal(newestConclusion([
    { name: "gate", conclusion: "FAILURE", completedAt: "2026-09-08T07:32:35Z" },
    { name: "gate", conclusion: "SUCCESS", completedAt: "2026-09-08T07:35:34Z" },
  ], "gate"), "SUCCESS");
});

test("quiet time comes from the OLDEST check-run start, and a zero date is not a start", () => {
  // The oldest start is the closest thing on the head to "when this head appeared": later runs are
  // re-runs. A commit's own author/committer date is supplied by the pusher's machine and can precede
  // the push by days, which would read as quiet the instant it arrived — the opposite of the protection.
  const quiet = headQuietSeconds([
    { startedAt: "2026-09-08T08:50:00Z" },
    { startedAt: "2026-09-08T08:58:00Z" },
    { startedAt: "0001-01-01T00:00:00Z" },
  ], NOW);
  assert.equal(quiet, 600, "08:50 is the oldest real start; the zero date is not a start at all");
});

test("no start times anywhere → null, never a number", () => {
  assert.equal(headQuietSeconds([], NOW), null);
  assert.equal(headQuietSeconds(null, NOW), null);
  assert.equal(headQuietSeconds([{ startedAt: "0001-01-01T00:00:00Z" }], NOW), null,
    "a head whose only timestamp is the zero date cannot be shown to be quiet");
});
