#!/usr/bin/env node
// @ts-check
// RULE: DOES THE CLAIMING SESSION ALREADY HOLD A ROW IN BUILD? -- B2, #476, rewritten by #989.
//
// IT ASKED ABOUT A PULL REQUEST AND THE QUESTION IS ABOUT A ROW. Until #989 this refused while the
// session's own PR was open AT ALL, so a PR that was green and waiting only on its reviewer blocked its
// author from starting anything: #988 was green from 07:46Z and waited through a twelve-hour restart gap,
// with nothing its author could do. ceo granted a hand exception three times in one day and then ruled
// that an engineer does not wait on review -- as many PRs in review as it takes, ONE row in build.
//
// IN BUILD MEANS A CLAIMED ROW WHOSE OWN DELIVERABLE IS A COMMIT THAT DOES NOT EXIST YET. One sentence,
// and everything below reads it from the tracker rather than from a label a session applies to itself:
//
//   held        `in-progress` + `session:<name>`, which is what `lookupOtherHeldIssues` already finds
//   undelivered no PR that is OPEN or MERGED closes it. OPEN means the commit is proposed, MERGED means
//               it exists; a CLOSED-unmerged PR means neither, so an abandoned PR leaves the row in build
//   owed        its Region declares at least one path. A row that names files is one somebody owes a
//               commit for; one that names none is a settings change, a ruling, a measurement on the row
//   its own     it has no sub-issues. A parent's deliverable is its sub-rows' commits, not its own
//
// WHAT `owed` CANNOT SEE, and it is a property of the parser rather than of this rule: `declaredRegionFiles`
// answers `[]` both for "names no path" and for "names paths its grammar cannot read". #999 fixed one
// instance of the second today (a fenced extension-less path) and another is open (a Region written as
// prose naming an extension-less file). Such a row would read as "deliverable is not a commit" and fail to
// block. MEASURED across all 67 open rows (worker-capture, reviewing #1012): 64 declare paths, 1 has no
// Region, and 2 parse to `[]` -- #623 and #149, both correctly classified. No live instance, so this is a
// sentence rather than a guard; the fix belongs in the parser, where the next grammar gap will also land.
//
// MEASURED BEFORE IT WAS WRITTEN (#989's own row carries the workings). `closedByPullRequestsReferences`
// takes an `includeClosedPrs` argument defaulting to FALSE, so a closed-unmerged PR is invisible to the
// query below -- confirmed on real data, issues #79 and #93, whose abandoned PRs (#89, #107) appear only
// with the argument set. #159 is the case that decides the wording: it carries BOTH #172 CLOSED and #473
// MERGED, so "no PR at all" would have called a delivered row in build while "no PR that is OPEN or
// MERGED" gets it right. The explicit CLOSED filter below therefore never fires under today's query --
// it is a guard against a future one, said plainly so nobody deletes it as dead.
//
// "A unit is finished when the PR reads MERGED -- not when the local run is green." #472's owner
// reported a clean local run and moved on while CI went red; nine PRs sat red on their acceptance lines
// the same night with their owners asleep, every one a fault its author could have fixed in a minute.
//
// So `row-claim` refuses a NEW claim while the claiming session's own open PR is still open at all --
// naming it and whether it is RED (a required check failing) or simply not yet merged -- rather than
// letting a session open a second front while its first is unresolved.
//
// `behind` alone MUST NOT block, per `ceo`'s ruling: under strict branch protection every merge puts
// every other open PR behind, and #406 sat `behind=55` while being entirely healthy -- `update-branch`
// now fixes that without the owner. So this asks only whether the PR is OPEN (blocking, regardless of
// its own CI colour -- "one PR in flight" is the rule's own name) versus MERGED (clear) or CLOSED
// (abandoned, no longer in flight); the message additionally says whether it is RED, because a red PR
// and a green-but-not-yet-merged PR need the same refusal but a different next action.
//
// `Closes:` CANNOT SEE A ROW WHOSE DELIVERABLE IS A COMMIT **PLUS** A NON-COMMIT STEP -- #2026, and the
// second reading `undelivered` now takes. Measured live 2026-09-22 21:47Z: `worker-judge` held #2000,
// whose PR #2011 was OPEN and green on every required check, and was refused a claim on #2002. #2011
// declares `Closes: none` and is RIGHT to -- #2000's done-when requires `npm run host:install` to have
// been RUN on the agent host, and a `Closes #2000` would auto-close the row on merge, discarding the very
// step the row exists to guarantee. So the two declarations are in genuine conflict: `Closes: #2000`
// loses the host step, `Closes: none` holds the author in build indefinitely, and no wording satisfies
// both. It does not even clear on merge. Any row whose done-when a merge cannot satisfy -- a host install,
// a fleet deploy, a release dispatch, a measurement taken after a run -- is in that population.
//
// THE REMEDY: A `Delivers: #N` LINE IN THE PULL REQUEST BODY, HONOURED ONLY WHEN THAT PULL REQUEST
// ACTUALLY CHANGES A PATH THE ROW'S REGION DECLARES. Two halves, and the second is the one that matters:
// #2026 sets the bar that "a remedy must not let a row be cleared by a PR that never proposed its
// commits", and a declaration alone is a claim by its own author. The file check is what makes it a
// reading rather than a promise.
//
// A DECLARED, PARSED, TESTED BODY FIELD is this repository's own proven pattern -- `Acceptance:` and
// `Closes:` are merge-blocking body fields already (2026-09-17), so authors read and write them. It is
// deliberately NOT a new label (one label per row number rots the vocabulary, the lesson `branch:agent/...`
// taught) and NOT a branch-name convention (not every branch encodes its row, as this header says above).
//
// FOUND VIA GITHUB'S OWN CROSS-REFERENCE EVENTS, not a search over PR bodies: writing `#2000` anywhere in
// a PR body makes GitHub record a `CROSS_REFERENCED_EVENT` on that issue, server-side, with no search
// index to lag behind a body edit. **A cross-reference alone is far too loose** and the live data says so:
// probed 2026-09-23 on #2000, twenty of its cross-references were 13 issues and FOUR pull requests --
// #2011, which delivered it, and #2030, #2038 and #2044, which merely mention it. The `Delivers:`
// declaration is what separates the one from the three.
//
// BOTH READS GO TO THE END OF THEIR CONNECTION, and neither takes a window. `PAGE_SIZE` carries the
// window this replaced and why it was a silent wrong answer; `MAX_PAGES`, the one bound that remains and
// why exceeding it is a FAILED lookup rather than a short one. Said once, there, rather than twice.
//
// WHAT THIS READING CAN AND CANNOT SEE, stated the way `owed` above states its own gap, because #2026
// asked for exactly that:
//
//   CAN   a held row whose commits are proposed (OPEN) or landed (MERGED) by a pull request that declares
//         `Delivers: #N` on a line of its own AND changes at least one path the row's Region declares.
//   CANNOT a pull request that delivers the row and never says so. The row stays in build, which is
//         today's behaviour exactly -- so the unseen case is the SAFE one, and the refusal names the line
//         to add. Opt-in, and a refusal you can follow in one body edit.
//   CANNOT a delivery that changes no path the Region covers -- a rename that moves every declared path,
//         a Region written after the commits. Also stays in build; the author widens the Region or the
//         row is genuinely not what that PR proposed.
//   CANNOT anything about whether the NON-COMMIT step happened. It never claimed to: this clause says the
//         commit is proposed, and the row stays OPEN until its own done-when is met by a human.
//
// NOTHING OUTSIDE THIS FILE IS TAUGHT `Delivers:` -- the merge-blocking body checker still requires only
// `Acceptance:` and `Closes:`, so the line is optional and unchecked, and a PR that omits it is not red.
// That boundary is deliberate: #2026's Region is this rule and its test, and a field the gate REQUIRES is
// a different row with a different blast radius.

