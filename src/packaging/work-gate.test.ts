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
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { shippedUnits } from "../host-units.mjs";
import { MAX_ROW_ORDERS_PER_TICK, decide, checksSettledGreen, readPrs, readReadyRows, EXIT, CAUSES,
  comparablePrFiles, START_CAUSES, draining, DRAIN_MARKER, stalledOrder, performActions,
  blockingChecks, anyChecksRed, requiredCheckNames, ownerOf, NOT_PICKABLE, NOT_STARTABLE,
  ROUTED_TO, readPromotableRows, GH_READS, partitionUnclaimed, openRowState, waitingBreakdown,
  deadMansSwitch,
  unfiledEpics, epicOrders, finishedEpics, finishedEpicOrders, fleetBatchRows, fleetBatchOrders,
  partitionFleetBatch, blockerClearedOrders,
  FLEET_MILESTONE, readEpics, answersOwed, answerOrders,
  readOpenRows, withAnswerLabel,
  blockedWithoutReferent, blockedReferentOrders, CHAIRMAN_LABEL,
  ANSWER_PREFIX, redOnlyBySupersededRun, cannotAskReport }
  from "../work-gate.mjs";

// Each check carries a NAME because the caller narrows with newestPerName, which keys on it -- a fixture
// without one is dropped, and the gate would read every PR as having no checks at all.
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
  assert.deepEqual(orders.map((o) => o.session), ["reviewer", "reviewer-2"],
    "odd PR numbers go to `reviewer` and even to `reviewer-2` -- agent-practices.md's own split");
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

  // A NON-DRAFT IS ALREADY ARMED -- `reviewer.md` skips it, so the gate must not raise it.
  assert.equal(decide({ prs: [{ ...draft(11, GREEN), isDraft: false }], readyRows: [] }).length, 0);
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

