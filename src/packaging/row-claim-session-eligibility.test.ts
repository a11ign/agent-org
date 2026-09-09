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

/**
 * #741: `--blocked-by=#N` END TO END THROUGH `claimRow` -- releases B2 only with a measurement comment
 * already on the claimant's own open PR, and only while `#N` is confirmed open. See
 * `row-claim-blocked-by-rule.test.ts` for the pure-function coverage of `blocked-by-rule.mjs` itself; this
 * proves the WIRING in `writeRowLabels` (the comment is posted on the RIGHT row, the label write still
 * happens, and a losing race never posts one).
 */
const QUALIFYING_MEASUREMENT_COMMENT = "Blocked-by measurement: #722 is red only on assertions introduced "
  + "by #718's merge, outside this PR's diff.\n\n"
  + "- ts (newest run): \"Cannot find module './closure'\" -- outside the diff\n";

/** Routes an `issue view` call by its REQUESTED `--json` field, since #741 asks it of two different
 * issues (the row being claimed, and the `--blocked-by` blocker) with two different field lists. Pulled
 * apart into small named routes, rather than one long `if` chain, to keep complexity below the lint gate. */
function issueViewRoute(args: string[], routes: { rowLabels?: string, blockerState?: string }): string {
  const fields = args[args.indexOf("--json") + 1];
  if (fields === "state") return routes.blockerState ?? JSON.stringify({ state: "OPEN" });
  return routes.rowLabels ?? JSON.stringify({ number: 700, title: "A row", labels: [] });
}

function blockedByRun(routes: { rowLabels?: string, blockerState?: string, comments?: string,
  onEdit?: () => void, onComment?: (body: string) => void }) {
  return (cmd: string, args: string[]): string => {
    const shape = args.slice(0, 2).join(" ");
    if (shape === "issue edit") { routes.onEdit?.(); return ""; }
    if (shape === "issue comment") { routes.onComment?.(args[args.length - 1]); return ""; }
    if (shape === "issue list") return JSON.stringify([{ number: 472 }]);
    if (shape === "api graphql") {
      return JSON.stringify({ data: { repository: { issue: {
        closedByPullRequestsReferences: { nodes: [{ number: 900, state: "OPEN", headRefOid: "abc" }] } } } } });
    }
    if (shape === "pr view") return routes.comments ?? JSON.stringify({ comments: [] });
    if (shape === "issue view") return issueViewRoute(args, routes);
    return "[]";
  };
}

test("#741's own acceptance shape: measurement comment present and #N open -- the claim succeeds and the "
  + "claim comment carries the exception and names #N", () => {
  let editCalled = false;
  let commentBody: string | undefined;
  const run = blockedByRun({
    comments: JSON.stringify({ comments: [{ body: QUALIFYING_MEASUREMENT_COMMENT }] }),
    onEdit: () => { editCalled = true; },
    onComment: (body) => { commentBody = body; },
  });
  const result = claimRow(700, "worker-audit", { run, moveStatus: () => ({ moved: true }),
    requiredContexts: () => ["ts"],
    checkRuns: () => [{ name: "ts", status: "completed", conclusion: "success", completedAt: null }],
    blockedBy: "#731" });
  assert.equal(result.claimed, true);
  assert.ok(editCalled, "the claim labels must still be written -- the override releases B2, it does not "
    + "skip claiming");
  assert.ok(commentBody, "the exception must be written into a claim comment, per #741's own acceptance");
  assert.match(commentBody as string, /#731/);
});

test("#741's own acceptance shape: without the measurement comment, refused, naming what the comment must "
  + "contain -- and no comment is posted", () => {
  let commentPosted = false;
  const run = blockedByRun({
    comments: JSON.stringify({ comments: [{ body: "looks fine to me" }] }),
    onComment: () => { commentPosted = true; },
  });
  const result = claimRow(700, "worker-audit", { run, moveStatus: () => ({ moved: true }),
    requiredContexts: () => ["ts"],
    checkRuns: () => [{ name: "ts", status: "completed", conclusion: "success", completedAt: null }],
    blockedBy: "#731" });
  assert.equal(result.claimed, false);
  assert.match((result as { reason: string }).reason, /measurement comment/);
  assert.equal(commentPosted, false);
});

test("#741's own acceptance shape: with #N closed, refused", () => {
  const run = blockedByRun({
    comments: JSON.stringify({ comments: [{ body: QUALIFYING_MEASUREMENT_COMMENT }] }),
    blockerState: JSON.stringify({ state: "CLOSED" }),
  });
  const result = claimRow(700, "worker-audit", { run, moveStatus: () => ({ moved: true }),
    requiredContexts: () => ["ts"],
    checkRuns: () => [{ name: "ts", status: "completed", conclusion: "success", completedAt: null }],
    blockedBy: "#731" });
  assert.equal(result.claimed, false);
  assert.match((result as { reason: string }).reason, /#731/);
  assert.match((result as { reason: string }).reason, /closed/);
});

test("#741's own acceptance shape: WITHOUT --blocked-by, B2 refuses exactly as it does today -- the flag "
  + "is the only new path, nothing else relaxes", () => {
  let commentPosted = false;
  const run = blockedByRun({
    comments: JSON.stringify({ comments: [{ body: QUALIFYING_MEASUREMENT_COMMENT }] }),
    onComment: () => { commentPosted = true; },
  });
  const result = claimRow(700, "worker-audit", { run, moveStatus: () => ({ moved: true }),
    requiredContexts: () => ["ts"],
    checkRuns: () => [{ name: "ts", status: "completed", conclusion: "success", completedAt: null }] });
  assert.equal(result.claimed, false);
  assert.doesNotMatch((result as { reason: string }).reason, /blocked-by/i,
    "with no --blocked-by, the refusal must read exactly like plain B2 -- a qualifying comment sitting "
    + "unused on the PR must never be discovered and applied on its own");
  assert.equal(commentPosted, false);
});

test("MUTATION TARGET: --blocked-by given while the refusal is B4 (file overlap), not B2, must not apply "
  + "-- the override is specific to the claimant's own PR being unhealthy", () => {
  const body = "## Region\n\n`scripts/merge-guard.mjs`.\n\n## Acceptance\n\nSomething checkable.\n\n"
    + "## Open-check\n\nSomething runnable.\n";
  const run = (cmd: string, args: string[]): string => {
    // `issue view` is asked for two different `--json` shapes here (labels, then `body` for both #707's
    // template check and B4's own region lookup) -- routed by the requested field, since answering both
    // with the same object is what silently skipped B4 entirely the first time this test was written.
    if (args[0] === "issue" && args[1] === "view") {
      const fields = args[args.indexOf("--json") + 1];
      if (fields === "body") return JSON.stringify({ body });
      return JSON.stringify({ number: 700, title: "A row", labels: [] });
    }
    if (args[0] === "pr" && args[1] === "list") {
      return JSON.stringify([{ number: 406, files: [{ path: "scripts/merge-guard.mjs" }] }]);
    }
    return "[]";
  };
  const result = claimRow(700, "worker-judge", { run, moveStatus: () => ({ moved: true }), blockedBy: "#731" });
  assert.equal(result.claimed, false);
  assert.match((result as { reason: string }).reason, /#406/);
  assert.doesNotMatch((result as { reason: string }).reason, /blocked-by/i);
});
