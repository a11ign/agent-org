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
 * `packages/agent-org/src/row-claim/own-pr-health-rule.mjs` for the full account.
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
  deliveredRowsDeclaredBy, lookupDeliveringPr, lookupHeldRows,
} from "../row-claim/own-pr-health-rule.mjs";

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
  // #1161: `-F`, and this line is the finding rather than a consequence of it. **A test anchored on the
  // BROKEN flag held it in place**: from #989 to #1161 this assertion read `-f sub_issue_id=` and passed
  // every run, so the guard whose job was to hold the remedy followable was the thing defending the remedy
  // that could not be followed. Pinning a string does not check that the string works, and a test written
  // from the implementation inherits the implementation's defect with the implementation's confidence.
  assert.match(reason as string, /sub_issues (?:-F|--field) sub_issue_id=/,
    "so the reader is told the one command that lifts it, in the spelling that actually lifts it");
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

/**
 * #1161: THE COMMAND IN THE MESSAGE IS ASSERTED, NOT THE PROSE AROUND IT.
 *
 * A test matching `sub_issues` passes on either flag, which is how `-f` survived from #989 to #1161 inside
 * a message this file already had assertions about. **The flag is the defect, so the flag is what is
 * anchored** — and anchored ADJACENT to the parameter it types, because `-f` appears nowhere else in the
 * sentence but would if the message ever grew another one.
 *
 * `gh api -f` sends every value as a string; the sub-issues endpoint requires an integer, so following this
 * line verbatim returned HTTP 422 every time. The rule it broke is the one that makes naming a remedy worth
 * doing: **follow the refusal exactly and you must pass.**
 */
test("#1161: the B2 refusal's own command sends a TYPED field, so following it verbatim works", () => {
  const reason = String(inBuildReason([{ ...inBuild, number: 908, subIssues: 0 }]));

  // BOTH SPELLINGS OF THE TYPED FLAG, because `--field` IS `-F`. worker-capture's finding on this guard,
  // and it is the sharpening I gave them on #1164 returned: **pin the rule, not the rendering** -- except
  // where the rendering IS the rule, and here it is not, since both forms are equally copy-pasteable for
  // the reader this message is written for. A maintainer spelling it long would otherwise get a red saying
  // the remedy is broken when it is correct, and the guard could not tell that edit from the defect.
  assert.match(reason, /sub_issues (?:-F|--field) sub_issue_id=/,
    "`-f` sends the id as a string and the endpoint refuses it with 422 -- a refusal whose remedy fails is "
    + "worse than one with no remedy, because the reader debugs the remedy instead of doing the work");
  assert.doesNotMatch(reason, /sub_issues (?:-f|--raw-field) sub_issue_id=/,
    "and BOTH spellings of the untyped flag must be gone rather than merely outnumbered -- a message "
    + "carrying one would satisfy the assertion above while still printing a line that returns 422");
});

test("#1161: the assertion is on the FLAG, so it cannot pass on a message that only mentions sub_issues", () => {
  // The mutation this file could not previously express: put `-f` back and clause 1 must go red. Driven on
  // the returned STRING rather than on the source, because the string is what a reader is handed.
  // THE REPLACEMENT MATCHES WHATEVER FLAG IS THERE, not the one the source happens to spell today. My
  // first version anchored on the literal `-F`, so under a source spelling it `--field` the mutation
  // silently did not apply and the test passed having changed nothing -- #1165's shape, produced while
  // building the guard against it, and caught only because the four-spelling matrix below showed `--field`
  // failing when it should pass.
  const withTheOldFlag = String(inBuildReason([{ ...inBuild, number: 908, subIssues: 0 }]))
    .replace(/sub_issues \S+ sub_issue_id=/, "sub_issues -f sub_issue_id=");

  assert.doesNotMatch(withTheOldFlag, /sub_issues (?:-F|--field) sub_issue_id=/,
    "the mutation genuinely changes what the first assertion looks at -- without this, a green test above "
    + "proves only that the string contains something, which is what let `-f` through for eight rows");
  assert.match(withTheOldFlag, /sub_issues/,
    "and it is still recognisably the same message, so the mutation changes the MEANING and not the subject");
});

