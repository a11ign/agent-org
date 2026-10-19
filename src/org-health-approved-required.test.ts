// no-token: pure -- every reading is a function of facts handed in; nothing here calls `gh`, git or the fleet.
/**
 * `src/org-health.ts`, agent-org#1248 (a11ign#928): AN APPROVED PULL REQUEST HELD AT `REVIEW_REQUIRED` FOR MORE THAN 10 MINUTES IS A NAMED HEALTH FINDING, WITH ITS AGE AND THE APPROVING IDENTITY.
 * It clears when `reviewDecision` leaves `REVIEW_REQUIRED`, when the pull request closes or merges, and when it takes a new head. The reading is behind `health.approvedRequired`, which ships OFF:
 * OFF is no reading at all, and the test pins that.
 *
 * THE FIXTURE is a `now` and PRs whose `heldSince` (when a tick first saw them approved and held) is set in minutes before `now` on the head they carry.
 * POSITIVE CONTROLS: 11 min trips with its age and approver; a PR past the window is named and one inside it is not.
 * NEGATIVE CONTROLS: 9 min and exactly 10 min are not findings; a new head clears it; `reviewDecision` APPROVED does not trip; a closed PR does not trip; OFF gives nothing.
 * MUTATIONS, run by hand: drop the `> window` check (the 9-min test goes red), always trip (every negative goes red), ignore the flag (the OFF test goes red).
 * ON THE OLD CODE the static import of the new exports is a link error, so every test here fails there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVED_REQUIRED_FLAG, APPROVED_REQUIRED_MINUTES, APPROVED_REQUIRED_SIGNAL, approvedRequiredReading, approvedRequiredReadings, type ApprovedRequiredPr } from "./org-health/hold-count.ts";
import { orgHealthOrders, orgHealthReadings } from "./org-health/fleet-build-readings.ts";
import { type Reading } from "./org-health/thresholds.ts";

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 12, 12, 0);
const ago = (minutes: number) => NOW - minutes * MINUTE;

const pr = (over: Partial<ApprovedRequiredPr> = {}): ApprovedRequiredPr => ({
  number: 1131, open: true, reviewDecision: "REVIEW_REQUIRED", head: "h2", approvers: ["a11ign-reviewer[bot]"], heldHead: "h2", heldSince: ago(11), ...over,
});

test("approved and held at REVIEW_REQUIRED for 11 minutes is a finding, named with its age and approver", () => {
  const reading = approvedRequiredReading({ now: NOW, prs: [pr()] });
  assert.equal(reading.signal, APPROVED_REQUIRED_SIGNAL);
  assert.equal(reading.status, "tripped");
  assert.match(reading.detail, /#1131 \(approved by a11ign-reviewer\[bot\], held 11 min\)/);
  assert.match(reading.detail, new RegExp(`over ${APPROVED_REQUIRED_MINUTES} min`));
});

test("the same PR held for 9 minutes is not a finding", () => {
  const reading = approvedRequiredReading({ now: NOW, prs: [pr({ heldSince: ago(9) })] });
  assert.equal(reading.status, "clear");
});

test("held for exactly the window is not a finding: the window is more than 10 minutes", () => {
  const reading = approvedRequiredReading({ now: NOW, prs: [pr({ heldSince: ago(APPROVED_REQUIRED_MINUTES) })] });
  assert.equal(reading.status, "clear");
});

test("a new head clears the finding: a stamp taken on an older head is not this head's age", () => {
  const reading = approvedRequiredReading({ now: NOW, prs: [pr({ head: "h3", heldHead: "h2", heldSince: ago(30) })] });
  assert.equal(reading.status, "clear");
});

test("reviewDecision APPROVED does not trip, and leaving REVIEW_REQUIRED clears", () => {
  assert.equal(approvedRequiredReading({ now: NOW, prs: [pr({ reviewDecision: "APPROVED" })] }).status, "clear");
  assert.equal(approvedRequiredReading({ now: NOW, prs: [pr({ reviewDecision: null })] }).status, "clear");
});

test("a closed or merged PR does not trip", () => {
  assert.equal(approvedRequiredReading({ now: NOW, prs: [pr({ open: false })] }).status, "clear");
});

test("a PR held at REVIEW_REQUIRED with no approval on its head is not this finding", () => {
  assert.equal(approvedRequiredReading({ now: NOW, prs: [pr({ approvers: [] })] }).status, "clear");
});

test("an approved PR that no tick has dated is unknown, not a finding", () => {
  const reading = approvedRequiredReading({ now: NOW, prs: [pr({ heldSince: null, heldHead: null })] });
  assert.equal(reading.status, "unknown");
});

test("a refused read of the open PRs is unknown, not clear", () => {
  assert.equal(approvedRequiredReading({ now: NOW, prs: null }).status, "unknown");
});

test("the finding is per PR: only the PR past the window is named", () => {
  const reading = approvedRequiredReading({ now: NOW, prs: [pr({ number: 1130, heldSince: ago(45) }), pr({ number: 1131, heldSince: ago(9) })] });
  assert.equal(reading.status, "tripped");
  assert.match(reading.detail, /#1130/);
  assert.doesNotMatch(reading.detail, /#1131/);
});

test("the finding says what it usually is: an approval the merge rule does not count, not a red check", () => {
  const reading = approvedRequiredReading({ now: NOW, prs: [pr()] });
  assert.match(reading.detail, /does not count toward the merge rule/);
  assert.doesNotMatch(reading.detail, /check/i);
});

test("the flag is named, and OFF is no reading at all", () => {
  assert.equal(APPROVED_REQUIRED_FLAG, "health.approvedRequired");
  assert.deepEqual(approvedRequiredReadings({ now: NOW, enabled: false, prs: [pr()] }), []);
});

test("ON, the reading reads its facts", () => {
  const on = approvedRequiredReadings({ now: NOW, enabled: true, prs: [pr()] });
  assert.deepEqual(on.map((r) => r.signal), [APPROVED_REQUIRED_SIGNAL]);
  assert.equal(on[0].status, "tripped");
});

test("orgHealthReadings adds nothing when approvedRequired is not passed or is off", () => {
  const base = { now: NOW, lastMergedAt: null, work: null, redPrs: null, refusals: null, drift: null, primarySince: null };
  const signals = (readings: Reading[]) => readings.map((r) => r.signal);
  const without = signals(orgHealthReadings(base));
  const off = signals(orgHealthReadings({ ...base, approvedRequired: { enabled: false, prs: [pr()] } }));
  assert.deepEqual(off, without);
  assert.equal(without.includes(APPROVED_REQUIRED_SIGNAL), false);
});

test("orgHealthReadings carries the reading when it is on", () => {
  const base = { now: NOW, lastMergedAt: null, work: null, redPrs: null, refusals: null, drift: null, primarySince: null };
  const on = orgHealthReadings({ ...base, approvedRequired: { enabled: true, prs: [pr()] } });
  assert.equal(on.find((r) => r.signal === APPROVED_REQUIRED_SIGNAL)?.status, "tripped");
});

test("a tripped reading orders its remedy, and it names the PR", () => {
  const readings = approvedRequiredReadings({ now: NOW, enabled: true, prs: [pr()] });
  const orders = orgHealthOrders(readings);
  assert.equal(orders.length, 1);
  assert.match(orders[0].prompt, /REVIEW_REQUIRED/);
  assert.match(orders[0].prompt, /#1131/);
  assert.match(orders[0].prompt, /Do not approve again/);
  assert.match(orders[0].causeKey, /org-health\//);
});
