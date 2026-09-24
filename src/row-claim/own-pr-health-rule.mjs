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

// #2126: AN UNANSWERED REFUSAL IS WORK NEEDING THIS SESSION'S ACTION, AND THAT IS WHAT B2 CAPS.
//
// #989's decision is NOT reversed and nothing below reverses it: one pull request awaiting review plus one
// new row stays legal, because waiting on a reviewer is not work. The gap is narrower -- a pull request
// whose reviewer HAS ASKED FOR CHANGES is not waiting on anybody but its author, and until this clause
// nothing counted it. Measured 2026-09-23: #2107 carried a `not convinced` from 10:37:46Z with no author
// response at all, and its own session was free to claim a fresh row.
//
// THE OBVIOUS DISCRIMINATOR IS DEFEATED BY A BOT, WHICH IS WHY IT IS NOT THE ONE USED. "Refuse while a
// not-convinced verdict stands AT THE CURRENT HEAD" would have caught neither measured case: #2107's
// verdict landed on `dfe72936` and the freshness sweep moved the head four times in half an hour --
// `787aecd4`, `5a9981d0`, `d45c1b00`, `6541b1ee` -- every one an automated `Merge branch 'main'` and ZERO
// author commits. A guard keyed on head identity is cleared automatically, by a bot, minutes after the
// refusal it was meant to hold.
//
// SO THE DISCRIMINATOR IS `reviewDecision`. It reads `CHANGES_REQUESTED` after all those merge commits
// precisely because `dismiss_stale_reviews` is false, so a refusal OUTLIVES the head it was posted on.
// One field, immune to merge noise, no heuristic about which commits "count", already populated by
// GitHub. (Not the repo's first reader of it: `packages/lab/src/packaging/branch-protection.test.ts`
// reads it too, and #2084's subject is that same outliving -- whichever lands second reuses the first's
// reader rather than adding a third.)
//
// THE ESCAPE IS NOT OPTIONAL, and the case that forced it is measured. #2105 carried, 57 seconds apart at
// the IDENTICAL commit `e1b8b7bc`, an APPROVED from `reviewer-2` and a CHANGES_REQUESTED from `reviewer`.
// Its author was handed an approval and a rejection of the same code inside a minute; walking away was
// close to rational, and a rule that encoded it as indiscipline would be wrong. So where a pull request
// carries contradictory verdicts at its current head the claim is NOT refused: it proceeds, and the row
// is labelled `answer:ceo` with the dispute written on it (`escalateDisputeToCeo`). A guard with no exit
// for a dispute converts a review disagreement into a stalled engineer, which is worse than what this
// clause fixes.
//
// WHO POSTED A VERDICT CANNOT BE READ FROM `author.login`, AND THIS IS THE PART THAT SURPRISED ME.
// Measured on #2105's five reviews: EVERY ONE is authored by `a11ign-bot`. `reviewer` and `reviewer-2`
// are org sessions sharing one GitHub identity, so GitHub itself sees one reviewer, keeps only the latest
// review per account in `latestReviews`, and a dispute detector keyed on the login would find none --
// defeated exactly the way the head-identity discriminator is. The reviewer's name lives in the review
// BODY, in this repo's own `, by <name>:` convention, and `reviewVerdict` (#1259) is already its parser.
// That is why the dispute read goes through `reviews`, not `latestReviews`, and through that parser
// rather than through `author`.

// FOUND VIA `closedByPullRequestsReferences`, THE REVERSE OF `merge-guard.mjs`'s OWN `closingIssuesReferences`
// -- not a `session:*` label on the PR (that label is a manual HOLD, applied by `pr:hold`, and most open
// PRs never carry one) and not a branch-name convention (not every branch encodes its issue number). The
// one fact this whole fleet can rely on is which issue a PR's own `Closes #N` resolves, because GitHub
// computes it server-side. So: find the OTHER issues `mySession` currently holds (`in-progress` +
// `session:<name>`, excluding the row being claimed right now), and ask GitHub which PR would close each.
import { REPO } from "../../../../scripts/repo-identity.mjs";
import { gh, lookup } from "../merge-guard/lookups.mjs";
import { declaredRegionFiles, regionCovers } from "../region-paths.mjs";
// #2126: the reviewer NAME is parsed by the tree's own verdict parser, never a second reading of the
// `, by <name>:` convention -- #1245/#1259 exist because six sessions each retyped one and two disagreed.
import { headMatches, reviewVerdict } from "../review-verdict.mjs";
// #2126: `answer:<session>` is the org's own spelling for "somebody owes this row an answer", and
// removing the label IS the act of answering -- so the escalation needs nothing else to remember it.
import { ANSWER_PREFIX } from "../waiting-condition.mjs";

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
 * #2126: ONE SIDE OF A REVIEW AT ONE HEAD -- the GitHub review state, and the org session the verdict's
 * own opener line names. `by` is `null` when the opener named nobody, never defaulted to a name.
 * @typedef {{ state: string, by: string | null }} ReviewSide
 */

