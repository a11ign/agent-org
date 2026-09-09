/**
 * B2 (#476) + B4 (#462), COMPOSED, THROUGH `sessionEligibilityReason` AND `claimRow` END TO END.
 *
 * `decideClaim` answers "is this ROW somebody else's"; `sessionEligibilityReason` answers "should THIS
 * SESSION start a NEW row right now" -- a session's own PR health, and whether its region overlaps
 * another open PR -- independent of who (if anyone) already holds the row being claimed. Both fail OPEN
 * on a lookup failure, the opposite of `decideClaim`'s own "unclaimed must be earned" rule: this protects
 * a session's ability to claim ANYTHING when the network is down, the identical reasoning
 * `merge-guard.mjs`'s `racesAnArmedMerge` states for the same choice made the same way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionEligibilityReason, claimRow, CLAIM_LABEL } from "../../../../scripts/row-claim.mjs";

/**
 * ONE `run` MOCK ROUTING BY SUBCOMMAND SHAPE, since `sessionEligibilityReason` makes several distinct
 * `gh` calls in sequence (issue list, GraphQL, issue view, pr list) and each needs its own canned answer.
 */
function routedRun(routes: { issueList?: string, graphql?: string, issueViewBody?: string, prList?: string }) {
  return (_cmd: string, args: string[]): string => {
    if (args[0] === "issue" && args[1] === "list") return routes.issueList ?? "[]";
    if (args[0] === "api" && args[1] === "graphql") {
      return routes.graphql ?? JSON.stringify({ data: { repository: { issue: {
        closedByPullRequestsReferences: { nodes: [] } } } } });
    }
    if (args[0] === "issue" && args[1] === "view") {
      return JSON.stringify({ body: routes.issueViewBody ?? "" });
    }
    if (args[0] === "pr" && args[1] === "list") return routes.prList ?? "[]";
    return "";
  };
}

test("no other held row, no region overlap: proceeds silently -- the common case", () => {
  const run = routedRun({});
  assert.equal(sessionEligibilityReason(455, "worker-judge", { run }), null);
});

