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
// FOUND VIA `closedByPullRequestsReferences`, THE REVERSE OF `merge-guard.mjs`'s OWN `closingIssuesReferences`
// -- not a `session:*` label on the PR (that label is a manual HOLD, applied by `pr:hold`, and most open
// PRs never carry one) and not a branch-name convention (not every branch encodes its issue number). The
// one fact this whole fleet can rely on is which issue a PR's own `Closes #N` resolves, because GitHub
// computes it server-side. So: find the OTHER issues `mySession` currently holds (`in-progress` +
// `session:<name>`, excluding the row being claimed right now), and ask GitHub which PR would close each.
import { REPO } from "../../../../scripts/repo-identity.mjs";
import { gh, lookup } from "../merge-guard/lookups.mjs";
import { declaredRegionFiles } from "../region-paths.mjs";

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
 * @typedef {{ number: number, declaresPaths: boolean, subIssues: number,
 *             closingPr: { state: "OPEN" | "MERGED" | "CLOSED" } | undefined }} RowFacts
 */

/**
 * Is this row IN BUILD -- does somebody still owe a commit for it? See the file header for each clause and
 * what it is read from.
 * @param {RowFacts} row @returns {boolean}
 */
export function isInBuild(row) {
  if (row.closingPr && row.closingPr.state !== "CLOSED") return false; // proposed, or delivered
  if (!row.declaresPaths) return false;                                // its deliverable is not a commit
  if (row.subIssues > 0) return false;                                 // a parent: its sub-rows owe them
  return true;
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
    + `gh api repos/${REPO}/issues/${inBuild.number}/sub_issues -F sub_issue_id=<id>\` and this refusal lifts.`;
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
 * What a row declares and whether anyone owes a commit for it -- the two readings the header names, each a
 * property of the tracker rather than a label. `null` on a failed lookup, never a guess.
 *
 * @param {number} issueNumber
 * @param {{ run?: (args: string[]) => string }} [deps]
 * @returns {{ declaresPaths: boolean, subIssues: number } | null}
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
    return { declaresPaths: declared.length > 0, subIssues: Array.isArray(subs) ? subs.length : 0 };
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
    const closing = lookupClosingPrHealth(issueNumber, deps);
    if (closing === null) return null; // a failed lookup partway through is INCONCLUSIVE
    const shape = lookupRowShape(issueNumber, deps);
    if (shape === null) return null;
    rows.push({ number: issueNumber, declaresPaths: shape.declaresPaths, subIssues: shape.subIssues,
      closingPr: closing === undefined ? undefined : { state: closing.state } });
  }
  return rows;
}
