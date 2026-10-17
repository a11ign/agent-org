// no-token: none -- the state directory is a throwaway one; nothing reaches GitHub, git, herdr or the fleet
/**
 * agent-org#1061: AN OPERATOR CAN TURN A MACHINERY FLAG ON WITH A COMMAND.
 *
 * THE DEFECT, 2026-10-11: `queue.reenqueueEjected` and `queue.chainWaitWake` had never been ON, because the only caller of `withMachineryFlag` was a test, so their
 * code returned before reading anything. The row's three tests, each reached from the command and read back through the reader the gate uses:
 *   (1) `on` makes `readReenqueueState` read the flag ON, and `off` makes it read OFF; before `on`, the same reader reads OFF (the positive control);
 *   (2) a name no module reads, and a signal the tick does not record, are REFUSED with nothing written; so is a state file that does not parse, left as it was;
 *   (3) `off` clears a `reverted` verdict, and `list` says who set each flag and when.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { main, FLAG_REGISTRY } from "../machinery-flag.ts";
import { CANARY_STATE_FILE, emptyCanaryState, machineryFlagOn, parseCanaryState, withMachineryFlag, type CanaryState } from "../org-health.ts";
import { readReenqueueState, REENQUEUE_EJECTED_FLAG, REENQUEUE_INFRA_FLAG } from "../work-gate/causes/pr-ejected.ts";
import { CHAIN_WAIT_FLAG } from "../work-gate/causes/org-health-chain-wait.ts";
import { CLOSED_UNDER_HALF_FLAG } from "../work-gate/causes/rows-closed-under-half.ts";
import { CHAIRMAN_REFUSAL_FLAG } from "../work-gate/causes/rows-offer.ts";
import { OWNERLESS_ASK_FLAG } from "../work-gate/pr-orders.ts";
import { VERDICT_DELIVERY_FLAG } from "../review-trust.ts"; // agent-org#1649
import { SESSION_PR_OUTSIDE_FLAG } from "../work-gate/outside-session-pr.ts"; // agent-org#1667
import { PACING_FLAG } from "../work-gate/pacing.ts";
import { REFUSE_AUTHOR_FALLBACK_FLAG } from "../gh-author-fallback.ts";
import { PR_OWNER_ROUTING_FLAG, ROW_REVIEW_SKILL_FLAG } from "../work-gate/pr-orders.ts";
import { QUEUE_ENTRY_NO_RUN_FLAG } from "../work-gate/causes/queue-entry-no-run.ts";
import { RECHECK_FLAG } from "../work-gate/shared-file-orders.ts";
import { AUTO_UNPARK_FLAG } from "../unpark-satisfied.ts";
import { OPEN_PR_HOLD_FLAG } from "../prune-worktrees.ts";
import { REFUSE_ASKING_ANNOUNCEMENTS_FLAG } from "../messaging/core.ts";
import { ACCOUNT_LIMIT_FLAG } from "../account-limit.ts";
import { SAME_HEAD_REFAIL_FLAG } from "../work-gate/pr-orders.ts";

const SESSION = "worker-agent-org-1061";
const T0 = Date.parse("2026-10-12T09:00:00Z");
const REFUSED = 2;

/** Runs the command against `dir`, capturing what it said; `now` is fixed so the record's time is checkable. */
function run(dir: string, argv: string[], now = T0) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, { dir, now, out: (text) => out.push(text), err: (text) => err.push(text) });
  return { code, out: out.join(""), err: err.join("") };
}

/** The reader the gate uses for `queue.reenqueueEjected`, on the same directory; its log is silenced, since a malformed file is a case below. */
const reenqueueOn = (dir: string) => machineryFlagOn(readReenqueueState(dir, () => {}), REENQUEUE_EJECTED_FLAG);

test("(1) `on` makes the reader read the flag ON, `off` makes it read OFF, and the flag is OFF before anything is switched", () => {
  const dir = tmpDir("machinery-flag-switch-");
  assert.equal(reenqueueOn(dir), false, "POSITIVE CONTROL: no state file reads the flag OFF");

  const on = run(dir, ["on", REENQUEUE_EJECTED_FLAG, `--session=${SESSION}`]);
  assert.equal(on.code, 0, on.err);
  assert.equal(reenqueueOn(dir), true, "the reader sees the flag ON after `on`");

  const off = run(dir, ["off", REENQUEUE_EJECTED_FLAG, `--session=${SESSION}`]);
  assert.equal(off.code, 0, off.err);
  assert.equal(reenqueueOn(dir), false, "the reader sees the flag OFF after `off`");
});

