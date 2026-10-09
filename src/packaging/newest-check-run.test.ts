// @ts-check
// `newestConclusion` / `newestRun` / `normaliseConclusion`, which moved here from the deleted update-branch
// sweep (#3047) because `queue-stalled.ts` still reads them. The fixtures are REAL rollup entries, so the
// vocabulary under test is the one `gh pr list --json statusCheckRollup` returns (upper case).
import { test } from "node:test";
import assert from "node:assert/strict";
import { newestConclusion, newestRun, normaliseConclusion, SUCCESS } from "../newest-check-run.ts";

// --- #498: a superseded check run stays attached to the head for ever ---
//
// PR #485's head `b9b9a0ee`, copied verbatim from `gh pr list --json statusCheckRollup` on 2026-09-08: a `gate`
// that FAILED inside a cancelled `ci.yml` run at 07:32, and the `gate` that SUCCEEDED in the live run three
// minutes later. Both are permanently attached to that head; reading the first reports a green PR as failing.
const CANCELLED_THEN_SUCCESS = [
  { name: "ts", conclusion: "CANCELLED", completedAt: "2026-09-08T07:32:30Z", startedAt: "2026-09-08T07:32:00Z" },
  { name: "gate", conclusion: "FAILURE", completedAt: "2026-09-08T07:32:37Z", startedAt: "2026-09-08T07:32:35Z" },
  { name: "gate", conclusion: "SUCCESS", completedAt: "2026-09-08T07:35:37Z", startedAt: "2026-09-08T07:35:34Z" },
];

test("newestConclusion: a superseded FAILURE never outranks the newer SUCCESS (#498)", () => {
  assert.equal(newestConclusion(CANCELLED_THEN_SUCCESS, "gate"), SUCCESS);
});

test("newestConclusion: ARRAY ORDER IS NOT TRUSTED -- newest-first input gives the same answer", () => {
  assert.equal(newestConclusion([...CANCELLED_THEN_SUCCESS].reverse(), "gate"), SUCCESS);
});

test("newestConclusion: a genuinely failing head is STILL read as failing", () => {
  const runs = [
    { name: "gate", conclusion: "SUCCESS", completedAt: "2026-09-08T07:00:00Z", startedAt: "2026-09-08T06:59:00Z" },
    { name: "gate", conclusion: "FAILURE", completedAt: "2026-09-08T08:00:00Z", startedAt: "2026-09-08T07:59:00Z" },
  ];
  assert.equal(newestConclusion(runs, "gate"), "failure");
});

test("newestConclusion: a still-running newest run reports null, 'not yet answered', not 'failing' (#488)", () => {
  const runs = [
    { name: "gate", conclusion: "FAILURE", completedAt: "2026-09-08T07:32:37Z", startedAt: "2026-09-08T07:32:35Z" },
    // GitHub reports an in-flight run with the zero date and an empty conclusion, not nulls.
    { name: "gate", conclusion: "", completedAt: "0001-01-01T00:00:00Z", startedAt: "2026-09-08T07:40:00Z" },
  ];
  assert.equal(newestConclusion(runs, "gate"), null);
});

test("newestConclusion: no run of that name, an empty rollup and a null rollup are all null, never a throw", () => {
  assert.equal(newestConclusion(CANCELLED_THEN_SUCCESS, "mergeSafety"), null);
  assert.equal(newestConclusion([], "gate"), null);
  assert.equal(newestConclusion(null, "gate"), null);
  assert.equal(newestConclusion(undefined, "gate"), null);
});

test("newestConclusion: an UNTIMED entry never outranks a timed one -- absence is not newness", () => {
  const runs = [
    { name: "gate", conclusion: "SUCCESS", completedAt: "2026-09-08T07:35:37Z", startedAt: "2026-09-08T07:35:34Z" },
    { name: "gate", conclusion: "FAILURE", completedAt: null, startedAt: null },
  ];
  assert.equal(newestConclusion(runs, "gate"), SUCCESS);
});

test("newestConclusion: startedAt is the fallback key when completedAt is absent on both", () => {
  const runs = [
    { name: "gate", conclusion: "FAILURE", completedAt: null, startedAt: "2026-09-08T07:00:00Z" },
    { name: "gate", conclusion: "SUCCESS", completedAt: null, startedAt: "2026-09-08T08:00:00Z" },
  ];
  assert.equal(newestConclusion(runs, "gate"), SUCCESS);
});

// --- #1623: by workflow run when both entries name a different one ---
//
// #1617 at `84f684dd`: the cancelled gate is in the NEWER run (34858134371) and "completed" at 14:49:32Z, before
// the older run's gate (34858130620) succeeded at 14:51:42Z. By time the success was newest; GitHub held the PR on
// the cancelled one. #1605's pair is the other way round, and there run order and time agree.
const gate = (conclusion: string, startedAt: string, completedAt: string, run?: number) => ({
  name: "gate", conclusion, startedAt, completedAt,
  ...(run ? { detailsUrl: `https://github.com/a11ign/a11ign/actions/runs/${run}/job/1` } : {}),
});
const PR_1617 = [
  gate("CANCELLED", "2026-09-14T14:49:33Z", "2026-09-14T14:49:32Z", 34858134371),
  gate("SUCCESS", "2026-09-14T14:51:37Z", "2026-09-14T14:51:42Z", 34858130620),
];
const PR_1605 = [
  gate("CANCELLED", "2026-09-14T14:22:34Z", "2026-09-14T14:22:33Z", 34855015256),
  gate("SUCCESS", "2026-09-14T14:26:18Z", "2026-09-14T14:26:21Z", 34855153052),
];

test("newestConclusion: #1617's cancelled gate is newest -- its workflow run is newer -- in either order", () => {
  assert.equal(newestConclusion(PR_1617, "gate"), "cancelled");
  assert.equal(newestConclusion([...PR_1617].reverse(), "gate"), "cancelled");
});

test("newestConclusion: #1605's success, in the later workflow run, stays newest", () => {
  assert.equal(newestConclusion(PR_1605, "gate"), SUCCESS);
  assert.equal(newestConclusion([...PR_1605].reverse(), "gate"), SUCCESS);
});

test("newestConclusion: entries with no run id are ordered by time alone, so #1617 reads as it did before #1623", () => {
  const withoutIds = PR_1617.map(({ detailsUrl, ...rest }) => { void detailsUrl; return rest; });
  assert.equal(newestConclusion(withoutIds, "gate"), SUCCESS);
});

test("newestRun: a MIXED pair (one run id, one not) and a pair in the SAME run fall back to time", () => {
  const [withId, withSecondId] = PR_1617;
  const { detailsUrl, ...noId } = withSecondId;
  void detailsUrl;
  assert.equal(newestRun([withId, noId], "gate")?.conclusion, "SUCCESS", "mixed: the later completion wins");
  assert.equal(newestRun([noId, withId], "gate")?.conclusion, "SUCCESS");
  const sameRun = { ...withSecondId, detailsUrl: withId.detailsUrl };
  assert.equal(newestRun([withId, sameRun], "gate")?.completedAt, "2026-09-14T14:51:42Z", "same run: the later completion wins");
});

test("normaliseConclusion: every spelling of absence is null and every verdict is lower case (#1100)", () => {
  assert.equal(normaliseConclusion("SUCCESS"), "success");
  assert.equal(normaliseConclusion("success"), "success");
  for (const absent of ["", null, undefined]) assert.equal(normaliseConclusion(absent), null);
});
