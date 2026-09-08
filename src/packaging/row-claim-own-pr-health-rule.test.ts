/**
 * RULE: IS THE CLAIMING SESSION'S OWN OPEN PR RED OR UNMERGED? -- B2, #476. See
 * `scripts/row-claim/own-pr-health-rule.mjs` for the full account (#472's owner reported a clean local
 * run and moved on while CI went red; nine PRs sat red the same night with their owners asleep).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ownPrHealthReason, lookupOtherHeldIssues, lookupClosingPrHealth, lookupOwnPrHealth,
} from "../../../../scripts/row-claim/own-pr-health-rule.mjs";

// --- ownPrHealthReason: THE VERDICT, PURE ---

test("no own PR at all raises nothing -- the common, first-claim case", () => {
  assert.equal(ownPrHealthReason(null), null);
});

test("#476's own acceptance shape: a RED open PR refuses, naming the PR and its state", () => {
  const reason = ownPrHealthReason({ number: 472, state: "OPEN", red: true });
  assert.ok(reason);
  assert.match(reason as string, /#472/);
  assert.match(reason as string, /RED/);
});

test("an open PR that is simply not yet merged ALSO refuses -- one PR in flight, not one green PR in flight", () => {
  const reason = ownPrHealthReason({ number: 300, state: "OPEN", red: false });
  assert.ok(reason);
  assert.match(reason as string, /not yet merged/);
  assert.doesNotMatch(reason as string, /RED/, "a green-but-open PR must not be told it is red");
});

test("#476's own acceptance shape: a MERGED PR allows -- a unit finished, not merely green", () => {
  assert.equal(ownPrHealthReason({ number: 472, state: "MERGED", red: false }), null);
});

test("a CLOSED (abandoned) PR allows -- it is no longer 'in flight', whatever its outcome", () => {
  assert.equal(ownPrHealthReason({ number: 300, state: "CLOSED", red: false }), null);
});

test("`behind` alone must never appear in this reason -- ceo's ruling: behind never blocks", () => {
  // The type itself carries no `behindBy` field at all -- this asserts the STRONGER property that no
  // code path could smuggle a behind-based sentence back in by accident.
  const reason = ownPrHealthReason({ number: 406, state: "OPEN", red: false });
  assert.doesNotMatch(reason as string, /behind/i);
});

// --- lookupOtherHeldIssues: `[]` and `null` stay different answers ---

test("lookupOtherHeldIssues excludes the row being claimed right now", () => {
  const run = (args: string[]) => {
    assert.ok(args.includes("in-progress"));
    assert.ok(args.includes("session:worker-judge"));
    return JSON.stringify([{ number: 455 }, { number: 300 }]);
  };
  const held = lookupOtherHeldIssues("worker-judge", 455, { run });
  assert.deepEqual(held, [300]);
});

test("lookupOtherHeldIssues returns null, never [], on a failed lookup", () => {
  const run = (): string => { throw new Error("gh: authentication required"); };
  assert.equal(lookupOtherHeldIssues("worker-judge", 455, { run }), null);
});

test("lookupOtherHeldIssues: genuinely holding nothing else is a real, different [] answer", () => {
  const run = () => JSON.stringify([{ number: 455 }]);
  assert.deepEqual(lookupOtherHeldIssues("worker-judge", 455, { run }), []);
});

// --- lookupClosingPrHealth: undefined (no PR yet) vs null (failed) vs a real answer ---

test("lookupClosingPrHealth: an issue with no closing PR yet is undefined, not null and not a refusal", () => {
  const run = () => JSON.stringify({ data: { repository: { issue: {
    closedByPullRequestsReferences: { nodes: [] } } } } });
  assert.equal(lookupClosingPrHealth(300, { run }), undefined);
});

test("lookupClosingPrHealth: a MERGED closing PR is reported merged, never re-asked for its check runs", () => {
  const run = () => JSON.stringify({ data: { repository: { issue: {
    closedByPullRequestsReferences: { nodes: [{ number: 475, state: "MERGED", headRefOid: "abc123" }] } } } } });
  let requiredContextsAsked = false;
  const requiredContexts = () => { requiredContextsAsked = true; return []; };
  const health = lookupClosingPrHealth(455, { run, requiredContexts });
  assert.deepEqual(health, { number: 475, state: "MERGED", red: false });
  assert.equal(requiredContextsAsked, false, "a merged PR's own colour does not matter -- asking for its "
    + "check runs would be a wasted round trip");
});

test("lookupClosingPrHealth: an OPEN closing PR with a failing required check is RED", () => {
  const run = () => JSON.stringify({ data: { repository: { issue: {
    closedByPullRequestsReferences: { nodes: [{ number: 472, state: "OPEN", headRefOid: "def456" }] } } } } });
  const requiredContexts = () => ["ts"];
  const checkRuns = () => [{ name: "ts", status: "completed", conclusion: "failure", completedAt: null }];
  const health = lookupClosingPrHealth(455, { run, requiredContexts, checkRuns });
  assert.deepEqual(health, { number: 472, state: "OPEN", red: true });
});

test("lookupClosingPrHealth: an OPEN closing PR with every required check satisfied is not red", () => {
  const run = () => JSON.stringify({ data: { repository: { issue: {
    closedByPullRequestsReferences: { nodes: [{ number: 472, state: "OPEN", headRefOid: "def456" }] } } } } });
  const requiredContexts = () => ["ts"];
  const checkRuns = () => [{ name: "ts", status: "completed", conclusion: "success", completedAt: null }];
  const health = lookupClosingPrHealth(455, { run, requiredContexts, checkRuns });
  assert.deepEqual(health, { number: 472, state: "OPEN", red: false });
});

test("lookupClosingPrHealth returns null on a failed GraphQL lookup", () => {
  const run = (): string => { throw new Error("network error"); };
  assert.equal(lookupClosingPrHealth(300, { run }), null);
});

// --- lookupOwnPrHealth: THE FULL LOOKUP, composed, fail-open throughout ---

test("lookupOwnPrHealth: a failed 'other held issues' lookup is null, never read as healthy", () => {
  const run = (): string => { throw new Error("gh: rate limited"); };
  assert.equal(lookupOwnPrHealth("worker-judge", 455, { run }), null);
});

test("lookupOwnPrHealth: holding nothing else at all is null (nothing to be unhealthy)", () => {
  const run = () => JSON.stringify([]);
  assert.equal(lookupOwnPrHealth("worker-judge", 455, { run }), null);
});
