/**
 * RULE: IS THIS ROW RESERVED FOR A SPECIFIC SESSION? -- #444, wired into `decideClaim` one clause ahead
 * of the claim check. See `packages/agent-org/src/row-claim/runner-rule.ts` for the full account (#324's own shape:
 * a row needing a genuinely fresh agent, reserved by a comment nothing enforced).
 */
// no-token: LIVE_SESSIONS
//
// `laneReason`'s default `deps?.liveSessions ?? LIVE_SESSIONS` puts `arm-pr.ts`'s `LIVE_SESSIONS` (and,
// through the same closure, its `gh`-calling helpers) in this file's import graph, but every case here
// either passes its own `liveSessions`/`pool` fixture or drives `runnerReason`, which never reads it at
// all. Nothing here calls `LIVE_SESSIONS` itself (#827: the whole-file over-charge this declaration
// exists for -- `arm-pr.ts` also defines functions that DO call `gh`, unrelated to this file's own
// assertions).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runnerReason, laneReason } from "../row-claim/runner-rule.ts";
import { decideClaim } from "../row-claim.ts";
import { ROUTED_TO } from "../work-gate.ts";

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
 * ceo's ruling on #1817, NARROWED TO ONE NAME BY #2506. `row-file.ts`'s `fleetOrLabAcceptance` force-adds
 * `lane:orchestrator` to any row whose Acceptance reaches the fleet or the lab. The pool was two names
 * (`orchestrator`, `worker-capture`) and `worker-capture` is retired, so the shipped pool is `orchestrator`
 * alone and a generic engineer is refused: fleet-gated throughput is `orchestrator`'s own turn rate until
 * `orchestrator` shows a `lab:job` dispatch from an engineer cannot collide with another capture, and the
 * exception then attaches to a ROW, not to a name. This reads `ROUTED_TO["fleet-gated"]` directly (from
 * `work-gate.ts`), never a second copy of the pool, so the two cannot drift.
 *
 * THE POOL-EXEMPTION BRANCH (`pool.includes(owner) && pool.includes(mySession)`) NEEDS TWO MEMBERS TO FIRE, and
 * the shipped pool has one. Its positive control is the `pool` seam on `laneReason`'s `deps`: the cases tagged
 * "TWO-NAME POOL" hand it a pool of two and are what stops the exemption being dead code with no test.
 *
 * PLAIN `lane:` SEMANTICS ARE UNCHANGED EVERYWHERE ELSE: a `lane:ceo` row still refuses every session
 * outside `ceo` unconditionally, because `ceo` is not a member of any `ROUTED_TO` pool.
 */
const captureRow = ["backlog", "ready", "fleet-gated", "lane:orchestrator"];
const twoNamePool = ["orchestrator", "worker-capture"];

test("#2506: a fleet-gated capture row is refused to worker-capture, naming orchestrator", () => {
  const reason = laneReason(captureRow, "worker-capture");
  assert.ok(reason, "worker-capture is retired and no longer in the pool, so orchestrator's lane label refuses it");
  assert.match(reason as string, /orchestrator/);
  assert.equal(decideClaim(captureRow, "worker-capture").proceed, false);
});

test("#1828: orchestrator itself is unaffected -- still claimable exactly as before", () => {
  assert.equal(laneReason(captureRow, "orchestrator"), null);
  assert.equal(decideClaim(captureRow, "orchestrator").proceed, true);
});

test("#2506: the pool is one name -- every other session, a generic spare included, is refused", () => {
  // `worker-9` is the positive control for "nothing else changed": it was refused before this row and still is.
  for (const outsider of ["worker-judge", "worker-tooling", "worker-9"]) {
    const reason = laneReason(captureRow, outsider);
    assert.ok(reason, `${outsider} must still be refused a fleet-gated row -- it is not in the routed pool`);
    assert.match(reason as string, /orchestrator/);
    assert.equal(decideClaim(captureRow, outsider).proceed, false);
  }
});

test("#1828 TWO-NAME POOL: the exemption fires for a member of the pool and only for one", () => {
  // The positive control for the branch the shipped one-name pool can no longer reach.
  assert.equal(laneReason(captureRow, "worker-capture", { pool: twoNamePool }), null,
    "a second pool member is admitted to the lane the other one's label names");
  assert.ok(laneReason(captureRow, "worker-9", { pool: twoNamePool }),
    "and a session outside the two-name pool is still refused");
});

test("#1828 TWO-NAME POOL, MUTATION target: without `fleet-gated` on the row, the exemption must not fire", () => {
  // Constructed so that a pool check keyed on `mySession`/`owner` alone, and not also on the row itself
  // carrying `fleet-gated`, would wrongly admit a pool member to an ORDINARY orchestrator lane row.
  assert.ok(laneReason(["ready", "lane:orchestrator"], "worker-capture", { pool: twoNamePool }),
    "a pool member must still be refused an orchestrator lane row that is not fleet-gated");
});

test("#1828: a lane:ceo row is untouched -- ceo is not in any ROUTED_TO pool", () => {
  // The pool-exemption must be scoped to members of the SAME pool as the asking session, not a blanket
  // OR for every `lane:` label on a `fleet-gated` row.
  assert.ok(laneReason(["ready", "fleet-gated", "lane:ceo"], "orchestrator"),
    "orchestrator is not ceo, and ceo owns this lane regardless of the fleet-gated label");
  assert.ok(laneReason(["ready", "fleet-gated", "lane:ceo"], "worker-capture", { pool: twoNamePool }),
    "and a two-name pool does not change that for a member of it");
});

test("#1828: ROUTED_TO['fleet-gated'] is read directly, so this suite and the pool cannot drift", () => {
  assert.deepEqual(ROUTED_TO["fleet-gated"], ["orchestrator"]);
});