/**
 * #2126: CONTRADICTORY VERDICTS AT ONE HEAD, which is the escape rather than a refusal.
 * @typedef {{ head: string, approved: ReviewSide, refused: ReviewSide }} ReviewDispute
 */

/**
 * #2126: ONE OPEN PULL REQUEST'S REVIEW HEALTH. `reviewDecision` is GitHub's own field, which outlives the
 * head it was posted on; `dispute` is `null` unless two DIFFERENT named reviewers disagree at that head.
 * #2254: `authorCommitsSinceReview` counts the NON-MERGE commits committed after the latest refusal, which
 * is what tells "nobody has answered" from "answered, waiting on a re-read". Absent reads as zero.
 * @typedef {{ number: number, head: string, reviewDecision: string | null,
 *             dispute: ReviewDispute | null, authorCommitsSinceReview?: number }} PrReviewHealth
 */

/**
 * @typedef {{ number: number, declaresPaths: boolean, subIssues: number,
 *             closingPr: { state: "OPEN" | "MERGED" | "CLOSED" } | undefined,
 *             deliveringPr?: DeliveringPr, openPrNumber?: number,
 *             openPrReview?: PrReviewHealth }} RowFacts
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
  // #2126: the SECOND thing B2 caps, and it is checked SECOND on purpose -- a population that has always
  // been refused must keep the refusal it has always been given, word for word, so nothing about the new
  // clause can move an existing verdict or an existing message.
  if (!inBuild) return unansweredRefusalReason(rows);
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

/** GitHub's two DECIDING review states. `COMMENTED`, `DISMISSED` and `PENDING` decide nothing, and the
 * split below drops them by naming these two rather than by excluding those three -- an allowlist, so a
 * review state GitHub adds tomorrow is not read as a side of a disagreement.
 *
 * A SET OF THESE TWO, FILTERED BEFORE THE SPLIT, WAS DEAD CODE AND IS GONE: it admitted exactly what the
 * split then re-selected, so mutating `COMMENTED` INTO it changed no behaviour and no test could see the
 * difference. Found by running that mutation rather than by reading the code. */
const APPROVED = "APPROVED";
const CHANGES_REQUESTED = "CHANGES_REQUESTED";

/**
 * #2126: THE PULL REQUEST OF THIS ROW'S THAT IS WAITING ON ITS AUTHOR RATHER THAN ON A REVIEWER, or `null`.
 *
 * Three conditions and each is load-bearing. The pull request must be OPEN (`openPrNumber` is only ever set
 * for an open one -- a merged or abandoned pull request is nobody's outstanding work); `reviewDecision` must
 * read `CHANGES_REQUESTED` (GitHub's own field, not a comment scan, and the one thing a bot merge cannot
 * clear); and the reviewers must NOT be in dispute at the current head, which is the escape `ceo`'s ruling
 * made non-optional rather than a hole to be closed later.
 *
 * #2254 -- THE FOURTH CONDITION, AND THE RULING IS TO LIFT THE CAP: an AUTHOR commit (not a merge) after the
 * latest refusal means the author has done the one thing the refusal asks, so the pull request is now
 * AWAITING REVIEW, which #989 says one new row may sit beside. `reviewDecision` cannot see it -- it keeps
 * reading `CHANGES_REQUESTED` until a new review lands -- so the guard was telling an author who HAD answered
 * that nobody had (#2165: #2240 answered at `c0c0e6df`, ready row #2176 unclaimed for the turn).
 *
 * WHY LIFT RATHER THAN ADD A THIRD, STILL-CAPPED STATE: a capped "answered" state would bind the session
 * until a reviewer acted, which is the stall this row measured, only with a truer sentence. And the
 * objection -- a trivial commit clears the cap without answering anything -- is real but cheap: this guard
 * meters WHICH ROW A SESSION MAY CLAIM, while `main` still requires an approving review, so a trivial commit
 * buys a second row in flight and no merge. It also corrects itself: a reviewer who re-refuses posts a
 * verdict AFTER that commit, and the count is taken from the latest refusal, so the cap returns.
 * @param {RowFacts} row @returns {PrReviewHealth | null}
 */
