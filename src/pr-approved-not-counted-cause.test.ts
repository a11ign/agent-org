// no-token: gh -- pure: `perPullRequestOrders` and `decide` over in-memory pull requests; nothing reaches `gh`, `git` or herdr
/**
 * #1249: A PULL REQUEST APPROVED AT ITS HEAD AND HELD BY GITHUB AS `REVIEW_REQUIRED` IS FILED UNDER `pr-approval-not-counted`, TO `ceo`, NOT `pr-checks-failing`.
 *
 * THE DEFECT: `unorderedOrder` filed `pr-checks-failing` for every pull request the draft order left unanswered and GitHub held for review, approved or not,
 * so an approval already in hand was briefed to its owner as a red build. A RED head still reads `pr-checks-failing`, and that is the control that keeps
 * the new cause from swallowing a real failure.
 *
 * THE CONTROLS ARE ONE FACT APART. (1) and (2) are the approved positives; (3) is the red head, approved, which must keep `pr-checks-failing`; (4) is the
 * unapproved twin of each, which must keep its old order; (5) is the stale-head approval, which is not at the head and so not counted at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { perPullRequestOrders, CHECKLESS_QUIET_MINUTES } from "./work-gate/pr-orders.ts";
import { decide } from "./work-gate/tick/tick-decisions-and-flags.ts";

type Order = { session: string, fallback?: string, cause: string, causeKey: string, discriminator: string, prompt: string };
type Pr = Record<string, unknown>;

const NOW = Date.parse("2026-10-07T16:00:00Z");
const MINUTE = 60_000;
const quietFor = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString();
const SETTLED = (name: string) => ({ name, status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-07T14:00:00Z", completedAt: "2026-10-07T14:05:00Z" });
/** The `ci` jobs, every one success, and `gate` nowhere: the #3997 shape. */
const WITHOUT_GATE = ["lint", "typecheck", "test", "deliberateRefusals"].map(SETTLED);
const WITH_GATE = [...WITHOUT_GATE, SETTLED("gate")];
/** A settled rollup whose REQUIRED `gate` is red: a red head, so `pr-checks-failing` is the answer whatever the approval says. Only a required check holds a PR, so the red one is `gate`. */
const RED = [...WITHOUT_GATE, { ...SETTLED("gate"), conclusion: "FAILURE" }];
const REQUIRED = ["gate"];
const HEAD = "ab698778cafe0000";
const OTHER_HEAD = "fedc4321cafe0000";
const APPROVED_AT_HEAD = [{ state: "APPROVED", commit: { oid: HEAD } }];

const prOf = (over: Pr = {}): Pr => ({
  number: 1249, headRefOid: HEAD, isDraft: false, statusCheckRollup: WITH_GATE, updatedAt: quietFor(1), mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED", headRefName: "agent/some-slug-3993", repoKey: "agent-org", repo: "a11ign/agent-org",
  labels: [{ name: "session:worker-3993" }], closingIssuesReferences: [], comments: [], reviews: [],
  author: { login: "a11ign-ai-workers" }, reviewDecision: "REVIEW_REQUIRED", ...over,
});
const ordersOf = (pr: Pr, nowMs = NOW): Order[] => perPullRequestOrders([pr], REQUIRED, null, nowMs) as Order[];
const approvalOf = (pr: Pr, nowMs = NOW): Order[] => ordersOf(pr, nowMs).filter((o) => o.cause === "pr-approval-not-counted");

test("(1) green + approved at head + REVIEW_REQUIRED -> ONE order, `pr-approval-not-counted` to `ceo`; no reviewer is asked again, and no `pr-checks-failing`", () => {
  const orders = ordersOf(prOf({ reviews: APPROVED_AT_HEAD }));
  assert.deepEqual(orders.map((o) => [o.session, o.cause]), [["ceo", "pr-approval-not-counted"]]);
  assert.equal(orders.some((o) => o.cause === "pr-checks-failing"), false);
  assert.equal(orders[0].causeKey, "ceo/pr-approval-not-counted/pr-agent-org#1249/ab698778");
  assert.match(orders[0].prompt, /is APPROVED by a reviewer, and GitHub still holds it for review \(`REVIEW_REQUIRED`\)/);
  assert.equal(orders[0].fallback, undefined, "`ceo` is the last reader here; there is no fallback to name");
});