test("(1) the other registered flags are switched on and read through their own readers' flag name", () => {
  const dir = tmpDir("machinery-flag-switch-");
  for (const name of [REENQUEUE_INFRA_FLAG, CHAIN_WAIT_FLAG, CLOSED_UNDER_HALF_FLAG, AUTO_UNPARK_FLAG, QUEUE_ENTRY_NO_RUN_FLAG, RECHECK_FLAG, OPEN_PR_HOLD_FLAG, REFUSE_ASKING_ANNOUNCEMENTS_FLAG, ROW_REVIEW_SKILL_FLAG, SAME_HEAD_REFAIL_FLAG, CHAIRMAN_REFUSAL_FLAG, OWNERLESS_ASK_FLAG, REFUSE_AUTHOR_FALLBACK_FLAG, VERDICT_DELIVERY_FLAG, SESSION_PR_OUTSIDE_FLAG]) assert.equal(run(dir, ["on", name, `--session=${SESSION}`]).code, 0);
  const state = JSON.parse(readFileSync(join(dir, CANARY_STATE_FILE), "utf8")) as CanaryState;
  assert.equal(machineryFlagOn(state, CHAIN_WAIT_FLAG), true);
  assert.equal(machineryFlagOn(state, CLOSED_UNDER_HALF_FLAG), true);
  assert.equal(machineryFlagOn(state, AUTO_UNPARK_FLAG), true, "rows.autoUnpark is switched by the command, which the gate's reader then sees");
  assert.equal(machineryFlagOn(state, QUEUE_ENTRY_NO_RUN_FLAG), true, "queue.queueEntryNoRun is switched by the command, which the gate's reader then sees (agent-org#1195)");
  assert.equal(machineryFlagOn(state, RECHECK_FLAG), true, "holds.recheck is switched by the command, which `recheckFlagOn` then reads (agent-org#1187)");
  assert.equal(machineryFlagOn(state, OPEN_PR_HOLD_FLAG), true, "prune.holdOpenPr is switched by the command, which `openPrHoldOn` then reads (agent-org#1221)");
  assert.equal(machineryFlagOn(state, REFUSE_ASKING_ANNOUNCEMENTS_FLAG), true, "messaging.refuseAskingAnnouncements is switched by the command, which `canaryFlagOn` in watch.ts then reads (agent-org#1222)");
  assert.equal(machineryFlagOn(state, ROW_REVIEW_SKILL_FLAG), true, "review.rowReviewSkill is switched by the command, which `rowReviewSkillFlagOn` then reads (agent-org#1268)");
  assert.equal(machineryFlagOn(state, SAME_HEAD_REFAIL_FLAG), true, "checks.sameHeadRefail is switched by the command, which `sameHeadRefailFlagOn` then reads (agent-org#1185)");
  assert.equal(machineryFlagOn(state, CHAIRMAN_REFUSAL_FLAG), true, "chairman.refusedOnce is switched by the command, which `offerHierarchyNow` then reads (agent-org#1456)");
  assert.equal(machineryFlagOn(state, OWNERLESS_ASK_FLAG), true, "prs.ownerlessAsk is switched by the command, which `ownerlessAskFlagOn` then reads (agent-org#1648)");
  assert.equal(machineryFlagOn(state, REENQUEUE_INFRA_FLAG), true, "queue.reenqueueInfra is switched by the command, which `requeueEjected` then reads (agent-org#1647)");
  assert.equal(machineryFlagOn(state, REFUSE_AUTHOR_FALLBACK_FLAG), true, "gh.refuseFallbackAuthor is switched by the command, which the wrapper's `author_refusal_on` then reads (agent-org#1666)");
  assert.equal(machineryFlagOn(state, VERDICT_DELIVERY_FLAG), true, "reviews.verdictDelivery is switched by the command, which `wake` then reads (agent-org#1649)");
  assert.equal(machineryFlagOn(state, SESSION_PR_OUTSIDE_FLAG), true, "reviews.outsideSessionPr is switched by the command, which `outsideSessionPrFlagOn` then reads (agent-org#1667)");
  assert.deepEqual(FLAG_REGISTRY, [REENQUEUE_EJECTED_FLAG, REENQUEUE_INFRA_FLAG, CHAIN_WAIT_FLAG, CLOSED_UNDER_HALF_FLAG, AUTO_UNPARK_FLAG, QUEUE_ENTRY_NO_RUN_FLAG, RECHECK_FLAG, OPEN_PR_HOLD_FLAG, REFUSE_ASKING_ANNOUNCEMENTS_FLAG, PACING_FLAG, ROW_REVIEW_SKILL_FLAG, ACCOUNT_LIMIT_FLAG, SAME_HEAD_REFAIL_FLAG, PR_OWNER_ROUTING_FLAG, CHAIRMAN_REFUSAL_FLAG, OWNERLESS_ASK_FLAG, REFUSE_AUTHOR_FALLBACK_FLAG, VERDICT_DELIVERY_FLAG, SESSION_PR_OUTSIDE_FLAG], "the registry is the eighteen flags a module reads");
});