/**
 * #1161: ALL FOUR SPELLINGS, so the guard is a claim about the FLAG and not about seven characters.
 *
 * `--field` is `-F` and `--raw-field` is `-f`. The first version of the guard above matched `-F` literally,
 * which fails safe -- but it could not tell a maintainer spelling the flag long (a correct edit) from the
 * defect it exists to catch, and would have reported the working remedy as broken. worker-capture's finding
 * on review, and it is the sharpening I had given them on #1164 returned: **pin the rule, not the
 * rendering -- except where the rendering IS the rule.** Here it is not, because both forms are equally
 * copy-pasteable by the reader the message is written for.
 */
test("#1161: both TYPED spellings pass and both UNTYPED spellings fail, which is the property", () => {
  const message = String(inBuildReason([{ ...inBuild, number: 908, subIssues: 0 }]));
  const spell = (flag: string) => {
    const spelled = message.replace(/sub_issues \S+ sub_issue_id=/, `sub_issues ${flag} sub_issue_id=`);
    // ASSERT THE REWRITE LANDED, on the result rather than on the input. Anchoring on one spelling is how
    // a mutation silently does not apply, and a rewrite that changed nothing returns the same green as one
    // that did. Checked here rather than trusted because this function's whole job is to vary the flag.
    assert.ok(spelled.includes(`sub_issues ${flag} sub_issue_id=`),
      `the rewrite must LAND: asked for ${flag} and the message does not carry it`);
    return spelled;
  };
  const typed = /sub_issues (?:-F|--field) sub_issue_id=/;
  const untyped = /sub_issues (?:-f|--raw-field) sub_issue_id=/;

  for (const flag of ["-F", "--field"]) {
    assert.match(spell(flag), typed, `${flag} sends the id typed, so the endpoint accepts it`);
    assert.doesNotMatch(spell(flag), untyped, `${flag} must not also read as the untyped flag`);
  }
  for (const flag of ["-f", "--raw-field"]) {
    assert.match(spell(flag), untyped, `${flag} sends the id as a string and the endpoint returns 422`);
    assert.doesNotMatch(spell(flag), typed, `${flag} must not satisfy the guard -- \`--raw-field\` ends in `
      + "`-field`, so a pattern without the second dash anchored would have let it through");
  }
});

// --- #2026: A DELIVERABLE THAT IS A COMMIT **PLUS** A NON-COMMIT STEP ----------------------------------

/**
 * THE INCIDENT, MEASURED RATHER THAN IMAGINED. 2026-09-22 21:47Z: `worker-judge` held #2000, whose pull
 * request #2011 was OPEN and green on every required check, and was refused a claim on #2002. #2011
 * declares `Closes: none` and is RIGHT to — #2000's done-when requires `npm run host:install` to have been
 * RUN on the agent host, and `Closes #2000` would auto-close the row on merge, discarding the step the row
 * exists to guarantee. The refusal's own last clause ("an open PR no longer blocks a claim") did not hold.
 *
 * Any row whose done-when a merge cannot satisfy is in that population: a host install, a fleet deploy, a
 * release dispatch, a measurement taken after the run. Those rows are exactly the ones whose pull request
 * MUST say `Closes: none`, so they are exactly the population B2 mishandled.
 */
const delivered = { state: "OPEN" as const, proposesRegionPath: true };

test("#2026: a declared delivery clears the row its `Closes: none` PR could not", () => {
  assert.equal(inBuildReason([{ ...inBuild, number: 2000, deliveringPr: delivered }]), null,
    "the commit IS proposed; `Closes:` simply cannot say so without auto-closing a row that owes a host step");
});

/**
 * THE BAR #2026 SET FOR ANY REMEDY, IN ONE ASSERTION: *"a remedy must not let a row be cleared by a PR that
 * never proposed its commits."* A `Delivers:` line is a claim written by its own author, so the declaration
 * alone must not be enough — the pull request has to change a path the row's own Region declares.
 *
 * This is the case that separates this remedy from the two #2026 listed beside it. Reading a plain
 * cross-reference would fail it outright: probed live on #2000 on 2026-09-23, its last 20 cross-references
 * held four pull requests — #2011, which delivered it, and #2030, #2038 and #2044, which only mention it.
 */