// FOUND VIA `closedByPullRequestsReferences`, THE REVERSE OF `merge-guard.mjs`'s OWN `closingIssuesReferences`
// -- not a `session:*` label on the PR (that label is a manual HOLD, applied by `pr:hold`, and most open
// PRs never carry one) and not a branch-name convention (not every branch encodes its issue number). The
// one fact this whole fleet can rely on is which issue a PR's own `Closes #N` resolves, because GitHub
// computes it server-side. So: find the OTHER issues `mySession` currently holds (`in-progress` +
// `session:<name>`, excluding the row being claimed right now), and ask GitHub which PR would close each.
import { REPO } from "../../../../scripts/repo-identity.mjs";
import { gh, lookup } from "../merge-guard/lookups.mjs";
import { declaredRegionFiles, regionCovers } from "../region-paths.mjs";

// NO `git` SPAWN HERE, deliberately -- every lookup in this file goes through `gh` (issue/PR/GraphQL
// reads), which needs no `sandboxGitEnv()` scrub: that helper exists for `execFileSync("git", ...)`
// specifically (a leaked `GIT_DIR` redirects a spawned GIT call onto the wrong repository), and
// `git-spawn-classification.test.ts` discovers files spawning `git`, not `gh`. #455 found the real gap
// this shape can hide in `packages/agent-org/src/merge-guard/lookups.mjs`; this file has no such call to have one in.

