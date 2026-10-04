// no-token: MAX_ROW_ORDERS_PER_TICK -- #827. Importing anything from `work-gate.mjs` reaches `defaultRun`
// (`execFileSync("gh", ...)`, work-gate.mjs:162), and this file never lets it run: every seam here is
// handed an injected `run`. Measured 2026-09-23 -- 173/173 pass with `gh` off `PATH` entirely and
// `GH_TOKEN`/`GITHUB_TOKEN`/`GH_CONFIG_DIR` unset, which is what makes this a verified claim rather than
// a hopeful one. Without it the acceptance job refuses the row's own declared command and verifies
// NOTHING (#2106 hit exactly that).
/**
 * #912: THE TICK IS A SCRIPT, AND THESE ARE THE ANSWERS IT MUST NOT GET WRONG.
 *
 * Six sessions each held a standing cron and woke every 10-30 minutes to ask a question one API call
 * answers -- 672 model turns a day, most finding nothing, which exhausted a weekly allowance in three
 * days. `work-gate.mjs` is that question, asked for free. So the failures that matter here are the ones
 * that would either put the org back to sleep or wake all of it:
 *
 * A REFUSED READ MUST NEVER READ AS QUIET. Both readers return `null` for a refusal and never `[]`
 * (#1286's rule, and its reason: a refused `gh` exits non-zero with EMPTY stdout, so `[]` reports "nothing
 * is queued" and the org acts on it). The positive control is that an empty queue still returns `[]` and
 * still means quiet -- a reader answering `refused` whenever unsure blocks every quiet morning.
 *
 * AND THE POSITIVES ARE NOT OPTIONAL, for `review-verdict.test.ts`'s reason one level up: a `decide` that
 * returned `[]` for everything satisfies every "no order" case perfectly and would wake nobody, ever.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, realpathSync,
  existsSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { shippedUnits } from "../host-units.mjs";
import { HOME_CHECKOUT } from "../project-config.mjs";
import { TOOL_ROOT, copyToolAndProject, importClosure, toolFile } from "./copied-tool-fixture.ts";
import { judgePin, type Declaration } from "../lib/pin-ratchet.mjs";
import { deriveClosureRequirements } from "../acceptance-commands.mjs";
import { patchIdOfDiff } from "../review-verdict.mjs";
import { MAX_ROW_ORDERS_PER_TICK, readCommitShas, readPatchId, withPatchIds, decide, checksSettledGreen, readPrs, readReadyRows, EXIT, CAUSES,
  comparablePrFiles, START_CAUSES, draining, DRAIN_MARKER, stalledOrder, performActions,
  blockingChecks, anyChecksRed, requiredCheckNames, readBaseTip, baseTipWhenRed, ownerOf, NOT_PICKABLE, NOT_STARTABLE,
  ROUTED_TO, readPromotableRows, GH_READS, partitionUnclaimed, openRowState, waitingBreakdown,
  deadMansSwitch, hostDriftOrders, JUDGMENT_CAUSES,
  shouldBeMerging as shouldBeMergingPrs, conflictedPrs, conflictStateOf, mergeConflictOrders,
  unfiledEpics, epicOrders, finishedEpics, finishedEpicOrders, fleetBatchRows, fleetBatchOrders,
  partitionFleetBatch, FLEET_GATED_SELECTOR, blockersFromRows, blockerClearedOrders, unclaimedBlockerClearedOrders, unclaimedClearings,
  anyBlockerClearingCandidate,
  promotionAskWindow, readRecentlyClosed, PROMOTION_ASK_OFFSETS_MS,
  PROMOTION_ASK_PERIOD_MS, PROMOTION_ASK_WINDOW_MS, HOUR_MS,
  claimedRowAmendedOrders, constraintsAfterClaim, amendmentsOn, readClaimedRowComments,
  CONSTRAINT_COMMENT_MARKER, CONSTRAINT_BODY_PREFIX,
  readEpics, answersOwed, answerOrders,
  readOpenRows, withAnswerLabel, rowsOwingAnswers, readClosedAnswerRows, withoutEndedAnswerSessions, endedSessionLabels,
  withEndedLabels, withPrOwners, ownerOfPr,
  blockedWithoutReferent, blockedReferentOrders, CHAIRMAN_LABEL, PARKED_LABEL,
  ANSWER_PREFIX, redOnlyBySupersededRun, cannotAskReport,
  readRowBranches, readWorktreeStamps, rowBranchOrders, GIT_READS,
  reviewStateOf, reviewBlocked, reviewBlockedOrders, REVIEW_STATE, HOLD_RED_JOBS, reviewableHead,
  readRowsOffBoard, rowsOffBoard, rowOffBoardOrders, rowsOffBoardOrSay, ROW_OFF_BOARD_GRACE_MS,
  refusedReadCount, SHARED_OUTAGE_READS, sharedReadOutage, markOutageReads,
  pipelineCodeownerReviewMissing, bareAnswerLabelOrders, readRowTimeline }
  from "../work-gate.mjs";
import { SESSION_PREFIX } from "../project-vocabulary.mjs";
// #2182: the SHIPPED reader that decides whether a delivered cause is still live, imported so this file
// can assert what the membership BUYS rather than only that the name is in the list. `wake.mjs` runs
// nothing on import (its `main()` is behind an `import.meta.url` guard) and these three are pure, so this
// costs the `no-token` promise at the top of this file nothing.
import { readLedger, undelivered, addressed, WAKE_TTL_MS, JUDGMENT_TTL_MS, deliver, escalateStuck,
  MAX_DELIVERIES, deliveryCounts } from "../wake.mjs";
// #2237: the decider that REFUSES a launch, so the order's named launch directory is checked against it
// rather than read by a reviewer. Pure over an injected filesystem.
import { primaryLaunchRefusal, launchCheckoutOf }
  from "../board-snapshot-scope.mjs";

// Each check carries a NAME because the caller narrows with newestPerName, which keys on it -- a fixture
// without one is dropped, and the gate would read every PR as having no checks at all.
import { closesUnresolvedOrders, closesUnresolvedPrs, primaryStaleOrders, withStalePrimaryNotice } from "../work-gate.mjs";
const GREEN = [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
const RED = [{ name: "ci", status: "COMPLETED", conclusion: "FAILURE" }];
const PENDING = [{ name: "ci", status: "IN_PROGRESS", conclusion: null }];
const HEAD = "abc12345deadbeefcafe000011112222";

/** @param n PR number @param rollup its checks @param comments its comments */
function draft(n: number, rollup: unknown[], comments: { body: string }[] = []) {
  return { number: n, isDraft: true, headRefOid: HEAD, statusCheckRollup: rollup,
    author: { login: "worker-judge" }, comments, labels: [] };
}

test("#912: a settled green draft with no verdict wakes its parity reviewer -- and nothing else does", () => {
  // THE POSITIVE, first: without this the rest is satisfied by a function that never emits anything.
  const orders = decide({ prs: [draft(1, GREEN), draft(2, GREEN)], readyRows: [] });
  assert.deepEqual(orders.map((o) => o.session), ["reviewer-1", "reviewer-2"],
    "PR n's reviewer is `reviewer-<n>` (#2401); the odd/even split is retired");
  assert.equal(orders[0].cause, "draft-awaiting-verdict");
  assert.ok(CAUSES.includes(orders[0].cause), "every emitted cause is declared in CAUSES");

  // A RED DRAFT IS THE AUTHOR'S WORK, and this file said so in this very comment while asserting that it
  // woke NOBODY -- which is how #1650 sat BLOCKED on a failing changeset with its own session idle. What
  // must not happen is waking a REVIEWER: that spends the org's most expensive turn (worktree, acceptance
  // command, re-derived numbers, mutation) on a head the author is still moving. The author being woken
  // is the comment's own conclusion, finally acted on.
  const red = decide({ prs: [draft(3, RED)], readyRows: [] });
  assert.deepEqual(red.map((o) => o.cause), ["pr-checks-failing"], "a red draft is its author's to fix");
  assert.ok(!red.some((o) => o.session.startsWith("reviewer")), "and no reviewer is spent on a red head");

  // PENDING IS NOT GREEN AND NOT RED: unknowable yet, so ask again next tick rather than wake onto a
  // moving head.
  assert.equal(decide({ prs: [draft(5, PENDING)], readyRows: [] }).length, 0, "a pending draft wakes nobody");
  assert.equal(checksSettledGreen(PENDING), null, "pending is neither, and says so");
  assert.equal(checksSettledGreen([]), null, "no checks at all is neither");
  assert.equal(checksSettledGreen(GREEN), true);
  assert.equal(checksSettledGreen(RED), false);

  // A NON-DRAFT IS NO LONGER SKIPPED (#2176). This line used to assert 0 -- "already armed, `reviewer.md`
  // skips it" -- which is how a pull request that opened READY sat `CHANGES_REQUESTED` for 5h47m with the
  // gate silent. Arming is not review: main requires an approving review (#2022). The full positive and
  // negative halves are in the #2176 tests below.
  assert.equal(decide({ prs: [{ ...draft(11, GREEN), isDraft: false }], readyRows: [] }).length, 1);
});

test("#912: a verdict settles its own head and no other", () => {
  // WHAT A SETTLED VERDICT SETTLES IS THE *REVIEWER'S* QUESTION, and that is all it ever settled. This
  // asserted `length === 0` until 2026-09-17, which read "verdict present, therefore nothing to do" --
  // and #1640 and #1634 sat green, convinced and undrafted for three days while the gate agreed with it.
  // The reviewer must not be re-woken; the PR still has a next step, and it belongs to someone else.
  const at = [{ body: "Review of #7 at `abc12345`, by `reviewer`: convinced." }];
  const settled = decide({ prs: [draft(7, GREEN, at)], readyRows: [] });
  assert.deepEqual(settled.map((o: { cause: string }) => o.cause), ["draft-convinced-not-ready"],
    "a verdict at THIS head settles the REVIEW, and hands the draft on to be promoted");
  assert.ok(!settled.some((o: { session: string }) => o.session.startsWith("reviewer")),
    "no reviewer may be re-woken for a head they have already answered");

  // THE STALE-HEAD CASE IS THE ONE THAT STALLS A PR. `reviewer.md`: "A PR you reviewed earlier whose head
  // has moved since is not done" -- the author answered, and the new head needs its own verdict.
  const stale = [{ body: "Review of #9 at `deadbeef`, by `reviewer`: convinced." }];
  assert.equal(decide({ prs: [draft(9, GREEN, stale)], readyRows: [] }).length, 1,
    "a verdict at a PREVIOUS head does not settle the current one");

  // UNCONVINCED IS A REFUSAL, and a refusal is still a verdict: the draft is the author's again, not the
  // reviewer's. Reading it as an approval was the #1245 failure; reading it as ABSENT re-wakes forever.
  const refused = [{ body: "Review of #13 at `abc12345`, by `reviewer`: UNCONVINCED" }];
  const answered = decide({ prs: [draft(13, GREEN, refused)], readyRows: [] });
  assert.deepEqual(answered.map((o: { cause: string }) => o.cause), ["verdict-not-convinced"],
    "a refusal is the author's to answer -- it is not nothing, which is how #1630 stalled");
  assert.ok(!answered.some((o: { session: string }) => o.session.startsWith("reviewer")),
    "and the reviewer who refused is not asked again");
});

/**
 * A REFUSED VERDICT GOES TO THE SESSION THE PULL REQUEST NAMES.
 *
 * Measured 2026-09-22 (#2001): 108 undelivered `product-manager` orders in 90 minutes, while the two
 * stalled PRs in the queue were one of each shape -- #1968 carried no `session:` label and #1957 carried
 * `session:worker-tooling`, whose refusal named a surviving mutant at a `file:line`. There was nothing in
 * the second to adjudicate, and it was hand-routed to its owner on the PR.
 *
 * BOTH HALVES ARE LOAD-BEARING. Changing the `session` and leaving the `causeKey` prefixed
 * `product-manager/` keys two sessions' orders to one dedupe string, so the second is swallowed as a
 * repeat -- the failure this file's whole design (the wake ledger) is built around, and one that no
 * assertion on `session` alone can see.
 */
test("#2001: a NOT CONVINCED verdict is routed by the PR's own session label, causeKey included", () => {
  const refused = [{ body: "Review of #13 at `abc12345`, by `reviewer`: not convinced." }];
  const owned = { ...draft(13, GREEN, refused), labels: [{ name: "session:worker-tooling" }] };
  const [order] = decide({ prs: [owned], readyRows: [] }) as { cause: string, session: string,
    causeKey: string, prompt: string }[];
  assert.equal(order.cause, "verdict-not-convinced");
  assert.equal(order.session, "worker-tooling", "the gate holds the label already -- it does not send "
    + "product-manager to go and read it");
  assert.equal(order.causeKey, "worker-tooling/verdict-not-convinced/pr-13/abc12345",
    "the dedupe key names the session it is delivered to, or the ledger swallows the next one");

  // THE DECISION SEAM SURVIVES THE ROUTING. Asking an author to "decide whether it stands" is asking
  // them to adjudicate a refusal of their own work; the escalation is what goes to product-manager.
  assert.doesNotMatch(order.prompt, /decide whether it stands/,
    "the owner reworks by default -- adjudicating their own refusal is not their call");
  assert.match(order.prompt, /DISPUTE/, "and disputing it is the named escalation");
  assert.match(order.prompt, /product-manager decides/, "which still lands on the queue's first reader");
});

test("#2001/#2941: a NOT CONVINCED verdict on a PR NOBODY owns goes to ceo, the last rung, and says so", () => {
  // THE NEGATIVE CONTROL, and not a formality: with no label, no row, no branch and no stamp there is nobody to route to.
  // It was `product-manager`, who does not fix code (#2941); the last answer is `ceo`. The prompt is pinned WORD FOR WORD
  // because a branch that quietly rewrote this one would pass a looser assertion.
  const refused = [{ body: "Review of #13 at `abc12345`, by `reviewer`: not convinced." }];
  const [order] = decide({ prs: [draft(13, GREEN, refused)], readyRows: [] }) as { session: string,
    causeKey: string, prompt: string }[];
  assert.equal(order.session, "ceo");
  assert.equal(order.causeKey, "ceo/verdict-not-convinced/pr-13/abc12345");
  assert.equal(order.prompt, "#13 at `abc12345` carries a NOT CONVINCED verdict from reviewer and NOBODY COULD BE NAMED "
    + "as its owner (no session label, no live session holding a row it closes, its branch names or stamped its worktree). "
    + "You are the last answer: read the verdict, route the rework to the session that should do it "
    + "(`session:<name>` on the PR), or close the PR if the work was abandoned.");
});

test("#912: a claimed row is not work, and an unclaimed one names no session", () => {
  const rows = [{ number: 20, labels: [{ name: "ready" }] },
    { number: 21, labels: [{ name: "ready" }, { name: "in-progress" }] }];
  const orders = decide({ prs: [], readyRows: rows });
  assert.deepEqual(orders.map((o) => o.subject), ["row-20"],
    "`ready` WITHOUT `in-progress` is the unclaimed set, and the claimed row is excluded");

  // NO SESSION IS NAMED, deliberately: which engineer takes it depends on who is idle at that instant,
  // which only `herdr agent list`'s `agent_status` knows. A gate that picked would be guessing.
  assert.equal(orders[0].session, "engineers");

  // POSITIVE CONTROL for the emptiness assertion above: an empty Ready set is genuinely quiet.
  assert.deepEqual(decide({ prs: [], readyRows: [] }), []);
});


/**
 * ONE ORDER PER ROW IS WHAT PUTS MORE THAN ONE ENGINEER TO WORK. A single order naming every unclaimed
 * row wakes exactly ONE session, because `wake` routes one order to one agent -- so a deep queue
 * recruited one engineer every two minutes while the rest sat idle. Measured 2026-09-17 with eight rows
 * Ready: two engineers woken over six minutes and a third never.
 */
test("every unclaimed row is its OWN order, so one tick can fill every idle engineer", () => {
  const rows = [30, 31, 32].map((n) => ({ number: n, labels: [{ name: "ready" }] }));
  const orders = decide({ prs: [], readyRows: rows });
  assert.deepEqual(orders.map((o) => o.subject), ["row-30", "row-31", "row-32"]);
  assert.equal(new Set(orders.map((o) => o.causeKey)).size, 3,
    "distinct keys, or the ledger would treat the queue as one already-delivered job");
});

test("rows go out OLDEST first -- a queue that hands out its newest starves its oldest", () => {
  const rows = [90, 12, 45].map((n) => ({ number: n, labels: [{ name: "ready" }] }));
  assert.deepEqual(decide({ prs: [], readyRows: rows }).map((o) => o.subject),
    ["row-12", "row-45", "row-90"]);
});

// --- #2296: the `priority` label is READ, and it orders offers without granting a claim ---
const priorityRow = (n: number, ...extra: string[]) =>
  ({ number: n, labels: [{ name: "ready" }, ...extra.map((e) => ({ name: e }))] });
const offered = (rows: unknown[], extra = {}) =>
  decide({ prs: [], readyRows: rows, ...extra })
    .filter((o: { cause: string }) => o.cause === "ready-row-unclaimed")
    .map((o: { subject: string }) => o.subject);

test("#2296: a higher-numbered row labelled `priority` is offered FIRST", () => {
  assert.deepEqual(offered([priorityRow(50), priorityRow(90, "priority")]), ["row-90", "row-50"]);
});

test("#2296: a `priority` row is inside the cap even when it is the highest-numbered of nine", () => {
  const rows = [...Array.from({ length: 8 }, (_, i) => priorityRow(100 + i)), priorityRow(999, "priority")];
  const names = offered(rows);
  assert.equal(names.length, MAX_ROW_ORDERS_PER_TICK);
  assert.equal(names[0], "row-999", "the slice must come AFTER the reorder, or the cap cuts the row it exists to lift");
  // POSITIVE CONTROL: without the label the same nine rows cut #999, so the assertion above can go red.
  assert.ok(!offered(rows.map((r) => priorityRow(r.number))).includes("row-999"));
});

test("#2296: oldest-first holds within each group, priority and not", () => {
  const rows = [priorityRow(70), priorityRow(30, "priority"), priorityRow(20), priorityRow(80, "priority")];
  assert.deepEqual(offered(rows), ["row-30", "row-80", "row-20", "row-70"]);
});

test("#2296: the label reorders offers and does NOT grant a claim -- a shelved `priority` row stays shelved", () => {
  const shelved = { ...regionRow(1452, ".github/workflows/release.yml"),
    labels: [{ name: "ready" }, { name: "priority" }] };
  assert.deepEqual(offered([shelved], { prFiles: [prTouching(1695, ".github/workflows/release.yml")] }), []);
  const held = priorityRow(1453, "priority", "in-progress");
  assert.deepEqual(offered([held]), []);
});

// --- #2293: what the label does NOT override, beyond #2296's shelved and claimed cases ---
test("#2293 a `priority` row keeps its lane owner, and an `answer:` shelf still hides it", () => {
  const orders = decide({ prs: [], readyRows: [priorityRow(20, "priority", "lane:ceo"),
    priorityRow(23, "priority", "answer:ceo"), priorityRow(30)] })
    .filter((o: { cause: string }) => o.cause === "ready-row-unclaimed");
  assert.deepEqual(orders.map((o: { subject: string, session: string }) => [o.subject, o.session]),
    [["row-20", "ceo"], ["row-30", "engineers"]],
    "#23 stays shelved despite the label; #20 goes to its lane owner rather than the engineer pool");
});

test("the per-tick cap bounds the REPORT, not the parallelism", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ number: 100 + i, labels: [{ name: "ready" }] }));
  const orders = decide({ prs: [], readyRows: many });
  assert.equal(orders.length, MAX_ROW_ORDERS_PER_TICK,
    "uncapped, 30 rows would print ~30 UNDELIVERED lines every two minutes and bury the ones that matter");
  assert.ok(MAX_ROW_ORDERS_PER_TICK > 5,
    "the cap must exceed the engineer count or it would throttle real work rather than the log");
});

test("a row already woken for keeps its key, so the next tick does not recruit a second engineer", () => {
  const rows = [{ number: 40, labels: [{ name: "ready" }] }, { number: 41, labels: [{ name: "ready" }] }];
  const first = decide({ prs: [], readyRows: rows });
  // #41 gets claimed; #40's key must be unchanged, or the ledger re-offers a row already being worked.
  const after = decide({ prs: [], readyRows: [rows[0], { ...rows[1], labels: [{ name: "ready" },
    { name: "in-progress" }] }] });
  assert.equal(after.find((o) => o.subject === "row-40")?.causeKey,
    first.find((o) => o.subject === "row-40")?.causeKey,
    "keyed on the queue DEPTH, every claim rewrote every remaining key and re-woke someone");
});

test("#912: the same state produces byte-identical orders, so the ledger can deduplicate", () => {
  const state = { prs: [draft(1, GREEN)], readyRows: [{ number: 20, labels: [{ name: "ready" }] }] };
  assert.equal(JSON.stringify(decide(state)), JSON.stringify(decide(state)),
    "causeKey is derived from GitHub state alone -- that is what lets the gate be stateless and re-run");
  assert.equal(decide(state)[0].causeKey, "reviewer-1/draft-awaiting-verdict/pr-1/abc12345");
});

test("#1286: a refused read returns null, an empty one returns [] -- and they are not the same", () => {
  const refusing = () => { throw new Error("gh exited non-zero with empty stdout"); };
  assert.equal(readPrs(refusing), null, "a refused PR read is null, NEVER [] -- [] reads as an empty queue");
  assert.equal(readReadyRows(refusing), null, "a refused Ready read is null, NEVER []");

  // THE POSITIVE CONTROL: an ACTUALLY empty queue still parses to [], and [] still means quiet. A reader
  // that answered `refused` whenever unsure would block every quiet morning, which is worse.
  assert.deepEqual(readPrs(() => "[]"), [], "an empty queue is [] and means quiet");
  assert.deepEqual(readReadyRows(() => "[]"), []);

  // A non-array payload is a read that did not answer the question -- null, not a crash.
  assert.equal(readPrs(() => '{"message":"Bad credentials"}'), null);
});

test("#912: the exit contract keeps four states, and 0 is QUIET on purpose", () => {
  assert.deepEqual(EXIT, { QUIET: 0, WORK: 1, CANNOT_ASK: 2, PARTIAL: 3 });
  // THE POLARITY IS THE POINT. Under 0=QUIET the predictable misuse `if work-gate; then wake; fi` wakes
  // every session on every quiet tick -- impossible to miss for more than one tick. Under the opposite
  // polarity the same mistake sleeps silently through a rate limit, which is the 2026-09-08 ten-hour
  // outage this design exists to prevent. Pinned so a later "tidy-up" cannot flip it.
  assert.equal(EXIT.QUIET, 0, "flipping this makes a rate-limited gate look like a quiet queue");
  assert.notEqual(EXIT.CANNOT_ASK, EXIT.QUIET, "a refused read is never a quiet one");
  assert.notEqual(EXIT.PARTIAL, EXIT.QUIET, "a half-examined queue is never a quiet one");
});

// ---------------------------------------------------------------------------------------------------
// #2685: AN OUTAGE THAT FAILS gh/GraphQL CALLS INDEPENDENTLY PER CAUSE MUST NOT DOUBLE-COUNT.
//
// `wake.mjs`'s `outageOf` already asks whether a causeKey's own addressed SESSION is unavailable
// (#2256); #2031's pool-exhaustion guard asks about the POOL. Neither asks whether GITHUB ITSELF refused
// THIS TICK's reads -- so, before this row, two causes stuck for the SAME shared connectivity reason each
// reach `escalateStuck` on their own and label two DIFFERENT rows `answer:ceo` for what is really one
// outage. `refusedReadCount`/`sharedReadOutage`/`markOutageReads` are `work-gate.mjs`'s half of the fix;
// `deliver`'s `outaged` (wake.mjs) is the other.

test("#2685: refusedReadCount counts nulls only -- an empty-but-successful read is not a refusal", () => {
  assert.equal(refusedReadCount([[], [], []]), 0, "three quiet lanes, none of them refused");
  assert.equal(refusedReadCount([null, [], null]), 2);
  assert.equal(refusedReadCount([]), 0);
});

test("#2685: sharedReadOutage trips at SHARED_OUTAGE_READS, not before", () => {
  assert.equal(SHARED_OUTAGE_READS, 2, "one lane's own trouble is not evidence of GitHub's -- a second, independent one is");
  assert.equal(sharedReadOutage(SHARED_OUTAGE_READS - 1), false, "one refused read is that read's own trouble");
  assert.equal(sharedReadOutage(SHARED_OUTAGE_READS), true, "a second refused read the SAME tick is the shared shape");
  assert.equal(sharedReadOutage(SHARED_OUTAGE_READS + 3), true);
});

test("#2685: markOutageReads leaves an ordinary tick's orders untouched", () => {
  const orders = [{ causeKey: "k1", session: "ceo", prompt: "p" }];
  assert.deepEqual(markOutageReads(orders, false), orders);
  assert.equal(markOutageReads(orders, false), orders, "the SAME array, not a copy -- nothing downstream sees a new shape");
});

test("#2685: markOutageReads tags every order alike, without disturbing what was already there", () => {
  const orders = [{ causeKey: "k1", session: "ceo", prompt: "p1" }, { causeKey: "k2", session: "ceo", prompt: "p2" }];
  assert.deepEqual(markOutageReads(orders, true),
    [{ ...orders[0], outageNow: true }, { ...orders[1], outageNow: true }]);
});

/**
 * THE FIXTURE ITSELF: two DIFFERENT causes, on two DIFFERENT rows, both at the delivery cap in the SAME
 * run. `escalateStuck` and `stuckRowOf`'s own tests already prove ONE stuck cause labels ONE row; what
 * neither proved is what happens to TWO, when the reason they are both stuck is one shared connectivity
 * failure rather than two genuinely unrelated rows.
 */
const CAPPED_CAUSES = [
  { session: "ceo", causeKey: "ceo/lane-backlog-unpromoted/row-101", prompt: "row #101 is not promoted" },
  { session: "ceo", causeKey: "ceo/org-stalled/row-102", prompt: "row #102 is stalled" },
];
const bothAtCap = () => new Map(CAPPED_CAUSES.map((o) => [o.causeKey, MAX_DELIVERIES]));

test("#2685 BEFORE: two causes capped for a shared reason still escalate as two, absent an outage reading", () => {
  const { stuck, outaged } = deliver(CAPPED_CAUSES, [], [], { counts: bothAtCap() });
  assert.equal(stuck.length, 2, "TODAY's shape: every capped cause is its own stuck entry");
  assert.deepEqual(outaged, [], "nothing here recognises them as sharing one cause");

  const calls: string[][] = [];
  const labelled = escalateStuck(stuck, (a: string[]) => { calls.push(a); return ""; }, () => {});
  assert.deepEqual(labelled, [101, 102], "TWO rows labelled answer:ceo for what may be one shared outage");
});

test("#2685 AFTER: work-gate's shared-outage reading collapses the SAME two causes to ONE signal", () => {
  // THIS TICK'S OWN READS: three of four independent lanes refused together -- the shape `sharedReadOutage`
  // exists to recognise, built from the SAME `refusedReadCount` `work-gate.mjs`'s `main` feeds it.
  const outageNow = sharedReadOutage(refusedReadCount([null, [], null, null]));
  assert.equal(outageNow, true, "three of four reads refused the same tick is GitHub's own outage, not one lane's");

  const { stuck, outaged } = deliver(markOutageReads(CAPPED_CAUSES, outageNow), [], [], { counts: bothAtCap() });
  assert.deepEqual(stuck, [], "NEITHER cause reaches escalateStuck's input -- the fix this row is about");
  assert.deepEqual(outaged, CAPPED_CAUSES.map((o) => o.causeKey), "named together, as ONE outage");

  const calls: string[][] = [];
  const labelled = escalateStuck(stuck, (a: string[]) => { calls.push(a); return ""; }, () => {});
  assert.deepEqual(labelled, [], "ZERO rows labelled -- collapsed to one outage signal, not two stuck rows");
  assert.deepEqual(calls, [], "no `gh issue edit` was even attempted for either row");
});

// --- #1650: a red pull request is work, and nobody was asking about it (2026-09-17) ---

test("a settled-RED pull request is an order, routed by its own session label", () => {
  const pr = { ...draft(50, RED), isDraft: false, labels: [{ name: "session:worker-capture" }] };
  const orders = decide({ prs: [pr], readyRows: [] });
  assert.deepEqual(orders.map((o: { cause: string; session: string }) => [o.cause, o.session]),
    [["pr-checks-failing", "worker-capture"]],
    "#1650 sat BLOCKED on a failing changeset while the session named on its own label was idle, and the "
    + "gate called the queue quiet -- `checksSettledGreen` returned false and nothing read it");
});

test("a RED DRAFT counts too -- it can never reach the reviewer lane, which requires green", () => {
  const orders = decide({ prs: [draft(51, RED)], readyRows: [] });
  assert.deepEqual(orders.map((o: { cause: string }) => o.cause), ["pr-checks-failing"],
    "a red draft is not 'not ready yet', it is a branch whose author stopped");
});

test("an unlabelled red pull request falls to ceo, the last rung of ownerOfPr, rather than being dropped", () => {
  const pr = { ...draft(52, RED), isDraft: false, labels: [] };
  assert.deepEqual(decide({ prs: [pr], readyRows: [] })
    .map((o: { session: string }) => o.session), ["ceo"]);
});

test("checks still RUNNING are not red -- an unsettled build is nobody's job yet", () => {
  const pr = { ...draft(53, PENDING), isDraft: false, labels: [{ name: "session:worker-judge" }] };
  assert.deepEqual(decide({ prs: [pr], readyRows: [] }), [],
    "waking someone to fix a build that has not finished is how a gate becomes noise");
});

// --- the shelf itself is work: Ready empty with a backlog behind it (2026-09-17) ---

test("an EMPTY ready queue with promotable backlog wakes product-manager", () => {
  const orders = decide({ prs: [], readyRows: [], promotableRows: Array.from({ length: 52 }, (_, i) => ({ number: 900 + i, labels: [{ name: "backlog" }] })) });
  assert.deepEqual(orders.map((o: { cause: string; session: string }) => [o.cause, o.session]),
    [["ready-queue-empty", "product-manager"]],
    "92 open issues, 87 backlog, ZERO ready and five engineers idle -- and the gate called it quiet");
  // "unlaned" since the pool shelf became pool-aware: a laned row is somebody else's to promote.
  assert.match(orders[0].prompt, /52 unlaned backlog row/);
});

/**
 * The `ready:audit` incident, pinned: `dispatcher` labelled two rows `ready` TO HIT A FLOOR -- one
 * disputed, one with neither a Region nor an Acceptance. "A floor met by a label I control is not a
 * measurement." So the order must report facts and must NOT ask for a number.
 */
test("the order asks for judgment, never for a count", () => {
  const [order] = decide({ prs: [], readyRows: [], promotableRows: Array.from({ length: 52 }, (_, i) => ({ number: 900 + i, labels: [{ name: "backlog" }] })) });
  assert.match(order.prompt, /NOT a request to reach a count/);
  assert.match(order.prompt, /Promoting nothing and saying why\s+is a valid answer/);
  assert.doesNotMatch(order.prompt, /at least three|promote three|reach (a )?floor of/i,
    "a number here buys relabelling rather than rows -- that is what ready:audit was filed for");
});

test("a NON-empty ready queue wakes nobody to stock it -- a short queue is not an empty one", () => {
  const ready = [{ number: 30, labels: [{ name: "ready" }] }];
  const orders = decide({ prs: [], readyRows: ready, promotableRows: Array.from({ length: 52 }, (_, i) => ({ number: 900 + i, labels: [{ name: "backlog" }] })) });
  assert.ok(!orders.some((o: { cause: string }) => o.cause === "ready-queue-empty"),
    "re-prompting on a short queue is the floor by another name");
});

test("an empty ready queue with NOTHING promotable behind it wakes nobody", () => {
  assert.deepEqual(decide({ prs: [], readyRows: [], promotableRows: Array.from({ length: 0 }, (_, i) => ({ number: 900 + i, labels: [{ name: "backlog" }] })) }), [],
    "there is nothing to ask for; waking someone to stare at an empty backlog is noise");
});

test("a REFUSED backlog read is not an empty shelf -- null must never wake anyone", () => {
  assert.deepEqual(decide({ prs: [], readyRows: [], promotableRows: [] }), [],
    "a refused read reported as 'nothing promotable' would be the quiet-org error one level down");
});

test("the discriminator is the count, so the order stops once a row is promoted", () => {
  const a = decide({ prs: [], readyRows: [], promotableRows: Array.from({ length: 52 }, (_, i) => ({ number: 900 + i, labels: [{ name: "backlog" }] })) })[0];
  const b = decide({ prs: [], readyRows: [], promotableRows: Array.from({ length: 51 }, (_, i) => ({ number: 900 + i, labels: [{ name: "backlog" }] })) })[0];
  assert.notEqual(a.causeKey, b.causeKey, "a changed shelf is a new question");
  const again = decide({ prs: [], readyRows: [], promotableRows: Array.from({ length: 52 }, (_, i) => ({ number: 900 + i, labels: [{ name: "backlog" }] })) })[0];
  assert.equal(a.causeKey, again.causeKey, "an unchanged shelf is the same question, so the ledger stops it");
});

test("a ready row that is CLAIMED does not count as stock", () => {
  const claimed = [{ number: 31, labels: [{ name: "ready" }, { name: "in-progress" }] }];
  const orders = decide({ prs: [], readyRows: claimed, promotableRows: Array.from({ length: 52 }, (_, i) => ({ number: 900 + i, labels: [{ name: "backlog" }] })) });
  assert.ok(orders.some((o: { cause: string }) => o.cause === "ready-queue-empty"),
    "a shelf holding only claimed rows is an empty shelf to anyone looking for work");
});

// --- #1320: a lane is a person, and nothing was asking them (2026-09-18) ---

const laneRow = (n: number, lane: string, extra: string[] = []) =>
  ({ number: n, labels: [{ name: "ready" }, { name: lane }, ...extra.map((e) => ({ name: e }))] });

test("a ready row goes to its LANE OWNER, not to the engineer pool", () => {
  const orders = decide({ prs: [], readyRows: [laneRow(60, "lane:ceo"), laneRow(61, "lane:orchestrator")] });
  assert.deepEqual(orders.map((o: { session: string }) => o.session), ["ceo", "orchestrator"],
    "every ready row went to `engineers` regardless of lane, and 18 of 49 open rows are lane:ceo -- "
    + "an engineer may not act on those");
});

test("lane:any and no lane are the engineer pool", () => {
  const orders = decide({ prs: [], readyRows: [laneRow(62, "lane:any"),
    { number: 63, labels: [{ name: "ready" }] }] });
  assert.deepEqual(orders.map((o: { session: string }) => o.session), ["engineers", "engineers"]);
});

test("the causeKey carries the owner, so a re-lane is a new question", () => {
  const asCeo = decide({ prs: [], readyRows: [laneRow(64, "lane:ceo")] })[0];
  const asPool = decide({ prs: [], readyRows: [laneRow(64, "lane:any")] })[0];
  assert.notEqual(asCeo.causeKey, asPool.causeKey,
    "the same row under a different owner is a different offer, and the ledger must not silence it");
});

/**
 * #1320 exactly: 18 open `lane:ceo` rows, none Ready, and `product-manager` reporting it had asked `ceo`
 * the day before with no answer -- because the only thing that ever woke `ceo` was the standing cron this
 * system replaced. Five publish-gated rows sat behind that silence.
 */
test("a lane with backlog and nothing Ready wakes its OWNER, who alone may promote it", () => {
  const backlog = [1320, 1346, 1531].map((n) => ({ number: n, labels: [{ name: "backlog" },
    { name: "lane:ceo" }] }));
  const orders = decide({ prs: [], readyRows: [], promotableRows: backlog });
  const lane = orders.find((o: { cause: string }) => o.cause === "lane-backlog-unpromoted");
  assert.ok(lane, "nobody was asking ceo about its own lane");
  assert.equal(lane.session, "ceo");
  assert.match(lane.prompt, /#1320/);
  assert.match(lane.prompt, /nobody else may promote it/);
});

test("a lane that HAS something Ready is not asked to stock it", () => {
  const backlog = [{ number: 70, labels: [{ name: "backlog" }, { name: "lane:ceo" }] }];
  const ready = [laneRow(71, "lane:ceo")];
  const orders = decide({ prs: [], readyRows: ready, promotableRows: backlog });
  assert.ok(!orders.some((o: { cause: string }) => o.cause === "lane-backlog-unpromoted"),
    "a lane with work on the shelf does not need stocking -- that is the floor by another name");
});

test("the lane order asks for judgment, not a quota", () => {
  const backlog = [{ number: 72, labels: [{ name: "backlog" }, { name: "lane:orchestrator" }] }];
  const [order] = decide({ prs: [], readyRows: [], promotableRows: backlog })
    .filter((o: { cause: string }) => o.cause === "lane-backlog-unpromoted");
  // THE PHRASE "not a quota" IS GONE BECAUSE THE SHAPE THAT NEEDED IT IS. It guarded a SURVEY -- "you
  // own 7 rows" reads as "promote 7". A per-row order (#1799) cannot be read as a quota at all. What
  // must survive is the GUARANTEE underneath it: doing nothing is a legitimate answer.
  assert.match(order.prompt, /leaving it and recording why is a valid answer/);
  assert.match(order.prompt, /leaving it and recording why\s+is a valid answer/);
  // AND IT MUST LAND ON THE ROW. `orchestrator` answered #1564 correctly and wrote it only to its own
  // terminal, so nothing downstream could tell an answered question from an ignored one.
  assert.match(order.prompt, /RECORD THE ANSWER ON THE ROW/);
  assert.match(order.prompt, /only in\s+your terminal is one the org cannot see/);
});

// --- a shelf full of other people's rows is an empty shelf to the pool (2026-09-18) ---

/**
 * Measured minutes after lane routing shipped: `ceo` and `orchestrator` were woken, promoted their own
 * lanes, and went to work -- 14 rows Ready, 11 `lane:ceo` and 3 `lane:orchestrator`, NOT ONE takeable by
 * an engineer. `ready-queue-empty` counted all 14 and stayed silent while three engineers sat idle.
 */
test("a Ready queue holding only LANED rows still wakes product-manager for the pool", () => {
  const ready = [laneRow(80, "lane:ceo"), laneRow(81, "lane:orchestrator")];
  const backlog = [{ number: 82, labels: [{ name: "backlog" }] }];
  const orders = decide({ prs: [], readyRows: ready, promotableRows: backlog });
  assert.ok(orders.some((o: { cause: string }) => o.cause === "ready-queue-empty"),
    "14 rows Ready read as a stocked shelf while not one was takeable by an engineer");
});

test("one unlaned row on the shelf is enough -- the pool has something to pull", () => {
  const ready = [laneRow(83, "lane:ceo"), { number: 84, labels: [{ name: "ready" }] }];
  const backlog = [{ number: 85, labels: [{ name: "backlog" }] }];
  assert.ok(!decide({ prs: [], readyRows: ready, promotableRows: backlog })
    .some((o: { cause: string }) => o.cause === "ready-queue-empty"));
});

test("the backlog it reports is the pool's too, not rows a lane owner must promote", () => {
  const backlog = [{ number: 86, labels: [{ name: "backlog" }, { name: "lane:ceo" }] },
    { number: 87, labels: [{ name: "backlog" }] }];
  const [order] = decide({ prs: [], readyRows: [], promotableRows: backlog })
    .filter((o: { cause: string }) => o.cause === "ready-queue-empty");
  assert.match(order.prompt, /1 unlaned backlog row/,
    "reporting the lane:ceo row here would ask product-manager for something only ceo may do");
});

test("a pool shelf that is empty with NO unlaned backlog wakes nobody", () => {
  const backlog = [{ number: 88, labels: [{ name: "backlog" }, { name: "lane:ceo" }] }];
  assert.ok(!decide({ prs: [], readyRows: [], promotableRows: backlog })
    .some((o: { cause: string }) => o.cause === "ready-queue-empty"),
    "there is nothing product-manager can promote; the lane order is what carries that work");
});

// --- #63: the escalation path ended at ceo, and ceo's onward route was a sentence (2026-09-18) ---
// The key and the window moved with #2989 and their tests with them: `packages/agent-org/src/work-gate-chairman-blocked.test.ts`.

const blockedRow = (n: number, daysAgo: number) =>
  ({ number: n, title: `row ${n}`, updatedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString() });
// The order is emitted only in the first two hours of a UTC day (#2989), so these pin a clock inside one.
const IN_WINDOW = Date.parse("2026-10-02T00:30:00Z");

/**
 * #63 sat four days with eight publish-gated rows behind it. `ceo` escalated correctly and
 * `product-manager` reported it in every sweep; nothing carried it onward, so it surfaced only because
 * the chairman happened to read a sweep in a terminal.
 */
test("rows waiting on the chairman wake CEO, the only session that briefs one", () => {
  const orders = decide({ prs: [], readyRows: [], chairmanBlocked: [blockedRow(63, 4)], nowMs: IN_WINDOW });
  assert.deepEqual(orders.map((o: { cause: string; session: string }) => [o.cause, o.session]),
    [["chairman-blocked", "ceo"]]);
  assert.match(orders[0].prompt, /#63/);
});

test("nothing waiting on the chairman wakes nobody", () => {
  assert.deepEqual(decide({ prs: [], readyRows: [], chairmanBlocked: [], nowMs: IN_WINDOW }), []);
});

test("the order tells ceo to CLEAR a stale label, or the count stops meaning anything", () => {
  const [order] = decide({ prs: [], readyRows: [], chairmanBlocked: [blockedRow(63, 4)], nowMs: IN_WINDOW });
  assert.match(order.prompt, /take the label off/);
  assert.match(order.prompt, /four days unread/);
});

// --- B4 asked EARLY: a row nobody can claim is not a row to offer (2026-09-18) ---

/**
 * THE TURN THIS REMOVES, MEASURED. All three unclaimed Ready rows (#1452, #1397, #1320) declared
 * `.github/workflows/release.yml`, which open draft #1695 already touched, so `row-claim.mjs` refused
 * every one of them on B4. The gate offered all three every two minutes anyway. `ceo` was woken for
 * #1452, ran sixteen shell commands, rediscovered the refusal, posted it on the row, messaged
 * `product-manager` and stopped -- re-deriving a hold a PRIOR `ceo` session had already recorded.
 *
 * The refusal was an intersection of two `--json` field lists the gate's own two calls already pay for.
 * So these tests pin BOTH directions, because both hide: a gate that never shelves restores the wasted
 * turn, and a gate that shelves when it cannot actually tell would starve a queue in silence.
 */
const regionRow = (n: number, region: string, extra: string[] = []) =>
  ({ number: n, body: `## Region\n\n- \`${region}\`\n\n## Acceptance\n\nnone\n\n## Open-check\n\nnone\n`,
    labels: [{ name: "ready" }, ...extra.map((e) => ({ name: e }))] });

/**
 * The one file the B4 overlap tests contend over. It must sit under a top-level directory the tree it runs in tracks,
 * and that is TWO trees: this repository (`docs`, `src`, `host`) and a11ign's, where CI copies the tool under
 * `packages/agent-org` (`docs`, `packages`, `.claude`). `docs/` is the one both have. `declaredRegionFiles` derives its
 * recognised prefixes from `git ls-files` (#1158), so a Region naming `.claude/...` or `packages/...` declares NOTHING
 * when run from this repository, and a row declaring nothing overlaps nothing. The "offered" assertions then pass for
 * that reason, and the "shelved" twins fail (#3073).
 */
const SHARED_FILE = "docs/messaging.md";

const prTouching = (n: number, ...files: string[]) => ({ number: n, files, changedFiles: files.length });

test("a row whose Region overlaps an open PR is NOT offered -- B4 would only refuse the claim", () => {
  const orders = decide({ prs: [], readyRows: [regionRow(1452, ".github/workflows/release.yml")],
    prFiles: [prTouching(1695, ".github/workflows/release.yml")] });
  assert.deepEqual(orders.filter((o: { cause: string }) => o.cause === "ready-row-unclaimed"), [],
    "offering it costs a whole session turn to reach the answer this comparison already has");
});

/**
 * THE POSITIVE CONTROL for every assertion above. A `partitionUnclaimed` that shelved everything would
 * satisfy each "not offered" case perfectly and would recruit nobody, ever -- this file's own header
 * names that shape one level up.
 */
test("the SAME row IS offered when no open PR touches its Region", () => {
  const orders = decide({ prs: [], readyRows: [regionRow(1452, ".github/workflows/release.yml")],
    prFiles: [prTouching(1695, "packages/lab/src/packaging/something.test.ts")] });
  assert.deepEqual(orders.map((o: { subject: string }) => o.subject), ["row-1452"]);
});

// --- #2237: the order names a launch directory `launchGate` ACCEPTS ---
//
// `rowOrders` told every woken engineer to run `row-claim` "from the primary checkout" for nine days
// after `launchGate` (#1352) began refusing that launch. Deleting the sentence would re-open the
// 2026-09-17 incident it exists for (an engineer stopped and asked a human where to run it), so the
// assertions come in both directions: it must not name the primary, AND it must name somewhere.
const HOST_REPOS = "/home/agent/repos";
const HOST_PRIMARY = `${HOST_REPOS}/a11y-witness`;

/**
 * The host as `launchGate` reads it: the primary's `.git` is a DIRECTORY, and any other checkout under the
 * repos directory is a linked worktree whose `.git` is a FILE. Every direct child counts as a checkout so a
 * named directory the fixture had never heard of is judged, not waved through as "outside any checkout"
 * (`launchCheckoutOf` returns null there and `primaryLaunchRefusal` then says nothing).
 */
const HOST_FS = {
  exists: (path: string) => /^\/home\/agent\/repos\/[^/]+\/\.git$/.test(path),
  isDirectory: (path: string) => path === `${HOST_PRIMARY}/.git`,
  read: () => "",
};

const claimOrderPrompt = () => {
  const orders = decide({ prs: [], readyRows: [{ number: 9001, title: "t", labels: [] }] }) as
    { cause: string, prompt: string }[];
  return (orders.find((o) => o.cause === "ready-row-unclaimed") as { prompt: string }).prompt;
};

/**
 * THE ORDER AS THE ENGINEER READS IT (#2405): the gate leaves the launch directory to `wake.mjs`, which knows who
 * took the order, so the sentence #2237 pins is asserted on what `addressed` delivers to a standing session whose
 * `role-<you>` worktree exists. `work-gate-engineer-order-paths.test.ts` pins the branch where it does not.
 */
const deliveredClaimOrder = () => addressed({ session: "engineers", prompt: claimOrderPrompt() }, "worker-tooling",
  { exists: () => true });

/**
 * THE LAUNCH DIRECTORY THE ORDER NAMES: the first absolute path in it, the order as `addressed` delivers it. "First" is a convention this test imposes -- an order that names the
 * primary at all, even to forbid it, must name its own directory BEFORE it -- and it is what lets a reworded
 * order that instructs the primary go red here without this file pinning a spelling of the wrong sentence.
 */
const namedLaunchDirectory = (prompt: string) =>
  /\/home\/agent\/repos\/[^\s`),;]+/.exec(prompt)?.[0] ?? null;

test("#2237 DONE-WHEN 1: the ready-row order does not instruct the launch `launchGate` refuses", () => {
  assert.doesNotMatch(deliveredClaimOrder(), /from the primary checkout/i,
    "row-claim, pr-open and row-file all refuse a launch from the primary checkout (#1352)");
});

test("#2237 DONE-WHEN 2+3: it names a launch directory, and `launchGate` accepts the one it names", () => {
  const dir = namedLaunchDirectory(deliveredClaimOrder());
  // DONE-WHEN 2. A prompt that names nothing passes clause 1 and re-opens the 2026-09-17 incident.
  assert.ok(dir !== null, "the order must say where to run the command, or the engineer stops and asks");
  assert.ok(launchCheckoutOf(dir, HOST_FS) !== null, `${dir} must be a checkout, else the refusal below is vacuous`);
  // DONE-WHEN 3. Asked of the DECIDER, so a rewording that still points at the primary is red here.
  assert.equal(primaryLaunchRefusal("row-claim", { cwd: dir, fs: HOST_FS }), null,
    `the order sends the engineer to ${dir}, and launchGate refuses it`);
});

test("#2237: POSITIVE CONTROL -- the same decider DOES refuse the primary, so the acceptance above can go red", () => {
  const refusal = primaryLaunchRefusal("row-claim", { cwd: HOST_PRIMARY, fs: HOST_FS });
  assert.match(refusal ?? "", /^row-claim: REFUSED -- launched from \/home\/agent\/repos\/a11y-witness, which is not a linked worktree/);
  assert.equal(primaryLaunchRefusal("row-claim", { cwd: `${HOST_REPOS}/role-worker-tooling`, fs: HOST_FS }), null);
});

test("#2237 DONE-WHEN 4: both flags stay named -- row-claim refuses when given only one", () => {
  const prompt = claimOrderPrompt();
  assert.match(prompt, /--branch=agent\/<slug>-9001/);
  assert.match(prompt, /--worktree=\.\.\/wt-9001/);
});

test("NO REGION is cannot-ask, not no-overlap -- the row is still offered, as row-claim would grant it", () => {
  const row = { number: 77, labels: [{ name: "ready" }], body: "a row with no template fields at all" };
  const orders = decide({ prs: [], readyRows: [row],
    prFiles: [prTouching(1695, ".github/workflows/release.yml")] });
  assert.deepEqual(orders.map((o: { subject: string }) => o.subject), ["row-77"],
    "row-claim skips B4 on a Region-less row rather than refusing it; disagreeing here would shelve "
    + "rows the claim would grant, and nothing would ever say so");
});

/**
 * #1419: `gh pr list --json files` returns each PR's first 100 files and never says so. At claim time a
 * list shorter than its own count is a REFUSAL, which is right when the cost of guessing is two sessions
 * in one file. Here it must FAIL OPEN -- one paginated PR would otherwise shelve the entire queue, and
 * the gate would report a starved queue as a quiet one.
 */
test("a TRUNCATED pull-request file list is dropped from the comparison, never read as an overlap", () => {
  const raw = [{ number: 1695, changedFiles: 113, files: [{ path: ".github/workflows/release.yml" }] }];
  assert.deepEqual(comparablePrFiles(raw), [], "113 changed files, 1 listed -- not comparable");
  const orders = decide({ prs: [], readyRows: [regionRow(1452, ".github/workflows/release.yml")],
    prFiles: comparablePrFiles(raw) });
  assert.deepEqual(orders.map((o: { subject: string }) => o.subject), ["row-1452"],
    "the gate fails open and row-claim still refuses at claim time -- shelving can only ever REMOVE a "
    + "wake that would have ended in a refusal");
});

test("comparablePrFiles reads gh's own shape: a file list is objects carrying a path", () => {
  assert.deepEqual(comparablePrFiles([{ number: 9, changedFiles: 2,
    files: [{ path: "a.ts" }, { path: "b.ts" }] }]),
  [{ number: 9, changedFiles: 2, files: ["a.ts", "b.ts"], closes: [], held: false }]);
});

// --- #2101: THE GATE SHELVED A ROW BEHIND THE PULL REQUEST THAT WAS THAT ROW'S OWN WORK ---
//
// Measured 2026-09-23: #2077 opened 32 seconds after #2076 was filed, one file each side and the same
// file. The gate compared #2076's Region against every open PR, #2077 included, and shelved #2076 --
// while #2084 and #2083 waited behind the same file and three engineers were idle. Nobody could claim
// the row and nobody could finish the PR; `product-manager` closed #2077 by hand after 1h41m.
//
// THE SHELVING SIDE IS PINNED BESIDE THE OFFERING SIDE ON PURPOSE. A gate that stops shelving is this
// row's defect running the other way -- it restores exactly the wasted turn `partitionUnclaimed` exists
// to remove -- so each assertion below that a row IS offered has a twin asserting a row is NOT.

const prClosingRow = (n: number, closes: number[], ...files: string[]) =>
  ({ number: n, files, changedFiles: files.length, closes });

test("#2101 a row is OFFERED although an open PR holds its whole Region, when that PR declares `Closes #<row>`", () => {
  const orders = decide({ prs: [], readyRows: [regionRow(2076, SHARED_FILE)],
    prFiles: [prClosingRow(2077, [2076], SHARED_FILE)] });
  assert.deepEqual(orders.map((o: { subject: string }) => o.subject), ["row-2076"],
    "a row and its own pull request are one piece of work, and one piece of work cannot collide with itself");
});

test("#2101 NEGATIVE: the same row is still SHELVED behind a PR declaring another row, and behind one " +
  "declaring nothing -- B4 stays unconditional about two SESSIONS in one file", () => {
  const row = regionRow(2076, SHARED_FILE);
  const other = decide({ prs: [], readyRows: [row],
    prFiles: [prClosingRow(2077, [2084], SHARED_FILE)] });
  assert.deepEqual(other.filter((o: { cause: string }) => o.cause === "ready-row-unclaimed"), []);
  const undeclared = decide({ prs: [], readyRows: [row],
    prFiles: [prTouching(2077, SHARED_FILE)] });
  assert.deepEqual(undeclared.filter((o: { cause: string }) => o.cause === "ready-row-unclaimed"), []);
});

test("#2101 the shelving REPORT names the same two, and stops naming the row's own PR", () => {
  const row = regionRow(2076, SHARED_FILE);
  assert.deepEqual(partitionUnclaimed([row],
    [prClosingRow(2077, [2076], SHARED_FILE)]).blocked, [],
  "a row withheld with no session able to unblock it is the deadlock itself");
  const [withheld] = partitionUnclaimed([row],
    [prTouching(2077, SHARED_FILE)]).blocked;
  assert.match(withheld.reason, /overlaps #2077/);
});

test("#2101 comparablePrFiles reads the declaration off the body gh already returns, never a second call", () => {
  assert.deepEqual(comparablePrFiles([
    { number: 2077, changedFiles: 1, files: [{ path: "a.ts" }], body: "Closes #2076\n\nsome prose" },
    { number: 2084, changedFiles: 1, files: [{ path: "a.ts" }], body: "Closes: none -- a trunk revert" },
    { number: 2085, changedFiles: 1, files: [{ path: "a.ts" }], body: "See #2076 for context." },
  ]).map((p: { number: number, closes: number[] }) => [p.number, p.closes]),
  [[2077, [2076]], [2084, []], [2085, []]],
  "an opt-out and a bare mention declare NO row, so neither can exclude one");
});

test("#2101 `body` rides on readPrs's existing field list -- another field, never another call", () => {
  const calls: string[][] = [];
  readPrs((args: string[]) => { calls.push(args); return "[]"; });
  assert.equal(calls.length, 1);
  assert.match(calls[0].join(" "), /changedFiles,body/);
});

// --- #2493: A HELD PR WAITING ON THE ASKING ROW IS NOT A REASON TO SHELVE IT ------------------------
//
// #2399 was shelved behind #2376, which carried `hold:` on purpose and was WAITING on #2399 -- the wait was a
// comment. `ceo` (#2400 section 2): exclude only when the PR is held AND every row it closes is `blockedBy` the
// asking row. The gate must give the verdicts `fileOverlapReason` gives at claim time, or it shelves what the
// claim would grant. Each "offered" assertion has a "shelved" twin, as in #2101 above.

const HELD_REGION = SHARED_FILE;
const edgeRow = (n: number, ...blockers: number[]) =>
  ({ number: n, labels: [{ name: "in-progress" }], blockedBy: { nodes: blockers.map((number) => ({ number, state: "OPEN" })) } });
/** #2376's shape: a HELD pull request on the region, closing `closes`. */
const heldPrClosing = (closes: number[], held = true) => ({ ...prClosingRow(2376, closes, HELD_REGION), held });
const shelved = (row: unknown, prFiles: { number: number; files: string[]; changedFiles: number }[], openRows: unknown[]) =>
  partitionUnclaimed([row], prFiles, { openRows }).blocked.map((b: { number: number }) => b.number);

test("#2493 THE POSITIVE: a held PR whose every closed row is blockedBy the asking row does not shelve it", () => {
  const row = regionRow(2399, HELD_REGION);
  const openRows = [edgeRow(2359, 2399)];
  assert.deepEqual(shelved(row, [heldPrClosing([2359])], openRows), []);
  const orders = decide({ prs: [], readyRows: [row], prFiles: [heldPrClosing([2359])], openRows });
  assert.deepEqual(orders.filter((o: { cause: string }) => o.cause === "ready-row-unclaimed")
    .map((o: { subject: string }) => o.subject), ["row-2399"], "offered, as `row-claim` would grant it");
});

test("#2493 NEGATIVES, through the gate: no edge, an edge to another row, no hold, and an unread row all SHELVE", () => {
  const row = regionRow(2399, HELD_REGION);
  assert.deepEqual(shelved(row, [heldPrClosing([2359])], [edgeRow(2359)]), [2399], "held, no edge");
  assert.deepEqual(shelved(row, [heldPrClosing([2359])], [edgeRow(2359, 2084)]), [2399], "an edge to ANOTHER row");
  assert.deepEqual(shelved(row, [heldPrClosing([2359], false)], [edgeRow(2359, 2399)]), [2399], "an edge but no `hold:`");
  assert.deepEqual(shelved(row, [heldPrClosing([2359])], []), [2399], "the closed row is not among those read: not excluded");
  assert.deepEqual(partitionUnclaimed([row], [heldPrClosing([2359])]).blocked.map((b: { number: number }) => b.number),
    [2399], "`openRows` absent excludes nothing, so every caller that does not pass it is unchanged");
  assert.match(partitionUnclaimed([row], [heldPrClosing([2359], false)], { openRows: [edgeRow(2359, 2399)] }).blocked[0].reason,
    /overlaps #2376/);
});

test("#2493 a held PR closing NOTHING, or closing TWO rows with one edge missing, still shelves", () => {
  const row = regionRow(2399, HELD_REGION);
  assert.deepEqual(shelved(row, [heldPrClosing([])], [edgeRow(2359, 2399)]), [2399], "`Closes: none` waits on nothing");
  assert.deepEqual(shelved(row, [heldPrClosing([2359, 2360])], [edgeRow(2359, 2399), edgeRow(2360, 2084)]), [2399]);
  assert.deepEqual(shelved(row, [heldPrClosing([2359, 2360])], [edgeRow(2359, 2399), edgeRow(2360, 2399)]), [],
    "the control: with both edges present the same PR is excluded");
});

test("#2493 `held` comes off the `labels` readPrs already returns, and only a `hold:` label is a hold", () => {
  const raw = (labels: string[]) => [{ number: 2376, changedFiles: 1, files: [{ path: "a.ts" }],
    body: "Closes #2359", labels: labels.map((name) => ({ name })) }];
  assert.equal(comparablePrFiles(raw(["hold:product-manager", "session:worker-1"]))[0].held, true);
  assert.equal(comparablePrFiles(raw(["session:worker-1", "ready"]))[0].held, false);
  assert.equal(comparablePrFiles(raw([]))[0].held, false);
  const calls: string[][] = [];
  readPrs((args: string[]) => { calls.push(args); return "[]"; });
  assert.match(calls[0].join(" "), /,labels,/, "the field is already on the call");
});

/** #2493: the two readers agree on the same fixtures -- the gate's `blockersFromRows` and the claim's lookup. */
test("#2493 blockersFromRows answers from the open rows already read, and `null` for a row it never read", () => {
  const blockersOf = blockersFromRows([edgeRow(2359, 2399, 7), edgeRow(2360)]);
  assert.deepEqual(blockersOf(2359), [2399, 7]);
  assert.deepEqual(blockersOf(2360), [], "read, and nothing blocks it");
  assert.equal(blockersOf(9999), null, "not read: unknown, which the rule reads as not excluded");
  assert.equal(blockersFromRows(null)(2359), null);
});

/** #2493 done-when 5: the ready audit's line lives in the role brief, pinned so deleting it is red. */
test("#2493: product-manager's brief says `SOLE HOLDER IS A HELD PR`, and what to read next, in ONE bullet", () => {
  const brief = readFileSync(join(HOME_CHECKOUT, ".agent-org/roles/product-manager.md"), "utf8");
  // THE BULLET, SLICED: a whole-file `includes` is satisfied by any second copy of the phrase elsewhere.
  const start = brief.indexOf("- **A ready audit that names a B4 holder");
  assert.ok(start >= 0, "the bullet is gone");
  const bullet = brief.slice(start, brief.indexOf("\n- **", start + 1));
  assert.match(bullet, /`SOLE HOLDER IS A HELD PR`/);
  assert.match(bullet, /only holder carries `hold:`/, "the condition that makes the line true");
  assert.match(bullet, /FIRST audit/, "the point of the row: the cycle is named at the first reading, not the fifth");
  assert.match(bullet, /--add-blocked-by/, "and the remedy is the edge, which is data, not a comment");
});

/**
 * #2084: THE NAMED CONTROL FOR `reviewStateOf`'s `UNREADABLE` STATE, and the reason it lives here.
 *
 * `reviewStateOf` answers `UNREADABLE` for a payload with no `reviewDecision` key, and `reviewBlocked`
 * deliberately does NOT emit an order for it -- a field the gate never asked for is a fact about the gate,
 * not about the pull request. That leaves a real silent failure: a `readPrs` that stopped requesting the
 * field would empty `pr-review-blocked` entirely and nothing would say so.
 *
 * SO THE GUARD SITS ON THE ARGUMENT RATHER THAN ON THE VERDICT. It catches the regression at its source on
 * every run, where a verdict-side guard would instead fire on every synthetic pull request in this file --
 * noise that a reader learns to ignore, which is worse than no control at all. It also pins the ONE CALL:
 * the whole reason this field was worth adding is that it rides on a request the gate already makes.
 */
test("#2084 `reviewDecision` rides on readPrs's existing field list -- another field, never another call", () => {
  const calls: string[][] = [];
  readPrs((args: string[]) => { calls.push(args); return "[]"; });
  assert.equal(calls.length, 1, "one call, or the field stopped being free");
  assert.match(calls[0].join(" "), /reviewDecision/,
    "`pr-review-blocked` goes silently empty without it, and an empty cause looks exactly like a healthy queue");
});

test("prFiles omitted means no overlap is KNOWABLE, so every row is offered exactly as before", () => {
  const orders = decide({ prs: [], readyRows: [regionRow(1452, ".github/workflows/release.yml")] });
  assert.deepEqual(orders.map((o: { subject: string }) => o.subject), ["row-1452"],
    "a caller that cannot read files must never be worse off than one that never asked");
});

test("the empty-shelf order says WHY the pool is empty, and BLOCKED is not the same as LANED", () => {
  const orders = decide({ prs: [], readyRows: [regionRow(1320, ".github/workflows/release.yml")],
    promotableRows: [{ number: 800, labels: [{ name: "backlog" }] }],
    prFiles: [prTouching(1695, ".github/workflows/release.yml")] });
  const [shelf] = orders.filter((o: { cause: string }) => o.cause === "ready-queue-empty");
  assert.match(shelf.prompt, /1 unlaned row\(s\) blocked \(#1320: overlaps #1695/);
  assert.doesNotMatch(shelf.prompt, /belong to a lane/,
    "no row here is laned -- saying so sends product-manager to an owner who has nothing to answer");
  assert.match(shelf.prompt, /NOT rows to promote past/,
    "a blocked row is waiting on a pull request; promoting over the same files just moves the refusal");
});

/**
 * #1885: `emptyShelfOrder` used to hardcode the PR-overlap sentence for every `poolBlocked` entry, even
 * one `partitionUnclaimed` shelved for a declared `blockedBy` wait -- a row with no comparable open PR
 * at all still read as "B4-blocked behind an open pull request". It must state that row's own reason.
 */
test("a row shelved on a declared blockedBy wait is named by ITS OWN reason, not a PR-overlap claim", () => {
  const waiting = { number: 1852, labels: [{ name: "ready" }],
    blockedBy: { nodes: [{ number: 1883, state: "OPEN" }, { number: 1878, state: "OPEN" }] } };
  const orders = decide({ prs: [], readyRows: [waiting],
    promotableRows: [{ number: 800, labels: [{ name: "backlog" }] }], prFiles: [] });
  const [shelf] = orders.filter((o: { cause: string }) => o.cause === "ready-queue-empty");
  assert.match(shelf.prompt, /1 unlaned row\(s\) blocked \(#1852: blocked by #1883, #1878 -- declared on the row/);
  assert.doesNotMatch(shelf.prompt, /B4-blocked behind an open pull request/,
    "prFiles is empty -- there is no PR to overlap with, so nothing may claim one blocked it");
});

// --- draining: finish what is in flight, take on nothing new (2026-09-18) ---

/**
 * WHY A WINDOW NEEDS MORE THAN AN OFF SWITCH. `ceo` announced a capture-free window for #63's history
 * purge and told `orchestrator` to hold the fleet; thirty minutes later two fresh agent branches had been
 * pushed, because the fleet has a hold and the work tick does not. Step 2 force-pushes a rewritten
 * history, so any branch created after the rewrite is stranded.
 *
 * And stopping the timer would have stranded them just as surely: the two drafts already open still
 * needed a reviewer verdict and a ready-marking to LAND. So the test that matters here is the pair --
 * what a drain withholds, and what it must keep delivering.
 */
const inFlight = () => [draft(1705, GREEN), { number: 1706, isDraft: true, headRefOid: HEAD,
  statusCheckRollup: GREEN, author: { login: "worker-tooling" }, labels: [],
  comments: [{ body: `Review of #1706 at \`${HEAD}\`, by reviewer: convinced` }] }];

test("a drain withholds every START cause, so nothing new is taken on", () => {
  const orders = decide({ prs: [], readyRows: [{ number: 90, labels: [{ name: "ready" }] }],
    promotableRows: [{ number: 91, labels: [{ name: "backlog" }] }], drain: true });
  assert.deepEqual(orders.map((o: { cause: string }) => o.cause), [],
    "a row claimed after the rewrite is a branch the force-push strands");
});

/**
 * THE POSITIVE CONTROL, and the reason a drain is a partition rather than an off switch. A drain that
 * withheld everything would pass the test above perfectly and would strand the very drafts the window is
 * waiting on -- which is precisely what stopping the timer would have done.
 */
test("a drain still delivers the FINISH causes -- work in flight must be able to land", () => {
  const causes = decide({ prs: inFlight(), readyRows: [], drain: true })
    .map((o: { cause: string }) => o.cause).sort();
  assert.deepEqual(causes, ["draft-awaiting-verdict", "draft-convinced-not-ready"],
    "the two open drafts needed a verdict and a ready-marking; a stopped tick strands both");
});

test("chairman-blocked survives a drain -- it is the WINDOW'S OWN subject", () => {
  const orders = decide({ prs: [], readyRows: [], chairmanBlocked: [blockedRow(63, 4)], drain: true, nowMs: IN_WINDOW });
  assert.deepEqual(orders.map((o: { cause: string }) => o.cause), ["chairman-blocked"],
    "during a transfer the chairman is the one doing the work; silencing their brief silences the "
    + "thing the drain exists to serve");
});

test("drain OFF changes nothing, so the flag cannot cost anything when it is not set", () => {
  const state = { prs: inFlight(), readyRows: [{ number: 90, labels: [{ name: "ready" }] }],
    promotableRows: [{ number: 91, labels: [{ name: "backlog" }] }] };
  assert.deepEqual(decide({ ...state }), decide({ ...state, drain: false }));
});

/**
 * THE PARTITION MUST BE TOTAL, and this is the assertion that makes adding a cause a DECISION. A new
 * cause that nobody classifies defaults to surviving a drain -- so a future `claim-abandoned-row` would
 * quietly start new work inside a transfer window and nothing would say so. Spelling the other half out
 * means this test fails the moment `CAUSES` grows, and the author has to answer which kind it is.
 */
test("every cause is classified as START or FINISH -- a new one cannot default into a window", () => {
  const finish = CAUSES.filter((c: string) => !START_CAUSES.includes(c)).sort();
  assert.deepEqual([...START_CAUSES].sort(),
    ["blocked-unexaminable", "epic-finished", "epic-unfiled", "fleet-batch-due",
      "lane-backlog-unpromoted", "org-stalled", "ready-queue-empty", "ready-row-unclaimed",
      "unclaimed-blocker-cleared"]);
  // #2139: `unclaimed-blocker-cleared` is START, and it is `blocker-cleared`'s own argument read the
  // other way. The partition turns on whether the row is work in flight, and the ONLY difference between
  // the two causes is the claim -- which is exactly where that line falls. Nobody holds this row, so
  // promoting it is the org TAKING ON work, and a window is for landing what is already begun.
  // #1969: `pr-green-unarmed` is FINISH. A drain stops the org TAKING ON work and must not stop it
  // finishing what is in flight -- and a green, unheld, unarmed pull request is the most finished work
  // there is. Withholding it during a window would strand exactly the PRs the window is waiting to land.
  // #2110: `claimed-row-amended` is FINISH, and a drain is where withholding it would cost most -- a
  // window exists to LAND what is in flight, and a constraint that goes unread during one is a build
  // finished against a rule nobody applied.
  // #2031: `row-branch-unshipped` is FINISH, and a drain is where withholding it would cost MOST rather
  // than least. Step 2 of #63's history-purge runbook force-pushes a rewritten history, and every
  // unlanded branch on `origin` at that moment is stranded by it -- a window exists so the org can find
  // out what is still in flight before that happens. It also starts no work: the work already exists.
  // #2174: `host-units-stale` is FINISH, and a drain is the window where withholding it would cost MOST.
  // A drain does not stop the org running -- the work tick that EMITS this cause is itself one of the
  // units that can go stale, and step 2 of #63's history-purge runbook force-pushes a rewritten history
  // to the very checkout a unit's `WorkingDirectory=` names. It also starts no work by the partition's
  // own definition: its subject is a machine that is already wrong, not a row anybody has yet to pick up,
  // and the action is minutes rather than a build.
  // #2356: `trunk-red` is FINISH, and a drain is a window where withholding it costs most. A red `main` is
  // the branch every in-flight pull request lands on, so a window waiting to land them is waiting on the
  // fix; and it takes on nothing new -- the work is repairing what was already merged.
  // #2209: `pr-merge-conflict` is FINISH, for `pr-review-blocked`'s argument: a green, unheld pull request
  // that cannot merge is finished work that cannot land, and a window waits on exactly those.
  // #2365: `verdict-comment-unreviewed` is FINISH: its subject is a green, unheld pull request whose verdict
  // exists and cannot merge, which is finished work a window is waiting to land.
  // #2401: `reviewer-auth-failed` is FINISH: a reviewer that cannot authenticate is the reason in-flight pull
  // requests cannot land, and a window waiting to land them is waiting on the login. It starts no work.
  // #2163: `disk-headroom-low` is FINISH: it starts no work, and a drain is precisely when nobody is looking, so a full
  // disk that a window silenced would be found by the first session to fail with ENOSPC, which is the outage it exists for.
  // #2084: `pr-review-blocked` is FINISH, and it is `pr-green-unarmed`'s own argument one surface over.
  // A pull request that is green, unheld and refused by GitHub's `reviewDecision` is finished work that
  // cannot land -- it is the most in-flight thing there is, and it takes on nothing. Withholding it during
  // a window would strand precisely the pull requests the window is waiting to land, which is the failure
  // `START_CAUSES` was split out to prevent.
  // #2416: `awaiting-evidence-stale` is FINISH: its subject is a pull request already open and waiting on a run,
  // which a window that is landing in-flight work cares about, and it takes on nothing new.
  // #2470: `claim-stalled` is FINISH, and an ACTION cause (in `JUDGMENT_CAUSES` neither): its subject is a row a session already
  // holds, which a drain exists to land, and a release only returns the row to a pool that a drain already withholds.
  // #2075: `row-off-board` is FINISH, and a JUDGMENT cause. Boarding a row takes on no work -- the row is already filed, and
  // what is wrong is that the chairman's view cannot see it -- and rows are still filed during a drain.
  // #1959: `pr-codeowner-review-missing` is FINISH, `pr-review-blocked`'s own argument one surface over: a
  // pull request CODEOWNERS assigns to `ceo` with no approval from `ceo` is finished work that cannot land
  // once #1756's flip turns the gap into a hard merge block, and a drain is the window where leaving it
  // unreviewed would cost most. It starts no work: the pull request already exists.
  // #2691: `row-call-count-signal` is FINISH, and a JUDGMENT cause. Its subject is a row a session already
  // holds -- the plainest case of work in flight there is -- and reading the signal starts no new work:
  // `product-manager` deciding to split, or not, is a judgment over a row that already exists.
  // #2711: `answer-label-unexplained` is FINISH, and an ACTION cause (in `JUDGMENT_CAUSES` neither):
  // `claim-stalled`'s own argument -- its subject is a row a session already holds, which a drain exists to
  // land, and the two remedies (post the question, remove the label) start no new work.
  // #2791: `ready-row-incomplete` is FINISH, and a JUDGMENT cause. It starts no work -- it asks `product-manager` to
  // AMEND a row so a later claim can succeed, which a window has no reason to hold back.
  // #2729: `lab-job-finished` is FINISH, and a JUDGMENT cause. Its subject is a row a session already holds and the
  // result of a job that session already dispatched -- the plainest work in flight there is -- and it starts nothing:
  // it replaces the holder polling `lab:status`. A window that withheld it would leave the holder to poll again.
  // #2781: `primary-stale` is FINISH, and an ACTION cause: it starts no work, it tells `ceo` the gate is running from old code, and
  // a drain is when withholding it would cost most (the drain window ends in a force-push to this very checkout).
  // #2823: `closes-unresolved-repo-wide` is FINISH, and a JUDGMENT cause. Its subject is pull requests already open whose
  // declared rows GitHub will not close, which the post-merge closer covers -- it starts no work, it names a fault to a reader.
  // #2848: `repeating-log-line` and `backlog-aged-unpromoted` are FINISH, and JUDGMENT causes. Neither starts work: one names a fault
  // in the tick's own journal and the other asks `product-manager` to decide about a row already filed, and a drain is when
  // nobody reads the journal.
  // #2938: `org-retrospective` is FINISH too. It starts no work -- it asks `ceo` to LOOK at how the org is doing, and a drain is when
  // that is most worth doing, so a window must not withhold it.
  // #2845: `ready-row-unclaimable` is FINISH too. It starts no work -- it asks `product-manager` to unstick a row the claim keeps
  // refusing -- and a drain is when a stuck row most needs to be seen, since the pool's engineers are withheld anyway.
  // #2936: `org-health` is FINISH, and a JUDGMENT cause. It starts no work -- it tells `ceo` that nothing is landing, a red PR is unattended, a row
  // is refused or the primary is stale -- and a drain is exactly when an org that is not landing anything should be told.
  assert.deepEqual(finish, ["answer-label-unexplained", "answer-owed", "awaiting-evidence-stale", "backlog-aged-unpromoted", "blocker-cleared", "chairman-answered", "chairman-blocked",
    "claim-stalled", "claimed-row-amended", "closes-unresolved-repo-wide", "disk-headroom-low", "draft-awaiting-verdict", "draft-convinced-not-ready", "host-units-stale",
    "lab-job-finished", "org-health", "org-retrospective", "pr-checks-failing", "pr-codeowner-review-missing", "pr-green-unarmed", "pr-merge-conflict", "pr-review-blocked", "primary-stale", "ready-row-incomplete", "ready-row-unclaimable", "repeating-log-line", "reviewer-auth-failed",
    "row-branch-unshipped", "row-call-count-signal", "row-off-board", "trunk-red", "verdict-comment-unreviewed", "verdict-not-convinced"]);
  for (const cause of START_CAUSES) {
    assert.ok(CAUSES.includes(cause), `${cause} is withheld by a drain but no longer exists`);
  }
});

test("the drain switch is a FILE, because turning a window on and off is an ssh away", () => {
  assert.match(DRAIN_MARKER, /\/\.cache\/a11ign\/drain$/,
    "it sits beside the wake ledger: one directory holds the org's runtime state");
  assert.equal(draining("/some/marker", () => true), true);
  assert.equal(draining("/some/marker", () => false), false);
});

// --- the dead man's switch: a cause that fires on the ABSENCE of causes (2026-09-19) ---

/**
 * EVERY OTHER CAUSE FIRES ON A POSITIVE STATE -- a draft exists, a row is unclaimed, a check is red. None
 * can fire on NOTHING HAPPENING, and that is the failure mode this org actually has. `work-gate` exits
 * QUIET when no known cause matched, and that single exit covers two different worlds: "there is
 * genuinely nothing to do" and "there is plenty to do and no cause can see it". They were
 * indistinguishable, so the absence of a signal was reported as health.
 *
 * Measured over 48 hours: a worker unable to capture for 4.9 days; #63 step 9 unstarted for 18 hours with
 * the publish blocked behind it; ten rows gated on a condition that had become true; a session stopped
 * behind a menu. Every time the gate was honestly QUIET and every session honestly idle.
 */
test("nothing fired and rows are open -- the org is stalled and ceo is told", () => {
  const order = stalledOrder({ orders: [], openRows: 56 });
  assert.equal(order?.session, "ceo", "a management question, not a queue one");
  assert.equal(order?.cause, "org-stalled");
  assert.equal(order?.discriminator, "56", "the count, so a tracker that moved is a new question");
  assert.match(order?.prompt ?? "", /NOT the org being finished/,
    "the whole point is distinguishing an empty queue from an unreachable one");
});

/**
 * THE POSITIVE CONTROL, and the one that matters most: a switch that fires beside real work is noise, and
 * noise is how a real signal gets filtered out. The pattern's own literature is blunter about this
 * failure than about the missing-switch one.
 */
test("it stays silent whenever ANY other cause fired", () => {
  assert.equal(stalledOrder({ orders: [{ cause: "ready-row-unclaimed" }], openRows: 56 }), null,
    "one order anywhere means some cause can still reach the org");
});

test("an EMPTY tracker is not a stall -- it is the one silence that is healthy", () => {
  assert.equal(stalledOrder({ orders: [], openRows: 0 }), null,
    "an org with no open rows has finished; paging for that teaches people to ignore the page");
});

test("a REFUSED read is not an empty tracker, and must not be read as either state", () => {
  assert.equal(stalledOrder({ orders: [], openRows: null }), null,
    "#1286's rule: null is 'could not ask', and guessing a stall from it would page on a gh outage");
});

test("org-stalled is a JUDGMENT cause and a START cause, and both matter", () => {
  assert.ok(CAUSES.includes("org-stalled"), "it must be in CAUSES or worker-profile refuses it at run time");
  assert.ok(START_CAUSES.includes("org-stalled"),
    "a drain makes the org idle ON PURPOSE -- a switch that fires during a transfer window is one people "
    + "learn to ignore");
});

/**
 * THE GATE ACTS ON THE ONE THING IT ALREADY KNOWS.
 *
 * `draft-convinced-not-ready` woke `product-manager` to run one `gh pr ready` on a fact the gate had
 * already parsed -- measured on #1730 and #1748, where the woken session's whole contribution was a
 * comment restating the reviewer's verdict. `reviewer.md` line 129 never asked for that step: "a
 * provisional `convinced` IS the verdict: the author marks ready on it".
 */
test("a convinced verdict from a REVIEWER carries the ready-flip as an action", () => {
  const at = [{ body: "Review of #7 at `abc12345`, by `reviewer`: convinced." }];
  const [order] = decide({ prs: [draft(7, GREEN, at)], readyRows: [] }) as { cause: string,
    action?: { kind: string, pr: number } }[];
  assert.equal(order.cause, "draft-convinced-not-ready");
  assert.deepEqual(order.action, { kind: "ready", pr: 7 },
    "the gate parsed this verdict already -- waking a session to re-read it is the turn being removed");
});

test("a verdict the opener did not attribute, or one the AUTHOR signed, still wakes a human", () => {
  // `verdictAtHead` returns `byIsAuthor: null` when the opener named nobody (#1244) and refuses to
  // guess. Automating THAT case would arm a draft on a verdict nobody is accountable for, which is the
  // one shape `ceo`'s one-in-five spot-check exists to catch. `=== false` and not `!== true`.
  const unattributed = [{ body: "Review of #7 at `abc12345`: convinced." }];
  const [anon] = decide({ prs: [draft(7, GREEN, unattributed)], readyRows: [] }) as { cause: string,
    action?: unknown }[];
  assert.equal(anon.cause, "draft-convinced-not-ready", "it is still the same cause");
  assert.equal(anon.action, undefined, "but the gate does not arm a draft on an unsigned verdict");

  // And a verdict the PR's own author wrote is the other half of the same rule.
  const selfSigned = [{ body: "Review of #7 at `abc12345`, by `worker-judge`: convinced." }];
  const [own] = decide({ prs: [draft(7, GREEN, selfSigned)], readyRows: [] }) as { action?: unknown }[];
  assert.equal(own.action, undefined, "an author cannot mark their own draft ready by reviewing it");
});

test("performActions does the work and wakes nobody", () => {
  const calls: string[][] = [];
  const lines: string[] = [];
  const orders = [{ session: "product-manager", cause: "draft-convinced-not-ready",
    action: { kind: "ready", pr: 7 } }];
  const { delivered, performed } = performActions(orders, (args: string[]) => { calls.push(args); return ""; },
    (line: string) => lines.push(line));
  assert.deepEqual(calls, [["pr", "ready", "7"]], "one gh call, and it is the one the session would have run");
  assert.equal(performed, 1);
  assert.deepEqual(delivered, [], "nothing left to deliver, so no session is woken for it");
  assert.match(lines.join(""), /DID ready pr-7/, "and the tick log says what the gate did on its own");
});

test("a FAILED action falls back to the session, and says why", () => {
  // The worst case must be exactly today's behaviour. An action that swallowed its own failure would
  // turn a visible wake into an invisible nothing -- the direction this repository has paid for before.
  const lines: string[] = [];
  const orders = [{ session: "product-manager", cause: "draft-convinced-not-ready", prompt: "...",
    action: { kind: "ready", pr: 7 } }];
  const { delivered, performed } = performActions(orders, () => { throw new Error("gh: not authorised"); },
    (line: string) => lines.push(line));
  assert.equal(performed, 0);
  assert.deepEqual(delivered, [{ session: "product-manager", cause: "draft-convinced-not-ready",
    prompt: "..." }], "the original order is delivered, with the spent action stripped off it");
  assert.match(lines.join(""), /COULD NOT ready pr-7: .*not authorised.*delivering to product-manager/);
});

test("an order with no action passes through untouched", () => {
  const orders = [{ session: "reviewer", cause: "draft-awaiting-verdict", causeKey: "k" }];
  const { delivered, performed } = performActions(orders, () => { throw new Error("must not be called"); });
  assert.equal(performed, 0);
  assert.deepEqual(delivered, orders, "every other cause still reaches its session exactly as before");
});

/**
 * ONLY A CHECK THAT CAN HOLD THE PULL REQUEST COUNTS AS RED.
 *
 * MEASURED 2026-09-19: `main`'s branch protection requires exactly one check, `required_status_checks:
 * ["gate"]`, and `gate` is an aggregator whose `needs` names the nine jobs that matter. `sweep` lives in
 * `auto-arm.yml` and is in nobody's `needs` -- it went red on #1750 at 14:34Z, the gate woke
 * `worker-capture` to "fix the cause on that branch", and #1750 MERGED FOUR MINUTES LATER at 14:38:46Z.
 * The check was genuinely red; the wake could never have been useful.
 */
const rollupOf = (entries: [string, string][]) => entries.map(([name, conclusion]) => ({
  __typename: "CheckRun", name, status: "COMPLETED", conclusion,
}));

test("a red check that cannot block the merge wakes nobody", () => {
  const pr = { number: 1750, isDraft: false, headRefOid: "7a9d8340aaaaaaaa", author: { login: "x" },
    labels: [{ name: "session:worker-capture" }], comments: [],
    statusCheckRollup: rollupOf([["gate", "SUCCESS"], ["ts / run", "SUCCESS"], ["sweep", "FAILURE"]]) };
  assert.deepEqual(decide({ prs: [pr], readyRows: [], required: ["gate"] }), [],
    "sweep is in nobody's needs -- #1750 merged four minutes after this exact wake was sent");
});

test("a red check that CAN block the merge still wakes its session", () => {
  // THE POSITIVE CONTROL. #1650 is why `failingChecksOrder` exists: a `changeset` failure sat unattended
  // while its own session was idle. Narrowing what counts as red must not reopen that.
  const pr = { number: 1650, isDraft: false, headRefOid: "deadbeefcafe0000", author: { login: "x" },
    labels: [{ name: "session:worker-capture" }], comments: [],
    statusCheckRollup: rollupOf([["gate", "FAILURE"], ["sweep", "SUCCESS"]]) };
  const [order] = decide({ prs: [pr], readyRows: [], required: ["gate"] }) as { cause: string,
    session: string }[];
  assert.equal(order.cause, "pr-checks-failing");
  assert.equal(order.session, "worker-capture", "and it goes to the session named on the PR");
});

test("#2538 the pr-checks-failing order keeps its (a)/(b)/(c) triage and drops the tail the preamble already says", () => {
  const pr = { number: 1650, isDraft: false, headRefOid: "deadbeefcafe0000", author: { login: "x" },
    labels: [{ name: "session:worker-capture" }], comments: [],
    statusCheckRollup: rollupOf([["gate", "FAILURE"]]) };
  const [order] = decide({ prs: [pr], readyRows: [], required: ["gate"] }) as { prompt: string }[];
  for (const kept of ["(a) a real defect on your branch", "(b) a run that tested a `main` since fixed", "(c) a check that could not ASK"]) {
    assert.ok(order.prompt.includes(kept), `the triage is useful and stays: ${kept}`);
  }
  assert.ok(order.prompt.endsWith("Read the failing job to see which."), "and the order now ends where the triage does");
  assert.doesNotMatch(order.prompt, /nobody answers|not yours to fix/, "the closing 'say so on the PR' repeated the preamble");
});

test("an UNREADABLE required set counts every check, exactly as before it existed", () => {
  // `null` is "could not be read", NOT "nothing is required". Conflating them would make the gate go
  // permanently silent on red PRs the first time an API read failed -- trading a wasted turn for the
  // failure this whole function was written to stop.
  const pr = { number: 1750, isDraft: false, headRefOid: "7a9d8340aaaaaaaa", author: { login: "x" },
    labels: [{ name: "session:worker-capture" }], comments: [],
    statusCheckRollup: rollupOf([["gate", "SUCCESS"], ["sweep", "FAILURE"]]) };
  const orders = decide({ prs: [pr], readyRows: [], required: null });
  assert.equal(orders.length, 1, "fail OPEN: an unreadable required set must never silence a red PR");
  assert.deepEqual(blockingChecks([{ name: "sweep" }], null), [{ name: "sweep" }],
    "null considers everything");
  assert.deepEqual(blockingChecks([{ name: "sweep" }, { name: "gate" }], ["gate"]), [{ name: "gate" }]);
});

test("a PR carrying none of the required checks is not reported as red", () => {
  // If `gate` never ran, there is no required check to be red about. The rollup is not empty, but the
  // BLOCKING rollup is -- and `checksSettledGreen([])` is `null` (unknowable), never `false`.
  const pr = { number: 99, isDraft: false, headRefOid: "aaaaaaaabbbbbbbb", author: { login: "x" },
    labels: [], comments: [], statusCheckRollup: rollupOf([["sweep", "FAILURE"]]) };
  assert.deepEqual(decide({ prs: [pr], readyRows: [], required: ["gate"] }), []);
});

/**
 * #1916: a superseded run's CANCELLED check is NO VERDICT while the replacement still runs (#1007's ruling).
 * The fixture is #1924's head `c0864658`, 2026-09-22: the required `gate` exists ONLY in the cancelled run
 * 35717172571, and the live run 35717174536's `ts / run` is still in progress.
 */
const cancelledGateWhile = (live: Record<string, unknown>) => ({ number: 1924, isDraft: false,
  headRefOid: "c0864658aaaaaaaa", author: { login: "x" }, labels: [{ name: "session:worker-capture" }],
  comments: [], statusCheckRollup: [
    { __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "CANCELLED",
      detailsUrl: "https://github.com/a11ign/a11ign/actions/runs/35717172571/job/1" },
    { __typename: "CheckRun", name: "ts / run", detailsUrl: "https://github.com/a11ign/a11ign/actions/runs/35717174536/job/2",
      ...live },
  ] });

test("a CANCELLED required check wakes nobody while another run on the head is still going -- #1916", () => {
  const pr = cancelledGateWhile({ status: "IN_PROGRESS", conclusion: null });
  assert.deepEqual(decide({ prs: [pr], readyRows: [], required: ["gate"] }), [],
    "#1914 and #1924 both went CLEAN minutes after this exact wake was sent");
  assert.deepEqual(decide({ prs: [pr], readyRows: [], required: null }), [],
    "and the unreadable-required path agrees");
});

test("a CANCELLED required check with nothing else running is still red and still reaches its author", () => {
  // THE POSITIVE CONTROL, and #1605's caveat: a cancelled `gate` that is genuinely the last word held a PR
  // BLOCKED. Without this, a predicate that ignored CANCELLED altogether would pass the test above.
  const settled = cancelledGateWhile({ status: "COMPLETED", conclusion: "SUCCESS" });
  const [order] = decide({ prs: [settled], readyRows: [], required: ["gate"] }) as { cause: string,
    session: string }[];
  assert.equal(order?.cause, "pr-checks-failing", "nothing is in flight, so nobody else will ever answer it");
  assert.equal(order.session, "worker-capture");
});

test("a real FAILURE beside a CANCELLED one is red even while something runs -- #1916", () => {
  const running = [{ name: "ts / run", status: "IN_PROGRESS" }];
  const cancelled = { name: "gate", status: "COMPLETED", conclusion: "CANCELLED" };
  const failed = { name: "changeset", status: "COMPLETED", conclusion: "FAILURE" };
  assert.equal(redOnlyBySupersededRun([cancelled], [cancelled, ...running]), true);
  assert.equal(redOnlyBySupersededRun([cancelled, failed], [cancelled, failed, ...running]), false,
    "only a cancellation is no-verdict; a failure has answered");
  assert.equal(redOnlyBySupersededRun([cancelled], [cancelled]), false, "nothing running: the last word");
  assert.equal(redOnlyBySupersededRun([], running), false, "no red at all is not this function's case");
});

/**
 * #2400: A HOLD IS AN ANSWER. #2376 carried `hold:product-manager` on purpose; the hold turned `deliberateRefusals`
 * red and `gate` with it, and the gate ordered `product-manager` to fix a cause it had itself placed -- 35 times,
 * then `needs:chairman`. The fixture is that PR's shape: no `session:` label and nobody else to name, so (#2941) the order would go to `ceo` -- and a hold
 * by ANY session is the answer for a PR nobody owns, which is what keeps #2376 quiet now that `product-manager` is not the addressee.
 */
const HELD_RED = [["deliberateRefusals", "FAILURE"], ["gate", "FAILURE"], ["ts / run", "SUCCESS"]] as [string, string][];
const heldPr = (labels: string[], checks: [string, string][] = HELD_RED) => ({ number: 2376, isDraft: true,
  headRefOid: "b7fd42fe00000000", author: { login: "x" }, labels: labels.map((name) => ({ name })), comments: [],
  statusCheckRollup: rollupOf(checks) });
const failingOrders = (pr: unknown, required: string[] | null) =>
  (decide({ prs: [pr], readyRows: [], required }) as { cause: string, session: string, causeKey: string, prompt: string }[])
    .filter((o) => o.cause === "pr-checks-failing");

test("a PR red ONLY from its addressee's own hold generates no failing-checks order -- #2400", () => {
  // BOTH required-set spellings: with `gate` the only required check the blocking set is `[gate]`, and `null`
  // (unreadable) counts every check, so the exemption has to hold on each.
  for (const required of [["gate"], null]) {
    assert.deepEqual(failingOrders(heldPr(["hold:product-manager"]), required), [],
      `hold:product-manager and only deliberateRefusals + gate red (required=${JSON.stringify(required)})`);
  }
});

test("the same two red jobs WITHOUT the hold still order -- the null is the exemption, not an empty rollup", () => {
  // THE POSITIVE CONTROL (clause 4), and also "the hold is removed": the order comes back on the next tick.
  for (const required of [["gate"], null]) {
    const [order, ...rest] = failingOrders(heldPr([]), required);
    assert.equal(rest.length, 0);
    assert.equal(order?.session, "ceo");
    assert.equal(order?.causeKey, "ceo/pr-checks-failing/pr-2376/b7fd42fe");
  }
});

test("a THIRD red job ends the exemption, so a real failure under a hold still reaches its session", () => {
  const real: [string, string][] = [["deliberateRefusals", "FAILURE"], ["gate", "FAILURE"], ["ts / run", "FAILURE"]];
  for (const required of [["gate"], null]) {
    const [order] = failingOrders(heldPr(["hold:product-manager"], real), required);
    assert.equal(order?.causeKey, "ceo/pr-checks-failing/pr-2376/b7fd42fe",
      `required=${JSON.stringify(required)}: with gate the only REQUIRED check, reading the blocking set alone `
      + "would have called this the hold's doing");
  }
  const noHoldRed: [string, string][] = [["gate", "FAILURE"], ["changeset", "FAILURE"]];
  assert.equal(failingOrders(heldPr(["hold:product-manager"], noHoldRed), ["gate"]).length, 1,
    "a hold does not excuse a red gate whose cause is not the hold (deliberateRefusals is green here)");
});

test("ANY session's hold answers a PR red only from it, the owner's too -- #2993 narrows #2400's clause 1", () => {
  // #2400 clause 1 ("a hold by anyone else is not an answer from the session being asked") was written for a hold the ADDRESSEE placed.
  // For a hold the addressee is the SUBJECT of, the order asks "fix your build" and nothing in the build is broken (#2990, five orders).
  assert.deepEqual(failingOrders(heldPr(["hold:ceo"]), ["gate"]), [], "unowned and held by ceo, who is the last answer");
  assert.deepEqual(failingOrders(heldPr(["hold:worker-9"]), ["gate"]), [], "unowned and held by somebody: that is the answer");
  const labelled = (labels: string[], checks: [string, string][] = HELD_RED) => heldPr(["session:worker-5", ...labels], checks);
  const real: [string, string][] = [["deliberateRefusals", "FAILURE"], ["gate", "FAILURE"], ["ts / run", "FAILURE"]];
  for (const required of [["gate"], null]) {
    const where = `required=${JSON.stringify(required)}`;
    // (1) a foreign hold, owner worker-5: no order
    assert.deepEqual(failingOrders(labelled(["hold:ceo"]), required), [], `(1) worker-5's PR held by ceo ${where}`);
    assert.deepEqual(failingOrders(labelled(["hold:product-manager"]), required), [], `(1) held by product-manager ${where}`);
    assert.deepEqual(failingOrders(labelled(["hold:worker-5"]), required), [], `worker-5 holding its own PR ${where}`);
    assert.deepEqual(failingOrders(labelled(["hold:ceo", "hold:worker-5"]), required), [], `two holders ${where}`);
    // (2) a third red job under the same foreign hold still reaches the owner
    const [order, ...rest] = failingOrders(labelled(["hold:ceo"], real), required);
    assert.equal(rest.length, 0);
    assert.equal(order?.session, "worker-5", `(2) a real ts / run failure under a foreign hold ${where}`);
    // (3) the hold removed, same two red jobs: the null above is the exemption, not an empty rollup
    assert.equal(failingOrders(labelled([]), required)[0]?.session, "worker-5", `(3) no hold ${where}`);
  }
});

/**
 * #2935: A ROW-ROUTED ORDER IS QUIET UNDER A HOLD. #2882 addressed an unlabelled red PR to the session holding its row (`rowOwner`), so
 * the hold of the session it went to before that change stopped matching and #2883 was re-ordered every tick. Since #2993 no hold has to
 * match anybody: the exemption still ends with either key (a third red job, or the hold removed).
 */
test("a rowOwner-routed PR under any hold generates no order; a third red job or no hold brings it back -- #2935/#2993", () => {
  const routed = (labels: string[], checks: [string, string][] = HELD_RED) =>
    ({ ...heldPr(labels, checks), rowOwner: { session: "worker-2879", row: 2879, source: "closes" } });
  for (const required of [["gate"], null]) {
    assert.deepEqual(failingOrders(routed(["hold:product-manager"]), required), [],
      `hold:product-manager, row held by worker-2879 (required=${JSON.stringify(required)})`);
    assert.deepEqual(failingOrders(routed(["hold:worker-2879"]), required), [], "the row holder's own hold");
    assert.deepEqual(failingOrders(routed(["hold:ceo"]), required), [], "somebody else's hold (#2993)");
    const real: [string, string][] = [["deliberateRefusals", "FAILURE"], ["gate", "FAILURE"], ["ts / run", "FAILURE"]];
    assert.equal(failingOrders(routed(["hold:product-manager"], real), required)[0]?.session, "worker-2879", "third job red");
    assert.equal(failingOrders(routed([]), required)[0]?.session, "worker-2879", "hold removed");
  }
  const labelled = { ...heldPr(["session:worker-5", "hold:product-manager"]), rowOwner: { session: "worker-2879", row: 2879, source: "closes" } };
  assert.deepEqual(failingOrders(labelled, ["gate"]), [], "a labelled PR under product-manager's hold: no order either (#2993)");
});

test("HOLD_RED_JOBS names the jobs ci.yml defines, so the exemption cannot go stale on a rename", () => {
  const ci = readFileSync(join(HOME_CHECKOUT, ".github/workflows/ci.yml"), "utf8");
  assert.deepEqual([...HOLD_RED_JOBS], ["deliberateRefusals", "gate"]);
  for (const job of HOLD_RED_JOBS) assert.match(ci, new RegExp(`\\n {2}${job}:\\n`), `${job} is a job in ci.yml`);
});

/**
 * #2709: THE HOLD'S OWN RED MUST NOT BLOCK THE REVIEW QUESTION EITHER. `redOnlyFromHoldOf` (above) already
 * excuses a hold's own manufactured red from `pr-checks-failing`, keyed to ONE session -- the addressee.
 * `reviewableHead` asks a different question ("can anyone be asked for a verdict yet") and has no
 * addressee, so it needs the unkeyed form: ANY `hold:` label, not just a session-matching one. The fixture
 * is PR #2649's live shape: held by `orchestrator`, which is also its own `session:` label (so
 * `failingChecksOrder` reads the hold as its own answer and stays out of the way, the same as #2400's
 * fixture above), `deliberateRefusals` and `gate` red, everything else green.
 */
const holdOwnPr = (checks: [string, string][] = HELD_RED) => ({ number: 2649, isDraft: false,
  headRefOid: "2649cafe00000000", author: { login: "x" },
  labels: [{ name: "session:orchestrator" }, { name: "hold:orchestrator" }], comments: [],
  statusCheckRollup: rollupOf(checks) });

test("#2709: a hold's own manufactured red does not block the review question", () => {
  assert.equal(reviewableHead(holdOwnPr()), "2649cafe00000000",
    "settled green apart from the hold's own two jobs -- the review question can be asked");

  const [order, ...rest] = decide({ prs: [holdOwnPr()], readyRows: [] }) as { cause: string, session: string }[];
  assert.equal(rest.length, 0);
  assert.equal(order?.cause, "draft-awaiting-verdict",
    "end to end: draftOrder/perPullRequestOrders asks for a verdict rather than returning null at "
    + "`if (!head) return null`");
  assert.equal(order?.session, "reviewer-2649");

  assert.deepEqual(shouldBeMergingPrs([holdOwnPr()], null), [],
    "a hold must keep stopping the merge -- mergeCandidates/greenUnheldPrs are unaffected by this fix");
});

test("#2709: a hold does not excuse a REAL red check outside HOLD_RED_JOBS from the review question", () => {
  const realRed: [string, string][] = [...HELD_RED, ["changeset", "FAILURE"]];
  assert.equal(reviewableHead(holdOwnPr(realRed)), null,
    "a genuine failure beside the hold's own two jobs still blocks the review question");
  const orders = decide({ prs: [holdOwnPr(realRed)], readyRows: [] }) as { cause: string }[];
  assert.ok(!orders.some((o) => o.cause === "draft-awaiting-verdict"),
    "no reviewer is asked while a real check is red");
});

/**
 * Clauses 3 and 5: the escalation is read off what `deliver` is HANDED, so an order never emitted cannot reach the
 * breaker at all. The wake half is driven with the ledger already at the cap, which is #2376's state.
 */
test("a held PR at the cap stops appearing in stuck, and a real failure under the same hold still escalates -- #2400", () => {
  const at = (checkNames: [string, string][], labels = ["hold:product-manager"]) => {
    const orders = failingOrders(heldPr(labels, checkNames), ["gate"]);
    const counts = new Map(orders.map((o) => [o.causeKey, MAX_DELIVERIES]));
    const calls: string[][] = [];
    const { sent, stuck } = deliver(orders, [], [], { counts, run: () => { throw new Error("nothing may be sent"); } });
    const labelled = escalateStuck(stuck, (a: string[]) => { calls.push(a); return ""; }, () => {});
    return { orders, sent, stuck, labelled, calls };
  };
  const held = at(HELD_RED);
  assert.deepEqual([held.orders, held.stuck, held.labelled, held.calls], [[], [], [], []],
    "no order, so no stuck line, so no escalation label");
  const real = at([["deliberateRefusals", "FAILURE"], ["gate", "FAILURE"], ["changeset", "FAILURE"]]);
  assert.equal(real.orders.length, 1, "POSITIVE CONTROL: the order exists");
  assert.equal(real.stuck.length, 1, "and at the cap it is stuck, by the ordinary count");
  assert.deepEqual(real.labelled, [2376]);
  assert.deepEqual(real.calls, [["issue", "edit", "2376", "--add-label", "answer:ceo"]]);
});

test("a PR held by SOMEBODY ELSE at the cap is not stuck and gets no needs:chairman -- #2993", () => {
  const foreign = ["session:worker-5", "hold:ceo"];
  const at = (checkNames: [string, string][]) => {
    const orders = failingOrders(heldPr(foreign, checkNames), ["gate"]);
    const counts = new Map(orders.map((o) => [o.causeKey, MAX_DELIVERIES]));
    const calls: string[][] = [];
    const { stuck } = deliver(orders, [], [], { counts, run: () => { throw new Error("nothing may be sent"); } });
    const labelled = escalateStuck(stuck, (a: string[]) => { calls.push(a); return ""; }, () => {});
    return { orders, stuck, labelled, calls };
  };
  const held = at(HELD_RED);
  assert.deepEqual([held.orders, held.stuck, held.labelled, held.calls], [[], [], [], []], "(4) a foreign hold: nothing to escalate");
  const real = at([["deliberateRefusals", "FAILURE"], ["gate", "FAILURE"], ["ts / run", "FAILURE"]]);
  assert.equal(real.orders[0]?.session, "worker-5", "POSITIVE CONTROL: the owner is still ordered on a real failure");
  assert.equal(real.stuck.length, 1, "and at the cap it is stuck, by the ordinary count");
});

test("the expensive question is asked only when something is red", () => {
  const green = { statusCheckRollup: rollupOf([["gate", "SUCCESS"]]) };
  const red = { statusCheckRollup: rollupOf([["gate", "FAILURE"]]) };
  const pending = { statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status: "IN_PROGRESS" }] };
  assert.equal(anyChecksRed([green, pending]), false, "a healthy tick never pays the fourth call");
  assert.equal(anyChecksRed([green, red]), true);
  assert.equal(anyChecksRed([]), false);
});

const BRANCH_ANSWER = (contexts: string[] | null, isProtected = true) =>
  JSON.stringify({ protected: isProtected, contexts });

/**
 * #2117: THE `pr-checks-failing` PROMPT CARRIES WHEN THE FAILING RUN STARTED AND WHETHER `main` MOVED
 * SINCE -- A FACT, NEVER A PREDICATE. #2087 (2026-09-23): the gate held `startedAt` and threw it away, and two
 * sessions reached opposite readings of one PR. The fixture is the row's own open-check.
 */
const RED_CI = { name: "ci", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-23T09:07:00Z" };
const RED_2087 = {
  number: 2087, isDraft: true, headRefOid: "06a5230817c14f3f6dedf986c7d722201e1333eb",
  statusCheckRollup: [RED_CI],
  author: { login: "worker-judge" }, comments: [], labels: [{ name: "session:worker-judge" }],
};
const TIP_AFTER = { sha: "b08d5486bcafe0000", date: "2026-09-23T09:15:13Z" };
const TIP_BEFORE = { sha: "a1a1a1a1bcafe0000", date: "2026-09-23T09:00:00Z" };
type Order = { cause: string, prompt: string, session: string, subject: string, discriminator: string,
  causeKey: string };
const redOrder = (baseTip?: { sha: string, date: string } | null, pr: object = RED_2087) =>
  (decide({ prs: [pr], readyRows: [], baseTip }) as Order[]).find((o) => o.cause === "pr-checks-failing") as Order;

test("the pr-checks-failing prompt states when the failing run started", () => {
  const order = redOrder(TIP_AFTER);
  assert.ok(order.prompt.includes("2026-09-23T09:07:00Z"), `the start time is in the prompt: ${order.prompt}`);
});

test("the prompt says main HAS moved when its tip is dated after the run started", () => {
  const { prompt } = redOrder(TIP_AFTER);
  assert.match(prompt, /`main` has MOVED since/);
  assert.ok(prompt.includes("b08d5486"), "it names the tip so a reader can `git log` it");
  assert.doesNotMatch(prompt, /has NOT moved/);
});

test("the prompt says main has NOT moved when its tip is no later than the run's start", () => {
  const { prompt } = redOrder(TIP_BEFORE);
  assert.match(prompt, /`main` has NOT moved since/);
  assert.doesNotMatch(prompt, /has MOVED/);
});

test("an unread tip or a missing start time is UNKNOWN, never `has not moved`", () => {
  for (const baseTip of [null, undefined]) {
    const { prompt } = redOrder(baseTip);
    assert.match(prompt, /NOT READ this tick[^]*UNKNOWN/, "an unread tip is not evidence that main stood still");
    assert.doesNotMatch(prompt, /has NOT moved|has MOVED/);
  }
  const noStart = { ...RED_2087, statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "FAILURE" }] };
  const { prompt } = redOrder(TIP_AFTER, noStart);
  assert.match(prompt, /carried no start time[^]*UNKNOWN/);
  assert.doesNotMatch(prompt, /has NOT moved|has MOVED/);
});

test("the start quoted is the NEWEST failing check's, so `moved since` holds for every red check", () => {
  const two = { ...RED_2087, statusCheckRollup: [
    { name: "gate", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-23T09:07:00Z" },
    { name: "ts / run", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-23T09:20:00Z" },
    { name: "lint", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-23T09:30:00Z" }] };
  const { prompt } = redOrder(TIP_AFTER, two);
  assert.ok(prompt.includes("2026-09-23T09:20:00Z"), "a green check's later start is not the failing run's");
  assert.match(prompt, /has NOT moved/, "the tip at 09:15 precedes the 09:20 failing run");
});

test("the base having moved changes NO predicate: same session, subject, discriminator, causeKey", () => {
  // Done-when 2. The order's WORDS may differ; whether, to whom and under which key must not.
  const strip = (o: Order) => ({ ...o, prompt: "" });
  const baseline = strip(redOrder(null));
  for (const baseTip of [TIP_AFTER, TIP_BEFORE, undefined]) {
    assert.deepEqual(strip(redOrder(baseTip)), baseline);
  }
  assert.equal(baseline.cause, "pr-checks-failing");
  assert.equal(baseline.session, "worker-judge");
  assert.equal(baseline.subject, "pr-2087");
  assert.equal(baseline.discriminator, "06a52308");
  assert.equal(baseline.causeKey, "worker-judge/pr-checks-failing/pr-2087/06a52308");
  // And the moved base does not SILENCE a genuine red, nor conjure an order for a green PR.
  const green = { ...RED_2087, statusCheckRollup: [{ ...RED_CI, conclusion: "SUCCESS" }] };
  assert.equal(redOrder(TIP_AFTER, green), undefined, "a green PR gets no red order however far main moved");
});

/**
 * #3005: A RED PULL REQUEST THAT TURNS CONFLICTED AT THE SAME HEAD IS A NEW CAUSE. #2990 sat 63 minutes at one
 * `pr-checks-failing` key (delivered six times, owner idle) because a conflicting branch gets no `pull_request` run, so
 * the head and the red never changed while the work went from "fix the check" to "rebase".
 */
const MERGEABLE_2087 = { ...RED_2087, mergeStateStatus: "BLOCKED", mergeable: "MERGEABLE" };
const CONFLICTING_2087 = { ...RED_2087, mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" };
const MERGEABLE_KEY = "worker-judge/pr-checks-failing/pr-2087/06a52308";

test("#3005 a red CONFLICTING pull request is ordered with a prompt that names the conflict first", () => {
  const order = redOrder(null, CONFLICTING_2087);
  assert.equal(order.cause, "pr-checks-failing");
  assert.equal(order.session, "worker-judge", "same owner: only the cause changed");
  assert.match(order.prompt, /conflict/i);
  assert.ok(order.prompt.indexOf("CONFLICTS") < order.prompt.indexOf("WHICH FIX"), "the rebase is named before the triage");
  assert.doesNotMatch(redOrder(null, MERGEABLE_2087).prompt, /conflict/i, "POSITIVE CONTROL: a mergeable red PR says nothing of it");
});

test("#3005 the conflicted key differs from the mergeable key, and the mergeable key is today's literal", () => {
  assert.equal(redOrder(null, MERGEABLE_2087).causeKey, MERGEABLE_KEY, "a conflict-free red PR keeps its key byte for byte");
  assert.equal(redOrder(null, RED_2087).causeKey, MERGEABLE_KEY, "and so does one that carries no merge fields at all (UNKNOWN)");
  assert.equal(redOrder(null, CONFLICTING_2087).causeKey, `${MERGEABLE_KEY}/conflicting`);
});

test("#3005 through deliver: an order sent at the mergeable key is sent again once the PR conflicts at the same head", () => {
  const atCap = new Map([[MERGEABLE_KEY, MAX_DELIVERIES]]);
  const quiet = () => { throw new Error("nothing may be typed into a session in this test"); };
  const before = deliver([redOrder(null, MERGEABLE_2087)], [], [], { counts: atCap, run: quiet });
  assert.equal(before.stuck.length, 1, "POSITIVE CONTROL: at the cap the mergeable key is stuck, as in #2990");
  const after = deliver([redOrder(null, CONFLICTING_2087)], [], [], { counts: atCap, run: quiet });
  assert.deepEqual(after.stuck, [], "the same head, now conflicted, is a fresh key with a fresh count");
});

test("the prompt names BOTH regimes and chooses neither", () => {
  for (const baseTip of [TIP_AFTER, TIP_BEFORE, null]) {
    const { prompt } = redOrder(baseTip);
    assert.match(prompt, /stale merge ref[^]*PUSH or `update-branch`/, "regime 1: a push clears it");
    assert.match(prompt, /`gh run rerun` reuses the same merge ref and cannot clear it/);
    assert.match(prompt, /could not ASK[^]*`gh run rerun`[^]*nothing to push/, "regime 2: a re-run clears it");
    assert.match(prompt, /does not choose/, "and it says so, naming what decides");
    assert.match(prompt, /what the failing assertion names/);
  }
});

test("readBaseTip reads `commits/main`, and fails OPEN and LOUDLY on every unusable answer", () => {
  const calls: string[][] = [];
  const tip = readBaseTip((args: string[]) => { calls.push(args); return JSON.stringify(TIP_AFTER); });
  assert.deepEqual(tip, TIP_AFTER);
  assert.equal(calls[0][0], "api");
  assert.ok(calls[0][1].endsWith("/commits/main"), `one CORE read of main's tip commit: ${calls[0][1]}`);
  const logged: string[] = [];
  const log = (line: string) => logged.push(line);
  assert.equal(readBaseTip(() => { throw new Error("HTTP 403\nrate limit"); }, log), null);
  assert.match(logged[0], /CANNOT READ main's tip[^]*HTTP 403/);
  assert.equal(readBaseTip(() => "not json", log), null);
  assert.equal(readBaseTip(() => JSON.stringify({ sha: "abc", date: "yesterday" }), log), null,
    "an unparseable date must not be compared -- NaN > NaN is false, which would read as `not moved`");
  assert.equal(readBaseTip(() => JSON.stringify({ date: TIP_AFTER.date }), log), null);
  for (const sha of ["", "not-a-sha", "abc", 12345]) {
    assert.equal(readBaseTip(() => JSON.stringify({ sha, date: TIP_AFTER.date }), log), null,
      `a tip whose sha is ${JSON.stringify(sha)} is unusable, so the prompt says UNKNOWN rather than quoting a blank`);
  }
});

test("the tip is read ONLY on a red tick, and declared in GH_READS beside requiredCheckNames", () => {
  const calls: string[][] = [];
  const spy = (args: string[]) => { calls.push(args); return JSON.stringify(TIP_AFTER); };
  const green = { ...RED_2087, statusCheckRollup: [{ ...RED_CI, conclusion: "SUCCESS" }] };
  assert.equal(baseTipWhenRed([green], spy), null);
  assert.equal(baseTipWhenRed([], spy), null);
  assert.equal(calls.length, 0, "a healthy tick pays nothing");
  assert.deepEqual(baseTipWhenRed([RED_2087], spy), TIP_AFTER);
  assert.equal(calls.length, 1, "a red tick pays exactly one call");
  assert.ok(GH_READS.conditionalOnRedBase.includes("readBaseTip"));
  assert.ok(!GH_READS.unconditional.some((r: string) => r.includes("readBaseTip")), "never unconditional");
});

test("requiredCheckNames fails OPEN on every unusable answer", () => {
  assert.deepEqual(requiredCheckNames(() => BRANCH_ANSWER(["gate"])), ["gate"]);
  assert.equal(requiredCheckNames(() => { throw new Error("HTTP 404"); }), null,
    "a repo with no branch protection must not read as 'nothing blocks a merge'");
  assert.equal(requiredCheckNames(() => BRANCH_ANSWER([])), null, "an EMPTY required set is treated as unreadable");
  assert.equal(requiredCheckNames(() => "not json"), null);
});

/**
 * FAILING OPEN IN SILENCE IS INDISTINGUISHABLE FROM NEVER HAVING WORKED -- #2106.
 *
 * `requiredCheckNames` returned `null` on EVERY tick from the day #1750 shipped until 2026-09-23, and
 * the only sign was a bare `gh: Not Found (HTTP 404)` on stderr beside an exit 0 -- `defaultRun` inherits
 * stderr, so `gh`'s own message was the whole report. Four days of a dead optimisation. There was never a
 * correctness bug: the fallback counts every check, so no red pull request went unreported. What was lost
 * is the saving, and nothing said so.
 *
 * #2331 REMOVED THE CAUSE, NOT THE REPORT. The gate now reads `branches/main`, which a non-admin
 * credential can read, so the admin-only 404 that produced the four dead days is gone -- and with it the
 * `branches/main.protected` DISCRIMINATOR that existed to explain that 404 (#2022's FORBIDDEN-versus-ABSENT).
 * Nothing reaches a second read any more: the discriminator was the same endpoint as the read it explained.
 * The report itself stays, because `branches/main` can still be refused (network, a renamed trunk) and
 * "fails open" must still announce itself.
 *
 * THE TEST DRIVES THE THROWING CASE AND ASSERTS BOTH HALVES, because `null` alone is what the old code
 * already did. Only the report is new, and a test that checked the `null` would pass against the defect.
 */
const requiredWithLog = (run: (args: string[]) => string) => {
  const lines: string[] = [];
  const calls: string[][] = [];
  const required = requiredCheckNames((args: string[]) => { calls.push(args); return run(args); },
    (line) => { lines.push(line); });
  return { required, lines, calls };
};

/** The gate's credential, as GitHub answers it: the ADMIN endpoint is a 404, `branches/main` answers. */
const nonAdminGh = (branchAnswer: string) => (args: string[]) => {
  if (args.some((arg) => arg.includes("branches/main/protection"))) throw new Error("gh: Not Found (HTTP 404)");
  return branchAnswer;
};

test("the required checks are read through `branches/main` with the ADMIN endpoint answering 404 -- #2331", () => {
  const read = requiredWithLog(nonAdminGh(BRANCH_ANSWER(["gate"])));
  assert.deepEqual(read.required, ["gate"]);
  assert.deepEqual(read.lines, [], "and a read that works says nothing");
  assert.equal(read.calls.length, 1, "ONE call -- there is no discriminator left to pay for");
  assert.ok(read.calls.every((args) => args.every((arg) => !arg.includes("branches/main/protection"))),
    `no call may name the admin-only endpoint; saw ${JSON.stringify(read.calls)}`);
  assert.ok(read.calls[0].some((arg) => arg.endsWith("/branches/main")));
});

test("POSITIVE CONTROL: a protected branch with no list is the existing 'cannot read' outcome -- #2331", () => {
  // Without this, the test above is satisfied by any function that returns ["gate"].
  const noList = requiredWithLog(nonAdminGh(BRANCH_ANSWER(null)));
  assert.equal(noList.required, null, "protected, but nothing to read: fail open, never a default");
  assert.equal(noList.lines.length, 1);
  assert.match(noList.lines[0], /CANNOT READ the required checks/);
  assert.match(noList.lines[0], /no usable list of contexts/);
  assert.match(noList.lines[0], /"protected":true/, "the report quotes whether `main` is protected at all");

  // #2022 STILL HOLDS AND NEEDS NO DISCRIMINATOR: a refusal is `null` and never a claim about protection.
  const refused = requiredWithLog(() => { throw new Error("gh: Not Found (HTTP 404)"); });
  assert.equal(refused.required, null);
  assert.match(refused.lines[0], /REFUSED/);
  assert.doesNotMatch(refused.lines[0], /ABSENT|unprotected/,
    "a refused read says nothing about whether the trunk is protected");
  assert.equal(refused.calls.length, 1, "and a refusal is not followed by a second, diagnosing read");
});

test("the report cannot become tick noise on a healthy gate -- #2106", () => {
  // THE POSITIVE CONTROL, NAMED. Every assertion above is satisfied by a version that reports on every
  // tick, including the successful ones -- which would bury the failure it exists to surface.
  const healthy = requiredWithLog(() => BRANCH_ANSWER(["gate"]));
  assert.deepEqual(healthy.required, ["gate"], "the successful read is unchanged");
  assert.deepEqual(healthy.lines, [], "a gate that CAN read the contexts says NOTHING");
  assert.equal(healthy.calls.length, 1);

  const empty = requiredWithLog(() => BRANCH_ANSWER([]));
  assert.equal(empty.required, null);
  assert.match(empty.lines[0], /no usable list of contexts/);
  assert.doesNotMatch(empty.lines[0], /REFUSED/);
});

/**
 * `fleet-gated` ROUTES WORK; IT DOES NOT HIDE IT.
 *
 * The label's own definition on GitHub is "Acceptance needs the fleet or the lab; ORCHESTRATOR RUNS IT".
 * `NOT_PICKABLE` was read as a property of the ROW, so the label that says whose work it is also hid the
 * row from that session -- and `laneBacklogOrders` iterated lanes, which routed rows do not have.
 *
 * MEASURED 2026-09-19 with the fleet 10/10 ready, consistent, zero recoveries: `orchestrator` idle,
 * seven `lane:orchestrator` rows open, ZERO visible to the cause. Twelve `fleet-gated` rows in total.
 * And the deadlock that keeps it that way: #914 -- "a nightly fleet capture batch for every fleet-gated
 * row" -- is itself `fleet-gated`.
 */
const gated = (n: number, ...extra: string[]) => ({ number: n,
  labels: [{ name: "backlog" }, { name: "fleet-gated" }, ...extra.map((name) => ({ name }))] });

test("a fleet-gated row belongs to the pool of one now, and reaches it -- #1828, narrowed by #2506", () => {
  // #1828 made the pool two names (`orchestrator`, `worker-capture`); #2506 retired `worker-capture`, so it is
  // `orchestrator` alone. The order is still ONE PER POOL NAME, not one order naming the pool -- `wake.mjs`
  // routes an order to one session -- and the list shape is what a second name would ride on.
  const orders = decide({ prs: [], readyRows: [], promotableRows: [gated(914), gated(1296)] });
  const forRow914 = orders.filter((o: { cause: string, subject: string }) =>
    o.cause === "lane-backlog-unpromoted" && o.subject === "row-914");
  assert.deepEqual(forRow914.map((o: { session: string }) => o.session).sort(),
    ["orchestrator"],
    "#914 -- the row that would AUTOMATE draining the pile -- must reach the pool's member");
  for (const order of forRow914 as { prompt: string }[]) {
    assert.match(order.prompt, /#914/);
    assert.match(order.prompt, /ROUTES rather than blocks/);
    assert.match(order.prompt, /fleet:status/, "and it must not read as the fleet being broken");
  }
});

test("THE POOL'S VIEW IS UNCHANGED: no engineer is offered a fleet-gated row", () => {
  // The old reasoning stays correct and load-bearing: that work serialises behind physical hardware, so
  // counting it as capacity would report a queue five engineers could share when one would be waiting on
  // a worker box. Routing must not widen the pool by a single row -- widening WHO the pool routes to is
  // #1828's whole point, and this test is what proves the two are different claims.
  assert.deepEqual(ownerOf(gated(914)), ["orchestrator"]);
  assert.equal(ownerOf({ number: 1, labels: [{ name: "backlog" }] }), null, "unlaned is the pool");
  const orders = decide({ prs: [], readyRows: [], promotableRows: [gated(914)] });
  assert.ok(!orders.some((o: { session: string }) => o.session === "product-manager"),
    "a routed row is not an empty shelf being refilled -- the pool's count must not see it");
  assert.ok(!orders.some((o: { session: string }) => !["orchestrator"].includes(o.session)),
    "and a fleet-gated row's orders never name anyone outside its own pool");
});

test("a LANE beats a routing label, because only one of them is access control", () => {
  // `lane:ceo` refuses every other session unconditionally at claim time. A routing label only says whose
  // hands the acceptance needs. Telling orchestrator about a lane:ceo row would name a row they cannot take.
  assert.equal(ownerOf(gated(1, "lane:ceo")), "ceo");
  assert.equal(ownerOf(gated(2, "lane:orchestrator")), "orchestrator");
});

test("routing says WHOSE the work is, never that it can start", () => {
  // `blocked`, `epic` and a claim still hide a row from everybody, including the session it routes to --
  // NOT_STARTABLE is strictly smaller than NOT_PICKABLE, and this is the difference that matters.
  // `readPromotableRows` returns `null` for a REFUSED read, which is a different answer from "none
  // promotable" -- so the helper asserts it got a list before asking what is in it, rather than letting
  // a null slide through as an empty one. That distinction is the whole point of the return type.
  const read = (rows: unknown[]) => {
    const got = readPromotableRows(() => JSON.stringify(rows));
    assert.ok(got !== null, "the fixture read must not be refused");
    return got;
  };
  assert.deepEqual(read([gated(914)]).map((r: { number: number }) => r.number), [914]);
  assert.deepEqual(read([gated(1042, "blocked")]), [], "blocked hides it from its owner too");
  assert.deepEqual(read([gated(44, "epic")]), [], "an epic is a container, not work, for anyone");
  assert.deepEqual(read([gated(1567, "in-progress")]), [], "and a claimed row is somebody's already");
});

test("NOT_PICKABLE now names meta too (#1804), and NOT_STARTABLE is still derived from it", () => {
  // DERIVED, NEVER RETYPED. Two hand-maintained lists that must stay in step is the defect this repo
  // names as its most expensive; the pool's list is the source and the owner's is subtraction.
  //
  // `meta` joined the pin deliberately on 2026-09-20 (#1804): a container/process row is not routed to
  // anyone, so it belongs in the POOL's list rather than only in the owner's subtraction -- unlike
  // `fleet-gated`, there is no session `meta` should still reach.
  assert.deepEqual(NOT_PICKABLE, ["blocked", "fleet-gated", "epic", "disputed", "decision",
    "awaiting-merge", "review-only", "meta", "in-progress"], "the POOL's view moved once, on purpose");
  // TWO SUBTRACTIONS NOW, NOT ONE. `fleet-gated` comes out because `ROUTED_TO` sends it to a fixed
  // session; `decision` comes out because `ownerOf` sends it to its LANE OWNER, or to
  // `product-manager` when it has no lane. Measured 2026-09-21: four `decision` rows were open and not
  // one was visible to any cause -- #1734 ("the gate can only see GitHub objects") had sat unreachable
  // for days while being cited as awaiting a ruling, and #1817 was filed for `ceo` with a label that
  // guaranteed `ceo` would never see it.
  assert.deepEqual(NOT_STARTABLE,
    NOT_PICKABLE.filter((n: string) => !(n in ROUTED_TO) && n !== "decision"));
  assert.ok(!NOT_STARTABLE.includes("fleet-gated"));
  assert.ok(!NOT_STARTABLE.includes("decision"), "a decision must still reach whoever owns it");
  assert.ok(NOT_STARTABLE.includes("blocked"), "routing subtracts only what it routes");
  assert.ok(NOT_STARTABLE.includes("meta"), "a meta row is not routed, so it stays excluded for everyone");
});

test("a backlog+meta row is not promotable (#1804): #20 stopped re-asking a settled judgment", () => {
  // #20 ("Daily board report") is a permanent thread carrying exactly `backlog`+`meta`, with `epic`
  // correctly removed on 2026-09-20 -- and `meta` alone did not exclude it, so `ready-queue-empty` fired
  // on the same settled judgment every time the shelf emptied.
  const read = (rows: unknown[]) => {
    const got = readPromotableRows(() => JSON.stringify(rows));
    assert.ok(got !== null, "the fixture read must not be refused");
    return got;
  };
  const dailyReport = { number: 20, labels: [{ name: "backlog" }, { name: "meta" }] };
  assert.deepEqual(read([dailyReport]), [], "a container/process row has no Region/Acceptance to promote");
});

test("a backlog row carrying needs:chairman is not promotable (#2604): nobody but the chairman can move it", () => {
  // #2561 carried `needs:chairman` and was counted as the third of three promotable rows, so the
  // empty-shelf order read 3 where the truthful reading was 2. #2585 fixed `unclaimedClearings`; this is
  // the second reader of the same gap.
  const read = (rows: unknown[]) => {
    const got = readPromotableRows(() => JSON.stringify(rows));
    assert.ok(got !== null, "the fixture read must not be refused");
    return got.map((r: { number: number }) => r.number);
  };
  const base = [{ name: "backlog" }, { name: "lane:any" }];
  const waiting = { number: 9001, labels: [...base, { name: CHAIRMAN_LABEL }], blockedBy: { nodes: [] } };
  const startable = { number: 9002, labels: base, blockedBy: { nodes: [] } };
  assert.deepEqual(read([waiting]), [], "a needs:chairman row is not stock");
  // POSITIVE CONTROL: the same row without the label is still counted, so the emptiness above is not a
  // look at nothing.
  assert.deepEqual(read([startable]), [9002], "the row without the label is counted exactly as before");
  assert.deepEqual(read([waiting, startable]), [9002], "only the labelled row of a mixed shelf is dropped");
});

test("a backlog row carrying parked is not promotable (#2653): `ceo` schedules it when its prerequisite phase is done", () => {
  // The third reader of the gap #2583 and #2604 closed for `needs:chairman`. The row is dropped in the reader, so
  // the two consumers of its list (`laneBacklogOrders`, `decide`'s pool count) inherit the skip; the row-by-row
  // pins for those consumers are below.
  const read = (rows: unknown[]) => {
    const got = readPromotableRows(() => JSON.stringify(rows));
    assert.ok(got !== null, "the fixture read must not be refused");
    return got.map((r: { number: number }) => r.number);
  };
  const base = [{ name: "backlog" }, { name: "lane:any" }];
  const parked = { number: 9001, labels: [...base, { name: PARKED_LABEL }], blockedBy: { nodes: [] } };
  const startable = { number: 9002, labels: base, blockedBy: { nodes: [] } };
  assert.deepEqual(read([parked]), [], "a parked row is not stock");
  // POSITIVE CONTROL: the same row without the label is still counted, so the emptiness above is not a look at nothing.
  assert.deepEqual(read([startable]), [9002], "the row without the label is counted exactly as before");
  assert.deepEqual(read([parked, startable]), [9002], "only the labelled row of a mixed shelf is dropped");

  // END TO END, the two consumers of that list: a lane owner's `lane-backlog-unpromoted` and the pool's
  // `ready-queue-empty`, each fed through the real reader.
  const causes = (rows: unknown[]) => decide({ prs: [], readyRows: [],
    promotableRows: readPromotableRows(() => JSON.stringify(rows)) ?? [] })
    .map((o: { cause: string }) => o.cause);
  const parkedCeo = { number: 9003, labels: [{ name: "backlog" }, { name: "lane:ceo" }, { name: PARKED_LABEL }] };
  const unparkedCeo = { ...parkedCeo, labels: [{ name: "backlog" }, { name: "lane:ceo" }] };
  assert.deepEqual(causes([parked, parkedCeo]), [], "a shelf of only parked rows asks nobody to promote anything");
  // POSITIVE CONTROLS, the same two rows without the label: each consumer DOES fire, so the empty list above is the
  // label's doing and not a fixture that never yields an order.
  assert.ok(causes([unparkedCeo]).includes("lane-backlog-unpromoted"), "the lane owner is asked about an unparked row");
  assert.ok(causes([startable]).includes("ready-queue-empty"), "product-manager is asked about an unparked pool row");
});

/**
 * #1899, measured live at the 2026-09-22 ~06:41Z `ready-queue-empty` tick: #1889 (`backlog`,
 * `answer:ceo`) and #1878 (`backlog`, `lane:any`, `answer:orchestrator`) both already carry the correct
 * `answer:<session>` label -- established by the 2026-09-19 chairman's direction as "waiting on another
 * session to answer" -- and `answerOrders` is already independently waking that session about each. Ei
 * ther counted as promotable anyway, because `NOT_STARTABLE` is a literal list and `answer:<session>` is
 * a prefix over one name per session, never a member of it.
 */
test("a row carrying answer:<session> is not promotable (#1899): it is already routed to whoever owes "
  + "the answer, not unpickable and not unlaned", () => {
  const read = (rows: unknown[]) => {
    const got = readPromotableRows(() => JSON.stringify(rows));
    assert.ok(got !== null, "the fixture read must not be refused");
    return got;
  };
  const answerCeo = { number: 1889, labels: [{ name: "backlog" }, { name: `${ANSWER_PREFIX}ceo` }] };
  const answerOrchestrator = { number: 1878,
    labels: [{ name: "backlog" }, { name: "lane:any" }, { name: `${ANSWER_PREFIX}orchestrator` }] };
  assert.deepEqual(read([answerCeo]), [], "routed to ceo for the answer -- not the pool's to promote");
  assert.deepEqual(read([answerOrchestrator]), [],
    "answer: excludes it even alongside lane:any, which alone would not");

  // THE POSITIVE CONTROL: a row with no `answer:` label at all is unaffected.
  const plain = { number: 1900, labels: [{ name: "backlog" }] };
  assert.deepEqual(read([plain]).map((r: { number: number }) => r.number), [1900],
    "a row with no answer: label must still promote exactly as before");

  // END TO END: `ready-queue-empty` no longer re-asks a shelf that is only these two rows.
  const orders = decide({ prs: [], readyRows: [], promotableRows: read([answerCeo, answerOrchestrator]) });
  assert.deepEqual(orders, [], "both rows are already correctly parked -- the shelf is genuinely empty");
});

/**
 * THE BOUNDED-WINDOW INVARIANT, GUARDED -- the hole `reviewer` found in #1769 and could not post.
 *
 * #1769 narrowed "red" to the required checks and called `newestPerName` at the read site to satisfy
 * `local/bounded-window-reads`. `reviewer` then MUTATED that call away -- passing the raw rollup -- and
 * ALL 65 TESTS STAYED GREEN. The lint rule caught it at authoring time; nothing caught it at test time,
 * so a future edit that dropped the narrowing would ship silently.
 *
 * WHAT THE REGRESSION WOULD DO: `statusCheckRollup` UNIONS superseded runs, so a check that failed at
 * 10:00 and succeeded at 11:00 appears TWICE. Read raw, the old FAILURE makes a green pull request look
 * red and the gate wakes its session to "fix the cause on that branch" -- exactly the wasted prompt
 * #1769 exists to stop, arriving through the fix for it. `merge-queue.mjs` had this defect until #634.
 *
 * The verdict never reached the PR: #1769 merged while the review was running, and `reviewer` correctly
 * refused to comment on a closed pull request. It was relayed by the chairman instead.
 */
test("a SUPERSEDED red run does not wake anyone -- the newest run per name is what counts", () => {
  const twice = { number: 1, isDraft: false, headRefOid: "abc12345aaaaaaaa", author: { login: "x" },
    labels: [{ name: "session:worker-capture" }],
    // A verdict at head, so the only order this fixture can produce is the red one (#2176).
    comments: [{ body: "Review of #1 at `abc12345`, by `reviewer`: convinced." }],
    statusCheckRollup: [
      { __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "FAILURE",
        completedAt: "2026-09-19T10:00:00Z" },
      { __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS",
        completedAt: "2026-09-19T11:00:00Z" },
    ] };
  assert.deepEqual(decide({ prs: [twice], readyRows: [], required: ["gate"] }), [],
    "the 11:00 SUCCESS supersedes the 10:00 FAILURE -- reading the union reports a green PR as red");

  // AND THE POSITIVE CONTROL, or the assertion above passes for a version that reports nothing at all:
  // reverse the times and the newest run IS the failure, which must still wake its session.
  const newestIsRed = { ...twice, statusCheckRollup: [
    { __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS",
      completedAt: "2026-09-19T10:00:00Z" },
    { __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "FAILURE",
      completedAt: "2026-09-19T11:00:00Z" },
  ] };
  const [order] = decide({ prs: [newestIsRed], readyRows: [], required: ["gate"] }) as
    { cause: string }[];
  assert.equal(order?.cause, "pr-checks-failing", "a genuinely red newest run must still be reported");
});

/**
 * "TWO `GH` CALLS, NO MODEL" IS THIS ORG'S SHORTHAND FOR THE GATE, AND IT WAS WRONG.
 *
 * `main` has made FOUR unconditional reads since long before the recent causes. The number was true when
 * the file was written and nobody re-counted it while three readers were added -- then #1769's own
 * comment repeated it, and `reviewer` caught it by counting the call sites rather than trusting the
 * sentence. This test is why the next person inherits a checked number.
 */
test("the gate's read count is counted, not remembered", () => {
  // ELEVEN since #2936 added the last-merge read (`readLastMergedAt`: one REST call, core pool) that `org-health.mjs`'s no-merge signal needs.
  // TEN since #2641 added the merged-or-closed pull request answer read (`readClosedAnswerRows`'s third call; one
  // `label list` still serves both searches).
  // NINE since #2075 added the per-issue Project 1 membership read (`readRowsOffBoard`: one GraphQL call per 100 open rows).
  // EIGHT since #2202 added the closed-row answer read (two calls, both exact -- see `readClosedAnswerRows`).
  // SIX since #2356 added the trunk read (`readTrunkRed`: one REST call, core pool). It was FIVE since
  // `answer-owed` landed. This pin caught that read within a minute of it being added, which
  // is exactly why it exists: the number it replaced ("two `gh` calls") had been wrong for months
  // because three readers arrived and nobody re-counted.
  assert.equal(GH_READS.unconditional.length, 11,
    "if you add or remove an unconditional read, this number and every comment quoting it move together");
  // #1938 REMOVED THE SILENCE-CONDITIONAL READ ENTIRELY: the dead man's switch now derives its
  // answer from the rows the unconditional read already fetched. The key is GONE rather than empty,
  // so a reader cannot quote a name that no longer exists.
  assert.ok(!("conditionalOnSilence" in GH_READS),
    "nothing is conditional on silence any more -- the second open-rows read was deleted");
  assert.ok(GH_READS.conditionalOnEmptyShelf.includes("readEpics"));
  assert.ok(GH_READS.conditionalOnRed.includes("requiredCheckNames"));
  // #2110: THE CLAIMED-ROW READ IS CONDITIONAL AND SERVER-SIDE FILTERED, and both halves are pinned
  // because both are what keep it bounded. `--label in-progress` is the filter; without it this would be
  // 500 rows of comment bodies on every tick, which is the read the row's own budget paragraph forbids.
  assert.ok(GH_READS.conditionalOnClaimedRows.includes("--label in-progress"),
    "the page must be the claimed rows and nothing else -- a full-population comments read is the cost "
    + "this cause was told not to buy");
  assert.ok(GH_READS.conditionalOnClaimedRows.includes("readClaimedRowComments"));
  // #2356: the trunk read is ONE call when main is healthy, and its four follow-ups are paid only by a red.
  assert.ok(GH_READS.unconditional.some((r) => r.includes("readTrunkRed")));
  assert.ok(GH_READS.conditionalOnRedTrunk.includes("readTrunkRed"));
});

/**
 * A DECLARED WAIT DROPS OUT, AND COMES BACK BY ITSELF.
 *
 * THE PROPERTY THAT MATTERS IS NOT THE HIDING -- `blocked` already hides. It is that nobody has to
 * REMEMBER to un-hide. `blocked` is a claim with no referent, so only a human re-reading the row can
 * clear it, which is why 11 rows carried it on 2026-09-19 with several waiting on conditions that had
 * long since become true.
 *
 * AND NO NEW CAUSE IS NEEDED, which is the strongest evidence this is the right seam: when the condition
 * clears, the row re-enters the population, the owner's COUNT changes, the causeKey changes, the wake
 * ledger's dedupe no longer matches, and the EXISTING cause fires. It composes with what is there
 * instead of adding a parallel mechanism beside it.
 */
const waitingRow = (n: number, extra: Record<string, unknown>) => ({ number: n,
  labels: [{ name: "backlog" }, { name: "lane:ceo" }], ...extra });

test("a row waiting on an OPEN blocker leaves its owner's backlog, and returns when it closes", () => {
  const open = [waitingRow(5, { blockedBy: { nodes: [{ number: 1772, state: "OPEN" }] } })];
  const closed = [waitingRow(5, { blockedBy: { nodes: [{ number: 1772, state: "CLOSED" }] } })];
  const read = (rows: unknown[]) => {
    const got = readPromotableRows(() => JSON.stringify(rows));
    assert.ok(got !== null, "a fixture read is never refused -- `?? []` here would hide a real refusal");
    return got;
  };

  assert.deepEqual(read(open), [], "while #1772 is open the row is not startable");
  assert.equal(read(closed)?.length, 1, "and the moment it closes the row is back -- nobody un-hid it");

  // THE RE-ENGAGEMENT, end to end: no order while blocked, and a real order once cleared.
  assert.deepEqual(decide({ prs: [], readyRows: [], promotableRows: read(open) }), []);
  const [order] = decide({ prs: [], readyRows: [], promotableRows: read(closed) }) as
    { session: string, causeKey: string }[];
  assert.equal(order.session, "ceo");
  assert.match(order.causeKey, /lane-backlog-unpromoted\/row-5/,
    "keyed on the ROW (#1799), so one row's judgment is not reopened when another row moves");
});

test("a row waiting on a DATE stops re-prompting its owner until that date", () => {
  // #1234 exactly: gated on wall-clock time, its owner woken every 2h to give the same answer, about 18
  // more times before the date it waits for.
  const row = [waitingRow(1234, { body: "Not-before: 2026-09-21" })];
  const read = (today: string) => {
    const orig = Date.now;
    Date.now = () => new Date(`${today}T12:00:00Z`).getTime();
    try {
      const got = readPromotableRows(() => JSON.stringify(row));
      assert.ok(got !== null, "a fixture read is never refused");
      return got;
    } finally { Date.now = orig; }
  };
  assert.deepEqual(read("2026-09-19"), [], "silent on the 19th and the 20th");
  assert.equal(read("2026-09-21")?.length, 1, "and back on the day itself, with no human involved");
});

test("a waiting READY row is SHELVED with its reason, never silently dropped", () => {
  // A row that vanishes without a line in the log is the failure `blocked` already is. `reportWithheld`
  // prints these, so a reader can see what the gate is deliberately not offering and why.
  const ready = [{ number: 7, labels: [{ name: "ready" }],
    blockedBy: { nodes: [{ number: 1772, state: "OPEN" }] } }];
  const { offerable, blocked } = partitionUnclaimed(ready, []);
  assert.deepEqual(offerable, []);
  assert.equal(blocked.length, 1);
  assert.match(blocked[0].reason, /blocked by #1772 .*clears itself/,
    "the shelf line must name the blocker, or it is the referent-less claim again");
});

test("A CORRECTLY WAITING QUEUE IS NOT A STALL -- the dead man's switch must not cry wolf", () => {
  // #1749's own comment says an alarm that fires when the org is SUPPOSED to be idle is the failure the
  // pattern's literature warns about more loudly than the missing-switch one. A queue where every row
  // declares what it waits on is working, not stuck.
  const allWaiting = [{ number: 1, blockedBy: { nodes: [{ number: 9, state: "OPEN" }] } },
    { number: 2, body: "Not-before: 2099-01-01" }];
  assert.equal(openRowState(allWaiting)?.reachable, 0,
    "zero REACHABLE rows, so nothing to be stalled about");
  assert.equal(stalledOrder({ orders: [], openRows: 0 }), null);

  // AND THE POSITIVE CONTROL: one row that could move and is not moving still fires the switch.
  const oneReachable = [...allWaiting, { number: 3 }];
  assert.equal(openRowState(oneReachable)?.reachable, 1);
  assert.equal(stalledOrder({ orders: [], openRows: 1 })?.cause, "org-stalled");
});

test("a REFUSED read is still refused, not read as a queue with nothing reachable", () => {
  // `null` means "could not ask" and must never collapse into 0, which would silence the switch on the
  // first API hiccup -- #1286's rule, and the filter added above must not have broken it. Since #1938
  // the refusal arrives as the un-coalesced `readOpenRows()` result rather than being re-read here, so
  // what `null` means is decided at the ONE place that knows: `readOpenRows`'s own catch.
  assert.equal(openRowState(null), null);
  assert.equal(openRowState(undefined), null, "a missing read is refused, not an empty tracker");
  assert.equal(openRowState("not an array" as unknown as unknown[]), null);
  assert.equal(stalledOrder({ orders: [], openRows: null }), null);
  // AND THE POSITIVE CONTROL for the whole family: an ARRAY is read, never refused -- including the
  // empty one, which genuinely means the tracker is empty and must not come back as `null`.
  assert.deepEqual(openRowState([]),
    { reachable: 0, waiting: { dates: [], blocked: [], answers: [], total: 0 } });
});

/**
 * THE ASSERTION #1938 EXISTS TO PROTECT.
 *
 * Deleting the second open-rows read is a one-line change; keeping the REFUSAL is not. `main` holds the
 * open rows as `readOpenRows() ?? []`, and feeding that to the switch would read a `gh` outage as a
 * healthy silent org -- silencing the dead man's switch on exactly the tick it matters most (#1286).
 *
 * THE OUTCOME ALONE CANNOT TELL THEM APART, which is why the refusal must SAY so. `stalledOrder` returns
 * no order for `null` (could not ask) and for `0` (nothing reachable) alike, so a coalesced refusal would
 * be invisible from outside: no order, no line, no difference. The stderr line is the observable, and it
 * is what fails if the `?? []` is threaded through by mistake.
 */
test("a REFUSED open-rows read reaches the switch as null, and the switch says it could not ask", () => {
  const lines: string[] = [];
  const log = (line: string) => { lines.push(line); };
  assert.deepEqual(deadMansSwitch({ orders: [], drain: false, openRows: null, log }), [],
    "a refused read produces no order -- it is not evidence of a stall either way");
  assert.match(lines.join(""), /CANNOT ASK whether the org is stalled/,
    "a refused read must not be reported as a quiet queue, the same rule `main` applies to the other lanes");

  // THE POSITIVE CONTROL, AND IT IS THE `?? []` ITSELF: an empty tracker is a real, healthy silence and
  // says nothing. If a refusal were coalesced to `[]` upstream, the line above would be missing here.
  const empty: string[] = [];
  assert.deepEqual(deadMansSwitch({ orders: [], drain: false, openRows: [],
    log: (line: string) => { empty.push(line); } }), []);
  assert.deepEqual(empty, [], "an empty tracker is the org being finished, not the gate being blind");

  // AND THE SWITCH STILL FIRES on rows it CAN see, or none of the above proves anything.
  const [order] = deadMansSwitch({ orders: [], drain: false, openRows: [{ number: 3 }], log }) as
    { cause: string, discriminator: string }[];
  assert.equal(order?.cause, "org-stalled");
  assert.equal(order?.discriminator, "1", "the reachable count is the discriminator, derived not re-read");
});

/**
 * THE WIRING, PINNED -- because the test above cannot see `main`.
 *
 * `deadMansSwitch` can be handed the right value and still be given the wrong one by its only caller.
 * `main` is not exported and exits the process, so this reads the source instead: whatever identifier it
 * passes as `openRows` must be assigned a BARE `readOpenRows()`. `const allOpen = readOpenRows() ?? []`
 * would not match, which is the mistake this row was filed to prevent.
 */
test("main hands the switch the UN-COALESCED read, not the `?? []` one", () => {
  const source = readFileSync(new URL("../work-gate.mjs", import.meta.url), "utf8");
  // EVERY `deadMansSwitch({...})` IN THE FILE, then the one that names `openRows` -- the declaration
  // spells the same parameter and would otherwise match first and report nothing.
  const calls = [...source.matchAll(/deadMansSwitch\(\{[^}]*\}\)/g)].map(([text]) => text);
  const name = calls.map((c) => c.match(/openRows:\s*(\w+)/)?.[1]).find(Boolean) ?? "";
  assert.ok(name, `main must pass openRows into the switch; found ${JSON.stringify(calls)}`);
  assert.match(source, new RegExp(`const ${name} = readOpenRows\\(\\);`),
    `${name} must be the raw read -- a \`?? []\` here reads a gh outage as a healthy silent org (#1286)`);
  // AND THE READ ITSELF IS NOW ONE CALL, which is the other half of #1938's done-when.
  assert.equal(source.match(/"issue", "list", "--state", "open", "--limit", "500"/g)?.length, 1,
    "the gate asked for the same 500 open rows twice; the second was a strict subset of the first");
});

/**
 * THE CONDITION THE GATE ALREADY COMPUTED AND THREW AWAY (#1935).
 *
 * The gate has always called `waitingOn` on every open row and kept only `.length`. The answer
 * -- date or row, WHICH date, WHICH row -- was discarded in the same expression that produced it, and
 * `org-stalled` then paged `ceo` with a bare count. The 2026-09-22T18:30Z wake that found this cost an
 * hour of hand-reading twenty rows to recover what the gate had read that same tick.
 */
test("the one read returns BOTH halves: what could move, and what is stopping the rest", () => {
  const rows = [{ number: 1931, body: "Not-before: 2099-01-01" }, { number: 3 },
    { number: 1926, blockedBy: { nodes: [{ number: 1918, state: "OPEN" }] } }];
  const state = openRowState(rows);
  assert.equal(state?.reachable, 1, "the count is unchanged -- a waiting row is still not startable");
  assert.equal(state?.waiting.total, 2, "and now the gate can also SAY what the other two are waiting on");
});

test("waitingBreakdown groups by date, sorts earliest first, and ignores CLOSED blockers", () => {
  const breakdown = waitingBreakdown([
    { number: 600, body: "Not-before: 2026-09-28" },
    { number: 1889, body: "## Not-before: 2026-09-23" },
    { number: 1931, body: "Not-before: 2026-09-23" },
    // A CLOSED BLOCKER IS A CONDITION THAT HAS CLEARED -- `waitingOn` drops it, and this row is neither
    // waiting nor counted. Without this case the breakdown could re-report the rot it exists to remove.
    { number: 42, blockedBy: { nodes: [{ number: 9, state: "CLOSED" }] } },
    { number: 1926, blockedBy: { nodes: [{ number: 1918, state: "OPEN" }] } },
  ], "2026-09-22");
  assert.deepEqual(breakdown.dates, [{ date: "2026-09-23", numbers: [1889, 1931] },
    { date: "2026-09-28", numbers: [600] }], "ISO dates sort lexically, so [0] is the earliest");
  assert.deepEqual(breakdown.blocked, [{ number: 1926, on: [1918] }]);
  assert.equal(breakdown.total, 4, "four of the five rows wait -- the closed blocker's does not");
});

test("org-stalled NAMES the waiting conditions, grouped, with the earliest date called out", () => {
  // The state measured on the wake that filed #1935: 12 of 20 open rows waiting, 6 date and 6 row, four
  // of the dates clearing the next day. "The org is stalled" and "the org is waiting until tomorrow" are
  // different facts and used to produce the identical page.
  const waiting = waitingBreakdown([
    { number: 1931, body: "Not-before: 2026-09-23" }, { number: 1889, body: "Not-before: 2026-09-23" },
    { number: 1663, body: "Not-before: 2026-09-23" }, { number: 1042, body: "Not-before: 2026-09-23" },
    { number: 1520, body: "Not-before: 2026-09-28" }, { number: 600, body: "Not-before: 2026-09-28" },
    { number: 1926, blockedBy: { nodes: [{ number: 1918, state: "OPEN" }] } },
    { number: 1756, blockedBy: { nodes: [{ number: 1931, state: "OPEN" }] } },
  ], "2026-09-22");
  const prompt = stalledOrder({ orders: [], openRows: 8, waiting })?.prompt ?? "";
  assert.match(prompt, /8 of the 16 open row\(s\) carry a machine-readable waiting condition/,
    "the totals a reader needs before opening the tracker at all");
  assert.match(prompt, /4 not before 2026-09-23 \(#1931 #1889 #1663 #1042\)/,
    "grouped by date and naming the rows -- `describeWaiting`'s wording, not a second copy of it");
  assert.match(prompt, /2 not before 2026-09-28 \(#1520 #600\)/);
  assert.match(prompt, /THE EARLIEST IS 2026-09-23/,
    "the date the org un-stalls by itself is the one fact that decides whether this is an incident");
  assert.match(prompt, /#1926 blocked by #1918; #1756 blocked by #1931/,
    "`blockedBy` is GitHub's own edge and the prompt never mentioned it before #1935");
  assert.match(prompt, /sustain itself across a date boundary/,
    "self-clearing is weaker than it reads: #1931's done-when needed a merge that could not happen");
  assert.equal(stalledOrder({ orders: [], openRows: 8, waiting })?.causeKey, "ceo/org-stalled/8",
    "the key stays the REACHABLE count: a date clearing moves a row into it, so it re-fires already");
});

/**
 * THE POSITIVE CONTROL FOR THE EMPTINESS THE case above ASSERTS AGAINST. A stall where NO row declares a
 * wait is the original defect -- every row stopped by a label, a lane or a claim -- and the wording that
 * says so must still be exactly what `ceo` reads. Without this, a bug that emitted the waiting paragraph
 * unconditionally, or dropped the old text, would pass every assertion above.
 */
test("no row carries a waiting condition -- the unexplained-stall wording survives untouched", () => {
  for (const order of [stalledOrder({ orders: [], openRows: 20 }),
    stalledOrder({ orders: [], openRows: 20, waiting: waitingBreakdown([{ number: 3 }], "2026-09-22") })]) {
    const prompt = order?.prompt ?? "";
    assert.match(prompt, /NOTHING IS REACHABLE/);
    assert.match(prompt, /`blocked`, `fleet-gated`, `epic`, a lane, a claim/,
      "the labels-and-lanes enumeration is still the right answer when nothing declares a wait");
    assert.match(prompt, /READ THE BACKLOG AND SAY WHY/);
    assert.doesNotMatch(prompt, /waiting condition|not before|blocked by #/,
      "a paragraph saying '0 rows are waiting' is noise on the page that matters most");
  }
});

/**
 * AN EPIC WITH NO CHILDREN IS WORK NOBODY HAS FILED -- the third instance of one defect.
 *
 *   `fleet-gated`  not the pool's | IS orchestrator's         -- fixed, ROUTED_TO
 *   `blocked`      not startable  | a claim with no referent  -- fixed, blockedBy/Not-before
 *   `epic`         not pickable   | NOBODY HAS FILED THIS YET -- this
 *
 * MEASURED 2026-09-20, and it is why the chairman found six engineers idle on a healthy fleet: 40 open
 * rows, 0 ready, 0 open PRs, ONE claimable row -- and that one titled "Human:" because it needs the
 * chairman. Meanwhile 17 open epics, 16 with zero sub-issues, nine also `fleet-gated`. #34 is the
 * plainest: "Sixteen built cases have never been captured." The org had not run out of work; it had run
 * out of FILED work, and no cause could tell the difference.
 */
const epic = (n: number, total = 0) => ({ number: n, title: `epic ${n}`,
  labels: [{ name: "backlog" }, { name: "epic" }], subIssuesSummary: { total, completed: 0 } });

test("an epic with no sub-issues is unfiled work; one with children is a real container", () => {
  assert.deepEqual(unfiledEpics([epic(34), epic(1317, 10)]).map((e) => e.number), [34],
    "#1317 has ten children and is doing its job; #34 has none and is hiding capture work");
  assert.deepEqual(unfiledEpics([]), []);
  assert.deepEqual(unfiledEpics(undefined as never), []);
});

test("it fires only when the shelf is EMPTY", () => {
  // An epic left whole while claimable work exists is a PRIORITY CALL, not a defect. It becomes the
  // org's most urgent question only when there is nothing else to pick up.
  assert.deepEqual(epicOrders([epic(34)], [{ number: 9 }]), [], "work on the shelf outranks filing more");
  const [order] = epicOrders([epic(34)], []) as { session: string, cause: string, discriminator: string }[];
  assert.equal(order.cause, "epic-unfiled");
  assert.equal(order.session, "product-manager", "filing is product-manager's lane");
  assert.equal(order.discriminator, "34", "keyed on the epic itself, not the shelf depth");
});

// --- #1799: an unrelated epic being filed must not re-litigate one already judged ---
test("the epic is the discriminator: filing an unrelated epic must not move another's causeKey", () => {
  // Measured against the live ledger, 2026-09-20: the same three epics (#69, #57, #20) were re-judged
  // from scratch four times in under an hour, each time because a DIFFERENT epic elsewhere was filed
  // and the count-based causeKey moved for reasons that had nothing to do with any of the three.
  const before = epicOrders([epic(34), epic(29), epic(31)], []) as
    { causeKey: string, discriminator: string }[];
  // #31 gets filed elsewhere; #34 and #29 are untouched.
  const after = epicOrders([epic(34), epic(29)], []) as { causeKey: string, discriminator: string }[];
  const keyFor = (orders: { discriminator: string, causeKey: string }[], n: number) =>
    orders.find((o) => o.discriminator === String(n))?.causeKey;
  assert.equal(keyFor(before, 34), keyFor(after, 34),
    "#34's own causeKey must survive #31 being filed, or JUDGMENT_TTL_MS can never protect it");
  assert.equal(keyFor(before, 29), keyFor(after, 29), "same for #29");
  assert.equal(keyFor(after, 31), undefined, "#31 is filed now -- its own order should be gone");
});

test("one order per unfiled epic, capped", () => {
  const many = Array.from({ length: MAX_ROW_ORDERS_PER_TICK + 3 }, (_, i) => epic(i + 1));
  assert.equal(epicOrders(many, []).length, MAX_ROW_ORDERS_PER_TICK,
    "a deep unfiled backlog still recruits product-manager once per tick, not once per epic");
});

test("a fully-filed backlog of epics says nothing at all", () => {
  // THE POSITIVE CONTROL: this cause must be capable of finding nothing, or it is a function that
  // always fires and `product-manager` learns to ignore it.
  assert.deepEqual(epicOrders([epic(1317, 10), epic(2, 3)], []), []);
  assert.deepEqual(epicOrders([], []), [], "and no epics at all is not a finding either");
});

test("the prompt points at the fleet, because that is where the idle capacity is", () => {
  const [order] = epicOrders([epic(34)], []) as { prompt: string }[];
  assert.match(order.prompt, /fleet-gated` epic is where the idle capacity is/);
  assert.match(order.prompt, /--parent 34/, "the epic->child link must be DATA, not prose");
  assert.match(order.prompt, /leaving it whole and recording why is a valid answer/,
    "some epics are correctly whole; a cause that demands splits would manufacture bad rows");
  assert.match(order.prompt, /READ ITS OWN RECENT COMMENTS FIRST/,
    "a durable answer already on the epic must not be re-derived from scratch");
});

test("readEpics refuses rather than reporting an empty backlog", () => {
  assert.equal(readEpics(() => { throw new Error("HTTP 502"); }), null);
  assert.equal(readEpics(() => "not json"), null);
  assert.deepEqual(readEpics(() => JSON.stringify([epic(34)]))?.map((e: { number: number }) => e.number),
    [34]);
});

test("epic-unfiled is classified in all three registries", () => {
  // `work-gate.test.ts`'s own partition test fails the moment CAUSES grows, which is what forces this.
  assert.ok(CAUSES.includes("epic-unfiled"));
  assert.ok(START_CAUSES.includes("epic-unfiled"),
    "splitting an epic MANUFACTURES work, which is what a drain window exists to stop");
});

/**
 * A QUESTION ONE SESSION OWES ANOTHER, SAID IN A FIELD RATHER THAN A SENTENCE.
 *
 * MEASURED OVERNIGHT 2026-09-20: `orchestrator` needed a ruling from `product-manager`, wrote the
 * question as a COMMENT on #914, and nothing in this org reads comments. It asked FIVE TIMES over 6.5
 * hours. `product-manager`'s own reply: "I should have confirmed sooner rather than let five asks go
 * unanswered since 01:55Z." Both behaved correctly; the escalation path simply had no mechanism behind
 * it, so it ran at the speed of someone happening to look.
 *
 * A LABEL AND NOT AN ASSIGNEE, decided by data: `repos/:o/:r/assignees` returns FOUR accounts which the
 * EIGHT sessions share, so an assignee structurally cannot say WHICH session owes the answer.
 */
const owedRow = (n: number, session: string) => ({ number: n,
  labels: [{ name: "backlog" }, { name: `${ANSWER_PREFIX}${session}` }] });

test("a row labelled answer:<session> wakes THAT session, not the pool", () => {
  const [order] = answerOrders([owedRow(914, "product-manager")]) as
    { session: string, cause: string, prompt: string }[];
  assert.equal(order.session, "product-manager");
  assert.equal(order.cause, "answer-owed");
  assert.match(order.prompt, /#914/);
  assert.match(order.prompt, /remove its `answer:product-manager` label/,
    "removing the label IS the act of answering -- there must be no second state to maintain");
});

test("two sessions owing answers get one order each, never one combined", () => {
  const owed = answersOwed([owedRow(1, "ceo"), owedRow(2, "product-manager"), owedRow(3, "ceo")]);
  assert.deepEqual([...owed.keys()].sort(), ["ceo", "product-manager"]);
  assert.deepEqual(owed.get("ceo")?.map((r: { number: number }) => r.number), [1, 3]);
  assert.equal(answerOrders([owedRow(1, "ceo"), owedRow(2, "product-manager")]).length, 2);
});

test("EACH ROW IS ITS OWN QUESTION, so answering one does not re-ask the others", () => {
  // #1799's rule, applied before it could bite here: a count-keyed order re-asks about every
  // outstanding question each time any ONE of them is answered.
  const both = answerOrders([owedRow(1, "ceo"), owedRow(2, "ceo")]) as { causeKey: string }[];
  assert.deepEqual(both.map((o) => o.causeKey),
    ["ceo/answer-owed/row-1", "ceo/answer-owed/row-2"]);
  const after = answerOrders([owedRow(1, "ceo")]) as { causeKey: string }[];
  assert.equal(after[0].causeKey, both[0].causeKey,
    "row 1's key is UNCHANGED by row 2 being answered -- that is the whole point");
});

test("a bare `answer:` names no session and is ignored", () => {
  // It would otherwise wake a session called "", which herdr reports as unknown and `wake` then counts
  // as an order with nowhere to go -- noise that looks like a real undelivered order.
  assert.equal(answersOwed([{ number: 1, labels: [{ name: "answer:" }] }]).size, 0);
  assert.equal(answersOwed([{ number: 1, labels: [{ name: "answer: " }] }]).size, 0);
});

test("rows owing nobody an answer produce nothing", () => {
  // THE POSITIVE CONTROL: this cause must be able to find nothing, or it fires forever and is muted.
  assert.deepEqual(answerOrders([{ number: 1, labels: [{ name: "backlog" }] }]), []);
  assert.deepEqual(answerOrders([]), []);
  assert.deepEqual(answerOrders(undefined as never), []);
});

test("it is delivered BEFORE every other cause", () => {
  // Every other order asks a session what should happen next. This one says another session is ALREADY
  // STOPPED waiting on them, which outranks any standing question.
  const orders = decide({ prs: [], readyRows: [], promotableRows: [],
    answerOwed: [owedRow(914, "product-manager")] }) as { cause: string }[];
  assert.equal(orders[0].cause, "answer-owed");
});

test("answer-owed is a WAKE cause and a FINISH cause, unlike the other three", () => {
  // 20-minute TTL, not the judgment two hours: this names a question someone is blocked on, and 6.5
  // hours is what the absence of any cadence already cost. And answering FINISHES work in flight, so a
  // drain wants it to happen rather than withholding it.
  assert.ok(CAUSES.includes("answer-owed"));
  assert.ok(!START_CAUSES.includes("answer-owed"), "a drain must not withhold an answer someone waits on");
});

/**
 * #2711: THE NATURAL NEIGHBOUR OF `answerOrders`. That cause wakes the NAMED session to answer; a bare
 * label with nothing posted since gives the addressee no way to tell a real question from a mistake, so
 * this wakes the row's own HOLDER instead, to post the question or remove the label. Live evidence:
 * `worker-2632` added `answer:ceo` to its own PR #2649 twice with no comment either time.
 */
const holderRow = (n: number, holder: string, owed: string) => ({ number: n,
  labels: [{ name: `${SESSION_PREFIX}${holder}` }, { name: `${ANSWER_PREFIX}${owed}` }] });
const timelineOf = (...events: unknown[]) => () => events.map((e) => JSON.stringify(e)).join("\n");

test("readRowTimeline parses NDJSON and refuses rather than reporting an empty timeline", () => {
  const ok = timelineOf({ event: "labeled", label: { name: "answer:ceo" }, created_at: "2026-09-26T12:42:47Z" });
  assert.deepEqual(readRowTimeline(2649, ok as never),
    [{ event: "labeled", label: { name: "answer:ceo" }, created_at: "2026-09-26T12:42:47Z" }]);
  assert.equal(readRowTimeline(2649, () => { throw new Error("HTTP 404"); }), null,
    "a refused read is null, never [] -- [] would read every bare label on it as unexplained");
});

test("a bare `answer:` label wakes the row's own HOLDER, never the addressee named in it", () => {
  const bare = timelineOf({ event: "labeled", label: { name: "answer:ceo" }, created_at: "2026-09-26T12:42:47Z" });
  const [order] = bareAnswerLabelOrders([holderRow(2649, "worker-2632", "ceo")], bare as never) as
    { session: string, cause: string, causeKey: string }[];
  assert.equal(order.session, "worker-2632", "the holder is woken, never `ceo`, who has nothing to answer");
  assert.equal(order.cause, "answer-label-unexplained");
  assert.match(order.causeKey, /^worker-2632\/answer-label-unexplained\/row-2649\/ceo\//);
});

test("a comment posted at or after the label answers it, and nothing fires", () => {
  const explained = timelineOf(
    { event: "labeled", label: { name: "answer:ceo" }, created_at: "2026-09-26T12:42:47Z" },
    { event: "commented", created_at: "2026-09-26T12:42:47Z" });
  assert.deepEqual(bareAnswerLabelOrders([holderRow(2649, "worker-2632", "ceo")], explained as never), []);
});

test("a row nobody currently holds has nobody this cause can wake", () => {
  const bare = timelineOf({ event: "labeled", label: { name: "answer:ceo" }, created_at: "2026-09-26T12:42:47Z" });
  assert.deepEqual(
    bareAnswerLabelOrders([{ number: 2649, labels: [{ name: "answer:ceo" }] }], bare as never), []);
});

test("answer-label-unexplained is FINISH and an ACTION cause, `claim-stalled`'s own classification", () => {
  assert.ok(CAUSES.includes("answer-label-unexplained"));
  assert.ok(!START_CAUSES.includes("answer-label-unexplained"),
    "its subject is a row the holder already holds, which a drain exists to land");
  assert.ok(!JUDGMENT_CAUSES.includes("answer-label-unexplained"),
    "the two remedies -- post the question, remove the label -- are one command each, not a standing "
    + "judgment to re-ask");
});

test("readOpenRows refuses rather than reporting an empty tracker", () => {
  assert.equal(readOpenRows(() => { throw new Error("HTTP 502"); }), null);
  assert.equal(readOpenRows(() => "not json"), null);
  const rows = [owedRow(914, "ceo"), { number: 2, labels: [{ name: "backlog" }] }];
  assert.equal(readOpenRows(() => JSON.stringify(rows))?.length, 2, "it returns EVERY open row...");
  assert.deepEqual(withAnswerLabel(rows).map((r: { number: number }) => r.number), [914],
    "...and each cause filters it, so one read serves both");
});

/**
 * A STANDING JUDGMENT IS KEYED ON THE THING JUDGED, NEVER ON A COUNT -- #1799, measured twice.
 *
 * `worker-judge` proved it for `epic-unfiled` and #1806 fixed that one. The SAME ledger showed the SAME
 * defect in `lane-backlog-unpromoted`: twelve deliveries to `orchestrator` over 10.4 hours --
 * /3 /3 /2 /2 /3 /4 /7 /6 /5 /3 /3 /3 -- of which SEVEN fired INSIDE the two-hour TTL, at gaps of 4, 18,
 * 4, 22, 27, 10 and 57 minutes. Each was a `sonnet`/`high` turn re-asking about rows already judged.
 */
test("one row leaving a lane does not reopen judgment on the rows that stayed", () => {
  const row = (n: number) => ({ number: n, labels: [{ name: "backlog" }, { name: "lane:ceo" }] });
  const five = decide({ prs: [], readyRows: [], promotableRows: [row(1), row(2), row(3)] })
    .filter((o: { cause: string }) => o.cause === "lane-backlog-unpromoted");
  const four = decide({ prs: [], readyRows: [], promotableRows: [row(1), row(2)] })
    .filter((o: { cause: string }) => o.cause === "lane-backlog-unpromoted");

  assert.deepEqual(five.map((o: { causeKey: string }) => o.causeKey),
    ["ceo/lane-backlog-unpromoted/row-1", "ceo/lane-backlog-unpromoted/row-2",
      "ceo/lane-backlog-unpromoted/row-3"]);
  assert.deepEqual(four.map((o: { causeKey: string }) => o.causeKey), five.slice(0, 2)
    .map((o: { causeKey: string }) => o.causeKey),
    "#3 leaving changes NOTHING about #1 and #2 -- under the old count key every one of them moved");
});

test("a lane's orders are capped like every other row order", () => {
  // Without the cap a lane of forty rows would emit forty orders in one tick, which is the noise
  // `MAX_ROW_ORDERS_PER_TICK` exists to bound.
  const many = Array.from({ length: 40 }, (_, i) => ({ number: i + 1,
    labels: [{ name: "backlog" }, { name: "lane:ceo" }] }));
  const orders = decide({ prs: [], readyRows: [], promotableRows: many })
    .filter((o: { cause: string }) => o.cause === "lane-backlog-unpromoted");
  assert.equal(orders.length, MAX_ROW_ORDERS_PER_TICK);
});

/**
 * `blocked` MUST NAME WHAT IT WAITS ON -- the root cause behind an empty queue, not the pile.
 *
 * THE THREE WHYS, run 2026-09-20 when the chairman asked why nobody was working:
 *   1. the engineer pool had ZERO claimable rows -- 1 of 38 free, and lane-owned
 *   2. the entire remaining supply was ELEVEN rows labelled `blocked`, untouched since 19 Sep
 *   3. nothing re-examines them: `blocked` is filtered out AT READ TIME by `NOT_STARTABLE`, and the
 *      nightly prose check caught 1 of 11 -- TEN WERE INVISIBLE TO EVERY CHECK IN THE SYSTEM
 *
 * The fourth why is where this fix belongs: #1780 added `blockedBy`/`Not-before:` as PREFERRED and left
 * `blocked` legal, unexaminable and unmigrated, so the pile both persisted and regenerated.
 */
const staleBlocked = (n: number, extra: Record<string, unknown> = {}) => ({ number: n, title: `row ${n}`,
  labels: [{ name: "backlog" }, { name: "blocked" }], ...extra });

test("a `blocked` row naming nothing is reported; one naming something is not", () => {
  const bare = staleBlocked(1731);
  const edge = staleBlocked(72, { blockedBy: { nodes: [{ number: 9, state: "OPEN" }] } });
  const dated = staleBlocked(1234, { body: "Not-before: 2099-01-01" });
  assert.deepEqual(blockedWithoutReferent([bare, edge, dated], "2026-09-20").map((r) => r.number),
    [1731], "a recorded blocker is examinable; a bare label is not");
});

test("it fires on the PROPERTY, so it catches new rows as well as today's pile", () => {
  // A cause that drained the existing eleven would fix the symptom. This one refuses any `blocked` that
  // says nothing, whenever it appears.
  const [order] = blockedReferentOrders([staleBlocked(1731)], [], "2026-09-20") as
    { session: string, cause: string, causeKey: string, prompt: string }[];
  assert.equal(order.session, "product-manager");
  assert.equal(order.cause, "blocked-unexaminable");
  assert.equal(order.causeKey, "product-manager/blocked-unexaminable/row-1731");
  assert.match(order.prompt, /--add-blocked-by/);
  assert.match(order.prompt, /Not-before: YYYY-MM-DD/);
  assert.match(order.prompt, /REMOVE the `blocked` label/);
});

test("`blocked` is NOT banned -- a wait neither mechanism can express is real", () => {
  // #1520 waits on a hosted-runner behaviour: not a row, not a date. What is refused is a `blocked` that
  // says NOTHING, not the label itself -- so the prompt offers a third answer.
  const [order] = blockedReferentOrders([staleBlocked(1520)], [], "2026-09-20") as { prompt: string }[];
  assert.match(order.prompt, /if the wait is real and none of those three can express it/);
  assert.match(order.prompt, /what\s+would clear it and who would notice/);
});

test("it waits for an empty shelf, like epic-unfiled", () => {
  assert.deepEqual(blockedReferentOrders([staleBlocked(1)], [{ number: 9 }], "2026-09-20"), [],
    "a stale label while claimable work exists is untidy, not urgent");
});

test("a row whose blocker has CLOSED is reported, because the label outlived the condition", () => {
  // The exact case that cost the day: #1731's blocker was fixed the day before and the label stayed on.
  const cleared = staleBlocked(1731, { blockedBy: { nodes: [{ number: 9, state: "CLOSED" }] } });
  assert.deepEqual(blockedWithoutReferent([cleared], "2026-09-20").map((r) => r.number), [1731]);
});

/**
 * AN EPIC THAT IS WAITING IS NOT UNFILED -- IT IS WAITING.
 *
 * #1780 built `blockedBy`/`Not-before:` so a session could record a waiting condition as DATA. #1784
 * shipped `epic-unfiled` without asking, so a correctly-recorded blocker was ignored.
 *
 * MEASURED 2026-09-20: `product-manager` was asked to split #57, judged it "still correctly blocked on
 * the open release milestone", RECORDED THAT AS A REAL `blockedBy` EDGE -- doing exactly what the rule
 * asks -- and was asked again anyway. Live at the time of the fix: 2 epics reported unfiled, BOTH of
 * them carrying a real edge, so the true count was 0. From outside, a session correctly declining and a
 * session ignoring its orders look identical, which is the whole reason this matters.
 */
test("an epic with a recorded blocker is not reported as unfiled", () => {
  const blocked = { number: 57, title: "pnpm", subIssuesSummary: { total: 0 },
    blockedBy: { nodes: [{ number: 9, state: "OPEN" }] } };
  const dated = { number: 69, title: "split", subIssuesSummary: { total: 0 },
    body: "Not-before: 2099-01-01" };
  const plain = { number: 34, title: "captures", subIssuesSummary: { total: 0 } };

  assert.deepEqual(unfiledEpics([blocked, dated, plain], "2026-09-20").map((e) => e.number), [34],
    "only the epic that is genuinely unfiled AND not waiting");
  assert.deepEqual(epicOrders([blocked, dated], []), [],
    "and an epic waiting on a recorded condition produces no order at all");
});

test("a CLEARED blocker makes the epic unfiled again, with no human involved", () => {
  // The self-clearing property #1780 was built for, now reaching this cause too.
  const cleared = { number: 57, subIssuesSummary: { total: 0 },
    blockedBy: { nodes: [{ number: 9, state: "CLOSED" }] } };
  assert.deepEqual(unfiledEpics([cleared], "2026-09-20").map((e) => e.number), [57]);
});

test("readEpics fetches the fields a waiting condition lives in", () => {
  // Without `body` and `blockedBy` on the read, `waitingOn` can only ever answer null -- the filter
  // would look correct and do nothing, which is the worst kind of wrong.
  const calls: string[][] = [];
  readEpics((args: string[]) => { calls.push(args); return "[]"; });
  const json = calls[0][calls[0].indexOf("--json") + 1];
  assert.match(json, /body/);
  assert.match(json, /blockedBy/);
  assert.match(json, /subIssuesSummary/);
});

/**
 * `needs:chairman` IS A REFERENT, AND OMITTING IT MADE `blocked-unexaminable` LOOP.
 *
 * MEASURED 2026-09-20 on #72 ("configure npm trusted publishing, then revoke the token"), which waits on
 * an npm org-owner logging into npmjs.com -- a chairman action. `product-manager` read the prompt's three
 * options, correctly found that neither `--add-blocked-by` nor `Not-before:` fits, took the third (name
 * in one line what would clear it) and wrote a complete, accurate comment. THE ROW STILL CARRIED
 * `blocked` AND STILL NAMED NOTHING CHECKABLE, SO THE CAUSE FIRED AGAIN -- and would have every two
 * hours forever. It cost one turn rather than many only because `product-manager` recognised its own
 * prior comment and declined to re-post.
 *
 * The label existed before the cause did: `readChairmanBlocked` reads it and `chairman-blocked` routes
 * it. It has every property the other two mechanisms have -- names a referent, machine-checkable, and
 * removing it IS the act of clearing. The three options were simply the wrong three.
 */
test("`needs:chairman` satisfies the cause, because it names a person a machine can check", () => {
  const bare = { number: 72, title: "npm", labels: [{ name: "backlog" }, { name: "blocked" }] };
  const named = { number: 72, title: "npm",
    labels: [{ name: "backlog" }, { name: "blocked" }, { name: CHAIRMAN_LABEL }] };
  assert.equal(blockedWithoutReferent([bare], "2026-09-20").length, 1);
  assert.deepEqual(blockedWithoutReferent([named], "2026-09-20"), [],
    "a wait on a person is named, routed by `chairman-blocked`, and cleared by removing the label");
});

test("the prompt offers the person-shaped answer, and admits the comment-only one does not silence it", () => {
  // A prompt that offers an escape without saying it does not work teaches a session to take it and be
  // asked again -- which is what happened on #72.
  const [order] = blockedReferentOrders([{ number: 72, title: "npm",
    labels: [{ name: "blocked" }] }], [], "2026-09-20") as { prompt: string }[];
  assert.match(order.prompt, /ONE of four things/);
  assert.match(order.prompt, /IF IT WAITS ON A PERSON, label it `needs:chairman`/);
  // SUPERSEDED 2026-09-21, and the replacement is the opposite instruction. This asserted that the
  // comment-only option must WARN it does not silence the question. That warning was honest about the
  // behaviour and the behaviour was wrong: #1520 was correctly re-answered four times in nine hours
  // because an explanation had no way to settle. The option now REQUIRES a `Not-before:` horizon, so
  // it does go quiet -- for a bounded time, then asks once more, which is the right treatment for a
  // wait nothing can examine.
  assert.match(order.prompt, /AND ADD A `Not-before:` FOR WHEN IT SHOULD NEXT BE\s+RE-CHECKED/,
    "an explained wait must carry a horizon, or it is a loop rather than an answer");
});

/**
 * A DECISION NOBODY CAN SEE IS NOT A DECISION -- the fourth instance of one defect.
 *
 *   `fleet-gated`  not the pool's | IS orchestrator's         -- #1770
 *   `blocked`      not startable  | a claim with no referent  -- #1780
 *   `epic`         not pickable   | nobody has FILED it       -- #1784
 *   `decision`     not startable  | SOMEONE OWES A DECISION   -- this
 *
 * MEASURED 2026-09-21: four `decision` rows open, NOT ONE visible to any cause. #1734 ("the gate can
 * only see GitHub objects") had sat unreachable for days while being cited repeatedly as awaiting a
 * ruling. #1817 was filed BY THIS SESSION for `ceo`, carrying `decision` + `lane:ceo` -- a label pair
 * that guaranteed `ceo` would never be told about it.
 */
const decisionRow = (n: number, ...extra: string[]) => ({ number: n, title: `row ${n}`,
  labels: [{ name: "backlog" }, { name: "decision" }, ...extra.map((name) => ({ name }))] });

test("a laned decision reaches its lane owner; an unlaned one reaches product-manager", () => {
  assert.equal(ownerOf(decisionRow(1817, "lane:ceo")), "ceo");
  assert.equal(ownerOf(decisionRow(1734)), "product-manager",
    "an UNOWNED decision is a filing gap, and lane labels are product-manager's brief");
  assert.equal(ownerOf({ number: 1, labels: [{ name: "backlog" }] }), null,
    "and an ordinary backlog row is still the pool's");
});

test("every decision row produces an order for its owner", () => {
  // The bug this caught: `laneBacklogOrders` iterated a STATIC `[...LANE_OWNER, ...ROUTED_TO]`, so
  // rows resolving to `product-manager` found an owner and then produced nothing at all.
  const orders = decide({ prs: [], readyRows: [],
    promotableRows: [decisionRow(1817, "lane:ceo"), decisionRow(1734)] }) as
    { session: string, causeKey: string }[];
  assert.deepEqual(orders.map((o) => o.session).sort(), ["ceo", "product-manager"]);
  assert.ok(orders.some((o) => o.causeKey.endsWith("row-1734")));
});

test("the owner set is DERIVED from the rows, so a new ownerOf case cannot go unrouted", () => {
  // A list that must be updated whenever `ownerOf` gains a case is a list that will not be.
  const orders = decide({ prs: [], readyRows: [], promotableRows: [decisionRow(9)] }) as
    { session: string }[];
  assert.deepEqual(orders.map((o) => o.session), ["product-manager"]);
});

test("the empty-shelf prompt asks whether a row is STILL TRUE, and to record what it found", () => {
  // MEASURED 2026-09-21: this cause's own audit examined #1731 carefully, concluded correctly that it
  // was not promotable, and left no trace on it -- while the defect it describes had been fixed 17
  // hours earlier by #1764 (30 sweep runs since, zero failures). It was the only row between the queue
  // and empty, and it was already done.
  const shelf = decide({ prs: [], readyRows: [],
    promotableRows: [{ number: 1731, labels: [{ name: "backlog" }] }] })
    .find((o: { cause: string }) => o.cause === "ready-queue-empty") as { prompt: string };
  assert.match(shelf.prompt, /IS IT STILL TRUE\?/);
  assert.match(shelf.prompt, /RECORD WHAT YOU FOUND, ON THE ROWS YOU EXAMINED/);
  assert.match(shelf.prompt, /Promoting nothing and saying why\s+is a valid answer/,
    "the guarantee that doing nothing is legitimate must survive both additions");
});

/**
 * AN EXPLAINED WAIT MUST SET ITS OWN RE-CHECK DATE, OR IT IS A LOOP THE ORG WAS TOLD TO RUN.
 *
 * Until 2026-09-21 this prompt's fourth option said a one-line comment was enough and that being
 * re-asked was DELIBERATE. That instruction was followed exactly: #1520 -- a measurement waiting for a
 * rehearsal-run count to reach 20, which is neither a row, a date nor a person -- was correctly
 * re-answered FOUR TIMES IN NINE HOURS (23:43, 01:44, 05:45, 08:21), each a full `sonnet`/`high` turn
 * reaching the identical conclusion, because nothing could record that the question had been answered.
 *
 * `product-manager` did nothing wrong at any point; the prompt ratified the loop. An explanation with
 * no horizon is not a terminal state.
 *
 * THE HORIZON IS ALSO THE ANSWER TO ROT, which is why it is a `Not-before:` and not a silence flag: an
 * unexaminable wait is exactly the kind that quietly becomes true, so it should go quiet for a while
 * and then be asked ONCE more -- never forever, never every two hours.
 */
test("the comment-only option requires a `Not-before:` horizon", () => {
  const [order] = blockedReferentOrders([{ number: 1520, title: "rehearsal count",
    labels: [{ name: "blocked" }] }], [], "2026-09-21") as { prompt: string }[];
  assert.match(order.prompt, /AND ADD A `Not-before:` FOR WHEN IT SHOULD NEXT BE\s+RE-CHECKED/);
  assert.match(order.prompt, /NOT OPTIONAL/);
  assert.doesNotMatch(order.prompt, /DOES NOT STOP THIS BEING ASKED AGAIN/,
    "the old instruction told the org the loop was deliberate -- it must not survive");
});

test("an explained wait WITH a horizon goes quiet, and comes back once", () => {
  const explained = { number: 1520, labels: [{ name: "blocked" }],
    body: "Not-before: 2026-09-28\n\nwaits on the run count reaching 20" };
  assert.deepEqual(blockedWithoutReferent([explained], "2026-09-21"), [],
    "quiet while the horizon stands");
  assert.equal(blockedWithoutReferent([explained], "2026-09-28").length, 1,
    "and asked ONCE more when it passes -- an unexaminable wait is the kind that quietly becomes true");
});

/**
 * A SESSION GETS ONE ORDER PER TICK, SO EVERY ORDER MUST NAME THE REST OF ITS QUEUE.
 *
 * `wake.mjs`'s `deliver` marks a session `working` the moment it is prompted, so a second order in the
 * same tick is refused -- correct, since two prompts cannot be typed into one live terminal. Before
 * 2026-09-20 that cost nothing: this cause emitted ONE order per owner naming up to eight rows, and a
 * session got its whole queue in one prompt.
 *
 * #1799's fix re-keyed per row so a standing judgment stopped being re-litigated when an unrelated row
 * moved. That was right. THE IMPLEMENTATION SERIALISED THE QUEUE: one order per row, one delivered per
 * tick, the rest deduped for two hours each.
 *
 * MEASURED 2026-09-21: `orchestrator` spent the day reasoning correctly about #1768 -- a row that cannot
 * move for TWELVE HOURS -- while #1663, #1042, #914 and #1830 sat with nothing stopping them and ten
 * workers idle. Every answer it gave was sound. It was never told the others existed in the same breath.
 */
const owned = (n: number) => ({ number: n, title: `row ${n}`,
  labels: [{ name: "backlog" }, { name: "lane:ceo" }] });

test("every order names the owner's OTHER actionable rows", () => {
  const [first] = decide({ prs: [], readyRows: [],
    promotableRows: [owned(1768), owned(1663), owned(914)] }) as { prompt: string }[];
  assert.match(first.prompt, /YOU ALSO OWN 2 OTHER ACTIONABLE ROW\(S\): #1663, #914/);
  assert.match(first.prompt, /DO NOT END YOUR TURN THERE/);
  assert.match(first.prompt, /ONE ORDER PER TICK/,
    "a session must know the others are not arriving in a minute, or waiting looks reasonable");
});

test("the row itself is never listed among its own others", () => {
  const orders = decide({ prs: [], readyRows: [],
    promotableRows: [owned(1), owned(2)] }) as { prompt: string }[];
  assert.doesNotMatch(orders[0].prompt, /ROW\(S\): #1\b/, "#1's order must not tell it to also do #1");
  assert.match(orders[0].prompt, /ROW\(S\): #2/);
  assert.match(orders[1].prompt, /ROW\(S\): #1/);
});

test("a lone row says nothing about others, rather than an empty list", () => {
  const [only] = decide({ prs: [], readyRows: [], promotableRows: [owned(914)] }) as { prompt: string }[];
  assert.doesNotMatch(only.prompt, /YOU ALSO OWN/,
    "an owner with one row must not be told to go and do the rest of nothing");
});

test("the causeKey is STILL per row -- both properties, neither traded", () => {
  // #1799's requirement survives: one row's judgment is deduped without touching another's.
  const orders = decide({ prs: [], readyRows: [],
    promotableRows: [owned(1768), owned(1663)] }) as { causeKey: string }[];
  assert.deepEqual(orders.map((o) => o.causeKey),
    ["ceo/lane-backlog-unpromoted/row-1768", "ceo/lane-backlog-unpromoted/row-1663"]);
});

// --- #1848: an epic whose every child is closed is FINISHED WORK STILL IN THE BACKLOG ------------------
//
// `unfiledEpics` asks `total === 0`. Nothing asked the opposite question, though `subIssuesSummary`
// carries `completed` and the gate has been fetching it since #1784.
//
// MEASURED 2026-09-21, when the chairman asked why nothing was running: 30 open rows, 0 Ready, and
// exactly ONE row an engineer could take. Of 27 backlog rows, 13 were `epic` -- and NINE had every child
// closed (#1317 10/10, #142, #65, #40, #37, #36, #35, #34, #31). #1317 is "Adopt rstest as the test
// runner": ten children, all ten merged. The backlog read 27 deep when it held about four real rows,
// which is how the org ran out of work without anyone noticing.

const doneEpic = (n: number, total = 1) => ({ number: n, title: `epic ${n}`,
  labels: [{ name: "backlog" }, { name: "epic" }], subIssuesSummary: { total, completed: total } });

test("#1848: every child closed is FINISHED; part-done and never-filed are not", () => {
  assert.deepEqual(finishedEpics([doneEpic(1317, 10), epic(149, 6), epic(69)]).map((e) => e.number), [1317],
    "#1317 is 10/10 -- done. #149 is 6 children with none closed. #69 has none at all, which is "
    + "unfiledEpics' finding, not this one");
  assert.deepEqual(finishedEpics([]), []);
  assert.deepEqual(finishedEpics(undefined as never), []);
});

test("#1848: THE TWO CAUSES ARE DISJOINT -- no epic is ever both unfiled and finished", () => {
  // `total === 0` and `total > 0 && completed === total` cannot both hold. Stated as a test because an
  // epic reported twice would put product-manager in front of two contradictory orders about one row,
  // and `0 === 0` is exactly the kind of boundary a later edit gets wrong.
  const population = [epic(69), epic(149, 6), doneEpic(1317, 10), doneEpic(31)];
  const unfiled = unfiledEpics(population).map((e) => e.number);
  const finished = finishedEpics(population).map((e) => e.number);
  assert.deepEqual(unfiled, [69]);
  assert.deepEqual(finished, [1317, 31]);
  assert.deepEqual(unfiled.filter((n) => finished.includes(n)), [],
    "an epic with zero children must never also count as finished");
});

test("#1848: a WAITING epic is waiting, not finished -- #1780's filter, same as unfiledEpics", () => {
  const held = { ...doneEpic(57, 3), body: "Not-before: 2099-01-01\n" };
  assert.deepEqual(finishedEpics([held]), [],
    "a recorded waiting condition means the answer is already known; asking again is how #57 got "
    + "re-litigated after correctly declining");
  assert.deepEqual(finishedEpics([{ ...doneEpic(58, 3), blockedBy: { nodes: [{ number: 5, state: "OPEN" }] } }]), [],
    "a real blockedBy edge counts too, not only the date field -- and the shape is GraphQL's "
    + "`{ nodes: [...] }`, which my first fixture got wrong and the test caught");
  assert.deepEqual(finishedEpics([{ ...doneEpic(59, 3), blockedBy: { nodes: [{ number: 5, state: "CLOSED" }] } }])
    .map((e) => e.number), [59],
    "POSITIVE CONTROL: a CLOSED blocker is not a wait, or a finished epic would be hidden for ever "
    + "by an edge that resolved months ago");
});

test("#1848: it fires only when the shelf is EMPTY, and goes to product-manager keyed per epic", () => {
  assert.deepEqual(finishedEpicOrders([doneEpic(1317, 10)], [{ number: 9 }]), [],
    "claimable work outranks tidying the epic list");
  const [order] = finishedEpicOrders([doneEpic(1317, 10)], []) as
    { session: string, cause: string, discriminator: string, causeKey: string }[];
  assert.equal(order.cause, "epic-finished");
  assert.equal(order.session, "product-manager", "filing is product-manager's lane");
  assert.equal(order.discriminator, "1317");
  assert.equal(order.causeKey, "product-manager/epic-finished/epic-1317",
    "#1799: keyed on the epic, so closing an unrelated one does not re-litigate this judgment");
});

test("#1848: THE ORDER ASKS, IT DOES NOT ASSERT -- 'file the next tranche' must survive as an answer", () => {
  // Every child closed does NOT prove the epic is done; it equally means the next rows were never
  // filed, which is the more valuable answer and the one a "close this" order would talk the reader
  // out of. If this prompt ever reads as an instruction to close, the cause becomes a tidy-up that
  // destroys supply.
  const [order] = finishedEpicOrders([doneEpic(34, 2)], []) as { prompt: string }[];
  assert.match(order.prompt, /never been filed/, "the unfiled-supply reading must be offered explicitly");
  assert.match(order.prompt, /--parent 34/, "and the epic->child link stays DATA, not prose");
  assert.match(order.prompt, /2 of 2/, "the counts it judged on are in the prompt, not left to be re-read");
  assert.match(order.prompt, /RECORD THE ANSWER ON THE EPIC/,
    "or the next reader re-derives a judgment already made -- #1799's whole finding");
});

test("#1848 POSITIVE CONTROL: a backlog with nothing finished says nothing at all", () => {
  assert.deepEqual(finishedEpicOrders([epic(69), epic(149, 6)], []), [],
    "this cause must be capable of finding nothing, or product-manager learns to ignore it");
  assert.deepEqual(finishedEpicOrders([], []), []);
});

test("#1848: one order per finished epic, capped like every other row cause", () => {
  const many = Array.from({ length: MAX_ROW_ORDERS_PER_TICK + 3 }, (_, i) => doneEpic(i + 1));
  assert.equal(finishedEpicOrders(many, []).length, MAX_ROW_ORDERS_PER_TICK,
    "nine finished epics in one tick must not become nine orders");
});

// --- #1941: the fleet batch was a state question wearing a clock ------------------------------------
//
// #1830 built a 01:00 UTC timer for the nightly fleet-gated batch. The cadence was inherited, not
// chosen: #914 recorded what a PERSON did late at night, and automating the remembering automated the
// hour with it. Measured 2026-09-22 when the chairman asked why everything waited for 1am -- the firing
// costs 2.2s of CPU and 5s of wall clock, performs no capture, and made the fleet wait up to
// twenty-three hours for a question worth asking the moment a row became gated.
//
// `agent-practices.md` already forbade it: "a cron is right for something that must happen at a
// WALL-CLOCK time regardless of state; it is never right for 'has anything changed yet'."

// The two milestones the batch must read the SAME (#2443): the version-one path, and the one a row filed
// off-path lands on. Literals, because the feeders no longer carry either as a constant.
const ON_PATH = "Road to version one";
const OFF_PATH = "Out of release";

const batchRow = (n: number, milestone: string | null = ON_PATH) => ({
  number: n,
  labels: [{ name: "fleet-gated" }],
  milestone: milestone === null ? null : { title: milestone },
});

test("#1941/#2443: the batch is every open fleet-gated row, in row order, WHATEVER ITS MILESTONE", () => {
  // POSITIVE CONTROL is the on-path pair (the case #1941 pinned before #2443): 1042 and 1768 must still
  // be offered, unchanged.
  const rows = [batchRow(1768), batchRow(1042), batchRow(99, OFF_PATH),
    { number: 5, labels: [{ name: "backlog" }], milestone: { title: ON_PATH } }];
  assert.deepEqual(fleetBatchRows(rows).map((r) => r.number), [99, 1042, 1768],
    "label-scoped, and SORTED -- an unsorted set would mint a different causeKey "
    + "for the same batch depending on what order GitHub happened to return it in");
  assert.deepEqual(fleetBatchRows([batchRow(1, null)]).map((r) => r.number), [1],
    "a row with no milestone at all is still a row that needs a fleet run");
});

test("#2443: a fleet-gated row carrying `out-of-release` and the `Out of release` milestone IS offered", () => {
  // THE DEFECT: #2212 sat here for hours on 2026-09-24 and nothing said so.
  const offPath = { ...batchRow(2212, OFF_PATH),
    labels: [{ name: "fleet-gated" }, { name: "out-of-release" }] };
  const [order] = fleetBatchOrders([offPath]);
  assert.equal(order?.causeKey, "orchestrator/fleet-batch-due/2212");
  assert.doesNotMatch(order.prompt, /Road to version one/, "the order no longer claims a milestone");
  assert.deepEqual(fleetBatchOrders([batchRow(2258)]).map((o) => o.causeKey),
    ["orchestrator/fleet-batch-due/2258"], "POSITIVE CONTROL: the on-path case is unchanged");
});

test("#2443: the selector is ONE object, and its two halves name the same label", () => {
  assert.deepEqual([...FLEET_GATED_SELECTOR.listArgs], ["--label", FLEET_GATED_SELECTOR.label]);
  assert.ok(FLEET_GATED_SELECTOR.matches(batchRow(1)), "the local half accepts a fleet-gated row");
  assert.ok(!FLEET_GATED_SELECTOR.matches({ number: 2, labels: [{ name: "backlog" }] }),
    "and refuses a row without the label");
});

test("#1941: THE CAUSEKEY IS THE SET, so it fires when the set changes and never on a clock", () => {
  const [before] = fleetBatchOrders([batchRow(1042), batchRow(1768)]);
  const [same] = fleetBatchOrders([batchRow(1768), batchRow(1042)]);
  assert.equal(before.causeKey, same.causeKey,
    "the same batch in a different order is the same question -- or every tick would re-ask it");
  const [changed] = fleetBatchOrders([batchRow(1042)]);
  assert.notEqual(before.causeKey, changed.causeKey,
    "a row leaving the set IS a change, and must reach orchestrator rather than wait for tonight");
  assert.equal(before.causeKey, "orchestrator/fleet-batch-due/1042.1768");
});

test("#1941: a COUNT would not do, which is the whole of #1799's finding", () => {
  // Two different two-row batches must not share a key. A count-based discriminator collides them, and
  // the second batch is then silently protected by the first's JUDGMENT_TTL -- the exact shape that
  // re-litigated three epics four times in an hour.
  const [a] = fleetBatchOrders([batchRow(1), batchRow(2)]);
  const [b] = fleetBatchOrders([batchRow(3), batchRow(4)]);
  assert.notEqual(a.causeKey, b.causeKey, "same size, different rows, different question");
});

test("#1941: an empty gated set says nothing at all -- the positive control", () => {
  assert.deepEqual(fleetBatchOrders([]), []);
  assert.deepEqual(fleetBatchOrders([{ number: 5, labels: [{ name: "backlog" }] }]), [],
    "this cause must be capable of finding nothing, or orchestrator learns to ignore it");
});

test("#1941: the order tells orchestrator how to LEAVE the set, not just to work it", () => {
  // A row that is skipped stays in the set and re-fires the identical causeKey for ever. The way out is
  // a machine-readable condition -- the same waiting-condition rule the rest of the gate already reads.
  const [order] = fleetBatchOrders([batchRow(1768)]);
  assert.equal(order.session, "orchestrator");
  assert.equal(order.cause, "fleet-batch-due");
  assert.match(order.prompt, /Fleet-hold-until:/);
  assert.match(order.prompt, /--add-blocked-by/);
  assert.match(order.prompt, /Not-before:/);
  assert.match(order.prompt, /NOT ON A CLOCK/,
    "the prompt says why it arrived now, so the reader does not defer it to tonight out of habit");
});

test("#1941: the retired timer's units are gone from the shipped host set", () => {
  // The clock is the thing being removed; leaving the unit in `packages/agent-org/host/` would let
  // `host:install` put it straight back, and the org would have both a timer and a gate cause firing the
  // same batch at two different cadences.
  const units = shippedUnits();
  assert.ok(!units.some((u: string) => u.startsWith("a11ign-fleet-gated-nightly")),
    `a11ign-fleet-gated-nightly.* must not ship any more -- found ${units.join(", ")}`);
  assert.ok(units.includes("a11ign-work-tick.timer"), "POSITIVE CONTROL: the tick's own units still ship");
});

// --- #2027: the fleet batch could not see a waiting condition -------------------------------------
//
// The order has told `orchestrator` since #1941 that a row which cannot move yet is an answer -- say so
// with `Fleet-hold-until:`, `--add-blocked-by` or `Not-before:` "and it leaves this set until the
// condition clears". `fleetBatchRows` filtered on the label and the milestone and NOTHING ELSE, so
// writing the condition changed nothing and the only exits were closing the row or removing its label.
//
// MEASURED IN ONE `work:gate` RUN, 2026-09-22T21:57Z: `SHELVED row #1976: blocked by #1918` and a
// fleet-batch order naming #1976, from the same invocation. Eight of that batch's nine rows carried a
// standing, correct condition; exactly one (#1908) was runnable.

const TODAY = "2026-09-23";
const NOW = Date.parse("2026-09-23T12:00:00Z");
const CLOCK = { today: TODAY, nowMs: NOW };

/** A `fleet-gated` row on the milestone, with whatever waiting condition the case is about. */
const gatedRow = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  labels: [{ name: "fleet-gated" }],
  milestone: { title: ON_PATH },
  ...extra,
});

const blockedByOpen = { blockedBy: { nodes: [{ number: 1918, state: "OPEN" }] } };
const blockedByClosed = { blockedBy: { nodes: [{ number: 1918, state: "CLOSED" }] } };

test("#2443: the waiting fields still shelve an OFF-path row, exactly as they do an on-path one", () => {
  const future = { ...gatedRow(2212, { body: "Not-before: 2026-09-30" }), milestone: { title: OFF_PATH } };
  const blocked = { ...gatedRow(2213, blockedByOpen), milestone: { title: OFF_PATH } };
  const free = { ...gatedRow(2214), milestone: { title: OFF_PATH } };
  const { batch, waiting } = partitionFleetBatch([future, blocked, free], CLOCK);
  assert.deepEqual(batch.map((r) => r.number), [2214], "the runnable off-path row is offered");
  assert.deepEqual(waiting.map((w) => w.number), [2212, 2213], "the waiting ones leave, and are reported");
});

test("#2027: an open `blockedBy` edge takes the row out of the fleet batch -- and a closed one puts it back", () => {
  assert.deepEqual(fleetBatchRows([gatedRow(1976, blockedByOpen)], CLOCK), [],
    "#1976 was dispatched and shelved by the same tick; the shelving was the true reading");
  // THE POSITIVE CONTROL, and it is the one that matters: an exclusion test alone passes on a filter that
  // returns nothing at all, which is the defect with the sign flipped.
  assert.deepEqual(
    fleetBatchRows([gatedRow(1976, blockedByClosed)], CLOCK).map((r) => r.number),
    [1976], "a blocker that has CLOSED is a condition that cleared, and the row comes back by itself");
});

test("#2027: a future `Not-before:` takes the row out -- and today's date puts it back", () => {
  const future = gatedRow(1042, { body: "Not-before: 2026-09-30" });
  assert.deepEqual(fleetBatchRows([future], CLOCK), [],
    "#1042 carried exactly this on 2026-09-22 and was dispatched anyway");
  const arrived = gatedRow(1042, { body: `Not-before: ${TODAY}` });
  assert.deepEqual(fleetBatchRows([arrived], CLOCK).map((r) => r.number), [1042],
    "POSITIVE CONTROL: `Not-before:` is not-BEFORE, so the named day itself is runnable");
});

test("#2027: a live `Fleet-hold-until:` takes the row out -- and a lapsed one puts it back", () => {
  // THE FOURTH CONDITION, and the only one this population has. It was declared in
  // `packages/control/src/fleet-playbook.mjs` and therefore unreadable by `waiting-condition.mjs`, which
  // is #2005's defect one field over -- the same reason the fleet batch could not honour its own order.
  const live = gatedRow(1768, { body: "Fleet-hold-until: 2026-09-23T18:00:00Z" });
  assert.deepEqual(fleetBatchRows([live], CLOCK), [],
    "a multi-round same-build sequence owns the fleet until the second it named");
  const lapsed = gatedRow(1768, { body: "Fleet-hold-until: 2026-09-23T06:00:00Z" });
  assert.deepEqual(fleetBatchRows([lapsed], CLOCK).map((r) => r.number), [1768],
    "POSITIVE CONTROL: the hold lapses with no edit to anyone's row, which is the property it was built for");
});

test("#2027: an `answer:<session>` label takes the row out -- and removing it puts the row back", () => {
  const owed = { number: 914, milestone: { title: ON_PATH },
    labels: [{ name: "fleet-gated" }, { name: `${ANSWER_PREFIX}product-manager` }] };
  assert.deepEqual(fleetBatchRows([owed], CLOCK), [],
    "#914 is the row that cost 6.5 hours waiting for a ruling -- re-dispatching it is re-asking it");
  assert.deepEqual(fleetBatchRows([gatedRow(914)], CLOCK).map((r) => r.number), [914],
    "POSITIVE CONTROL: removing the label IS the act of answering, and the row returns on that alone");
});

test("#2027: a whole batch that is waiting produces NO ORDER, rather than an order naming it", () => {
  // THE MUTATION THIS SUITE IS FOR: make the new filter return `true` unconditionally -- a filter that
  // excludes nothing -- and this goes red. It is the defect restored exactly.
  const allWaiting = [gatedRow(31, blockedByOpen), gatedRow(1042, { body: "Not-before: 2026-09-30" }),
    gatedRow(1768, { body: "Fleet-hold-until: 2026-09-23T18:00:00Z" })];
  assert.deepEqual(fleetBatchOrders(allWaiting, CLOCK), [],
    "every answer is already recorded in a field; re-reporting them is the treadmill the order's own "
    + "last sentence was written to prevent");
  const [order] = fleetBatchOrders([...allWaiting, gatedRow(1908)], CLOCK);
  assert.equal(order?.causeKey, "orchestrator/fleet-batch-due/1908",
    "POSITIVE CONTROL: the one genuinely runnable row still reaches orchestrator, and alone -- the "
    + "2026-09-22 batch of nine was eight answered rows and this one");
});

test("#2027: a shelved fleet row is REPORTED, never silently dropped", () => {
  const { batch, waiting } = partitionFleetBatch(
    [gatedRow(1976, blockedByOpen), gatedRow(1908)], CLOCK);
  assert.deepEqual(batch.map((r) => r.number), [1908]);
  assert.deepEqual(waiting, [{ number: 1976,
    reason: "blocked by #1918 -- declared on the row, and it clears itself" }],
    "the same sentence the engineer pool's shelvings print, because a row that vanishes silently is the "
    + "failure `blocked` already is");
});

// A row answered with `needs:chairman` re-fired: #2728 (a credential-only row, wrongly carrying
// `fleet-gated`) came back three minutes after `orchestrator` had already answered it, because the
// label names a person rather than one of the order's three machine-readable exits
// (`Fleet-hold-until:`, `--add-blocked-by`, `Not-before:`). `waitingOn`/`fleetWaitingOn` deliberately
// do not read this label (#2583/#2604/#2653 all made the same choice for their own populations), so
// the fifth reader lives here, in the fleet batch's own filter (#2730).
test("#2730: `needs:chairman` takes a row out of the fleet batch -- and removing it puts the row back", () => {
  const asked = gatedRow(2728, { labels: [{ name: "fleet-gated" }, { name: CHAIRMAN_LABEL }] });
  assert.deepEqual(fleetBatchRows([asked], CLOCK), [],
    "#2728 is a credential row answered `needs:chairman`; re-dispatching it is re-asking it");
  assert.deepEqual(fleetBatchRows([gatedRow(2728)], CLOCK).map((r) => r.number), [2728],
    "POSITIVE CONTROL: removing the label IS the act of answering, and the row returns on that alone");
});

test("#2730: a `needs:chairman` row is REPORTED as waiting, in the sentence the other conditions get", () => {
  const asked = gatedRow(2728, { labels: [{ name: "fleet-gated" }, { name: CHAIRMAN_LABEL }] });
  const { batch, waiting } = partitionFleetBatch([asked, gatedRow(1908)], CLOCK);
  assert.deepEqual(batch.map((r) => r.number), [1908]);
  assert.deepEqual(waiting, [{ number: 2728,
    reason: "waiting on the chairman (needs:chairman) -- declared on the row, and it clears itself" }]);
});

test("#2730: a whole batch answered `needs:chairman` produces NO ORDER, rather than re-firing on it", () => {
  const asked = gatedRow(2728, { labels: [{ name: "fleet-gated" }, { name: CHAIRMAN_LABEL }] });
  assert.deepEqual(fleetBatchOrders([asked], CLOCK), [],
    "the answer is already recorded in the label; re-reporting it is the treadmill #2027 exists to prevent");
});

// --- #2027, second half: nothing woke a claim holder when their blocker cleared --------------------
//
// PR #1957 merged 2026-09-22T21:26:01Z and closed #1948 at 21:26:02Z, leaving #1908 -- `in-progress`,
// `session:worker-capture` -- with every blocker closed and six rows queued behind it. The `work:gate`
// run 31 minutes later emitted NO CAUSE FOR `worker-capture` AT ALL: `ready-row-unclaimed` skips a
// claimed row, and no other cause addresses the session that already holds one. `prompt:session` refused
// (`NOT PROMPTED: "worker-capture" is working`) and the refusal was dropped, so the only route that
// worked was `answer:worker-capture` applied by hand -- a label meaning "someone owes you an answer".

const heldRow = (n: number, session: string, extra: Record<string, unknown> = {}) => ({
  number: n,
  labels: [{ name: "in-progress" }, { name: `session:${session}` }],
  ...extra,
});

test("#2027: the session holding a row whose blockers have ALL closed is named and woken", () => {
  const [order] = blockerClearedOrders([heldRow(1908, "worker-capture",
    { blockedBy: { nodes: [{ number: 1948, state: "CLOSED" }, { number: 1926, state: "CLOSED" }] } })], TODAY);
  assert.equal(order?.session, "worker-capture", "the holder, not the pool -- nobody else can act on it");
  assert.equal(order?.cause, "blocker-cleared");
  assert.equal(order?.causeKey, "worker-capture/blocker-cleared/row-1908/1926.1948",
    "keyed on the CLEARED SET and sorted, so the same clearing is one question however GitHub orders it");
  assert.match(order?.prompt ?? "", /#1926, #1948/, "the prompt names what cleared, so no turn re-derives it");
});

test("#2027: one still-open blocker is not a clearing -- the positive control on the negative", () => {
  assert.deepEqual(blockerClearedOrders([heldRow(1908, "worker-capture",
    { blockedBy: { nodes: [{ number: 1948, state: "CLOSED" }, { number: 1918, state: "OPEN" }] } })], TODAY), [],
    "the LAST condition to clear is the one that frees a row");
});

test("#2027: a row that never declared a blocker is not freshly unblocked", () => {
  // Without this, every claimed row in the tracker is announced as unblocked on the first tick after this
  // ships. A cause that fires on its whole population the day it lands is noise, and noise is how a real
  // signal gets filtered out.
  assert.deepEqual(blockerClearedOrders([heldRow(1908, "worker-capture")], TODAY), []);
  assert.deepEqual(blockerClearedOrders([heldRow(1908, "worker-capture",
    { blockedBy: { nodes: [] } })], TODAY), [], "an empty node list is the same statement");
});

test("#2027: an UNCLAIMED row's cleared blocker is not this cause -- `ready-row-unclaimed` owns that", () => {
  const unclaimed = { number: 1908, labels: [{ name: "ready" }], ...blockedByClosed };
  assert.deepEqual(blockerClearedOrders([unclaimed], TODAY), [],
    "this cause exists for the gap where a row is HELD; offering a free row is another cause's job");
  const noSession = { number: 1908, labels: [{ name: "in-progress" }], ...blockedByClosed };
  assert.deepEqual(blockerClearedOrders([noSession], TODAY), [],
    "a claim with no `session:` label names nobody to wake, and waking a session called \"\" is an order "
    + "with nowhere to go");
  // A `session:` LABEL WITHOUT THE CLAIM IS NOT A HOLDER, and this shape is real rather than contrived:
  // `ready-label-audit.mjs` names it as #171's -- a correct decline whose restore silently did not
  // happen. Telling that session to "pick it back up" would tell it to resume a row it no longer holds.
  // Caught by a mutation: with the `in-progress` test deleted, every other case here still passed.
  const stranded = { number: 1908, ...blockedByClosed,
    labels: [{ name: "was-ready" }, { name: "session:worker-capture" }] };
  assert.deepEqual(blockerClearedOrders([stranded], TODAY), [],
    "the claim label is what says a session is HOLDING the row, and it is the claim this cause resumes");
});

test("#2027: a row still waiting on a DATE or an ANSWER is not announced as runnable", () => {
  assert.deepEqual(blockerClearedOrders([heldRow(1908, "worker-capture",
    { ...blockedByClosed, body: "Not-before: 2026-09-30" })], TODAY), [],
    "its `blockedBy` cleared and its `Not-before:` did not");
  const owing = { number: 1908, ...blockedByClosed,
    labels: [{ name: "in-progress" }, { name: "session:worker-capture" },
      { name: `${ANSWER_PREFIX}ceo` }] };
  assert.deepEqual(blockerClearedOrders([owing], TODAY), [],
    "#2005's rule: a row waiting on a ruling must not be made to look free");
});

test("#2186: a row the FLEET holds is not announced as runnable until the hold passes", () => {
  // #2114's shape, from the row: blockers all closed, `in-progress`, held by a session, and a
  // `Fleet-hold-until:` six hours out. `waitingOn` answers null for it BY DESIGN, so the cause woke a
  // holder for a row the same tick's shelf line said was held.
  const held = heldRow(2114, "worker-judge", { ...blockedByClosed, body: "Fleet-hold-until: 2026-09-23T22:00:00Z" });
  assert.deepEqual(blockerClearedOrders([held], TODAY, NOW), [],
    "a live fleet hold is as disqualifying to a holder as an open `blockedBy` edge");
  const [order] = blockerClearedOrders([held], TODAY, Date.parse("2026-09-23T22:00:01Z"));
  assert.equal(order?.session, "worker-judge",
    "and the SAME row is woken once the timestamp has passed -- the other direction, or this is a mute button");
  assert.equal(order?.cause, "blocker-cleared");
});

// --- #2161: the cause must not ask a holder who has already resumed ------------------------------------
//
// #2031 (6m56s past a green draft), #2145 (1m47s) and #2170 (2m24s after APPROVED and in the merge queue)
// were each told to "PICK IT BACK UP" for a row whose holder had built it and opened a pull request. The
// screen asked who HOLDS the row and never whether they had acted, and because this is an ACTION cause the
// twenty-minute expiry re-offers it until `MAX_DELIVERIES` labels a healthy row `needs:chairman`.

/** An open pull request as `readPrs` returns it: only `number` and `body` matter to this screen. */
const openPr = (number: number, body: string) => ({ number, body, isDraft: true, files: [], changedFiles: 0 });

test("#2161: the SAME row is announced with no pull request and screened once one names it -- both ways", () => {
  const row = heldRow(2031, "worker-capture", { blockedBy: { nodes: [{ number: 2014, state: "CLOSED" }] } });
  const [unresumed] = blockerClearedOrders([row], TODAY, NOW, { openPrs: [openPr(2999, "Closes #1111")] });
  assert.equal(unresumed?.session, "worker-capture",
    "POSITIVE CONTROL: an open PR for ANOTHER row is not this holder's answer, so the order still goes");
  assert.equal(unresumed?.causeKey, "worker-capture/blocker-cleared/row-2031/2014");
  assert.deepEqual(blockerClearedOrders([row], TODAY, NOW, { openPrs: [] }).map((o) => o.causeKey),
    ["worker-capture/blocker-cleared/row-2031/2014"], "no open PR at all: the holder has not resumed");
  assert.deepEqual(blockerClearedOrders([row], TODAY, NOW, { openPrs: [openPr(2156, "Closes #2031")] }), [],
    "an open PR whose `Closes:` names the row proves the clearing was acted on -- and this is the SAME "
    + "row, session and blocker as the two assertions above");
});

// --- #2493: FILING THE EDGE MUST BE ENOUGH TO WAKE THE OWNER OF A HELD PR ---------------------------------
//
// `ceo`'s ruling (#2400 section 2) rests on `blocker-cleared` addressing the holder of a row whose LAST blocker
// closes. That is pinned above for a holder with no pull request, and the #2161 screen is what stood between it
// and the case that matters here: #2376's owner HAS an open PR (`Closes #2359`), so the screen read them as
// "already resumed" and the wake never came. A HELD pull request is the holder's declaration that they are
// WAITING, so it is not evidence they acted on this clearing.

const heldPrOf = (number: number, body: string, labels: string[]) =>
  ({ ...openPr(number, body), labels: labels.map((name) => ({ name })) });

test("#2493: the holder of a row whose LAST blocker closed is woken although a HELD pull request names the row", () => {
  const waiting = heldRow(2359, "worker-9", { blockedBy: { nodes: [{ number: 2399, state: "OPEN" }] } });
  assert.deepEqual(blockerClearedOrders([waiting], TODAY, NOW,
    { openPrs: [heldPrOf(2376, "Closes #2359", ["hold:worker-9"])] }), [],
    "while the edge is OPEN nobody is woken -- the positive control's other side");
  const cleared = heldRow(2359, "worker-9", { blockedBy: { nodes: [{ number: 2399, state: "CLOSED" }] } });
  const [order] = blockerClearedOrders([cleared], TODAY, NOW,
    { openPrs: [heldPrOf(2376, "Closes #2359", ["hold:worker-9"])] });
  assert.equal(order?.session, "worker-9", "the edge is what wakes the owner: no other message is needed");
  assert.equal(order?.causeKey, "worker-9/blocker-cleared/row-2359/2399");
  assert.deepEqual(blockerClearedOrders([cleared], TODAY, NOW,
    { openPrs: [heldPrOf(2376, "Closes #2359", ["session:worker-9"])] }), [],
    "and an UNHELD open PR still screens, exactly as #2161 says: only the hold changes the reading");
});

test("#2161: it is the DECLARATION that screens, in every spelling the merge gate reads", () => {
  const row = heldRow(2170, "worker-judge", { ...blockedByClosed });
  for (const body of ["Closes #2170", "Closes: #2170", "Closes #2100, #2170", "Closes #2100\nCloses #2170"]) {
    assert.deepEqual(blockerClearedOrders([row], TODAY, NOW, { openPrs: [openPr(2246, body)] }), [], `\`${body}\``);
  }
  // `Closes: none` and prose that merely mentions the number declare nothing, so they screen nothing --
  // the identical rule B4 applies (#2101), read from the same parser. A row claimed and then ABANDONED,
  // with an unrelated PR mentioning its number, is exactly the holder this cause must still reach.
  for (const body of ["Closes: none -- docs only", "see #2170 for context", "", null]) {
    assert.equal(blockerClearedOrders([row], TODAY, NOW, { openPrs: [openPr(2246, body as string)] }).length, 1,
      `${JSON.stringify(body)} names no row`);
  }
});

test("#2161: a truncated file list does not withdraw the screen -- it reads `prs`, not `comparablePrFiles`", () => {
  // `comparablePrFiles` drops a PR whose `files` is shorter than `changedFiles` (#1419), which is right for
  // an overlap comparison. The largest pull requests are the likeliest to be a row's whole build.
  const big = { number: 2246, body: "Closes #2170", files: [{ path: "a" }], changedFiles: 400 };
  assert.deepEqual(blockerClearedOrders([heldRow(2170, "worker-judge", { ...blockedByClosed })],
    TODAY, NOW, { openPrs: [big] }), []);
});

test("#2161: the narrowing REMOVES nothing but the resumed row -- one orders, one does not, side by side", () => {
  const rows = [heldRow(2031, "worker-capture", { ...blockedByClosed }),
    heldRow(2145, "worker-5", { ...blockedByClosed })];
  assert.deepEqual(blockerClearedOrders(rows, TODAY, NOW, { openPrs: [openPr(2156, "Closes #2031")] }).map((o) => o.session),
    ["worker-5"], "the holder who has NOT resumed is still told, with #2027's prompt");
  assert.match(blockerClearedOrders(rows, TODAY, NOW, { openPrs: [openPr(2156, "Closes #2031")] })[0]?.prompt ?? "",
    /PICK IT BACK UP/);
});

test("#2161: decide() hands the cause the pull requests it already read", () => {
  const row = heldRow(2031, "worker-capture", { ...blockedByClosed });
  const cleared = (prs: ReturnType<typeof openPr>[]) => decide({ prs, readyRows: [], openRows: [row] })
    .filter((o) => o.cause === "blocker-cleared");
  assert.equal(cleared([]).length, 1, "POSITIVE CONTROL: with no open PR the order is still emitted");
  assert.equal(cleared([openPr(2156, "Closes #2031")]).length, 0,
    "and with the holder's open PR in `prs` the same call emits none -- decide must pass `prs` through");
});

test("#2161: the narrowing spends no `gh` call -- it reads what `draftOrder` already has", () => {
  assert.equal(GH_READS.unconditional.length, 11, "#2161 adds no unconditional read (8 since #2202, 9 since #2075, 10 since #2641, 11 since #2936)");
  const gate = readFileSync(new URL("../work-gate.mjs", import.meta.url), "utf8");
  const body = gate.slice(gate.indexOf("function rowsWithOpenPr"), gate.indexOf("export function blockerClearedOrders"));
  assert.ok(body.length > 0 && !/\brun\(|spawnSync|defaultRun/.test(body),
    "the helper is pure: no seam, no subprocess, so no binary for a budget to be charged against");
});

test("#2027: blocker-cleared is a FINISH cause, because a claimed row is work in flight", () => {
  assert.ok(CAUSES.includes("blocker-cleared"), "it must be in CAUSES or worker-profile refuses it at run time");
  assert.ok(!START_CAUSES.includes("blocker-cleared"),
    "a drain finishes work in flight and starts none; withholding this strands exactly the claimed rows a "
    + "transfer window needs landed");
});

test("#2741: blocker-cleared is JUDGMENT, the same reclassification row-branch-unshipped got for the same reason", () => {
  assert.ok(JUDGMENT_CAUSES.includes("blocker-cleared"),
    "a clearing a holder has already answered does not become false again twenty minutes later -- an "
    + "ACTION cause's WAKE_TTL_MS re-ask hit MAX_DELIVERIES inside its own first PROMOTION_ASK_WINDOW_MS "
    + "and escalated #1756 twice in one day before the row's own backoff window ever went quiet");
});

test("#2027: decide() routes it, and ahead of the causes that offer new work", () => {
  const orders = decide({ prs: [], readyRows: [],
    openRows: [heldRow(1908, "worker-capture", { ...blockedByClosed })] });
  const causes = orders.map((o) => o.cause);
  assert.ok(causes.includes("blocker-cleared"),
    "the gate could see the row become runnable and, before this, had nobody to tell");
  assert.equal(orders.find((o) => o.cause === "blocker-cleared")?.session, "worker-capture");
});

// --- #2741: `blocker-cleared` backs off THE SAME WAY `unclaimed-blocker-cleared` already does ----------
//
// #1756 is `ceo`'s own claimed, no-PR row: `blockedBy` #1931 and #1959 closed, and the pre-fix causeKey
// (`ceo/blocker-cleared/row-1756/1931.1959`) never changes again once they do. Because this was an ACTION
// cause, `wake`'s twenty-minute expiry re-asked it six times inside `PROMOTION_ASK_WINDOW_MS`'s own first
// two hours and escalated (`answer:ceo`) BEFORE any backoff schedule could ever go quiet. `ceo` answering
// the escalation correctly -- reading the row, confirming nothing changed, removing the label -- is what
// RESET the counter (`fleetWaitingOn` un-shelves on removal) and let the identical cycle restart from
// zero: two full cycles on 2026-09-27 and a third overnight before `ceo` finally silenced #1756 with a
// `Not-before:`, which is an answer this cause never needed reaching for.

const T2741 = Date.parse("2026-09-27T19:00:00Z");
/** #1756's own shape: `ceo` holds it, and both declared blockers closed at `T2741`. */
const row1756 = () => heldRow(1756, "ceo",
  { blockedBy: { nodes: [{ number: 1931, state: "CLOSED" }, { number: 1959, state: "CLOSED" }] } });
const closedAt1756 = new Map([[1931, T2741], [1959, T2741]]);
const FIRST_1756_KEY = "ceo/blocker-cleared/row-1756/1931.1959";

test("#2741: a fresh clearing is asked at once under the pre-backoff key, then falls silent inside the window", () => {
  const [first] = blockerClearedOrders([row1756()], TODAY, T2741 + 20 * 60_000, { closings: closedAt1756 });
  assert.equal(first?.causeKey, FIRST_1756_KEY,
    "POSITIVE CONTROL: shipping this does not re-fire every key already in the ledger");
  assert.deepEqual(blockerClearedOrders([row1756()], TODAY, T2741 + 3 * HOUR_MS, { closings: closedAt1756 }), [],
    "an unanswered clearing is NOT re-asked on the old twenty-minute or two-hour TTL");
  const [second] = blockerClearedOrders([row1756()], TODAY, T2741 + 6 * HOUR_MS + 60_000, { closings: closedAt1756 });
  assert.equal(second?.causeKey, `${FIRST_1756_KEY}@6h`,
    "the same row IS asked again at the schedule's next horizon, under a NEW key");
});

test("#2741: with no closing times (an old caller, or a refused read), every ask is the unstaged first one", () => {
  // The exact fallback `unclaimedBlockerClearedOrders` already documents for its own `closings`: absent
  // or `null` behaves exactly as before this row, never toward silence.
  for (const now of [T2741 + 20 * 60_000, T2741 + 3 * HOUR_MS, T2741 + 40 * HOUR_MS]) {
    assert.deepEqual(blockerClearedOrders([row1756()], TODAY, now).map((o) => o.causeKey), [FIRST_1756_KEY],
      `now=${now}`);
  }
});

test("#2741: decide() passes the closing times through, and without them behaves as before", () => {
  const state = { prs: [], readyRows: [], openRows: [row1756()] };
  const asked = (closings?: Map<number, number> | null) =>
    decide({ ...state, ...(closings === undefined ? {} : { closings }) })
      .filter((o) => o.cause === "blocker-cleared").length;
  assert.equal(asked(), 1, "a caller that passes nothing gets the unstaged ask");
  assert.equal(asked(new Map([[1931, Date.now() - 30 * HOUR_MS], [1959, Date.now() - 30 * HOUR_MS]])), 0,
    "and one that passes closing times gets the backoff: 30h after the clearing is between the 24h and 72h asks");
  assert.equal(asked(new Map([[1931, Date.now() - 5 * 60_000], [1959, Date.now() - 5 * 60_000]])), 1,
    "POSITIVE CONTROL: a fresh clearing is still asked");
});

test("#2741: THROUGH wake's ledger, no window's causeKey is delivered enough times on its own to escalate", () => {
  // The shipped cadence (`work:tick`, every two minutes) over the span that held #1756's own first TWO
  // escalate/RESET cycles -- long enough to cross the 0h, 6h and 24h rungs of the ladder.
  const TICK = 2 * 60_000;
  const judgment = new Set(JUDGMENT_CAUSES);
  let ledger = "";
  for (let now = T2741 + TICK; now <= T2741 + 30 * HOUR_MS; now += TICK) {
    const live = readLedger("ledger", () => ledger, now, judgment);
    const orders = undelivered(blockerClearedOrders([row1756()], TODAY, now, { closings: closedAt1756 }), live);
    for (const o of orders) ledger += `${now}\t${o.causeKey}\n`;
  }
  const counts = deliveryCounts("ledger", () => ledger);
  assert.deepEqual([...counts.keys()].sort(), [FIRST_1756_KEY, `${FIRST_1756_KEY}@24h`, `${FIRST_1756_KEY}@6h`],
    "the ladder still asks three times over thirty hours -- it is a backoff, not a silence");
  for (const [key, n] of counts) {
    assert.ok(n < MAX_DELIVERIES, `${key} was delivered ${n} times on ONE unchanged key -- #1756 escalated `
      + `at exactly ${MAX_DELIVERIES}, and a window that changes the key every time it re-asks cannot reach that cap`);
  }
});

test("#2741: the SAME replay on the pre-#2741 key (no backoff) is what actually escalated #1756", () => {
  // POSITIVE CONTROL on the test above: reclassifying the group alone changes the TTL from twenty minutes
  // to two hours but not the fact that the key never changes, so the identical key keeps accumulating
  // deliveries across the same span -- this is the shape the backoff exists to break.
  const TICK = 2 * 60_000;
  const judgment = new Set(JUDGMENT_CAUSES);
  let ledger = "";
  for (let now = T2741 + TICK; now <= T2741 + 30 * HOUR_MS; now += TICK) {
    const live = readLedger("ledger", () => ledger, now, judgment);
    const orders = undelivered(blockerClearedOrders([row1756()], TODAY, now), live);
    for (const o of orders) ledger += `${now}\t${o.causeKey}\n`;
  }
  const counts = deliveryCounts("ledger", () => ledger);
  assert.deepEqual([...counts.keys()], [FIRST_1756_KEY], "one key for the whole span, with no closing times");
  assert.ok((counts.get(FIRST_1756_KEY) ?? 0) >= MAX_DELIVERIES,
    "and delivered at least six times on it -- the run this row's #2741 backoff must not reproduce");
});

test("#2741: anyBlockerClearingCandidate is the gate `main` pays `readRecentlyClosed` on", () => {
  assert.equal(anyBlockerClearingCandidate([row1756()], TODAY, T2741 + 60_000), true,
    "POSITIVE CONTROL: a claimed row whose blockers just cleared is exactly what `closingsWhenRowsCleared` must pay for");
  assert.equal(anyBlockerClearingCandidate([heldRow(1908, "worker-capture")], TODAY), false,
    "a row that never declared a blocker is not a candidate");
  assert.equal(anyBlockerClearingCandidate([heldRow(1908, "worker-capture",
    { blockedBy: { nodes: [{ number: 1948, state: "CLOSED" }, { number: 1918, state: "OPEN" }] } })], TODAY), false,
    "one still-open blocker is not a clearing -- the same positive control on the negative blockerClearedOrders pins");
  assert.equal(anyBlockerClearingCandidate([{ number: 1908, labels: [{ name: "ready" }], ...blockedByClosed }], TODAY),
    false, "an UNCLAIMED row is `unclaimedClearings`'s population, not this one");
  const held = heldRow(2114, "worker-judge", { ...blockedByClosed, body: "Fleet-hold-until: 2026-09-23T22:00:00Z" });
  assert.equal(anyBlockerClearingCandidate([held], TODAY, NOW), false,
    "a row the FLEET holds is not a candidate until the hold passes, matching `blockerClearedOrders` itself");
});

// --- #2780: the CLAIMED-row reader of the `needs:chairman` / `parked` gap ---------------------------
// #2583, #2604 and #2653 taught the three readers that reach an UNCLAIMED row; `blockerClearedOrders` addresses the
// holder of a CLAIMED one and was never taught either. #2623 (`needs:chairman`, still claimed) was asked 19+ times in a day.

test("#2780: a CLAIMED row labelled `needs:chairman` is WAITING, so its cleared blockers order no pick-up", () => {
  const waiting = heldRow(2623, "worker-2623", { ...blockedByClosed,
    labels: [{ name: "in-progress" }, { name: "session:worker-2623" }, { name: CHAIRMAN_LABEL }] });
  assert.deepEqual(blockerClearedOrders([waiting], TODAY), [],
    "#2623 was told to PICK IT BACK UP at every re-ask for a row whose one remaining step was the chairman's");
  assert.equal(anyBlockerClearingCandidate([waiting], TODAY), false,
    "`main` pays `readRecentlyClosed` on this predicate, so it must not count the row either");
  // THE CONTROL: the same row minus the label, so an empty result above is the label's doing.
  const control = heldRow(2623, "worker-2623", blockedByClosed);
  assert.equal(blockerClearedOrders([control], TODAY).length, 1,
    "POSITIVE CONTROL: without `needs:chairman` the same claimed row still reaches its holder");
  assert.equal(anyBlockerClearingCandidate([control], TODAY), true, "and is still a candidate");
});

test("#2780: a CLAIMED row labelled `parked` is WAITING on `ceo`, so its cleared blockers order no pick-up", () => {
  const parked = heldRow(2568, "worker-2568", { ...blockedByClosed,
    labels: [{ name: "in-progress" }, { name: "session:worker-2568" }, { name: PARKED_LABEL }] });
  assert.deepEqual(blockerClearedOrders([parked], TODAY), [],
    "a parked claimed row is scheduled by `ceo`, and a cleared blocker is not the event that resumes it");
  assert.equal(anyBlockerClearingCandidate([parked], TODAY), false, "nor is it a candidate for the closings read");
  const control = heldRow(2568, "worker-2568", blockedByClosed);
  assert.equal(blockerClearedOrders([control], TODAY).length, 1,
    "POSITIVE CONTROL: without `parked` the same claimed row still reaches its holder");
  assert.equal(blockerClearedOrders([parked, heldRow(2569, "worker-2569", blockedByClosed)], TODAY)
    .map((o) => o.session).join(), "worker-2569", "only the labelled row of a mixed set is dropped");
});

// --- #2139, the other half of #2027: nobody was told when an UNCLAIMED row's last blocker closed ----
//
// `blocker-cleared` above is scoped by `labelsOf(row).includes(CLAIM_LABEL)`, and that one condition is
// the gap. A row NOBODY holds reaches no cause at all when its blockers clear: `lane-backlog-unpromoted`
// addresses only a lane OWNER and `ready-queue-empty` fires only when the unlaned Ready pool is EMPTY.
//
// MEASURED 2026-09-23 ON THE LIVE TRACKER. A sweep for open rows whose every declared blocker is CLOSED
// returned SIX -- none claimed, none `ready`, all `lane:any`, every one structurally startable -- and
// they had been stranded 57m, 4h30m, 13h43m, 13h51m, 14h09m and 16h09m with three of five peer sessions
// idle. The Ready queue was NOT empty (four rows), which is exactly why the one cause that would
// eventually have looked stayed silent: a queue with depth and no throughput.

/** An unclaimed backlog row -- the population `blocker-cleared` cannot see, by the one label it lacks. */
const backlogRow = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: "a row whose blocker closed",
  labels: [{ name: "backlog" }, { name: "lane:any" }],
  ...extra,
});

test("#2139: an UNCLAIMED row whose declared blockers have ALL closed reaches product-manager", () => {
  const [order] = unclaimedBlockerClearedOrders([backlogRow(1998,
    { blockedBy: { nodes: [{ number: 1993, state: "CLOSED" }, { number: 1972, state: "CLOSED" }] } })], TODAY);
  assert.equal(order?.session, "product-manager",
    "promotion is that session's call -- agent-practices makes it first reader for rows and promotions");
  assert.equal(order?.cause, "unclaimed-blocker-cleared");
  assert.equal(order?.causeKey, "product-manager/unclaimed-blocker-cleared/row-1998/1972.1993",
    "keyed on the CLEARED SET and sorted, so the same clearing is one question however GitHub orders it");
  assert.match(order?.prompt ?? "", /#1998 \(a row whose blocker closed\)/, "the order names the row");
  assert.match(order?.prompt ?? "", /#1972, #1993/,
    "and what cleared, so no woken turn re-derives it -- the prompt carries the answer, not the question");
});

/**
 * THE POSITIVE CONTROL, AND IT IS THE WHOLE ROW (#2139's own Acceptance). Each of these three negatives
 * is a way a naive copy of `blockerClearedOrders` would announce rows that are not runnable, and a cause
 * that fires on all three is noise -- which is how the real signal gets filtered out.
 */
test("#2139: the three shapes that are NOT a clearing, against the one that is", () => {
  assert.deepEqual(unclaimedBlockerClearedOrders([backlogRow(1998)], TODAY), [],
    "a row that never declared a blocker is not freshly unblocked -- without this, every backlog row in "
    + "the tracker is announced on the first tick after this ships");
  assert.deepEqual(unclaimedBlockerClearedOrders([backlogRow(1998,
    { blockedBy: { nodes: [{ number: 1993, state: "CLOSED" }, { number: 1918, state: "OPEN" }] } })], TODAY), [],
    "the LAST condition to clear is the one that frees a row");
  assert.deepEqual(unclaimedBlockerClearedOrders([backlogRow(1998,
    { ...blockedByClosed, body: "Not-before: 2026-09-30" })], TODAY), [],
    "its `blockedBy` cleared and its `Not-before:` did not -- `waitingOn` is asked in full");
  assert.deepEqual(unclaimedBlockerClearedOrders([{ ...backlogRow(1998), ...blockedByClosed,
    labels: [{ name: "backlog" }, { name: `${ANSWER_PREFIX}ceo` }] }], TODAY), [],
    "#2005's rule: a row waiting on a ruling must not be made to look free");
  // AND THE CONTROL, same fixture shape, the only difference being that nothing else is outstanding. A
  // reader who sees every line above empty AND this one empty has a broken fixture, not a fixed repo.
  assert.equal(unclaimedBlockerClearedOrders([backlogRow(1998, blockedByClosed)], TODAY).length, 1,
    "POSITIVE CONTROL: the genuinely runnable row still reaches product-manager");
});

test("#2583: a row labelled `needs:chairman` is WAITING, so its cleared blockers order no promotion", () => {
  const labelled = { ...backlogRow(2561, blockedByClosed),
    labels: [{ name: "backlog" }, { name: "lane:any" }, { name: CHAIRMAN_LABEL }] };
  assert.deepEqual(unclaimedBlockerClearedOrders([labelled], TODAY), [],
    "#2561 was ordered to `product-manager` at every re-ask for a row whose first step was impossible");
  assert.equal(unclaimedClearings([labelled], TODAY).length, 0,
    "`main` reads this population before paying for `readRecentlyClosed`, so it must not count the row either");
  // THE CONTROL: the same row minus the label, so an empty result above is the label's doing and not a
  // fixture that never yielded an order.
  assert.equal(unclaimedBlockerClearedOrders([{ ...labelled,
    labels: [{ name: "backlog" }, { name: "lane:any" }] }], TODAY).length, 1,
    "POSITIVE CONTROL: without `needs:chairman` the same row still reaches product-manager");
});

test("#2653: a row labelled `parked` is WAITING on `ceo`, so its cleared blockers order no promotion", () => {
  // #2568: blockers #2561 and #2644 closed and `product-manager` had already parked it -- and the order came anyway.
  const parked = { ...backlogRow(2568, blockedByClosed),
    labels: [{ name: "backlog" }, { name: "lane:any" }, { name: PARKED_LABEL }] };
  assert.deepEqual(unclaimedBlockerClearedOrders([parked], TODAY), [],
    "a parked row was ordered to `product-manager` for promotion, and again at every re-ask");
  assert.equal(unclaimedClearings([parked], TODAY).length, 0,
    "`main` reads this population before paying for `readRecentlyClosed`, so it must not count the row either");
  // THE CONTROL: the same row minus the label, so an empty result above is the label's doing.
  assert.equal(unclaimedBlockerClearedOrders([{ ...parked,
    labels: [{ name: "backlog" }, { name: "lane:any" }] }], TODAY).length, 1,
    "POSITIVE CONTROL: without `parked` the same row still reaches product-manager");
});

test("#2139: a CLAIMED row is `blocker-cleared`'s, and a `ready` row is already offered", () => {
  const claimed = { ...backlogRow(1908), ...blockedByClosed,
    labels: [{ name: "in-progress" }, { name: "session:worker-capture" }] };
  assert.deepEqual(unclaimedBlockerClearedOrders([claimed], TODAY), [],
    "the two causes address different populations and must not be collapsed: this one would tell "
    + "`product-manager` to promote a row somebody is already building");
  assert.equal(blockerClearedOrders([claimed], TODAY).length, 1,
    "POSITIVE CONTROL on that exclusion -- the claimed row is not dropped, it is the other cause's");
  // `ready` IS EXCLUDED AND IT IS NOT TIDINESS. `rowOrders` already offers it, so an order asking for a
  // promotion that has already happened is not a duplicate -- it is an order whose own subject is false.
  assert.deepEqual(unclaimedBlockerClearedOrders([{ ...backlogRow(1998), ...blockedByClosed,
    labels: [{ name: "ready" }, { name: "lane:any" }] }], TODAY), [],
    "`ready-row-unclaimed` owns a row that is already on the shelf");
});

/**
 * #1561 IS THE SECOND HALF OF THE SHAPE, and the reason this cause NAMES a hiding label rather than
 * excluding the row. Its `blockedBy` edge cleared itself at 2026-09-23T08:28:00Z exactly as designed and
 * it still sat 4h30m, because a hand-set `blocked` LABEL outlived the referent it named: `blocked` is in
 * `NOT_PICKABLE`, so the self-clearing edge was overridden by the non-self-clearing label. Excluding the
 * row would reproduce the invisibility that stranded it -- and `blocked-unexaminable`, the only other
 * cause that could have reached it, is shelf-gated and was silent for the same four hours.
 */
test("#2139: a row hidden by a NOT_PICKABLE label is REPORTED with the label named, never as free", () => {
  const [order] = unclaimedBlockerClearedOrders([{ ...backlogRow(1561), ...blockedByClosed,
    labels: [{ name: "backlog" }, { name: "blocked" }] }], TODAY);
  assert.ok(order, "excluding it is how #1561 sat 4h30m after its own edge cleared");
  assert.match(order?.prompt ?? "", /IT STILL CARRIES `blocked`/,
    "the order must not report a row that nothing will pick up as free");
  assert.match(order?.prompt ?? "", /4h30m/, "and it names what that cost, so the answer is one edit");
  const clean = unclaimedBlockerClearedOrders([backlogRow(1998, blockedByClosed)], TODAY);
  assert.doesNotMatch(clean[0]?.prompt ?? "", /IT STILL CARRIES/,
    "POSITIVE CONTROL on the sentence: a row with nothing hiding it does not carry the warning, so the "
    + "assertion above is not matching text every order has");
});

test("#2139: the cause is in the CAUSES contract wake.mjs routes on, and is START and JUDGMENT", () => {
  assert.ok(CAUSES.includes("unclaimed-blocker-cleared"),
    "a cause the gate computes and does not publish reaches nobody, which is this row's entire subject -- "
    + "and worker-profile refuses an unlisted cause at run time");
  assert.ok(START_CAUSES.includes("unclaimed-blocker-cleared"),
    "nobody holds this row, so promoting it is the org TAKING ON work -- the line the partition draws");
  assert.ok(JUDGMENT_CAUSES.includes("unclaimed-blocker-cleared"),
    "\"it stays in backlog\" does not stop being true twenty minutes later; an ACTION expiry would re-ask "
    + "it for ever, which is the treadmill measured on lane-backlog-unpromoted");
});

test("#2139: decide() routes it, and NOT behind an empty-shelf gate", () => {
  const orders = decide({ prs: [], readyRows: [readyRow(2222)],
    openRows: [backlogRow(1998, blockedByClosed)] });
  const order = orders.find((o) => o.cause === "unclaimed-blocker-cleared");
  assert.equal(order?.session, "product-manager",
    "the Ready queue was NOT empty on 2026-09-23 -- four rows -- which is exactly why `ready-queue-empty` "
    + "stayed silent while six rows sat runnable. Depth is not throughput.");
  const causes = orders.map((o) => o.cause);
  assert.ok(causes.indexOf("ready-row-unclaimed") < causes.indexOf("unclaimed-blocker-cleared"),
    "behind the offers: a row already on the shelf can be claimed this minute, this one needs promoting");
  assert.deepEqual(decide({ prs: [], readyRows: [readyRow(2222)],
    openRows: [backlogRow(1998, blockedByClosed)], drain: true })
    .filter((o) => o.cause === "unclaimed-blocker-cleared"), [],
    "a transfer window stops the org taking on work, and this is the plainest case of taking some on");
});

// --- #2286: an UNANSWERED promotion order backs off instead of repeating on the two-hour TTL -----------
//
// MEASURED 2026-09-24 (a reading at a moment, from the host wake ledger): 28 of `product-manager`'s 46
// recent deliveries were `unclaimed-blocker-cleared`, and 23 of those were FOUR rows re-asked at an
// unchanged key on `JUDGMENT_TTL_MS`, six times each over ten hours. #2280 found the same thing across
// the whole ledger: 447 of 454 redundant deliveries were this re-ask working as designed.

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-09-23T22:00:00Z");
/** A backlog row whose blocker #2139 closed at `T0`, and the closing times that say so. */
const clearedRow = (n: number) => backlogRow(n, { blockedBy: { nodes: [{ number: 2139, state: "CLOSED" }] } });
const closedAtT0 = new Map([[2139, T0]]);
const askKeys = (rows: object[], now: number, closings: Map<number, number> | null = closedAtT0) =>
  unclaimedBlockerClearedOrders(rows, TODAY, { closings, now }).map((o) => o.causeKey);
const FIRST_KEY = "product-manager/unclaimed-blocker-cleared/row-2161/2139";

test("#2286: the schedule -- each window is one ask, the ladder is 0/6h/24h and the tail never ends", () => {
  const at = (h: number, m = 0) => promotionAskWindow(h * HOUR + m * 60_000)?.suffix;
  assert.equal(at(0), "", "the clearing itself is asked AT ONCE, and its key is the pre-#2286 key");
  assert.equal(at(1, 59), "", "still the first window a minute before it closes");
  assert.equal(at(2), undefined, "between asks nothing is emitted: this is the silence that ends the treadmill");
  assert.equal(at(5, 59), undefined);
  assert.equal(at(6), "@6h", "the second ask");
  assert.equal(at(8), undefined);
  assert.equal(at(24), "@24h", "the third");
  assert.equal(at(48), undefined);
  assert.equal(at(72), "@72h", "the tail begins");
  assert.equal(at(144), "@144h", "and every 72h after, FOR EVER -- ceo's first constraint: never silent");
  assert.equal(at(24 * 365 + 6), undefined, "a year on it is between asks, not switched off...");
  assert.notEqual(promotionAskWindow(72 * 40 * HOUR)?.suffix, undefined, "...and asked again at a later multiple");
  assert.equal(promotionAskWindow(-5 * HOUR)?.suffix, "", "a closing stamped in the future (clock skew) is a fresh one");
  assert.deepEqual([...PROMOTION_ASK_OFFSETS_MS], [0, 6 * HOUR, 24 * HOUR], "the ladder, in one place");
  assert.equal(PROMOTION_ASK_PERIOD_MS, 72 * HOUR);
});

test("#2286: the window is EXACTLY the wake ledger's judgment TTL -- that equality is the whole mechanism", () => {
  assert.equal(PROMOTION_ASK_WINDOW_MS, JUDGMENT_TTL_MS,
    "shorter would still ask once per window; longer lets the TTL re-ask INSIDE a window, which is the "
    + "treadmill. `wake.mjs` imports the gate, so the gate cannot import this number: a test holds both.");
});

test("#2286: a FRESH clearing is asked at once, then again at each horizon -- and not between", () => {
  const row = [clearedRow(2161)];
  assert.deepEqual(askKeys(row, T0 + 20 * 60_000), [FIRST_KEY],
    "POSITIVE CONTROL: the first ask is immediate and byte-identical to the unstaged key, so shipping "
    + "this does not re-fire every key already in the ledger");
  assert.deepEqual(askKeys(row, T0 + 3 * HOUR), [], "an unanswered order is NOT re-asked on the TTL");
  assert.deepEqual(askKeys(row, T0 + 6 * HOUR + 60_000), [`${FIRST_KEY}@6h`],
    "POSITIVE CONTROL: the same row IS asked again after the schedule's horizon, under a NEW key");
  assert.deepEqual(askKeys(row, T0 + 30 * HOUR), [], "and stays quiet between the later ones");
  assert.deepEqual(askKeys(row, T0 + 25 * HOUR), [`${FIRST_KEY}@24h`]);
  assert.deepEqual(askKeys(row, T0 + 73 * HOUR), [`${FIRST_KEY}@72h`]);
});

test("#2286: a CHANGED cleared set is a new question, delivered at once whatever the old one's age", () => {
  const twice = backlogRow(2161, { blockedBy: { nodes: [{ number: 2139, state: "CLOSED" },
    { number: 2186, state: "CLOSED" }] } });
  const closings = new Map([[2139, T0], [2186, T0 + 30 * HOUR]]);
  assert.deepEqual(askKeys([twice], T0 + 30.5 * HOUR, closings),
    ["product-manager/unclaimed-blocker-cleared/row-2161/2139.2186"],
    "the row was blocked again and cleared again: its anchor is the LAST closing, its key names the new "
    + "set, so it reaches `product-manager` immediately instead of waiting for the old set's next horizon");
  assert.deepEqual(askKeys([clearedRow(2161)], T0 + 30.5 * HOUR, closings), [],
    "CONTROL: the old set, unchanged, is still in its silence at the same instant");
});

test("#2286: a row whose ANSWER has been written is not asked at all, even inside a window", () => {
  const now = T0 + 20 * 60_000;
  const inside = (extra: Record<string, unknown>) => askKeys([{ ...clearedRow(2161), ...extra }], now);
  assert.equal(inside({}).length, 1, "POSITIVE CONTROL: the same row, unanswered, is inside its first window");
  assert.deepEqual(inside({ labels: [{ name: "ready" }] }), [], "`ready` is the promotion");
  assert.deepEqual(inside({ body: "Not-before: 2099-01-01T00:00:00Z" }), [], "a `Not-before:` is an answer");
  // #2812: the hour is read against the INJECTED clock, so this is 100 minutes after `now` on any wall-clock day.
  // Before the fix it was read against the real one, where 2026-09-24T00:00Z is long past and the row was asked.
  const hourAfterNow = new Date(now + 100 * 60_000).toISOString().replace(".000Z", "Z");
  assert.deepEqual(inside({ body: `Not-before: ${hourAfterNow}` }), [], "an HOUR-form `Not-before:` is read at `now`");
  assert.equal(inside({ body: `Not-before: ${new Date(now - 60_000).toISOString().replace(".000Z", "Z")}` }).length, 1,
    "POSITIVE CONTROL: the same wait a minute in the past has lapsed at `now`, so the row IS asked");
  assert.deepEqual(inside({ labels: [{ name: "backlog" }, { name: `${ANSWER_PREFIX}ceo` }] }), [],
    "`answer:<session>` is an answer");
  assert.deepEqual(inside({ blockedBy: { nodes: [{ number: 2139, state: "CLOSED" },
    { number: 2186, state: "OPEN" }] } }), [], "a new open `blockedBy` edge is an answer");
});

test("#2286: a refused closing-time read FAILS OPEN to the unstaged ask, never to silence", () => {
  assert.deepEqual(askKeys([clearedRow(2161)], T0 + 20 * 60_000, null), [FIRST_KEY],
    "no closing time means the gate cannot tell a fresh clearing from an old one, and silencing a fresh "
    + "one is the 16h09m stranding #2139 ended");
  assert.deepEqual(askKeys([clearedRow(2161)], T0 + 3 * HOUR, null), [FIRST_KEY],
    "it is today's behaviour, TTL and all -- degraded, not dropped");
  assert.equal(readRecentlyClosed(() => { throw new Error("rate limited"); }), null, "a refusal is null");
  assert.equal(readRecentlyClosed(() => "{}"), null, "so is a body that is not a list");
  const read = readRecentlyClosed(() => JSON.stringify([{ number: 2139, closedAt: "2026-09-23T22:00:00Z" },
    { number: 7, closedAt: "not a date" }]));
  assert.deepEqual([...(read ?? [])], [[2139, T0]], "POSITIVE CONTROL: a good read maps number to epoch ms, "
    + "and a row with no usable stamp is left out rather than read as the epoch");
});

test("#2286: a blocker older than the closed-rows window lands on the wall-clock grid, not on a fresh ask", () => {
  const row = [clearedRow(2161)];
  const unknown = new Map<number, number>();
  assert.deepEqual(askKeys(row, Date.parse("2026-09-23T12:00:00Z"), unknown), [],
    "an unknown closing is OLD, so 12:00Z on a day that is not a 72h multiple is between asks");
  const grid = Math.ceil(Date.parse("2026-09-23T12:00:00Z") / PROMOTION_ASK_PERIOD_MS) * PROMOTION_ASK_PERIOD_MS;
  assert.equal(askKeys(row, grid + 60_000, unknown).length, 1,
    "POSITIVE CONTROL: and it is asked once per 72h, so an old clearing is never silent either");
});

test("#2286: decide() passes the closing times through, and without them behaves as before", () => {
  const state = { prs: [], readyRows: [readyRow(2222)], openRows: [clearedRow(2161)] };
  const asked = (closings?: Map<number, number> | null) =>
    decide({ ...state, ...(closings === undefined ? {} : { closings }) })
      .filter((o) => o.cause === "unclaimed-blocker-cleared").length;
  assert.equal(asked(), 1, "a caller that passes nothing gets the unstaged ask");
  assert.equal(asked(new Map([[2139, Date.now() - 30 * HOUR + 3 * 60_000]])), 0,
    "and one that passes closing times gets the backoff: 30h after the clearing is between the 24h and 72h asks");
  assert.equal(asked(new Map([[2139, Date.now() - 5 * 60_000]])), 1, "POSITIVE CONTROL: a fresh one is asked");
});

test("#2286: THROUGH wake's ledger, ten hours of an unanswered row is 2 deliveries, not 6", () => {
  const row = [clearedRow(2161)];
  const TICK = 10 * 60_000;
  const judgment = new Set(JUDGMENT_CAUSES);
  const replay = (closings: Map<number, number> | null) => {
    let ledger = "";
    let delivered = 0;
    for (let now = T0 + TICK; now <= T0 + 10 * HOUR; now += TICK) {
      const live = readLedger("ledger", () => ledger, now, judgment);
      const orders = undelivered(unclaimedBlockerClearedOrders(row, TODAY, { closings, now }), live);
      for (const o of orders) { ledger += `${now}\t${o.causeKey}\n`; delivered += 1; }
    }
    return delivered;
  };
  assert.equal(replay(null), 5,
    "POSITIVE CONTROL: with no backoff the SAME loop reproduces the measured treadmill -- one delivery "
    + "per two-hour TTL -- so the 2 below is the schedule, not a loop that cannot deliver");
  assert.equal(replay(closedAtT0), 2, "the first ask, and the six-hour one -- and nothing between");
});

// --- #2110: a row that moved under the session holding it ------------------------------------------
//
// MEASURED TWICE IN ONE MORNING, 2026-09-23. #2099 was claimed by `worker-capture` at 09:54:06Z and
// built by 10:16:50Z; `product-manager` recorded `ceo`'s ruling on it at 10:22:34Z -- 28 minutes after
// the claim, 6 minutes after the work was finished. The gate emitted NO cause for `worker-capture`:
// `ready-row-unclaimed` had stopped matching at the claim, and `blocker-cleared` is the only cause whose
// subject is a row somebody already holds. The same hour, `orchestrator` held #1918 while it acquired an
// open `blockedBy` on #2100 -- the same defect wearing the other marker, and the one a claim-time rule
// (`blocked-by-edge-rule.mjs`, #1886) can never reach because the edge arrives AFTER the claim.

const CLAIM_RECORD = { id: "IC_claim", body: "<!-- row-claim: claim record -->\n**Claim record** -- claimed by `worker-capture`." };
const CONSTRAINT = { id: "IC_constraint",
  body: "## CONSTRAINT\n\n`ceo`'s ruling: this row may NOT be implemented by granting a token." };
const BUILD_REPORT = { id: "IC_build", body: "Built as draft #2105. The Acceptance passes at `0da227db0`." };

/** A claimed row, with the comment page `readClaimedRowComments` would have returned for it. */
const withComments = (n: number, comments: { id: string; body: string }[]) => [{ number: n, comments }];

test("#2110: a `## CONSTRAINT` comment posted after the claim wakes the SESSION THAT HOLDS THE ROW", () => {
  // THE POSITIVE, first and alone: every silence assertion below is satisfied by a function that returns
  // `[]` for everything, and this is the one that is not.
  const [order] = claimedRowAmendedOrders([heldRow(2099, "worker-capture")],
    withComments(2099, [CLAIM_RECORD, BUILD_REPORT, CONSTRAINT]));
  assert.equal(order?.session, "worker-capture",
    "read from the row's own `session:` label -- no address book, which is why this is the gate's "
    + "question and not a messaging one");
  assert.equal(order?.cause, "claimed-row-amended");
  assert.equal(order?.causeKey, "worker-capture/claimed-row-amended/row-2099/IC_constraint",
    "keyed on the MARKER, so a second constraint is a second question and an unchanged row is silent");
  assert.match(order?.prompt ?? "", /## CONSTRAINT/,
    "the prompt names what changed; a woken turn that has to survey the row is a tick with extra steps");
});

/**
 * DONE-WHEN 2's POSITIVE CONTROL, AND THE REASON THIS CAUSE IS NARROW AT ALL.
 *
 * A cause that fired on ANY comment on a claimed row would wake the holder for their own claim record,
 * their own build report and every clarifying reply -- the comment-noise problem arriving one door along
 * from the gap it was written to close. Without this assertion the cause is a noise generator that every
 * other test here still passes.
 */
test("#2110: an ORDINARY comment on a claimed row emits nothing -- a claim record, a build report", () => {
  assert.deepEqual(claimedRowAmendedOrders([heldRow(2099, "worker-capture")],
    withComments(2099, [CLAIM_RECORD, BUILD_REPORT])), [],
    "the marker is DECLARED and parsed, never inferred from prose");
  assert.deepEqual(claimedRowAmendedOrders([heldRow(2099, "worker-capture")], withComments(2099, [])), [],
    "and a claimed row with no comments at all is not an amendment either");
});

test("#2110: a constraint the row ALREADY CARRIED at claim time is not news -- the record is the clock", () => {
  // `gh issue list --json comments` returns OLDEST-FIRST, so "after the claim" is a position in a list
  // the gate already holds. A row claimed, released and claimed again anchors on the NEWEST record --
  // `claimRecordFrom`'s own rule, and for the same reason: the CURRENT holder is the one being told.
  assert.deepEqual(claimedRowAmendedOrders([heldRow(2099, "worker-capture")],
    withComments(2099, [CONSTRAINT, CLAIM_RECORD])), [],
    "it was there to be read when the row was taken; this cause is about a row moving UNDER a holder");
  assert.deepEqual(constraintsAfterClaim([CONSTRAINT, CLAIM_RECORD, BUILD_REPORT]), []);
  assert.deepEqual(constraintsAfterClaim([CONSTRAINT, CLAIM_RECORD, CONSTRAINT]).map((c) => c.id),
    ["IC_constraint"], "the SECOND claim is the anchor, and the constraint after it still counts");
});

test("#2110: a comment that QUOTES the marker is not a constraint -- mention versus use", () => {
  // The trap `acceptance-commands.mjs`'s header names, and the one a plain `includes` walks into: the
  // comment announcing this very cause on the row would have fired it.
  const quoting = { id: "IC_meta",
    body: "I am adding a cause that fires on a `## CONSTRAINT` heading -- see #2110 for the shape." };
  assert.deepEqual(claimedRowAmendedOrders([heldRow(2110, "worker-capture")],
    withComments(2110, [CLAIM_RECORD, quoting])), [],
    "anchored to a line start, or this repo's own announcement of the feature triggers it");
  assert.ok(CONSTRAINT_COMMENT_MARKER === "## CONSTRAINT",
    "the literal #2099 actually used at 10:22:34Z, before this cause existed to read it");
});

test("#2110: a `Constraint:` line in the ROW BODY is the other declared spelling", () => {
  const [order] = claimedRowAmendedOrders(
    [heldRow(1234, "orchestrator", { body: "## What is wrong\n\nConstraint: no new unconditional read.\n" })],
    withComments(1234, [CLAIM_RECORD]));
  assert.equal(order?.cause, "claimed-row-amended");
  assert.match(order?.prompt ?? "", /Constraint: no new unconditional read\./,
    "the whole line is quoted back, so the woken turn does not have to go and find it");
  assert.ok(CONSTRAINT_BODY_PREFIX === "Constraint:",
    "the `Acceptance:`/`Closes:`/`Not-before:` family's shape -- a declared, parsed body field");
});

test("#2110: a REPLACED body constraint is a new question, because the key is the LINE and not its presence", () => {
  const keyFor = (line: string) => claimedRowAmendedOrders(
    [heldRow(1234, "orchestrator", { body: `${line}\n` })], withComments(1234, [CLAIM_RECORD]))[0]?.causeKey;
  const first = keyFor("Constraint: no new unconditional read.");
  const second = keyFor("Constraint: no new unconditional read, and no per-row call.");
  assert.ok(first && second, "both must produce an order at all, or this compares two silences");
  assert.notEqual(first, second,
    "keying on mere PRESENCE would make a row whose constraint was rewritten look unchanged -- and the "
    + "rewrite is exactly the amendment a holder must be told about");
});

/**
 * DONE-WHEN 5, AND IT IS THE CHEAP HALF: `blockedBy` already rides the unconditional read that
 * `blocker-cleared` makes. #1918 was claimed by `orchestrator` while clean and acquired an open edge on
 * #2100 afterwards. The report that produced this half was itself wrong about the cause -- it concluded
 * `claimRow` never reads `blockedBy`, when #1886 closed COMPLETED 2026-09-22T05:28:36Z and
 * `blocked-by-edge-rule.mjs` refuses such a claim before B4. That refusal is what makes the inference
 * here sound: an OPEN edge on a row that IS claimed can only have arrived after the claim.
 */
test("#2110: #1918 gained an open `blockedBy` on #2100 while `orchestrator` held it", () => {
  const [order] = claimedRowAmendedOrders(
    [heldRow(1918, "orchestrator", { blockedBy: { nodes: [{ number: 2100, state: "OPEN" }] } })],
    withComments(1918, [CLAIM_RECORD]));
  assert.equal(order?.session, "orchestrator");
  assert.equal(order?.causeKey, "orchestrator/claimed-row-amended/row-1918/blocked.2100");
  assert.match(order?.prompt ?? "", /#2100/, "the prompt names the blocker, not just the fact of one");
});

test("#2110: a CLOSED blocker is not an amendment -- `blocker-cleared` owns that direction", () => {
  assert.deepEqual(claimedRowAmendedOrders([heldRow(1908, "worker-capture", { ...blockedByClosed })],
    withComments(1908, [CLAIM_RECORD])), [],
    "this cause says a row got HARDER; the row getting easier is #2027's, and emitting both would wake "
    + "a holder twice for one event");
  assert.deepEqual(amendmentsOn({ number: 1908, ...blockedByClosed }, [CLAIM_RECORD]), []);
});

test("#2110: an UNCLAIMED row is outside this cause entirely -- there is nobody it is news to", () => {
  const constrained = withComments(2099, [CLAIM_RECORD, CONSTRAINT]);
  assert.deepEqual(claimedRowAmendedOrders([{ number: 2099, labels: [{ name: "ready" }] }], constrained), [],
    "a constraint on a free row is read by whoever claims it -- that is what claiming a row is");
  assert.deepEqual(claimedRowAmendedOrders([{ number: 2099, labels: [{ name: "in-progress" }] }], constrained), [],
    "a claim with no `session:` label names nobody, and waking a session called \"\" is an order with "
    + "nowhere to go");
  // A `session:` LABEL WITHOUT THE CLAIM IS NOT A HOLDER -- `ready-label-audit.mjs` names this as #171's
  // shape, a correct decline whose restore silently did not happen. Caught by a mutation: with the
  // `in-progress` test deleted, every other case in this block still passed.
  assert.deepEqual(claimedRowAmendedOrders(
    [{ number: 2099, labels: [{ name: "was-ready" }, { name: "session:worker-capture" }] }], constrained), [],
    "the claim label is what says a session is HOLDING the row");
});

test("#2110: an unchanged row mints the SAME key every tick, and a second constraint mints a new one", () => {
  const row = heldRow(2099, "worker-capture");
  const once = claimedRowAmendedOrders([row], withComments(2099, [CLAIM_RECORD, CONSTRAINT]));
  const twice = claimedRowAmendedOrders([row], withComments(2099, [CLAIM_RECORD, CONSTRAINT]));
  assert.deepEqual(once, twice,
    "byte-identical, so the waker's ledger deduplicates it -- that is what lets this gate be stateless");
  const second = { id: "IC_constraint2", body: "## CONSTRAINT\n\nAnd it must not add an unconditional read." };
  const after = claimedRowAmendedOrders([row], withComments(2099, [CLAIM_RECORD, CONSTRAINT, second]));
  assert.notEqual(after[0]?.causeKey, once[0]?.causeKey,
    "a SECOND constraint is a second order -- the newest marker names the key, so the dedupe stops matching");
});

test("#2182: it is a JUDGMENT cause -- its answer is durable, so an unchanged row is not re-asked", () => {
  assert.ok(CAUSES.includes("claimed-row-amended"),
    "it must be in CAUSES or worker-profile refuses it at run time");
  // MEASURED ON #1955: four offers in 71 minutes for one open `blockedBy` edge that was correct,
  // acknowledged three times and self-clearing. Reading an amendment and accepting it changes neither
  // the row nor the marker, so the holder reaches the same conclusion every time it is asked.
  assert.ok(JUDGMENT_CAUSES.includes("claimed-row-amended"),
    "a holder who has decided to wait reaches the same answer on every re-ask");
  // STILL FINISH, AND THAT IS UNCHANGED BY THIS. #2110 put it outside START_CAUSES because a drain is
  // exactly the window in which withholding it costs most -- a constraint arriving unread during one is
  // a build finished against a rule nobody applied.
  assert.ok(!START_CAUSES.includes("claimed-row-amended"),
    "FINISH: its subject is a row the session already holds");
});

test("#2182: the UNCHANGED marker set goes quiet past the action clock, and a CHANGED one does not", () => {
  // THE BEHAVIOUR, NOT THE MEMBERSHIP. Naming the cause in a frozen array is satisfied by editing the
  // array; what the row asks for is that `wake.mjs`'s reader actually suppresses the re-offer, so this
  // drives the SHIPPED `readLedger` over a ledger holding the SHIPPED key.
  const row = heldRow(2099, "worker-capture");
  const unchanged = claimedRowAmendedOrders([row], withComments(2099, [CLAIM_RECORD, CONSTRAINT]));
  const key = unchanged[0]?.causeKey ?? "";
  assert.equal(key, "worker-capture/claimed-row-amended/row-2099/IC_constraint",
    "the key this test suppresses is the one the gate really mints");

  const at = Date.parse("2026-09-23T15:29:26Z");     // #1955's first offer, to the second
  const ledger = `${at}\t${key}\n`;
  const read = () => ledger;
  const live = (now: number) => readLedger("/ledger", read as never, now, new Set(JUDGMENT_CAUSES));

  // PAST THE TWENTY-MINUTE ACTION CLOCK AND STILL SILENT -- this is the defect, in one assertion.
  // At 31 minutes #1955 was offered a second time; under the judgment clock it is not.
  assert.ok(live(at + WAKE_TTL_MS + 60_000).has(key),
    "31 minutes on, an unchanged wait must not buy another model turn to reach the same conclusion");
  assert.ok(live(at + JUDGMENT_TTL_MS - 60_000).has(key), "still silent just inside the judgment window");
  // DURABLE IS NOT ETERNAL. Shipped as never-expiring, this silenced `ready-queue-empty` for four hours
  // with six agents idle -- so the two-hour ceiling is asserted rather than assumed.
  assert.ok(!live(at + JUDGMENT_TTL_MS + 1).has(key), "and it IS re-offered once the window closes");

  // THE POSITIVE CONTROL, IN THE SAME RUN. Without it every assertion above passes against a reader that
  // returns every key it is given, and against a cause that simply stopped being emitted. A SECOND
  // marker is a different key, so the same ledger line does not cover it and the holder is told at once.
  const second = { id: "IC_constraint2", body: "## CONSTRAINT\n\nAnd it must not add an unconditional read." };
  const changed = claimedRowAmendedOrders([row], withComments(2099, [CLAIM_RECORD, CONSTRAINT, second]));
  const changedKey = changed[0]?.causeKey ?? "";
  assert.notEqual(changedKey, key, "a second constraint is a second question");
  assert.ok(!live(at + 60_000).has(changedKey),
    "one minute later, a CHANGED marker set reaches the holder on the next tick -- the half a careless "
    + "fix would break by keying on the row instead of on what it carries");
});

test("#2110: two markers on one row are ONE order naming both, keyed on the pair", () => {
  // Not two orders: the holder has one row to go and read, and waking them twice for it is the noise
  // this cause is narrow to avoid. The key is the SET, so either marker changing is a new question.
  const [order, ...rest] = claimedRowAmendedOrders(
    [heldRow(1918, "orchestrator", { blockedBy: { nodes: [{ number: 2100, state: "OPEN" }] } })],
    withComments(1918, [CLAIM_RECORD, CONSTRAINT]));
  assert.deepEqual(rest, [], "one row, one order");
  assert.equal(order?.causeKey, "orchestrator/claimed-row-amended/row-1918/IC_constraint+blocked.2100");
  assert.match(order?.prompt ?? "", /and an open `blockedBy` edge on #2100/);
});

test("#2110: the per-tick cap applies, so one bad morning cannot wake a session nine times", () => {
  const rows = Array.from({ length: MAX_ROW_ORDERS_PER_TICK + 3 },
    (_unused, i) => heldRow(3000 + i, "worker-capture", { body: "Constraint: read this.\n" }));
  assert.equal(claimedRowAmendedOrders(rows, []).length, MAX_ROW_ORDERS_PER_TICK);
});

test("#2110: claimed-row-amended is a FINISH cause, and a drain is where withholding it costs most", () => {
  assert.ok(CAUSES.includes("claimed-row-amended"),
    "it must be in CAUSES or worker-profile refuses it at run time");
  assert.ok(!START_CAUSES.includes("claimed-row-amended"),
    "its subject is a row the session ALREADY HOLDS -- and a window exists to LAND work in flight, which "
    + "is exactly when a build finished against an unread rule is least affordable");
});

test("#2110: decide() routes it, ahead of blocker-cleared and every cause that offers new work", () => {
  const held = heldRow(2099, "worker-capture", { ...blockedByClosed });
  const orders = decide({ prs: [], readyRows: [], openRows: [held],
    claimedComments: withComments(2099, [CLAIM_RECORD, CONSTRAINT]) });
  const causes = orders.map((o) => o.cause);
  assert.ok(causes.includes("claimed-row-amended"),
    "before this, the gate could see the row change and had nobody to tell");
  assert.ok(causes.indexOf("claimed-row-amended") < causes.indexOf("blocker-cleared"),
    "an unread constraint means work in progress is being done against a rule nobody applied; a cleared "
    + "blocker merely means work can start again and loses nothing by waiting a tick");
  assert.equal(orders.find((o) => o.cause === "claimed-row-amended")?.session, "worker-capture");
});

test("#2110: a caller that could not read the comments still sees the body and edge markers", () => {
  // `[]` is "not asked or refused". The degradation may go QUIET on the half it could not read; it must
  // never invent a constraint, and it must never be worse than before this cause existed.
  assert.deepEqual(decide({ prs: [], readyRows: [],
    openRows: [heldRow(2099, "worker-capture")] }).map((o) => o.cause), [],
    "no comments, no body line, no open edge -- nothing to say");
  const [order] = claimedRowAmendedOrders(
    [heldRow(1918, "orchestrator", { blockedBy: { nodes: [{ number: 2100, state: "OPEN" }] } })], []);
  assert.equal(order?.cause, "claimed-row-amended",
    "the edge rides the read that already happened, so a refused comments page cannot silence it");
});

test("#2110: the claimed-row read is ONE call, filtered server-side, and refuses to `null`", () => {
  const calls: string[][] = [];
  const rows = readClaimedRowComments((args: string[]) => {
    calls.push(args);
    return JSON.stringify([{ number: 2099, comments: [CLAIM_RECORD] }]);
  });
  assert.equal(calls.length, 1, "one call for the whole claimed population -- never one per row");
  assert.deepEqual(calls[0], ["issue", "list", "--state", "open", "--label", "in-progress",
    "--limit", "200", "--json", "number,comments"]);
  assert.equal(rows?.length, 1);
  assert.equal(readClaimedRowComments(() => { throw new Error("HTTP 403"); }), null,
    "#1286's rule: a refused read is `null` and never `[]` -- a refusal that reads as an empty page "
    + "reports every claimed row as unamended");
});

test("#2110: main pays for it only when something is actually claimed", () => {
  const gate = readFileSync(fileURLToPath(new URL("../work-gate.mjs", import.meta.url)),
    "utf8");
  // The `decide` jsdoc spells the same call shape when it says where `claimedComments` comes from, so
  // prose is excluded by its backtick rather than by counting matches -- `cannotAskReport`'s own pin one
  // test down makes the identical exclusion for the identical reason.
  assert.equal(gate.match(/(?<!`)readClaimedRowComments\(\)/g)?.length, 1,
    "exactly one call site, and it is inside the condition below -- a second is a second price");
  assert.match(gate, /const held = openRows\.some\(\(r\) => labelsOf\(r\)\.includes\(CLAIM_LABEL\)\);\s*\n\s*return held \? readClaimedRowComments\(\) : null;/,
    "the condition is answered from rows already in hand, so asking it costs no call of its own");
  assert.equal(GH_READS.unconditional.length, 11,
    "#2110 adds no UNCONDITIONAL read -- the comment page is conditional on a claim existing");
});

/**
 * #2003: A DEAD POOL AND A QUIET QUEUE LOOKED IDENTICAL FROM THE JOURNAL.
 *
 * Measured 2026-09-22. `a11ign-ai-workers` reached `used 5000, remaining 0`, and from 20:28:15Z every tick
 * logged the same four lines and woke nobody. The refusal was correct and loud, and still left the only
 * three facts a reader needs unstated: WHICH account, WHICH pool, and WHEN it comes back. `328832207` is a
 * user ID, not a login, and the answer to "for how long" -- 52 minutes -- was in the headers of the call
 * that had just failed.
 *
 * WHY A FIXTURE AND NOT A LIVE CALL: the probe has to be exercised on a DEAD pool, which is the one state
 * a test cannot create. So the fake `run` reproduces what `execFileSync` does when `gh` exits non-zero --
 * it THROWS with the response on `error.stdout` -- because that is the property the whole reading rests on,
 * and a fake that returned the response normally would pass while the real refusal path returned null.
 */
const DEAD_GRAPHQL = [
  "HTTP/2.0 200 OK",
  "X-Ratelimit-Limit: 5000",
  "X-Ratelimit-Remaining: 0",
  "X-Ratelimit-Reset: 1790127611",
  "X-Ratelimit-Resource: graphql",
  "X-Ratelimit-Used: 5000",
  "",
  '{"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded for user ID 328832207."}]}',
].join("\r\n");

const LIVE_GRAPHQL = [
  "HTTP/2.0 200 OK",
  "X-Ratelimit-Limit: 5000",
  "X-Ratelimit-Remaining: 3340",
  "X-Ratelimit-Reset: 1790119231",
  "X-Ratelimit-Resource: graphql",
  "X-Ratelimit-Used: 1660",
  "",
  '{"data":{"viewer":{"login":"a11ign-ai-workers"}}}',
].join("\r\n");

/** A `gh` that fails the way `execFileSync` fails: non-zero, with the response still on `stdout`. */
const refusedWith = (stdout: string) => () => {
  throw Object.assign(new Error("gh exited 1"), { status: 1, stdout });
};

/** Records every `gh` invocation, so "how many calls did that cost" is counted rather than reasoned about. */
function recordingRun(reply: (args: string[]) => string) {
  const calls: string[][] = [];
  return {
    calls,
    run: (args: string[]) => { calls.push(args); return reply(args); },
  };
}

// --- #1984: `identity` IS NOW REQUIRED, AND EVERY EXISTING FIXTURE HERE PICKS ONE ON PURPOSE -------------
//
// `cannotAskReport` no longer defaults it (the same reasoning `run` has carried since #1405): a defaulted
// read of `.agent-org/host.json` and a real `hosts.yml` would make these tests depend on whatever THIS
// host happens to have installed. `UNASKED_IDENTITY` is what every test below that is not ABOUT identity
// passes, so `gh-identity-declared.test.ts` -- not this file -- owns proving the real function resolves an
// account on this host.
const UNASKED_IDENTITY = { login: null, source: "test: identity not exercised by this fixture" };

/** A stand-in for what `HERDR_WORKSPACE_ID` routing to the workers config would have declared. */
const DECLARED_WORKERS_IDENTITY = { login: "a11ign-ai-workers", source: "test: declared via HERDR_WORKSPACE_ID" };

test("#2003/#1984: a refusal on a DEAD pool names the DECLARED account beside the user ID, for ONE call", () => {
  const { calls, run } = recordingRun(refusedWith(DEAD_GRAPHQL));
  const report = cannotAskReport({ run, identity: DECLARED_WORKERS_IDENTITY });

  assert.match(report, /CANNOT ASK: neither the pull-request list nor the Ready rows could be read/,
    "the original refusal is unchanged -- this row adds facts to it, it does not replace it");
  assert.match(report, /pool graphql/, "WHICH pool -- core and graphql die separately and reset separately");
  assert.match(report, /resets at 2026-09-23T01:40:11\.000Z/,
    "an ABSOLUTE reset: a reader arriving an hour later cannot use minutes counted when the line was written");
  assert.match(report, /0 remaining of 5000/);
  assert.match(report, /THE POOL IS EXHAUSTED/, "the verdict is stated, not left to be inferred from a 0");

  // DONE-WHEN 2 IS THE BINDING LIMIT, AND THIS IS WHERE IT BITES. A rate-limited response names a user ID
  // and no login, and no second call may be made to improve on that.
  assert.equal(calls.length, 1,
    "AT MOST ONE extra request on the refusal path -- #2003 done-when 2, and the dead pool is the case "
    + "that tests it, because it is the one where a second call would buy something");
  // #1984: the response alone named only a user ID -- BEFORE this row the line read
  // `account UNREADABLE (user ID 328832207)`. The DECLARED identity (bought at zero calls, off disk) now
  // fills the login, and the user ID stays beside it rather than being dropped: when the two disagree that
  // IS #1974/#1967's confusion made visible, so nothing here may collapse to only one of them.
  assert.match(report, /account a11ign-ai-workers \(user ID 328832207\)/,
    "the declared login beside the user ID the refusing response actually carried -- neither replaces the other");
  assert.ok(!/account 328832207/.test(report),
    "a user ID must never be printed as though it were the account name -- that is the journal line this "
    + "row was filed to replace");
});

test("#1984: a dead pool with NO declared identity either still degrades to UNREADABLE, never a guess", () => {
  // THE POSITIVE CONTROL FOR THE MERGE ITSELF: without it, `diagnosis.login ?? identity.login` could look
  // like it always prints something, when a host that cannot declare an account (a fresh checkout, a
  // workspace with no config installed) must still read UNREADABLE rather than inventing a name.
  const { run } = recordingRun(refusedWith(DEAD_GRAPHQL));
  const report = cannotAskReport({ run, identity: UNASKED_IDENTITY });
  assert.match(report, /account UNREADABLE \(user ID 328832207\)/,
    "with no declared identity to fall back on, the prior degradation is exactly what must still print");
});

test("#2003: a LIVE pool costs ONE probe and says the pool is not the cause -- the positive control", () => {
  // THE CONTROL THAT MATTERS. Without it, a refusalPoolLine that printed EXHAUSTED unconditionally would
  // satisfy the test above perfectly, and every network blip would be reported to the org as a dead pool.
  const { calls, run } = recordingRun(() => LIVE_GRAPHQL);
  const report = cannotAskReport({ run, identity: UNASKED_IDENTITY });

  assert.match(report, /account a11ign-ai-workers/);
  assert.match(report, /1660 used, 3340 remaining of 5000/);
  assert.match(report, /THE POOL IS NOT THE CAUSE/,
    "budget left means the reads were refused by something else, and saying so is the point of the line");
  assert.ok(!report.includes("EXHAUSTED"), "a healthy pool must never be reported as exhausted");
  assert.ok(!report.includes("UNREADABLE"),
    "a live probe answers all three facts from its own body and headers -- nothing is degraded here");
  assert.equal(calls.length, 1, "one probe, the same one the dead-pool case pays -- #2003's done-when 2");
});

test("#1984: a LIVE pool's own login wins over a declared identity, not the other way round", () => {
  // THE OTHER HALF OF THE MERGE: a response that already names an account is a CONFIRMED fact, and a
  // declared identity must never override it -- if it did, a live probe naming a DIFFERENT account than
  // this workspace's declaration would silently hide the very drift #1974/#1967 were about.
  const { run } = recordingRun(() => LIVE_GRAPHQL);
  const report = cannotAskReport({ run, identity: { login: "a-declared-account-that-must-not-appear",
    source: "test: precedence check" } });
  assert.match(report, /account a11ign-ai-workers/, "the response's own login still wins");
  assert.ok(!report.includes("a-declared-account-that-must-not-appear"),
    "a declared identity is a fallback for when the response names none, never an override of one it did");
});

test("#2003: an unreadable probe reports UNREADABLE and never invents a pool", () => {
  // DONE-WHEN 3, AND THE OLDEST RULE IN THIS FILE ONE LEVEL DOWN: an instrument that cannot answer must not
  // answer zero. `0 remaining` reads as an exhausted pool, and a reader waits for a reset that is not coming.
  const noResponse = cannotAskReport({ run: () => "", identity: UNASKED_IDENTITY });
  assert.match(noResponse, /account UNREADABLE/);
  assert.match(noResponse, /pool UNREADABLE/);
  assert.match(noResponse, /CANNOT say whether the pool is exhausted or something else refused/);
  assert.ok(!/\bremaining\b/.test(noResponse.replace("pool UNREADABLE", "")),
    "no count may be printed for a pool that was never read");

  // Headers present but unparseable is the same answer, and it is a DIFFERENT failure: a response arrived.
  const garbled = cannotAskReport({
    run: () => "HTTP/2.0 200 OK\r\nX-Ratelimit-Resource: graphql\r\n\r\n{}", identity: UNASKED_IDENTITY,
  });
  assert.match(garbled, /pool UNREADABLE/,
    "a resource name with no counts is not a pool reading -- remaining and limit are what make it one");

  // THE USER ID IS READ OFF PROSE, SO ITS ABSENCE HAS TO DEGRADE RATHER THAN THROW. If GitHub ever
  // reworded the rate-limit message, this is what the line becomes -- a bare UNREADABLE, never a partial
  // match printed as an account.
  // THE REWORDING KEEPS A NUMBER IN IT ON PURPOSE. A fixture with no digits left would pass against a
  // reader that had been loosened to grab the first integer it saw, so the number here is a plausible one
  // that is NOT an account (`try again in 3600 seconds`) -- the mutant that drops the `user ID` anchor
  // survives without it, measured.
  const reworded = cannotAskReport({
    run: refusedWith(DEAD_GRAPHQL.replace("for user ID 328832207",
      "for this installation; try again in 3600 seconds")),
    identity: UNASKED_IDENTITY,
  });
  assert.match(reworded, /account UNREADABLE(?! \()/,
    "no user ID in the message means no user ID in the line, and the pool facts still stand");
  assert.ok(!reworded.includes("3600"),
    "the ID is read off the `user ID` anchor, not off whatever integer the message happens to contain");
  assert.match(reworded, /THE POOL IS EXHAUSTED/,
    "POSITIVE CONTROL: the account degrading must not take the reset and the verdict down with it");
});

test("#2003: the pool reading has ONE definition, and the gate pays for it only when refusing", () => {
  const gate = readFileSync(new URL("../work-gate.mjs", import.meta.url), "utf8");

  // THE COST IS ON THE REFUSAL PATH OR IT IS NOT FREE. `cannotAskReport` is the only caller of
  // `poolDiagnosis`, and its own only call site must sit inside the both-lanes-refused branch -- otherwise
  // a healthy tick pays a point every two minutes, which is the one thing this row must not buy.
  assert.equal(gate.match(/poolDiagnosis\(/g)?.length, 1,
    "poolDiagnosis is called once, inside cannotAskReport -- a second call site is a second price");
  const refusalBranch = /if \(prs === null && readyRows === null\) \{([\s\S]*?)\n {2}\}/.exec(gate)?.[1] ?? "";
  assert.match(refusalBranch, /cannotAskReport\(\{ run: defaultRun, identity: declaredGhAccount\(\) \}\)/,
    "the report is built inside the refusal branch; anywhere else and every healthy tick pays for it. "
    + "#1984: identity is read here too, at zero extra gh calls -- a local file read, not a network one");
  // The declaration spells the same call shape, so it is excluded by name rather than by counting matches.
  assert.equal(gate.match(/(?<!function )cannotAskReport\(\{/g)?.length, 1,
    "exactly one call site, and it is the one inside the refusal branch asserted above");

  // AND THE READ COUNT IS UNCHANGED, which is the other half of done-when 2: this row adds no
  // unconditional read, and `GH_READS` is the pin that would catch it if it ever did.
  assert.equal(GH_READS.unconditional.length, 11,
    "#2003 must not add an unconditional read -- the refusal path is where the extra call lives");

  // A SECOND COPY OF "HOW TO READ A POOL" IS REFUSED (#2003's Region says so). The header name is the
  // fingerprint: whoever writes it again has written the second copy this move exists to prevent.
  const src = fileURLToPath(new URL("../", import.meta.url));
  const definers = readdirSync(src)
    .filter((f: string) => f.endsWith(".mjs"))
    .filter((f: string) => readFileSync(join(src, f), "utf8").includes("X-Ratelimit-Remaining"));
  assert.deepEqual(definers, ["api-pool.mjs"],
    `only the leaf module may know how to read a pool; found ${definers.join(", ")}`);
});

// --- #2005: `answer:<session>` HOLDS THE ROW, and does not merely wake the session that owes it ---

/**
 * THE INCIDENT, AT ONE TICK'S OUTPUT, 2026-09-22T20:49:41Z.
 *
 *   20:47Z  `product-manager` puts `answer:ceo` on #2002 (`npm run host:install`) because the ruling it
 *           depends on -- which account the daily board dispatch spends -- was still open.
 *   next    the tick PROMOTES #2002 from `backlog` to `ready` while it carries `answer:ceo`,
 *   tick    then emits `WOKE worker-capture <- engineers/ready-row-unclaimed/2002`.
 *
 * `worker-capture` was one turn from claiming a row whose whole point was that it must not run yet --
 * and running it would have made an unruled decision real on the host.
 *
 * THE GATE ALREADY READ THE LABEL. `GH_READS` names `issue list (all open: answer/blocked labels)` and
 * `answerOrders` was independently waking `ceo` about the same row on the same tick. What no path asked
 * was whether the label STOPS anything -- so `waiting on ceo` and `offer this to anyone` were both true.
 */
const answerRow = (n: number, session: string, extra: string[] = []) =>
  ({ number: n, labels: [{ name: "ready" }, { name: `${ANSWER_PREFIX}${session}` },
    ...extra.map((e) => ({ name: e }))] });

test("#2005: a READY row carrying answer:<session> is SHELVED, and the shelf line names who owes it", () => {
  const { offerable, blocked } = partitionUnclaimed([answerRow(2002, "ceo")], []);
  assert.deepEqual(offerable, [], "one turn from claiming a row whose point was that it must not run yet");
  assert.equal(blocked.length, 1, "shelved, never silently dropped -- a row that vanishes is the defect");
  assert.match(blocked[0].reason, /waiting on ceo to answer .*clears itself/,
    "the line must NAME the session: unlike a date, this condition is cleared by a person, so a reason "
    + "that only says 'waiting' is the referent-less claim #1768 spent a row getting away from");
  assert.equal(blocked[0].number, 2002);
});

test("#2005 done-when 3: removing the label restores the row, with no other action", () => {
  // A SHELF THAT NEVER UNSHELVES IS THE FAILURE THIS REPLACES, and it is the property `blocked` lacks:
  // the label clears ITSELF because taking it off IS the act of answering. Both directions, same row,
  // one label of difference -- so a rule that shelved everything cannot pass this pair.
  const held = answerRow(2002, "ceo");
  const answered = { number: 2002, labels: [{ name: "ready" }] };
  assert.deepEqual(partitionUnclaimed([held], []).offerable, []);
  assert.deepEqual(partitionUnclaimed([answered], []).offerable.map((r: { number: number }) => r.number),
    [2002], "the ONLY change is the label, so nothing else can be what restored it");
  assert.deepEqual(partitionUnclaimed([answered], []).blocked, []);

  // END TO END: the order the incident actually emitted is the thing that must not be emitted.
  const withLabel = decide({ prs: [], readyRows: [held] });
  assert.deepEqual(withLabel.filter((o: { cause: string }) => o.cause === "ready-row-unclaimed"), []);
  const without = decide({ prs: [], readyRows: [answered] });
  assert.deepEqual(without.filter((o: { cause: string }) => o.cause === "ready-row-unclaimed")
    .map((o: { subject: string }) => o.subject), ["row-2002"],
    "and the positive control: with the question answered, the row is offered exactly as before");
});

test("#2005 done-when 4: the answer-owed wake is UNCHANGED -- this holds the row, it does not quieten "
  + "the question", () => {
  // THE ONE WAY THIS CHANGE COULD DO HARM. A row that stops moving AND stops asking is worse than one
  // that moves: the org would then be waiting on a question nobody is being asked. `answerOrders` reads
  // the prefix directly and must keep doing so, on the very row the gate now shelves.
  const held = answerRow(2002, "ceo");
  assert.deepEqual(withAnswerLabel([held]).map((r: { number: number }) => r.number), [2002]);
  assert.deepEqual([...answersOwed([held]).keys()], ["ceo"]);
  const orders = answerOrders([held]);
  assert.equal(orders.length, 1, "still exactly one order, at the session that owes the answer");
  assert.equal(orders[0].session, "ceo");
  assert.equal(orders[0].cause, "answer-owed");
  assert.equal(orders[0].causeKey, "ceo/answer-owed/row-2002");
});

test("#2005: the OFFER path and the PROMOTION path now answer from one reader, so they cannot disagree", () => {
  // THE SHAPE OF THE DEFECT, NOT JUST THE INSTANCE. #1899 taught `readPromotableRows` about the prefix
  // with a filter local to that function, so ONE of the two questions about a row knew and the other did
  // not. Asserting both refuse the SAME fixture is what would catch a future reader added to one path.
  const row = { number: 2002, labels: [{ name: "backlog" }, { name: `${ANSWER_PREFIX}ceo` }] };
  const promotable = readPromotableRows(() => JSON.stringify([row]));
  assert.deepEqual(promotable, [], "not promotable -- done-when 1");
  assert.deepEqual(partitionUnclaimed([{ ...row, labels: [{ name: "ready" }, { name: `${ANSWER_PREFIX}ceo` }] }],
    []).offerable, [], "and not offerable -- done-when 2, from the same predicate");

  // THE LOCAL FILTER IS GONE, and this is the assertion that keeps it gone: a second spelling of the
  // prefix inside `readPromotableRows` is how the two paths drifted, so the source must not hold one.
  const gate = readFileSync(fileURLToPath(new URL("../work-gate.mjs", import.meta.url)), "utf8");
  const body = /export function readPromotableRows\([\s\S]*?\n\}/.exec(gate)?.[0] ?? "";
  assert.ok(body.length > 0, "readPromotableRows must still be found, or this guard reads nothing");
  assert.ok(!/withAnswerLabel|ANSWER_PREFIX/.test(body),
    "it must ask `waitingOn` and nothing else; a prefix read of its own is the drift that caused #2005");
});

test("#2005's open-check: a row HELD BY the session that owes the answer leaves before the question is "
  + "asked, so nothing had to express 'not offered to anyone but the holder'", () => {
  // The filer asked whether `answer:<session>` should hold a row against its OWN HOLDER -- #1948 was
  // `in-progress` + `session:worker-tooling` + `answer:worker-tooling` on the day this was filed, and a
  // session is not blocked by its own unanswered question the way a stranger is. It never arises: a
  // claimed row leaves on the CLAIM_LABEL line, before anything asks what it is waiting on.
  const heldByOwner = { number: 1948, labels: [{ name: "ready" }, { name: "in-progress" },
    { name: "session:worker-tooling" }, { name: `${ANSWER_PREFIX}worker-tooling` }] };
  const { offerable, blocked } = partitionUnclaimed([heldByOwner], []);
  assert.deepEqual(offerable, [], "a claimed row is offered to nobody, which is stronger than the rule "
    + "the open-check proposed");
  assert.deepEqual(blocked, [], "and it is not SHELVED either -- it is being worked, not waiting");
});

test("#2005: waitingBreakdown groups answers by session, and no group is reported with an absent referent", () => {
  // THE MUTATION THIS CATCHES. The two-kind version read `kind === "date"` and treated everything else
  // as a row-blocker, so a third kind would have been pushed as `{ number, on: undefined }` and rendered
  // as "blocked by " with nothing after it -- a wrong fact in the one report built to stop `ceo`
  // hand-reading twenty rows. An `else` over a closed set of two becomes a false statement in silence.
  const rows = [answerRow(2002, "ceo"), answerRow(1889, "ceo"), answerRow(1878, "orchestrator"),
    { number: 7, blockedBy: { nodes: [{ number: 1772, state: "OPEN" }] } },
    { number: 8, body: "Not-before: 2099-01-01" }, { number: 9 }];
  const breakdown = waitingBreakdown(rows, "2026-09-23");
  assert.deepEqual(breakdown.answers,
    [{ session: "ceo", numbers: [2002, 1889] }, { session: "orchestrator", numbers: [1878] }],
    "grouped by session and sorted by it, for the reason dates are grouped by date: '3 rows are waiting "
    + "on ceo' is the fact a reader acts on");
  assert.deepEqual(breakdown.blocked, [{ number: 7, on: [1772] }],
    "an answer-waiting row must NOT land in the row-blocker group with an absent `on`");
  assert.equal(breakdown.total, 5, "three answers, one blocker, one date -- and #9 is not waiting");
  assert.equal(openRowState(rows, "2026-09-23")?.reachable, 1,
    "only #9 could move; counting three parked rows as reachable is the switch crying wolf in reverse");
});

test("#2005: the org-stalled prompt NAMES the session, because that group is the one a reader clears", () => {
  // #1935's own finding one level over: the condition was computed and discarded at the same expression,
  // and `ceo` then spent an hour hand-reading rows the gate had already read that tick. A date cannot be
  // hurried and a blocking row is someone else's work; a question owed is a session that can be asked now.
  const waiting = waitingBreakdown([answerRow(2002, "ceo"), answerRow(1889, "ceo")], "2026-09-23");
  const order = stalledOrder({ orders: [], openRows: 1, waiting });
  assert.ok(order !== null, "one reachable row and no orders is still a stall");
  assert.match(order.prompt, /2 on a session's answer: 2 waiting on ceo to answer \(#2002 #1889\)/);
  assert.match(order.prompt, /REMOVING THE LABEL IS THE ACT OF ANSWERING/);
});

/**
 * #2031: A READY ROW WHOSE WORK IS ALREADY PUSHED WAS STILL OFFERED AS A FRESH START.
 *
 * #2014 bought the interception at CLAIM time, and it says nothing to anyone who never attempts a claim
 * -- the work gate, which is what actually offers rows to the org, was one of those readers. Measured
 * 2026-09-22 on #2000: `agent/worktree-prune-unit-2000` was pushed at 21:02:36Z; the row read `ready`,
 * no `session:`, no `in-progress`, until 21:22Z; `gh pr list --head <branch> --state all` returned `[]`
 * for that whole window. The gate offered #2000 as `ready-row-unclaimed` throughout, because `ready`
 * with no `session:` label was the ENTIRE question it asked, and a second session was routed into the
 * same three Region paths at 21:06Z.
 *
 * THE CAUSE OF THE STALENESS IS WHY THE DETECTION MUST NOT SPEND THE POOL. Opening the pull request is
 * the act that makes a row look claimed, and that act spends GraphQL: #1996's PR was never opened
 * because the shared 5,000-point pool was exhausted until 21:20:11Z. So the board goes stale precisely
 * when the pool is gone, and a detector that spent the pool would be blind in the same outage that
 * produces the defect. `git ls-remote --heads origin` spends none, and the test below pins the BINARY
 * the seam spawns rather than trusting the comment.
 */
const BRANCH_2000 = "agent/worktree-prune-unit-2000";
const SHA_2000 = "1f4e9c7a3b5d8e2016243c5f7a9b0d1e2f3a4b5c";
const LISTING = `${SHA_2000}\trefs/heads/${BRANCH_2000}\n`
  + `9999999999999999999999999999999999999999\trefs/heads/main\n`;
/** A Ready row as `readReadyRows` returns it: `ready`, no `session:`, no `in-progress`. */
const readyRow = (n: number, extra: Record<string, unknown> = {}) =>
  ({ number: n, title: `row ${n}`, labels: [{ name: "ready" }], ...extra });
/** A body stating all three template sections (#2791): a row with a `body` and any of them missing is not stock. */
const COMPLETE_BODY = "## Region\n\nx.mjs\n\n## Acceptance\n\nnpm test\n\n## Open-check\n\nfalse today\n";

test("#2031: a Ready row whose branch is on origin gets its own cause, and is no longer offered fresh", () => {
  // THE POSITIVE FIRST, and it is the whole row: without it every silence assertion below is satisfied
  // by a `rowBranchOrders` that returns `[]` for everything and a partition that shelves nothing.
  const rows = [readyRow(2000), readyRow(2001)];
  const branches = [{ branch: BRANCH_2000, head: SHA_2000, row: 2000 }];
  const orders = decide({ prs: [], readyRows: rows, rowBranches: branches });
  const mine = orders.filter((o) => o.cause === "row-branch-unshipped");
  assert.equal(mine.length, 1, "one order, for the one row origin holds a branch for");
  assert.equal(mine[0].subject, "row-2000");
  // NAMED IN BOTH COMMANDS, not merely somewhere in the prompt. A mutant that left one of the two as a
  // `<branch>` placeholder survived an `includes(BRANCH_2000)` on the whole string, because the other
  // command and the shelving sentence still carried it -- and a command a reader cannot paste is the
  // one thing this prompt exists to hand over.
  assert.ok(mine[0].prompt.includes(`git log --oneline origin/main..origin/${BRANCH_2000}`),
    "the cause NAMES the branch in the history command -- done-when 1");
  assert.ok(mine[0].prompt.includes(`git diff origin/main...origin/${BRANCH_2000}`),
    "and in the diff command: both are pasteable, and both spend no API pool");
  assert.ok(mine[0].prompt.includes(SHA_2000.slice(0, 12)),
    "and its head sha, so the reader can tell which push this is about");
  // DONE-WHEN 2: the row is no longer offered as a fresh start while the condition holds. #2001, whose
  // number matches no head, still is -- without that half this passes against a gate that stopped
  // offering every row.
  assert.deepEqual(orders.filter((o) => o.cause === "ready-row-unclaimed").map((o) => o.subject),
    ["row-2001"], "#2000 is withheld and #2001 is not");
  assert.ok(CAUSES.includes("row-branch-unshipped"),
    "it must be in CAUSES or worker-profile refuses it at run time");
});

test("#3010: a branch an OPEN PR is on gets the order that names the PR and --adopt, not 'open its pull request'", () => {
  const rows = [readyRow(2000)];
  const branches = [{ branch: BRANCH_2000, head: SHA_2000, row: 2000 }];
  const pr = { number: 2987, headRefName: BRANCH_2000, labels: [{ name: "session:worker-2000" }] };
  const orders = decide({ prs: [pr], readyRows: rows, rowBranches: branches });
  const mine = orders.filter((o) => o.cause === "row-branch-unshipped");
  assert.equal(mine.length, 1, "still ONE order: the row is not silently dropped");
  assert.ok(!/open its pull request/.test(mine[0].prompt), "the plain #2031 advice is wrong when a PR is open");
  assert.ok(!/delete the branch on `origin`/.test(mine[0].prompt), "and so is the exit that would close the PR");
  assert.ok(mine[0].prompt.includes("OPEN pull request #2987"), "it names the PR");
  assert.ok(mine[0].prompt.includes(`--branch=${BRANCH_2000}`) && mine[0].prompt.includes("--adopt=worker-2000"),
    "it names --adopt, the one route that resumes the tree, with the holder off the PR's session label");
  assert.notEqual(mine[0].causeKey, rowBranchOrders(rows, branches)[0].causeKey,
    "the PR is in the key, so an order already spent for the bare branch does not suppress this one");
});

test("#3010: POSITIVE CONTROL -- a branch with NO open PR (or one on another branch) still gets #2031's order unchanged", () => {
  const rows = [readyRow(2000)];
  const branches = [{ branch: BRANCH_2000, head: SHA_2000, row: 2000 }];
  const elsewhere = { number: 7, headRefName: "agent/other-1", labels: [] };
  for (const prs of [[], [elsewhere]]) {
    const [order] = rowBranchOrders(rows, branches, prs);
    assert.ok(/open its pull request/.test(order.prompt), "the three exits are still named");
    assert.ok(!order.prompt.includes("--adopt"), "and --adopt is not");
    assert.equal(order.causeKey, rowBranchOrders(rows, branches)[0].causeKey, "the key is #2031's");
  }
});

test("#2031: the withheld row is SHELVED with its reason, never silently dropped", () => {
  const { offerable, blocked } = partitionUnclaimed([readyRow(2000), readyRow(2001)], [],
    { rowBranches: [{ branch: BRANCH_2000, head: SHA_2000, row: 2000 }] });
  assert.deepEqual(offerable.map((r: { number: number }) => r.number), [2001]);
  assert.equal(blocked.length, 1, "a row that vanishes silently is the failure `blocked` already is");
  assert.ok(blocked[0].reason.includes(BRANCH_2000), "the `SHELVED row #N:` line names the branch");
  // IT MUST NOT ASSERT THE WORK IS DONE -- #2031's own "what this will NOT fix": a branch on origin for
  // a Ready row means only that a branch EXISTS, and telling finished work from abandoned work stays a
  // reading of the branch. A shelving that said "this row is done" would be a wrong fact in the tick log.
  assert.ok(/NOT a claim that the work is finished/.test(blocked[0].reason),
    "it states existence and concludes nothing");
});

test("#2031: the detection makes NO `gh` call -- the pool is gone in the outage it exists for", () => {
  // DONE-WHEN 3, PINNED ON THE BINARY RATHER THAN THE COMMENT. The seam takes the command as well as
  // the arguments precisely so this can be asserted: a future edit that answered the same question with
  // `gh api repos/.../branches` would pass an args-only spy and fail here.
  const calls: [string, string[]][] = [];
  const found = readRowBranches((cmd: string, args: string[]) => {
    calls.push([cmd, args]);
    return LISTING;
  });
  assert.deepEqual(calls, [["git", ["-C", HOME_CHECKOUT, "ls-remote", "--heads", "origin"]]],
    "one local git call, and `gh` is never spawned -- a detector that spent GraphQL would be blind in "
    + "the exhausted-pool outage that produces the staleness it detects");
  assert.deepEqual(found, [{ branch: BRANCH_2000, head: SHA_2000, row: 2000 }],
    "`main` is not a row branch: the trailing `-<digits>` is the whole match");
  assert.equal(GH_READS.unconditional.length, 11, "#2031 adds NO gh read -- it is a local git call");
  assert.ok(GIT_READS.unconditional.some((r: string) => r.includes("ls-remote")),
    "and the free read is COUNTED rather than left out because it is free -- `GH_READS`'s own header "
    + "records what happened last time a read went unwritten-down");
});

test("#3091: the row-branch scan asks the PROJECT's origin, so a branch only the tool repository holds shelves nothing", () => {
  // THE TICK'S `WorkingDirectory` IS THE TOOL'S CHECKOUT, so a bare `git ls-remote --heads origin` read
  // `a11ign/agent-org` and an agent-org branch ending `-3064` shelved project row #3064 for 88 ticks. The
  // seam cannot show which repository a real git would answer from, so the pin is on the ARGUMENTS: `-C` first.
  const seen: string[][] = [];
  const projectOrigin = (_cmd: string, args: string[]) => {
    seen.push(args);
    return args[0] === "-C" && args[1] === HOME_CHECKOUT ? LISTING : `${SHA_2000.replace(/./g, "f")}\trefs/heads/agent/tool-only-3064\n`;
  };
  assert.deepEqual(readRowBranches(projectOrigin),
    [{ branch: BRANCH_2000, head: SHA_2000, row: 2000 }],
    "positive control: a branch on the PROJECT's origin is still listed");
  assert.deepEqual(seen[0].slice(0, 2), ["-C", HOME_CHECKOUT], "git is pointed at the project checkout before it asks");
  const toolOnly = readRowBranches((_cmd: string, args: string[]) => (args[0] === "-C" ? "" : `${SHA_2000}\trefs/heads/agent/tool-only-3064\n`));
  assert.deepEqual(toolOnly, [], "a branch only the tool repository holds is not the project's, so nothing is shelved");
});

test("#3091: the worktree-stamp read has the same defect and the same remedy -- the tool's `worktree list` names the tool's trees", () => {
  const asked: string[][] = [];
  readWorktreeStamps((_cmd: string, args: string[]) => { asked.push(args); return ""; });
  assert.deepEqual(asked, [["-C", HOME_CHECKOUT, "worktree", "list", "--porcelain"]]);
});

test("#2031: a refused listing is `null`, and the gate then behaves exactly as it did before", () => {
  // #1286's rule. `[]` would mean "no row has a branch on origin", which is a positive claim, and a tick
  // that could not reach the remote has not earned it. The degradation must also not go the other way:
  // nothing is shelved, so a session is never starved of a row because `origin` was unreachable.
  assert.equal(readRowBranches(() => { throw new Error("fatal: could not read from remote repository"); }),
    null, "a refused read is `null`, never an empty listing");
  const rows = [readyRow(2000)];
  for (const rowBranches of [null, undefined]) {
    assert.deepEqual(decide({ prs: [], readyRows: rows, rowBranches }).map((o) => o.cause),
      ["ready-row-unclaimed"],
      "not asked and refused are the same thing here: no cause invented, and no row withheld");
  }
  assert.deepEqual(rowBranchOrders(rows, null), [], "and the emitter says nothing on its own");
});

test("#2031: a CLAIMED row is not this cause's business -- `claimed-row-amended` speaks to a holder", () => {
  // The done-when's population is "every open `ready` row carrying no `session:` label". A held row
  // already has a session that knows about its own branch, and waking anyone about it would fire on
  // every row every session is currently building.
  const branches = [{ branch: BRANCH_2000, head: SHA_2000, row: 2000 }];
  const claimed = readyRow(2000, { labels: [{ name: "ready" }, { name: "in-progress" },
    { name: "session:worker-capture" }] });
  assert.deepEqual(rowBranchOrders([claimed], branches), [],
    "a row somebody holds is not offered as a fresh start either, so there is nothing to withhold");
  const sessionOnly = readyRow(2000, { labels: [{ name: "ready" }, { name: "session:worker-capture" }] });
  assert.deepEqual(rowBranchOrders([sessionOnly], branches), [],
    "`session:` is the label the done-when names, and it holds on its own");
});

test("#2031: the order is keyed on the SHA, so a push is a new question and a re-read is not", () => {
  const rows = [readyRow(2000)];
  const at = (head: string) => rowBranchOrders(rows, [{ branch: BRANCH_2000, head, row: 2000 }])[0];
  const first = at(SHA_2000);
  assert.equal(first.causeKey, at(SHA_2000).causeKey,
    "an unchanged branch mints the identical key on every tick and the wake ledger drops it -- this is "
    + "a JUDGMENT cause, and 'abandoned, leave it' is an answer that does not change the state");
  assert.notEqual(first.causeKey, at("0".repeat(40)).causeKey,
    "a PUSH to that branch is a different fact and must reach the owner");
  assert.ok(first.causeKey.includes(SHA_2000), "the sha is IN the key, not merely in the prompt");
});

test("#2031: it routes to the lane owner, else `product-manager` -- never to the engineer pool", () => {
  // `product-manager` is this org's first reader for rows, the queue and holds (the chairman's
  // 2026-09-14 routing direction). It is deliberately NOT `engineers`: the pool's answer to a row is to
  // CLAIM it, and #2014 already refuses exactly that claim -- so routing there would wake a session to
  // be refused by a guard the gate can see from here.
  const branches = [{ branch: BRANCH_2000, head: SHA_2000, row: 2000 }];
  assert.equal(rowBranchOrders([readyRow(2000)], branches)[0].session, "product-manager");
  const laned = readyRow(2000, { labels: [{ name: "ready" }, { name: "lane:ceo" }] });
  assert.equal(rowBranchOrders([laned], branches)[0].session, "ceo",
    "a laned row's owner is the one who can act on it");
});

test("#2031: a branch whose trailing number is a COINCIDENCE is named as one, not asserted as work", () => {
  // The match is on the NAME, which is all `ls-remote` can see. `rowBranchesInListing` cannot tell
  // `agent/some-refactor-2000` from a branch called `release-v1-2000`, and the prompt says so rather
  // than leaving the reader to discover it -- the third exit exists for exactly that case.
  const order = rowBranchOrders([readyRow(2000)],
    [{ branch: "release-v1-2000", head: SHA_2000, row: 2000 }])[0];
  // ASSERTED ON WHAT THE PROMPT SAYS, not on a regex for words it must avoid: the prompt's own
  // disclaimer contains the string "the work is finished" inside "NOT a claim that the work is
  // finished", so a negative word-match would have been satisfied by DELETING the disclaimer.
  assert.ok(order.prompt.includes("NOT a claim that the work is finished"),
    "it must never assert the row is done -- #2031's own 'what this will NOT fix'");
  for (const exit of ["FINISHED", "ABANDONED", "COINCIDENCE"]) {
    assert.ok(order.prompt.includes(exit),
      `all three exits are offered and none is chosen -- the gate cannot tell them apart (${exit})`);
  }
});

/**
 * #2174: THE HOST GOES STALE ON A MERGE AND NOTHING IN THIS ORG FINDS OUT.
 *
 * The shipped units are COPIES, so a merge touching `packages/agent-org/host/` changes the tree and
 * leaves the host as it was. Measured three times in 24 hours; the third had a consequence -- #2144
 * (#1998) merged at 14:04:06Z changing the board unit's `ExecStart`, and eight hours later the service
 * manager still loaded the pre-#1998 program, due to dispatch the 06:10Z board edition from the 31 lines
 * of untracked bash whose whole removal was that PR's deliverable (#2173).
 *
 * THE POSITIVE CONTROL FOR EVERY EMPTINESS ASSERTION BELOW is the first test here -- the same reader over
 * a populated drift list, asserted to produce an order that NAMES the unit. Delete it and the silence
 * tests all pass against a `hostDriftOrders` that returns `[]` for every input, which is the shape this
 * repository keeps re-finding.
 */
const DRIFT_STALE = { unit: "a11ign-board-report.service", problem: "STALE",
  detail: "the installed copy differs from the one in the repository." };
const DRIFT_MISSING = { unit: "a11ign-work-tick.service", problem: "PROGRAM MISSING",
  missingProgram: "/home/agent/repos/a11y-witness/packages/agent-org/src/work-tick.mjs",
  detail: "the program it starts is not there." };

test("#2174 POSITIVE CONTROL: a host with drift produces an order that NAMES the unit and its problem", () => {
  const orders = hostDriftOrders([DRIFT_STALE]);
  assert.equal(orders.length, 1, "one order for the whole drift set, not one per finding");
  const [order] = orders;
  assert.equal(order.cause, "host-units-stale");
  assert.ok(order.session, "it is addressed to a session -- an order nobody is named on wakes nobody");
  // NAMES the unit and the problem, not merely that something is wrong: the whole defect this row is
  // about is that `host:check` is a command somebody has to think to RUN, so the wake has to carry the
  // finding rather than send the reader to go and look.
  assert.match(order.prompt, /a11ign-board-report\.service/, "the prompt names the drifting unit");
  assert.match(order.prompt, /STALE/, "and its problem");
  assert.match(order.prompt, /the installed copy differs/, "and the detail, so nothing has to be re-read");
});

test("#2174: a CLEAN host produces no order", () => {
  assert.deepEqual(hostDriftOrders([]), [],
    "an empty finding list is a host that is correct, and waking somebody to say so is the burn "
    + "`work-gate.mjs` exists to remove");
});

/**
 * ASSERTED SEPARATELY FROM THE CLEAN HOST ABOVE, and that separation is the point rather than a style
 * choice. `hostUnitDrift` returns `[]` for a clean host AND for a machine with no user systemd manager;
 * `readHostDrift` returns `null` for a read that threw. All three are silence here -- none of them is a
 * stale host -- but reading "not asked" as "all correct" is this repository's most-repeated defect, and
 * one test covering both would be exactly that substitution written down.
 */
test("#2174: an UNASKABLE machine produces no order either -- a different claim, asserted apart", () => {
  assert.deepEqual(hostDriftOrders(null), [],
    "`null` is a read that was refused or threw: it must never wake anyone, and must never be read as "
    + "a clean host either");
  assert.deepEqual(hostDriftOrders(undefined), [], "omitted is the same claim as null");
  // CI, a reviewer's laptop and a container all land here through `systemdUserAvailable`, which returns
  // `[]` rather than throwing -- a check that fires on every laptop is one somebody silences within a
  // day, taking the real finding with it.
  assert.deepEqual(hostDriftOrders([]), [], "and so does a machine that is simply not an agent host");
});

test("#2174: the causeKey is keyed on the DRIFT SET -- stable while it persists, new when it changes", () => {
  const once = hostDriftOrders([DRIFT_STALE])[0].causeKey;
  assert.equal(hostDriftOrders([DRIFT_STALE])[0].causeKey, once,
    "a host stale in the same way on the next tick mints the identical key and the ledger drops it");
  // A SECOND UNIT JOINING IS A NEW QUESTION. `fleetBatchOrders`'s rule, for its reason: a COUNT would
  // collide two different drift sets of the same size, which is #1799's finding.
  assert.notEqual(hostDriftOrders([DRIFT_STALE, DRIFT_MISSING])[0].causeKey, once,
    "a second drifting unit is a second question and must reach the owner");
  assert.equal(hostDriftOrders([DRIFT_MISSING, DRIFT_STALE])[0].causeKey,
    hostDriftOrders([DRIFT_STALE, DRIFT_MISSING])[0].causeKey,
    "sorted: the reader's order is not a new question");
  // AND THE PROBLEM IS IN THE KEY, NOT JUST THE UNIT -- a unit whose fault CHANGES is a new question too.
  assert.notEqual(hostDriftOrders([{ ...DRIFT_STALE, problem: "NOT INSTALLED" }])[0].causeKey, once,
    "the same unit with a different problem is a different state and must not be deduped away");
});

test("#2174: it is an ACTION cause -- in CAUSES, NOT in JUDGMENT_CAUSES, and routed by worker-profile", () => {
  assert.ok(CAUSES.includes("host-units-stale"),
    "it must be in CAUSES or worker-profile refuses it at run time");
  // AN ACTION CAUSE KEEPS `wake.mjs`'s TWENTY-MINUTE EXPIRY. It names a thing to DO -- read these
  // findings, then run the remedy -- and a wake that does not stick leaves the host stale with nobody
  // told. That expiry exists because #1433 and #1435 sat Ready overnight behind a spent causeKey.
  assert.ok(!JUDGMENT_CAUSES.includes("host-units-stale"),
    "a judgment cause is never re-offered; a stale host must be");
  assert.ok(!START_CAUSES.includes("host-units-stale"),
    "FINISH: the tick that emits this is itself one of the units that can go stale, and a drain window "
    + "ends in a force-push to the very checkout a unit's WorkingDirectory names");
});

test("#2174: decide() routes it, and only when it is handed drift", () => {
  const withDrift = decide({ prs: [], readyRows: [], hostDrift: [DRIFT_STALE] });
  const order = withDrift.find((o) => o.cause === "host-units-stale");
  assert.ok(order, "the gate could see the host had drifted and, before this, had nobody to tell");
  assert.match(order.prompt, /a11ign-board-report\.service/);
  // NOT ASKED IS NOT A FALSE ALARM. `decide` carries no default for `hostDrift` deliberately -- a default
  // parameter is a branch `complexity` counts and `decide` sits exactly on its limit of 15 -- so the
  // omitted case has to behave, and this is what says it does.
  assert.deepEqual(decide({ prs: [], readyRows: [] }).filter((o) => o.cause === "host-units-stale"), [],
    "a caller that cannot read the host must produce no order at all");
});

/**
 * #2174 CONSTRAINT 1, AND THE MEASUREMENT THAT DECIDED THE DESIGN AGAINST THE OBVIOUS ANSWER.
 *
 * The row offered three routes -- import `hostUnitDrift`, split it into a leaf module, or spawn
 * `host:check`. A direct import LOOKS free and measures free on the axis constraint 1 names: every one
 * of `host-units.mjs`'s imports is already in this gate's closure, so it adds one file to 21, and the
 * gate loads in 39.3ms against 39.4ms without it.
 *
 * IT IS NOT FREE ON THE AXIS THE ROW DID NOT NAME. `host-units.mjs` calls `git log --all`, so importing
 * it puts a `history` capability requirement into `work-gate.mjs` -- which `row-claim/runner-rule.mjs`
 * reaches, and most of the packaging suite imports THAT. Measured both ways: **4 test files derive a
 * `history` requirement, and 28 do with the import.** So the gate spawns instead, and these two
 * assertions are the standing version of that measurement -- if somebody "simplifies" the spawn into an
 * import, the second one fails and says what it costs.
 */
test("#2174: the gate does NOT import host-units.mjs -- the spawn is the fence, not a preference", () => {
  const SRC = fileURLToPath(new URL("../", import.meta.url));
  assert.ok(!importClosure(join(SRC, "work-gate.mjs")).has(join(SRC, "host-units.mjs")),
    "importing it drags `git log --all` into the gate's capability closure and taxes 24 unrelated test "
    + "files with `History: full`; the gate runs `host-units.mjs --json` as a child process instead");
  // THE CONTROL: the walker really can see this edge when it exists, so the assertion above is a fact
  // about the gate rather than about a walker that finds nothing.
  assert.ok(importClosure(join(SRC, "host-units.mjs")).has(join(SRC, "acceptance-commands.mjs")),
    "the same walker DOES find host-units.mjs's own edges");
});

/**
 * The test files charged with a `history` requirement, as a RATCHET against the base the change merges into (#3232, `lib/pin-ratchet.mjs`). The
 * reason the population is policed stays (a file JOINING it is taxed with `History: full`, #497); what changed is HOW: a file this change ADDS to
 * it is declared below with its reason, so two changes that each add one are each judged against their own base, and a file that leaves passes.
 */
const DECLARED_HISTORY_POPULATION: Declaration[] = [
  { name: "home-checkout-refusal.test.ts", reason: "#3039: imports `host-units.mjs` for `hostUnitDrift` and `hostUnitsInstall`, the same edge `host-units.test.ts` has" },
  { name: "host-project-paths.test.ts", reason: "#2620: imports `host-units.mjs` for the rendered unit texts, the same edge `host-units.test.ts` has; its pull request declares `History: full` (#497)" },
  { name: "host-tool-install.test.ts", reason: "#2793: imports `host-units.mjs` for the rendered `work-tick` unit, the same edge; its pull request declares `History: full`" },
  { name: "host-units.test.ts", reason: "tests `host-units.mjs`, which calls `git log --all`: the edge every other entry here shares" },
  { name: "reviewer-door-install.test.ts", reason: "#3316: imports `host-units.mjs` for `hostUnitDrift` and the door install, the same edge `host-units.test.ts` has; its pull request declares `History: full`" },
  { name: "shadow-window-arm.test.ts", reason: "#2867: imports `host-units.mjs` for the rendered shadow-window unit texts and the installer, the same edge; declares `History: full`" },
  { name: "work-gate.test.ts", reason: "this very file: it spawns the gate and reads commit history" },
  { name: "work-tick-crash-exit.test.ts", reason: "#3038: imports `host-units.mjs` for the rendered `work-tick` unit's ExecStart, the same edge `host-tool-install.test.ts` has" },
];

/** The `*.test.ts` files of `packagingDir` whose import closure derives a `history` requirement. */
function historyChargedTests(packagingDir: string): string[] {
  return readdirSync(packagingDir).filter((f) => f.endsWith(".test.ts"))
    .filter((f) => {
      try {
        return deriveClosureRequirements(join(packagingDir, f))
          .some((r: { requirement: string }) => r.requirement === "history");
      } catch { return false; }
    }).sort();
}

test("#2174: no test file joins the history-requirement population without a declaration", () => {
  const current = historyChargedTests(fileURLToPath(new URL("./", import.meta.url)));
  // Positive control: the scan keeps the tests that really are charged, so an emptied population cannot pass for "none joined".
  assert.ok(current.includes("work-gate.test.ts"), "this very file is in the population, and the scan dropped it");
  const { undeclared, judged } = judgePin({
    repo: TOOL_ROOT, paths: ["src"], scan: (root) => historyChargedTests(join(root, "src/packaging")), current, declared: DECLARED_HISTORY_POPULATION,
  });
  assert.deepEqual(undeclared, [],
    `(judged ${judged}) adding a \`history\` reader to the gate's import closure taxes every test file that reaches it -- if a file joined `
    + "this population, check what was imported, and declare the file in DECLARED_HISTORY_POPULATION only if it genuinely needs history");
});

/**
 * #2174 CONSTRAINT 1, THE HALF THAT IS NOT NEGOTIABLE: the gate must still load in a tree with no
 * `node_modules`, and the row asked for that DEMONSTRATED rather than claimed.
 *
 * `a11ign-work-tick.service` runs `work-tick.mjs` before any `npm ci` or build, so a bare specifier
 * anywhere in this closure is an `ERR_MODULE_NOT_FOUND` that takes the whole tick down -- and #535
 * records what that costs when the throw is swallowed. Importing from THIS checkout proves nothing:
 * node resolves a bare specifier by walking up from the importing file, and every worktree here has a
 * `node_modules` to find. So the closure is copied into a throwaway tree with none in its ancestor
 * chain, mirroring `pre-commit-hook.test.ts`'s own technique for the identical bind.
 */
test("#2174: work-gate.mjs loads in a tree with NO node_modules, host-units edge included", () => {
  const entry = toolFile("src/work-gate.mjs");
  const closure = importClosure(entry);
  // THE CONTROL IS THE GATE ITSELF, not the host-units edge -- there is deliberately no such edge (see
  // the capability test above). What must hold is that the closure copied here is really the gate's:
  // an empty or truncated one would make the import below pass by having nothing to resolve.
  assert.ok(closure.size > 10 && closure.has(toolFile("src/waiting-condition.mjs")),
    `the control: the closure must really be the gate's, got ${closure.size} file(s)`);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a11y-work-gate-no-modules-")));
  // THE COPY LIST BEYOND THE STATIC CLOSURE IS GENERATED, never hand-listed (#3232): the project's `.agent-org/` and the tool's `host/` go in WHOLE,
  // so a new import edge that reads one more file of either (`roles.dir`'s briefs, a unit template) cannot fail this test for want of a list entry.
  // `copied-tool-fixture.ts` then writes the host file the copy is told to use over the one copied here.
  cpSync(join(HOME_CHECKOUT, ".agent-org"), join(root, ".agent-org"), { recursive: true });
  cpSync(toolFile("host"), join(root, "packages/agent-org/host"), { recursive: true });
  const copy = copyToolAndProject(entry, closure, root);
  assert.ok(existsSync(join(root, "packages/agent-org/host/work-tick.service.in")) && existsSync(join(root, ".agent-org/project.json")),
    "the control: both directories really came across whole");
  assert.ok(!existsSync(join(root, "node_modules")), "the tree really has none -- the premise");
  const run = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import(${JSON.stringify(pathToFileURL(copy.entry).href)})`
    + ".then(m => { if (!m.CAUSES.includes('host-units-stale')) throw new Error('cause missing'); })"],
  { encoding: "utf8", cwd: root, env: { ...process.env, ...copy.env } });
  assert.equal(run.status, 0,
    `the gate must load with no node_modules anywhere above it: ${run.stderr}`);
});

/**
 * #2174, FOUND BY MUTATION: `Array.isArray(drift) ? drift : []` survived being weakened to `drift ?? []`,
 * because `null` and `undefined` behave identically under both. The difference only shows on a value
 * that is neither an array nor nullish -- and that is exactly what a future `host:check --json` printing
 * an object where a list used to be would hand this function. Under the weaker form it reaches `.map`
 * and throws, which takes the whole tick down: a detector that can silence the gate is worse than the
 * defect it detects.
 */
test("#2174: a drift value that is not a list is 'not asked', never a crash", () => {
  for (const notAList of [{} as never, "two findings" as never, 0 as never, true as never]) {
    assert.deepEqual(hostDriftOrders(notAList), [],
      "anything this function cannot read as a finding list is a read it did not get, and it must "
      + "neither wake anyone nor throw");
  }
});


// --- #2084: GitHub's own review decision, which nothing in this repository read ------------------------

/**
 * #2084: A PULL REQUEST THAT LOOKS EXACTLY LIKE FINISHED WORK, with one field added.
 *
 * `isDraft: false` and green, so it is past `pr-checks-failing`, which needs a red check. It CARRIES A
 * CONVINCED VERDICT AT ITS HEAD (#2176), because since that row a ready pull request with none is a
 * `draft-awaiting-verdict` subject, and these tests are about `reviewDecision`, not about review routing.
 * The `reviewDecision` is the ONLY thing that distinguishes a mergeable pull request from one GitHub is
 * holding, and until #2084 no line of this repository read it.
 */
function ready(n: number, reviewDecision: string | null | undefined, labels: string[] = []) {
  const pr: Record<string, unknown> = { number: n, isDraft: false, headRefOid: HEAD,
    statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }],
    author: { login: "a11ign-ai-workers" },
    comments: [{ body: `Review of #${n} at \`${HEAD.slice(0, 8)}\`, by \`reviewer\`: convinced.` }],
    labels: labels.map((name) => ({ name })) };
  // `undefined` MEANS THE KEY IS ABSENT, and it has to be absent rather than present-and-undefined:
  // `Object.hasOwn` is what `reviewStateOf` keys on, and a fixture that sets the key to `undefined` would
  // quietly pick a side of the very question under test. `branch-protection.test.ts` makes the same point
  // about `bypass_actors` and parses JSON text to avoid it; here, not writing the key is enough.
  if (reviewDecision !== undefined) pr.reviewDecision = reviewDecision;
  return pr;
}

test("#2084 THE LIVE SHAPE: a green, unheld, ready PR awaiting review reaches product-manager", () => {
  // MEASURED, NOT INVENTED. #2198 at `468a74f1b`: opened ready at 17:39:37Z with ZERO reviews,
  // `mergeStateStatus: BLOCKED`, `reviewDecision: REVIEW_REQUIRED`, armed -- and `decide` run against the
  // live payload returned NO ORDER OF ANY KIND for it, while `shouldBeMerging` listed it as a candidate.
  // That reading is this test's subject, and it is why the row's "done-when 1 removes most of the need for
  // it" is wrong: #2198 has no review to dismiss.
  const orders = decide({ prs: [ready(2198, "REVIEW_REQUIRED")], readyRows: [], required: ["gate"] });
  assert.deepEqual(orders.map((o) => o.cause), ["pr-review-blocked"],
    "before this row a pull request in exactly this state produced no order at all");
  assert.equal(orders[0].session, "product-manager");
  assert.ok(CAUSES.includes(orders[0].cause), "every emitted cause is declared in CAUSES");
  assert.match(orders[0].prompt, /#2198\s+AWAITING_REVIEW/);
});

test("#2084: an APPROVED or undecided pull request wakes NOBODY -- the control on the whole cause", () => {
  // THE NEGATIVE HALF, and without it the cause is satisfied by a function that flags every open PR.
  // `""` is the #1968 state -- the base requires no decision -- and it is NOT an approval; it is here
  // because it must not BLOCK, while `reviewStateOf` below pins that it does not read as APPROVED either.
  for (const decision of ["APPROVED", "", null]) {
    assert.deepEqual(decide({ prs: [ready(1, decision)], readyRows: [], required: ["gate"] }), [],
      `\`reviewDecision: ${JSON.stringify(decision)}\` blocks nothing and must wake nobody`);
  }
});

test("#2084: a CHANGES_REQUESTED at head is reported, and the prompt says a push does not clear it", () => {
  // #2049's own state, which sat green and armed and unmergeable for over seven hours. The prompt has to
  // carry the mechanism rather than the word, because the recipient's first instinct is to tell the author
  // to push -- and pushing past a refusal is exactly what does not work.
  const orders = decide({ prs: [ready(2049, "CHANGES_REQUESTED")], readyRows: [], required: ["gate"] });
  assert.deepEqual(orders.map((o) => o.cause), ["pr-review-blocked"]);
  assert.match(orders[0].prompt, /does NOT clear by being pushed past/);
  assert.match(orders[0].prompt, /compare the review's commit against `headRefOid`/,
    "the row's whole finding: the refusal may be at a head the author has already fixed");
});

test("#2084: a DRAFT, a RED one and a HELD one are other causes' subjects, never this one", () => {
  // EACH EXCLUSION IS A CAUSE, not an oversight, and a test rather than a paragraph. A draft belongs to
  // `draft-awaiting-verdict`; a red one to `pr-checks-failing`; a held one is not merging BY DECISION and
  // reporting it would send somebody to unblock what a ruling holds.
  const drafted = { ...ready(1, "REVIEW_REQUIRED"), isDraft: true };
  assert.ok(!decide({ prs: [drafted], readyRows: [], required: ["gate"] })
    .some((o) => o.cause === "pr-review-blocked"), "a draft is the reviewer lane's, not this cause's");
  const red = { ...ready(3, "REVIEW_REQUIRED"),
    statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "FAILURE" }] };
  assert.deepEqual(decide({ prs: [red], readyRows: [], required: ["gate"] }).map((o) => o.cause),
    ["pr-checks-failing"], "a red PR needs a fix, not a reviewer");
  assert.deepEqual(reviewBlocked([ready(5, "REVIEW_REQUIRED", ["hold:ceo"])], ["gate"]), [],
    "a held pull request is not merging by decision, and this cause must not argue with one");
});

test("#2084: ONE ORDER FOR THE SET, keyed on every number AND its decision", () => {
  // `greenUnarmedOrders`' shape and for its reason -- but the DECISION is in the key as well as the
  // number, because the two states want different acts. Keyed on numbers alone, a pull request whose
  // refusal was answered and is now merely awaiting a review would not re-fire.
  const orders = reviewBlockedOrders(reviewBlocked(
    [ready(2049, "CHANGES_REQUESTED"), ready(2198, "REVIEW_REQUIRED")], ["gate"]));
  assert.equal(orders.length, 1, "one order, or a queue-wide state wakes one session per pull request");
  assert.equal(orders[0].causeKey, "product-manager/pr-review-blocked/2049:REFUSED.2198:AWAITING_REVIEW");
  const answered = reviewBlockedOrders(reviewBlocked(
    [ready(2049, "REVIEW_REQUIRED"), ready(2198, "REVIEW_REQUIRED")], ["gate"]));
  assert.notEqual(answered[0].causeKey, orders[0].causeKey,
    "the refusal became a pending review: a different state, so a different question");
});

test("#2084: the key carries NO head, so a rework does not re-wake product-manager every push", () => {
  // DELIBERATE, and the reason is this row's own diagnosis. `verdict-not-convinced` keys on the head
  // because the author is the recipient and every push IS the answer; here the recipient is the queue's
  // reader and a push during a rework changes nothing they can act on. It also makes the key move at
  // exactly the right moment if `dismiss_stale_reviews` is ever turned on: the push dismisses the review,
  // the decision changes, and the key changes with it.
  const a = reviewBlockedOrders(reviewBlocked([ready(7, "CHANGES_REQUESTED")], ["gate"]));
  const pushed = { ...ready(7, "CHANGES_REQUESTED"), headRefOid: "ffffffffffffffffffffffffffffffff" };
  const b = reviewBlockedOrders(reviewBlocked([pushed], ["gate"]));
  assert.equal(a[0].causeKey, b[0].causeKey, "the head moved and the state did not");
});

/**
 * #2283: a labelled pull request in the two states the row routes. `ready()` plus a `session:` label and,
 * for a refusal, the review's own commit -- `reviews[].commit.oid`, the field `readPrs` asks for (#2365).
 */
function labelled(n: number, session: string, decision: string, refusedAt?: string) {
  const pr = ready(n, decision, [`session:${session}`]);
  if (refusedAt !== undefined) pr.reviews = [{ state: "CHANGES_REQUESTED", commit: { oid: refusedAt } }];
  return pr;
}
const blockedOrders = (prs: unknown[]) => reviewBlockedOrders(reviewBlocked(prs, ["gate"]));
const OLD_HEAD = "0ldc0mm1t0000000000000000000000f";

test("#2283 done-when 1: a labelled PR in AWAITING_REVIEW or REFUSED is ITS SESSION's order, keyed without a head", () => {
  const orders = blockedOrders([labelled(2301, "worker-9", "REVIEW_REQUIRED"),
    labelled(2302, "worker-4", "CHANGES_REQUESTED", HEAD)]);
  assert.deepEqual(orders.map((o) => [o.session, o.causeKey]), [
    ["worker-9", "worker-9/pr-review-blocked/pr-2301/AWAITING_REVIEW"],
    ["worker-4", "worker-4/pr-review-blocked/pr-2302/REFUSED"]], "one order per labelled PR, to its own session");
  for (const o of orders) {
    assert.equal(o.cause, "pr-review-blocked");
    assert.ok(!o.causeKey.includes(HEAD), "the key names the state and never the head (#2084)");
  }
  // Positive control: the SAME two states with NO label still make the ONE set order to product-manager,
  // and the labelled and unlabelled orders are different keys, never swallowed as one.
  const unlabelled = blockedOrders([ready(2301, "REVIEW_REQUIRED"), ready(2302, "CHANGES_REQUESTED")]);
  assert.deepEqual(unlabelled.map((o) => [o.session, o.causeKey]),
    [["product-manager", "product-manager/pr-review-blocked/2301:AWAITING_REVIEW.2302:REFUSED"]]);
  const mixed = blockedOrders([labelled(2301, "worker-9", "REVIEW_REQUIRED"), ready(2302, "CHANGES_REQUESTED")]);
  assert.deepEqual(mixed.map((o) => o.causeKey).sort(), [
    "product-manager/pr-review-blocked/2302:REFUSED", "worker-9/pr-review-blocked/pr-2301/AWAITING_REVIEW"]);
});

test("#2283 done-when 2: the product-manager set order does not list a labelled PR", () => {
  const orders = blockedOrders([labelled(2301, "worker-9", "REVIEW_REQUIRED"),
    labelled(2303, "worker-9", "CHANGES_REQUESTED", HEAD), ready(2304, "REVIEW_REQUIRED")]);
  const set = orders.filter((o) => o.session === "product-manager");
  assert.equal(set.length, 1);
  assert.match(set[0].prompt, /#2304\s+AWAITING_REVIEW/, "the unlabelled PR stays in the set");
  assert.doesNotMatch(set[0].prompt, /#2301|#2303/, "a labelled PR is its session's, not the queue reader's");
  assert.equal(set[0].causeKey, "product-manager/pr-review-blocked/2304:AWAITING_REVIEW");
});

test("#2283 done-when 3: a push to a labelled PR's head does not change its causeKey", () => {
  for (const [decision, refusedAt] of [["REVIEW_REQUIRED", undefined], ["CHANGES_REQUESTED", HEAD]] as const) {
    const before = blockedOrders([labelled(2305, "worker-9", decision, refusedAt)]);
    const pushed = { ...labelled(2305, "worker-9", decision, refusedAt), headRefOid: "f".repeat(32) };
    const after = blockedOrders([pushed]);
    assert.equal(before.length, 1);
    assert.equal(before[0].causeKey, after[0].causeKey, `${decision}: the head moved and the state did not`);
  }
});

test("#2283: a refusal's FIRST FACT is the review's commit against headRefOid, in all three readings", () => {
  const at = (refusedAt?: string) => blockedOrders([labelled(2306, "worker-9", "CHANGES_REQUESTED", refusedAt)])[0].prompt;
  const live = at(HEAD);
  assert.match(live.split("\n")[1], /posted AT the current head `abc12345`.*live/, "at the head: the refusal stands");
  const stale = at(OLD_HEAD);
  assert.match(stale.split("\n")[1], /posted at `0ldc0mm1` and the head is now `abc12345`.*STILL STANDS/,
    "at an older head: the author pushed after it and only a newer review lifts it");
  assert.match(stale, /reviewer-2306/, "and the remedy names the reviewer for that pull request");
  assert.match(at().split("\n")[1], /names no commit/, "a payload that cannot say is not read as a match");
  assert.match(live, /rework is yours/);
});

test("#2283: an UNRECOGNISED decision stays at product-manager even on a labelled PR", () => {
  // The author can neither read nor fix a value of GitHub's this gate has never seen.
  const orders = blockedOrders([labelled(2307, "worker-9", "A_STATE_GITHUB_HAS_NOT_SHIPPED_YET")]);
  assert.deepEqual(orders.map((o) => [o.session, o.causeKey]),
    [["product-manager", "product-manager/pr-review-blocked/2307:UNRECOGNISED"]]);
});

test("#2283: through `decide`, a labelled AWAITING_REVIEW PR reaches its session with the reviewer named", () => {
  const orders = decide({ prs: [labelled(2308, "worker-9", "REVIEW_REQUIRED")], readyRows: [], required: ["gate"] });
  assert.deepEqual(orders.map((o) => [o.cause, o.session]), [["pr-review-blocked", "worker-9"]]);
  assert.match(orders[0].prompt, /prompt:session reviewer-2308/);
  assert.match(orders[0].prompt, /never entered the reviewer lane/);
});

test("#2084: an ABSENT `reviewDecision` is UNREADABLE and emits NOTHING -- it is a fact about the gate", () => {
  // BOTH HALVES, because either alone is the wrong lesson. The state is named rather than folded into
  // "fine" -- that is the honest answer for a field nobody asked for -- and it emits no order, because an
  // order would report the gate's own read as a pull request's state. The control for the regression it
  // would otherwise hide is the `readPrs` field-list test above, named there.
  assert.equal(reviewStateOf(ready(1, undefined)).code, REVIEW_STATE.UNREADABLE);
  assert.deepEqual(reviewBlocked([ready(1, undefined)], ["gate"]), []);
  assert.deepEqual(decide({ prs: [ready(1, undefined)], readyRows: [], required: ["gate"] }), []);
});

test("#2084: an UNRECOGNISED decision BLOCKS -- the `!== never` shape, and the value nobody has seen", () => {
  // `bindsMeVerdict`'s lesson in `branch-protection.test.ts`, one file over: an allowlist of the blocking
  // values would be written from today's vocabulary, and the value that slips through is the one nobody
  // has seen. A state this gate cannot name must never be the state that reads as mergeable.
  const v = reviewStateOf(ready(1, "A_STATE_GITHUB_HAS_NOT_SHIPPED_YET"));
  assert.equal(v.code, REVIEW_STATE.UNRECOGNISED);
  assert.notEqual(v.code, REVIEW_STATE.APPROVED);
  assert.deepEqual(reviewBlocked([ready(1, "A_STATE_GITHUB_HAS_NOT_SHIPPED_YET")], ["gate"])
    .map((r) => r.number), [1], "and it reaches somebody rather than passing quietly");
});

test("#2084: an EMPTY decision is NOT an approval -- the #1968 state has its own name", () => {
  // It blocks nothing, which the control above pins; but reading it as APPROVED would report a base that
  // requires no review at all as a satisfied requirement. `branch-protection.test.ts` measured that shape
  // on #1968: three reviews including an APPROVED, and an empty decision that decided nothing.
  for (const empty of ["", null]) {
    const v = reviewStateOf(ready(1, empty));
    assert.equal(v.code, REVIEW_STATE.NO_DECISION);
    assert.notEqual(v.code, REVIEW_STATE.APPROVED);
    assert.match(v.why, /#1968 state/);
  }
  assert.equal(new Set(Object.values(REVIEW_STATE)).size, 6, "and the six are genuinely distinct");
});

// --- #1959: a pull request CODEOWNERS assigns to `ceo`'s pipeline lane, with no review from `ceo` --------

const pipelinePr = (n: number, files: string[], extra: Record<string, unknown> = {}) =>
  ({ number: n, files: files.map((path) => ({ path })), changedFiles: files.length,
    author: { login: "a11ign-ai-workers" }, reviews: [], ...extra });

test("#1959 (a): fires for an open PR touching a pipeline path with no code-owner approval", () => {
  const pr = pipelinePr(10, [".github/workflows/release.yml"]);
  assert.deepEqual(pipelineCodeownerReviewMissing([pr], comparablePrFiles([pr])).map((m) => m.number), [10]);
});

test("#1959 (b): does NOT fire for a PR touching ONLY the generated consumer-gate.yml", () => {
  const pr = pipelinePr(11, [".github/workflows/consumer-gate.yml"]);
  assert.deepEqual(pipelineCodeownerReviewMissing([pr], comparablePrFiles([pr])), [],
    "CODEOWNERS carves this file out of the pipeline lane by its own last-matching-pattern rule");
});

test("#1959: a PR touching BOTH the carve-out and an owned path still fires, on the owned path", () => {
  const pr = pipelinePr(12, [".github/workflows/consumer-gate.yml", ".github/workflows/ci.yml"]);
  assert.deepEqual(pipelineCodeownerReviewMissing([pr], comparablePrFiles([pr])).map((m) => m.number), [12]);
});

test("#1959 (c): does NOT fire once the code owner has approved", () => {
  const pr = pipelinePr(13, [".github/workflows/release.yml"],
    { reviews: [{ state: "APPROVED", author: { login: "a11ign-ai-leads" } }] });
  assert.deepEqual(pipelineCodeownerReviewMissing([pr], comparablePrFiles([pr])), [],
    "the owner has already reviewed; the gap this row names is closed for this PR");
});

test("#1959: an APPROVED review from anyone ELSE does not satisfy CODEOWNERS", () => {
  const pr = pipelinePr(14, [".github/workflows/release.yml"],
    { reviews: [{ state: "APPROVED", author: { login: "a11ign-bot" } }] });
  assert.deepEqual(pipelineCodeownerReviewMissing([pr], comparablePrFiles([pr])).map((m) => m.number), [14],
    "GitHub's own rule: only an approval BY a code owner satisfies the requirement");
});

test("#1959 (d): does NOT fire for a PR the code owner authored -- GitHub never requests it", () => {
  const pr = pipelinePr(15, [".github/workflows/release.yml"], { author: { login: "a11ign-ai-leads" } });
  assert.deepEqual(pipelineCodeownerReviewMissing([pr], comparablePrFiles([pr])), [],
    "GitHub will not request a review from a pull request's own author, and #2022's bypass allowance "
    + "covers exactly this case");
});

test("#1959: a PR touching no pipeline path at all is not this cause's subject", () => {
  const pr = pipelinePr(16, ["packages/lab/src/packaging/work-gate.test.ts"]);
  assert.deepEqual(pipelineCodeownerReviewMissing([pr], comparablePrFiles([pr])), []);
});

test("#1959: a truncated file list (gh's 100-file cap) is dropped, never read short", () => {
  // `comparablePrFiles` already refuses a PR whose `files.length` does not match `changedFiles` -- the
  // same truncation guard B4 relies on -- so this cause inherits "silent about what it cannot see" rather
  // than a false negative built on a partial read.
  const pr = { number: 17, files: [{ path: "packages/lab/src/packaging/work-gate.test.ts" }],
    changedFiles: 101, author: { login: "a11ign-ai-workers" }, reviews: [] };
  assert.deepEqual(comparablePrFiles([pr]), [], "the truncation guard drops it before this cause ever reads it");
  assert.deepEqual(pipelineCodeownerReviewMissing([pr], comparablePrFiles([pr])), []);
});

test("#1959: decide() wakes ceo with ONE order naming every PR still missing the review", () => {
  const a = pipelinePr(20, [".github/workflows/release.yml"]);
  const b = pipelinePr(21, [".github/workflows/auto-arm.yml"], { labels: [{ name: "session:worker-21" }] });
  const orders = decide({ prs: [a, b], readyRows: [], prFiles: comparablePrFiles([a, b]) })
    .filter((o) => o.cause === "pr-codeowner-review-missing");
  assert.equal(orders.length, 1, "one set order, not one per pull request");
  assert.equal(orders[0].session, "ceo");
  assert.match(orders[0].prompt, /#20/);
  assert.match(orders[0].prompt, /#21 \(worker-21\)/, "a labelled PR names whose branch it is, for context only");
});

test("#1959: it is FINISH (never withheld by a drain) and an ACTION cause (not in JUDGMENT_CAUSES)", () => {
  assert.ok(CAUSES.includes("pr-codeowner-review-missing"),
    "it must be in CAUSES or worker-profile refuses it at run time");
  assert.ok(!START_CAUSES.includes("pr-codeowner-review-missing"),
    "FINISH: the pull request already exists, and a drain is the window where leaving it unreviewed until "
    + "#1756's flip lands would cost most");
  assert.ok(!JUDGMENT_CAUSES.includes("pr-codeowner-review-missing"),
    "ACTION: the causeKey already carries the waiting set, so a review that clears one PR mints a new key");
  const a = pipelinePr(22, [".github/workflows/release.yml"]);
  const orders = decide({ prs: [a], readyRows: [], prFiles: comparablePrFiles([a]), drain: true })
    .filter((o) => o.cause === "pr-codeowner-review-missing");
  assert.equal(orders.length, 1, "a drain stops the org taking on work, not finishing a review already owed");
});

/**
 * #2113 AT THE SEAM THAT OFFERS ROWS, WHICH IS THE ONLY PLACE THE DEFECT COULD EVER COST ANYTHING.
 *
 * `waitingOn`'s own tests pin the parsing and the comparison. This pins what the gate DOES with it: a
 * `ready` row declaring a sub-day wait is shelved with its reason while the hour has not arrived, and
 * offered the moment it has -- ON THE SAME DATE, which is the resolution the field could not express.
 *
 * THE CLOCK IS INJECTED, and #2113 is why this path needed one: whether a row is offerable can now change
 * within a single day, so a test that read the host clock could not tell a correct answer from a lucky
 * one. `partitionFleetBatch` already took a `clock` for the same reason; this is that pattern, not a new
 * one.
 */
test("#2113: a Ready row waiting on an HOUR is shelved before it and offered after, on one date", () => {
  const dated = readyRow(2002, { body: `${COMPLETE_BODY}\n## Not-before: 2026-09-23T06:10:00Z` });
  const clock = (iso: string) => ({ today: "2026-09-23", nowMs: Date.parse(iso) });

  // 00:20Z: the date has arrived and the 06:10Z run has not. Before #2113 this row was OFFERABLE, and a
  // session woken for it could not have finished it.
  const early = partitionUnclaimed([dated, readyRow(2003)], [], { clock: clock("2026-09-23T00:20:00Z") });
  assert.deepEqual(early.offerable.map((r: { number: number }) => r.number), [2003],
    "#2003 declares nothing and is still offered -- without it a gate that shelved everything would pass");
  assert.equal(early.blocked.length, 1, "shelved with a reason, never silently dropped");
  assert.equal(early.blocked[0].number, 2002);
  assert.match(early.blocked[0].reason, /not before 2026-09-23T06:10:00Z .*clears itself/,
    "the shelf line names the HOUR: a reader deciding whether to wait cannot use the day it falls in");

  // 07:14Z, the same date -- the moment #2002's owner actually took the read. The wait has cleared with
  // no edit to the row, which is the property every condition in this module is required to have.
  const late = partitionUnclaimed([dated, readyRow(2003)], [], { clock: clock("2026-09-23T07:14:00Z") });
  assert.deepEqual(late.offerable.map((r: { number: number }) => r.number), [2002, 2003],
    "the ONLY thing that changed is the clock, so nothing else can be what released it");
  assert.deepEqual(late.blocked, []);
});

test("#2113: a date-only Ready row is offered and shelved exactly as it was before the widening", () => {
  // THE EQUIVALENCE AT THE SEAM. `waitingOn` is asked for the whole org here, so a change that altered
  // any date-only row's answer would be a behaviour change dressed as a widening. A date-only value is
  // measured against `today` at midnight UTC, and the clock is moved across the whole day to show it
  // does not enter that path at all.
  const dated = readyRow(2002, { body: `${COMPLETE_BODY}\nNot-before: 2026-09-24` });
  for (const at of ["2026-09-23T00:00:00Z", "2026-09-23T23:59:59Z"]) {
    const { offerable, blocked } = partitionUnclaimed([dated], [],
      { clock: { today: "2026-09-23", nowMs: Date.parse(at) } });
    assert.deepEqual(offerable, [], `tomorrow's date still shelves the row at ${at}`);
    assert.match(blocked[0].reason, /not before 2026-09-24/);
  }
  const arrived = partitionUnclaimed([dated], [],
    { clock: { today: "2026-09-24", nowMs: Date.parse("2026-09-24T00:00:00Z") } });
  assert.deepEqual(arrived.offerable.map((r: { number: number }) => r.number), [2002],
    "and the day itself is not 'before' it -- the rule this field has always had");
});


// --- #2209: a pull request that CONFLICTS with `main`, which nothing in this repository could see ---------

/**
 * #2203's own shape: green, unheld, not a draft, approved, armed -- and DIRTY. The two merge fields are the
 * only thing that distinguishes it from a pull request that is merely waiting, and until this row no line
 * of the gate asked for either.
 */
function conflicted(n: number, labels: string[] = ["session:worker-tooling"]) {
  return { ...ready(n, "APPROVED", labels), mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" };
}

test("#2209 `mergeStateStatus` and `mergeable` ride on readPrs's existing call -- the fixture and the org agree", () => {
  // THE CONTROL FOR EVERYTHING BELOW: a filter reading a field production never fetches is green on a
  // fixture and blind in the org, and an empty cause looks exactly like a healthy queue.
  const calls: string[][] = [];
  readPrs((args: string[]) => { calls.push(args); return "[]"; });
  assert.equal(calls.length, 1, "one call, or the fields stopped being free");
  const fields = String(calls[0][calls[0].indexOf("--json") + 1]).split(",");
  assert.ok(fields.includes("mergeStateStatus"), "the conflict predicate reads this");
  assert.ok(fields.includes("mergeable"), "and this");
  assert.ok(fields.includes("reviewDecision"), "and the #2084 field is still there");
});

test("#2209 a CONFLICTING pull request is not one that should be merging; a merely blocked one still is", () => {
  const blocked = { ...ready(2, "REVIEW_REQUIRED"), mergeStateStatus: "BLOCKED", mergeable: "MERGEABLE" };
  assert.deepEqual(shouldBeMergingPrs([conflicted(1), blocked], ["gate"]), [2],
    "the conflicting one leaves; the control -- MERGEABLE, blocked on something else -- must stay");
});

test("#2209 THE LIVE SHAPE: a conflicted, approved, green PR reaches its AUTHOR with the real state named", () => {
  // MEASURED: #2203 at 2026-09-23T18:30Z -- `DIRTY`, `CONFLICTING`, `APPROVED` -- was reported to
  // `product-manager` as a credential outage. THE REMEDY IS NOT AN EXCLUSION: dropping it from
  // `shouldBeMerging` and reporting it nowhere fails the row, and this is the assertion that says so.
  const orders = decide({ prs: [conflicted(2203)], readyRows: [], required: ["gate"] });
  assert.deepEqual(orders.map((o) => o.cause), ["pr-merge-conflict"],
    "it must still reach somebody, and not as pr-green-unarmed or pr-review-blocked");
  assert.equal(orders[0].session, "worker-tooling", "the conflict is code work: the PR's own session");
  assert.ok(CAUSES.includes(orders[0].cause));
  assert.match(orders[0].prompt, /CONFLICTS with `main`/);
  assert.match(orders[0].prompt, /DO NOT ARM IT/, "the remedy pr-green-unarmed hands over cannot succeed here");
  assert.match(orders[0].prompt, /holding every Ready row that shares a file with it \(B4\)/, "the B4 consequence is said nowhere else and stays (#2538)");
  assert.doesNotMatch(orders[0].prompt, /nobody answers|should be closed/, "the closing tail repeated the preamble (#2538)");
  assert.equal(orders[0].causeKey, `worker-tooling/pr-merge-conflict/pr-2203/${HEAD.slice(0, 8)}`);
});

test("#2209 an unlabelled conflicted PR falls back to product-manager, never to nobody", () => {
  const orders = mergeConflictOrders(conflictedPrs([conflicted(7, [])], ["gate"]));
  assert.equal(orders.length, 1);
  assert.equal(orders[0].session, "product-manager");
  assert.match(orders[0].prompt, /names no session/);
});

test("#2209 the conflict cause and pr-review-blocked PARTITION one population -- no PR is named by both", () => {
  const both = { ...conflicted(9), reviewDecision: "REVIEW_REQUIRED" };
  assert.deepEqual(reviewBlocked([both], ["gate"]), [],
    "a conflicted PR is the author's rebase first; the review question comes back after it");
  assert.deepEqual(conflictedPrs([both], ["gate"]).map((p: { number: number }) => p.number), [9]);
});

test("#2209 a draft, a red PR and a held PR are other causes' subjects, never this one", () => {
  // The positive control for these three exclusions is the LIVE SHAPE test above, which shares the fixture.
  const drafted = { ...conflicted(1), isDraft: true };
  const red = { ...conflicted(3), statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "FAILURE" }] };
  const held = conflicted(5, ["hold:ceo"]);
  assert.deepEqual(conflictedPrs([drafted, red, held], ["gate"]), []);
  assert.deepEqual(decide({ prs: [red], readyRows: [], required: ["gate"] }).map((o) => o.cause),
    ["pr-checks-failing"]);
});

test("#2209 an UNREAD merge state is not read as mergeable, and not read as a conflict", () => {
  // THE FALL DIRECTION, pinned: absent or `UNKNOWN` (GitHub still computing) is neither certified clear
  // nor accused. It STAYS in the candidate set -- `pr-green-unarmed`'s population as it was -- so a field
  // the gate lost cannot silently empty that cause.
  const absent = ready(4, "APPROVED");
  const unknown = { ...ready(6, "APPROVED"), mergeStateStatus: "UNKNOWN", mergeable: "UNKNOWN" };
  assert.equal(conflictStateOf(absent), "UNREAD");
  assert.equal(conflictStateOf(unknown), "UNREAD");
  assert.equal(conflictStateOf({ mergeStateStatus: "CLEAN" }), "NOT_CONFLICTING");
  assert.equal(conflictStateOf({ mergeable: "CONFLICTING" }), "CONFLICTING", "either field is enough");
  assert.equal(conflictStateOf({ mergeStateStatus: "DIRTY" }), "CONFLICTING");
  assert.deepEqual(shouldBeMergingPrs([absent, unknown], ["gate"]), [4, 6]);
  assert.deepEqual(conflictedPrs([absent, unknown], ["gate"]), []);
});

test("#2209 pr-green-unarmed keeps saying what it said for the state it was built for", () => {
  // #1969's credential outage: green, unheld, unarmed and MERGEABLE. Its text is unchanged.
  const mergeable = { ...ready(8, "APPROVED"), mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" };
  assert.deepEqual(shouldBeMergingPrs([mergeable], ["gate"]), [8]);
  const orders = decide({ prs: [mergeable], readyRows: [], required: ["gate"], unarmed: [8] });
  assert.deepEqual(orders.map((o) => o.cause), ["pr-green-unarmed"]);
});


// --- #2176: the review question is asked of every green pull request, and keyed on the AUTHORED head ------

const AUTHORED = "a".repeat(40);
const AUTHORED_2 = "d".repeat(40);
const MERGE_UI = "b".repeat(40);
const MERGE_SESSION = "c".repeat(40);
// #3045: a head is the same work as another when its PATCH ID is equal, which `withPatchIds` reads and a fixture states.
const PATCH_A = "1".repeat(64);
const PATCH_B = "2".repeat(64);
const patched = (ids: Record<string, string>) => ({ patchIds: ids });
const verdictAt = (n: number, oid: string, word: string) =>
  ({ body: `Review of #${n} at \`${oid.slice(0, 8)}\`, by \`reviewer\`: ${word}.` });

/** A green, NON-draft pull request -- the shape #2104 had -- with an optional commit chain attached. */
function readyPr(n: number, head: string, extra: Record<string, unknown> = {}) {
  return { number: n, isDraft: false, headRefOid: head, statusCheckRollup: GREEN,
    author: { login: "a11ign-ai-workers" }, comments: [], labels: [{ name: "session:worker-judge" }], ...extra };
}
const ordersFor = (pr: unknown) => decide({ prs: [pr], readyRows: [] }) as
  { cause: string, session: string, causeKey: string, prompt: string }[];

test("#2176 a green NON-DRAFT with no verdict at its head wakes its parity reviewer", () => {
  // THE POSITIVE HALF, and the row's Open-check: this returned ZERO orders before #2176.
  const orders = ordersFor(readyPr(9999, AUTHORED));
  assert.deepEqual(orders.map((o) => [o.session, o.cause]), [["reviewer-9999", "draft-awaiting-verdict"]]);
  assert.deepEqual(ordersFor(readyPr(9998, AUTHORED)).map((o) => o.session), ["reviewer-9998"],
    "`reviewer-<n>` for every n, exactly as for a draft");
  assert.match(orders[0].prompt, /Ready \(not a draft\) #9999/, "the wording must be true of the pull request");
  assert.doesNotMatch(orders[0].prompt, /Draft #/);
  // THE CONTRAST THAT MAKES THE RESULT A DEFECT RATHER THAN A FIXTURE PROPERTY: the same pull request as a draft.
  assert.equal(ordersFor({ ...readyPr(9999, AUTHORED), isDraft: true }).length, 1);
});

test("#2176 a green NON-DRAFT carrying `not convinced` at head sends the rework to the session on its label", () => {
  const pr = readyPr(2104, AUTHORED, { comments: [verdictAt(2104, AUTHORED, "not convinced")] });
  const [order] = ordersFor(pr);
  assert.equal(order.cause, "verdict-not-convinced");
  assert.equal(order.session, "worker-judge", "the session named by the pull request's own label");
  assert.equal(order.causeKey, `worker-judge/verdict-not-convinced/pr-2104/${AUTHORED.slice(0, 8)}`);
  assert.deepEqual(ordersFor({ ...pr, isDraft: true }).map((o) => o.cause), ["verdict-not-convinced"],
    "exactly as the draft case does");
});

test("#2176 a green NON-DRAFT with a CONVINCED verdict produces NO order -- draft-convinced-not-ready stays draft-only", () => {
  const convinced = readyPr(2105, AUTHORED, { comments: [verdictAt(2105, AUTHORED, "convinced")] });
  assert.deepEqual(ordersFor(convinced), [], "already ready: there is nothing to flip");
  // THE POSITIVE CONTROL for the emptiness above, which is the two tests before this one and, beside it,
  // the same reader over the same shape with the WORD changed: it must be non-empty, or the assertion above
  // passes for a function that returns [] for everything.
  const refused = { ...convinced, comments: [verdictAt(2105, AUTHORED, "not convinced")] };
  assert.equal(ordersFor(refused).length, 1);
  // AND THE CAUSE THAT MUST SURVIVE, so "applies to both" cannot silently become "applies to all four".
  assert.deepEqual(ordersFor({ ...convinced, isDraft: true }).map((o) => o.cause), ["draft-convinced-not-ready"]);
});

test("#3045 a head with the same PATCH keeps the SAME causeKey, whoever pushed it; a changed patch moves it", () => {
  const keyOf = (pr: unknown) => ordersFor(pr)[0].causeKey;
  const base = keyOf(readyPr(2104, AUTHORED, patched({ [AUTHORED]: PATCH_A })));
  assert.match(base, new RegExp(`/pr-2104/${PATCH_A.slice(0, 8)}$`), "keyed on the patch id, not the head");
  const merged = readyPr(2104, MERGE_UI, patched({ [AUTHORED]: PATCH_A, [MERGE_UI]: PATCH_A }));
  assert.equal(keyOf(merged), base, "an update-branch is a new head with no new work");
  const rebased = readyPr(2104, MERGE_SESSION, patched({ [MERGE_SESSION]: PATCH_A }));
  assert.equal(keyOf(rebased), base, "a rebased head is read as the same work with NO ancestor in common");
  // THE CONTROL: a changed patch moves the key, or the equalities above are a constant.
  const resolved = readyPr(2104, MERGE_UI, patched({ [AUTHORED]: PATCH_A, [MERGE_UI]: PATCH_B }));
  assert.notEqual(keyOf(resolved), base, "a merge whose conflict resolution CHANGED the patch is new work");
  // UNREAD IS NOT EQUAL: with no patch id the key is the head, which is this gate's behaviour before #3045.
  assert.match(keyOf(readyPr(2104, MERGE_UI)), new RegExp(`/pr-2104/${MERGE_UI.slice(0, 8)}$`));
});

test("#3045 #2104's shape: a verdict at an EARLIER head stands while the patch is equal, and not when it is not", () => {
  const same = patched({ [AUTHORED]: PATCH_A, [MERGE_SESSION]: PATCH_A });
  const refused = readyPr(2104, MERGE_SESSION, { ...same, comments: [verdictAt(2104, AUTHORED, "not convinced")] });
  const [order] = ordersFor(refused);
  assert.equal(order.cause, "verdict-not-convinced", "rework is owed, however many merges came after");
  assert.equal(order.causeKey, `worker-judge/verdict-not-convinced/pr-2104/${PATCH_A.slice(0, 8)}`);
  // The controls: without the equality the verdict is at a head that is NOT this work, and the reviewer is summoned again.
  assert.equal(ordersFor({ ...refused, patchIds: { [AUTHORED]: PATCH_A, [MERGE_SESSION]: PATCH_B } })[0].cause, "draft-awaiting-verdict");
  assert.equal(ordersFor({ ...refused, patchIds: undefined })[0].cause, "draft-awaiting-verdict");
  // A verdict written AFTER an update-branch names the merge head, and it settles the pull request too.
  assert.deepEqual(ordersFor(readyPr(2104, MERGE_SESSION, { ...same, comments: [verdictAt(2104, MERGE_UI, "convinced")],
    patchIds: { ...same.patchIds, [MERGE_UI]: PATCH_A } })), []);
});

test("#3045 the reviewer's prompt says a verdict at an equal-patch head stands, and only when there is one", () => {
  const pr = readyPr(2104, MERGE_UI, patched({ [AUTHORED]: PATCH_A, [MERGE_UI]: PATCH_A }));
  assert.match(ordersFor(pr)[0].prompt, new RegExp(`patch \\(\`${PATCH_A.slice(0, 8)}\`\\) is the same at 2 heads`));
  assert.doesNotMatch(ordersFor(readyPr(2104, AUTHORED, patched({ [AUTHORED]: PATCH_A })))[0].prompt, /is the same at/);
});

test("#3045 withPatchIds reads patches ONLY where the review question is genuinely open", () => {
  const calls: string[][] = [];
  const run = (args: string[]) => { calls.push(args); return "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n"; };
  const open = readyPr(1, MERGE_UI);
  const settled = readyPr(2, MERGE_UI, { comments: [verdictAt(2, AUTHORED, "convinced")] });
  const red = readyPr(3, MERGE_UI, { statusCheckRollup: RED });
  const labelled = readyPr(5, MERGE_UI, { labels: [{ name: "awaiting-evidence" }] });
  const out = withPatchIds([open, settled, red, labelled], run) as { patchIds?: Record<string, string> }[];
  assert.deepEqual(calls.map((c) => c[c.length - 1]),
    [`repos/a11ign/a11ign/compare/main...${MERGE_UI}`, `repos/a11ign/a11ign/compare/main...${MERGE_UI}`, `repos/a11ign/a11ign/compare/main...${AUTHORED.slice(0, 8)}`],
    "the open one at its head; the answered one at its head AND the head its verdict names; red and labelled: no call");
  assert.deepEqual(Object.keys(out[0].patchIds ?? {}), [MERGE_UI], "the positive control: the open one WAS enriched");
  assert.deepEqual(Object.keys(out[1].patchIds ?? {}), [MERGE_UI, AUTHORED.slice(0, 8)]);
  assert.deepEqual([out[2], out[3]].map((p) => p.patchIds), [undefined, undefined]);
});

test("#3045 a REFUSED read leaves the pull request as it was -- never an empty patch id", () => {
  const refuse = () => { throw new Error("HTTP 406 diff too large"); };
  const [pr] = withPatchIds([readyPr(1, MERGE_UI)], refuse) as { patchIds?: unknown }[];
  assert.equal(pr.patchIds, undefined);
  assert.equal(readPatchId(MERGE_UI, "main", refuse), null);
  assert.equal(readPatchId(MERGE_UI, "main", () => ""), patchIdOfDiff(""), "an empty diff is a real patch, not an unread one");
  assert.deepEqual(readCommitShas(1, refuse), null);
  assert.equal(readCommitShas(1, () => ""), null, "no commits is not a list either");
  assert.deepEqual(readCommitShas(1, () => `${AUTHORED}\n${MERGE_UI}\n`), [AUTHORED, MERGE_UI]);
});

test("#3045 the patch read is counted in GH_READS", () => {
  assert.match(GH_READS.conditionalOnUnreviewedGreenPr, /compare\/\{base\}\.\.\.\{head\}/);
  assert.match(GH_READS.conditionalOnUnreviewedGreenPr, /pulls\/\{n\}\/commits/);
});


// --- #2365: a convinced verdict that is only a COMMENT ---------------------------------------------------

const approvalAt = (oid: string) => ({ state: "APPROVED", commit: { oid }, author: { login: "a11ign-bot" } });
/** #2337's shape: green, ready, a convinced COMMENT at head, and `reviews` READ and empty. */
const commentOnly = (n = 9999, head = AUTHORED, extra: Record<string, unknown> = {}) =>
  readyPr(n, head, { comments: [verdictAt(n, head, "convinced")], reviews: [], reviewDecision: "REVIEW_REQUIRED", ...extra });
const unreviewed = (pr: unknown) => ordersFor(pr).filter((o) => o.cause === "verdict-comment-unreviewed");

test("#2365 a green ready PR with a convinced COMMENT and no review at head orders its parity reviewer", () => {
  const [order, ...rest] = unreviewed(commentOnly(9999));
  assert.deepEqual(rest, []);
  assert.equal(order.session, "reviewer-9999", "`reviewer-<n>`");
  assert.equal(unreviewed(commentOnly(9998))[0].session, "reviewer-9998", "and for an even number too");
  assert.match(order.prompt, /pr-review-verdict/, "it must name the remedy");
  assert.match(order.prompt, /not a new review round/);
  assert.equal(order.causeKey, `reviewer-9999/verdict-comment-unreviewed/pr-9999/${AUTHORED.slice(0, 8)}`);
  // `pr-review-blocked` (#2084) ALSO names it, for the whole set to `product-manager`: two questions, two
  // remedies, and neither replaces the other -- this one names the comment and who re-posts it.
  assert.deepEqual(ordersFor(commentOnly(9999)).map((o) => o.cause).sort(),
    ["pr-review-blocked", "verdict-comment-unreviewed"]);
});

test("#2365 the same pull request with an APPROVED review at head produces NO such order", () => {
  // THE CONTROL is the test above: same reader, same shape, `reviews` empty, non-empty.
  assert.equal(unreviewed(commentOnly()).length, 1);
  assert.deepEqual(unreviewed(commentOnly(9999, AUTHORED, { reviews: [approvalAt(AUTHORED)] })), []);
  // An approval at an OLDER head that is not equivalent is not an approval at this one.
  assert.equal(unreviewed(commentOnly(9999, AUTHORED, { reviews: [approvalAt(AUTHORED_2)] })).length, 1);
});

test("#2365 a PR-wide `reviewDecision: APPROVED` does not stand in for an approval AT this head (reviewer-2, #2388)", () => {
  // `main` keeps a stale approval, so `reviewDecision` stays APPROVED while nothing approves the current head.
  const staleButApproved = commentOnly(9999, AUTHORED, { reviewDecision: "APPROVED", reviews: [approvalAt(AUTHORED_2)] });
  assert.equal(unreviewed(staleButApproved).length, 1, "the stale approval must not silence the order");
  // THE CONTROL: the same shape with the approval AT head is silent, so the line above is not a constant.
  assert.deepEqual(unreviewed({ ...staleButApproved, reviews: [approvalAt(AUTHORED)] }), []);
  // `reviews` UNREAD stays no order whatever `reviewDecision` says.
  assert.deepEqual(unreviewed({ ...staleButApproved, reviews: undefined }), []);
});

test("#2365 `not convinced` at head, a STALE head, and an UNREAD `reviews` field each produce NO such order", () => {
  const notConvinced = commentOnly(9999, AUTHORED, { comments: [verdictAt(9999, AUTHORED, "not convinced")] });
  assert.deepEqual(unreviewed(notConvinced), [], "rework is `verdict-not-convinced`'s");
  assert.deepEqual(ordersFor(notConvinced).map((o) => o.cause).filter((c) => c !== "pr-review-blocked"),
    ["verdict-not-convinced"]);
  const stale = commentOnly(9999, AUTHORED, { comments: [verdictAt(9999, AUTHORED_2, "convinced")] });
  assert.deepEqual(unreviewed(stale), [], "a comment at a head that is not this one says nothing about it");
  assert.deepEqual(ordersFor(stale).map((o) => o.cause).filter((c) => c !== "pr-review-blocked"),
    ["draft-awaiting-verdict"], "the reviewer is asked afresh");
  const unread = { ...commentOnly(), reviews: undefined };
  assert.deepEqual(unreviewed(unread), [], "an absent field is UNREAD, never 'no review'");
});

test("#2365 a HELD or RED pull request is not asked", () => {
  assert.equal(unreviewed(commentOnly()).length, 1);
  const held = commentOnly(9999, AUTHORED, { labels: [{ name: "session:worker-judge" }, { name: "hold:ceo" }] });
  assert.deepEqual(unreviewed(held), [], "held is not merging BY DECISION");
  assert.deepEqual(unreviewed(commentOnly(9999, AUTHORED, { statusCheckRollup: [] })), []);
});

test("#2365 when both apply, a DRAFT's next act is `draft-convinced-not-ready`, and the ready PR gets this one", () => {
  const draft = commentOnly(9999, AUTHORED, { isDraft: true });
  assert.deepEqual(ordersFor(draft).map((o) => o.cause), ["draft-convinced-not-ready"]);
  assert.deepEqual(ordersFor({ ...draft, isDraft: false }).map((o) => o.cause).filter((c) => c !== "pr-review-blocked"),
    ["verdict-comment-unreviewed"]);
});

test("#3045 #2365: a head with the same patch keeps the SAME causeKey; a changed patch moves it", () => {
  const keyOf = (pr: unknown) => unreviewed(pr)[0].causeKey;
  const base = keyOf(commentOnly(9999, AUTHORED, patched({ [AUTHORED]: PATCH_A })));
  const same = patched({ [AUTHORED]: PATCH_A, [MERGE_UI]: PATCH_A });
  const merged = commentOnly(9999, MERGE_UI, { ...same, comments: [verdictAt(9999, AUTHORED, "convinced")] });
  assert.equal(keyOf(merged), base, "update-branch is a new head with no new work");
  // An approval AT THE AUTHORED HEAD still counts after the merge: it is the same work.
  assert.deepEqual(unreviewed({ ...merged, reviews: [approvalAt(AUTHORED)] }), []);
  const changed = commentOnly(9999, AUTHORED_2, { comments: [verdictAt(9999, AUTHORED_2, "convinced")],
    patchIds: { [AUTHORED]: PATCH_A, [AUTHORED_2]: PATCH_B } });
  assert.notEqual(keyOf(changed), base, "THE CONTROL: without it the equalities above are a constant");
  // ... and an approval at a head whose patch is NOT this one does not count.
  assert.equal(unreviewed({ ...changed, reviews: [approvalAt(AUTHORED)] }).length, 1);
});

test("#2365 `readPrs` asks for `reviews` -- not `latestReviews`, whose commit oid is empty -- on the one list call", () => {
  const calls: string[][] = [];
  readPrs((args: string[]) => { calls.push(args); return "[]"; });
  assert.equal(calls.length, 1);
  const fields = calls[0][calls[0].indexOf("--json") + 1].split(",");
  assert.ok(fields.includes("reviews"));
  assert.ok(!fields.includes("latestReviews"));
});

// --- #2202: a merge's close ended the wake on `answer:<session>` and nothing said so ---

const closedOwedRow = (n: number, session: string) => ({ number: n, state: "CLOSED",
  labels: [{ name: `${ANSWER_PREFIX}${session}` }] });

test("#2202 DONE-WHEN 3: a CLOSED row still wearing answer:<session> wakes that session, and says the row is closed", () => {
  const [order] = answerOrders([closedOwedRow(1936, "orchestrator")]) as { session: string, cause: string, prompt: string }[];
  assert.equal(order.session, "orchestrator");
  assert.equal(order.cause, "answer-owed");
  assert.match(order.prompt, /THE ROW IS CLOSED/);
  assert.match(order.prompt, /remove its `answer:orchestrator` label/);
  const [open] = answerOrders([owedRow(1936, "orchestrator")]) as { prompt: string }[];
  assert.doesNotMatch(open.prompt, /THE ROW IS CLOSED/, "an open row is not told it is closed -- the control");
});

test("#2202: decide wakes the session for a closed row given as `answerOwed`, before every other cause", () => {
  const orders = decide({ prs: [], readyRows: [], promotableRows: [],
    answerOwed: [closedOwedRow(2034, "product-manager")] }) as { cause: string, session: string }[];
  assert.deepEqual(orders.map((o) => [o.cause, o.session]), [["answer-owed", "product-manager"]]);
});

test("#2202: readClosedAnswerRows asks for the CLOSED rows carrying the repo's own answer labels, and returns the "
  + "rows GitHub gives it -- driven with a CLOSED row, not by the shape of an argv", () => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === "label") return JSON.stringify([{ name: "answer:ceo" }, { name: "answer:orchestrator" }, { name: "answered" }]);
    if (args[0] === "pr") return "[]"; // #2641: the pull-request half has its own file, `closed-pr-answer-owed.test.ts`
    return JSON.stringify([closedOwedRow(1936, "orchestrator"), { number: 8, state: "CLOSED", labels: [{ name: "backlog" }] }]);
  };
  const rows = readClosedAnswerRows(run);
  assert.deepEqual(rows?.map((r: { number: number }) => r.number), [1936], "only the row that carries an answer: label");
  const search = calls[1][calls[1].indexOf("--search") + 1];
  assert.equal(search, 'label:"answer:ceo","answer:orchestrator"', "a label that merely starts with `answer` is not asked for");
  assert.ok(calls[1].includes("closed"), "and it is the CLOSED population -- the open read already has the rest");
});

test("#2202: readClosedAnswerRows refuses rather than reporting nobody owes anything, and asks nothing with no labels", () => {
  assert.equal(readClosedAnswerRows(() => { throw new Error("HTTP 502"); }), null);
  assert.equal(readClosedAnswerRows(() => "not json"), null);
  assert.deepEqual(readClosedAnswerRows((args) => { if (args[0] === "label") return "[]"; throw new Error("no search with no labels"); }),
    [], "no answer: label exists, so nothing can owe -- and no search is made");
  const refusedSearch = (args: string[]) => { if (args[0] === "label") return JSON.stringify([{ name: "answer:ceo" }]); return "{}"; };
  assert.equal(readClosedAnswerRows(refusedSearch), null, "a search answering a non-list is a refusal, never an empty tracker");
});

test("#2202: main feeds the closed-row read into `answerOwed` beside the open one, through the helper that SAYS a refusal", () => {
  const source = readFileSync(new URL("../work-gate.mjs", import.meta.url), "utf8");
  assert.match(source, /answerOwed: rowsOwingAnswers\(\{ openRows: allOpen, openPrs, closedRows: closedAnswerRows\(\) \}\)/,
    "a closed row owing an answer must reach `decide` -- the open read alone is the defect");
  assert.match(source, /function closedAnswerRows\(\) \{[^]*?NOTE: could not read the closed rows/,
    "a refused read is a line on stderr, never a silent empty list");
});

// --- #2609: a closed row's answer:<session> for a session that has ENDED re-queued an order with no addressee every tick ---

const ENDED_AT = Date.parse("2026-09-26T05:00:00Z");
/** Runs `withoutEndedAnswerSessions` over `rows` with `live` workspaces and `ended` evidence; returns the orders and what was said. */
const settleAnswers = (rows: unknown[], live: string[] | null, ended: Record<string, number> | Error) => {
  const said: string[] = [];
  const kept = withoutEndedAnswerSessions(rows, { agents: () => live,
    ended: () => { if (ended instanceof Error) throw ended; return new Map(Object.entries(ended)); },
    say: (line: string) => said.push(line) });
  return { orders: answerOrders(withAnswerLabel(kept)) as { session: string, subject: string }[], said };
};

test("#2609 DONE-WHEN 1+4: a closed row's answer: for an ENDED session (absent from herdr, teardown recorded) orders nobody, "
  + "and the line says GONE rather than busy", () => {
  const { orders, said } = settleAnswers([closedOwedRow(2116, "worker-8")], ["ceo"], { "worker-8": ENDED_AT });
  assert.deepEqual(orders, []);
  assert.equal(said.length, 1);
  assert.match(said[0], /SKIPPED answer-owed for worker-8 on closed row #2116: that session has ENDED/);
  assert.doesNotMatch(said[0], /busy/i, "names the session as gone, not as busy");
});

test("#2609 DONE-WHEN 3+4: the LIVE session's closed-row question still wakes it, even when the ledger says it ended once", () => {
  const { orders, said } = settleAnswers([closedOwedRow(1936, "worker-8")], ["worker-8"], { "worker-8": ENDED_AT });
  assert.deepEqual(orders.map((o) => o.session), ["worker-8"], "live wins: a reused label is not gone");
  assert.deepEqual(said, []);
  const standing = settleAnswers([closedOwedRow(2034, "product-manager")], ["product-manager"], {});
  assert.deepEqual(standing.orders.map((o) => o.session), ["product-manager"]);
});

test("#2609 DONE-WHEN 2+4: ABSENT IS NOT ENDED -- a session that has not started, and a herdr that does not answer, skip nothing", () => {
  const notStarted = settleAnswers([closedOwedRow(2500, "reviewer-2500")], ["ceo"], { "worker-8": ENDED_AT });
  assert.deepEqual(notStarted.orders.map((o) => o.session), ["reviewer-2500"], "absent with no teardown record keeps its order");
  const blip = settleAnswers([closedOwedRow(2116, "worker-8")], null, { "worker-8": ENDED_AT });
  assert.deepEqual(blip.orders.map((o) => o.session), ["worker-8"], "herdr silent classifies nothing");
  assert.match(blip.said.join(""), /herdr did not answer/);
  const unreadable = settleAnswers([closedOwedRow(2116, "worker-8")], ["ceo"], new Error("EACCES: permission denied"));
  assert.deepEqual(unreadable.orders.map((o) => o.session), ["worker-8"], "evidence that cannot be read drops nothing");
  assert.match(unreadable.said.join(""), /could not be read \(EACCES/);
});

test("#2609: only the ended session's label is taken off a row that carries two, and the `engineers` pool is never gone", () => {
  const row = { number: 7, state: "CLOSED", labels: [{ name: "answer:worker-8" }, { name: "answer:ceo" }, { name: "lane:any" }] };
  const { orders } = settleAnswers([row], ["ceo"], { "worker-8": ENDED_AT });
  assert.deepEqual(orders.map((o) => o.session), ["ceo"]);
  assert.deepEqual(settleAnswers([closedOwedRow(8, "engineers")], [], { engineers: ENDED_AT }).orders.map((o) => o.session), ["engineers"]);
});

test("#2609: a quiet tracker pays nothing -- no closed row wearing an answer: label asks herdr or the ledgers at all", () => {
  const boom = () => { throw new Error("must not be asked"); };
  const rows = [{ number: 1, state: "CLOSED", labels: [{ name: "lane:any" }] }];
  assert.equal(withoutEndedAnswerSessions(rows, { agents: boom, ended: boom, say: boom }), rows);
});

test("#2609: `endedSessionLabels` reads a teardown's record, and a label that STARTED AGAIN is not ended", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "a11y-ended-labels-")));
  const at = (ms: number) => new Date(ms).toISOString();
  writeFileSync(join(dir, "spare-cycles"), [JSON.stringify({ role: "worker-8", at: ENDED_AT }), "not json",
    JSON.stringify({ role: "worker-9", at: ENDED_AT })].join("\n") + "\n");
  writeFileSync(join(dir, "reviewer-endings"), `${JSON.stringify({ session: "reviewer-2401", at: at(ENDED_AT) })}\n`);
  writeFileSync(join(dir, "spare-instances.json"), JSON.stringify({ "worker-9": { spawnedAt: ENDED_AT } }));
  const ended = endedSessionLabels({ dir });
  assert.deepEqual([...ended.keys()].sort(), ["reviewer-2401", "worker-8"],
    "worker-9 started at the ending's own instant (>=), so it is a later instance and is not ended");
  writeFileSync(join(dir, "spare-instances.json"), JSON.stringify({ "worker-9": { spawnedAt: ENDED_AT - 1 } }));
  assert.ok(endedSessionLabels({ dir }).has("worker-9"), "THE CONTROL: a registry entry OLDER than the ending leaves it ended");
  assert.equal(endedSessionLabels({ dir: join(dir, "nowhere") }).size, 0, "no ledgers is no evidence, not an error");
  writeFileSync(join(dir, "spare-instances.json"), "{ torn");
  assert.throws(() => endedSessionLabels({ dir }), "an unreadable registry is a lost reading and THROWS -- nothing is dropped on it");
});

test("#2609: `closedAnswerRows` runs the ended-session filter on what `readClosedAnswerRows` returned", () => {
  const source = readFileSync(new URL("../work-gate.mjs", import.meta.url), "utf8");
  assert.match(source, /function closedAnswerRows\(\) \{[^]*?return withoutEndedAnswerSessions\(rows\);/);
});

// --- #3093: ownerOfPr ordered a pull request to the session its LABEL names even when that session had ENDED ---

/** Runs `withPrOwners` over one PR through the same seams `main` wires, with `live` workspaces and `ended` evidence. */
const ownerAfterEndings = (pr: object, live: string[] | null, ended: Record<string, number> | Error, rows: unknown[] = []) => {
  const said: string[] = [];
  const [settled] = withPrOwners([pr], rows, () => null, { agents: () => live,
    ended: () => { if (ended instanceof Error) throw ended; return new Map(Object.entries(ended)); },
    say: (line: string) => said.push(line) });
  return { owner: ownerOfPr(settled), said, settled };
};
const PR_55 = { number: 55, repoKey: "a11ign/agent-org", headRefName: "agent/some-branch", labels: [{ name: "session:worker-3064" }] };

test("#3093: a PR labelled for an ENDED session (absent from herdr, teardown recorded) is ordered to ceo, never to the dead seat", () => {
  const { owner, settled } = ownerAfterEndings(PR_55, ["ceo"], { "worker-3064": ENDED_AT });
  assert.deepEqual(owner, { session: "ceo", source: "ceo" });
  assert.equal(settled.labelEnded, true);
});

test("#3093: an ended label falls to the LOWER rungs first -- a live row owner is named, with source closing-row", () => {
  const rows = [{ number: 3064, labels: [{ name: "in-progress" }, { name: "session:worker-3070" }] }];
  const pr = { ...PR_55, closingIssuesReferences: [{ number: 3064 }] };
  assert.deepEqual(ownerAfterEndings(pr, ["ceo"], { "worker-3064": ENDED_AT }, rows).owner, { session: "worker-3070", source: "closing-row" });
});

test("#3093 POSITIVE CONTROLS: a live label, an absent session with NO teardown record, a silent herdr and an unreadable ledger all KEEP the label", () => {
  const kept = { session: "worker-3064", source: "label" };
  assert.deepEqual(ownerAfterEndings(PR_55, ["worker-3064"], { "worker-3064": ENDED_AT }).owner, kept, "live wins: a reused label is not gone");
  assert.deepEqual(ownerAfterEndings(PR_55, ["ceo"], { "worker-8": ENDED_AT }).owner, kept, "absent without a record is not ended");
  const blip = ownerAfterEndings(PR_55, null, { "worker-3064": ENDED_AT });
  assert.deepEqual(blip.owner, kept, "herdr silent classifies nothing");
  assert.match(blip.said.join(""), /herdr did not answer/);
  const unreadable = ownerAfterEndings(PR_55, ["ceo"], new Error("EACCES: permission denied"));
  assert.deepEqual(unreadable.owner, kept, "evidence that cannot be read classifies nothing");
  assert.match(unreadable.said.join(""), /could not be read \(EACCES/);
});

test("#3093: the `engineers` pool is never ended, and a PR with no label pays neither herdr nor the ledgers", () => {
  assert.deepEqual(ownerAfterEndings({ ...PR_55, labels: [{ name: "session:engineers" }] }, [], { engineers: ENDED_AT }).owner,
    { session: "engineers", source: "label" });
  const boom = () => { throw new Error("must not be asked"); };
  const unlabelled = [{ ...PR_55, labels: [] }];
  assert.equal(withEndedLabels(unlabelled, { agents: boom, ended: boom, say: boom }), unlabelled);
});

test("#3093: a caller that names no source is not answered by this host -- withPrOwners without `io` classifies nothing", () => {
  const [pr] = withPrOwners([PR_55], [], () => null);
  assert.equal(pr.labelEnded, undefined);
  assert.equal(ownerOfPr(pr).source, "label");
});

test("#3093: `main` hands withPrOwners the LIVE herdr and ledger readers", () => {
  const source = readFileSync(new URL("../work-gate.mjs", import.meta.url), "utf8");
  assert.match(source, /withPrOwners\([^\n]*stampLookup\(\), \{ agents: liveWorkspaceLabels, ended: endedSessionLabels \}\)/);
});

test("#3093: the order for an ended-label PR goes to ceo, and says the label names an ENDED session and asks to re-lane or close", () => {
  const [pr] = withPrOwners([{ ...draft(55, RED), isDraft: false, labels: [{ name: "session:worker-3064" }] }], [], () => null,
    { agents: () => ["ceo"], ended: () => new Map([["worker-3064", ENDED_AT]]) });
  const [order] = decide({ prs: [pr], readyRows: [] });
  assert.equal(order.session, "ceo");
  assert.match(order.prompt, /its `session:` label names `worker-3064`, which has ENDED/);
  assert.match(order.prompt, /Re-lane it .*or close it/);
  assert.doesNotMatch(order.prompt, /It carries your session label/);
  const untouched = decide({ prs: [{ ...draft(55, RED), isDraft: false, labels: [{ name: "session:worker-3064" }] }], readyRows: [] });
  assert.equal(untouched[0].session, "worker-3064", "THE CONTROL: with the label not ended, the same PR still orders to its owner");
});

// --- #2492: answer:<session> on a PULL REQUEST woke nobody, because `gh issue list` does not return PRs ---

/** A PR as `readPrs` returns one: `isDraft` and `headRefOid` present, `state` absent (it asks `--state open`). */
const prWithLabels = (n: number, ...names: string[]) => ({ number: n, isDraft: false, headRefOid: "abc123",
  labels: names.map((name) => ({ name })) });

test("#2492 DONE-WHEN 1: a PR carrying answer:worker-tooling emits ONE order, worker-tooling/answer-owed/row-<n>, through decide", () => {
  const orders = decide({ prs: [], readyRows: [], promotableRows: [],
    answerOwed: withAnswerLabel([prWithLabels(2376, `${ANSWER_PREFIX}worker-tooling`)]) }) as
    { cause: string, session: string, causeKey: string }[];
  assert.deepEqual(orders.map((o) => [o.cause, o.session, o.causeKey]),
    [["answer-owed", "worker-tooling", "worker-tooling/answer-owed/row-2376"]]);
});

test("#2492 DONE-WHEN 2: the same PR WITHOUT the label emits none, and the same label on an ISSUE still emits exactly one", () => {
  assert.deepEqual(answerOrders(withAnswerLabel([prWithLabels(2376, "in-progress")])), [],
    "the negative control: a PR owing nobody wakes nobody");
  const issue = answerOrders([owedRow(2377, "worker-tooling")]) as { causeKey: string }[];
  assert.deepEqual(issue.map((o) => o.causeKey), ["worker-tooling/answer-owed/row-2377"],
    "an issue owing an answer is unchanged");
  const both = answerOrders([owedRow(2377, "worker-tooling"), prWithLabels(2376, `${ANSWER_PREFIX}worker-tooling`)]) as
    { causeKey: string }[];
  assert.deepEqual(both.map((o) => o.causeKey).sort(),
    ["worker-tooling/answer-owed/row-2376", "worker-tooling/answer-owed/row-2377"],
    "one number is one thing: an issue and a PR are two orders, never one each twice");
});

test("#2492 DONE-WHEN 3: the prompt says pull request for a PR and row for an issue, and a PR with no `state` reads as open", () => {
  const [pr] = answerOrders([prWithLabels(2376, `${ANSWER_PREFIX}ceo`)]) as { prompt: string }[];
  assert.match(pr.prompt, /^#2376 IS A PULL REQUEST WAITING ON AN ANSWER FROM YOU/);
  assert.match(pr.prompt, /ANSWER ON THE PULL REQUEST, then remove its `answer:ceo` label/);
  assert.doesNotMatch(pr.prompt, /THE ROW IS CLOSED|that row's/, "a PR from `readPrs` is open, and is not called a row");
  const [row] = answerOrders([owedRow(2377, "ceo")]) as { prompt: string }[];
  assert.match(row.prompt, /^#2377 IS WAITING ON AN ANSWER FROM YOU/);
  assert.match(row.prompt, /ANSWER ON THE ROW, then remove its `answer:ceo` label/);
  assert.doesNotMatch(row.prompt, /pull request/i, "the control: an issue is never called a pull request");
});

test("#2492 DONE-WHEN 4: the PR half feeds the SAME answerOwed input, so answer-owed still orders before every other cause", () => {
  const orders = decide({ prs: [openPr(5, "")], readyRows: [], promotableRows: [],
    answerOwed: [...withAnswerLabel([owedRow(2377, "ceo")]), ...withAnswerLabel([prWithLabels(2376, `${ANSWER_PREFIX}ceo`)])] }) as
    { cause: string, causeKey: string }[];
  assert.deepEqual(orders.slice(0, 2).map((o) => [o.cause, o.causeKey]),
    [["answer-owed", "ceo/answer-owed/row-2377"], ["answer-owed", "ceo/answer-owed/row-2376"]]);
});

test("#2492: rowsOwingAnswers carries a labelled PR beside the open and closed rows, and a PR without the label adds nothing", () => {
  const reads = { openRows: [owedRow(2377, "ceo")], closedRows: [closedOwedRow(1936, "orchestrator")] };
  const numbers = (openPrs: unknown[]) => (rowsOwingAnswers({ ...reads, openPrs }) as { number: number }[]).map((r) => r.number);
  assert.deepEqual(numbers([prWithLabels(2376, `${ANSWER_PREFIX}worker-tooling`)]), [2377, 2376, 1936]);
  assert.deepEqual(numbers([prWithLabels(2376, "in-progress")]), [2377, 1936], "the negative control: the label decides, not the PR");
  assert.deepEqual(numbers([]), [2377, 1936]);
});

// --- #2075: `row-off-board` -- an open row with no Project 1 item wakes product-manager ---

const NOW_MS = Date.parse("2026-09-26T12:00:00Z");
const MINUTE_MS = 60_000;

/** One open row's facts as `readRowsOffBoard` reads them; `ageMs` is how long ago it was created. */
function boardFacts(number: number, onBoard: boolean | null, ageMs = 60 * MINUTE_MS) {
  return { number, title: `row ${number}`, createdMs: NOW_MS - ageMs, onBoard };
}

/** One `repository.issues` node as GitHub returns it: the projects an issue is an item of, by number. */
function issueNode(number: number, projects: number[], { createdAt = "2026-09-26T08:00:00Z", totalCount = projects.length } = {}) {
  return { number, title: `row ${number}`, createdAt,
    projectItems: { totalCount, nodes: projects.map((n) => ({ project: { number: n } })) } };
}

/** A `gh` fake serving `pages` in order, recording every argv it was asked. */
function graphqlPages(pages: unknown[]) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    const page = pages[calls.length - 1];
    if (page === undefined) throw new Error("asked for a page the fake does not have");
    return JSON.stringify(page);
  };
  return { run, calls };
}

const page = (nodes: unknown[], next: string | null = null) => ({ data: { repository: { issues: { nodes,
  pageInfo: { hasNextPage: next !== null, endCursor: next } } } } });

test("#2075 DONE-WHEN 1: an open row with no Project 1 item yields ONE row-off-board order for product-manager naming it", () => {
  const orders = rowOffBoardOrders([boardFacts(2068, false), boardFacts(2028, true)], NOW_MS);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].session, "product-manager");
  assert.equal(orders[0].cause, "row-off-board");
  assert.match(orders[0].prompt, /#2068 row 2068/);
  assert.doesNotMatch(orders[0].prompt, /#2028/, "the boarded row is not named: the order is about the absent one");
  assert.match(orders[0].prompt, /DOES NOT BOARD THE ROW FOR YOU/, "it reports; the Status is a judgment and is not made here");
});

test("#2075 DONE-WHEN 2 (the half that matters): a board where every open row is boarded emits NO order", () => {
  assert.deepEqual(rowOffBoardOrders([boardFacts(1, true), boardFacts(2, true)], NOW_MS), []);
  assert.deepEqual(rowOffBoardOrders([], NOW_MS), [], "an empty tracker is not a finding either");
  assert.deepEqual(rowOffBoardOrders(null, NOW_MS), [], "could not ask is silence, and the tick says so on stderr");
  assert.deepEqual(rowOffBoardOrders(undefined, NOW_MS), [], "not asked at all is silence too");
  // The positive control for the emptiness above: the SAME inputs with one row unboarded DO order.
  assert.equal(rowOffBoardOrders([boardFacts(1, true), boardFacts(2, false)], NOW_MS).length, 1);
});

test("#2075 DONE-WHEN 3 (freshness): a row on the board that was added seconds ago is NOT reported, and neither is a row too young to have been boarded", () => {
  // The read is PER ISSUE, so the lag of the board listing cannot reach it: this pins that by asserting what is asked.
  const { run, calls } = graphqlPages([page([issueNode(2075, [1], { createdAt: "2026-09-26T11:59:30Z" })])]);
  const facts = readRowsOffBoard(run);
  assert.deepEqual(rowsOffBoard(facts!, NOW_MS), [], "the issue's own projectItems says it is on Project 1");
  assert.ok(calls.every((argv) => argv[0] === "api" && argv[1] === "graphql" && !argv.join(" ").includes("item-list")),
    "the board LISTING, which lagged ~4 minutes behind an add, is never read");
  // And the window in which row-file is between `gh issue create` and the board: the grace.
  const young = boardFacts(2100, false, ROW_OFF_BOARD_GRACE_MS - 1);
  assert.deepEqual(rowsOffBoard([young], NOW_MS), [], "younger than the grace: row-file may still be about to add it");
  assert.deepEqual(rowsOffBoard([{ ...young, createdMs: NOW_MS - ROW_OFF_BOARD_GRACE_MS }], NOW_MS).map((r) => r.number), [2100],
    "POSITIVE CONTROL: at the grace it is reported, so the filter is a boundary and not a blanket");
});

test("#2075: the causeKey names the SET -- it changes when the set changes and does not when it does not", () => {
  const key = (rows: [number, boolean][]) => rowOffBoardOrders(rows.map(([n, on]) => boardFacts(n, on)), NOW_MS)[0]?.causeKey;
  assert.equal(key([[2068, false], [2070, false]]), "product-manager/row-off-board/2068.2070");
  assert.equal(key([[2070, false], [2068, false]]), key([[2068, false], [2070, false]]), "order of the read does not mint a new key");
  assert.equal(key([[2068, false], [2070, false], [9, true]]), key([[2068, false], [2070, false]]),
    "boarded rows joining or leaving the population do not change it");
  assert.notEqual(key([[2068, false], [2070, false]]), key([[2068, false]]), "a row boarded leaves the set: a new question");
  assert.notEqual(key([[2068, false], [2070, false]]), key([[2068, false], [2071, false]]),
    "same size, different rows: a count would collide (#1799)");
});

test("#2075: a row whose membership could not be told is neither reported off the board nor counted boarded", () => {
  assert.deepEqual(rowsOffBoard([boardFacts(7, null)], NOW_MS), []);
  // Read through the shipped reader: ten items, none of them Project 1, page shows fewer than its own total.
  const truncated = issueNode(8, [5, 6], { totalCount: 11 });
  const [f] = readRowsOffBoard(graphqlPages([page([truncated])]).run)!;
  assert.equal(f.onBoard, null, "a partial item list is not proof of absence");
});

test("#2075: readRowsOffBoard reads membership of PROJECT 1 specifically, across pages", () => {
  const { run, calls } = graphqlPages([
    page([issueNode(1, [1]), issueNode(2, [])], "cursor-1"),
    page([issueNode(3, [2]), issueNode(4, [2, 1])]),
  ]);
  const facts = readRowsOffBoard(run)!;
  assert.deepEqual(facts.map((f) => [f.number, f.onBoard]), [[1, true], [2, false], [3, false], [4, true]],
    "an item on some OTHER project (3) is not an item on Project 1");
  assert.equal(calls.length, 2);
  assert.ok(!calls[0].join(" ").includes("after="), "the first page has no cursor");
  assert.ok(calls[1].includes("after=cursor-1"), "the second page is asked with the first's cursor");
  assert.deepEqual(rowsOffBoard(facts, NOW_MS).map((r) => r.number), [2, 3]);
});

test("#2075: a refused, errored, malformed or never-ending read is `null` -- never an empty board", () => {
  assert.equal(readRowsOffBoard(() => { throw new Error("HTTP 403"); }), null, "gh exited non-zero");
  assert.equal(readRowsOffBoard(() => "not json"), null);
  assert.equal(readRowsOffBoard(() => JSON.stringify({ data: { repository: null } })), null);
  assert.equal(readRowsOffBoard(() => JSON.stringify({ ...page([issueNode(1, [1])]), errors: [{ message: "boom" }] })), null,
    "errors beside data is refused before data is trusted (#555)");
  const forever = () => JSON.stringify(page([issueNode(1, [1])], "more"));
  assert.equal(readRowsOffBoard(forever), null, "a list still paging at the cap is not a whole list");
  // The control: a healthy single page is an array, so `null` above is the refusal and not the shape.
  assert.ok(Array.isArray(readRowsOffBoard(graphqlPages([page([issueNode(1, [1])])]).run)));
});

test("#2075: rowsOffBoardOrSay says on stderr when it could not ask, and is silent when it did", () => {
  const lines: string[] = [];
  // `rowsOffBoardOrSay` runs the real `gh`; a bare token-less host refuses it, so pin the SAY on both branches through the log.
  const said = rowsOffBoardOrSay((line: string) => lines.push(line));
  if (said === null) assert.match(lines.join(""), /CANNOT ASK which open rows are off Project 1.*not a clean board/);
  else assert.deepEqual(lines, [], "a read that answered says nothing");
});

test("#2075: row-off-board is a JUDGMENT cause and FINISH, and `decide` emits it from `offBoard` and from nothing else", () => {
  assert.ok(CAUSES.includes("row-off-board"));
  assert.ok(JUDGMENT_CAUSES.includes("row-off-board"), "its answer is durable: an unchanged set is not re-asked on the action expiry");
  assert.ok(!START_CAUSES.includes("row-off-board"), "boarding takes on no work");
  const base = { prs: [], readyRows: [] };
  const causes = (state: object) => (decide({ ...base, ...state }) as { cause: string }[]).map((o) => o.cause);
  // `decide` reads the real clock, so the row's age is taken from it rather than from the fixed NOW_MS above.
  const old = { ...boardFacts(2068, false), createdMs: Date.now() - 60 * MINUTE_MS };
  assert.deepEqual(causes({ offBoard: [old] }), ["row-off-board"]);
  assert.deepEqual(causes({}), [], "a caller that did not ask emits nothing");
  assert.deepEqual(causes({ offBoard: null }), [], "a caller whose read was refused emits nothing");
  assert.deepEqual(causes({ offBoard: [old], drain: true }), ["row-off-board"], "a drain does not withhold it");
});

// --- #2791: a Ready row the claim refuses for a template defect is not stock -------------------------------

/**
 * #2729 and #2730 read `ready` for ~38h with no `## Open-check`, and `row-claim` refused both
 * (`NOT CLAIMED: ... is missing Open-check`). The pool counted them, so `ready-queue-empty` never fired and
 * every engineer waited on a queue with nothing takeable. `missingTemplateFields` is the rule the claim
 * applies, imported unchanged -- so the gate and the claim cannot disagree about what is claimable.
 */
const NO_OPEN_CHECK = "## Region\n\nx.mjs\n\n## Acceptance\n\nnpm test\n";
const BACKLOG = [{ number: 800, labels: [{ name: "backlog" }] }];
const shelfCauses = (orders: { cause: string }[]) => orders.map((o) => o.cause).sort();

test("#2791: two unclaimable Ready rows and a promotable backlog -- ready-queue-empty FIRES; completed, it does not", () => {
  const incomplete = [readyRow(2729, { body: NO_OPEN_CHECK }), readyRow(2730, { body: "" })];
  const orders = decide({ prs: [], readyRows: incomplete, promotableRows: BACKLOG, prFiles: [] });
  // THE POSITIVE FIRST: the only thing that changed against the control below is the body.
  const [shelf] = orders.filter((o: { cause: string }) => o.cause === "ready-queue-empty");
  assert.ok(shelf, "the pool has nothing an engineer can claim, so product-manager is asked to promote");
  assert.match(shelf.prompt, /#2729: its body has no `## Open-check`/);
  assert.match(shelf.prompt, /#2730: its body has no `## Region`, `## Acceptance`, `## Open-check`/);
  assert.equal(orders.filter((o: { cause: string }) => o.cause === "ready-row-unclaimed").length, 0,
    "and neither is offered: that order ends in a refused claim");
  const complete = incomplete.map((r) => ({ ...r, body: COMPLETE_BODY }));
  const control = decide({ prs: [], readyRows: complete, promotableRows: BACKLOG, prFiles: [] });
  assert.deepEqual(shelfCauses(control), ["ready-row-unclaimed", "ready-row-unclaimed"],
    "the same rows with the sections present are offered and the shelf is not empty");
});

test("#2791: it is not silent -- one order per row naming the missing sections, keyed so it stops when they are added", () => {
  const rows = [readyRow(2730, { body: "" }), readyRow(2729, { body: NO_OPEN_CHECK })];
  const orders = decide({ prs: [], readyRows: rows }).filter((o: { cause: string }) => o.cause === "ready-row-incomplete");
  assert.deepEqual(orders.map((o: { subject: string }) => o.subject), ["row-2729", "row-2730"], "oldest first");
  assert.ok(orders.every((o: { session: string }) => o.session === "product-manager"));
  assert.match(orders[0].prompt, /no `## Open-check`/);
  assert.doesNotMatch(orders[0].prompt, /`## Region`|`## Acceptance`/, "only what is MISSING is named");
  assert.equal(orders[0].discriminator, "Open-check");
  assert.match(orders[1].causeKey, /row-2730\/Region\+Acceptance\+Open-check$/);
  // THE ROW IS THE STATE: completing it removes the order, and a different gap is a different key.
  assert.deepEqual(decide({ prs: [], readyRows: [readyRow(2729, { body: COMPLETE_BODY })] })
    .filter((o: { cause: string }) => o.cause === "ready-row-incomplete"), []);
  const other = decide({ prs: [], readyRows: [readyRow(2729, { body: "## Region\n\nx\n\n## Open-check\n\ny\n" })] })
    .filter((o: { cause: string }) => o.cause === "ready-row-incomplete");
  assert.notEqual(other[0].causeKey, orders[0].causeKey);
});

test("#2791: the shelved row is SHELVED with its reason, and a row whose body was never read is left alone", () => {
  const { offerable, blocked } = partitionUnclaimed([readyRow(2729, { body: NO_OPEN_CHECK }), readyRow(2731)], [], {});
  assert.deepEqual(offerable.map((r: { number: number }) => r.number), [2731],
    "no `body` key is 'not asked', never 'asked and empty' -- otherwise every body-less caller shelves its whole queue");
  assert.equal(blocked.length, 1);
  assert.match(blocked[0].reason, /no `## Open-check` -- `row-claim` refuses it/);
  const claimed = readyRow(2732, { body: "", labels: [{ name: "ready" }, { name: "in-progress" }] });
  assert.deepEqual(decide({ prs: [], readyRows: [claimed] }).filter((o: { cause: string }) => o.cause === "ready-row-incomplete"), [],
    "a held row is its holder's, and the claim it went through already required the sections");
});

test("#2791: readReadyRows asks for `body`, so the gate reads the same field the claim does", () => {
  const calls: string[][] = [];
  readReadyRows((args: string[]) => { calls.push(args); return "[]"; });
  assert.ok(String(calls[0][calls[0].indexOf("--json") + 1]).split(",").includes("body"));
});

// ---- #2823: THE REPO-WIDE CLOSES CONDITION IS A GATE CAUSE ----

const CLOSES_NOW = Date.parse("2026-09-30T13:00:00Z");
/** An open PR declaring `Closes #<n+1000>`; `resolved` is what GitHub answered (`null` = the field was not read). */
function closesPr(n: number, resolved: number[] | null, body = `Closes #${n + 1000}`) {
  return { ...draft(n, GREEN), body, createdAt: "2026-09-30T10:00:00Z",
    ...(resolved === null ? {} : { closingIssuesReferences: resolved.map((number) => ({ number })) }) };
}
const FOUR_UNRESOLVED = [closesPr(1, []), closesPr(2, []), closesPr(3, []), closesPr(4, [])];

test("#2823: four open PRs declaring a Closes that GitHub resolved nothing for wake `product-manager` ONCE, with the answer", () => {
  const orders = closesUnresolvedOrders(FOUR_UNRESOLVED, CLOSES_NOW);
  assert.equal(orders.length, 1, "one order for the condition, not one per pull request");
  const [order] = orders;
  assert.equal(order.session, "product-manager");
  assert.equal(order.cause, "closes-unresolved-repo-wide");
  assert.ok(CAUSES.includes(order.cause) && JUDGMENT_CAUSES.includes(order.cause) && !START_CAUSES.includes(order.cause));
  for (const n of [1, 2, 3, 4]) assert.ok(order.prompt.includes(`#${n}`), `the order names #${n}`);
  assert.match(order.prompt, /oldest open 3h/, "and says how long the condition has stood");
  assert.equal(order.causeKey, "product-manager/closes-unresolved-repo-wide/1+2+3+4", "keyed on the SET of pull requests");
  assert.deepEqual(closesUnresolvedOrders([...FOUR_UNRESOLVED].reverse(), CLOSES_NOW)[0].causeKey, order.causeKey,
    "and the read order does not change the key");
  assert.deepEqual(decide({ prs: FOUR_UNRESOLVED, readyRows: [] }).filter((o) => o.cause === order.cause).length, 1,
    "`decide` emits it -- a builder nobody calls wakes nobody");
});

test("#2823: the order clears when ANY of them resolves, and is silent on every non-repo-wide shape", () => {
  const key = (prs: unknown[]) => closesUnresolvedOrders(prs, CLOSES_NOW).map((o) => o.causeKey);
  assert.deepEqual(key([closesPr(1, []), closesPr(2, []), closesPr(3, []), closesPr(4, [999])]), [],
    "the newest PR resolved -- GitHub is resolving, so it is not repo-wide");
  assert.deepEqual(key([closesPr(1, []), closesPr(2, []), closesPr(3, [998]), closesPr(4, [])]), [],
    "a sibling resolved");
  assert.deepEqual(key(FOUR_UNRESOLVED.slice(0, 3)), [], "one under test plus only two siblings is 'cannot say', not a fault");
  assert.deepEqual(key([closesPr(1, []), closesPr(2, []), closesPr(3, []), closesPr(4, [], "Closes: none -- docs")]), [],
    "a PR declaring `none` is no sibling and no subject");
  assert.deepEqual(key(FOUR_UNRESOLVED.map((pr) => closesPr(pr.number, null))), [],
    "an unread `closingIssuesReferences` is not asked, and never reads as 'resolved nothing'");
  assert.deepEqual(closesUnresolvedOrders(null, CLOSES_NOW), [], "a refused PR read has no PRs to name");
  assert.equal(closesUnresolvedPrs(FOUR_UNRESOLVED).length, 4, "the positive control for every emptiness above");
});

test("#2823: a fifth PR changes the key (a new set is a new condition), and a missing createdAt drops only the age", () => {
  const five = [...FOUR_UNRESOLVED, closesPr(5, [])];
  assert.equal(closesUnresolvedOrders(five, CLOSES_NOW)[0].causeKey, "product-manager/closes-unresolved-repo-wide/1+2+3+4+5");
  const undated = FOUR_UNRESOLVED.map((pr) => ({ ...pr, createdAt: undefined }));
  const [order] = closesUnresolvedOrders(undated, CLOSES_NOW);
  assert.ok(order && !order.prompt.includes("oldest open"));
});

test("#2823: readPrs asks for `closingIssuesReferences` and `createdAt`, the two fields the Closes cause reads", () => {
  const calls: string[][] = [];
  readPrs((args: string[]) => { calls.push(args); return "[]"; });
  const fields = String(calls[0][calls[0].indexOf("--json") + 1]).split(",");
  assert.ok(fields.includes("closingIssuesReferences") && fields.includes("createdAt"));
});

// THE SWEEP that used to sit here (every refusal that names a session) moved to `refusal-sweep.test.ts` (#2940): this file's
// import closure needs `history`, which the acceptance job lacks, so a test command naming it is refused.

// --- #2781: a primary that is not at origin/main is a signal, not a journal line -----------------------------------------
//
// POSITIVE CONTROL FOR THE EMPTINESS ASSERTIONS BELOW is the first test: the same reader over a dirty, behind primary, asserted
// to name the paths. Without it, every silence test passes against a `primaryStaleOrders` that returns `[]` for everything.
const PRIMARY_DIRTY_BEHIND = { sha: "a5f407d4f0000000", originSha: "9c6ab24630000000", behind: 41, ahead: 0,
  dirty: ["packages/lab/src/capture-screenreader-dataset.mjs", "packages/lab/src/packaging/wake-by-hand.test.ts"] };
const PRIMARY_CURRENT = { sha: "9c6ab24630000000", originSha: "9c6ab24630000000", behind: 0, ahead: 0, dirty: [] };

test("#2781 POSITIVE CONTROL: a dirty, behind primary wakes ceo naming the dirty paths, the shas and the distance", () => {
  const orders = primaryStaleOrders(PRIMARY_DIRTY_BEHIND);
  assert.equal(orders.length, 1);
  const [order] = orders;
  assert.equal(order.session, "ceo", "ceo owns the primary (.github/CLAUDE.md)");
  assert.equal(order.cause, "primary-stale");
  assert.match(order.prompt, /capture-screenreader-dataset\.mjs/);
  assert.match(order.prompt, /wake-by-hand\.test\.ts/);
  assert.match(order.prompt, /41 commit\(s\) behind/);
  assert.match(order.prompt, /a5f407d4f/);
  assert.match(order.prompt, /9c6ab2463/);
  assert.match(order.prompt, /salvage/, "the edits are someone's work: save before clearing");
});

test("#2781 done-when 4: a DIRTY primary already AT origin/main is reported the tick the edit appears, before any update fails", () => {
  const [order] = primaryStaleOrders({ ...PRIMARY_CURRENT, dirty: ["package.json"] });
  assert.ok(order, "dirty alone is enough");
  assert.match(order.prompt, /package\.json/);
  assert.match(order.prompt, /0 commit\(s\) behind/);
});

test("#2781: a BEHIND primary that is clean is still a signal, and says to read the update's own output", () => {
  const [order] = primaryStaleOrders({ ...PRIMARY_CURRENT, sha: "1111111110000000", behind: 3 });
  assert.match(order.prompt, /No tracked path is dirty/);
  assert.match(order.prompt, /3 commit\(s\) behind/);
});

test("#2781: a primary CARRYING commits origin lacks is a signal too", () => {
  const [order] = primaryStaleOrders({ ...PRIMARY_CURRENT, sha: "2222222220000000", ahead: 2 });
  assert.match(order.prompt, /carrying 2 commit\(s\) origin lacks/);
});

test("#2781: a current primary, and an UNASKABLE one, emit nothing -- two different claims, asserted apart", () => {
  assert.deepEqual(primaryStaleOrders(PRIMARY_CURRENT), [], "looked at, and current");
  assert.deepEqual(primaryStaleOrders(null), [], "not asked (a linked worktree, CI): never a false alarm");
  assert.deepEqual(primaryStaleOrders(undefined), [], "omitted is the same claim as null");
});

test("#2781: the causeKey is stable while nothing changes and new when a merge lands or the dirty set changes", () => {
  const key = primaryStaleOrders(PRIMARY_DIRTY_BEHIND)[0].causeKey;
  assert.equal(primaryStaleOrders({ ...PRIMARY_DIRTY_BEHIND, dirty: [...PRIMARY_DIRTY_BEHIND.dirty].reverse() })[0].causeKey, key,
    "the reader's order is not a new question");
  assert.notEqual(primaryStaleOrders({ ...PRIMARY_DIRTY_BEHIND, originSha: "3333333330000000" })[0].causeKey, key, "another merge");
  assert.notEqual(primaryStaleOrders({ ...PRIMARY_DIRTY_BEHIND, dirty: ["one-more.mjs", ...PRIMARY_DIRTY_BEHIND.dirty] })[0].causeKey, key,
    "another edited file");
});

test("#2781: it is an ACTION cause (re-offered on the expiry), FINISH not START, and decide() routes it only when handed a drift", () => {
  assert.ok(CAUSES.includes("primary-stale"), "or worker-profile refuses it at run time");
  assert.ok(!JUDGMENT_CAUSES.includes("primary-stale"), "a judgment cause is never re-offered; a stale primary must be");
  assert.ok(!START_CAUSES.includes("primary-stale"), "a drain must not withhold it");
  assert.ok(decide({ prs: [], readyRows: [], primaryDrift: PRIMARY_DIRTY_BEHIND }).some((o) => o.cause === "primary-stale"));
  assert.deepEqual(decide({ prs: [], readyRows: [] }).filter((o) => o.cause === "primary-stale"), [], "not asked -> no order");
  assert.deepEqual(decide({ prs: [], readyRows: [], primaryDrift: PRIMARY_CURRENT }).filter((o) => o.cause === "primary-stale"), []);
});

test("#2781 done-when 2: every other order is headed with the stale sha and the count; the current primary's orders are untouched", () => {
  const orders = [{ cause: "host-units-stale", prompt: "run host:install" }, { cause: "primary-stale", prompt: "own text" }];
  const [other, own] = withStalePrimaryNotice(orders, PRIMARY_DIRTY_BEHIND);
  assert.match(other.prompt, /^\[THIS GATE IS RUNNING FROM A STALE PRIMARY: a5f407d4f, 41 commit\(s\) behind origin\/main 9c6ab2463/);
  assert.match(other.prompt, /run host:install$/, "the original text follows, unchanged");
  assert.equal(own.prompt, "own text", "primary-stale already says it");
  assert.deepEqual(withStalePrimaryNotice(orders, PRIMARY_CURRENT), orders, "current: not one byte changed");
  assert.deepEqual(withStalePrimaryNotice(orders, null), orders, "not asked: not one byte changed");
  assert.deepEqual(withStalePrimaryNotice(orders, { ...PRIMARY_CURRENT, dirty: ["x"] }), orders,
    "dirty but AT origin/main: the orders ARE current, so they are not bannered");
});

test("#2781 the tick READS the primary and WIRES it: main() reads it once, feeds decide, and banners the decided orders", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../work-gate.mjs"), "utf8");
  assert.match(source, /primaryDrift = readPrimaryDriftNow\(\)/);
  // #2849: the argument object is NAMED so the shadow tap can record it, and `decide` is reached through `decideAndTap`.
  assert.match(source, /const decideArgs = \{ primaryDrift,/);
  assert.match(source, /withStalePrimaryNotice\(decideAndTap\(decideArgs\), primaryDrift\)/, "the SAME reading banners the orders");
  assert.match(source, /const orders = decide\(args\);/, "and `decideAndTap` still calls `decide` with the object it was given");
});