export function unansweredRefusal(row) {
  const review = row.openPrReview;
  if (!review) return null;
  if (review.reviewDecision !== CHANGES_REQUESTED) return null;
  if (review.dispute) return null;
  if ((review.authorCommitsSinceReview ?? 0) > 0) return null;
  return review;
}

/** A commit the sweep or a `git pull` writes rather than an author: GitHub's own default merge headlines. */
const MERGE_HEADLINE = /^Merge (?:branch|pull request|remote-tracking branch)\b/;

/**
 * #2254: HOW MANY COMMITS THE AUTHOR HAS PUSHED SINCE THE LATEST REFUSAL, merges not counted.
 *
 * THE MERGE EXCLUSION IS THE #2107 CONTROL: the freshness sweep moves the head with `Merge branch 'main'`
 * commits and ZERO author work, so counting them would reopen exactly what #2126 closed. `gh pr list`
 * gives no parent list, so a merge is recognised by its headline -- a conflict-resolving merge the AUTHOR
 * wrote is excluded too, which errs toward refusing, the safe direction.
 *
 * EVERY UNREADABLE INPUT COUNTS ZERO: no refusal with a `submittedAt`, or a commit with no `committedDate`,
 * cannot be placed on the timeline and so proves no answer. Ties are not answers either (`>`, not `>=`).
 * `gh` returns at most the first hundred commits, so a longer pull request can under-count -- also toward
 * refusing.
 * @param {{ reviews?: { state?: string, submittedAt?: string }[],
 *           commits?: { messageHeadline?: string, committedDate?: string }[] }} pr
 * @returns {number}
 */
export function authorCommitsSinceRefusal(pr) {
  const refusedAt = (pr.reviews ?? [])
    .filter((review) => review.state === CHANGES_REQUESTED)
    .map((review) => Date.parse(review.submittedAt ?? ""))
    .filter((time) => !Number.isNaN(time))
    .reduce((latest, time) => Math.max(latest, time), Number.NEGATIVE_INFINITY);
  if (refusedAt === Number.NEGATIVE_INFINITY) return 0;
  return (pr.commits ?? []).filter((commit) => !MERGE_HEADLINE.test(commit.messageHeadline ?? "")
    && Date.parse(commit.committedDate ?? "") > refusedAt).length;
}

/**
 * #2126: THE REFUSAL, WHICH NAMES THE PULL REQUEST -- because unlike a row in build, a pull request is
 * exactly where the work is, and the reader has to be able to open it.
 *
 * IT ALSO NAMES WHAT DOES NOT LIFT IT. A reader whose head has moved four times since the verdict will
 * reasonably believe the refusal is stale; saying so here is the difference between a rule that is
 * followed and one that is worked around. And it names the escape, so a genuinely disputed pull request
 * is not read as this refusal with a broken remedy -- the #1161 shape this file has paid for once.
 * @param {readonly RowFacts[]} rows @returns {string | null}
 */