test("#476's own acceptance shape: a RED own PR refuses, end to end", () => {
  const run = routedRun({
    issueList: JSON.stringify([{ number: 472 }]),
    graphql: JSON.stringify({ data: { repository: { issue: {
      closedByPullRequestsReferences: { nodes: [{ number: 900, state: "OPEN", headRefOid: "abc" }] } } } } }),
  });
  // `requiredContexts`/`checkRuns` injected directly (not through `run`): they reach `gh` through
  // `merge-guard/lookups.mjs`'s own internal helper, not this file's `run` argv, so leaving them
  // un-injected would make this "offline" test place a real network call the moment the fixture's PR
  // reads OPEN -- exactly the trap `lookupClosingPrHealth`'s own comment names.
  const reason = sessionEligibilityReason(455, "worker-judge",
    { run, requiredContexts: () => ["ts"], checkRuns: () => [{ name: "ts", status: "completed",
      conclusion: "failure", completedAt: null }] });
  assert.ok(reason, "an OPEN closing PR for another held row must refuse a new claim");
  assert.match(reason as string, /#900/);
  assert.match(reason as string, /RED/);
});

test("#476's own acceptance shape: the same session with that PR MERGED is allowed", () => {
  const run = routedRun({
    issueList: JSON.stringify([{ number: 472 }]),
    graphql: JSON.stringify({ data: { repository: { issue: {
      closedByPullRequestsReferences: { nodes: [{ number: 900, state: "MERGED", headRefOid: "abc" }] } } } } }),
  });
  assert.equal(sessionEligibilityReason(455, "worker-judge", { run }), null);
});

test("#462's own acceptance shape: a CONSTRUCTED region overlap refuses, end to end", () => {
  const run = routedRun({
    issueViewBody: "Region: `scripts/merge-guard.mjs`.",
    prList: JSON.stringify([{ number: 406, files: [{ path: "scripts/merge-guard.mjs" }] }]),
  });
  const reason = sessionEligibilityReason(455, "worker-judge", { run });
  assert.ok(reason);
  assert.match(reason as string, /#406/);
});

test("#462's own POSITIVE CONTROL: remove the overlap, end to end, and it goes quiet", () => {
  const run = routedRun({
    issueViewBody: "Region: `scripts/row-claim.mjs`.",
    prList: JSON.stringify([{ number: 406, files: [{ path: "scripts/merge-guard.mjs" }] }]),
  });
  assert.equal(sessionEligibilityReason(455, "worker-judge", { run }), null);
});

test("B2 is checked BEFORE B4 -- an unhealthy own PR is reported without even asking about files", () => {
  let prListAsked = false;
  const base = routedRun({
    issueList: JSON.stringify([{ number: 472 }]),
    graphql: JSON.stringify({ data: { repository: { issue: {
      closedByPullRequestsReferences: { nodes: [{ number: 900, state: "OPEN", headRefOid: "abc" }] } } } } }),
  });
  const run = (cmd: string, args: string[]) => {
    if (args[0] === "pr" && args[1] === "list") prListAsked = true;
    return base(cmd, args);
  };
  const reason = sessionEligibilityReason(455, "worker-judge",
    { run, requiredContexts: () => [], checkRuns: () => [] });
  assert.ok(reason);
  assert.equal(prListAsked, false, "B4's lookup is a separate round trip and should not run once B2 has "
    + "already decided to refuse");
});

// --- #710: the overlap check reads the DECLARED Region section, never every path the row's prose
// mentions -- #705-vs-#698 is the real shape this measured against ---

test("#710 REGRESSION FIXTURE: #705's real body cites a fixture file in prose that #698's real PR " +
  "actually changed -- and #705's own Region section never names it. Must NOT refuse", () => {
  const run = routedRun({
    issueViewBody: "## The fixture: what it would actually have taken\n\n"
      + "Rescuing `packages/lab/scripts/audit-rule-coverage.ts` from `lead/inventory-bootstrap` "
      + "(2026-09-06):\n\n"
      + "## Region\n\n`scripts/` for the helper, `packages/lab/src/packaging/` for its test, and "
      + "`docs/` wherever the stranded-branch procedure ends up being written down.\n",
    prList: JSON.stringify([{ number: 698, files: [{ path: "packages/lab/scripts/audit-rule-coverage.ts" }] }]),
  });
  assert.equal(sessionEligibilityReason(455, "worker-judge", { run }), null,
    "a file cited as a worked example, outside the Region section, must never be read as an overlap");
});

test("a failed lookup anywhere fails OPEN, never blocking a claim on a network error", () => {
  const run = (): string => { throw new Error("gh: rate limited"); };
  assert.equal(sessionEligibilityReason(455, "worker-judge", { run }),
    null, "the opposite direction from decideClaim's own lookups -- this protects the session's ability "
    + "to claim ANYTHING, not a verdict about evidence");
});

/**
 * END TO END THROUGH `claimRow` ITSELF -- proves the wiring in `writeRowLabels`, not just the pure
 * composition function above.
 */
test("claimRow refuses a genuinely new claim when the session's own PR is unhealthy", () => {
  let editCalled = false;
  const run = (cmd: string, args: string[]) => {
    if (args[0] === "issue" && args[1] === "view") {
      return JSON.stringify({ number: 455, title: "A row", labels: [] }); // unclaimed
    }
    if (args[0] === "issue" && args[1] === "edit") { editCalled = true; return ""; }
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify([{ number: 472 }]);
    if (args[0] === "api" && args[1] === "graphql") {
      return JSON.stringify({ data: { repository: { issue: {
        closedByPullRequestsReferences: { nodes: [{ number: 900, state: "OPEN", headRefOid: "abc" }] } } } } });
    }
    return "[]";
  };
  const result = claimRow(455, "worker-judge", { run, moveStatus: () => ({ moved: true }),
    requiredContexts: () => [], checkRuns: () => [] });
  assert.equal(result.claimed, false);
  assert.match((result as { reason: string }).reason, /#900/);
  assert.equal(editCalled, false, "must never write a claim it has already decided to refuse");
});

test("claimRow proceeds normally when eligibility is silent -- unchanged from before B2/B4", () => {
  let editCalled = false;
  const run = (cmd: string, args: string[]) => {
    if (args[0] === "issue" && args[1] === "view") {
      return JSON.stringify({ number: 461, title: "A row", labels: [] });
    }
    if (args[0] === "issue" && args[1] === "edit") { editCalled = true; return ""; }
    return "[]";
  };
  const result = claimRow(461, "worker-judge", { run, moveStatus: () => ({ moved: true }) });
  assert.equal(result.claimed, true);
  assert.ok(editCalled);
});

test("RESUMING a row this session already holds skips eligibility entirely -- not a new front", () => {
  let listAsked = false;
  const run = (cmd: string, args: string[]) => {
    if (args[0] === "issue" && args[1] === "list") { listAsked = true; }
    if (args[0] === "issue" && args[1] === "view") {
      return JSON.stringify({ number: 461, title: "A row",
        labels: [{ name: CLAIM_LABEL }, { name: "session:worker-judge" }] });
    }
    return "";
  };
  const result = claimRow(461, "worker-judge", { run, moveStatus: () => ({ moved: true }) });
  assert.equal(result.claimed, true);
  assert.equal(listAsked, false, "resuming a row already yours must not spend a round trip re-checking "
    + "eligibility for a front that was never new");
});