// #989: `colourFor` AND THE CHECK-STATE READ ARE GONE WITH THE VERDICT THAT USED THEM. B2 no longer asks
// whether a PR is red -- it asks whether a row is in build -- so a PR's colour answers a question nobody
// is asking here. Removing it took TWO network calls per held row with it, for a value nothing consumed:
// `row-claim-session-eligibility.test.ts` had a case taking 8.4 seconds because an un-injected fixture
// reached the real API through that path.

/**
 * A pull request that DECLARED it delivers this row without closing it, and whether it actually proposes
 * one of the row's own Region paths. Both halves are facts on the row, not steps in a lookup, so the
 * predicate below can be driven without a network at all.
 * @typedef {{ state: "OPEN" | "MERGED" | "CLOSED", proposesRegionPath: boolean }} DeliveringPr
 */

/**
 * @typedef {{ number: number, declaresPaths: boolean, subIssues: number,
 *             closingPr: { state: "OPEN" | "MERGED" | "CLOSED" } | undefined,
 *             deliveringPr?: DeliveringPr }} RowFacts
 */

/**
 * Is this row IN BUILD -- does somebody still owe a commit for it? See the file header for each clause and
 * what it is read from.
 * @param {RowFacts} row @returns {boolean}
 */
export function isInBuild(row) {
  if (row.closingPr && row.closingPr.state !== "CLOSED") return false; // proposed, or delivered
  if (proposedByDeclaredDelivery(row.deliveringPr)) return false;      // #2026: proposed under `Delivers:`
  if (!row.declaresPaths) return false;                                // its deliverable is not a commit
  if (row.subIssues > 0) return false;                                 // a parent: its sub-rows owe them
  return true;
}

/**
 * #2026: DOES A DECLARED DELIVERY ACTUALLY PROPOSE THIS ROW'S COMMITS? Both halves, and neither alone:
 * a CLOSED-unmerged pull request proposes nothing (the same reading `closingPr` takes one line above),
 * and a declaration that changes no path the Region declares is an author's claim rather than a proposal.
 * #2026's own bar: a remedy must not let a row be cleared by a pull request that never proposed its
 * commits.
 * @param {DeliveringPr | undefined} delivering @returns {boolean}
 */
function proposedByDeclaredDelivery(delivering) {
  if (delivering === undefined) return false;
  return delivering.state !== "CLOSED" && delivering.proposesRegionPath;
}

/**
 * THE VERDICT, PURE. `null` when nothing blocks -- including when the lookup could not ask, which its own
 * caller reports separately; this function only ever sees rows it was given.
 *
 * THE REFUSAL NAMES THE ROW, NOT A PR, because the row is what is in build -- and it names BOTH ways out,
 * since a refusal a reader cannot follow is the shape this repo has paid for most often. It also names the
 * one thing that can make a parent look like a build: the sub-issue link exists only where the sub-row was
 * filed with `row-file --parent`, so a parent whose children were filed without it reads as in build.
 * `row-claim-own-pr-health-rule.test.ts` pins that as a known limitation rather than describing it.
 *
 * @param {readonly RowFacts[]} rows every OTHER row this session holds
 * @returns {string | null}
 */