test("(2) a name no module reads is refused, and nothing is written", () => {
  const dir = tmpDir("machinery-flag-switch-");
  const result = run(dir, ["on", "queue.reenqueueEjectd", `--session=${SESSION}`]);
  assert.equal(result.code, REFUSED);
  assert.match(result.err, /is not a flag any module reads/);
  assert.equal(existsSync(join(dir, CANARY_STATE_FILE)), false, "no state file was written");
});

test("(2) a signal the tick does not record is refused, and nothing is written", () => {
  const dir = tmpDir("machinery-flag-switch-");
  const result = run(dir, ["on", REENQUEUE_EJECTED_FLAG, "--signals=claims-refused,made-up", `--session=${SESSION}`]);
  assert.equal(result.code, REFUSED);
  assert.match(result.err, /made-up is not a signal the tick records/);
  assert.equal(existsSync(join(dir, CANARY_STATE_FILE)), false);
});

test("(2) a state file that does not parse is refused and left as it was", () => {
  const dir = tmpDir("machinery-flag-switch-");
  const garbage = "{ not the state";
  writeFileSync(join(dir, CANARY_STATE_FILE), garbage);
  const result = run(dir, ["on", REENQUEUE_EJECTED_FLAG, `--session=${SESSION}`]);
  assert.equal(result.code, REFUSED);
  assert.match(result.err, /is unreadable/);
  assert.equal(readFileSync(join(dir, CANARY_STATE_FILE), "utf8"), garbage, "the malformed file is not overwritten");
});

test("(2) a switch without a session is refused, since the record says who made it", () => {
  const dir = tmpDir("machinery-flag-switch-");
  assert.equal(run(dir, ["on", REENQUEUE_EJECTED_FLAG]).code, REFUSED);
  assert.equal(existsSync(join(dir, CANARY_STATE_FILE)), false);
});

test("(3) `off` clears a reverted verdict, so the canary may watch the flag again when it is turned on", () => {
  const dir = tmpDir("machinery-flag-switch-");
  const reverted: CanaryState = {
    ...emptyCanaryState(),
    flags: { [REENQUEUE_EJECTED_FLAG]: { ...withMachineryFlag(emptyCanaryState(), { name: REENQUEUE_EJECTED_FLAG, on: true }).flags[REENQUEUE_EJECTED_FLAG], on: false, verdict: "reverted", decidedAt: T0 - 1000, incident: "a11ign#1" } },
  };
  writeFileSync(join(dir, CANARY_STATE_FILE), JSON.stringify(reverted));
  assert.equal(run(dir, ["off", REENQUEUE_EJECTED_FLAG, `--session=${SESSION}`]).code, 0);
  const after = JSON.parse(readFileSync(join(dir, CANARY_STATE_FILE), "utf8")) as CanaryState;
  assert.equal(after.flags[REENQUEUE_EJECTED_FLAG].verdict, null, "the reverted verdict is cleared");
  assert.equal(machineryFlagOn(after, REENQUEUE_EJECTED_FLAG), false);
  assert.equal(run(dir, ["on", REENQUEUE_EJECTED_FLAG, `--session=${SESSION}`]).code, 0);
  const again = JSON.parse(readFileSync(join(dir, CANARY_STATE_FILE), "utf8")) as CanaryState;
  assert.equal(again.flags[REENQUEUE_EJECTED_FLAG].onAt, null, "turned on again, the canary's hour is not yet begun: the gate starts it on its next tick");
});

test("(3) the record says who turned the flag on and when, and `list` prints it", () => {
  const dir = tmpDir("machinery-flag-switch-");
  assert.equal(run(dir, ["on", REENQUEUE_EJECTED_FLAG, "--signals=claims-refused", `--session=${SESSION}`]).code, 0);
  const state = JSON.parse(readFileSync(join(dir, CANARY_STATE_FILE), "utf8")) as CanaryState & { flags: Record<string, { setBy?: string; setAt?: number; signals: string[] }> };
  assert.equal(state.flags[REENQUEUE_EJECTED_FLAG].setBy, SESSION);
  assert.equal(state.flags[REENQUEUE_EJECTED_FLAG].setAt, T0);
  assert.deepEqual(state.flags[REENQUEUE_EJECTED_FLAG].signals, ["claims-refused"], "--signals sets the signals the canary watches");

  const listed = run(dir, ["list"]);
  assert.equal(listed.code, 0);
  assert.match(listed.out, new RegExp(`${REENQUEUE_EJECTED_FLAG.replace(".", "\\.")}  ON .*set by ${SESSION} at 2026-10-12T09:00:00\\.000Z`));
  assert.match(listed.out, new RegExp(`${CHAIN_WAIT_FLAG.replace(".", "\\.")}  OFF`), "a flag nobody set is listed OFF");
});
