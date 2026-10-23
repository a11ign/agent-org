// no-token: gh -- importing `org-health.ts` reaches `defaultRun`, and this file never lets it run: every read step reads the fake code host's rows, watched so that any effect is caught, and the effect steps are handed a fake `release` or a fake `post`.
/**
 * agent-org#1209: THE READS OF `orgHealthNow`'s readers are separated from their EFFECTS, with no behaviour change. Each reader that interleaved the two is split into a READ step
 * (returns data, performs no effect) and an EFFECT step (consumes that data, performs the effects, in the order the reader always did):
 *
 *   - the stale waits and the hold release  -- `liftableWaits` (read) then `applyHoldLifts` (release, log); `liftResolvedHolds` is the two in order;
 *   - the board truth audit and its post     -- `readBoardTruthAudit` (read: the closed rows, the merged pull requests, the herdr listing, the roadmaps, the epics)
 *     then `postBoardTruth` (effect: the day's table, and the prose findings' labels, inside `postDaysTable`); `boardTruthNow` is the two in order.
 *
 * THE WATCHED CODE HOST is the test's proof (A11-160, step 8: it was a recorded runner answering `gh` argument lists): a read step is run against the fake code host whose rows are watched (`watchedRows`), and it is held to
 * asking only READ operations of it and to leaving the world as it was (every row, comment and label). A read step that performs an effect is therefore caught twice: the operation is in `writes`, and the world changed.
 * The POSITIVE CONTROLS are a reader with an effect, which the watch catches, and the effect step itself, which the same watch catches, so the negatives are not passing because the watch never sees a write.
 *
 * Logging is NOT an effect for this file: the log lines are the same text in the same order before and after the split, and the tests say so where they check them.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { rows } from "../plugins/rows.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow } from "../plugins/fakes/code-host-rows.ts";
import { watchedRows } from "../plugins/fakes/watched-rows.test.support.ts";
import { WAIT_MARKER, waitItemOf, staleWaits } from "../wait-condition.ts";
import { postDaysTable } from "../board-truth-audit.ts";
import { applyHoldLifts, boardTruthNow, liftResolvedHolds, liftableWaits, postBoardTruth, readBoardTruthAudit } from "./org-health.ts";

afterEach(() => forgetActivation());

const HOUR_MS = 3_600_000;
const NOW = Date.parse("2026-10-03T16:00:00Z");
const ISO = (ms: number) => new Date(ms).toISOString();
const REPO = "a11ign/a11ign";

type Fact = { state: "open" | "closed" | "merged"; labels: string[]; resolvedAt: number | null; changedAt: number | null };
const resolved = (state: "closed" | "merged"): Fact => ({ state, labels: [], resolvedAt: NOW - HOUR_MS, changedAt: NOW - HOUR_MS });

const marker = (lines: string) => ({ author: { login: "a11ign-ai-workers" }, createdAt: ISO(NOW - 3 * HOUR_MS), body: `${WAIT_MARKER}\nHeld by \`ceo\`.\n${lines}` });

/** A pull request held by `labels`, declaring `waits` in its hold marker (or none). */
function heldPr(labels: string[], waits: string[], extra: Record<string, unknown> = {}) {
  return { number: 3155, labels: labels.map((name) => ({ name })), body: "", comments: waits.length ? [marker(waits.map((w) => `Waiting-for: ${w}`).join("\n"))] : [],
    updatedAt: ISO(NOW - 2 * HOUR_MS), ...extra };
}

/** What the gate would find stale for `raw`, with `facts` as the referenced items. */
function staleOf(raw: Record<string, unknown>, facts: Record<string, Fact>) {
  return staleWaits({ items: [waitItemOf(raw, "pr")], facts: { items: facts }, now: NOW });
}

// --- the watched code host -----------------------------------------------------------------------------------------------------

/** The operations of the code host's rows that WRITE (a comment, a label, a Discussion, a release): a read step may call none of them. */
const WRITES = new Set(["commentOnIssue", "addLabelToRowByApi", "addLabelToRow", "removeLabelFromRow", "setRowBody", "createDiscussion", "updateDiscussion", "createDraftRelease", "uploadReleaseAsset", "closeRowWithComment", "createRow"]);

