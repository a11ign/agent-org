/**
 * RULE: IS THE CLAIMING SESSION'S OWN OPEN PR RED OR UNMERGED? -- B2, #476. See
 * `scripts/row-claim/own-pr-health-rule.mjs` for the full account (#472's owner reported a clean local
 * run and moved on while CI went red; nine PRs sat red the same night with their owners asleep).
 *
 * #733: `reasons` carries `checkReasons`'s OWN returned strings, never a boolean collapsing them --
 * `product-manager` was sent looking for a failure that did not exist because a still-running required
 * check was reported as "a required check is failing". See `colourFor` in the rule file itself.
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

test("#476's own acceptance shape: a genuinely FAILING open PR refuses, naming the PR and RED", () => {
  const reason = ownPrHealthReason({ number: 472, state: "OPEN", reasons: ["FAILING: ts (failure)."] });
  assert.ok(reason);
  assert.match(reason as string, /#472/);
  assert.match(reason as string, /RED/);
});

test("#733's own acceptance shape: a check that has merely NOT FINISHED must NOT be told 'failing'", () => {
  const reason = ownPrHealthReason({ number: 472, state: "OPEN",
    reasons: ["STILL RUNNING: ts. Not a refusal forever -- ask again."] });
  assert.ok(reason);
  assert.doesNotMatch(reason as string, /failing/i, "product-manager's own #733 finding: a reader sent "
    + "looking for a failure that does not exist");
  assert.match(reason as string, /STILL RUNNING/);
  assert.match(reason as string, /ask again/i);
});

test("#733's own acceptance shape: BOTH still-running and failing names both, rather than picking one", () => {
  const reason = ownPrHealthReason({ number: 472, state: "OPEN",
    reasons: ["STILL RUNNING: lint. Not a refusal forever -- ask again.", "FAILING: ts (failure)."] });
  assert.ok(reason);
  assert.match(reason as string, /RED/);
  assert.match(reason as string, /STILL RUNNING/);
});

test("a required context that NEVER RAN reads as a genuine problem, same as failing -- not as a wait", () => {
  const reason = ownPrHealthReason({ number: 472, state: "OPEN",
    reasons: ["REQUIRED CONTEXT NEVER RAN: ts."] });
  assert.ok(reason);
  assert.match(reason as string, /RED/);
});

test("an open PR that is simply not yet merged ALSO refuses -- one PR in flight, not one green PR in flight", () => {
  const reason = ownPrHealthReason({ number: 300, state: "OPEN", reasons: [] });
  assert.ok(reason);
  assert.match(reason as string, /not yet merged/);
  assert.doesNotMatch(reason as string, /RED/, "a green-but-open PR must not be told it is red");
  assert.doesNotMatch(reason as string, /STILL RUNNING/);
});

test("#476's own acceptance shape: a MERGED PR allows -- a unit finished, not merely green", () => {
  assert.equal(ownPrHealthReason({ number: 472, state: "MERGED", reasons: [] }), null);
});

test("a CLOSED (abandoned) PR allows -- it is no longer 'in flight', whatever its outcome", () => {
  assert.equal(ownPrHealthReason({ number: 300, state: "CLOSED", reasons: [] }), null);
});

test("`behind` alone must never appear in this reason -- ceo's ruling: behind never blocks", () => {
  // The type itself carries no `behindBy` field at all -- this asserts the STRONGER property that no
  // code path could smuggle a behind-based sentence back in by accident.
  const reason = ownPrHealthReason({ number: 406, state: "OPEN", reasons: [] });
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
  assert.deepEqual(health, { number: 475, state: "MERGED", reasons: [] });
  assert.equal(requiredContextsAsked, false, "a merged PR's own colour does not matter -- asking for its "
    + "check runs would be a wasted round trip");
});

test("lookupClosingPrHealth: an OPEN closing PR with a failing required check carries checkReasons's own "
  + "FAILING string, real -- not a call site's own boolean", () => {
  const run = () => JSON.stringify({ data: { repository: { issue: {
    closedByPullRequestsReferences: { nodes: [{ number: 472, state: "OPEN", headRefOid: "def456" }] } } } } });
  const requiredContexts = () => ["ts"];
  const checkRuns = () => [{ name: "ts", status: "completed", conclusion: "failure", completedAt: null }];
  const health = lookupClosingPrHealth(455, { run, requiredContexts, checkRuns });
  assert.equal(health?.number, 472);
  assert.equal(health?.state, "OPEN");
  assert.equal(health?.reasons.length, 1);
  assert.match(health?.reasons[0] as string, /^FAILING/);
});

test("#733's own MUTATION shape: an OPEN closing PR with a required check merely UNFINISHED (not yet "
  + "completed) carries checkReasons's real STILL RUNNING string, never a FAILING one", () => {
  const run = () => JSON.stringify({ data: { repository: { issue: {
    closedByPullRequestsReferences: { nodes: [{ number: 472, state: "OPEN", headRefOid: "def456" }] } } } } });
  const requiredContexts = () => ["ts"];
  const checkRuns = () => [{ name: "ts", status: "in_progress", conclusion: null, completedAt: null }];
  const health = lookupClosingPrHealth(455, { run, requiredContexts, checkRuns });
  assert.equal(health?.reasons.length, 1);
  assert.match(health?.reasons[0] as string, /^STILL RUNNING/);
  assert.doesNotMatch(health?.reasons.join(" ") as string, /FAILING/,
    "this IS #733's own mutation instruction: a check that only has NOT FINISHED must never produce a "
    + "FAILING reason");
});

test("lookupClosingPrHealth: an OPEN closing PR with every required check satisfied has no reasons at all", () => {
  const run = () => JSON.stringify({ data: { repository: { issue: {
    closedByPullRequestsReferences: { nodes: [{ number: 472, state: "OPEN", headRefOid: "def456" }] } } } } });
  const requiredContexts = () => ["ts"];
  const checkRuns = () => [{ name: "ts", status: "completed", conclusion: "success", completedAt: null }];
  const health = lookupClosingPrHealth(455, { run, requiredContexts, checkRuns });
  assert.deepEqual(health, { number: 472, state: "OPEN", reasons: [] });
});

test("lookupClosingPrHealth returns null on a failed GraphQL lookup", () => {
  const run = (): string => { throw new Error("network error"); };
  assert.equal(lookupClosingPrHealth(300, { run }), null);
});

// --- #733's own live case, end to end: lookupClosingPrHealth -> ownPrHealthReason ---

test("#733's own live shape: a PR pending only on ts/run (every other check pass) is refused as STILL "
  + "RUNNING, never told a check is failing -- product-manager's own #730 finding", () => {
  const run = () => JSON.stringify({ data: { repository: { issue: {
    closedByPullRequestsReferences: { nodes: [{ number: 730, state: "OPEN", headRefOid: "abc" }] } } } } });
  const requiredContexts = () => ["ts", "lint"];
  const checkRuns = () => [
    { name: "ts", status: "in_progress", conclusion: null, completedAt: null },
    { name: "lint", status: "completed", conclusion: "success", completedAt: "2026-09-09T14:00:00Z" },
  ];
  const health = lookupClosingPrHealth(703, { run, requiredContexts, checkRuns });
  const reason = ownPrHealthReason(health ?? null);
  assert.ok(reason);
  assert.match(reason as string, /#730/);
  assert.doesNotMatch(reason as string, /failing/i);
  assert.match(reason as string, /STILL RUNNING/);
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
