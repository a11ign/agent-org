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
import { MAX_ROW_ORDERS_PER_TICK, decide, checksSettledGreen, readPrs, readReadyRows, EXIT, CAUSES,
  comparablePrFiles, START_CAUSES, draining, DRAIN_MARKER, stalledOrder, performActions,
  blockingChecks, anyChecksRed, requiredCheckNames, ownerOf, NOT_PICKABLE, NOT_STARTABLE,
  ROUTED_TO, readPromotableRows, GH_READS, partitionUnclaimed, readOpenRowCount,
  unfiledEpics, epicOrders, finishedEpics, finishedEpicOrders, readEpics, answersOwed, answerOrders,
  readOpenRows, withAnswerLabel,
  blockedWithoutReferent, blockedReferentOrders, CHAIRMAN_LABEL,
  ANSWER_PREFIX }
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
  [{ number: 9, changedFiles: 2, files: ["a.ts", "b.ts"] }]);
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
  assert.match(shelf.prompt, /1 unlaned row\(s\) \(#1320\) are B4-blocked/);
  assert.doesNotMatch(shelf.prompt, /belong to a lane/,
    "no row here is laned -- saying so sends product-manager to an owner who has nothing to answer");
  assert.match(shelf.prompt, /NOT rows to promote past/,
    "a blocked row is waiting on a pull request; promoting over the same files just moves the refusal");
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
    ["blocked-unexaminable", "epic-finished", "epic-unfiled", "lane-backlog-unpromoted", "org-stalled",
      "ready-queue-empty", "ready-row-unclaimed"]);
  assert.deepEqual(finish, ["answer-owed", "chairman-blocked", "draft-awaiting-verdict",
    "draft-convinced-not-ready", "pr-checks-failing", "verdict-not-convinced"]);
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
  assert.ok(GH_READS.conditionalOnSilence.includes("readOpenRowCount"));
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
  assert.equal(readOpenRowCount(() => JSON.stringify(allWaiting)), 0,
    "zero REACHABLE rows, so nothing to be stalled about");
  assert.equal(stalledOrder({ orders: [], openRows: 0 }), null);

  // AND THE POSITIVE CONTROL: one row that could move and is not moving still fires the switch.
  const oneReachable = [...allWaiting, { number: 3 }];
  assert.equal(readOpenRowCount(() => JSON.stringify(oneReachable)), 1);
  assert.equal(stalledOrder({ orders: [], openRows: 1 })?.cause, "org-stalled");
});

test("a REFUSED read is still refused, not read as a queue with nothing reachable", () => {
  // `null` means "could not ask" and must never collapse into 0, which would silence the switch on the
  // first API hiccup -- #1286's rule, and the filter added above must not have broken it.
  assert.equal(readOpenRowCount(() => { throw new Error("HTTP 502"); }), null);
  assert.equal(readOpenRowCount(() => "not json"), null);
  assert.equal(stalledOrder({ orders: [], openRows: null }), null);
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