/** The fake code host serving the project's tracker with the open row #4001 and the record row #928, watched: `calls` is every operation of its rows that was called, `writes` those that write, and `world()` the rows as they stand. */
function recorder() {
  const host = createFakeCodeHost();
  host.rowsWorld.repo = REPO;
  host.rowsWorld.now = () => NOW;
  host.rowsWorld.rows.set(4001, fakeRow(host.rowsWorld, 4001, { title: "a row", labels: [] }));
  host.rowsWorld.rows.set(928, fakeRow(host.rowsWorld, 928, { title: "The record", labels: ["meta"], createdAt: ISO(NOW - 90 * HOUR_MS), updatedAt: ISO(NOW - 90 * HOUR_MS) }));
  const watched = watchedRows(host);
  substituteCodeHost(watched.host);
  return { calls: watched.calls, writes: () => watched.calls.filter((call) => WRITES.has(call.op)), world: () => JSON.stringify([...host.rowsWorld.rows.values()]), host: watched.host };
}

// --- the lift: the read step names what may be lifted, the effect step releases it ----------------------------------------------

test("the lift's READ STEP performs no release: it names the lifts from the waits alone, and the same reading twice is the same reading", () => {
  const stale = staleOf(heldPr(["hold:ceo"], ["closed #3220"]), { "#3220": resolved("closed") });
  const first = liftableWaits(stale, NOW, new Set([REPO]));
  const second = liftableWaits(stale, NOW, new Set([REPO]));
  assert.deepEqual(first, second, "a read is a function of its inputs, with nothing released between two readings");
  assert.equal(first.lifts.length, 1, "POSITIVE CONTROL: the read names the one hold whose Waiting-for is true");
  assert.equal(first.lifts[0].holders.join(","), "ceo");
  assert.equal(first.remaining.length, 0);
});

test("the read step leaves a stale wait it may not lift in `remaining`, unreleased, as `liftResolvedHolds` always did", () => {
  const stale = staleOf(heldPr(["answer:ceo"], ["closed #3220"]), { "#3220": resolved("closed") });
  const read = liftableWaits(stale, NOW, new Set([REPO]));
  assert.equal(read.lifts.length, 0, "an answer label is the session's to give, so the read names no lift");
  assert.equal(read.remaining.length, 1, "and the wait stays in remaining for a session");
});

test("the effect step releases each held lift once per holder, in the order the read named them, and logs each lift that held", () => {
  const stale = staleOf(heldPr(["hold:ceo", "hold:orchestrator"], ["closed #3220"]), { "#3220": resolved("closed") });
  const { lifts, remaining } = liftableWaits(stale, NOW, new Set([REPO]));
  const asked: [number, string][] = [];
  const said: string[] = [];
  const left = applyHoldLifts({ lifts, remaining }, { release: (n: number, s: string) => { asked.push([n, s]); return true; }, log: (l: string) => said.push(l) });
  assert.deepEqual(asked, [[3155, "ceo"], [3155, "orchestrator"]], "one release per holder, in the holder order the read named");
  assert.equal(said.length, 1, "one line for the one pull request that lifted");
  assert.match(said[0], /^DID lift-hold pr-.* \(ceo, orchestrator\)/);
  assert.deepEqual(left, [], "nothing is left for a session");
});

test("a release that fails keeps its stale wait in `remaining`, after the waits the read never lifted, and logs nothing for it", () => {
  const stale = staleOf(heldPr(["hold:ceo"], ["closed #3220"]), { "#3220": resolved("closed") });
  const { lifts, remaining } = liftableWaits(stale, NOW, new Set([REPO]));
  const said: string[] = [];
  const left = applyHoldLifts({ lifts, remaining }, { release: () => false, log: (l: string) => said.push(l) });
  assert.equal(left.length, 1, "the failed lift is ordered to a session instead");
  assert.deepEqual(said, [], "no lift is logged for a release that did not hold");
});

