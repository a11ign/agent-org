/**
 * RULE: DID EVERY RUN FINISH AFTER main's CURRENT TIP WAS COMMITTED? -- #455's split into
 * `scripts/merge-guard/staleness-rule.mjs`. THE DANGEROUS SHAPE, because the runs are real and look like
 * evidence. Measured on #135: newest run 00:08:02Z against a main tipped 00:41:07Z.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stalenessReason } from "../../../../scripts/merge-guard/staleness-rule.mjs";

const MAIN_TIP = "2026-09-07T00:41:07Z";
const AFTER = "2026-09-07T00:45:35Z";
const BEFORE = "2026-09-07T00:08:02Z";
const runsAt = (at: string) => [{ completedAt: at }, { completedAt: at }];

test("runs finishing after main's tip raise no reason -- the common case", () => {
  assert.deepEqual(stalenessReason(runsAt(AFTER), MAIN_TIP), []);
});

test("THE #135 SHAPE: real runs, real conclusions, against a base that has moved", () => {
  const reasons = stalenessReason(runsAt(BEFORE), MAIN_TIP);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /EVERY RUN PREDATES THE CURRENT main/);
  assert.match(reasons[0], new RegExp(`${BEFORE}.*${MAIN_TIP}`, "s"),
    "both timestamps, or the reader cannot tell how stale");
});

test("only the NEWEST run's timestamp decides it -- one fresh run among stale ones is enough", () => {
  const runs = [{ completedAt: BEFORE }, { completedAt: AFTER }];
  assert.deepEqual(stalenessReason(runs, MAIN_TIP), []);
});

test("a run with no completedAt is ignored rather than crashing the comparison", () => {
  const runs = [{ completedAt: null }, { completedAt: AFTER }];
  assert.deepEqual(stalenessReason(runs, MAIN_TIP), []);
});

test("an empty run list raises no staleness reason -- that absence is checks-rule.mjs's finding, not this one's", () => {
  assert.deepEqual(stalenessReason([], MAIN_TIP), []);
});