test("#2001: a NOT CONVINCED verdict on a PR naming no session is unchanged", () => {
  // THE NEGATIVE CONTROL, and not a formality: with no label there is nobody to route to, and both the
  // lookup and the decision are genuinely product-manager's. The prompt is pinned WORD FOR WORD because
  // "unchanged" is the claim -- a branch that quietly rewrote this one would pass a looser assertion.
  const refused = [{ body: "Review of #13 at `abc12345`, by `reviewer`: not convinced." }];
  const [order] = decide({ prs: [draft(13, GREEN, refused)], readyRows: [] }) as { session: string,
    causeKey: string, prompt: string }[];
  assert.equal(order.session, "product-manager");
  assert.equal(order.causeKey, "product-manager/verdict-not-convinced/pr-13/abc12345");
  assert.equal(order.prompt, "#13 at `abc12345` carries a NOT CONVINCED verdict from reviewer and "
    + "nothing has moved since. Read the verdict, decide whether it stands, and route the rework to the "
    + "session holding that row -- or close the PR if the row was wrong. A refused verdict nobody "
    + "answers is a pull request that never lands.");
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
  assert.equal(decide(state)[0].causeKey, "reviewer/draft-awaiting-verdict/pr-1/abc12345");
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

test("an unlabelled red pull request falls back to product-manager rather than being dropped", () => {
  const pr = { ...draft(52, RED), isDraft: false, labels: [] };
  assert.deepEqual(decide({ prs: [pr], readyRows: [] })
    .map((o: { session: string }) => o.session), ["product-manager"]);
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

const blockedRow = (n: number, daysAgo: number) =>
  ({ number: n, title: `row ${n}`, updatedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString() });

/**
 * #63 sat four days with eight publish-gated rows behind it. `ceo` escalated correctly and
 * `product-manager` reported it in every sweep; nothing carried it onward, so it surfaced only because
 * the chairman happened to read a sweep in a terminal.
 */
test("rows waiting on the chairman wake CEO, the only session that briefs one", () => {
  const orders = decide({ prs: [], readyRows: [], chairmanBlocked: [blockedRow(63, 4)] });
  assert.deepEqual(orders.map((o: { cause: string; session: string }) => [o.cause, o.session]),
    [["chairman-blocked", "ceo"]]);
  assert.match(orders[0].prompt, /4 day\(s\)/);
  assert.match(orders[0].prompt, /#63/);
  // `updatedAt` is LAST ACTIVITY, not time waiting: labelling #63 reset it to 0 the first time this ran.
  // The prompt must not let a reader mistake one for the other.
  assert.match(orders[0].prompt, /not time spent waiting/);
});

test("the discriminator is the AGE, so ceo is reminded once a DAY and the reminder grows", () => {
  const today = decide({ prs: [], readyRows: [], chairmanBlocked: [blockedRow(63, 4)] })[0];
  const tomorrow = decide({ prs: [], readyRows: [], chairmanBlocked: [blockedRow(63, 5)] })[0];
  assert.notEqual(today.causeKey, tomorrow.causeKey, "a day older is a new question");
  const again = decide({ prs: [], readyRows: [], chairmanBlocked: [blockedRow(63, 4)] })[0];
  assert.equal(today.causeKey, again.causeKey,
    "and the same day is the same question, or ceo is re-briefed every twenty minutes for days");
});

test("the AGE is the OLDEST row's, since the list arrives oldest first", () => {
  const orders = decide({ prs: [], readyRows: [],
    chairmanBlocked: [blockedRow(63, 9), blockedRow(64, 1)] });
  assert.match(orders[0].prompt, /9 day\(s\)/, "reporting the newest would understate the stall");
  assert.match(orders[0].prompt, /2 row\(s\)/);
});

test("nothing waiting on the chairman wakes nobody", () => {
  assert.deepEqual(decide({ prs: [], readyRows: [], chairmanBlocked: [] }), []);
});

test("the order tells ceo to CLEAR a stale label, or the count stops meaning anything", () => {
  const [order] = decide({ prs: [], readyRows: [], chairmanBlocked: [blockedRow(63, 4)] });
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
  ({ number: n, body: `## Region\n\n- \`${region}\`\n\n## Acceptance\n\nnone\n`,
    labels: [{ name: "ready" }, ...extra.map((e) => ({ name: e }))] });

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
  [{ number: 9, changedFiles: 2, files: ["a.ts", "b.ts"], closes: [] }]);
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
  const orders = decide({ prs: [], readyRows: [regionRow(2076, ".claude/rules/agent-practices.md")],
    prFiles: [prClosingRow(2077, [2076], ".claude/rules/agent-practices.md")] });
  assert.deepEqual(orders.map((o: { subject: string }) => o.subject), ["row-2076"],
    "a row and its own pull request are one piece of work, and one piece of work cannot collide with itself");
});

test("#2101 NEGATIVE: the same row is still SHELVED behind a PR declaring another row, and behind one " +
  "declaring nothing -- B4 stays unconditional about two SESSIONS in one file", () => {
  const row = regionRow(2076, ".claude/rules/agent-practices.md");
  const other = decide({ prs: [], readyRows: [row],
    prFiles: [prClosingRow(2077, [2084], ".claude/rules/agent-practices.md")] });
  assert.deepEqual(other.filter((o: { cause: string }) => o.cause === "ready-row-unclaimed"), []);
  const undeclared = decide({ prs: [], readyRows: [row],
    prFiles: [prTouching(2077, ".claude/rules/agent-practices.md")] });
  assert.deepEqual(undeclared.filter((o: { cause: string }) => o.cause === "ready-row-unclaimed"), []);
});

test("#2101 the shelving REPORT names the same two, and stops naming the row's own PR", () => {
  const row = regionRow(2076, ".claude/rules/agent-practices.md");
  assert.deepEqual(partitionUnclaimed([row],
    [prClosingRow(2077, [2076], ".claude/rules/agent-practices.md")]).blocked, [],
  "a row withheld with no session able to unblock it is the deadlock itself");
  const [withheld] = partitionUnclaimed([row],
    [prTouching(2077, ".claude/rules/agent-practices.md")]).blocked;
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
  const orders = decide({ prs: [], readyRows: [], chairmanBlocked: [blockedRow(63, 4)], drain: true });
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
      "lane-backlog-unpromoted", "org-stalled", "ready-queue-empty", "ready-row-unclaimed"]);
  // #1969: `pr-green-unarmed` is FINISH. A drain stops the org TAKING ON work and must not stop it
  // finishing what is in flight -- and a green, unheld, unarmed pull request is the most finished work
  // there is. Withholding it during a window would strand exactly the PRs the window is waiting to land.
  assert.deepEqual(finish, ["answer-owed", "blocker-cleared", "chairman-blocked", "draft-awaiting-verdict",
    "draft-convinced-not-ready", "pr-checks-failing", "pr-green-unarmed", "verdict-not-convinced"]);
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

test("the expensive question is asked only when something is red", () => {
  const green = { statusCheckRollup: rollupOf([["gate", "SUCCESS"]]) };
  const red = { statusCheckRollup: rollupOf([["gate", "FAILURE"]]) };
  const pending = { statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status: "IN_PROGRESS" }] };
  assert.equal(anyChecksRed([green, pending]), false, "a healthy tick never pays the fourth call");
  assert.equal(anyChecksRed([green, red]), true);
  assert.equal(anyChecksRed([]), false);
});

test("requiredCheckNames fails OPEN on every unusable answer", () => {
  assert.deepEqual(requiredCheckNames(() => JSON.stringify(["gate"])), ["gate"]);
  assert.equal(requiredCheckNames(() => { throw new Error("HTTP 404"); }), null,
    "a repo with no branch protection must not read as 'nothing blocks a merge'");
  assert.equal(requiredCheckNames(() => "[]"), null, "an EMPTY required set is treated as unreadable");
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
 * THE TEST DRIVES THE THROWING CASE AND ASSERTS BOTH HALVES, because `null` alone is what the old code
 * already did. Only the report is new, and a test that checked the `null` would pass against the defect.
 *
 * AND #2022'S RULING IS THE SECOND HALF: a 404 from `branches/main/protection` means FORBIDDEN or ABSENT,
 * and reading it as "unprotected" is never allowed. `branches/main.protected` is the discriminator, so
 * all three of its answers are pinned here -- including the one where it too is refused, which must say
 * CANNOT TELL rather than pick a side.
 */
const requiredWithLog = (run: (args: string[]) => string) => {
  const lines: string[] = [];
  const calls: string[][] = [];
  const required = requiredCheckNames((args: string[]) => { calls.push(args); return run(args); },
    (line) => { lines.push(line); });
  return { required, lines, calls };
};

/** A `gh` that refuses the protection endpoint and answers the discriminator with `protectedFlag`. */
const refusingProtection = (protectedFlag: string | null) => (args: string[]) => {
  if (args.includes("repos/{owner}/{repo}/branches/main/protection")) {
    throw new Error("gh: Not Found (HTTP 404)");
  }
  if (protectedFlag === null) throw new Error("gh: Not Found (HTTP 404)");
  return protectedFlag;
};

test("a refused required-checks read says so, and names the credential it needed -- #2106", () => {
  const forbidden = requiredWithLog(refusingProtection("true"));
  assert.equal(forbidden.required, null,
    "FAIL OPEN IS UNCHANGED: the report is additional, never a substitute for the `null`");
  assert.equal(forbidden.lines.length, 1, "once per tick -- `requiredWhenRed` is the only caller");
  assert.match(forbidden.lines[0], /branches\/main\/protection/,
    "the report names the endpoint, so the reader can run the failing call themselves");
  assert.match(forbidden.lines[0], /FORBIDDEN rather than ABSENT/);
  assert.match(forbidden.lines[0], /permissions\.admin/,
    "and names WHY -- the gate's credential is not an admin, which is the fact that fixes nothing by retrying");
  assert.match(forbidden.lines[0], /#1750/, "and what is lost: the saving, not any red pull request");

  // #2022's OTHER ARM, which must not be guessed: the same 404 with an UNPROTECTED trunk behind it.
  const absent = requiredWithLog(refusingProtection("false"));
  assert.equal(absent.required, null);
  assert.match(absent.lines[0], /genuinely ABSENT/);
  assert.doesNotMatch(absent.lines[0], /FORBIDDEN rather than ABSENT/,
    "a trunk with no protection is not a credential problem, and must not be reported as one");

  // AND THE HONEST THIRD STATE. The discriminator is subject to the same fail-open rule as its caller.
  const cannotTell = requiredWithLog(refusingProtection(null));
  assert.equal(cannotTell.required, null);
  assert.match(cannotTell.lines[0], /CANNOT TELL/,
    "#2022: a 404 that cannot be discriminated is never read as unprotected");
});

test("the new report cannot become tick noise on a healthy gate -- #2106", () => {
  // THE POSITIVE CONTROL, NAMED. Every assertion above is satisfied by a version that reports on every
  // tick, including the successful ones -- which would bury the four-day failure it exists to surface.
  const healthy = requiredWithLog(() => JSON.stringify(["gate"]));
  assert.deepEqual(healthy.required, ["gate"], "the successful read is unchanged");
  assert.deepEqual(healthy.lines, [], "a gate that CAN read the contexts says NOTHING");
  assert.equal(healthy.calls.length, 1,
    "and pays exactly one call -- the discriminator is reached only by a REFUSED read");

  // A REACHABLE ENDPOINT WITH AN UNUSABLE ANSWER IS REPORTED, BUT NOT DIAGNOSED. The call answered, so
  // there is nothing for `branches/main.protected` to discriminate and no second call to pay for.
  const empty = requiredWithLog(() => "[]");
  assert.equal(empty.required, null);
  assert.equal(empty.calls.length, 1, "a malformed answer proves the endpoint was reachable");
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

test("a fleet-gated row belongs to a pool of two now, and reaches BOTH of them -- #1828", () => {
  // ceo's ruling on #1817: `fleet-gated` routes to `orchestrator` AND `worker-capture`, not one name.
  // ONE ORDER PER NAME, not one order naming the pair -- `wake.mjs` routes an order to one session, so
  // a shared order would reach neither reliably.
  const orders = decide({ prs: [], readyRows: [], promotableRows: [gated(914), gated(1296)] });
  const forRow914 = orders.filter((o: { cause: string, subject: string }) =>
    o.cause === "lane-backlog-unpromoted" && o.subject === "row-914");
  assert.deepEqual(forRow914.map((o: { session: string }) => o.session).sort(),
    ["orchestrator", "worker-capture"],
    "#914 -- the row that would AUTOMATE draining the pile -- must reach both pool members");
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
  assert.deepEqual(ownerOf(gated(914)), ["orchestrator", "worker-capture"]);
  assert.equal(ownerOf({ number: 1, labels: [{ name: "backlog" }] }), null, "unlaned is the pool");
  const orders = decide({ prs: [], readyRows: [], promotableRows: [gated(914)] });
  assert.ok(!orders.some((o: { session: string }) => o.session === "product-manager"),
    "a routed row is not an empty shelf being refilled -- the pool's count must not see it");
  assert.ok(!orders.some((o: { session: string }) => !["orchestrator", "worker-capture"].includes(o.session)),
    "and a fleet-gated row's orders never name anyone outside its own two-name pool");
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
  const twice = { number: 1, isDraft: false, headRefOid: "head1234aaaaaaaa", author: { login: "x" },
    labels: [{ name: "session:worker-capture" }], comments: [],
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
  // FIVE since `answer-owed` landed. This pin caught that read within a minute of it being added, which
  // is exactly why it exists: the number it replaced ("two `gh` calls") had been wrong for months
  // because three readers arrived and nobody re-counted.
  assert.equal(GH_READS.unconditional.length, 5,
    "if you add or remove an unconditional read, this number and every comment quoting it move together");
  // #1938 REMOVED THE SILENCE-CONDITIONAL READ ENTIRELY: the dead man's switch now derives its
  // answer from the rows the unconditional read already fetched. The key is GONE rather than empty,
  // so a reader cannot quote a name that no longer exists.
  assert.ok(!("conditionalOnSilence" in GH_READS),
    "nothing is conditional on silence any more -- the second open-rows read was deleted");
  assert.ok(GH_READS.conditionalOnEmptyShelf.includes("readEpics"));
  assert.ok(GH_READS.conditionalOnRed.includes("requiredCheckNames"));
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

const batchRow = (n: number, milestone: string | null = FLEET_MILESTONE) => ({
  number: n,
  labels: [{ name: "fleet-gated" }],
  milestone: milestone === null ? null : { title: milestone },
});

test("#1941: the batch is every open fleet-gated row ON THE MILESTONE, in row order", () => {
  const rows = [batchRow(1768), batchRow(1042), batchRow(99, "Some other milestone"),
    { number: 5, labels: [{ name: "backlog" }], milestone: { title: FLEET_MILESTONE } }];
  assert.deepEqual(fleetBatchRows(rows).map((r) => r.number), [1042, 1768],
    "milestone-scoped and label-scoped, and SORTED -- an unsorted set would mint a different causeKey "
    + "for the same batch depending on what order GitHub happened to return it in");
  assert.deepEqual(fleetBatchRows([batchRow(1, null)]), [],
    "a row with no milestone is not on this one");
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
  milestone: { title: FLEET_MILESTONE },
  ...extra,
});

const blockedByOpen = { blockedBy: { nodes: [{ number: 1918, state: "OPEN" }] } };
const blockedByClosed = { blockedBy: { nodes: [{ number: 1918, state: "CLOSED" }] } };

test("#2027: an open `blockedBy` edge takes the row out of the fleet batch -- and a closed one puts it back", () => {
  assert.deepEqual(fleetBatchRows([gatedRow(1976, blockedByOpen)], FLEET_MILESTONE, CLOCK), [],
    "#1976 was dispatched and shelved by the same tick; the shelving was the true reading");
  // THE POSITIVE CONTROL, and it is the one that matters: an exclusion test alone passes on a filter that
  // returns nothing at all, which is the defect with the sign flipped.
  assert.deepEqual(
    fleetBatchRows([gatedRow(1976, blockedByClosed)], FLEET_MILESTONE, CLOCK).map((r) => r.number),
    [1976], "a blocker that has CLOSED is a condition that cleared, and the row comes back by itself");
});

test("#2027: a future `Not-before:` takes the row out -- and today's date puts it back", () => {
  const future = gatedRow(1042, { body: "Not-before: 2026-09-30" });
  assert.deepEqual(fleetBatchRows([future], FLEET_MILESTONE, CLOCK), [],
    "#1042 carried exactly this on 2026-09-22 and was dispatched anyway");
  const arrived = gatedRow(1042, { body: `Not-before: ${TODAY}` });
  assert.deepEqual(fleetBatchRows([arrived], FLEET_MILESTONE, CLOCK).map((r) => r.number), [1042],
    "POSITIVE CONTROL: `Not-before:` is not-BEFORE, so the named day itself is runnable");
});

test("#2027: a live `Fleet-hold-until:` takes the row out -- and a lapsed one puts it back", () => {
  // THE FOURTH CONDITION, and the only one this population has. It was declared in
  // `packages/control/src/fleet-playbook.mjs` and therefore unreadable by `waiting-condition.mjs`, which
  // is #2005's defect one field over -- the same reason the fleet batch could not honour its own order.
  const live = gatedRow(1768, { body: "Fleet-hold-until: 2026-09-23T18:00:00Z" });
  assert.deepEqual(fleetBatchRows([live], FLEET_MILESTONE, CLOCK), [],
    "a multi-round same-build sequence owns the fleet until the second it named");
  const lapsed = gatedRow(1768, { body: "Fleet-hold-until: 2026-09-23T06:00:00Z" });
  assert.deepEqual(fleetBatchRows([lapsed], FLEET_MILESTONE, CLOCK).map((r) => r.number), [1768],
    "POSITIVE CONTROL: the hold lapses with no edit to anyone's row, which is the property it was built for");
});

test("#2027: an `answer:<session>` label takes the row out -- and removing it puts the row back", () => {
  const owed = { number: 914, milestone: { title: FLEET_MILESTONE },
    labels: [{ name: "fleet-gated" }, { name: `${ANSWER_PREFIX}product-manager` }] };
  assert.deepEqual(fleetBatchRows([owed], FLEET_MILESTONE, CLOCK), [],
    "#914 is the row that cost 6.5 hours waiting for a ruling -- re-dispatching it is re-asking it");
  assert.deepEqual(fleetBatchRows([gatedRow(914)], FLEET_MILESTONE, CLOCK).map((r) => r.number), [914],
    "POSITIVE CONTROL: removing the label IS the act of answering, and the row returns on that alone");
});

test("#2027: a whole batch that is waiting produces NO ORDER, rather than an order naming it", () => {
  // THE MUTATION THIS SUITE IS FOR: make the new filter return `true` unconditionally -- a filter that
  // excludes nothing -- and this goes red. It is the defect restored exactly.
  const allWaiting = [gatedRow(31, blockedByOpen), gatedRow(1042, { body: "Not-before: 2026-09-30" }),
    gatedRow(1768, { body: "Fleet-hold-until: 2026-09-23T18:00:00Z" })];
  assert.deepEqual(fleetBatchOrders(allWaiting, FLEET_MILESTONE, CLOCK), [],
    "every answer is already recorded in a field; re-reporting them is the treadmill the order's own "
    + "last sentence was written to prevent");
  const [order] = fleetBatchOrders([...allWaiting, gatedRow(1908)], FLEET_MILESTONE, CLOCK);
  assert.equal(order?.causeKey, "orchestrator/fleet-batch-due/1908",
    "POSITIVE CONTROL: the one genuinely runnable row still reaches orchestrator, and alone -- the "
    + "2026-09-22 batch of nine was eight answered rows and this one");
});

test("#2027: a shelved fleet row is REPORTED, never silently dropped", () => {
  const { batch, waiting } = partitionFleetBatch(
    [gatedRow(1976, blockedByOpen), gatedRow(1908)], FLEET_MILESTONE, CLOCK);
  assert.deepEqual(batch.map((r) => r.number), [1908]);
  assert.deepEqual(waiting, [{ number: 1976,
    reason: "blocked by #1918 -- declared on the row, and it clears itself" }],
    "the same sentence the engineer pool's shelvings print, because a row that vanishes silently is the "
    + "failure `blocked` already is");
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

test("#2027: blocker-cleared is a FINISH cause, because a claimed row is work in flight", () => {
  assert.ok(CAUSES.includes("blocker-cleared"), "it must be in CAUSES or worker-profile refuses it at run time");
  assert.ok(!START_CAUSES.includes("blocker-cleared"),
    "a drain finishes work in flight and starts none; withholding this strands exactly the claimed rows a "
    + "transfer window needs landed");
});

test("#2027: decide() routes it, and ahead of the causes that offer new work", () => {
  const orders = decide({ prs: [], readyRows: [],
    openRows: [heldRow(1908, "worker-capture", { ...blockedByClosed })] });
  const causes = orders.map((o) => o.cause);
  assert.ok(causes.includes("blocker-cleared"),
    "the gate could see the row become runnable and, before this, had nobody to tell");
  assert.equal(orders.find((o) => o.cause === "blocker-cleared")?.session, "worker-capture");
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

test("#2003: a refusal on a DEAD pool names the pool and the reset, for ONE call", () => {
  const { calls, run } = recordingRun(refusedWith(DEAD_GRAPHQL));
  const report = cannotAskReport({ run });

  assert.match(report, /CANNOT ASK: neither the pull-request list nor the Ready rows could be read/,
    "the original refusal is unchanged -- this row adds facts to it, it does not replace it");
  assert.match(report, /pool graphql/, "WHICH pool -- core and graphql die separately and reset separately");
  assert.match(report, /resets at 2026-09-23T01:40:11\.000Z/,
    "an ABSOLUTE reset: a reader arriving an hour later cannot use minutes counted when the line was written");
  assert.match(report, /0 remaining of 5000/);
  assert.match(report, /THE POOL IS EXHAUSTED/, "the verdict is stated, not left to be inferred from a 0");

  // DONE-WHEN 2 IS THE BINDING LIMIT, AND THIS IS WHERE IT BITES. A rate-limited response names a user ID
  // and no login, and no second call may be made to improve on that -- so the account is reported
  // UNREADABLE with the ID the response did carry, which is done-when 3's rule applied to the account.
  assert.equal(calls.length, 1,
    "AT MOST ONE extra request on the refusal path -- #2003 done-when 2, and the dead pool is the case "
    + "that tests it, because it is the one where a second call would buy something");
  assert.match(report, /account UNREADABLE \(user ID 328832207\)/,
    "not the login, and not silence: what the refusing response actually carried, marked as not the answer");
  assert.ok(!/account 328832207/.test(report),
    "a user ID must never be printed as though it were the account name -- that is the journal line this "
    + "row was filed to replace");
});

test("#2003: a LIVE pool costs ONE probe and says the pool is not the cause -- the positive control", () => {
  // THE CONTROL THAT MATTERS. Without it, a refusalPoolLine that printed EXHAUSTED unconditionally would
  // satisfy the test above perfectly, and every network blip would be reported to the org as a dead pool.
  const { calls, run } = recordingRun(() => LIVE_GRAPHQL);
  const report = cannotAskReport({ run });

  assert.match(report, /account a11ign-ai-workers/);
  assert.match(report, /1660 used, 3340 remaining of 5000/);
  assert.match(report, /THE POOL IS NOT THE CAUSE/,
    "budget left means the reads were refused by something else, and saying so is the point of the line");
  assert.ok(!report.includes("EXHAUSTED"), "a healthy pool must never be reported as exhausted");
  assert.ok(!report.includes("UNREADABLE"),
    "a live probe answers all three facts from its own body and headers -- nothing is degraded here");
  assert.equal(calls.length, 1, "one probe, the same one the dead-pool case pays -- #2003's done-when 2");
});

test("#2003: an unreadable probe reports UNREADABLE and never invents a pool", () => {
  // DONE-WHEN 3, AND THE OLDEST RULE IN THIS FILE ONE LEVEL DOWN: an instrument that cannot answer must not
  // answer zero. `0 remaining` reads as an exhausted pool, and a reader waits for a reset that is not coming.
  const noResponse = cannotAskReport({ run: () => "" });
  assert.match(noResponse, /account UNREADABLE/);
  assert.match(noResponse, /pool UNREADABLE/);
  assert.match(noResponse, /CANNOT say whether the pool is exhausted or something else refused/);
  assert.ok(!/\bremaining\b/.test(noResponse.replace("pool UNREADABLE", "")),
    "no count may be printed for a pool that was never read");

  // Headers present but unparseable is the same answer, and it is a DIFFERENT failure: a response arrived.
  const garbled = cannotAskReport({ run: () => "HTTP/2.0 200 OK\r\nX-Ratelimit-Resource: graphql\r\n\r\n{}" });
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
  assert.match(refusalBranch, /cannotAskReport\(\{ run: defaultRun \}\)/,
    "the report is built inside the refusal branch; anywhere else and every healthy tick pays for it");
  // The declaration spells the same call shape, so it is excluded by name rather than by counting matches.
  assert.equal(gate.match(/(?<!function )cannotAskReport\(\{/g)?.length, 1,
    "exactly one call site, and it is the one inside the refusal branch asserted above");

  // AND THE READ COUNT IS UNCHANGED, which is the other half of done-when 2: this row adds no
  // unconditional read, and `GH_READS` is the pin that would catch it if it ever did.
  assert.equal(GH_READS.unconditional.length, 5,
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
