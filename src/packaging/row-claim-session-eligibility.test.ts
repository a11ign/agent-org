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
interface Routes {
  issueList?: string; graphql?: string; issueViewBody?: string; prList?: string;
  heldRowBody?: string; subIssues?: string;
}

/** The CLAIMED row's own body (B4 reads its Region); any other issue is a row this session HOLDS (#989). */
const CLAIMED_ROWS = ["455", "705"];

/** #989's two reads for a held row: does its Region name files, and does it have sub-issues. */
function heldRowRoute(routes: Routes, args: string[]): string | null {
  if (args[0] === "api" && /\/sub_issues$/.test(args[1] ?? "")) return routes.subIssues ?? "[]";
  if (args[0] === "issue" && args[1] === "view" && !args.some((a) => CLAIMED_ROWS.includes(a))) {
    // Defaults to a Region declaring one file, so a held row with no PR is IN BUILD unless a test says so.
    return JSON.stringify({ body: routes.heldRowBody ?? "## Region\n\n```\nscripts/held.mjs\n```\n" });
  }
  return null;
}

function routedRun(routes: Routes) {
  return (_cmd: string, args: string[]): string => {
    const held = heldRowRoute(routes, args);
    if (held !== null) return held;
    if (args[0] === "issue" && args[1] === "list") return routes.issueList ?? "[]";
    if (args[0] === "api" && args[1] === "graphql") {
      return routes.graphql ?? JSON.stringify({ data: { repository: { issue: {
        closedByPullRequestsReferences: { nodes: [] } } } } });
    }
    if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ body: routes.issueViewBody ?? "" });
    if (args[0] === "pr" && args[1] === "list") return routes.prList ?? "[]";
    return "";
  };
}

test("no other held row, no region overlap: proceeds silently -- the common case", () => {
  const run = routedRun({});
  assert.equal(sessionEligibilityReason(455, "worker-judge", { run }), null);
});

test("#989: an OPEN own PR no longer refuses -- red or green, it is not a row in build", () => {
  // #476's own acceptance shape, INVERTED by #989. The PR here is open with a failing required check, and
  // it still does not block: an open PR means the commit is PROPOSED, and an engineer does not wait on
  // review. ceo granted this by hand three times on 2026-09-11 before ruling it the rule.
  const run = routedRun({
    issueList: JSON.stringify([{ number: 472 }]),
    graphql: JSON.stringify({ data: { repository: { issue: {
      closedByPullRequestsReferences: { nodes: [{ number: 900, state: "OPEN", headRefOid: "abc" }] } } } } }),
  });
  assert.equal(sessionEligibilityReason(455, "worker-judge", { run }), null);
});

