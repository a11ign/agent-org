// no-token: pure -- every reading is a function of facts handed in; nothing here calls `gh`, git or the fleet.
/**
 * `src/org-health.ts`, agent-org#1168 (a11ign#928): AN APPROVED PULL REQUEST THAT HAS BEEN DIRTY FOR MORE THAN 30 MINUTES, WITH NO PUSH TO ITS HEAD IN THAT WINDOW, IS A NAMED FINDING WITH ITS AGE.
 * It clears when the PR rebases or merges (a push inside the window, or the PR no longer DIRTY and approved). The three readings are behind `health.approvedDirty`, which ships OFF:
 * OFF is no reading at all, and the test pins that.
 *
 * THE FIXTURE is a `now` and PRs whose `dirtySince` (when a tick first saw them DIRTY) and `headPushedAt` are set in minutes before `now`.
 * POSITIVE CONTROLS: 31 min DIRTY trips with its age; a push inside the window clears; a holds count of 3 trips; a head whose last two runs failed the same jobs trips.
 * NEGATIVE CONTROLS: 29 min is not a finding; a push 5 min ago clears; 2 holds is not a finding; differing failing jobs are not a same-way rerun; OFF gives nothing.
 * MUTATIONS, run by hand: drop the `> window` check (the 29-min test goes red), always trip (every negative goes red), ignore the flag (the OFF test goes red).
 * ON THE OLD CODE the static import of the new exports is a link error, so every test here fails there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVED_DIRTY_FLAG, APPROVED_DIRTY_MINUTES, APPROVED_DIRTY_SIGNAL, HOLDS_PER_PR, HOLDS_PER_PR_SIGNAL, SAME_WAY_RERUN_SIGNAL, type DirtyPr } from "./org-health/claim-refusal.ts";
import { approvedDirtyReading, approvedDirtyReadings, holdsPerPrReading, sameWayRerunReading } from "./org-health/hold-count.ts";
import { orgHealthOrders, orgHealthReadings } from "./org-health/fleet-build-readings.ts";
import { type Reading } from "./org-health/thresholds.ts";

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 12, 12, 0);
const ago = (minutes: number) => NOW - minutes * MINUTE;

const pr = (over: Partial<DirtyPr> = {}): DirtyPr => ({ number: 1131, approved: true, mergeStateStatus: "DIRTY", dirtySince: ago(31), headPushedAt: ago(90), ...over });

test("approved and DIRTY for 31 minutes is a finding, named with its age", () => {
  const reading = approvedDirtyReading({ now: NOW, prs: [pr()] });
  assert.equal(reading.signal, APPROVED_DIRTY_SIGNAL);
  assert.equal(reading.status, "tripped");
  assert.match(reading.detail, /#1131 \(DIRTY 31 min\)/);
  assert.match(reading.detail, new RegExp(`over ${APPROVED_DIRTY_MINUTES} min`));
});

test("the same PR at 29 minutes is not a finding", () => {
  const reading = approvedDirtyReading({ now: NOW, prs: [pr({ dirtySince: ago(29) })] });
  assert.equal(reading.status, "clear");
});

test("a head push inside the window clears the finding; the PR is still DIRTY", () => {
  const reading = approvedDirtyReading({ now: NOW, prs: [pr({ headPushedAt: ago(5) })] });
  assert.equal(reading.status, "clear");
});

test("the finding clears once the PR is no longer DIRTY (rebased or merged)", () => {
  assert.equal(approvedDirtyReading({ now: NOW, prs: [pr({ mergeStateStatus: "CLEAN" })] }).status, "clear");
  assert.equal(approvedDirtyReading({ now: NOW, prs: [pr({ approved: false })] }).status, "clear");
});

test("a DIRTY PR that no tick has dated is unknown, not a finding", () => {
  const reading = approvedDirtyReading({ now: NOW, prs: [pr({ dirtySince: null })] });
  assert.equal(reading.status, "unknown");
});

test("a DIRTY PR past the window whose head push time is unread is unknown, not a finding", () => {
  const reading = approvedDirtyReading({ now: NOW, prs: [pr({ headPushedAt: null })] });
  assert.equal(reading.status, "unknown");
  assert.doesNotMatch(reading.detail, /#1131/);
});

test("an unread push time does not hide a PR whose known push is outside the window", () => {
  const reading = approvedDirtyReading({ now: NOW, prs: [pr({ number: 1130, headPushedAt: null }), pr({ number: 1131, headPushedAt: ago(90) })] });
  assert.equal(reading.status, "tripped");
  assert.match(reading.detail, /#1131/);
  assert.doesNotMatch(reading.detail, /#1130/);
});

test("a refused read of the open PRs is unknown, not clear", () => {
  assert.equal(approvedDirtyReading({ now: NOW, prs: null }).status, "unknown");
});

test("the finding is per PR: only the PR past the window is named", () => {
  const reading = approvedDirtyReading({ now: NOW, prs: [pr({ number: 1130, dirtySince: ago(45) }), pr({ number: 1131, dirtySince: ago(10) })] });
  assert.equal(reading.status, "tripped");
  assert.match(reading.detail, /#1130/);
  assert.doesNotMatch(reading.detail, /#1131/);
});

test("the same reading on a rerun of the same facts is the same reading", () => {
  const facts = [pr({ number: 1130, dirtySince: ago(45) })];
  const first: Reading = approvedDirtyReading({ now: NOW, prs: facts });
  const second: Reading = approvedDirtyReading({ now: NOW + 5 * MINUTE, prs: facts });
  assert.equal(first.status, "tripped");
  assert.equal(second.status, "tripped");
  assert.equal(first.discriminator, approvedDirtyReading({ now: NOW, prs: facts }).discriminator);
});

test("the three readings are off when the flag is off: no reading at all", () => {
  assert.equal(APPROVED_DIRTY_FLAG, "health.approvedDirty");
  const off = approvedDirtyReadings({
    now: NOW, enabled: false,
    prs: [pr()], holds: [{ number: 1, holds: 9 }], reruns: [{ number: 1, attempts: [["a"], ["a"]] }],
  });
  assert.deepEqual(off, []);
});

test("the three readings are on when the flag is on and each reads its own facts", () => {
  const on = approvedDirtyReadings({
    now: NOW, enabled: true,
    prs: [pr()], holds: [{ number: 1, holds: 3 }], reruns: [{ number: 2, attempts: [["lint"], ["lint"]] }],
  });
  assert.deepEqual(on.map((r) => r.signal), [APPROVED_DIRTY_SIGNAL, HOLDS_PER_PR_SIGNAL, SAME_WAY_RERUN_SIGNAL]);
  assert.ok(on.every((r) => r.status === "tripped"));
});

test("orgHealthReadings adds nothing when approvedDirty is not passed or is off", () => {
  const base = { now: NOW, lastMergedAt: null, work: null, redPrs: null, refusals: null, drift: null, primarySince: null };
  const signals = (readings: Reading[]) => readings.map((r) => r.signal);
  const without = signals(orgHealthReadings(base));
  const off = signals(orgHealthReadings({ ...base, approvedDirty: { enabled: false, prs: [pr()], holds: null, reruns: null } }));
  assert.deepEqual(off, without);
});

test("holds: 3 holds on one PR trips and names it; 2 do not", () => {
  const tripped = holdsPerPrReading({ holds: [{ number: 1131, holds: HOLDS_PER_PR }, { number: 1130, holds: 1 }] });
  assert.equal(tripped.signal, HOLDS_PER_PR_SIGNAL);
  assert.equal(tripped.status, "tripped");
  assert.match(tripped.detail, /#1131 \(3 holds\)/);
  assert.doesNotMatch(tripped.detail, /#1130/);
  assert.equal(holdsPerPrReading({ holds: [{ number: 1131, holds: HOLDS_PER_PR - 1 }] }).status, "clear");
  assert.equal(holdsPerPrReading({ holds: null }).status, "unknown");
});

test("same-way rerun: the last two runs failing the same jobs trips; different jobs and a pass do not", () => {
  const tripped = sameWayRerunReading({ reruns: [{ number: 1131, attempts: [["lint", "unit"], ["unit", "lint"]] }] });
  assert.equal(tripped.signal, SAME_WAY_RERUN_SIGNAL);
  assert.equal(tripped.status, "tripped");
  assert.match(tripped.detail, /#1131 \(lint, unit\)/);
  assert.equal(sameWayRerunReading({ reruns: [{ number: 1131, attempts: [["lint"], ["unit"]] }] }).status, "clear");
  assert.equal(sameWayRerunReading({ reruns: [{ number: 1131, attempts: [[], []] }] }).status, "clear");
  assert.equal(sameWayRerunReading({ reruns: null }).status, "unknown");
});

test("a tripped approved-DIRTY reading orders its remedy, and it names the PR", () => {
  const readings = approvedDirtyReadings({ now: NOW, enabled: true, prs: [pr({ number: 1131, dirtySince: ago(31) })], holds: [], reruns: [] });
  const orders = orgHealthOrders(readings);
  assert.equal(orders.length, 1);
  assert.match(orders[0].prompt, /DIRTY/);
  assert.match(orders[0].prompt, /#1131/);
  assert.match(orders[0].causeKey, /org-health\//);
});
