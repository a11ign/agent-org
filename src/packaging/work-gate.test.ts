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
import { decide, checksSettledGreen, readPrs, readReadyRows, EXIT, CAUSES }
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
  assert.equal(orders.length, 1, "`ready` WITHOUT `in-progress` is the unclaimed set");
  assert.equal(orders[0].subject, "rows-20", "the claimed row is excluded");

  // NO SESSION IS NAMED, deliberately: which engineer takes it depends on who is idle at that instant,
  // which only `herdr agent list`'s `agent_status` knows. A gate that picked would be guessing.
  assert.equal(orders[0].session, "engineers");

  // POSITIVE CONTROL for the emptiness assertion above: an empty Ready set is genuinely quiet.
  assert.deepEqual(decide({ prs: [], readyRows: [] }), []);
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