export function inBuildReason(rows) {
  const inBuild = rows.find(isInBuild);
  if (!inBuild) return null;
  return `#${inBuild.number} is IN BUILD: you hold it, no PR that is open or merged closes it, and its `
    + "Region declares files somebody still owes a commit for. Finish it, or `decline` it, before claiming "
    + "another (this is B2: one ROW in build per session -- an open PR no longer blocks a claim).\n"
    + `  If #${inBuild.number} is a PARENT whose sub-rows were filed without \`--parent\`, link one with \``
    // #1161: `-F`, NOT `-f`. `gh api -f` sends every value as a STRING and the sub-issues endpoint requires
    // an integer, so this line returned `Invalid property /sub_issue_id: "5434613075" is not of type
    // integer. (HTTP 422)` every time it was followed exactly. `-F` sends it typed and it works.
    //
    // The rule this broke is the one that makes a named remedy worth printing at all: FOLLOW THE REFUSAL
    // EXACTLY AND YOU MUST PASS. A refusal naming a remedy that fails is worse than one naming none, because
    // the reader now debugs the remedy instead of doing the work -- and may conclude the sub-issue route
    // does not exist and `decline` a row they should have linked.
    //
    // Found by worker-capture following it, which is the only way it could have been found: the message is
    // correct, the diagnosis is correct, and THE ONE PART THAT IS EXECUTABLE IS THE PART NOBODY EXECUTED.
    + `gh api repos/${REPO}/issues/${inBuild.number}/sub_issues -F sub_issue_id=<id>\` and this refusal lifts.`
    + deliversRemedy(inBuild.number);
}

/**
 * #2026: THE THIRD WAY OUT, AND IT IS THE ONE THE OTHER TWO DO NOT FIT. "Finish it" is exactly what is
 * happening when a row's commits are already proposed and its done-when needs a host install afterwards,
 * and `decline` would orphan a green reviewed pull request. Printed only as part of the refusal, because
 * a reader who is not being refused has no use for it.
 *
 * BOTH CONDITIONS ARE NAMED, not just the line to add: this rule honours the declaration only from a pull
 * request that also changes a path the row's Region declares, and a remedy whose second half is a secret
 * is the #1161 shape again -- the reader follows it exactly, is refused anyway, and debugs the remedy
 * instead of doing the work.
 * @param {number} issueNumber @returns {string}
 */
function deliversRemedy(issueNumber) {
  return `\n  If a pull request ALREADY PROPOSES #${issueNumber}'s commits but must not auto-close it -- a `
    + "row whose done-when needs a host install, a deploy or a measurement after the run, so its body "
    + `correctly says \`Closes: none\` -- add a line reading \`Delivers: #${issueNumber}\` to THAT pull `
    + "request's body and this refusal lifts. It is honoured only while that pull request is open or "
    + `merged AND changes at least one path #${issueNumber}'s own \`## Region\` declares, so it states a `
    + "delivery rather than claiming one.";
}

/**
 * Every OTHER issue `mySession` currently holds (`in-progress` + `session:<name>`), excluding the row
 * being claimed right now -- `null` on a failed lookup, never `[]`, the same convention every lookup in
 * this fleet uses: a network failure must never read as "holds nothing".
 *
 * @param {string} mySession
 * @param {number} excludeIssueNumber
 * @param {{ run?: (args: string[]) => string }} [deps]
 * @returns {number[] | null}
 */
export function lookupOtherHeldIssues(mySession, excludeIssueNumber, { run = gh } = {}) {
  return lookup(() => {
    const raw = run(["issue", "list", "--repo", REPO, "--state", "open",
      "--label", "in-progress", "--label", `session:${mySession}`, "--json", "number"]);
    /** @type {{ number: number }[]} */
    const parsed = JSON.parse(raw);
    return parsed.map((issue) => issue.number).filter((n) => n !== excludeIssueNumber);
  });
}

/**
 * Which PR (if any) would close `issueNumber`, and what state it is in -- #989 removed the check-state
 * read, so this reports the PR's STATE and nothing about its colour.
 *
 * `closedByPullRequestsReferences` is resolved server-side by GitHub, never a `Closes #N` regex over a
 * PR body -- the same discipline `merge-guard.mjs`'s `lookupClosingIssues` already applies in reverse.
 * `null` on a failed lookup; `{ number, state: "OPEN"/"MERGED"/"CLOSED" }` when a closing PR exists; an
 * issue with NO closing PR at all (nobody has opened one yet) is reported as `undefined`, distinct from a
 * failed lookup -- "nothing to check" and "could not ask" are different states, and `isInBuild` reads them
 * differently: an abandoned (CLOSED) PR leaves the row in build, no PR at all likewise, a MERGED one does
 * not.
 *
 * @param {number} issueNumber
 * @param {{ run?: (args: string[]) => string }} [deps]
 * @returns {{ number: number, state: "OPEN" | "MERGED" | "CLOSED" } | undefined | null}
 */
