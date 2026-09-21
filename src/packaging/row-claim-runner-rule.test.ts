/**
 * RULE: IS THIS ROW RESERVED FOR A SPECIFIC SESSION? -- #444, wired into `decideClaim` one clause ahead
 * of the claim check. See `packages/agent-org/src/row-claim/runner-rule.mjs` for the full account (#324's own shape:
 * a row needing a genuinely fresh agent, reserved by a comment nothing enforced).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runnerReason, laneReason } from "../row-claim/runner-rule.mjs";
import { decideClaim } from "../row-claim.mjs";
import { ROUTED_TO } from "../work-gate.mjs";

test("no runner: label at all raises nothing -- the common case", () => {
  assert.equal(runnerReason(["backlog", "ready"], "worker-judge"), null);
});

test("#444's own acceptance shape: a reserved row refuses a different session by name", () => {
  const reason = runnerReason(["backlog", "ready", "runner:worker-audit"], "worker-judge");
  assert.ok(reason);
  assert.match(reason as string, /worker-audit/);
});

test("the NAMED runner is admitted -- the reservation is not a lock against everyone", () => {
  assert.equal(runnerReason(["backlog", "ready", "runner:worker-audit"], "worker-audit"), null);
});

test("more than one runner label: any one matching admits the asker", () => {
  assert.equal(runnerReason(["runner:worker-audit", "runner:orchestrator"], "orchestrator"), null);
});

test("more than one runner label, none matching: both are named in the refusal", () => {
  const reason = runnerReason(["runner:worker-audit", "runner:orchestrator"], "worker-judge");
  assert.match(reason as string, /worker-audit/);
  assert.match(reason as string, /orchestrator/);
});

/**
 * WIRED INTO `decideClaim`, AHEAD OF THE CLAIM CHECK -- the exact acceptance script from #444's own issue
 * body, so a future edit to `decideClaim`'s clause ORDER is caught here rather than only in the rule's
 * own isolated test.
 */
test("#444's literal acceptance script, run against decideClaim itself", () => {
  const r = decideClaim(["backlog", "ready", "runner:worker-audit"], "worker-judge");
  assert.equal(r.proceed, false);
  assert.match((r as { reason: string }).reason, /worker-audit/);

  const own = decideClaim(["backlog", "ready", "runner:worker-audit"], "worker-audit");
  assert.equal(own.proceed, true);
});

test("a runner: reservation on a row NOT YET claimed still refuses -- #324's own shape", () => {
  // No `in-progress` label at all here -- this is the case the old `decideClaim` could not express: a
  // row can be `ready` (unclaimed) and still reserved.
  const r = decideClaim(["backlog", "ready", "runner:worker-audit"], "dispatcher");
  assert.equal(r.proceed, false);
});

test("MUTATION target: removing the runner clause from decideClaim must be exactly what this test catches", () => {
  // Constructed so that WITHOUT the runner check, decideClaim would read this as unclaimed and proceed --
  // proving the clause is load-bearing, not merely present.
  const r = decideClaim(["runner:worker-audit"], "worker-judge");
  assert.equal(r.proceed, false, "a row with ONLY a runner: label (no in-progress) must still refuse a "
    + "non-runner session -- if this passes, the runner clause has been removed or short-circuited");
});

/**
 * RULE: A `fleet-gated` ROW'S `lane:` LABEL IS SATISFIED BY ANY MEMBER OF ITS ROUTED POOL -- #1828,
 * ceo's ruling on #1817. `row-file.mjs`'s `fleetOrLabAcceptance` force-adds `lane:orchestrator` to any
 * row whose Acceptance reaches the fleet or the lab, which is what a real fleet-gated capture row carries
 * at filing -- and, before this row, is exactly what refused every session but `orchestrator`, including
 * `worker-capture` once the ruling put it in the same pool. This reads `ROUTED_TO["fleet-gated"]`
 * directly (from `work-gate.mjs`), never a second copy of the pool, so the two cannot drift.
 *
 * PLAIN `lane:` SEMANTICS ARE UNCHANGED EVERYWHERE ELSE: a `lane:ceo` row still refuses every session
 * outside `ceo` unconditionally, because `ceo` is not a member of any `ROUTED_TO` pool.
 */
const captureRow = ["backlog", "ready", "fleet-gated", "lane:orchestrator"];

test("#1828: a fleet-gated capture row is claimable by worker-capture, not only orchestrator", () => {
  assert.equal(laneReason(captureRow, "worker-capture"), null,
    "worker-capture is in ROUTED_TO['fleet-gated']'s pool, so orchestrator's lane label must not refuse it");
  assert.equal(decideClaim(captureRow, "worker-capture").proceed, true);
});

test("#1828: orchestrator itself is unaffected -- still claimable exactly as before", () => {
  assert.equal(laneReason(captureRow, "orchestrator"), null);
  assert.equal(decideClaim(captureRow, "orchestrator").proceed, true);
});

test("#1828: worker-judge and worker-tooling are still refused -- the pool is two names, not every session", () => {
  for (const outsider of ["worker-judge", "worker-tooling"]) {
    const reason = laneReason(captureRow, outsider);
    assert.ok(reason, `${outsider} must still be refused a fleet-gated row -- it is not in the routed pool`);
    assert.match(reason as string, /orchestrator/);
    const decision = decideClaim(captureRow, outsider);
    assert.equal(decision.proceed, false);
  }
});

test("#1828: a lane:ceo row is untouched -- ceo is not in any ROUTED_TO pool", () => {
  // The pool-exemption must be scoped to members of the SAME pool as the asking session, not a blanket
  // OR for every `lane:` label on a `fleet-gated` row.
  assert.ok(laneReason(["ready", "fleet-gated", "lane:ceo"], "worker-capture"),
    "worker-capture is not ceo, and ceo owns this lane regardless of the fleet-gated label");
});

test("#1828 MUTATION target: without `fleet-gated` on the row, the pool exemption must not fire", () => {
  // Constructed so that a pool check keyed on `mySession`/`owner` alone, and not also on the row itself
  // carrying `fleet-gated`, would wrongly admit worker-capture to an ORDINARY orchestrator lane row.
  const reason = laneReason(["ready", "lane:orchestrator"], "worker-capture");
  assert.ok(reason, "worker-capture must still be refused an orchestrator lane row that is not fleet-gated");
});

test("#1828: ROUTED_TO['fleet-gated'] is read directly, so this suite and the pool cannot drift", () => {
  assert.deepEqual(ROUTED_TO["fleet-gated"], ["orchestrator", "worker-capture"]);
});