test("`liftResolvedHolds` is the read step then the effect step, the same calls, the same log and the same return", () => {
  const stale = staleOf(heldPr(["hold:ceo", "answer:ceo"], ["closed #3220"]), { "#3220": resolved("closed") });
  const viaComposed: [number, string][] = [];
  const logComposed: string[] = [];
  const composed = liftResolvedHolds(stale, { now: NOW, release: (n: number, s: string) => { viaComposed.push([n, s]); return true; }, log: (l: string) => logComposed.push(l), declared: new Set([REPO]) });
  const viaSplit: [number, string][] = [];
  const logSplit: string[] = [];
  const { lifts, remaining } = liftableWaits(stale, NOW, new Set([REPO]));
  const split = applyHoldLifts({ lifts, remaining }, { release: (n: number, s: string) => { viaSplit.push([n, s]); return true; }, log: (l: string) => logSplit.push(l) });
  assert.deepEqual(viaComposed, viaSplit);
  assert.deepEqual(logComposed, logSplit);
  assert.deepEqual(composed, split);
});

// --- the board truth: the read step performs no effect, the effect step posts ----------------------------------------------------

const OPEN_ROW = { number: 4001, title: "a row", labels: [], body: "", comments: [], updatedAt: ISO(NOW - HOUR_MS) };
const noRunner = () => assert.fail("the code host's rows are asked, not a runner");

test("the board truth READ STEP performs no effect: the audit is read through a watched code host that records every write", () => {
  const rec = recorder();
  const before = rec.world();
  const audit = readBoardTruthAudit({ openRowsRead: [OPEN_ROW], claimedComments: [], waitFacts: null, now: NOW }, { repo: REPO, run: noRunner, agents: () => [] });
  assert.deepEqual(rec.writes(), [], `no effect was attempted: ${JSON.stringify(rec.writes())}`);
  assert.equal(rec.world(), before, "and the world is as it was");
  assert.ok(rec.calls.length > 0, "the read step did read, so the code host was really exercised");
  assert.ok(Array.isArray(audit.findings) && Array.isArray(audit.unread), "and it returns the audit a post would consume");
});

test("POSITIVE CONTROL: a reader that performs an effect is caught by the watched code host, and the operation is recorded", () => {
  const rec = recorder();
  const before = rec.world();
  const readerWithEffect = () => { rows().commentOnIssue({ repo: REPO, issue: 4001, body: "a post", run: noRunner }); return {}; };
  readerWithEffect();
  assert.deepEqual(rec.writes().map((call) => [call.op, call.request.issue, call.request.body]), [["commentOnIssue", 4001, "a post"]]);
  assert.notEqual(rec.world(), before, "and the world changed");
});

test("POSITIVE CONTROL: the effect step, `postBoardTruth`, is caught by the same watch when it posts the day's table", () => {
  const rec = recorder();
  const audit = readBoardTruthAudit({ openRowsRead: [OPEN_ROW], claimedComments: [], waitFacts: null, now: NOW }, { repo: REPO, run: noRunner, agents: () => [] });
  const logged: string[] = [];
  postBoardTruth({ ...audit, unread: [] }, { now: NOW, repo: REPO, run: noRunner, post: postDaysTable, log: (l: string) => logged.push(l) });
  assert.ok(rec.writes().length > 0, `the day's table was the effect the watch caught: ${logged.join(" | ")}`);
  assert.deepEqual(rec.writes().map((call) => call.op), ["commentOnIssue"], "posted as a comment on the record row");
  assert.match(rec.writes()[0].request.body, /^### Board against reality/);
});

test("`boardTruthNow` is the read step then the effect step: the post receives the very audit it returns, after the reads", () => {
  const rec = recorder();
  const order: string[] = [];
  let posted: { audit: unknown } | null = null;
  let operationsBeforePost = -1;
  const returned = boardTruthNow({ openRowsRead: [OPEN_ROW], claimedComments: [], waitFacts: null, now: NOW }, {
    repo: REPO, run: noRunner, agents: () => [], log: () => {},
    post: (input) => { order.push("post"); operationsBeforePost = rec.calls.length; posted = { audit: input.audit }; return "posted"; },
  });
  assert.equal(posted!.audit, returned, "the post is handed the audit the gate gets back");
  assert.deepEqual(order, ["post"]);
  assert.ok(operationsBeforePost > 0, "the reads were made before the post");
  assert.equal(rec.calls.length, operationsBeforePost, "and nothing was asked of the code host after it");
  assert.deepEqual(rec.writes(), [], "and nothing but reads came before it (the post here is the injected one)");
});