export function lookupClosingPrHealth(issueNumber, { run = gh } = {}) {
  return lookup(() => {
    const [owner, name] = REPO.split("/");
    const query = "query($owner:String!,$name:String!,$number:Int!){"
      + "repository(owner:$owner,name:$name){issue(number:$number){"
      + "closedByPullRequestsReferences(first:5){nodes{number state headRefOid}}}}}";
    const data = JSON.parse(run(["api", "graphql", "-f", `query=${query}`,
      "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${issueNumber}`]));
    /** @type {{ number: number, state: "OPEN" | "MERGED" | "CLOSED", headRefOid: string }[]} */
    const nodes = data.data.repository.issue.closedByPullRequestsReferences.nodes;
    if (nodes.length === 0) return undefined;
    // MOST RECENT (last) reference wins -- an issue can accumulate more than one over its life (a
    // reverted fix reopened and closed by a second PR); the newest is the one that matters now.
    const pr = nodes[nodes.length - 1];
    // #989: THE CHECK STATE IS NOT READ ANY MORE, and removing it removed two network calls per held row
    // for a value nothing consumed. B2 asks whether a row is in build; a PR's colour answers a question
    // nobody is asking here, and `row-claim-session-eligibility.test.ts` had one case taking 8.4 SECONDS
    // because an un-injected fixture reached the real API through that path.
    return { number: pr.number, state: pr.state };
  });
}

/**
 * #2026: HOW MUCH OF EACH CONNECTION ONE REQUEST CARRIES -- a PAGE SIZE, not a window. GitHub caps a
 * connection page at 100, and both reads below page to the END rather than stopping at the first page.
 *
 * THE WINDOW THIS REPLACED WAS A SILENT WRONG ANSWER IN BOTH DIRECTIONS (reviewer-2 on #2048, and the
 * verdict is right): `timelineItems(last:20)` drops a real delivery the moment twenty cross-references
 * accumulate after it -- and a row that is BLOCKING ITS AUTHOR collects them, because every sibling row
 * and pull request that cites the refusal adds one -- while `files(first:100)` misses a Region path that
 * falls after the hundredth changed file of a wide rename. Each truncation reads as "nobody declared a
 * delivery", which leaves the author in build with no way to tell a missing line from an unread one.
 * A cap NOBODY CAN SEE is the defect; a page size everything pages past is not.
 */
const PAGE_SIZE = 100;

/**
 * #2026: THE MOST PAGES EITHER READ WILL TAKE, and it exists to bound a SERVER that never says it has
 * finished -- a `hasNextPage` that stays true against a cursor that stops moving would otherwise spin
 * forever inside a claim. It is not a window: exceeding it THROWS, so `lookup` reads `null` and the row
 * stays IN BUILD, which is this clause's own safe direction (see `rowFactsFor`). `MAX_PAGES * PAGE_SIZE`
 * cross-references or changed files is orders past anything this repository has produced -- deliberately
 * not written out as a number here, which would go stale the first time either constant moved -- so
 * reaching it means the connection is misbehaving rather than that the row is busy.
 */
const MAX_PAGES = 50;

/** A `Delivers:` line of its own, the way `Acceptance:` and `Closes:` are lines of their own. */
const DELIVERS_LINE = /^[ \t]*(?:\*\*)?Delivers:(?:\*\*)?[ \t]*(.*)$/gim;
const ROW_REFERENCE = /#(\d+)\b/g;

/**
 * #2026: THE ROWS A PULL REQUEST BODY DECLARES IT DELIVERS. A LINE OF ITS OWN, like every other body
 * field this repository parses -- so a row number cited in prose ("this is the shape #2000 hit") declares
 * nothing, which is the whole reason the field exists rather than reading cross-references directly.
 *
 * More than one row per line is taken (`Delivers: #2000, #2002`): one pull request can carry two rows'
 * commits, and a grammar that silently took only the first would clear one row and hold the other with
 * nothing to say why. `Delivers: none` yields no number and so declares nothing, which is what it says.
 *
 * @param {string} body a pull request body, possibly empty
 * @returns {number[]} every row number declared, in declaration order, without repeats
 */
export function deliveredRowsDeclaredBy(body) {
  /** @type {Set<number>} */
  const declared = new Set();
  for (const [, list] of (body ?? "").matchAll(DELIVERS_LINE)) {
    for (const [, number] of list.matchAll(ROW_REFERENCE)) declared.add(Number(number));
  }
  return [...declared];
}

/**
 * #2026: THE PULL REQUEST THAT DECLARED IT DELIVERS THIS ROW, with the paths it actually changes.
 *
 * Read off GitHub's own `CROSS_REFERENCED_EVENT` timeline rather than a search over pull request bodies:
 * the events are computed server-side the moment a body naming `#N` is written or edited, so there is no
 * search index to lag behind the edit the refusal just told somebody to make. The timeline is the
 * CANDIDATE set and nothing more -- most of it is unrelated -- and `deliveredRowsDeclaredBy` is the
 * filter. Probed live on #2000, 2026-09-23: 13 issue cross-references and four pull requests, of which
 * one (#2011) delivered the row and three (#2030, #2038, #2044) only mention it.
 *
 * `null` on a failed lookup, `undefined` when nothing declared a delivery -- "could not ask" and "nobody
 * declared one" are different states, the same distinction `lookupClosingPrHealth` draws.
 *
 * @param {number} issueNumber
 * @param {{ run?: (args: string[]) => string }} [deps]
 * @returns {{ number: number, state: "OPEN" | "MERGED" | "CLOSED", changedPaths: string[] } | undefined | null}
 */
export function lookupDeliveringPr(issueNumber, { run = gh } = {}) {
  return lookup(() => {
    // A cross-reference whose source is an ISSUE matches no inline fragment and arrives as `{}`, so the
    // number is what separates a pull request from one -- not a `__typename` this query need not ask for.
    const declaring = crossReferencingPrs(issueNumber, run)
      .filter((source) => source.number !== undefined
        && deliveredRowsDeclaredBy(source.body ?? "").includes(issueNumber));
    if (declaring.length === 0) return undefined;
    // MOST RECENT (last) wins, the same reading `lookupClosingPrHealth` takes: a redone delivery declares
    // itself on a second pull request and the newest is the one that describes the tree now.
    const pr = declaring[declaring.length - 1];
    const number = /** @type {number} */ (pr.number);
    return { number, state: /** @type {any} */ (pr.state), changedPaths: changedPathsOf(number, run) };
  });
}

/** The cross-reference timeline, to its end. */
const CROSS_REFERENCE_QUERY = "query($owner:String!,$name:String!,$number:Int!,$after:String){"
  + "repository(owner:$owner,name:$name){issue(number:$number){"
  + `timelineItems(first:${PAGE_SIZE},after:$after,itemTypes:[CROSS_REFERENCED_EVENT]){`
  + "pageInfo{hasNextPage endCursor}nodes{"
  + "... on CrossReferencedEvent{source{... on PullRequest{number state body}}}}}}}}";

/** ONE pull request's changed paths, to their end. */
const CHANGED_FILES_QUERY = "query($owner:String!,$name:String!,$number:Int!,$after:String){"
  + "repository(owner:$owner,name:$name){pullRequest(number:$number){"
  + `files(first:${PAGE_SIZE},after:$after){pageInfo{hasNextPage endCursor}nodes{path}}}}}`;

/**
 * #2026: EVERY PULL REQUEST THAT CROSS-REFERENCES THIS ROW, read to the end of the timeline.
 *
 * THE TIMELINE ASKS FOR NO FILE LISTS, and that is the change reviewer-2's blocker forced rather than a
 * tidy-up alongside it: the files are needed for exactly ONE pull request -- the one that declared the
 * delivery -- so fetching a hundred paths for every unrelated cross-reference both cost more and made the
 * file list impossible to page (there is no single cursor across a hundred nested connections). Reading
 * the declaration first and the files second is what makes both reads complete.
 *
 * @param {number} issueNumber
 * @param {(args: string[]) => string} run
 * @returns {{ number?: number, state?: string, body?: string }[]}
 */
function crossReferencingPrs(issueNumber, run) {
  return everyNodeOf((cursor) => graphqlPage(run, CROSS_REFERENCE_QUERY, issueNumber, cursor)
    .data.repository.issue.timelineItems)
    .map((/** @type {{ source?: object }} */ node) => node.source ?? {});
}

/**
 * #2026: EVERY PATH ONE PULL REQUEST CHANGES, read to the end of the file list -- never the first page.
 * A wide rename is exactly the shape that both moves a row's declared paths and runs past a hundred
 * files, so a truncated list would refuse the delivery that proves the point.
 *
 * @param {number} prNumber
 * @param {(args: string[]) => string} run
 * @returns {string[]}
 */
function changedPathsOf(prNumber, run) {
  return everyNodeOf((cursor) => graphqlPage(run, CHANGED_FILES_QUERY, prNumber, cursor)
    .data.repository.pullRequest.files)
    .map((/** @type {{ path: string }} */ file) => file.path);
}

/**
 * ONE PAGE of a GraphQL connection. `$after` is DECLARED by both queries but only SENT once there is a
 * cursor: an unsupplied nullable variable is `null`, which is where a connection starts -- and `-f after=`
 * would send the empty STRING instead, which is a cursor GitHub rejects.
 *
 * @param {(args: string[]) => string} run
 * @param {string} query
 * @param {number} number the issue or pull request the query is about
 * @param {string | null} cursor
 * @returns {any}
 */
function graphqlPage(run, query, number, cursor) {
  const [owner, name] = REPO.split("/");
  const args = ["api", "graphql", "-f", `query=${query}`,
    "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`];
  if (cursor) args.push("-f", `after=${cursor}`);
  return JSON.parse(run(args));
}

/**
 * EVERY node of a paged connection, in page order -- so the LAST node is still the most recent one, the
 * reading both callers above take.
 *
 * A PAGE WITHOUT `pageInfo` THROWS rather than reading as the last one. Both queries ask for it, so its
 * absence means the response is not the shape this code believes it is -- and the one thing this read
 * must never do quietly is stop early, which is the defect it was written to fix.
 *
 * @param {(cursor: string | null) => { nodes?: any[], pageInfo?: { hasNextPage?: boolean, endCursor?: string | null } }} page
 * @returns {any[]}
 */
function everyNodeOf(page) {
  /** @type {any[]} */
  const all = [];
  /** @type {string | null} */
  let cursor = null;
  for (let read = 0; read < MAX_PAGES; read += 1) {
    const { nodes, pageInfo } = page(cursor);
    all.push(...(nodes ?? []));
    if (!pageInfo) throw new Error("a connection page carried no `pageInfo`, so its end cannot be read");
    if (!pageInfo.hasNextPage) return all;
    cursor = pageInfo.endCursor ?? null;
  }
  throw new Error(`a connection did not end within ${MAX_PAGES} pages`);
}

/**
 * What a row declares and whether anyone owes a commit for it -- the two readings the header names, each a
 * property of the tracker rather than a label. `null` on a failed lookup, never a guess.
 *
 * #2026: it also returns the declared paths THEMSELVES, not only whether there are any -- the delivery
 * clause has to ask whether a pull request changes one of them, and re-parsing the body a second time is
 * how two readings of one Region drift apart (`row-reachability.mjs` records that exact history).
 *
 * @param {number} issueNumber
 * @param {{ run?: (args: string[]) => string }} [deps]
 * @returns {{ declaresPaths: boolean, declaredPaths: string[], subIssues: number } | null}
 */
export function lookupRowShape(issueNumber, { run = gh } = {}) {
  return lookup(() => {
    const body = JSON.parse(run(["issue", "view", String(issueNumber), "--repo", REPO, "--json", "body"])).body;
    // `declaredRegionFiles` is the tree's own parser, not a second reading of the Region: #941 taught it
    // directory items, #975 root-level files, #999 fenced extensionless paths. A row whose Region it reads
    // as empty is a row naming no file -- which is what "the deliverable is not a commit" looks like.
    const declared = declaredRegionFiles(body ?? "") ?? [];
    // GitHub's OWN sub-issue link, written by `row-file --parent`. It cannot be self-applied the way a
    // label can: filing the sub-row is what creates it.
    const subs = JSON.parse(run(["api", `repos/${REPO}/issues/${issueNumber}/sub_issues`]));
    return { declaresPaths: declared.length > 0, declaredPaths: declared,
      subIssues: Array.isArray(subs) ? subs.length : 0 };
  });
}

/**
 * THE FULL LOOKUP, composed: every OTHER row `mySession` holds, with the facts `isInBuild` needs. `null`
 * on ANY failed sub-lookup -- an inconclusive answer must never read as "nothing in build", which would
 * silently defeat the rule this file exists to enforce.
 *
 * @param {string} mySession
 * @param {number} excludeIssueNumber the row being claimed right now -- never checked against itself
 * @param {{ run?: (args: string[]) => string }} [deps]
 * @returns {RowFacts[] | null}
 */
export function lookupHeldRows(mySession, excludeIssueNumber, deps = {}) {
  const otherHeld = lookupOtherHeldIssues(mySession, excludeIssueNumber, deps);
  if (otherHeld === null) return null;
  /** @type {RowFacts[]} */
  const rows = [];
  for (const issueNumber of otherHeld) {
    const facts = rowFactsFor(issueNumber, deps);
    if (facts === null) return null; // a failed lookup partway through is INCONCLUSIVE
    rows.push(facts);
  }
  return rows;
}

/**
 * ONE HELD ROW'S FACTS. `null` on any failed sub-lookup, for the reason `lookupHeldRows` gives.
 *
 * #2026: THE DELIVERY LOOKUP IS ONLY MADE FOR A ROW THAT WOULD OTHERWISE BE IN BUILD, and that is
 * behaviour rather than an optimisation to admire: a row already cleared by `Closes:`, by declaring no
 * path or by being a parent cannot be cleared HARDER, so asking would spend a GraphQL call on a question
 * whose answer changes nothing. The common case -- a session holding one row with an ordinary closing
 * pull request -- makes no extra call at all. #989 removed two calls per held row from this path for a
 * value nothing consumed; this adds one back only where it decides the verdict.
 *
 * @param {number} issueNumber
 * @param {{ run?: (args: string[]) => string }} [deps]
 * @returns {RowFacts | null}
 */
function rowFactsFor(issueNumber, deps = {}) {
  const closing = lookupClosingPrHealth(issueNumber, deps);
  if (closing === null) return null;
  const shape = lookupRowShape(issueNumber, deps);
  if (shape === null) return null;
  /** @type {RowFacts} */
  const facts = { number: issueNumber, declaresPaths: shape.declaresPaths, subIssues: shape.subIssues,
    closingPr: closing === undefined ? undefined : { state: closing.state } };
  if (!isInBuild(facts)) return facts;
  const delivering = lookupDeliveringPr(issueNumber, deps);
  // A FAILED DELIVERY LOOKUP IS NOT INCONCLUSIVE -- IT LEAVES THE ROW IN BUILD, and this is the one place
  // #2026 departs from the "fail open, a failed lookup is INCONCLUSIVE" convention the three lookups above
  // share. THE REASON IS THE DIRECTION OF THE CLAUSE: those lookups establish that a row IS in build, so an
  // unanswerable one must not manufacture a refusal. This one can only ever CLEAR a row, and it is asked
  // ONLY of rows that are already in build -- so returning `null` here would convert every refusal B2 would
  // have made into silence the moment GraphQL hiccuped, and B2's teeth would depend on the network.
  // Falling through to "nobody declared a delivery" is exactly the answer this rule gave before #2026: a
  // new clause must not change the rule's behaviour under failure.
  //
  // FOUND BY FOUR REDS OUTSIDE THIS ROW'S REGION rather than reasoned out in advance:
  // `row-claim-session-eligibility.test.ts` routes every `api graphql` call to one
  // `closedByPullRequestsReferences` payload, so the new query read `undefined` and threw, and four tests
  // that assert a refusal went quiet. The fakes were right and the failure direction was wrong.
  if (delivering === null || delivering === undefined) return facts;
  return { ...facts, deliveringPr: { state: delivering.state,
    proposesRegionPath: delivering.changedPaths.some(
      (path) => shape.declaredPaths.some((entry) => regionCovers(entry, path))) } };
}