test("#989: a held row with NO PR, declaring files, refuses -- that is what in build means", () => {
  const run = routedRun({ issueList: JSON.stringify([{ number: 472 }]) });
  const reason = sessionEligibilityReason(455, "worker-judge", { run });
  assert.ok(reason, "no PR closes #472 and its Region names a file: somebody owes a commit for it");
  assert.match(reason as string, /#472 is IN BUILD/);
  assert.match(reason as string, /Finish it, or `decline` it/);
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

test("B2 is checked BEFORE B4 -- a row IN BUILD is reported without even asking about files", () => {
  let prListAsked = false;
  const base = routedRun({ issueList: JSON.stringify([{ number: 472 }]) });
  const run = (cmd: string, args: string[]) => {
    if (args[0] === "pr" && args[1] === "list") prListAsked = true;
    return base(cmd, args);
  };
  const reason = sessionEligibilityReason(455, "worker-judge",
    { run
});
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
test("claimRow refuses a genuinely new claim when the session holds a row IN BUILD", () => {
  let editCalled = false;
  const run = (cmd: string, args: string[]) => {
    if (args[0] === "issue" && args[1] === "view") {
      // #989 reads the HELD row's body (does its Region name files); `decideClaim` reads the CLAIMED row's.
      return args.includes("472")
        ? JSON.stringify({ body: "## Region\n\n```\nscripts/held.mjs\n```\n" })
        : JSON.stringify({ number: 455, title: "A row", labels: [] }); // unclaimed, and no `body` key:
        // `lookupIssueBody` reads null and #707's template check is skipped, as it was before #989.
    }
    if (args[0] === "issue" && args[1] === "edit") { editCalled = true; return ""; }
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify([{ number: 472 }]);
    if (args[0] === "api" && /\/sub_issues$/.test(args[1] ?? "")) return "[]";
    if (args[0] === "api" && args[1] === "graphql") {
      // #989: no PR closes #472, so it is in build -- the claim is refused by the ROW, not by a PR.
      return JSON.stringify({ data: { repository: { issue: {
        closedByPullRequestsReferences: { nodes: [] } } } } });
    }
    return "[]";
  };
  const result = claimRow(455, "worker-judge", { run, moveStatus: () => ({ moved: true }) });
  assert.equal(result.claimed, false);
  assert.match((result as { reason: string }).reason, /#472 is IN BUILD/,
    "the refusal names the ROW that is in build, not a PR -- #989's whole point");
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
// #989: `QUALIFYING_MEASUREMENT_COMMENT` went with #741's four tests. The fixture was the comment that
// released B2 on a red own PR; B2 no longer refuses for that, so nothing in this file can qualify.
// `row-claim-blocked-by-rule.test.ts` still owns the comment's own grammar, which is unchanged.

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

/**
 * #741's OVERRIDE HAS NO SUBJECT AFTER #989, and that is a capability question rather than a rename.
 *
 * #741 let a session claim while its own PR was red for a reason outside its diff, by writing a
 * measurement comment ON THAT PR. #989 removes the refusal it was releasing: an open PR no longer blocks
 * anything, so the need is met by default and the flag has nothing left to excuse. **The refusal that
 * remains is a row IN BUILD -- which by definition has no PR for a measurement comment to live on.**
 *
 * Both halves are asserted below rather than left implied. Whether `--blocked-by` retires, or moves its
 * measurement comment onto the ROW, is product-manager's call on its own row; what this file must not do
 * is keep four tests passing about a path nobody can reach.
 */
test("#989: #741's own case needs no flag now -- an open, RED own PR does not refuse at all", () => {
  let editCalled = false;
  const run = blockedByRun({ onEdit: () => { editCalled = true; } });
  const result = claimRow(700, "worker-audit", { run, moveStatus: () => ({ moved: true }) });
  assert.equal(result.claimed, true, "the session's own PR is OPEN and that is no longer a refusal");
  assert.ok(editCalled);
});

test("#989: --blocked-by cannot excuse a row IN BUILD, and says why rather than being ignored", () => {
  // A row in build has no PR, so there is nowhere for #741's measurement comment to live. The refusal
  // names that instead of silently declining to apply -- a flag that is quietly dropped and a flag that
  // was never given produce the same output, which is the shape this repo has the longest record of.
  const run = (cmd: string, args: string[]): string => {
    const shape = args.slice(0, 2).join(" ");
    if (shape === "issue list") return JSON.stringify([{ number: 472 }]);
    if (shape === "api graphql") {
      return JSON.stringify({ data: { repository: { issue: {
        closedByPullRequestsReferences: { nodes: [] } } } } });
    }
    if (shape === "issue view") {
      return args.includes("472")
        ? JSON.stringify({ body: "## Region\n\n```\nscripts/held.mjs\n```\n" })
        : JSON.stringify({ number: 700, title: "A row", labels: [] }); // no `body`: #707 is not this test
    }
    return "[]";
  };
  const result = claimRow(700, "worker-audit",
    { run, moveStatus: () => ({ moved: true }), blockedBy: "#731" });
  assert.equal(result.claimed, false);
  const reason = (result as { reason: string }).reason;
  assert.match(reason, /#472 is IN BUILD/);
  assert.match(reason, /--blocked-by=#731 did not apply/);
  assert.match(reason, /no open PR of this session's own was found/,
    "the override's own words, which are exactly right now: an in-build row has no PR to attach to");
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
