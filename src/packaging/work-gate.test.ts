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
import { MAX_ROW_ORDERS_PER_TICK, decide, checksSettledGreen, readPrs, readReadyRows, EXIT, CAUSES }
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
  assert.match(lane.prompt, /Nobody else may promote these/);
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
  assert.match(order.prompt, /not a quota/);
  assert.match(order.prompt, /Promoting nothing and recording\s+why is a valid answer/);
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
