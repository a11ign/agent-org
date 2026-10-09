/**
 * B2 (#476) + B4 (#462) + THE ROW'S OWN `blockedBy` EDGE (#1886), COMPOSED, THROUGH
 * `sessionEligibilityReason` AND `claimRow` END TO END.
 *
 * `decideClaim` answers "is this ROW somebody else's"; `sessionEligibilityReason` answers "should THIS
 * SESSION start a NEW row right now" (a session's own PR health, and whether its region overlaps another
 * open PR) and, since #1886, "is THIS row startable at all right now" (does it carry an open `blockedBy`
 * edge) -- independent of who (if anyone) already holds the row being claimed. All three fail OPEN on a
 * lookup failure, the opposite of `decideClaim`'s own "unclaimed must be earned" rule: this protects a
 * session's ability to claim ANYTHING when the network is down, the identical reasoning
 * `merge-guard.ts`'s `racesAnArmedMerge` states for the same choice made the same way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionEligibilityReason, claimRow, CLAIM_LABEL } from "../row-claim.ts";

/**
 * ONE `run` MOCK ROUTING BY SUBCOMMAND SHAPE, since `sessionEligibilityReason` makes several distinct
 * `gh` calls in sequence (issue list, GraphQL, issue view, pr list) and each needs its own canned answer.
 */
interface Routes {
  issueList?: string; graphql?: string; issueViewBody?: string; prList?: string;
  heldRowBody?: string; subIssues?: string; blockedBy?: string; prReviews?: string;
  prCommits?: string;
}

/** The CLAIMED row's own body (B4 reads its Region); any other issue is a row this session HOLDS (#989). */
const CLAIMED_ROWS = ["455", "705", "2760"];

/** #2151: a claim's labels are ONE `PUT .../labels` (or, for a back-off or a decline, an `issue edit`), so a
 * test that asks "did the claim write?" must read both -- watching only `issue edit` would call a claim that
 * wrote nothing and a claim that wrote everything the same. */
function writesLabels(args: string[]): boolean {
  return (args[0] === "issue" && args[1] === "edit")
    || (args[0] === "api" && args[1] === "--method" && args[2] === "PUT" && /\/labels$/.test(args[3]));
}

/** #989's two reads for a held row: does its Region name files, and does it have sub-issues. */
function heldRowRoute(routes: Routes, args: string[]): string | null {
  if (args[0] === "api" && /\/sub_issues$/.test(args[1] ?? "")) return routes.subIssues ?? "[]";
  if (args[0] === "issue" && args[1] === "view" && !args.some((a) => CLAIMED_ROWS.includes(a))) {
    // Defaults to a Region declaring one file, so a held row with no PR is IN BUILD unless a test says so.
    return JSON.stringify({ body: routes.heldRowBody ?? "## Region\n\n```\nscripts/held.mjs\n```\n" });
  }
  return null;
}

/** The CLAIMED row's own `issue view` call, routed by its REQUESTED `--json` field: #1886's
 * `blockedBy`-edge check and B4's Region-body read ask for different fields of the same issue. */
function claimedRowViewRoute(routes: Routes, args: string[]): string {
  const fields = args[args.indexOf("--json") + 1];
  if (fields === "blockedBy") return routes.blockedBy ?? JSON.stringify({ blockedBy: { nodes: [] } });
  return JSON.stringify({ body: routes.issueViewBody ?? "" });
}

/**
 * #2126: TWO DIFFERENT `pr list` CALLS NOW, routed by the fields each one ASKS FOR rather than by order.
 * B4 reads every open pull request's FILES; B2's review-health clause reads every open pull request's
 * `reviewDecision`. Answering both from one canned string is the shape that silently skipped B4 the first
 * time this file was written, and it would have made #2126's clause untestable in exactly the same way.
 */
