/**
 * RULE: IS THIS ROW RESERVED FOR A SPECIFIC SESSION? -- #444, wired into `decideClaim` one clause ahead
 * of the claim check. See `scripts/row-claim/runner-rule.mjs` for the full account (#324's own shape:
 * a row needing a genuinely fresh agent, reserved by a comment nothing enforced).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runnerReason } from "../../../../scripts/row-claim/runner-rule.mjs";
import { decideClaim } from "../../../../scripts/row-claim.mjs";

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