function unansweredRefusalReason(rows) {
  const row = rows.find((candidate) => unansweredRefusal(candidate) !== null);
  const review = row ? unansweredRefusal(row) : null;
  if (!row || !review) return null;
  return `#${row.number}'s pull request #${review.number} carries an UNANSWERED REFUSAL: its `
    + `\`reviewDecision\` reads ${CHANGES_REQUESTED}, so a reviewer has asked for changes and nobody has `
    + "answered. That is work needing YOUR action rather than a row waiting on a reviewer, and B2 caps work "
    + "needing action -- not open pull requests (#2126). #989 is unchanged: one pull request AWAITING "
    + `REVIEW plus one new row is still legal.\n  Answer #${review.number} -- push a commit of your own, and `
    + "have the verdict re-read -- before claiming another row. A commit YOU push after the verdict lifts "
    + "this refusal at once (#2254: answered and waiting on a re-read is awaiting review, which is legal); "
    + "a reply with no commit does not.\n"
    + "  A BOT MERGE DOES NOT LIFT THIS, and a guard keyed on the head would have been decorative: "
    + "`dismiss_stale_reviews` is false, so `reviewDecision` outlives every automatic `Merge branch "
    + "'main'` the freshness sweep makes. Measured on #2107, whose 10:37:46Z refusal at `dfe72936` survived "
    + "four such commits and the head move to `6541b1ee` with ZERO author commits.\n"
    + `  If two reviewers DISAGREE at #${review.number}'s current head this refusal does not apply at all: `
    + `the claim proceeds and #${row.number} is labelled \`${ANSWER_PREFIX}ceo\` instead, because a guard `
    + "with no exit for a dispute converts a review disagreement into a stalled engineer.";
}

/**
 * #2126: CONTRADICTORY VERDICTS AT THE PULL REQUEST'S CURRENT HEAD, or `null`.
 *
 * READ FROM `reviews` AND NOT `latestReviews`, and from the review BODY and not `author.login`. Measured on
 * #2105's five reviews: every one is authored by `a11ign-bot`, because `reviewer` and `reviewer-2` are org
 * sessions sharing one GitHub identity. GitHub therefore sees ONE reviewer, keeps only that account's most
 * recent review in `latestReviews`, and a detector keyed on the login would find no dispute at all -- the
 * same way the head-identity discriminator is defeated by a bot. The name lives in the verdict's own
 * `, by <name>:` opener, which `reviewVerdict` already parses.
 *
 * AN UNATTRIBUTED PAIR IS NOT A DISPUTE, deliberately. Two opposing verdicts at one head with no name on
 * either cannot be told from ONE reviewer reversing themselves -- and a reversal is an ordinary unanswered
 * refusal, whose latest word GitHub has already folded into `reviewDecision`. Reading it as a dispute would
 * let any reviewer who changed their mind at the same head wave the guard through.
 *
 * AND A NAME'S SUPERSEDED VERDICT IS NOT A SIDE OF ONE EITHER -- `reviewer`'s blocker at `00d34048`, and
 * the one case the reversal test above could not see. That test has only ONE reviewer, so a reversal
 * leaves nothing to pair with; put a SECOND reviewer in the same head and the two rules collide.
 * `reviewer-2` APPROVED, then `reviewer-2` CHANGES_REQUESTED, then `reviewer` CHANGES_REQUESTED: both
 * reviewers now refuse and `reviewDecision` reads `CHANGES_REQUESTED`, but the dead `reviewer-2` approval
 * still paired with `reviewer`'s refusal, so the claim was WAVED THROUGH and escalated to `ceo` as a
 * disagreement that had already resolved itself. The direction of that error is the bad one: a guard whose
 * whole job is to refuse work needing action, declining to refuse, and sending `ceo` a dispute to rule on
 * that nobody is having. So each name is reduced to its LATEST verdict before the pairing.
 *
 * ORDER COMES FROM `submittedAt`, WITH THE ARRAY AS THE FALLBACK. `gh pr list --json reviews` returns the
 * whole review object, `submittedAt` included, oldest first -- but "latest" is a claim about time and
 * reading it off array position alone would be a silent dependence on an ordering nothing in this file
 * asserts. When every review at the head carries a stamp they are sorted by it; when any does not, the
 * caller's order stands, which is what a hand-built fixture supplies.
 *
 * A `COMMENTED` OR `DISMISSED` REVIEW SUPERSEDES NOTHING, because only verdicts are collapsed. GitHub
 * does not let running commentary clear an approval out of `reviewDecision` and neither does this: an
 * `APPROVED` followed by that same name's `COMMENTED` is still an approval, and still a live side.
 *
 * @param {{ headRefOid?: string,
 *           reviews?: { state?: string, body?: string, submittedAt?: string,
 *                       commit?: { oid?: string } }[] }} pr
 * @returns {ReviewDispute | null}
 */
