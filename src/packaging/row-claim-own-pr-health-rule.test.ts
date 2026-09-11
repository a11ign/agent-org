// no-token: gh
//
// #827's check charges a command the WHOLE import closure of what it imports, and this file imports
// `own-pr-health-rule.mjs`, whose closure reaches `lookups.mjs`, which spawns `gh`. That is true of the
// IMPORT and false of the CALL: every function driven here is pure or takes its `run` injected, and no
// test below lets a real spawn happen.
//
// PROVED, NOT ASSERTED, since the check is deliberately shallow: with GH_TOKEN and GITHUB_TOKEN unset and a
// fake `gh` first on PATH that exits 97 and shouts to stderr -- 17 pass, 0 fail, and the fake never printed.

/**
 * RULE: DOES THE CLAIMING SESSION ALREADY HOLD A ROW IN BUILD? -- B2, #476, rewritten by #989. See
 * `scripts/row-claim/own-pr-health-rule.mjs` for the full account.
 *
 * The predicate it replaces asked whether the session's own PR was OPEN AT ALL, so a PR that was green and
 * waiting only on its reviewer blocked its author from starting anything -- #988 was green from 07:46Z and
 * waited through a twelve-hour restart gap. ceo granted a hand exception three times in one day and then
 * ruled that an engineer does not wait on review: as many PRs in review as it takes, ONE row in build.
 *
 * IN BUILD MEANS A CLAIMED ROW WHOSE OWN DELIVERABLE IS A COMMIT THAT DOES NOT EXIST YET.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inBuildReason, isInBuild, lookupOtherHeldIssues, lookupClosingPrHealth, lookupRowShape,
} from "../../../../scripts/row-claim/own-pr-health-rule.mjs";

/** A row owed a commit: held, declaring files, no sub-rows, no PR. Each test changes ONE fact from this. */
const inBuild = { number: 989, declaresPaths: true, subIssues: 0, closingPr: undefined };

// --- THE VERDICT, PURE -------------------------------------------------------------------------------

test("#989: no rows at all raises nothing -- the common, first-claim case", () => {
  assert.equal(inBuildReason([]), null);
});