function prListRoute(routes: Routes, args: string[]): string {
  const fields = args[args.indexOf("--json") + 1] ?? "";
  return /reviewDecision/.test(fields) ? routes.prReviews ?? "[]" : routes.prList ?? "[]";
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
    if (args[0] === "issue" && args[1] === "view") return claimedRowViewRoute(routes, args);
    if (args[0] === "pr" && args[1] === "list") return prListRoute(routes, args);
    // #2316: `commits` is read PER PULL REQUEST, the way `gh` serves it -- GitHub refuses it on the list.
    if (args[0] === "pr" && args[1] === "view") return routes.prCommits ?? JSON.stringify({ commits: [] });
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
    issueViewBody: "Region: `packages/agent-org/src/merge-guard.ts`.",
    prList: JSON.stringify([{ number: 406, changedFiles: 1, files: [{ path: "packages/agent-org/src/merge-guard.ts" }] }]),
  });
  const reason = sessionEligibilityReason(455, "worker-judge", { run });
  assert.ok(reason);
  assert.match(reason as string, /#406/);
});

test("#462's own POSITIVE CONTROL: remove the overlap, end to end, and it goes quiet", () => {
  const run = routedRun({
    issueViewBody: "Region: `packages/agent-org/src/row-claim.ts`.",
    prList: JSON.stringify([{ number: 406, changedFiles: 1, files: [{ path: "packages/agent-org/src/merge-guard.ts" }] }]),
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

// --- #1886: the ROW BEING CLAIMED may itself carry an open `blockedBy` edge -- see
// `row-claim-blocked-by-edge-rule.test.ts` for the pure-function coverage of `blocked-by-edge-rule.ts`
// itself; these prove the WIRING into `sessionEligibilityReason`, end to end. ---

// #1852 is the real reproduction (see #1886's own Region), but this file's `routedRun` fixture treats
// issue 455/705 as the row being claimed and reads any OTHER issue number in an `issue view` call as a
// HELD row `sessionEligibilityReason` is asking about on B2's behalf -- so these tests use 455, matching
// every other test in this file, rather than the literal #1852.
test("#1886's own acceptance shape: an open blockedBy edge on the row being claimed refuses it, naming "
  + "the blocking issue(s)", () => {
  const run = routedRun({
    blockedBy: JSON.stringify({ blockedBy: { nodes: [{ number: 1878, state: "OPEN" },
      { number: 1883, state: "OPEN" }] } }),
  });
  const reason = sessionEligibilityReason(455, "worker-judge", { run });
  assert.ok(reason, "#1852's own reproduction: an open blockedBy edge must refuse, not read as startable");
  assert.match(reason as string, /#1878/);
  assert.match(reason as string, /#1883/);
});

test("#1886's own POSITIVE CONTROL: a CLOSED blockedBy edge is a wait that has cleared -- goes quiet", () => {
  const run = routedRun({
    blockedBy: JSON.stringify({ blockedBy: { nodes: [{ number: 1878, state: "CLOSED" }] } }),
  });
  assert.equal(sessionEligibilityReason(455, "worker-judge", { run }), null);
});

test("the blockedBy-edge check runs BEFORE B4 -- refused without even asking about files", () => {
  let prListAsked = false;
  const base = routedRun({
    blockedBy: JSON.stringify({ blockedBy: { nodes: [{ number: 1878, state: "OPEN" }] } }),
  });
  const run = (cmd: string, args: string[]) => {
    if (args[0] === "pr" && args[1] === "list") prListAsked = true;
    return base(cmd, args);
  };
  const reason = sessionEligibilityReason(455, "worker-judge", { run });
  assert.ok(reason);
  assert.equal(prListAsked, false, "B4's lookup is a separate round trip and should not run once the "
    + "row's own blockedBy edge has already decided to refuse");
});

test("MUTATION TARGET: --blocked-by=#N must not silently release a blockedBy-edge refusal -- it is scoped "
  + "to B2 only, a different claim about a different thing", () => {
  // A custom `run`, not `routedRun`: `claimRow` also calls `fetchLabels` (`--json number,title,labels,state`)
  // ahead of `sessionEligibilityReason`, which `routedRun` (built for that function alone) does not answer.
  const run = (cmd: string, args: string[]): string => {
    if (args[0] === "issue" && args[1] === "view") {
      const fields = args[args.indexOf("--json") + 1];
      if (fields === "blockedBy") {
        return JSON.stringify({ blockedBy: { nodes: [{ number: 1878, state: "OPEN" }] } });
      }
      return JSON.stringify({ number: 1852, title: "A row", labels: [] });
    }
    return "[]";
  };
  const result = claimRow(1852, "nobody-holds-this-row",
    { run, moveStatus: () => ({ moved: true }), blockedBy: "#731" });
  assert.equal(result.claimed, false);
  assert.match((result as { reason: string }).reason, /#1878/,
    "the blockedBy-edge refusal must still be the reason -- --blocked-by has no subject here");
  assert.doesNotMatch((result as { reason: string }).reason, /--blocked-by=#731 did not apply/,
    "that message is B2's own override failure text; this refusal was never B2's to release");
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
    prList: JSON.stringify([{ number: 698, changedFiles: 1, files: [{ path: "packages/lab/scripts/audit-rule-coverage.ts" }] }]),
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
    if (writesLabels(args)) { editCalled = true; return ""; }
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
    if (writesLabels(args)) { editCalled = true; return ""; }
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

test("RESUMING a row this session already holds still refuses on the row's own open blockedBy edge", () => {
  // PR #1891 NOT CONVINCED (reviewer, 576a678b): the fix that shipped put the row-owned `blockedBy` read
  // inside `sessionEligibilityReason`, called only from the `!alreadyMine` branch -- so this exact
  // resumed-claim path (the one the test just above proves skips B2/B4) never read the edge at all, and
  // `claimRow` returned `claimed: true` against a still-open blocker. This is the same reproduction
  // reviewer gave against #1883, replayed here as a positive assertion rather than a manual repro.
  let listAsked = false;
  let editCalled = false;
  const run = (cmd: string, args: string[]) => {
    if (args[0] === "issue" && args[1] === "list") { listAsked = true; return "[]"; }
    if (writesLabels(args)) { editCalled = true; return ""; }
    if (args[0] === "issue" && args[1] === "view") {
      const fields = args[args.indexOf("--json") + 1];
      if (fields === "blockedBy") {
        return JSON.stringify({ blockedBy: { nodes: [{ number: 999, state: "OPEN" }] } });
      }
      return JSON.stringify({ number: 461, title: "A row",
        labels: [{ name: CLAIM_LABEL }, { name: "session:worker-judge" }] });
    }
    return "";
  };
  const result = claimRow(461, "worker-judge", { run, moveStatus: () => ({ moved: true }) });
  assert.equal(result.claimed, false);
  assert.match((result as { reason: string }).reason, /#999/,
    "the row's own open blockedBy edge must refuse a resumed claim exactly as it refuses a new one -- "
    + "it is a property of the row, not of whether this session already holds it");
  assert.equal(editCalled, false, "must never write a claim it has already decided to refuse");
  assert.equal(listAsked, false, "the row-owned blockedBy check costs no B2 round trip -- B2/B4's own "
    + "alreadyMine skip is unaffected by this fix");
});

/**
 * #741: `--blocked-by=#N` END TO END THROUGH `claimRow` -- releases B2 only with a measurement comment
 * already on the claimant's own open PR, and only while `#N` is confirmed open. See
 * `row-claim-blocked-by-rule.test.ts` for the pure-function coverage of `blocked-by-rule.ts` itself; this
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
    if (writesLabels(args)) { routes.onEdit?.(); return ""; }
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
  assert.match(reason, /no PR of this session's own to attach a measurement comment to/);
  assert.match(reason, /`row-claim\.ts decline <n> --session=<name>`/,
    "product-manager's ruling on #1012: naming the missing PR alone is a refusal nobody can follow, because "
    + "an in-build row has no PR and none is coming. It must name the door that exists.");
});

test("MUTATION TARGET: --blocked-by given while the refusal is B4 (file overlap), not B2, must not apply "
  + "-- the override is specific to the claimant's own PR being unhealthy", () => {
  const body = "## Region\n\n`packages/agent-org/src/merge-guard.ts`.\n\n## Acceptance\n\nSomething checkable.\n\n"
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
      return JSON.stringify([{ number: 406, changedFiles: 1, files: [{ path: "packages/agent-org/src/merge-guard.ts" }] }]);
    }
    return "[]";
  };
  const result = claimRow(700, "worker-judge", { run, moveStatus: () => ({ moved: true }), blockedBy: "#731" });
  assert.equal(result.claimed, false);
  assert.match((result as { reason: string }).reason, /#406/);
  assert.doesNotMatch((result as { reason: string }).reason, /blocked-by/i);
});

// --- #2126: AN UNANSWERED REFUSAL IS WORK NEEDING ACTION, THROUGH `sessionEligibilityReason` -----------

/**
 * B2 caps WORK NEEDING THIS SESSION'S ACTION, and a pull request whose reviewer has asked for changes is
 * exactly that -- it is not waiting on anybody but its author. #989 is untouched and the four cases far
 * above are its positive control: as many pull requests AWAITING REVIEW as it takes, one row in build.
 *
 * `row-claim-own-pr-health-rule.test.ts` owns the pure coverage of the predicate, the dispute reader and
 * the escalation. These prove the WIRING: that `sessionEligibilityReason` actually reaches them, with the
 * one `pr list` call the row asked for and not one per held row.
 */
const REFUSED_HEAD = "6541b1ee3ca8332069db55e3144d93bbef4e6b0f";
const VERDICT_HEAD = "dfe72936b50f0e6cb8a3d5f1a9c0e2b7d4f61a83";

/** A held row (#472) whose commits ARE proposed by an open pull request (#900) -- #989 clears it. */
const heldWithOpenPr = JSON.stringify({ data: { repository: { issue: {
  closedByPullRequestsReferences: { nodes: [{ number: 900, state: "OPEN", headRefOid: REFUSED_HEAD }] },
} } } });

const verdict = (state: string, oid: string, by: string) => ({ state, commit: { oid },
  body: `**Review of #900 at \`${oid.slice(0, 8)}\`, by ${by}: `
    + `${state === "APPROVED" ? "convinced" : "not convinced"} (provisional).**` });

const openPrReviews = (decision: string | null, reviews: unknown[] = []) => JSON.stringify(
  [{ number: 900, headRefOid: REFUSED_HEAD, reviewDecision: decision, reviews }]);

test("#2126 (1): the session's own open PR reading CHANGES_REQUESTED refuses a fresh claim", () => {
  const run = routedRun({
    issueList: JSON.stringify([{ number: 472 }]),
    graphql: heldWithOpenPr,
    prReviews: openPrReviews("CHANGES_REQUESTED"),
  });
  const reason = sessionEligibilityReason(455, "worker-tooling", { run });
  assert.ok(reason, "#2126's own live shape: a refusal nobody has answered, end to end");
  assert.match(reason as string, /#900/, "the refusal names the pull request, where the work is");
  assert.match(reason as string, /#472/, "and the row it belongs to");
});

test("#2126 (2): the same session with that PR reading APPROVED is ALLOWED -- #989 preserved", () => {
  // THE POSITIVE CONTROL FOR THE CASE ABOVE, and the assertion that this row did not quietly restore #476.
  const run = routedRun({
    issueList: JSON.stringify([{ number: 472 }]),
    graphql: heldWithOpenPr,
    prReviews: openPrReviews("APPROVED"),
  });
  assert.equal(sessionEligibilityReason(455, "worker-tooling", { run }), null);
});

test("#2126 (2): REVIEW_REQUIRED is a pull request waiting on its REVIEWER, and is ALLOWED", () => {
  const run = routedRun({
    issueList: JSON.stringify([{ number: 472 }]),
    graphql: heldWithOpenPr,
    prReviews: openPrReviews("REVIEW_REQUIRED"),
  });
  assert.equal(sessionEligibilityReason(455, "worker-tooling", { run }), null,
    "an engineer does not wait on review -- ceo's ruling of 2026-09-11, unchanged by this clause");
});

test("#2126 (3): four bot merge commits and no author commit do NOT clear the refusal", () => {
  // #2107's real shape: the verdict sits at `dfe72936` and the head is `6541b1ee`, four automated
  // `Merge branch 'main'` commits later, with zero author commits. A guard keyed on head identity would
  // find no verdict at the current head at all; `reviewDecision` still reads CHANGES_REQUESTED because
  // `dismiss_stale_reviews` is false.
  const run = routedRun({
    issueList: JSON.stringify([{ number: 472 }]),
    graphql: heldWithOpenPr,
    prReviews: openPrReviews("CHANGES_REQUESTED", [verdict("CHANGES_REQUESTED", VERDICT_HEAD, "reviewer")]),
  });
  const reason = sessionEligibilityReason(455, "worker-tooling", { run });
  assert.ok(reason, "the refusal outlived four head moves that no author made");
  assert.match(reason as string, /#900/);
  assert.match(reason as string, /BOT MERGE DOES NOT LIFT THIS/,
    "and it says so, so a reader whose head has moved does not read the refusal as stale");
});

test("#2126 (4): contradictory verdicts at the SAME head are not refused -- they escalate to ceo", () => {
  const calls: string[][] = [];
  const base = routedRun({
    issueList: JSON.stringify([{ number: 472 }]),
    graphql: heldWithOpenPr,
    prReviews: openPrReviews("CHANGES_REQUESTED", [
      verdict("APPROVED", REFUSED_HEAD, "reviewer-2"),
      verdict("CHANGES_REQUESTED", REFUSED_HEAD, "reviewer"),
    ]),
  });
  const run = (cmd: string, args: string[]) => { calls.push(args); return base(cmd, args); };

  assert.equal(sessionEligibilityReason(455, "worker-tooling", { run }), null,
    "#2105's real shape: an APPROVED and a CHANGES_REQUESTED on the identical commit, 57 seconds apart. "
    + "A guard with no exit for a dispute converts a review disagreement into a stalled engineer");

  const edit = calls.find((c) => c[0] === "issue" && c[1] === "edit");
  assert.ok(edit, `the escape must ESCALATE, not merely stay quiet -- calls were `
    + `${calls.map((c) => c.slice(0, 2).join(" ")).join(", ")}`);
  assert.deepEqual([edit?.[2], edit?.[edit.indexOf("--add-label") + 1]], ["472", "answer:ceo"]);
  const comment = calls.find((c) => c[0] === "issue" && c[1] === "comment")?.slice(-1)[0] ?? "";
  assert.match(comment, /OPPOSITE verdicts on #900/, "with the dispute written where ceo reads it");
});

test("#2126 (4): the escalation is the DISPUTE's doing -- remove one side and the same claim is refused", () => {
  // THE POSITIVE CONTROL FOR THE ESCAPE. Identical fixture with the APPROVED dropped: no dispute, so the
  // refusal stands and nothing is escalated. Without this, the clearance above proves only that some
  // fixture goes quiet.
  const calls: string[][] = [];
  const base = routedRun({
    issueList: JSON.stringify([{ number: 472 }]),
    graphql: heldWithOpenPr,
    prReviews: openPrReviews("CHANGES_REQUESTED", [verdict("CHANGES_REQUESTED", REFUSED_HEAD, "reviewer")]),
  });
  const run = (cmd: string, args: string[]) => { calls.push(args); return base(cmd, args); };
  assert.ok(sessionEligibilityReason(455, "worker-tooling", { run }));
  assert.deepEqual(calls.filter((c) => c[0] === "issue" && (c[1] === "edit" || c[1] === "comment")), [],
    "and a refused claim escalates nothing -- the control for this emptiness is the test directly above");
});

test("#2126: the review-health read is ONE `pr list`, whatever the session holds", () => {
  // #989 took two calls per held row OUT of this path; a clause that put one back per row would undo the
  // measurement that justified it. Three held rows, three open pull requests, one review-health call.
  let reviewReads = 0;
  const base = routedRun({
    issueList: JSON.stringify([{ number: 472 }, { number: 473 }, { number: 474 }]),
    graphql: heldWithOpenPr,
    prReviews: openPrReviews("APPROVED"),
  });
  const run = (cmd: string, args: string[]) => {
    if (args[0] === "pr" && args[1] === "list"
      && /reviewDecision/.test(args[args.indexOf("--json") + 1] ?? "")) reviewReads += 1;
    return base(cmd, args);
  };
  assert.equal(sessionEligibilityReason(455, "worker-tooling", { run }), null);
  assert.equal(reviewReads, 1, "one call, not one per row");
});

test("#2126: a row IN BUILD is still reported without ANY `pr list` round trip", () => {
  // The existing B2-before-B4 expectation, restated for the new read: this clause's lookup is a `pr list`
  // too, and a row in build has no open pull request for it to ask about. If this goes red the clause has
  // started spending a round trip on rows it can never say anything about.
  let prListAsked = false;
  const base = routedRun({ issueList: JSON.stringify([{ number: 472 }]) });
  const run = (cmd: string, args: string[]) => {
    if (args[0] === "pr" && args[1] === "list") prListAsked = true;
    return base(cmd, args);
  };
  assert.match(String(sessionEligibilityReason(455, "worker-tooling", { run })), /#472 is IN BUILD/);
  assert.equal(prListAsked, false);
});

test("#2126: a FAILED review-health read refuses nothing, the way every lookup here fails OPEN", () => {
  const base = routedRun({ issueList: JSON.stringify([{ number: 472 }]), graphql: heldWithOpenPr });
  const run = (cmd: string, args: string[]) => {
    if (args[0] === "pr" && args[1] === "list"
      && /reviewDecision/.test(args[args.indexOf("--json") + 1] ?? "")) throw new Error("gh: 502");
    return base(cmd, args);
  };
  assert.equal(sessionEligibilityReason(455, "worker-tooling", { run }), null,
    "this clause can only ever CREATE a refusal, so an unanswerable read must not manufacture one");
});

// --- #2769: `--adopt` TELLS B4 WHICH BRANCH IT IS RE-STAMPING, so the row's own `Closes: none` split PR is not a competitor ---

const SPLIT_REGION_FILE = "packages/agent-org/src/row-claim.ts";
const SPLIT_BRANCH = "agent/reachable-region-2760";
/** #2766's real shape: an open PR on the row's Region file that declares `Closes: none`, from the branch being adopted. */
const splitPrList = JSON.stringify([{ number: 2766, changedFiles: 1, files: [{ path: SPLIT_REGION_FILE }],
  body: "Closes: none -- Done-when 3 on #2760 is still open", labels: [], headRefName: SPLIT_BRANCH }]);
/** All three template fields, because `claimRow` refuses a body missing any before it ever reaches B4. */
const splitBody = `## Region\n\n\`\`\`\n${SPLIT_REGION_FILE}\n\`\`\`\n\n## Acceptance\n\n\`\`\`\nnpx tsx --test x.test.ts\n\`\`\`\n\n`
  + "## Open-check\n\n```\ngit worktree list\n```\n";
const splitRoutes = { issueViewBody: splitBody, prList: splitPrList };

test("#2769 sessionEligibilityReason: the `Closes: none` PR from the adopted branch is not a collision; without the branch it is", () => {
  const run = routedRun(splitRoutes);
  assert.match(sessionEligibilityReason(2760, "worker-2760", { run }) as string, /overlaps #2766/, "CONTROL: a fresh claim still refuses");
  assert.equal(sessionEligibilityReason(2760, "worker-2760", { run, adoptedBranch: SPLIT_BRANCH }), null);
  assert.match(sessionEligibilityReason(2760, "worker-2760", { run, adoptedBranch: "agent/other-1" }) as string, /overlaps #2766/);
});

/** `routedRun` answers `sessionEligibilityReason`'s reads; `claimRow` first reads the row's labels, which it does not. */
function splitClaimRun() {
  const routed = routedRun(splitRoutes);
  return (cmd: string, args: string[]): string => {
    const fields = args[args.indexOf("--json") + 1] ?? "";
    if (args[0] === "issue" && args[1] === "view" && /labels/.test(fields)) {
      return JSON.stringify({ number: 2760, title: "A row", labels: [] });
    }
    return routed(cmd, args);
  };
}

test("#2769 claimRow FORWARDS `adoptedBranch` to B4 -- the flag reaches the check that reads it, not only the function that owns it", () => {
  const refused = claimRow(2760, "worker-2760", { run: splitClaimRun(), moveStatus: () => ({ moved: true }) });
  assert.equal(refused.claimed, false);
  assert.match((refused as { reason: string }).reason, /overlaps #2766/, "CONTROL: without it the claim is refused by B4");
  const adopted = claimRow(2760, "worker-2760", { run: splitClaimRun(), moveStatus: () => ({ moved: true }), adoptedBranch: SPLIT_BRANCH });
  assert.doesNotMatch(String((adopted as { reason?: string }).reason ?? ""), /overlaps|B4/, "B4 no longer refuses the adopted branch's own PR");
});