export function disputeAtHead(pr) {
  const head = pr.headRefOid ?? "";
  const named = oldestFirst((pr.reviews ?? [])
    .filter((review) => headMatches(review.commit?.oid ?? null, head)))
    .map((review) => ({ state: /** @type {string} */ (review.state),
      by: reviewVerdict(review.body ?? "").author }))
    // AN UNNAMED SIDE IS DROPPED BEFORE THE PAIRING, not compared as `null`: one named verdict against one
    // unattributed one would otherwise pair (`"reviewer" !== null`) and read as two reviewers, when it may
    // be the same one writing twice. Dropping it here is what makes the pairing below a claim about two
    // KNOWN and DIFFERENT names.
    .filter((side) => side.by !== null)
    .filter((side) => side.state === APPROVED || side.state === CHANGES_REQUESTED);
  // ONE VERDICT PER NAME, THE LATEST. A `Map` keyed on the name overwrites in place, so the last verdict
  // each reviewer left at this head is the only one that can be a side below.
  const current = [...new Map(named.map((side) => [side.by, side])).values()];
  const approvals = current.filter((side) => side.state === APPROVED);
  const refusals = current.filter((side) => side.state === CHANGES_REQUESTED);
  const pairs = approvals.flatMap((approved) => refusals
    .filter((refused) => refused.by !== approved.by)
    .map((refused) => ({ approved, refused })));
  return pairs.length === 0 ? null : { head, ...pairs[0] };
}

/**
 * Reviews oldest first: by `submittedAt` when every one carries it, otherwise exactly as given.
 *
 * The fallback is not a shrug. A fixture that omits the stamp is asserting an ORDER rather than a time,
 * and re-sorting it by an absent field would silently reorder it; a live payload always has the field.
 * @template {{ submittedAt?: string }} T @param {T[]} reviews @returns {T[]}
 */
function oldestFirst(reviews) {
  if (!reviews.every((review) => typeof review.submittedAt === "string" && review.submittedAt !== "")) {
    return reviews;
  }
  return [...reviews].sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)));
}

/**
 * #2126: HOW MANY OPEN PULL REQUESTS ONE REVIEW-HEALTH READ TAKES. `gh pr list` defaults to THIRTY, which
 * is a window nobody can see -- a session's own pull request falling past it would read as "no refusal" and
 * the clause would go quiet exactly when the queue is busiest.
 *
 * THE READINGS ARE READINGS, AND `reviewer` was right to say so at `00d34048`: 7 open at 2026-09-23T12:20Z
 * when this was written, 16 when the review ran, 10 at 2026-09-23T14:15Z. It is a queue and it moves; what
 * does not move is that 200 is orders past anything this repository has carried, and that `row-claim`
 * already reads every open pull request once for B4's file overlap, so this read costs no extra call.
 */
export const OPEN_PR_LIMIT = 200;

/**
 * #2126: HOW MUCH OF A SHA A MESSAGE PRINTS. Eight, because that is what this repository's review
 * convention writes (`packages/agent-org/docs/roles/reviewer.md`: a verdict matching ``at `<head8>` ``), so a
 * reader can match the refusal against the verdict without re-deriving anything.
 */
const HEAD_DISPLAY_CHARS = 8;

/**
 * #2126: EVERY OPEN PULL REQUEST'S REVIEW HEALTH, IN **ONE** CALL -- never one per held row.
 *
 * That is the shape the row asked for by name: #989 took two network calls per held row OUT of this path
 * when it dropped the colour read, and a clause that put one back per row would undo the measurement that
 * justified it. One repo-wide read costs the same whether the session holds one row or five, and mirrors
 * `lookupOpenPrFiles`, which B4 already drives exactly this way.
 *
 * `null` on a failed lookup, the convention every lookup in this file shares.
 * @param {{ run?: (args: string[]) => string }} [deps]
 * @returns {PrReviewHealth[] | null}
 */