test("#989: a row in build refuses, BY NUMBER, and names both ways out", () => {
  const reason = inBuildReason([inBuild]);
  assert.ok(reason);
  assert.match(reason as string, /#989 is IN BUILD/);
  assert.match(reason as string, /Finish it, or `decline` it/,
    "a refusal a reader cannot follow is the shape this repo has paid for most often");
  assert.match(reason as string, /one ROW in build per session/);
});

/**
 * THE CASE THE OLD PREDICATE GOT WRONG, and the reason this row exists: N open pull requests block nothing
 * as long as no row is in build. N = 0, 1 and 3, so the rule is not accidentally a one-PR rule wearing a
 * longer sentence.
 */
for (const n of [0, 1, 3]) {
  test(`#989: ${n} open PR(s) and no row in build -- the claim proceeds`, () => {
    const rows = Array.from({ length: n }, (_, i) => (
      { number: 900 + i, declaresPaths: true, subIssues: 0, closingPr: { state: "OPEN" as const } }));
    assert.equal(inBuildReason(rows), null,
      "an open PR means the commit is PROPOSED; waiting on a reviewer is not a build");
  });
}

test("#989: a row whose PR is MERGED while the row is still OPEN is NOT in build", () => {
  // product-manager's mirror, and the one case where a wrong answer blocks a session that has DELIVERED.
  // Real shape: issue #159 carries both #172 CLOSED and #473 MERGED. "No PR at all" would have called it a
  // build; "no PR that is open or merged" gets it right. (#159 itself is closed, so the row-still-open half
  // is constructed here -- the window between a merge and the row's auto-close is about a second.)
  assert.equal(inBuildReason([{ ...inBuild, closingPr: { state: "MERGED" } }]), null);
});

test("#989: a row whose PR was CLOSED WITHOUT MERGING IS in build -- the commit still does not exist", () => {
  // Abandoning a PR and starting a third thing is exactly what B2 should refuse. Real shape: issues #79 and
  // #93, whose PRs #89 and #107 are closed-unmerged. Measured: the query this rule runs does not return
  // them at all (`includeClosedPrs` defaults to false), so they arrive here as `undefined` in practice --
  // this fixture drives the explicit filter, which guards a future query rather than today's.
  assert.ok(inBuildReason([{ ...inBuild, closingPr: { state: "CLOSED" } }]));
});

test("#989: a row declaring no Region path is not in build -- its deliverable is not a commit", () => {
  // A settings change, a ruling, a measurement posted on the row. #916 and #918 are the live shapes.
  assert.equal(inBuildReason([{ ...inBuild, declaresPaths: false }]), null);
});

test("#989: a PARENT is not in build -- its deliverable is its sub-rows' commits", () => {
  // #908's shape: it declares `eslint.config.js` and the packaging directory, and #986 was filed against
  // it. A parent held for weeks while its sub-rows land must not block its holder.
  assert.equal(inBuildReason([{ ...inBuild, number: 908, subIssues: 1 }]), null);
});

test("#989: a parent PLUS an in-build sub-row refuses, naming the SUB-ROW", () => {
  const reason = inBuildReason([{ ...inBuild, number: 908, subIssues: 2 }, { ...inBuild, number: 986 }]);
  assert.ok(reason);
  assert.match(reason as string, /#986 is IN BUILD/,
    "the parent must not absorb the blame for the row actually in build");
  assert.doesNotMatch(reason as string, /#908 is IN BUILD/);
});

/**
 * KNOWN LIMITATION, PINNED RATHER THAN DESCRIBED. The parent property reads GitHub's sub-issue link, which
 * exists only where the sub-row was filed with `row-file --parent`. A parent whose sub-rows were all filed
 * without it answers `[]` and reads as IN BUILD. That is why the refusal names the command that links one:
 * an invisible dependency costs an evening, a followable one costs a command. When a future row closes this,
 * this test is what it flips.
 */
test("#989 LIMITATION: a parent with no sub-issue LINKS reads as in build, and the refusal says how to fix it", () => {
  const reason = inBuildReason([{ ...inBuild, number: 908, subIssues: 0 }]);
  assert.ok(reason, "the link, not the fact of parenthood, is what this can see");
  assert.match(reason as string, /sub_issues -f sub_issue_id=/,
    "so the reader is told the one command that lifts it");
});

test("#989: isInBuild is the whole predicate, and each clause is load-bearing", () => {
  assert.equal(isInBuild(inBuild), true);
  assert.equal(isInBuild({ ...inBuild, closingPr: { state: "OPEN" } }), false);
  assert.equal(isInBuild({ ...inBuild, closingPr: { state: "MERGED" } }), false);
  assert.equal(isInBuild({ ...inBuild, closingPr: { state: "CLOSED" } }), true);
  assert.equal(isInBuild({ ...inBuild, declaresPaths: false }), false);
  assert.equal(isInBuild({ ...inBuild, subIssues: 1 }), false);
});

// --- THE LOOKUPS: what each clause is READ from ------------------------------------------------------

test("#989: the held population is this session's own rows -- another session's do not count", () => {
  // `lookupOtherHeldIssues` filters on `session:<name>`, and this guards that from widening later, which is
  // the failure nobody notices.
  const calls: string[][] = [];
  const run = (args: string[]) => { calls.push(args); return "[]"; };
  lookupOtherHeldIssues("worker-judge", 989, { run });
  assert.deepEqual(calls[0].filter((a) => a.startsWith("session:")), ["session:worker-judge"]);
  assert.ok(calls[0].includes("in-progress"));
});

test("#989: the row being claimed is never checked against itself", () => {
  const run = () => JSON.stringify([{ number: 989 }, { number: 908 }]);
  assert.deepEqual(lookupOtherHeldIssues("worker-judge", 989, { run }), [908]);
});

test("#989: a failed lookup is INCONCLUSIVE -- null, never an empty list read as 'holds nothing'", () => {
  const run = () => { throw new Error("gh: network"); };
  assert.equal(lookupOtherHeldIssues("worker-judge", 989, { run }), null);
  assert.equal(lookupRowShape(989, { run }), null);
  assert.equal(lookupClosingPrHealth(989, { run }), null);
});

test("#989: the Region reading DELEGATES to the tree's own parser -- it is not a second reading", () => {
  // `declaredRegionFiles` is where the Region grammar lives and keeps changing: #941 taught it directory
  // items, #975 root-level files, #999 fenced extensionless paths. This rule asks it rather than matching
  // paths itself, so each of those reaches B2 with no edit here -- which is the property worth asserting,
  // not any one grammar.
  //
  // THE DELEGATION, PAYING OFF WHILE THIS ROW WAS BEING WRITTEN: when I drafted these tests #999 (PR
  // #1005) was open, so a fenced `scripts/git-hooks/pre-push` declared nothing and asserting it would have
  // pinned a parser this rule does not own to a version that had not landed. #1005 merged an hour later,
  // and the case below now passes with NO change to the rule -- which is the property worth having.
  const body = (region: string) => JSON.stringify({ body: `## Region\n\n${region}\n` });
  const shapeFor = (region: string) => lookupRowShape(989, {
    run: (args) => (args[0] === "issue" ? body(region) : "[]"),
  });
  assert.equal(shapeFor("```\nscripts/row-claim/own-pr-health-rule.mjs\n```")?.declaresPaths, true);
  assert.equal(shapeFor("```\nscripts/git-hooks/pre-push\n```")?.declaresPaths, true, "#999's fenced "
    + "extensionless path -- #911's own Region, which declared nothing before PR #1005 merged");
  assert.equal(shapeFor("packages/control/ansible/")?.declaresPaths, true, "#941's directory item");
  assert.equal(shapeFor("Whatever it needs under `docs/`, and the ruling on the row.")?.declaresPaths, false);
});

test("#989: the parent reading is GitHub's own sub-issue link, counted", () => {
  const shape = lookupRowShape(908, {
    run: (args) => (args[0] === "issue"
      ? JSON.stringify({ body: "## Region\n\n```\neslint.config.js\n```\n" })
      : JSON.stringify([{ number: 986 }, { number: 1000 }])),
  });
  assert.equal(shape?.subIssues, 2);
});