test("#2026: a declared delivery that proposes NO Region path leaves the row in build", () => {
  const reason = inBuildReason([{ ...inBuild, number: 2000,
    deliveringPr: { ...delivered, proposesRegionPath: false } }]);
  assert.ok(reason, "a declaration is a claim; changing one of the row's declared files is the proposal");
  assert.match(reason as string, /#2000 is IN BUILD/);
});

test("#2026: a declared delivery that was CLOSED unmerged leaves the row in build", () => {
  // The same reading `closingPr` already takes one line above: an abandoned pull request proposes nothing,
  // and abandoning one to start a third thing is exactly what B2 exists to refuse.
  assert.ok(inBuildReason([{ ...inBuild, deliveringPr: { ...delivered, state: "CLOSED" } }]));
});

test("#2026: a MERGED declared delivery clears it too — the row stays open for its host step", () => {
  // #2026's second measured cost: `Closes: none` does not clear on merge either, so #2000 would have stayed
  // in build after #2011 landed until somebody closed the row by hand.
  assert.equal(inBuildReason([{ ...inBuild, deliveringPr: { ...delivered, state: "MERGED" } }]), null);
});

test("#2026: isInBuild's delivery clause is load-bearing in both halves", () => {
  assert.equal(isInBuild({ ...inBuild, deliveringPr: delivered }), false);
  assert.equal(isInBuild({ ...inBuild, deliveringPr: { ...delivered, state: "MERGED" } }), false);
  assert.equal(isInBuild({ ...inBuild, deliveringPr: { ...delivered, state: "CLOSED" } }), true);
  assert.equal(isInBuild({ ...inBuild, deliveringPr: { ...delivered, proposesRegionPath: false } }), true);
  assert.equal(isInBuild({ ...inBuild, deliveringPr: undefined }), true,
    "and a row nobody declared a delivery for reads exactly as it did before this clause existed");
});

// --- #2026: the declaration's grammar ------------------------------------------------------------------

test("#2026: `Delivers:` is a LINE OF ITS OWN, so a row cited in prose declares nothing", () => {
  // The whole reason the field exists rather than reading GitHub's cross-references directly: three of the
  // four pull requests cross-referencing #2000 on 2026-09-23 only mentioned it in prose.
  assert.deepEqual(deliveredRowsDeclaredBy("Delivers: #2000"), [2000]);
  assert.deepEqual(deliveredRowsDeclaredBy("body\n\nDelivers: #2000\n\nmore"), [2000]);
  assert.deepEqual(deliveredRowsDeclaredBy("**Delivers:** #2000"), [2000], "bolded, as PR bodies here are");
  assert.deepEqual(deliveredRowsDeclaredBy("this is the shape #2000 hit"), [],
    "a prose mention is not a declaration, which is exactly what a cross-reference cannot tell apart");
  assert.deepEqual(deliveredRowsDeclaredBy("see what it Delivers: #2000 eventually"), [],
    "and not mid-sentence either — `Acceptance:` and `Closes:` are lines of their own and so is this");
});

test("#2026: one pull request may declare more than one row, and `none` declares nothing", () => {
  assert.deepEqual(deliveredRowsDeclaredBy("Delivers: #2000, #2002"), [2000, 2002],
    "taking only the first would clear one row and hold the other with nothing to say why");
  assert.deepEqual(deliveredRowsDeclaredBy("Delivers: none -- it finishes no row"), []);
  assert.deepEqual(deliveredRowsDeclaredBy(""), []);
  assert.deepEqual(deliveredRowsDeclaredBy("Delivers: #2000\nDelivers: #2000"), [2000], "no repeats");
});

// --- #2026: what the declaration is READ from ----------------------------------------------------------

/**
 * A FULL PAGE, the size the rule asks GitHub for — 100, the largest a connection page can be. The
 * fixtures below decide their own page boundaries, so the paging TESTS would pass against any value;
 * the test directly below is what makes this number a pin rather than a description.
 */
const PAGE = 100;

/**
 * ONE PAGE of a GraphQL connection, `pageInfo` and all, as GitHub sends it — the cursor is the index of
 * the page that follows, so a fixture says where a page boundary falls by where it splits its array.
 */
const connectionPage = (pages: unknown[][], index: number) => ({
  nodes: pages[index] ?? [],
  pageInfo: { hasNextPage: index + 1 < pages.length, endCursor: String(index + 1) },
});

/** The live shape of #2000's timeline on 2026-09-23, with #2011's body carrying the line it would need. */
const crossRef = (pr: { number: number; state: string; body: string }) => (
  { source: { number: pr.number, state: pr.state, body: pr.body } });

/**
 * BOTH READS THE DELIVERY LOOKUP MAKES, each served as PAGES: the cross-reference timeline, which carries
 * no file lists at all, and then the changed files of whichever pull request declared. A fixture that
 * could only ever answer one page is a fixture that cannot tell paging from truncation, which is the
 * defect reviewer-2 found in the first cut of this Region.
 */
const deliveryApi = (timelinePages: unknown[][], filePages: Record<number, string[][]> = {}) => {
  const calls: string[][] = [];
  const cursor = (args: string[]) => Number(args.find((a) => a.startsWith("after="))?.slice("after=".length) ?? 0);
  const run = (args: string[]) => {
    calls.push(args);
    if (args.join(" ").includes("timelineItems")) {
      return JSON.stringify({ data: { repository: { issue: {
        timelineItems: connectionPage(timelinePages, cursor(args)) } } } });
    }
    const pr = Number(args.find((a) => a.startsWith("number="))?.slice("number=".length));
    const pages = (filePages[pr] ?? [[]]).map((paths) => paths.map((path) => ({ path })));
    return JSON.stringify({ data: { repository: { pullRequest: {
      files: connectionPage(pages, cursor(args)) } } } });
  };
  return { run, calls };
};

/** One timeline page and one file page — the shape of almost every row, and the default to read against. */
const oneDelivery = (nodes: unknown[], paths: Record<number, string[]> = {}) => deliveryApi([nodes],
  Object.fromEntries(Object.entries(paths).map(([pr, list]) => [pr, [list]])));

test("#2026: the timeline is the CANDIDATE set and the declaration is the filter", () => {
  const nodes = [
    {}, {}, // an ISSUE cross-reference matches no inline fragment and arrives as `{}` — measured, not assumed
    crossRef({ number: 2011, state: "MERGED", body: "Delivers: #2000\n" }),
    crossRef({ number: 2030, state: "MERGED", body: "mentions #2000 in prose" }),
    crossRef({ number: 2044, state: "MERGED", body: "also mentions #2000" }),
  ];
  const { run } = oneDelivery(nodes, { 2011: ["packages/agent-org/host/x"], 2044: ["docs/b.md"] });
  assert.deepEqual(lookupDeliveringPr(2000, { run }),
    { number: 2011, state: "MERGED", changedPaths: ["packages/agent-org/host/x"] },
    "#2030 and #2044 are real cross-references of #2000 that delivered nothing — reading the timeline "
    + "alone would have picked the last of the three");
});

test("#2026: a declaration naming ANOTHER row is not a declaration of this one", () => {
  const { run } = oneDelivery([crossRef({ number: 9, state: "OPEN", body: "Delivers: #2002" })], { 9: ["a.ts"] });
  assert.equal(lookupDeliveringPr(2000, { run }), undefined);
});

test("#2026: nothing declaring is `undefined` and a failed lookup is `null` — different states", () => {
  assert.equal(lookupDeliveringPr(2000, { run: oneDelivery([]).run }), undefined);
  assert.equal(lookupDeliveringPr(2000, { run: () => { throw new Error("gh: network"); } }), null,
    "an inconclusive answer must never read as 'nothing in build', which would defeat the rule");
});

test("#2026: the lookup asks GitHub's own cross-reference events, not a search over bodies", () => {
  // A search index lags the body edit the refusal has just told somebody to make; the timeline is computed
  // server-side the moment the body is written. This pins the mechanism, which is the finding.
  const { run, calls } = oneDelivery([]);
  lookupDeliveringPr(2000, { run });
  const query = calls[0].join(" ");
  assert.match(query, /CROSS_REFERENCED_EVENT/);
  assert.doesNotMatch(query, /\bsearch\(/, "a search query would be indexed minutes after the edit");
});

// --- #2026: BOTH CONNECTIONS ARE READ TO THEIR END — reviewer-2's blocker on #2048 ----------------------

/**
 * THE ROW THAT IS BLOCKING ITS AUTHOR IS THE ROW THAT COLLECTS CROSS-REFERENCES — every sibling row and
 * pull request that cites the refusal adds one — so the delivery is the OLDEST interesting event on the
 * timeline and a window reads past it. The first cut of this Region took `timelineItems(last:20)`, which
 * answered "nobody declared a delivery" the moment twenty events piled up after the one that mattered,
 * and left the author in build with nothing to distinguish a missing line from an unread one.
 */
/**
 * THE PAGING TESTS BELOW CANNOT SEE THE PAGE SIZE — every fixture decides its own boundaries, so a
 * `PAGE_SIZE` of 1 would page correctly and survive all of them while making a claim cost fifty requests.
 * Both queries ask for the largest page GitHub will give, and this is the assertion that notices.
 */
test("#2026: both queries ask for a FULL page, so paging is not paid for one node at a time", () => {
  const { run, calls } = oneDelivery([crossRef({ number: 2011, state: "OPEN", body: "Delivers: #2000" })],
    { 2011: ["a.ts"] });
  lookupDeliveringPr(2000, { run });
  assert.match(calls[0].join(" "), new RegExp(`timelineItems\\(first:${PAGE},`));
  assert.match(calls[1].join(" "), new RegExp(`files\\(first:${PAGE},`));
});

test("#2026: a delivery declared before a hundred more cross-references is still found", () => {
  const noise = (from: number) => Array.from({ length: PAGE }, (_, i) => crossRef(
    { number: from + i, state: "MERGED", body: `mentions #2000 in passing (${from + i})` }));
  const { run, calls } = deliveryApi(
    [[crossRef({ number: 2011, state: "OPEN", body: "Delivers: #2000" }), ...noise(3000).slice(1)],
      noise(4000), noise(5000)],
    { 2011: [["packages/agent-org/host/units.mjs"]] });
  assert.deepEqual(lookupDeliveringPr(2000, { run }),
    { number: 2011, state: "OPEN", changedPaths: ["packages/agent-org/host/units.mjs"] },
    "the declaration is 200 cross-references back; a single page of the timeline cannot see it");
  assert.equal(calls.filter((args) => args.join(" ").includes("timelineItems")).length, 3,
    "three pages, so the read genuinely continued rather than the fixture flattening them");
});

/**
 * AND THE SAME TRUNCATION ON THE OTHER CONNECTION. `files(first:100)` misses a Region path that falls
 * after the hundredth changed file — and a wide rename is exactly the shape that both moves a row's
 * declared paths and runs past a hundred files, so the truncated read would refuse the delivery that
 * proves the point.
 */
test("#2026: a Region path after the hundredth changed file is still read", () => {
  const filler = (from: number) => Array.from({ length: PAGE }, (_, i) => `docs/note-${from + i}.md`);
  const { run, calls } = deliveryApi([[crossRef({ number: 2011, state: "OPEN", body: "Delivers: #2000" })]],
    { 2011: [filler(0), [...filler(100).slice(1), "packages/agent-org/host/units.mjs"]] });
  const delivery = lookupDeliveringPr(2000, { run });
  assert.ok(delivery?.changedPaths.includes("packages/agent-org/host/units.mjs"),
    "the only path the Region covers is on the second page of the file list");
  assert.equal(delivery?.changedPaths.length, PAGE * 2, "both pages, whole");
  assert.equal(calls.filter((args) => args.join(" ").includes("pullRequest")).length, 2);
});

test("#2026: each page is asked with the cursor the one before it gave", () => {
  // Without this the loop re-reads page one until the bound trips: `hasNextPage` alone is not paging.
  const { run, calls } = deliveryApi([[], [], []]);
  lookupDeliveringPr(2000, { run });
  assert.deepEqual(calls.map((args) => args.find((a) => a.startsWith("after=")) ?? "after=<unsent>"),
    ["after=<unsent>", "after=1", "after=2"],
    "the first page sends no cursor at all — `-f after=` would send the empty STRING, which GitHub rejects");
});

test("#2026: the timeline asks for no file lists; the files are read off the ONE pull request that declared", () => {
  // Not a tidy-up: a hundred nested file connections have no single cursor between them, so asking for
  // the files inline is what made the file list impossible to page in the first place.
  const { run, calls } = oneDelivery([crossRef({ number: 2011, state: "OPEN", body: "Delivers: #2000" })],
    { 2011: ["a.ts"] });
  lookupDeliveringPr(2000, { run });
  assert.doesNotMatch(calls[0].join(" "), /files\(/, "the candidate set costs one page of numbers and bodies");
  assert.match(calls[1].join(" "), /pullRequest\(number:\$number\)\{files\(/);
  assert.ok(calls[1].includes("number=2011"),
    `the SECOND read is about the declaring PR, not the row — ${calls[1].join(" ")}`);
});

/**
 * THE ONE BOUND THAT REMAINS, AND IT IS A FAILED LOOKUP RATHER THAN A SHORT ANSWER. A `hasNextPage` that
 * stays true against a cursor that stops moving would spin forever inside a claim, so the read gives up —
 * and gives up by THROWING, which `lookup` reads as `null` and `rowFactsFor` leaves IN BUILD. A bound that
 * returned what it had would be the truncation this test exists to forbid, wearing a larger number.
 */
test("#2026: a connection that never ends is a FAILED lookup, not a short answer", () => {
  const endless = () => JSON.stringify({ data: { repository: { issue: { timelineItems: {
    nodes: [], pageInfo: { hasNextPage: true, endCursor: "always-more" } } } } } });
  assert.equal(lookupDeliveringPr(2000, { run: endless }), null);
});

test("#2026: a page carrying no `pageInfo` is a failed lookup, not the last page", () => {
  const shapeless = () => JSON.stringify({ data: { repository: { issue: { timelineItems: { nodes: [] } } } } });
  assert.equal(lookupDeliveringPr(2000, { run: shapeless }), null,
    "both queries ask for `pageInfo`, so its absence means the response is not the shape this code reads");
});

// --- #2026: the composition, and the call it does NOT make ---------------------------------------------

/** Answers each `gh` shape `lookupHeldRows` drives, so one test can pin which calls are made at all. */
const fleet = (opts: { closingPr?: string; region: string;
  timelineNodes?: unknown[]; filePaths?: Record<number, string[]> }) => {
  const seen: string[] = [];
  const delivery = oneDelivery(opts.timelineNodes ?? [], opts.filePaths ?? {});
  const run = (args: string[]) => {
    const joined = args.join(" ");
    if (args[0] === "issue" && args[1] === "list") { seen.push("held"); return JSON.stringify([{ number: 2000 }]); }
    if (joined.includes("closedByPullRequestsReferences")) {
      seen.push("closing");
      const nodes = opts.closingPr ? [{ number: 2011, state: opts.closingPr, headRefOid: "abc" }] : [];
      return JSON.stringify({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes } } } } });
    }
    if (joined.includes("timelineItems")) { seen.push("delivery"); return delivery.run(args); }
    if (joined.includes("pullRequest(")) { seen.push("files"); return delivery.run(args); }
    if (args[0] === "issue") { seen.push("shape"); return JSON.stringify({ body: `## Region\n\n${opts.region}\n` }); }
    seen.push("subs"); return "[]";
  };
  return { seen, rows: lookupHeldRows("worker-capture", 2026, { run }) };
};

const REGION = "```\npackages/agent-org/host/units.mjs\n```";

test("#2026: a row already cleared by `Closes:` costs NO delivery lookup", () => {
  // Behaviour, not an optimisation to admire: a cleared row cannot be cleared harder, so the question's
  // answer changes nothing. #989 took two calls per held row out of this path; this adds one back only
  // where it decides the verdict.
  const { seen, rows } = fleet({ closingPr: "OPEN", region: REGION });
  assert.equal(inBuildReason(rows ?? []), null);
  assert.ok(!seen.includes("delivery"), `the delivery lookup must not run — calls were ${seen.join(",")}`);
});

test("#2026: a row in build IS asked, and the Region overlap is the tree's own `regionCovers`", () => {
  const { seen, rows } = fleet({ region: REGION, timelineNodes: [
    crossRef({ number: 2011, state: "OPEN", body: "Closes: none -- the host install finishes it\n"
      + "Delivers: #2000\n" })], filePaths: { 2011: ["packages/agent-org/host/units.mjs"] } });
  assert.ok(seen.includes("delivery"));
  assert.deepEqual(rows?.[0].deliveringPr, { state: "OPEN", proposesRegionPath: true });
  assert.equal(inBuildReason(rows ?? []), null, "#2026's own open-check, end to end");
});

test("#2026: a declaring PR that touches none of the Region's files still leaves the row in build", () => {
  const { rows } = fleet({ region: REGION, timelineNodes: [
    crossRef({ number: 2011, state: "OPEN", body: "Delivers: #2000" })],
  filePaths: { 2011: ["docs/unrelated.md"] } });
  assert.deepEqual(rows?.[0].deliveringPr, { state: "OPEN", proposesRegionPath: false });
  assert.ok(inBuildReason(rows ?? []), "the row's own bar: a PR that never proposed its commits clears nothing");
});

test("#2026: a DIRECTORY Region entry covers the file beneath it, because `regionCovers` says so", () => {
  // Delegated, not re-implemented: #941 taught the tree one answer for directory prefixes and this rule
  // asks it. Re-parsing the Region a second way is how two readings of one section drift apart.
  const { rows } = fleet({ region: "packages/agent-org/host/", timelineNodes: [
    crossRef({ number: 2011, state: "OPEN", body: "Delivers: #2000" })],
  filePaths: { 2011: ["packages/agent-org/host/x.mjs"] } });
  assert.equal(rows?.[0].deliveringPr?.proposesRegionPath, true);
});

// --- #2026: the refusal names the third way out --------------------------------------------------------

/**
 * FOLLOW THE REFUSAL EXACTLY AND YOU MUST PASS — the rule #1161 paid for one clause above. The other two
 * ways out do not fit this population: "finish it" is exactly what is happening when the commits are
 * already proposed, and `decline` would orphan a green reviewed pull request. So the refusal has to name
 * the line to add, AND the condition that makes it count, or the reader adds it to an unrelated pull
 * request, is refused again, and debugs the remedy instead of doing the work.
 */
test("#2026: the refusal names the `Delivers:` line, by row number, and what makes it count", () => {
  const reason = String(inBuildReason([{ ...inBuild, number: 2000 }]));
  assert.match(reason, /add a line reading `Delivers: #2000`/,
    "by NUMBER, so the line is copy-pasteable rather than a template the reader fills in wrong");
  assert.match(reason, /open or merged AND changes at least one path/,
    "and the second condition, or the remedy is followable and still fails");
  assert.match(reason, /`## Region`/, "naming WHERE those paths are declared");
});

test("#2026: the remedy is printed only in the refusal, and mutating it out goes red", () => {
  // The mutation this file could not otherwise express: drop the clause and the assertions above must fail.
  // Driven on the returned STRING, because the string is what a reader is handed.
  const withoutTheRemedy = String(inBuildReason([{ ...inBuild, number: 2000 }]))
    .replace(/\n {2}If a pull request ALREADY PROPOSES[\s\S]*$/, "");
  assert.doesNotMatch(withoutTheRemedy, /Delivers:/,
    "the mutation genuinely removes what those assertions look at");
  assert.match(withoutTheRemedy, /#2000 is IN BUILD/,
    "and it is still recognisably the same refusal, so the mutation changes the MEANING, not the subject");
  assert.equal(inBuildReason([{ ...inBuild, deliveringPr: delivered }]), null,
    "while a row that is NOT refused is handed no remedy at all");
});

/**
 * #2026: THE ONE PLACE THIS CLAUSE DEPARTS FROM THE FILE'S "a failed lookup is INCONCLUSIVE" CONVENTION,
 * and the direction of the clause is the reason. The three lookups above establish that a row IS in build,
 * so an unanswerable one must not manufacture a refusal. This one can only ever CLEAR a row, and it is
 * asked only of rows already in build — so treating a failure as inconclusive would convert every refusal
 * B2 would have made into silence the moment GraphQL hiccuped, and B2's teeth would depend on the network.
 *
 * FOUND BY FOUR REDS OUTSIDE THIS ROW'S REGION, not reasoned out in advance:
 * `row-claim-session-eligibility.test.ts` routes every `api graphql` call to one
 * `closedByPullRequestsReferences` payload, so the new query threw and four tests asserting a refusal went
 * quiet. The fakes were right and the failure direction was wrong.
 */
test("#2026: a FAILED delivery lookup leaves the row IN BUILD — the clause fails to not clearing", () => {
  const run = (args: string[]) => {
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify([{ number: 2000 }]);
    if (args.join(" ").includes("timelineItems")) throw new Error("gh: GraphQL 502");
    if (args[0] === "api" && args[1] === "graphql") {
      return JSON.stringify({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [] } } } } });
    }
    if (args[0] === "issue") return JSON.stringify({ body: `## Region\n\n${REGION}\n` });
    return "[]";
  };
  const rows = lookupHeldRows("worker-capture", 2026, { run });
  assert.notEqual(rows, null, "the HELD reading answered, so the claim is not inconclusive overall");
  assert.equal(rows?.[0].deliveringPr, undefined);
  assert.ok(inBuildReason(rows ?? []), "a new clause must not change the rule's behaviour under failure");
});