export function lookupOpenPrReviewHealth({ run = gh } = {}) {
  return lookup(() => {
    const raw = run(["pr", "list", "--repo", REPO, "--state", "open", "--limit", String(OPEN_PR_LIMIT),
      "--json", "number,headRefOid,reviewDecision,reviews,commits"]);
    /** @type {{ number: number, headRefOid?: string, reviewDecision?: string | null,
     *           reviews?: { state?: string, body?: string, submittedAt?: string,
     *                       commit?: { oid?: string } }[],
     *           commits?: { messageHeadline?: string, committedDate?: string }[] }[]} */
    const parsed = JSON.parse(raw);
    return parsed.map((pr) => ({ number: pr.number, head: pr.headRefOid ?? "",
      reviewDecision: pr.reviewDecision ?? null, dispute: disputeAtHead(pr),
      authorCommitsSinceReview: authorCommitsSinceRefusal(pr) }));
  });
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
  return withReviewHealth(rows, deps);
}

/**
 * #2126: THE REVIEW-HEALTH READ, AND THE TWO CONDITIONS UNDER WHICH IT DOES NOT HAPPEN AT ALL.
 *
 * NOT MADE when no held row has an OPEN pull request -- which is the case for every row that is in build,
 * by definition, so the refusal B2 has always made still costs exactly the calls it always did. That is
 * behaviour rather than thrift: `row-claim-session-eligibility.test.ts` pins that a row in build is
 * reported WITHOUT B4's `pr list` round trip, and this read is a `pr list` too.
 *
 * A FAILED READ CLEARS NOTHING AND REFUSES NOTHING. This clause can only ever CREATE a refusal, so an
 * unanswerable read must not manufacture one -- the same reasoning `rowFactsFor`'s delivery clause states
 * in the opposite direction for the opposite reason. B2's existing teeth do not depend on this call.
 *
 * @param {RowFacts[]} rows @param {{ run?: (args: string[]) => string }} deps
 * @returns {RowFacts[]}
 */
function withReviewHealth(rows, deps) {
  if (!rows.some((row) => row.openPrNumber !== undefined)) return rows;
  const health = lookupOpenPrReviewHealth(deps);
  if (health === null) return rows;
  const byNumber = new Map(health.map((pr) => [pr.number, pr]));
  const reviewed = rows.map((row) => {
    const review = row.openPrNumber === undefined ? undefined : byNumber.get(row.openPrNumber);
    return review === undefined ? row : { ...row, openPrReview: review };
  });
  for (const row of reviewed) escalateDisputeToCeo(row, deps);
  return reviewed;
}

/**
 * #2126: THE ESCAPE'S OTHER HALF -- a dispute that is waved through SILENTLY is not an escape, it is a
 * hole. The chairman's 2026-09-19 direction is the rule being followed here: a conclusion that changes what
 * should happen next goes in a FIELD, not a comment, because the org can act on what GitHub records and
 * cannot act on anything a session merely learns. So the label is the escalation and the comment is only
 * its reasoning.
 *
 * THE ONE WRITE IN THIS FILE, and it is deliberate that it sits beside a read. The moment the claim guard
 * discovers the dispute is the only moment anything in this org is looking at it; deferring the write to a
 * caller would mean the caller had to be taught about a state it never asks about.
 *
 * IDEMPOTENT, because a claim may drive this twice (`sessionEligibilityReason`, then the `--blocked-by`
 * path): the row's existing labels are read first and a row already awaiting `ceo` is left exactly as it
 * is. A FAILED WRITE NEVER FAILS THE CLAIM -- it is reported on stderr with the dispute in full, so the
 * session can put the label on by hand, which is the one thing a swallowed error would have cost.
 *
 * @param {RowFacts} row
 * @param {{ run?: (args: string[]) => string, log?: (line: string) => void }} [deps]
 * @returns {boolean} whether the label was written by THIS call
 */