test("(2) approved at head, `gate` ABSENT and quiet 30 minutes (#3997's shape) -> `pr-approval-not-counted` to `ceo`, and not `pr-checks-failing` unordered", () => {
  const pr = prOf({ reviews: APPROVED_AT_HEAD, statusCheckRollup: WITHOUT_GATE, updatedAt: quietFor(CHECKLESS_QUIET_MINUTES) });
  const orders = ordersOf(pr);
  assert.deepEqual(orders.map((o) => [o.session, o.cause]), [["ceo", "pr-approval-not-counted"]]);
  assert.equal(orders.some((o) => o.causeKey.includes("/unordered/")), false, "the unordered order is replaced here, not added to");
  assert.equal(approvalOf(pr, NOW - 1).length, 0, "29:59.999 quiet is not yet asked, as the unordered order it replaces was not");
});

test("(3) the RED head, approved at head -> `pr-checks-failing` still, and never `pr-approval-not-counted`: the red order comes first", () => {
  const red = prOf({ reviews: APPROVED_AT_HEAD, statusCheckRollup: RED });
  const orders = ordersOf(red);
  assert.ok(orders.some((o) => o.cause === "pr-checks-failing"), "a red head is a failing-checks order, approved or not");
  assert.equal(orders.some((o) => o.cause === "pr-approval-not-counted"), false);
  const failingNotRequired = prOf({ reviews: APPROVED_AT_HEAD, statusCheckRollup: [...WITH_GATE, { ...SETTLED("deliberateRefusals"), conclusion: "FAILURE" }] });
  assert.equal(ordersOf(failingNotRequired).some((o) => o.cause === "pr-approval-not-counted"), true, "a red job OUTSIDE the required set does not hold the PR, so the approval is the question");
});

test("(4) the unapproved twins keep their orders: green -> the reviewer's `draft-awaiting-verdict`; #3997's shape -> `pr-checks-failing` unordered", () => {
  const green = ordersOf(prOf());
  assert.deepEqual(green.map((o) => [o.session, o.cause]), [["reviewer-agent-org-1249", "draft-awaiting-verdict"]]);
  const unordered = ordersOf(prOf({ statusCheckRollup: WITHOUT_GATE, updatedAt: quietFor(CHECKLESS_QUIET_MINUTES) }));
  assert.deepEqual(unordered.map((o) => [o.session, o.cause]), [["worker-3993", "pr-checks-failing"]]);
  assert.match(unordered[0].causeKey, /\/unordered\//);
  assert.equal(approvalOf(prOf()).length, 0);
});

test("(5) a stale-head approval (at a head the PR has moved past) is not counted for the head: the green twin is the reviewer's, the unordered twin is `pr-checks-failing`", () => {
  const stale = [{ state: "APPROVED", commit: { oid: OTHER_HEAD } }];
  assert.equal(approvalOf(prOf({ reviews: stale })).length, 0, "green, stale approval");
  assert.deepEqual(ordersOf(prOf({ reviews: stale })).map((o) => o.cause), ["draft-awaiting-verdict"]);
  const unordered = prOf({ reviews: stale, statusCheckRollup: WITHOUT_GATE, updatedAt: quietFor(CHECKLESS_QUIET_MINUTES) });
  assert.equal(approvalOf(unordered).length, 0, "unordered, stale approval");
  assert.deepEqual(ordersOf(unordered).map((o) => o.cause), ["pr-checks-failing"]);
});

test("(6) controls: a draft, a decision GitHub already counts, and an unreadable review list are never this cause", () => {
  assert.equal(approvalOf(prOf({ reviews: APPROVED_AT_HEAD, isDraft: true })).length, 0, "draft");
  assert.equal(approvalOf(prOf({ reviews: APPROVED_AT_HEAD, reviewDecision: "APPROVED" })).length, 0, "GitHub counts it: APPROVED is not held");
  const unread = prOf({ reviews: APPROVED_AT_HEAD }); delete unread.reviews;
  assert.equal(approvalOf(unread).length, 0, "reviews not read: null is never an accusation");
});

test("(7) the new cause is `decide`'s, through the gate at its own clock, and it is one order per head", () => {
  const decided = decide({ prs: [prOf({ reviews: APPROVED_AT_HEAD })], readyRows: [], required: REQUIRED, nowMs: NOW }) as Order[];
  assert.deepEqual(decided.filter((o) => o.cause === "pr-approval-not-counted").map((o) => o.session), ["ceo"]);
  assert.equal(decided.some((o) => o.cause === "draft-awaiting-verdict"), false);
  const two = ordersOf(prOf({ reviews: APPROVED_AT_HEAD })).concat(ordersOf(prOf({ reviews: APPROVED_AT_HEAD, number: 1250 })));
  assert.equal(new Set(two.map((o) => o.causeKey)).size, 2);
});
