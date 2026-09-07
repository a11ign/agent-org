/**
 * A PUSH TO `main` THAT FAILS ITS OWN GATE IS REVERTED, UNATTENDED -- unless the failure is INHERITED, or
 * `main` has already moved on. #316 (pipeline unit 3).
 *
 * Two real near-misses, both measured live by `dispatcher` against the actual PR queue the morning this
 * was built, and both are what these tests pin as SHAPES rather than one-off cases:
 *
 *   - 13 of 19 PRs read red on one bad commit and none was at fault -- their own push-to-main gate run
 *     failed for a reason that already existed before they landed. A revert must refuse unless the
 *     commit BEFORE this push was itself verified green.
 *   - `main` was red for 90 minutes; the real fix was a follow-up commit, not a revert. A revert firing
 *     after that follow-up landed would have reverted the FIX. The bound here is not a clock: it is
 *     whether the failing push is STILL `main`'s tip when the decision is made.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { revertVerdict, revertPrBody, EXIT } from "../../../../scripts/trunk-revert.mjs";

const PUSH = "a1b2c3d4e5f6789012345678901234567890abcd";

test("READY: the push's own gate failed, the commit before it was green, and main has not moved on", () => {
  const v = revertVerdict({ beforeGateConclusion: "success", currentMainSha: PUSH, pushSha: PUSH });
  assert.equal(v.code, EXIT.READY, v.reason);
});

test("THE #316 INHERITED-FAILURE CASE: the commit before this push was already red -- refuse, never revert", () => {
  const v = revertVerdict({ beforeGateConclusion: "failure", currentMainSha: PUSH, pushSha: PUSH });
  assert.equal(v.code, EXIT.REFUSED);
  assert.match(v.reason, /INHERITED/);
  assert.match(v.reason, /remove innocent work/);
});

test("a before-conclusion of anything other than success is treated the same as failure -- cancelled, timed_out, etc.", () => {
  for (const conclusion of ["cancelled", "timed_out", "action_required", "neutral"]) {
    const v = revertVerdict({ beforeGateConclusion: conclusion, currentMainSha: PUSH, pushSha: PUSH });
    assert.equal(v.code, EXIT.REFUSED, `conclusion=${conclusion} must refuse, not just "failure" literally`);
  }
});

test("MUTATION target: beforeGateConclusion === null is CANNOT_ASK, never coerced into READY or REFUSED", () => {
  const v = revertVerdict({ beforeGateConclusion: null, currentMainSha: PUSH, pushSha: PUSH });
  assert.equal(v.code, EXIT.CANNOT_ASK);
  assert.match(v.reason, /CANNOT SAY/);
});

test("null before-conclusion covers the FIRST PUSH this workflow has ever seen, and says so", () => {
  const v = revertVerdict({ beforeGateConclusion: null, currentMainSha: PUSH, pushSha: PUSH });
  assert.match(v.reason, /first push/);
});

test("THE #316 STALE-ACTION CASE: main has moved on since this push -- refuse rather than revert a possible fix", () => {
  const laterSha = "9988776655443322110099887766554433221100";
  const v = revertVerdict({ beforeGateConclusion: "success", currentMainSha: laterSha, pushSha: PUSH });
  assert.equal(v.code, EXIT.REFUSED);
  assert.match(v.reason, /moved on/);
  assert.match(v.reason, /already have/);
});

test("currentMainSha === pushSha (the exact-match case) is what makes READY possible at all", () => {
  const v = revertVerdict({ beforeGateConclusion: "success", currentMainSha: PUSH, pushSha: PUSH });
  assert.equal(v.code, EXIT.READY);
});

test("a failed lookup of main's current tip is CANNOT_ASK, never treated as \"still the tip\"", () => {
  const v = revertVerdict({ beforeGateConclusion: "success", currentMainSha: null, pushSha: PUSH });
  assert.equal(v.code, EXIT.CANNOT_ASK);
});

test("the inherited-failure check is asked BEFORE the staleness check -- a stale AND inherited push reads as inherited, the more specific fault", () => {
  const laterSha = "9988776655443322110099887766554433221100";
  const v = revertVerdict({ beforeGateConclusion: "failure", currentMainSha: laterSha, pushSha: PUSH });
  assert.match(v.reason, /INHERITED/);
});

/**
 * `revertPrBody` names everything `ceo` asked for: the original PR and its author, the failure, and the
 * reverted sha -- because `git revert -m 1` is itself revertible and somebody will need that sha.
 */

test("revertPrBody names the original PR, its author, the reverted sha and the run URL", () => {
  const body = revertPrBody({
    pushSha: PUSH,
    originPr: { number: 309, author: "worker-config", title: "feat(#298): CI/CD pipeline unit 1" },
    runUrl: "https://github.com/DanBeckDev/a11y-witness/actions/runs/123",
  });
  assert.match(body, /#309/);
  assert.match(body, /@worker-config/);
  assert.match(body, new RegExp(PUSH));
  assert.match(body, /actions\/runs\/123/);
  assert.match(body, new RegExp(`Reverts commit ${PUSH}`), "the exact marker lookupExistingRevertPr searches for");
});

test("revertPrBody degrades honestly when the original PR could not be identified, rather than inventing one", () => {
  const body = revertPrBody({ pushSha: PUSH, originPr: null, runUrl: "https://example.test/run" });
  assert.match(body, /could not be identified/);
  assert.doesNotMatch(body, /#undefined/);
  assert.match(body, new RegExp(`Reverts commit ${PUSH}`));
});

test("revertPrBody always carries its own idempotency marker, so a re-run can find it and skip a duplicate", () => {
  const withOrigin = revertPrBody({
    pushSha: PUSH, originPr: { number: 1, author: "a", title: "t" }, runUrl: "https://example.test",
  });
  const withoutOrigin = revertPrBody({ pushSha: PUSH, originPr: null, runUrl: "https://example.test" });
  const marker = `Reverts commit ${PUSH}.`;
  assert.ok(withOrigin.includes(marker));
  assert.ok(withoutOrigin.includes(marker));
});
