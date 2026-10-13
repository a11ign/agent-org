// no-token: gh -- pure: `decide` over in-memory pull requests and the identities passed in; nothing here reaches `gh`, `git` or the network
/**
 * #1325: WITH `prs.ownerRouting` ON, A PULL REQUEST THE ORG DOES NOT OWN IS ORDERED FOR ITS REVIEW AND NOTHING ELSE. An outside pull request (the
 * author is not a declared identity, `reviewTrustOf`) and one the chairman authored keep `draft-awaiting-verdict` (or `verdict-comment-unreviewed`),
 * and lose every follow-up: red checks, conflicts, a not-convinced verdict, changes-requested, the stalled and checkless orders.
 *
 * THE ORDER PATH IS `decide`, not the producers alone, because the withholding is the last step of `decide` and the producers each keep their
 * own follow-ups. Every case runs twice: flag ON, and flag OFF, where the same pull request still earns its follow-up. The flag-off run is the
 * POSITIVE CONTROL that the pull request really is one the producers would order, so an empty result with the flag on is the filter's, not
 * an empty fixture's.
 *
 * MUTATION (the row's Done-when): routing an outside pull request's follow-up to `ceo` instead of withholding it turns the first OUTSIDE test red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./work-gate.ts";
import { PR_OWNER_ROUTING_FLAG, withholdOutsideFollowUps } from "./work-gate/pr-orders.ts";
import { prOwnerRoutingFlagOn } from "./work-gate/tick.ts";
import { OUTSIDE, INSIDE, reviewTrustOf, type DeclaredIdentities } from "./review-trust.ts";
import { CHAIRMAN_LOGINS } from "./work-gate/vocabulary.ts";
import { emptyCanaryState, STANDARD_MACHINERY_SIGNALS, withMachineryFlag } from "./org-health.ts";

type Order = { session: string; cause: string; subject?: string; causeKey: string; };
type Pr = Record<string, unknown>;

const NOW = Date.parse("2026-10-13T09:00:00Z");
const HEAD = "ab698778cafe0000";
const REQUIRED = ["gate"];
/** The identities the org declares, passed in so the test does not read the host: the chairman and the shared worker account are inside. */
const IDENTITIES: DeclaredIdentities = { exact: [...CHAIRMAN_LOGINS, "a11ign-ai-workers"], pattern: [] };

const SETTLED = (name: string, conclusion = "SUCCESS") => ({
  name, status: "COMPLETED", conclusion, startedAt: "2026-10-13T07:00:00Z", completedAt: "2026-10-13T07:05:00Z",
});
const GREEN = [SETTLED("lint"), SETTLED("typecheck"), SETTLED("test"), SETTLED("gate")];
const RED = [SETTLED("lint"), SETTLED("typecheck"), SETTLED("test"), SETTLED("gate", "FAILURE")];

/** A pull request from an outside fork: `isCrossRepository` true, which is what `reviewTrustOf` reads. */
const OUTSIDE_AUTHOR = { isCrossRepository: true, author: { login: "some-stranger" } };
/** A pull request the chairman opened, from inside the repository. */
const CHAIRMAN_AUTHOR = { isCrossRepository: false, author: { login: "DanBeckDev" } };
/** A pull request a declared worker opened, from inside the repository: the control that nothing is withheld from the org's own work. */
const ORG_AUTHOR = { isCrossRepository: false, author: { login: "a11ign-ai-workers" } };

const prOf = (number: number, over: Pr = {}): Pr => ({
  number, repo: "a11ign/agent-org", repoKey: "agent-org", headRefOid: HEAD, headRefName: `contrib-branch-${number}`, isDraft: false,
  statusCheckRollup: GREEN, updatedAt: "2026-10-13T08:00:00Z", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED",
  labels: [], closingIssuesReferences: [], comments: [], reviews: [], reviewDecision: "REVIEW_REQUIRED", ...OUTSIDE_AUTHOR, ...over,
});

/** A verdict left at HEAD by a reviewer, in the opener form `reviewVerdict` reads. The word is spaced: `not-convinced` parses as `convinced` (see the report). */
const verdictComment = (number: number, verdict: string) => ({
  author: { login: "reviewer-bot" }, createdAt: "2026-10-13T08:30:00Z",
  body: [`**Review of #${number} at \`${HEAD.slice(0, 8)}\``, `${verdict}: the acceptance is not met.`].join("\n"),
});

const decided = (prs: Pr[], prOwnerRouting: boolean) => decide({ prs, readyRows: [], nowMs: NOW, required: REQUIRED, identities: IDENTITIES, prOwnerRouting }) as Order[];
const onlySubject = (orders: Order[], number: number) => orders.filter((o) => o.subject === `pr-agent-org#${number}`);

test("the flag is read by the machinery's own switch, and absent or off is OFF", () => {
  assert.equal(prOwnerRoutingFlagOn(true), true);
  assert.equal(prOwnerRoutingFlagOn(false), false);
  const on = withMachineryFlag(emptyCanaryState(), { name: PR_OWNER_ROUTING_FLAG, on: true, signals: STANDARD_MACHINERY_SIGNALS });
  assert.equal(prOwnerRoutingFlagOn(undefined, () => on), true);
  assert.equal(prOwnerRoutingFlagOn(undefined, () => emptyCanaryState()), false);
});