export function escalateDisputeToCeo(row, { run = gh, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const review = row.openPrReview;
  const dispute = review?.dispute;
  if (!review || !dispute) return false;
  const label = `${ANSWER_PREFIX}ceo`;
  try {
    if (alreadyLabelled(row.number, label, run)) return false;
    run(["label", "create", label, "--repo", REPO, "--force"]);
    run(["issue", "edit", String(row.number), "--repo", REPO, "--add-label", label]);
    run(["issue", "comment", String(row.number), "--repo", REPO,
      "--body", disputeComment(row.number, review, dispute)]);
    log(`row-claim: #${review.number} carries OPPOSITE verdicts at \`${dispute.head.slice(0, HEAD_DISPLAY_CHARS)}\` `
      + `(\`${dispute.approved.by}\` approved, \`${dispute.refused.by}\` asked for changes), so the claim `
      + `is NOT refused and #${row.number} now carries \`${label}\` (#2126).`);
    return true;
  } catch (error) {
    log(`row-claim: could not label #${row.number} \`${label}\` for the review dispute on #${review.number} `
      + `at \`${dispute.head.slice(0, HEAD_DISPLAY_CHARS)}\` (${/** @type {Error} */ (error).message}). The claim still `
      + `proceeds; put \`${label}\` on #${row.number} by hand so ceo can see it.`);
    return false;
  }
}

/**
 * Whether a row already carries `label` -- ONE read, made only on the dispute path, so the common claim
 * pays nothing for it. Throws on a failure rather than reading as "not labelled", which would re-post the
 * dispute comment on every claim.
 * @param {number} issueNumber @param {string} label @param {(args: string[]) => string} run
 * @returns {boolean}
 */
function alreadyLabelled(issueNumber, label, run) {
  const raw = run(["issue", "view", String(issueNumber), "--repo", REPO, "--json", "labels"]);
  /** @type {{ labels?: { name?: string }[] }} */
  const parsed = JSON.parse(raw);
  return (parsed.labels ?? []).some((entry) => entry?.name === label);
}

/**
 * #2126: THE DISPUTE, WRITTEN WHERE `ceo` READS IT. Names both verdicts, the head they share, and the
 * ruling's own sentence -- because the next reader's first question is whether the guard is broken, and the
 * answer is that it is doing exactly what it was told to do.
 * @param {number} issueNumber @param {PrReviewHealth} review @param {ReviewDispute} dispute
 * @returns {string}
 */
function disputeComment(issueNumber, review, dispute) {
  return `**Two reviewers reached OPPOSITE verdicts on #${review.number} at the same head \``
    + `${dispute.head.slice(0, HEAD_DISPLAY_CHARS)}\`.** \`${dispute.approved.by}\` approved it; \`${dispute.refused.by}\` `
    + `asked for changes.\n\nB2's review-health clause (#2126) therefore did NOT refuse this session a fresh `
    + `claim, and #${issueNumber} carries \`${ANSWER_PREFIX}ceo\` instead: the guard cannot tell which `
    + "verdict stands and the ruling is explicit that it must not try -- *\"a guard with no exit for a "
    + "dispute converts a review disagreement into a stalled engineer, which is worse than what this row "
    + "fixes.\"*\n\n`ceo` rules which verdict stands; **removing this label is the act of answering**.\n\n"
    + "*Written by `row-claim`, not by hand.*";
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
    closingPr: closing === undefined ? undefined : { state: closing.state },
    // #2126: the NUMBER of the open pull request, kept at row level rather than inside `closingPr`, so the
    // two shapes `row-claim-own-pr-health-rule.test.ts` compares whole (`deliveringPr`) keep their exact
    // keys. Undefined whenever no pull request of this row's is open -- which includes every row in build.
    openPrNumber: openPrNumberOf(closing, undefined) };
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
  return { ...facts, openPrNumber: openPrNumberOf(closing, delivering),
    deliveringPr: { state: delivering.state,
      proposesRegionPath: delivering.changedPaths.some(
        (path) => shape.declaredPaths.some((entry) => regionCovers(entry, path))) } };
}

/**
 * #2126: WHICH PULL REQUEST OF THIS ROW'S IS STILL OPEN -- the one whose review health decides whether the
 * row is work needing this session's action. Only an OPEN one qualifies: a merged pull request is delivered
 * and a closed one is abandoned, and neither is outstanding work whatever its last verdict said.
 *
 * The closing pull request wins over a declared delivery when both are open, because `Closes:` is GitHub's
 * own resolution and `Delivers:` is a body field this repository parses -- the stronger fact first. In
 * practice a row has at most one, since `Delivers:` exists precisely for rows whose pull request must say
 * `Closes: none`.
 *
 * @param {{ number: number, state: string } | undefined} closing
 * @param {{ number: number, state: string } | undefined} delivering
 * @returns {number | undefined}
 */
function openPrNumberOf(closing, delivering) {
  if (closing && closing.state === "OPEN") return closing.number;
  if (delivering && delivering.state === "OPEN") return delivering.number;
  return undefined;
}
