/**
 * RULE: WOULD ARMING THIS PR CLOSE A ROW SOMEBODY ELSE IS INSIDE? -- #249, #455's split into
 * `scripts/merge-guard/claimed-row-rule.mjs`. Reuses `row-claim.mjs`'s own `decideClaim` rather than
 * re-deriving "is this row somebody else's" a second time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closingClaimReasons, claimedCloseCoveredBy, applyAllowClaimedClose,
} from "../../../../scripts/merge-guard/claimed-row-rule.mjs";
import { reasonKind } from "../../../../scripts/merge-guard/reason-kind.mjs";

const CLOSES_CLAIMED = [{ number: 237, title: "example row", labels: ["in-progress", "session:worker-judge", "started"] }];

test("case 1: a row claimed by a DIFFERENT session is refused, and the holder is findable", () => {
  const reasons = closingClaimReasons(CLOSES_CLAIMED, "dispatcher");
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /WOULD CLOSE #237 "example row"/);
  assert.equal(reasonKind(reasons[0]), "CLAIMED_BY_ANOTHER_SESSION");
});

test("case 2: the session asking already holds the row -- resuming is not a collision", () => {
  assert.deepEqual(closingClaimReasons(CLOSES_CLAIMED, "worker-judge"), []);
});

test("case 3: an empty closes list, or an unclaimed row, stays silent -- the common case", () => {
  assert.deepEqual(closingClaimReasons([], "dispatcher"), []);
  assert.deepEqual(closingClaimReasons([{ number: 999, labels: [] }], "dispatcher"), []);
});

test("omitting session treats every claimed row as somebody else's -- the conservative default", () => {
  const reasons = closingClaimReasons(CLOSES_CLAIMED, "");
  assert.equal(reasons.length, 1, "a check that does not know who is asking cannot vouch for the asker");
});

test("claimedCloseCoveredBy: the named session covers a row it actually holds", () => {
  const covered = claimedCloseCoveredBy(CLOSES_CLAIMED, "worker-judge");
  assert.deepEqual([...covered], [237]);
});

test("claimedCloseCoveredBy: a name that matches NO real claimant covers nothing", () => {
  const covered = claimedCloseCoveredBy(CLOSES_CLAIMED, "dispatcher");
  assert.deepEqual([...covered], []);
});

test("claimedCloseCoveredBy: an unclaimed row is never covered, however the flag is spelled", () => {
  assert.deepEqual([...claimedCloseCoveredBy([{ number: 999, labels: [] }], "worker-judge")], []);
});

test("claimedCloseCoveredBy: covers only the rows the name actually holds, among several closed", () => {
  const covered = claimedCloseCoveredBy([
    { number: 237, labels: ["in-progress", "session:worker-judge"] },
    { number: 238, labels: ["in-progress", "session:worker-audit"] },
    { number: 239, labels: [] },
  ], "worker-judge");
  assert.deepEqual([...covered], [237]);
});

test("applyAllowClaimedClose: a confirmed name overrides only the row it covers", () => {
  const verdict = { reasons: closingClaimReasons(CLOSES_CLAIMED, "dispatcher") };
  const { overridden, remaining } = applyAllowClaimedClose(verdict, CLOSES_CLAIMED, "worker-judge");
  assert.equal(overridden.length, 1);
  assert.equal(remaining.length, 0);
});

test("applyAllowClaimedClose: an unconfirmed name overrides nothing", () => {
  const verdict = { reasons: closingClaimReasons(CLOSES_CLAIMED, "dispatcher") };
  const { overridden, remaining } = applyAllowClaimedClose(verdict, CLOSES_CLAIMED, "somebody-else");
  assert.equal(overridden.length, 0);
  assert.equal(remaining.length, 1);
});

test("applyAllowClaimedClose: no allowClaimedClose value overrides nothing", () => {
  const verdict = { reasons: closingClaimReasons(CLOSES_CLAIMED, "dispatcher") };
  const { overridden, remaining } = applyAllowClaimedClose(verdict, CLOSES_CLAIMED, null);
  assert.equal(overridden.length, 0);
  assert.equal(remaining.length, 1);
});

test("applyAllowClaimedClose: never touches a reason of a different kind, even when a name is confirmed", () => {
  const verdict = { reasons: ["BASE IS NOT main — it is `x`.", ...closingClaimReasons(CLOSES_CLAIMED, "dispatcher")] };
  const { overridden, remaining } = applyAllowClaimedClose(verdict, CLOSES_CLAIMED, "worker-judge");
  assert.equal(overridden.length, 1);
  assert.equal(remaining.length, 1);
  assert.match(remaining[0], /BASE IS NOT main/);
});