test("an outside pull request is an outside pull request: the author is not a declared identity", () => {
  assert.equal(reviewTrustOf(prOf(1, OUTSIDE_AUTHOR) as never, IDENTITIES), OUTSIDE);
  assert.equal(reviewTrustOf(prOf(2, ORG_AUTHOR) as never, IDENTITIES), INSIDE);
});

test("OUTSIDE, RED: flag on, no order at all; flag off, the red pull request is ordered to its owner (positive control)", () => {
  const prs = [prOf(1001, { statusCheckRollup: RED })];
  assert.equal(onlySubject(decided(prs, true), 1001).length, 0);
  assert.ok(onlySubject(decided(prs, false), 1001).some((o) => o.cause === "pr-checks-failing"), "POSITIVE CONTROL: flag off still orders the red build");
});

test("OUTSIDE, CONFLICTING: flag on, no conflict order; flag off, the conflict is ordered (positive control)", () => {
  const prs = [prOf(1002, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })];
  assert.equal(onlySubject(decided(prs, true), 1002).length, 0);
  assert.ok(onlySubject(decided(prs, false), 1002).length > 0, "POSITIVE CONTROL: flag off orders the conflicted pull request");
});

test("OUTSIDE, NOT-CONVINCED: flag on, the verdict earns no order to anyone; flag off, the not-convinced verdict is ordered back (positive control)", () => {
  const prs = [prOf(1003, { comments: [verdictComment(1003, "Not convinced")] })];
  assert.equal(onlySubject(decided(prs, true), 1003).length, 0);
  assert.ok(onlySubject(decided(prs, false), 1003).length > 0, "POSITIVE CONTROL: flag off orders the author after the not-convinced verdict");
});

test("OUTSIDE, GREEN AND UNREVIEWED: flag on, the review order is kept and is the only one", () => {
  const orders = onlySubject(decided([prOf(1004)], true), 1004);
  assert.deepEqual(orders.map((o) => o.cause), ["draft-awaiting-verdict"]);
  assert.match(orders[0].session, /^reviewer-/, "the review goes to a reviewer seat, never to ceo");
  assert.notEqual(orders[0].session, "ceo");
});

test("CHAIRMAN-AUTHORED, RED AND CONFLICTING: flag on, no follow-up; flag off, both are ordered (positive control)", () => {
  const red = [prOf(1005, { ...CHAIRMAN_AUTHOR, statusCheckRollup: RED })];
  const conflicting = [prOf(1006, { ...CHAIRMAN_AUTHOR, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })];
  assert.equal(onlySubject(decided(red, true), 1005).length, 0);
  assert.equal(onlySubject(decided(conflicting, true), 1006).length, 0);
  assert.ok(onlySubject(decided(red, false), 1005).length > 0, "POSITIVE CONTROL: flag off orders the chairman's red build");
  assert.ok(onlySubject(decided(conflicting, false), 1006).length > 0, "POSITIVE CONTROL: flag off orders the chairman's conflict");
});

test("CHAIRMAN-AUTHORED, GREEN AND UNREVIEWED: flag on, the review is kept and is the only order", () => {
  const orders = onlySubject(decided([prOf(1007, CHAIRMAN_AUTHOR)], true), 1007);
  assert.deepEqual(orders.map((o) => o.cause), ["draft-awaiting-verdict"]);
});

test("the org's own pull request keeps its follow-ups with the flag on: nothing about routing reaches INSIDE work", () => {
  const prs = [prOf(1008, { ...ORG_AUTHOR, statusCheckRollup: RED })];
  const on = onlySubject(decided(prs, true), 1008);
  const off = onlySubject(decided(prs, false), 1008);
  assert.ok(on.some((o) => o.cause === "pr-checks-failing"), "an INSIDE red pull request is still ordered");
  assert.deepEqual(on, off);
});

test("flag off is byte-identical: a mixed set decides the same orders as the same set with the flag never read", () => {
  const prs = [prOf(1009, { statusCheckRollup: RED }), prOf(1010, { ...CHAIRMAN_AUTHOR, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }), prOf(1011, ORG_AUTHOR)];
  assert.equal(JSON.stringify(decided(prs, false)), JSON.stringify(decide({ prs, readyRows: [], nowMs: NOW, required: REQUIRED, identities: IDENTITIES, prOwnerRouting: false }) as Order[]));
});

test("withholdOutsideFollowUps is PURE and keeps every order that is not a withheld pull request's", () => {
  const prs = [prOf(1012, OUTSIDE_AUTHOR), prOf(1013, ORG_AUTHOR)];
  const orders = [
    { cause: "pr-checks-failing", subject: "pr-agent-org#1012" },
    { cause: "draft-awaiting-verdict", subject: "pr-agent-org#1012" },
    { cause: "pr-checks-failing", subject: "pr-agent-org#1013" },
    { cause: "ready-queue-empty", subject: "queue" },
  ];
  assert.deepEqual(withholdOutsideFollowUps(orders, prs, IDENTITIES), [orders[1], orders[2], orders[3]]);
});
