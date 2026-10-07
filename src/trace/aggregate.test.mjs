// a11ign/a11ign#3513 (slice 6 of #3494): `trace --aggregate`. Fixtures only: nothing here reads `~/.claude`, `~/.cache/a11ign` or GitHub.
// no-token: gh -- every source is an injected fixture; `aggregate` is a pure function and calls no `gh`
//
// TWO WEEKS, so "never pooled" can fail: A (Mon 2026-09-21) holds rows 101 and 102, B (Mon 2026-09-28) holds 201 and 202, and the figures of the two differ. Row 301 is OPEN and
// dear, so an average that lets it in moves a figure the test names. The hand-computed numbers are in the comments beside the assertion that uses them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { aggregate, compareWeeks, DEFINITIONS, MOVES, dearestPhase, nearestRank, NOT_DERIVABLE, NOT_HELD, phaseShares, renderAggregate, weekStart } from "./aggregate.mjs";
import { sandboxGitEnv } from "../lib/git-env.mjs";
import { eventsOfTranscript, PRICES } from "./store.mjs";
import { parseMergePaths, readMergePaths, readMoves } from "./trace.mjs";
import { waterfall } from "./waterfall.mjs";

const ROW_REPO = "a11ign/a11ign";
const at = (iso) => Date.parse(iso);
const WEEK_A = at("2026-09-21T00:00:00Z");
const WEEK_B = at("2026-09-28T00:00:00Z");
const NOW = at("2026-10-06T00:00:00Z");
const HELD_FROM = at("2026-09-21T00:00:00Z"); // the store's first transcripts: the start of week A, so both weeks are complete
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

const SONNET = "claude-sonnet-5-5";
let serial = 0;
const WRITE_1H_FACTOR = 2; // store.mjs's own: a 1-hour cache write costs twice the input rate
/**
 * A turn event in the store's shape. `tokens` is [input, output, cacheRead, cacheWrite1h]; `cost` null is an unpriced turn.
 * A report prices a turn from `PRICES` and ignores the cost on its line (#3638), so a fixture that wants a turn to cost `cost` dollars gives it a model of its own with a flat rate
 * per token, and the line carries the SAME figure (the stored cost agrees with `PRICES`, as one stored at the current price does).
 */
const turn = ({ when, session, row = null, cost, tokens = [1, 1, 1, 0], model, ...rest }) => {
  const weight = tokens[0] + tokens[1] + tokens[2] + tokens[3] * WRITE_1H_FACTOR;
  const own = `fixture-${(serial += 1)}:`;
  if (cost !== null && model === undefined) PRICES.push({ prefix: own, input: cost * 1e6 / weight, output: cost * 1e6 / weight, cacheRead: cost * 1e6 / weight, verified: false });
  return {
    id: `turn:${serial}`, kind: "turn", source: "transcript", at: at(when), session, row, pr: null, repo: null, cause: null, causeKey: null, wakeId: null, model: model ?? (cost === null ? "<synthetic>" : own),
    tokens: { input: tokens[0], output: tokens[1], cacheRead: tokens[2], cacheWrite5m: 0, cacheWrite1h: tokens[3] }, costUsd: cost, wallClockMs: 1000, sidechain: false, ...rest,
  };
};
const wake = (id, when, session, causeKey, extra = {}) => ({
  id, kind: "wake", source: "wake-ledger", at: at(when), session, row: null, pr: null, repo: null, cause: "x", causeKey, wakeId: id, ...extra,
});
const github = (kind, when, extra) => ({
  id: `gh:${(serial += 1)}`, kind, source: "github", at: at(when), session: "github", row: null, pr: null, repo: null, cause: null, causeKey: null, wakeId: null, ...extra,
});
const pull = (number, row, openedIso, mergedIso) => ({ repo: ROW_REPO, number, createdAt: openedIso, mergedAt: mergedIso, body: `Closes #${row}` });

const PULLS = [
  pull(1101, 101, "2026-09-22T08:00:00Z", "2026-09-23T10:00:00Z"), pull(1102, 102, "2026-09-22T09:00:00Z", "2026-09-24T10:00:00Z"),
  pull(1201, 201, "2026-09-29T08:00:00Z", "2026-09-29T14:00:00Z"), pull(1202, 202, "2026-09-30T08:00:00Z", "2026-10-01T15:00:00Z"),
];

const WEEK_A_TURNS = [
  turn({ when: "2026-09-22T10:00:00Z", session: "worker-101", row: 101, cost: 1, tokens: [10, 100, 700, 100] }),
  turn({ when: "2026-09-22T11:00:00Z", session: "worker-101", row: 101, cost: 2, tokens: [10, 50, 800, 0] }),
  turn({ when: "2026-09-23T10:00:00Z", session: "worker-102", row: 102, cost: 5, tokens: [20, 10, 400, 0] }),
  turn({ when: "2026-09-23T11:00:00Z", session: "worker-102", row: 102, cost: null, tokens: [5, 5, 100, 0], model: "<synthetic>" }),
  turn({ when: "2026-09-22T12:00:00Z", session: "ceo", cost: 4, tokens: [10, 10, 900, 0] }),
  turn({ when: "2026-09-22T13:00:00Z", session: "product-manager", cost: 2, tokens: [10, 10, 400, 0] }),
  turn({ when: "2026-09-22T14:00:00Z", session: "unnamed:abc.jsonl", cost: 1, tokens: [10, 10, 100, 0] }),
  turn({ when: "2026-09-22T15:00:00Z", session: "product-manager", cost: 0.5, tokens: [10, 10, 300, 0], touchedRows: [101] }),
];

const WEEK_B_TURNS = [
  turn({ when: "2026-09-29T09:00:00Z", session: "worker-201", row: 201, cost: 9.6, tokens: [10, 10, 10, 0] }),
  turn({ when: "2026-09-29T09:50:00Z", session: "reviewer-1201", pr: 1201, cost: 0.1 }),
  turn({ when: "2026-09-29T11:00:00Z", session: "reviewer-1201", pr: 1201, cost: 0.3 }),
  turn({ when: "2026-10-01T09:00:00Z", session: "worker-202", row: 202, cost: 19.6, tokens: [10, 10, 10, 0] }),
  turn({ when: "2026-10-01T12:00:00Z", session: "worker-202", row: 202, cost: 0.4 }),
  turn({ when: "2026-09-30T10:00:00Z", session: "worker-301", row: 301, cost: 100, tokens: [10, 10, 10, 0] }), // OPEN and dear
  // The standing lead: a wake delivered twice (same key), then a different one, a compaction and the turn that re-reads after it.
  turn({ when: "2026-09-29T08:05:00Z", session: "product-manager", cost: 0.2, wakeId: "wake:pm:1" }),
  turn({ when: "2026-09-29T09:05:00Z", session: "product-manager", cost: 0.5, wakeId: "wake:pm:2" }),
  turn({ when: "2026-09-29T10:05:00Z", session: "product-manager", cost: 0.027, model: SONNET, tokens: [1000, 500, 100000, 0], wakeId: "wake:pm:3" }), // (1000 x 2 + 500 x 10 + 100000 x 0.2) / 1e6, at the real Sonnet rates: its re-read part is priced by `costOf` too
  turn({ when: "2026-09-30T12:05:00Z", session: "ceo", cost: 0.012, model: SONNET, tokens: [500, 100, 50000, 0] }),
];

const EVENTS = [
  ...WEEK_A_TURNS, ...WEEK_B_TURNS,
  github("claimed", "2026-09-22T08:00:00Z", { row: 101, claimant: "worker-101" }), github("claimed", "2026-09-20T09:00:00Z", { row: 102, claimant: "worker-102" }),
  github("claimed", "2026-09-29T08:00:00Z", { row: 201, claimant: "worker-201" }), github("claimed", "2026-09-30T09:00:00Z", { row: 202, claimant: "worker-202" }),
  // wakes: two of worker-101 and one standing wake naming row 101 (the store's alone); worker-102 has two, and wakes-per-row says three
  wake("wake:w101:1", "2026-09-22T09:59:00Z", "worker-101", "worker-101/ready-row-unclaimed/row-101", { row: 101 }),
  wake("wake:w101:2", "2026-09-22T11:59:00Z", "worker-101", "worker-101/blocker-cleared/row-101", { row: 101 }),
  wake("wake:ceo:1", "2026-09-22T12:00:00Z", "ceo", "ceo/row-call-count-signal/101", { row: 101 }),
  wake("wake:w102:1", "2026-09-22T09:59:00Z", "worker-102", "worker-102/ready-row-unclaimed/row-102", { row: 102 }),
  wake("wake:w102:2", "2026-09-23T09:59:00Z", "worker-102", "worker-102/blocker-cleared/row-102", { row: 102 }),
  wake("wake:w201:1", "2026-09-29T07:59:00Z", "worker-201", "worker-201/ready-row-unclaimed/row-201", { row: 201 }),
  wake("wake:w202:1", "2026-09-30T08:59:00Z", "worker-202", "worker-202/ready-row-unclaimed/row-202", { row: 202 }),
  wake("wake:w202:2", "2026-10-01T08:59:00Z", "worker-202", "worker-202/blocker-cleared/row-202", { row: 202 }),
  wake("wake:pm:1", "2026-09-29T08:00:00Z", "product-manager", "product-manager/row-off-board/x"),
  wake("wake:pm:2", "2026-09-29T09:00:00Z", "product-manager", "product-manager/row-off-board/x"),
  wake("wake:pm:3", "2026-09-29T10:00:00Z", "product-manager", "product-manager/claim-report/y"),
  { id: "compaction:ceo:1", kind: "compaction", source: "transcript", at: at("2026-09-30T12:00:00Z"), session: "ceo", row: null, pr: null, repo: null, cause: null, causeKey: null, wakeId: null },
  // a re-review (CHANGES_REQUESTED, then APPROVED, with the reviewer's turn between them), a re-queue (ejected, then queued again, a turn between) and a CI re-run
  github("reviewed", "2026-09-29T10:00:00Z", { pr: 1201, state: "CHANGES_REQUESTED", actor: "reviewer-1201" }), github("reviewed", "2026-09-29T12:00:00Z", { pr: 1201, state: "APPROVED", actor: "reviewer-1201" }),
  github("added_to_merge_queue", "2026-10-01T10:00:00Z", { pr: 1202 }), github("removed_from_merge_queue", "2026-10-01T11:00:00Z", { pr: 1202, outcome: "unmerged" }),
  github("added_to_merge_queue", "2026-10-01T13:00:00Z", { pr: 1202 }),
  github("ci_run", "2026-10-01T09:30:00Z", { pr: 1202, name: "gate", startedAt: at("2026-10-01T09:30:00Z"), completedAt: at("2026-10-01T09:40:00Z") }),
  github("ci_run", "2026-10-01T12:30:00Z", { pr: 1202, name: "gate", startedAt: at("2026-10-01T12:30:00Z"), completedAt: at("2026-10-01T12:45:00Z") }),
];

/** wakes-per-row's reading of each week, as `measure` returns its rows. */
const READINGS = new Map([
  [WEEK_A, [{ row: 101, measured: true, wakes: 2 }, { row: 102, measured: true, wakes: 3 }]],
  [WEEK_B, [{ row: 201, measured: false, unmeasured: "worker-201: a transcript is unreadable" }, { row: 202, measured: true, wakes: 1 }]],
]);

const report = (overrides = {}) => aggregate({
  events: EVENTS, pulls: PULLS, rowRepo: ROW_REPO, now: NOW, since: WEEK_A, held: { from: HELD_FROM, basis: "test fixture" }, readings: READINGS, unreadable: ["/x/broken.jsonl"], openRows: [301], ...overrides,
});
const weekOf = (result, start) => result.weeks.find((week) => week.start === start);

test("WEEKS: Monday 00:00 UTC, and the two weeks of the fixture are the two the test names", () => {
  assert.equal(weekStart(at("2026-09-27T23:59:59Z")), WEEK_A);
  assert.equal(weekStart(at("2026-09-28T00:00:00Z")), WEEK_B);
  assert.deepEqual(report().weeks.map((week) => week.start).slice(0, 2), [WEEK_A, WEEK_B]);
  assert.equal(nearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(nearestRank([], 50), null, "no rows is no figure, not 0");
});

test("PER ROW: p50 and p90 of dollars and tokens, EACH WEEK ITS OWN (positive control: pooled, A's p50 would be 5 and B's 10)", () => {
  const a = weekOf(report(), WEEK_A).perRow;
  const b = weekOf(report(), WEEK_B).perRow;
  // Row 101 = 1 + 2 + 0.5 (the product-manager turn that WROTE to it); row 102 = 5 priced, its other turn unpriced.
  assert.deepEqual([a.dollars.n, a.dollars.p50, a.dollars.p90], [2, 3.5, 5]);
  // Row 201 = 9.6 + 0.1 + 0.3; row 202 = 19.6 + 0.4 (the open row 301's 100 is in neither).
  near(/** @type {number} */ (b.dollars.p50), 10);
  near(/** @type {number} */ (b.dollars.p90), 20);
  // Tokens: row 101 = 910 + 860 + 320; row 102 = 430 + 110.
  assert.deepEqual([a.tokens.p50, a.tokens.p90], [540, 2090]);
  assert.notEqual(a.dollars.p50, b.dollars.p50);
});

test("OPEN ROW: in its own list and in NO average (positive control: row 301 is $100, and p90 of week B is 20, not 100)", () => {
  const result = report();
  assert.deepEqual(result.open.map((row) => [row.row, row.status, row.dollars]), [[301, "open", 100]]);
  assert.deepEqual(result.outside, [], "every other row with turns is merged in the reading");
  // A row GitHub does not call open and the reading did not merge (merged earlier, or closed with no merge) is OUTSIDE, in no average, and not called open.
  const outside = report({ openRows: [] });
  assert.deepEqual([outside.open.length, outside.outside.map((row) => row.row)], [0, [301]]);
  assert.equal(report({ openRows: null }).openKnown, false, "unasked is not 'none are open'");
  for (const week of result.weeks) assert.ok(!week.rows.some((row) => row.row === 301), "an open row is not among the merged rows");
  assert.equal(weekOf(result, WEEK_B).perRow.rows, 2);
  assert.ok(/** @type {number} */ (weekOf(result, WEEK_B).perRow.dollars.p90) < 21);
  // ...but its spend is in the week's spend by turn time, because the dollars were spent.
  assert.ok(weekOf(result, WEEK_B).spend.dollars > 100);
});

test("FLOOR: a row with an unpriced turn is marked and its dollars are the priced part; a row with no priced turn has NO dollar figure", () => {
  const rows = weekOf(report(), WEEK_A).rows;
  const flagged = rows.find((row) => row.row === 102);
  assert.deepEqual([flagged.dollars, flagged.floor, flagged.unpriced], [5, true, 1]);
  assert.equal(rows.find((row) => row.row === 101).floor, false);
  const onlyUnpriced = aggregate({
    events: [turn({ when: "2026-09-22T10:00:00Z", session: "worker-9", row: 9, cost: null, model: "<synthetic>" })], pulls: [pull(1, 9, "2026-09-21T10:00:00Z", "2026-09-23T10:00:00Z")],
    rowRepo: ROW_REPO, now: NOW, since: WEEK_A, held: { from: HELD_FROM, basis: "t" },
  });
  const row9 = weekOf(onlyUnpriced, WEEK_A).rows[0];
  assert.deepEqual([row9.dollars, row9.held, row9.tokens], [null, true, 3]);
  assert.equal(weekOf(onlyUnpriced, WEEK_A).perRow.noPrice, 1);
});

test("NO TURN HELD: a merged row with no turn in the store has no figure (never 0 dollars) and is counted apart", () => {
  const empty = aggregate({ events: [], pulls: [pull(1, 7, "2026-09-21T10:00:00Z", "2026-09-23T10:00:00Z")], rowRepo: ROW_REPO, now: NOW, since: WEEK_A, held: { from: HELD_FROM, basis: "t" } });
  const week = weekOf(empty, WEEK_A);
  assert.deepEqual([week.rows[0].dollars, week.rows[0].tokens, week.perRow.noTurns, week.perRow.dollars.p50], [null, null, 1, null]);
});

test("WALL-CLOCK: first claim to merge, per row; a row with no claim record has none and is counted", () => {
  const a = weekOf(report(), WEEK_A);
  assert.equal(a.rows.find((row) => row.row === 101).wallClockMs, at("2026-09-23T10:00:00Z") - at("2026-09-22T08:00:00Z"));
  const hour = 60 * 60 * 1000;
  assert.deepEqual([a.perRow.wallClock.n, a.perRow.noClaim, a.perRow.wallClock.p50 / hour], [2, 0, 26]);
  const unclaimed = weekOf(report({ events: EVENTS.filter((event) => !(event.kind === "claimed" && event.row === 101)) }), WEEK_A);
  assert.deepEqual([unclaimed.perRow.wallClock.n, unclaimed.perRow.noClaim], [1, 1]);
});

test("OVERHEAD: turns naming no row, with each standing session on its own line; a turn that wrote to a row is on the row", () => {
  const { overhead } = weekOf(report(), WEEK_A).spend;
  // Overhead = ceo 4 + product-manager 2 = 6 of the week's priced 15.5 (1+2+5+4+2+1+0.5), and 1340 of its 4090 tokens (920 + 420).
  assert.equal(overhead.dollars, 6);
  assert.equal(overhead.tokens, 1340);
  near(/** @type {number} */ (overhead.share.dollars), 6 / 15.5);
  near(/** @type {number} */ (overhead.share.tokens), 1340 / 4090);
  assert.deepEqual(overhead.bySession.map((own) => [own.session, own.turns, own.dollars, own.onRows.turns, own.onRows.dollars]), [["ceo", 1, 4, 0, 0], ["product-manager", 1, 2, 1, 0.5]]);
});

test("UNMEASURED: a session no order named, and a transcript that could not be read, are NOT overhead (positive control: the overhead above is 6, not 7)", () => {
  const { spend } = weekOf(report(), WEEK_A);
  assert.deepEqual([spend.unmeasured.turns, spend.unmeasured.dollars], [1, 1]);
  assert.deepEqual(spend.unmeasured.unreadableTranscripts, ["/x/broken.jsonl"]);
  assert.ok(!spend.overhead.bySession.some((own) => own.session.startsWith("unnamed:")));
});

test("CACHE-READ SHARE: cacheRead over the input side, against a hand-computed value", () => {
  // Week A: cacheRead 700+800+400+100+900+400+100+300 = 3700; input side (input + cacheRead + cacheWrite) 810+810+420+105+910+410+110+310 = 3885.
  const { cacheRead } = weekOf(report(), WEEK_A).spend;
  assert.deepEqual([cacheRead.cacheRead, cacheRead.inputSide], [3700, 3885]);
  near(/** @type {number} */ (cacheRead.share), 3700 / 3885);
});

test("REPEAT CLASSES: each class's count and dollars, each turn priced once, and the two that have no dollars say why", () => {
  const { classes, total } = weekOf(report(), WEEK_B).repeats;
  const byId = Object.fromEntries(classes.map((entry) => [entry.id, entry]));
  // wake:pm:2 repeats wake:pm:1's key: 1 re-delivery, priced as the whole turn it started (0.5). It is also a later wake of its session, but its turn is taken.
  assert.deepEqual([byId.redelivered.count, byId.redelivered.dollars], [1, 0.5]);
  // Three wakes are not their session's first: PM's 2 and 3, and worker-202's second (which started no turn, so it costs nothing measured). Wake 3's first turn re-reads
  // (1000 x $2 + 100000 x $0.2) / 1e6 = 0.022; wake 2's turn is already the re-delivery's.
  assert.equal(byId.preamble.count, 3);
  near(/** @type {number} */ (byId.preamble.dollars), 0.022);
  assert.equal(byId.preamble.tokens, 101000);
  // The reviewer's turn between its first review and the second: 0.3 (the 0.1 before the first review is not).
  assert.deepEqual([byId.rereview.count, byId.rereview.dollars], [1, 0.3]);
  // The turn on row 202 between the ejection (11:00) and the re-entry (13:00): 0.4.
  assert.deepEqual([byId.requeue.count, byId.requeue.dollars], [1, 0.4]);
  // The ceo's first turn after its compaction: (500 x $2 + 50000 x $0.2) / 1e6 = 0.011.
  assert.equal(byId.compaction.count, 1);
  near(/** @type {number} */ (byId.compaction.dollars), 0.011);
  assert.deepEqual([byId["ci-rerun"].count, byId["ci-rerun"].dollars, byId["ci-rerun"].ms], [1, NOT_DERIVABLE, 15 * 60 * 1000]);
  assert.deepEqual([byId.deferred.count, byId.deferred.dollars], [0, NOT_HELD]);
  near(total.dollars, 0.5 + 0.022 + 0.3 + 0.4 + 0.011);
  assert.equal(total.tokens, classes.reduce((sum, entry) => sum + entry.tokens, 0), "the headline's tokens are every class's, the not-derivable ones too");
  assert.equal(total.floor, false);
});

test("REPEAT CLASSES: a class whose turns are all unpriced is not derivable (never 0), and the week before has none of week B's repeats", () => {
  const unpriced = EVENTS.map((event) => (event.id === EVENTS.find((candidate) => candidate.kind === "turn" && candidate.wakeId === "wake:pm:2").id ? { ...event, model: "<synthetic>", costUsd: null } : event));
  const { classes, total } = weekOf(report({ events: unpriced }), WEEK_B).repeats;
  // The class's only turn is unpriced: its dollars are NOT 0, they are not derivable, and the class says how many turns it could not price.
  assert.deepEqual([classes[0].dollars, classes[0].floor, classes[0].unpriced, classes[0].count], [NOT_DERIVABLE, true, 1, 1]);
  assert.equal(total.floor, true);
  assert.equal(weekOf(report(), WEEK_A).repeats.classes.find((entry) => entry.id === "redelivered").count, 0);
});

test("TOP TEN: the ten dearest rows of a week, ties broken the same way twice and whatever order the rows arrive in", () => {
  const rows = Array.from({ length: 12 }, (_, index) => 500 + index);
  const eventsFor = (order) => order.map((row) => turn({ when: "2026-09-22T10:00:00Z", session: `worker-${row}`, row, cost: row === 511 ? 9 : 1, tokens: [1, 1, 1, 0] }));
  const run = (order) => aggregate({
    events: eventsFor(order), pulls: order.map((row) => pull(row + 1000, row, "2026-09-21T10:00:00Z", "2026-09-23T10:00:00Z")), rowRepo: ROW_REPO, now: NOW, since: WEEK_A, held: { from: HELD_FROM, basis: "t" },
  });
  const first = weekOf(run(rows), WEEK_A).dearest.map((row) => row.row);
  const second = weekOf(run([...rows].reverse()), WEEK_A).dearest.map((row) => row.row);
  assert.deepEqual(first, [511, 500, 501, 502, 503, 504, 505, 506, 507, 508]);
  assert.deepEqual(second, first);
});

test("WAKES: the rows the store and wakes-per-row agree on, and a reason for each that they do not (positive control: no reason is empty)", () => {
  const a = weekOf(report(), WEEK_A).wakes;
  // Row 101: 2 worker wakes in the store (the ceo's wake naming it is the store's alone) and 2 in wakes-per-row. Row 102: 2 against 3, claimed before the store's window.
  assert.deepEqual([a.rows, a.agree], [2, 1]);
  assert.deepEqual(a.differ.map((entry) => [entry.row, entry.store, entry.wakesPerRow]), [[102, 2, 3]]);
  assert.match(a.differ[0].reason, /^the store starts at its ingest window/);
  const b = weekOf(report(), WEEK_B).wakes;
  assert.deepEqual(b.differ.map((entry) => [entry.row, entry.wakesPerRow]), [[201, null], [202, 1]]);
  assert.match(b.differ[0].reason, /UNMEASURED \(worker-201: a transcript is unreadable\)/);
  assert.match(b.differ[1].reason, /^UNEXPLAINED: the store holds 2 wakes and wakes-per-row 1/);
  for (const week of [a, b]) for (const entry of week.differ) assert.ok(entry.reason.length > 0, `row ${entry.row} differs with no explanation`);
});

test("WAKES: a reviewer's wakes count only inside its pull request's open-to-merge window, as wakes-per-row places them", () => {
  const inside = wake("wake:r:1", "2026-09-22T10:00:00Z", "reviewer-1101", "reviewer-1101/x/pr-1101", { pr: 1101 });
  const outside = wake("wake:r:2", "2026-09-26T10:00:00Z", "reviewer-1101", "reviewer-1101/x/pr-1101", { pr: 1101 });
  const result = aggregate({
    events: [inside, outside], pulls: [PULLS[0]], rowRepo: ROW_REPO, now: NOW, since: WEEK_A, held: { from: HELD_FROM, basis: "t" },
    readings: new Map([[WEEK_A, [{ row: 101, measured: true, wakes: 1 }]]]),
  });
  assert.deepEqual([weekOf(result, WEEK_A).wakes.agree, weekOf(result, WEEK_A).wakes.differ.length], [1, 0]);
});

test("PARTIAL: a week the store holds only part of, or that is not over, is marked and left out of the comparison", () => {
  const whole = report();
  assert.deepEqual(whole.weeks.slice(0, 2).map((week) => week.partial), [null, null]);
  assert.equal(compareWeeks(whole.weeks).length, 1, "A and B are complete, so B is compared with A");
  const late = report({ held: { from: at("2026-09-24T00:00:00Z"), basis: "ingest window" } });
  assert.match(weekOf(late, WEEK_A).partial, /^the store holds transcripts only from 2026-09-24/);
  assert.equal(weekOf(late, WEEK_B).partial, null);
  assert.equal(compareWeeks(late.weeks).length, 0, "a partial week is not compared");
  const current = report({ now: at("2026-10-02T00:00:00Z") });
  assert.equal(weekOf(current, WEEK_B).partial, "the week is not over");
  assert.equal(compareWeeks(current.weeks).length, 0);
});

test("UNREAD GITHUB: a week holding a merged row whose GitHub events the run did not reach is PARTIAL and not compared, and says how many", () => {
  const short = report({ unreadRows: [101, 102] });
  assert.match(weekOf(short, WEEK_A).partial, /^GitHub's events are not yet read for 2 of its merged rows/);
  assert.equal(weekOf(short, WEEK_B).partial, null);
  assert.equal(compareWeeks(short.weeks).length, 0, "A is partial, so B has nothing complete to be compared with");
  assert.equal(weekOf(report({ unreadRows: [999] }), WEEK_A).partial, null, "a row of no week of the report changes nothing");
  // Every reason is printed, not the first: a week that is not over AND has unread rows says both, and its GitHub-read classes are marked a floor.
  const both = report({ now: at("2026-10-02T00:00:00Z"), unreadRows: [201] });
  assert.match(weekOf(both, WEEK_B).partial, /^the week is not over; GitHub's events are not yet read for 1 of its merged rows/);
  assert.match(renderAggregate(both), /re-reviews\s+1\s+\$0\.3000, 3 tokens\s+\[FLOOR: GitHub unread for 1 rows of this week\]/);
  assert.doesNotMatch(renderAggregate(report()), /FLOOR: GitHub unread/);
});

test("RENDER: the definitions are printed once at the top, and a class with no derivation prints its words, never 0", () => {
  const text = renderAggregate(report());
  assert.ok(text.indexOf("DEFINITIONS") < text.indexOf("WEEK 2026-09-21"));
  for (const line of DEFINITIONS) assert.ok(text.includes(line), `missing definition: ${line.slice(0, 40)}`);
  assert.equal(text.split("DEFINITIONS").length, 2, "printed once");
  assert.match(text, /CI re-runs\s+1\s+dollars: not derivable, 0 tokens, 0\.3h of runner time/);
  assert.match(text, /deferred waits\s+0\s+dollars: not held, 0 tokens/);
  assert.match(text, /UNEXPLAINED: the store holds N wakes and wakes-per-row M: #202 \(2 v 1\)/);
  assert.match(text, /OPEN ROWS, in no average \(1\)/);
  assert.match(text, /models with no price, by turns: <synthetic> 1/);
  assert.match(text, /1 rows -- the store starts at its ingest window.*: #102 \(2 v 3\)/);
  assert.match(text, /PARTIAL|complete/);
});

// BY GATE CAUSE (#3626). A fixture of its own, in week B: a key delivered once in week A and again in B, `pr-checks-failing` re-sent three times at 20-minute gaps, a deferral retry and a one-off.
const causeEvents = (extra) => [
  turn({ when: "2026-09-29T08:05:00Z", session: "worker-9", cost: 1, wakeId: "wake:c:2" }), turn({ when: "2026-09-29T08:25:00Z", session: "worker-9", cost: 2, wakeId: "wake:c:3" }),
  turn({ when: "2026-09-29T08:45:00Z", session: "worker-9", cost: 4, wakeId: "wake:c:4" }), turn({ when: "2026-09-29T09:05:00Z", session: "worker-9", cost: null, wakeId: "wake:c:5", model: "<synthetic>" }),
  wake("wake:c:0", "2026-09-22T08:00:00Z", "worker-9", "worker-9/answer-owed/row-9", { cause: "answer-owed" }), // week A: the earlier delivery
  wake("wake:c:1", "2026-09-29T08:00:00Z", "worker-9", "worker-9/pr-checks-failing/pr-9/abc", { cause: "pr-checks-failing" }),
  wake("wake:c:2", "2026-09-29T08:20:00Z", "worker-9", "worker-9/pr-checks-failing/pr-9/abc", { cause: "pr-checks-failing" }),
  wake("wake:c:3", "2026-09-29T08:40:00Z", "worker-9", "worker-9/pr-checks-failing/pr-9/abc", { cause: "pr-checks-failing" }),
  wake("wake:c:4", "2026-09-29T09:00:00Z", "worker-9", "worker-9/pr-checks-failing/pr-9/abc@deferred:2", { cause: "pr-checks-failing" }),
  wake("wake:c:5", "2026-09-29T10:00:00Z", "worker-9", "worker-9/answer-owed/row-9", { cause: "answer-owed" }),
  ...extra,
];
const causesOf = (events) => weekOf(report({ events }), WEEK_B).repeats.classes.find((entry) => entry.id === "redelivered");

test("BY GATE CAUSE: repeats, distinct keys, median gap and dollars per cause, the DEAREST first (not the most repeats), and a deferral retry its own row", () => {
  const redelivered = causesOf(causeEvents([]));
  // 4 repeats of pr-checks-failing: wakes 2 and 3 (gaps 20 and 20 minutes) and wake 4, the `@deferred` retry (a gap of 20 minutes from wake 3), which is NOT the same row as them.
  // answer-owed: wake 5 repeats the week-A delivery, so its gap is 7 days + 2 hours (the previous delivery counts whenever it was).
  // The two rankings DISAGREE here (the chairman's order is in dollars): by repeats pr-checks-failing leads (2 against 1), by dollars its `@deferred` retry does ($4 against $3), and the cause with no derivable dollars is last.
  assert.deepEqual(redelivered.causes.map(({ cause, deferred, count, keys }) => [cause, deferred, count, keys]), [["pr-checks-failing", true, 1, 1], ["pr-checks-failing", false, 2, 1], ["answer-owed", false, 1, 1]]);
  assert.deepEqual(redelivered.causes.map((own) => own.medianGapMs), [20 * 60 * 1000, 20 * 60 * 1000, (7 * 24 + 2) * 60 * 60 * 1000]);
  // Wake 2's turn costs 1 and wake 3's costs 2; wake 4's costs 4 (the retry); wake 5's turn is unpriced, so answer-owed is not derivable (never 0) and a floor.
  assert.deepEqual(redelivered.causes.map((own) => [own.dollars, own.floor]), [[4, false], [3, false], [NOT_DERIVABLE, true]]);
  assert.equal(redelivered.count, redelivered.causes.reduce((sum, own) => sum + own.count, 0), "the rows add up to the class");
  near(/** @type {number} */ (redelivered.dollars), 7);
});

test("BY GATE CAUSE: the report prints the table under the re-delivered line, the dearest cause first; a week with no repeats prints none (positive control: week B does)", () => {
  const printed = renderAggregate(report({ events: causeEvents([]) }));
  const lines = printed.split("\n");
  const head = lines.findIndex((line) => line.includes("by gate cause"));
  assert.ok(lines[head - 1].includes("re-delivered orders"), "the table sits directly under the class line");
  assert.match(lines[head + 1], /pr-checks-failing @deferred\s+1\s+1\s+20 min\b.*\$4\.0+$/);
  assert.match(lines[head + 2], /pr-checks-failing\s+2\s+1\s+20 min\b.*\$3\.0+$/);
  assert.match(lines[head + 3], /answer-owed\s+1\s+1\s+170\.0h\b.*dollars: not derivable/);
  const quiet = renderAggregate(report({ events: EVENTS.filter((event) => event.kind !== "wake") }));
  assert.equal(quiet.includes("by gate cause"), false, "no repeats, no table");
  assert.equal(weekOf(report({ events: EVENTS.filter((event) => event.kind !== "wake") }), WEEK_B).repeats.classes[0].causes.length, 0);
});

test("BY GATE CAUSE: a fixture whose repeats are all one cause prints that cause first and alone", () => {
  const only = weekOf(report({ events: [...WEEK_B_TURNS, wake("a", "2026-09-29T08:00:00Z", "ceo", "ceo/answer-owed/row-1", { cause: "answer-owed" }), wake("b", "2026-09-29T09:00:00Z", "ceo", "ceo/answer-owed/row-1", { cause: "answer-owed" })] }), WEEK_B)
    .repeats.classes[0];
  assert.deepEqual(only.causes.map(({ cause, count }) => [cause, count]), [["answer-owed", 1]]);
});


// THE SPLIT (#3661): each cause's repeats are AFTER A CHANGE, UNCHANGED or UNEXPLAINED, read from the store's GitHub record. A repeat is in exactly one.
const ROW_KEY = "worker-11/ready-row-unclaimed/row-11";
const SPLIT_ROW = [
  github("filed", "2026-09-29T07:00:00Z", { row: 11 }),
  github("released", "2026-09-29T08:30:00Z", { row: 11, claimant: "worker-11" }), // between delivery 1 and 2: wake 2 is a row worked a second time
  github("claimed", "2026-09-29T09:00:00Z", { row: 11, claimant: "worker-11" }), // at delivery 2's own instant: that delivery answered it, so it is not a change for wake 3
  github("released", "2026-09-29T10:00:01Z", { row: 11, claimant: "worker-11" }), // after wake 3: not a change for it either
  wake("wake:s:1", "2026-09-29T08:00:00Z", "worker-11", ROW_KEY, { cause: "ready-row-unclaimed" }),
  wake("wake:s:2", "2026-09-29T09:00:00Z", "worker-11", ROW_KEY, { cause: "ready-row-unclaimed" }),
  wake("wake:s:3", "2026-09-29T10:00:00Z", "worker-11", ROW_KEY, { cause: "ready-row-unclaimed" }),
  turn({ when: "2026-09-29T09:05:00Z", session: "worker-11", cost: 3, wakeId: "wake:s:2" }), turn({ when: "2026-09-29T10:05:00Z", session: "worker-11", cost: 5, wakeId: "wake:s:3" }),
];
const causeOf = (entry, name) => entry.causes.find((own) => own.cause === name);
const figures = (share) => [share.count, share.dollars];
/** The positive control: the three parts of a cause add up to its repeats and its dollars, and a breakdown that does not is RED. */
function assertAddsUp(own) {
  const parts = Object.values(own.split);
  const priced = (value) => (typeof value === "number" ? value : 0);
  assert.equal(parts.reduce((sum, part) => sum + part.count, 0), own.count, `${own.cause}: after a change + unchanged + unexplained must be the cause's repeats`);
  near(parts.reduce((sum, part) => sum + priced(part.dollars), 0), priced(own.dollars));
}

test("SPLIT: one repeat after a release and one with no change in between read after a change 1 and unchanged 1, each with its own dollars; a change at or before the previous delivery, or after the repeat, is no change", () => {
  const own = causeOf(causesOf(SPLIT_ROW), "ready-row-unclaimed");
  assert.deepEqual([own.count, ...Object.values(own.split).map(figures)], [2, [1, 3], [1, 5], [0, 0]]);
  assertAddsUp(own);
});

test("SPLIT: a repeat whose row has no GitHub events, and one whose key names no subject, read unexplained and are in neither column (never folded into unchanged)", () => {
  const own = causeOf(causesOf([...SPLIT_ROW, github("filed", "2026-09-29T07:00:00Z", { row: 99 }),
    wake("wake:u:1", "2026-09-29T11:00:00Z", "worker-12", "worker-12/ready-row-unclaimed/row-12", { cause: "unheld" }), wake("wake:u:2", "2026-09-29T11:30:00Z", "worker-12", "worker-12/ready-row-unclaimed/row-12", { cause: "unheld" }),
    wake("wake:n:1", "2026-09-29T11:00:00Z", "ceo", "ceo/org-health/some-signal", { cause: "unnamed" }), wake("wake:n:2", "2026-09-29T11:30:00Z", "ceo", "ceo/org-health/some-signal", { cause: "unnamed" })]), "unheld");
  assert.deepEqual([own.count, ...Object.values(own.split).map((share) => share.count)], [1, 0, 0, 1], "row 12 has no events in the store");
  const unnamed = causeOf(causesOf([wake("wake:n:1", "2026-09-29T11:00:00Z", "worker-13", "worker-13/org-health/some-signal", { cause: "unnamed" }),
    wake("wake:n:2", "2026-09-29T11:30:00Z", "worker-13", "worker-13/org-health/some-signal", { cause: "unnamed" }), github("filed", "2026-09-29T07:00:00Z", { row: 13 })]), "unnamed");
  assert.deepEqual(Object.values(unnamed.split).map((share) => share.count), [0, 0, 1], "the session's NAME is worker-13, but the key names no row: the store's attribution is not the order's subject");
  assertAddsUp(own);
  assertAddsUp(unnamed);
});

test("SPLIT: a key that carries a head reads after a change when the head moved to a DIFFERENT one; the same head, a CI run, a review, and a head moved on a key with no head are not", () => {
  const key = "worker-21/pr-checks-failing/pr-21/abcdef12";
  const bare = "worker-22/pr-review-blocked/pr-22";
  const wakes = (session, causeKey, cause) => [0, 20, 40].map((minute, index) => wake(`wake:h:${session}:${index}`, `2026-09-29T08:${String(minute).padStart(2, "0")}:00Z`, session, causeKey, { cause }));
  const own = causeOf(causesOf([
    github("opened", "2026-09-29T07:00:00Z", { pr: 21 }), github("head_moved", "2026-09-29T08:10:00Z", { pr: 21, headSha: "ffffffff00112233" }), // before repeat 1: a different head
    github("head_moved", "2026-09-29T08:30:00Z", { pr: 21, headSha: "abcdef1234567890" }), github("ci_run", "2026-09-29T08:35:00Z", { pr: 21, headSha: "abcdef1234567890" }), // before repeat 2: the same head, and a CI run
    github("opened", "2026-09-29T07:00:00Z", { pr: 22 }), github("head_moved", "2026-09-29T08:10:00Z", { pr: 22, headSha: "ffffffff00112233" }), github("reviewed", "2026-09-29T08:30:00Z", { pr: 22 }),
    ...wakes("worker-21", key, "pr-checks-failing"), ...wakes("worker-22", bare, "pr-review-blocked"),
  ]), "pr-checks-failing");
  assert.deepEqual(Object.values(own.split).map((share) => share.count), [1, 1, 0], "repeat 1 after the head moved away, repeat 2 on the same head");
  const noHead = causeOf(causesOf([github("opened", "2026-09-29T07:00:00Z", { pr: 22 }), github("head_moved", "2026-09-29T08:10:00Z", { pr: 22, headSha: "ffffffff00112233" }),
    github("reviewed", "2026-09-29T08:30:00Z", { pr: 22 }), ...wakes("worker-22", bare, "pr-review-blocked")]), "pr-review-blocked");
  assert.deepEqual(Object.values(noHead.split).map((share) => share.count), [0, 2, 0], "a key with no head is not changed by a head moving, nor by a review");
  assertAddsUp(own);
  assertAddsUp(noHead);
});

test("SPLIT: a label going on or off the row is a change, and the class's split adds up to the class (its total unchanged by the split)", () => {
  const key = "worker-14/answer-owed/row-14";
  const events = [...SPLIT_ROW, github("filed", "2026-09-29T07:00:00Z", { row: 14 }), github("unlabeled", "2026-09-29T08:30:00Z", { row: 14, name: "answer:worker-14" }),
    wake("wake:l:1", "2026-09-29T08:00:00Z", "worker-14", key, { cause: "answer-owed" }), wake("wake:l:2", "2026-09-29T09:00:00Z", "worker-14", key, { cause: "answer-owed" }),
    turn({ when: "2026-09-29T09:05:00Z", session: "worker-14", cost: 2, wakeId: "wake:l:2" })];
  const entry = causesOf(events);
  assert.deepEqual(causeOf(entry, "answer-owed").split.afterChange.count, 1);
  for (const own of entry.causes) assertAddsUp(own);
  assert.equal(Object.values(entry.split).reduce((sum, share) => sum + share.count, 0), entry.count, "the class's three parts are its repeats");
  near(Object.values(entry.split).reduce((sum, share) => sum + share.dollars, 0), entry.dollars);
  near(entry.dollars, 10); // 3 + 5 + 2, as it was before the split
});

test("SPLIT: a breakdown that does not add up is RED (the positive control the check names)", () => {
  const own = causeOf(causesOf(SPLIT_ROW), "ready-row-unclaimed");
  assertAddsUp(own);
  assert.throws(() => assertAddsUp({ ...own, split: { ...own.split, unexplained: { ...own.split.unexplained, count: 1 } } }), /must be the cause's repeats/);
  assert.throws(() => assertAddsUp({ ...own, split: { ...own.split, unchanged: { ...own.split.unchanged, dollars: 4 } } }));
});

test("SPLIT: the table prints a column for each part and a closing row for the class", () => {
  const lines = renderAggregate(report({ events: SPLIT_ROW })).split("\n");
  const head = lines.findIndex((line) => line.includes("by gate cause"));
  assert.match(lines[head], /after a change\s+unchanged\s+unexplained\s+dollars$/);
  assert.match(lines[head + 1], /ready-row-unclaimed\s+2\s+1\s+1\.0h\s+1 \$3\.0+\s+1 \$5\.0+\s+0 \$0\.0+\s+\$8\.0+$/);
  assert.match(lines[head + 2], /all causes\s+2\s+1 \$3\.0+\s+1 \$5\.0+\s+0 \$0\.0+\s+\$8\.0+$/);
});


// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// #3511: the phase share and each dear row's dearest phase, from the rows' waterfalls

const MIN = 60 * 1000;
/**
 * Two merged rows in week B with timelines worked out by hand, and a third (603) with a turn and no GitHub record. Row 601: filed 08:00, claimed 08:10, built 08:20-09:00 (a turn of $4),
 * a pull request opened 09:00, ready 09:10, a reviewer's turn of $1, reviewed 09:30, queued 09:40, merged and closed 10:00 = 120 min. Row 602: filed 11:00, claimed 11:05, built 11:10-11:50
 * ($6), opened 11:50, ready 12:00, an UNPRICED turn at 12:05, reviewed 12:10, queued 12:20, merged and closed 12:30 = 90 min. A review round holds the phase to itself while it is open, so
 * `verify` has nothing exclusive here; the 10 minutes between the review and the queue entry are in no phase.
 */
const phased = (row, pr, day, times, turns) => [
  github("filed", `${day}T${times.filed}:00Z`, { row }), github("claimed", `${day}T${times.claimed}:00Z`, { row, claimant: `worker-${row}` }),
  github("opened", `${day}T${times.opened}:00Z`, { pr }), github("ready_for_review", `${day}T${times.ready}:00Z`, { pr }), github("reviewed", `${day}T${times.reviewed}:00Z`, { pr, state: "APPROVED", headSha: "aaaaaaa" }),
  github("added_to_merge_queue", `${day}T${times.queued}:00Z`, { pr }), github("merged", `${day}T${times.closed}:00Z`, { pr }), github("closed", `${day}T${times.closed}:00Z`, { pr }), github("closed", `${day}T${times.closed}:00Z`, { row }),
  ...turns,
];
const PHASED_EVENTS = [
  ...phased(601, 1601, "2026-09-29", { filed: "08:00", claimed: "08:10", opened: "09:00", ready: "09:10", reviewed: "09:30", queued: "09:40", closed: "10:00" }, [
    turn({ when: "2026-09-29T08:59:30Z", session: "worker-601", row: 601, cost: 4, wallClockMs: 39.5 * MIN }),
    turn({ when: "2026-09-29T09:25:00Z", session: "reviewer-1601", pr: 1601, cost: 1, wallClockMs: 15 * MIN })]),
  ...phased(602, 1602, "2026-09-29", { filed: "11:00", claimed: "11:05", opened: "11:50", ready: "12:00", reviewed: "12:10", queued: "12:20", closed: "12:30" }, [
    turn({ when: "2026-09-29T11:49:30Z", session: "worker-602", row: 602, cost: 6, wallClockMs: 39.5 * MIN }),
    turn({ when: "2026-09-29T12:05:00Z", session: "worker-602", row: 602, cost: null, model: "<synthetic>", wallClockMs: 5 * MIN })]),
  turn({ when: "2026-09-29T13:00:00Z", session: "worker-603", row: 603, cost: 2 }),
];
const PHASED_PULLS = [pull(1601, 601, "2026-09-29T09:00:00Z", "2026-09-29T10:00:00Z"), pull(1602, 602, "2026-09-29T11:50:00Z", "2026-09-29T12:30:00Z"), pull(1603, 603, "2026-09-29T13:00:00Z", "2026-09-29T14:00:00Z")];
const phasedWeek = () => weekOf(aggregate({ events: PHASED_EVENTS, pulls: PHASED_PULLS, rowRepo: ROW_REPO, now: NOW, since: WEEK_B, held: { from: HELD_FROM, basis: "t" } }), WEEK_B);

test("PHASE SHARE: each phase's share of the week's wall-clock and dollars, from the rows' waterfalls, against hand-computed values", () => {
  const { phases } = phasedWeek();
  assert.deepEqual([phases.rows, phases.noRecord], [2, 1], "row 603 has a turn and no GitHub record: counted apart, in no share");
  assert.equal(phases.wallClockMs, 210 * MIN, "120 + 90");
  near(phases.dollars, 11);
  const share = (name) => phases.shares.find((one) => one.phase === name);
  const minutes = { spec: 15, claim: 15, build: 80, verify: 0, review: 50, CI: 0, queue: 30, merge: 0, between: 20 };
  for (const [name, expected] of Object.entries(minutes)) {
    assert.equal(share(name).exclusiveMs, expected * MIN, `${name}: exclusive minutes`);
    near(share(name).wallShare, expected / 210);
  }
  near(share("build").dollarShare, 10 / 11);
  near(share("review").dollarShare, 1 / 11);
  assert.equal(share("review").unpriced, 1, "the unpriced turn is counted apart in its phase, and is not zero dollars");
  near(phases.shares.reduce((sum, one) => sum + one.wallShare, 0), 1);
  near(phases.shares.reduce((sum, one) => sum + one.dollarShare, 0), 1);
});

test("PHASE SHARE POSITIVE CONTROL: a share that does not sum to the whole is RED, and a table that leaves a part out is never printed", () => {
  const rowEvents = (row) => PHASED_EVENTS.filter((event) => event.row === row || event.pr === row + 1000 || (event.pr === null && event.row === row));
  const real = [601, 602].map((row) => waterfall({ events: rowEvents(row), now: NOW }));
  near(phaseShares(real).shares.reduce((sum, one) => sum + one.wallShare, 0), 1);
  const dropped = structuredClone(real);
  dropped[0].phases.find((phase) => phase.phase === "build").exclusiveMs = 0; // a phase whose wall-clock is lost: the table would show 33% of this row missing
  assert.throws(() => phaseShares(dropped), /phase shares of wall-clock add up to 0\.\d+, not the whole/);
  const lostTurns = structuredClone(real);
  lostTurns[1].phases.find((phase) => phase.phase === "build").spend.dollars = 0; // a phase whose dollars are lost
  assert.throws(() => phaseShares(lostTurns), /phase shares of dollars add up to .*not the whole/);
  assert.deepEqual(phaseShares([]).shares.map((one) => one.wallShare), Array(9).fill(null), "with nothing held there is no share, which is not 0% and not an error");
});

test("DEAREST PHASE: each of the dearest rows names the phase that cost most and the phase with the most wall-clock to itself", () => {
  const dearest = phasedWeek().dearest;
  assert.deepEqual(dearest.map((row) => row.row), [602, 601, 603]);
  assert.deepEqual([dearest[0].phase.costliest.phase, dearest[0].phase.costliest.share, dearest[0].phase.costliest.floor], ["build", 1, true], "row 602: all $6 are build, and its unpriced turn makes that a floor");
  assert.deepEqual([dearest[1].phase.costliest.phase, dearest[1].phase.costliest.share, dearest[1].phase.costliest.floor], ["build", 0.8, false], "row 601: $4 of $5");
  assert.deepEqual([dearest[1].phase.longest.phase, dearest[1].phase.longest.ms], ["build", 40 * MIN]);
  assert.deepEqual(dearest[2].phase, { costliest: null, longest: null }, "row 603 has no phase record: none is invented, and its $2 are not called `between`");
  assert.deepEqual(dearestPhase(waterfall({ events: PHASED_EVENTS.filter((event) => event.row === 603), now: NOW })), { costliest: null, longest: null }, "no waterfall, no figure");
});

test("PHASE SHARE RENDER: the table, the dearest phase beside each dear row, and the two definitions", () => {
  const text = renderAggregate(aggregate({ events: PHASED_EVENTS, pulls: PHASED_PULLS, rowRepo: ROW_REPO, now: NOW, since: WEEK_B, held: { from: HELD_FROM, basis: "t" } }));
  assert.match(text, /PHASE SHARE over 2 merged rows \(1 with no phase record are in no share\): 3\.5h of wall-clock/);
  assert.match(text, /build +38\.1% of wall-clock \(1\.3h to itself\) +90\.9% of dollars \(\$10\.0000\)/);
  assert.match(text, /verify +0\.0% of wall-clock/);
  assert.match(text, /#602 .*\n +dearest phase: build >= \$6\.0000 \(100\.0% of its turns' dollars\); most wall-clock to itself: build 0\.7h \(44\.4%\)/);
  assert.match(text, /#603 .*\n +phases: none \(no phase record of this row in the store\)/);
  assert.ok(DEFINITIONS.some((line) => line.startsWith("PHASE SHARE (#3511)")) && DEFINITIONS.some((line) => line.startsWith("DEAREST PHASE (#3511)")));
});

// STORED BEFORE ITS PRICE (#3638). The store keeps the cost a turn had when it was INGESTED, and an unchanged transcript is not read again, so a price added later reached none of the
// turns stored before it. A report prices from `PRICES` as it stands and ignores the stored figure.
const storedAt = (when, model, costUsd, extra = {}) => turn({ when, session: "worker-9", row: 9, cost: costUsd, model, tokens: [1000, 500, 0, 0], ...extra });
const oneRow = (events) => aggregate({
  events, pulls: [pull(1, 9, "2026-09-21T10:00:00Z", "2026-09-23T10:00:00Z")], rowRepo: ROW_REPO, now: NOW, since: WEEK_A, held: { from: HELD_FROM, basis: "t" },
});

test("REPRICED: a stored turn of a model priced SINCE (claude-sonnet-5, stored null) prints priced, its dollars from PRICES and not from the line", () => {
  const week = weekOf(oneRow([storedAt("2026-09-22T10:00:00Z", "claude-sonnet-5", null)]), WEEK_A);
  const row9 = week.rows[0];
  near(row9.dollars, (1000 * 2 + 500 * 10) / 1e6);
  assert.deepEqual([row9.floor, row9.unpriced], [false, 0]);
  assert.deepEqual(week.spend.unpricedModels, []);
  assert.equal(week.perRow.noPrice, 0);
});

test("REPRICED: the stored figure is not trusted over PRICES (a line that says 99 for a turn PRICES puts at 0.007)", () => {
  const row9 = weekOf(oneRow([storedAt("2026-09-22T10:00:00Z", "claude-sonnet-5", 99)]), WEEK_A).rows[0];
  near(row9.dollars, 0.007);
});

test("REPRICED, positive control: a Codex turn stored null stays UNPRICED (null, never 0) and its row stays a FLOOR of the Claude turn beside it", () => {
  const week = weekOf(oneRow([storedAt("2026-09-22T10:00:00Z", "claude-sonnet-5", null), storedAt("2026-09-22T11:00:00Z", "gpt-5.6-luna", null)]), WEEK_A);
  const row9 = week.rows[0];
  near(row9.dollars, 0.007);
  assert.deepEqual([row9.floor, row9.unpriced], [true, 1]);
  assert.deepEqual(week.spend.unpricedModels, [["gpt-5.6-luna", 1]]);
  const only = weekOf(oneRow([storedAt("2026-09-22T10:00:00Z", "gpt-5.6-luna", null)]), WEEK_A);
  assert.equal(only.rows[0].dollars, null, "a row of only unpriced turns has no dollar figure");
});

test("REPRICED: a changed price in PRICES moves a turn that was stored at the old one", () => {
  const events = [storedAt("2026-09-22T10:00:00Z", "claude-sonnet-5", 0.007)];
  const row = PRICES.find((price) => price.prefix === "claude-sonnet-5");
  const was = row.input;
  try {
    near(weekOf(oneRow(events), WEEK_A).rows[0].dollars, 0.007);
    row.input = was * 2;
    near(weekOf(oneRow(events), WEEK_A).rows[0].dollars, (1000 * 4 + 500 * 10) / 1e6);
  } finally {
    row.input = was;
  }
  near(weekOf(oneRow(events), WEEK_A).rows[0].dollars, 0.007);
});


// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// #3967: by repository, before and after the move, the first turn and the tokens read through tools

const AGENT_ORG = "a11ign/agent-org";
const inRepo = (repo, number, row, openedIso, mergedIso) => ({ repo, number, createdAt: openedIso, mergedAt: mergedIso, body: `Closes ${ROW_REPO}#${row}` });
const SIZES = (...windows) => windows.map((window) => [window, 0, 0, 0]); // [input, output, cacheRead, cacheWrite1h]: a first turn whose whole window is `window`

test("BY REPOSITORY: a row is in the repository of its LAST merged pull request, each repository has its own rows, and one with no merged row prints nothing", () => {
  const pulls = [
    pull(1101, 101, "2026-09-22T08:00:00Z", "2026-09-23T10:00:00Z"), pull(1102, 102, "2026-09-22T09:00:00Z", "2026-09-24T10:00:00Z"),
    inRepo(AGENT_ORG, 31, 201, "2026-09-22T09:00:00Z", "2026-09-25T10:00:00Z"),
    pull(1103, 103, "2026-09-22T09:00:00Z", "2026-09-22T12:00:00Z"), inRepo(AGENT_ORG, 32, 103, "2026-09-23T09:00:00Z", "2026-09-26T10:00:00Z"), // two repositories: the later merge is the row's
  ];
  const events = [
    turn({ when: "2026-09-22T10:00:00Z", session: "worker-101", row: 101, cost: 1, tokens: [10, 10, 80, 0] }), turn({ when: "2026-09-22T11:00:00Z", session: "worker-102", row: 102, cost: 3, tokens: [10, 10, 180, 0] }),
    turn({ when: "2026-09-22T12:00:00Z", session: "worker-201", row: 201, cost: 7, tokens: [10, 10, 30, 0] }),
    turn({ when: "2026-09-22T13:00:00Z", session: "worker-103", row: 103, cost: 2, tokens: [10, 10, 30, 0] }),
  ];
  const [week] = aggregate({ events, pulls, rowRepo: ROW_REPO, now: NOW, since: WEEK_A, held: { from: HELD_FROM, basis: "fixture" } }).weeks;
  assert.deepEqual(week.byRepo.map((cut) => [cut.repo, cut.rows]), [[ROW_REPO, 2], [AGENT_ORG, 2]], "rows 201 and 103 are agent-org's (103's last merge was there), 101 and 102 the primary's");
  const primary = week.byRepo.find((cut) => cut.repo === ROW_REPO);
  assert.deepEqual([primary.tokens.n, primary.tokens.p50, primary.tokens.p90], [2, 100, 200], "P50 and P90 are nearest-rank over the repository's own rows: 100 and 200 tokens");
  assert.deepEqual([primary.dollars.p50, primary.dollars.p90], [1, 3]);
  const [empty] = aggregate({ events, pulls: [pulls[0]], rowRepo: ROW_REPO, now: NOW, since: WEEK_A, held: { from: HELD_FROM, basis: "fixture" } }).weeks;
  assert.deepEqual(empty.byRepo.map((cut) => cut.repo), [ROW_REPO], "a repository with no merged row has no entry, and so no figure of 0");
});

test("FIRST-TURN SIZE: the first turn of each per-row transcript, never a standing seat's, a subagent's or a later turn", () => {
  const events = [
    turn({ when: "2026-09-22T10:00:00Z", session: "worker-101", row: 101, cost: 1, tokens: [10, 5, 900, 90], transcript: "w1" }), // window 10 + 900 + 90 = 1000; output is not in it
    turn({ when: "2026-09-22T10:30:00Z", session: "worker-101", row: 101, cost: 1, tokens: [10, 5, 5000, 0], transcript: "w1" }), // a later turn of the same transcript: not a first turn
    turn({ when: "2026-09-22T09:00:00Z", session: "worker-101", row: 101, cost: 1, tokens: [1, 1, 99999, 0], transcript: "w1", sidechain: true }), // a subagent's, earlier: not the transcript's first
    turn({ when: "2026-09-22T11:00:00Z", session: "reviewer-1101", pr: 1101, cost: 1, tokens: [30, 5, 2970, 0], transcript: "r1" }), // 3000, placed on row 101 through its pull request
    turn({ when: "2026-09-22T12:00:00Z", session: "ceo", row: 101, cost: 1, tokens: [10, 5, 7777, 0], transcript: "c1" }), // a standing seat that wrote to the row
  ];
  const [week] = aggregate({ events, pulls: [pull(1101, 101, "2026-09-22T08:00:00Z", "2026-09-23T10:00:00Z")], rowRepo: ROW_REPO, now: NOW, since: WEEK_A, held: { from: HELD_FROM, basis: "fixture" } }).weeks;
  const { firstTurn } = week.byRepo[0];
  assert.deepEqual([firstTurn.n, firstTurn.p50, firstTurn.p90], [2, 1000, 3000], "two first turns, 1000 and 3000: the worker's and the reviewer's");
  const none = aggregate({ events: [events[4]], pulls: [pull(1101, 101, "2026-09-22T08:00:00Z", "2026-09-23T10:00:00Z")], rowRepo: ROW_REPO, now: NOW, since: WEEK_A, held: { from: HELD_FROM, basis: "fixture" } }).weeks[0].byRepo[0].firstTurn;
  assert.deepEqual(none, { n: 0, p50: null, p90: null }, "a row with only a standing seat's turn has no first turn, which is not 0");
  assert.match(renderAggregate(aggregate({ events: [events[4]], pulls: [pull(1101, 101, "2026-09-22T08:00:00Z", "2026-09-23T10:00:00Z")], rowRepo: ROW_REPO, now: NOW, since: WEEK_A, held: { from: HELD_FROM, basis: "fixture" } })), /FIRST-TURN SIZE: not held/);
});

test("TOOL-READ TOKENS: summed per row and per tool, mixed in the total and in no tool, and a turn with no field or no tokens makes the row's figure a floor", () => {
  const read = (tool, tokens) => ({ tool, tokens });
  const events = [
    turn({ when: "2026-09-22T10:00:00Z", session: "worker-101", row: 101, cost: 1, tokens: [10, 0, 990, 0], toolRead: read("Read", 400) }),
    turn({ when: "2026-09-22T10:10:00Z", session: "worker-101", row: 101, cost: 1, tokens: [10, 0, 990, 0], toolRead: read("Grep", 100) }),
    turn({ when: "2026-09-22T10:20:00Z", session: "worker-101", row: 101, cost: 1, tokens: [10, 0, 990, 0], toolRead: read("mixed", 50) }),
    turn({ when: "2026-09-22T10:30:00Z", session: "worker-101", row: 101, cost: 1, tokens: [10, 0, 990, 0], toolRead: null }), // no read call before it: derived, and nothing
    turn({ when: "2026-09-22T11:00:00Z", session: "worker-102", row: 102, cost: 1, tokens: [10, 0, 990, 0], toolRead: read("Read", 200) }),
    turn({ when: "2026-09-22T11:10:00Z", session: "worker-102", row: 102, cost: 1, tokens: [10, 0, 990, 0], toolRead: read("Glob", null) }), // a window that cannot be read that way
    turn({ when: "2026-09-22T12:00:00Z", session: "worker-103", row: 103, cost: 1, tokens: [10, 0, 990, 0] }), // stored before the reader: no field at all
  ];
  const pulls = [101, 102, 103].map((row) => pull(1100 + row, row, "2026-09-22T08:00:00Z", "2026-09-23T10:00:00Z"));
  const [{ byRepo: [cut] }] = aggregate({ events, pulls, rowRepo: ROW_REPO, now: NOW, since: WEEK_A, held: { from: HELD_FROM, basis: "fixture" } }).weeks;
  const read3 = cut.toolRead;
  assert.deepEqual([read3.total, read3.byTool, read3.mixed], [750, { Read: 600, Grep: 100, Glob: 0 }, 50], "400 + 100 + 50 + 200: the mixed 50 is in the total and in no tool");
  assert.deepEqual([read3.rows, read3.notHeldRows, read3.floorRows, read3.notDerivableTurns], [2, 1, 1, 1], "row 103 has no figure; row 102 has one turn it could not derive, so its figure is a floor");
  near(read3.share, 750 / 6000); // of the tokens of the rows that have the figure: 101 has 4 turns of 1000 and 102 has 2, row 103 is not in the denominator
});

test("MOVE: the weeks before, the week that holds it, and the weeks after, each its own population, with a row placed by its pull requests' paths", () => {
  const moves = [{ ...MOVES[0], at: at("2026-10-02T18:13:06Z") }];
  const pulls = [
    pull(1101, 101, "2026-09-22T08:00:00Z", "2026-09-23T10:00:00Z"), pull(1102, 102, "2026-09-22T08:00:00Z", "2026-09-24T10:00:00Z"), pull(1103, 103, "2026-09-22T08:00:00Z", "2026-09-25T10:00:00Z"),
    pull(1104, 104, "2026-09-22T08:00:00Z", "2026-09-26T10:00:00Z"), pull(1201, 201, "2026-09-29T08:00:00Z", "2026-09-30T10:00:00Z"), inRepo(AGENT_ORG, 31, 301, "2026-10-05T08:00:00Z", "2026-10-06T10:00:00Z"),
  ];
  const pullPaths = new Map([
    [`${ROW_REPO}#1101`, ["packages/agent-org/src/a.mjs", "packages/agent-org/b.mjs"]], // wholly under the old directory: the package's
    [`${ROW_REPO}#1102`, ["packages/agent-org/src/a.mjs", "docs/x.md"]], // under it and elsewhere: MIXED
    [`${ROW_REPO}#1103`, ["docs/x.md"]], // not under it
  ]); // 1104 is not found: its paths were not read
  const events = [
    turn({ when: "2026-09-22T10:00:00Z", session: "worker-101", row: 101, cost: 1, tokens: [10, 0, 90, 0], transcript: "a" }), turn({ when: "2026-09-22T11:00:00Z", session: "worker-102", row: 102, cost: 1, tokens: [10, 0, 90, 0], transcript: "b" }),
    turn({ when: "2026-09-22T12:00:00Z", session: "worker-103", row: 103, cost: 1, tokens: [10, 0, 90, 0], transcript: "c" }), turn({ when: "2026-09-22T13:00:00Z", session: "worker-104", row: 104, cost: 1, tokens: [10, 0, 90, 0], transcript: "d" }),
    turn({ when: "2026-09-29T10:00:00Z", session: "worker-201", row: 201, cost: 1, tokens: [10, 0, 90, 0], transcript: "e" }), turn({ when: "2026-10-05T10:00:00Z", session: "worker-301", row: 301, cost: 5, tokens: [10, 0, 490, 0], transcript: "f" }),
  ];
  const report = aggregate({ events, pulls, rowRepo: ROW_REPO, now: at("2026-10-14T00:00:00Z"), since: WEEK_A, held: { from: HELD_FROM, basis: "fixture" }, moves, pullPaths });
  const [before, moveWeek, after, current] = report.weeks.map((week) => week.moves[0]);
  assert.deepEqual([before.side, moveWeek.side, after.side, current.side], ["before", "move-week", "after", "after"]);
  assert.deepEqual(before.placed, { package: 1, mixed: 1, other: 1, unread: 1 }, "positive control: every placement occurs, so the counts below are not all zero");
  assert.equal(before.cut.rows, 1, "only row 101 is the package's; the MIXED row, the other row and the one with no paths are on neither side");
  assert.equal(moveWeek.cut, null, "the week that holds the move is on neither side and has no figure");
  assert.equal(after.cut.rows, 1, "row 301 merged in a11ign/agent-org");
  assert.equal(current.cut.rows, 0, "a week after the move with no merged row of the package has a cut of zero rows, which the text prints as no figure");
  const text = renderAggregate(report);
  assert.match(text, /BEFORE AND AFTER THE MOVE, agent-org \(#2974, closed 2026-10-02T18:13:06.000Z/);
  assert.match(text, /MOVE WEEK: on neither side/);
  assert.match(text, /placed by paths: 1 on the package, MIXED 1 \(on neither side\), other 1, paths not read 1\./);
  assert.match(text, /AFTER: the whole weeks above are the reading/, "a whole week after the move exists in this reading");
});

test("MOVE: until a whole week has passed after the move the after side is NOT HELD, and a move whose time was not read is not placed", () => {
  const moves = [{ ...MOVES[0], at: at("2026-10-02T18:13:06Z") }, { ...MOVES[1], at: null }];
  const events = [turn({ when: "2026-09-29T10:00:00Z", session: "worker-201", row: 201, cost: 1, tokens: [10, 0, 90, 0], transcript: "e" })];
  const report = aggregate({ events, pulls: [pull(1201, 201, "2026-09-29T08:00:00Z", "2026-09-30T10:00:00Z")], rowRepo: ROW_REPO, now: at("2026-10-06T00:00:00Z"), since: WEEK_B, held: { from: HELD_FROM, basis: "fixture" }, moves });
  const text = renderAggregate(report);
  assert.match(text, /AFTER: not held: no whole week has passed since the move \(the first is the week of 2026-10-05, which ends 2026-10-12\)/);
  assert.match(text, /BEFORE AND AFTER THE MOVE, lab \(#2703\): not held: the closing time of the row was not read/);
  assert.equal(report.weeks[0].moves[1].side, "not held");
  assert.ok(!/\$0\.0000/.test(text.split("BEFORE AND AFTER THE MOVE, agent-org")[1]), "no figure of 0 stands in for a side that is not held");
});

test("DEFINITIONS name the four figures of #3967, and the report prints them", () => {
  for (const name of ["BY REPOSITORY", "BEFORE AND AFTER THE MOVE", "FIRST-TURN SIZE", "TOOL-READ TOKENS"]) assert.ok(DEFINITIONS.some((line) => line.startsWith(`${name} (#3967)`)), name);
});

test("parseMergePaths: the paths of each `Merge pull request #n` commit or squash commit ending `(#n)`, and nothing of a commit that names no pull request", () => {
  const text = ["@@\tsha3957\tMerge pull request #3957 from a11ign/agent/x", "", ".agent-org/roles/liaison.md", "packages/guards/a.test.ts", "@@\tsha0\tA direct commit", "", "docs/x.md", "@@\tsha265\tfix(#254): a squash-merged pull request (#265)", "", "src/y.mjs", "@@\tsha3954\tMerge pull request #3954 from a11ign/agent/y", "", ".github/workflows/release.yml"].join("\n");
  const paths = parseMergePaths(text, ROW_REPO);
  assert.deepEqual([...paths], [[`${ROW_REPO}#3957`, [".agent-org/roles/liaison.md", "packages/guards/a.test.ts"]], [`${ROW_REPO}#265`, ["src/y.mjs"]], [`${ROW_REPO}#3954`, [".github/workflows/release.yml"]]]);
});

test("parseMergePaths: a merge commit repeated once per parent keeps its FIRST section, the first parent's, and a later parent's diff replaces nothing (reviewer-agent-org-350)", () => {
  const text = ["@@\tsha7\tMerge pull request #7 from a11ign/agent/x", "", "packages/agent-org/keep.mjs", "@@\tsha7\tMerge pull request #7 from a11ign/agent/x", "", "docs/unrelated.md", "@@\tsha8\tMerge pull request #8 from a11ign/agent/y", "", "docs/y.md"].join("\n");
  assert.deepEqual([...parseMergePaths(text, ROW_REPO)], [[`${ROW_REPO}#7`, ["packages/agent-org/keep.mjs"]], [`${ROW_REPO}#8`, ["docs/y.md"]]]);
});

test("readMergePaths: the command as run, on a real merge whose first parent holds an unrelated change, reads the pull request's own paths and not the first parent's other work", () => {
  const checkout = mkdtempSync(join(tmpdir(), "merge-paths-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", checkout, "-c", "user.email=a@b", "-c", "user.name=n", "-c", "commit.gpgsign=false", ...args], { env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] });
    const commitFile = (path, message) => { mkdirSync(join(checkout, path, ".."), { recursive: true }); writeFileSync(join(checkout, path), message); git("add", "."); git("commit", "-qm", message); };
    git("init", "-q", "-b", "main");
    commitFile("README", "base");
    git("checkout", "-qb", "pr");
    commitFile("packages/agent-org/keep.mjs", "the pull request");
    git("checkout", "-q", "main");
    commitFile("docs/unrelated.md", "other work on main");
    git("merge", "-q", "--no-ff", "pr", "-m", "Merge pull request #7 from a11ign/agent/x");
    git("update-ref", "refs/remotes/origin/main", "main");
    const { paths, note } = readMergePaths({ checkout, rowRepo: ROW_REPO, since: 0 });
    assert.equal(note, null);
    assert.deepEqual([...paths], [[`${ROW_REPO}#7`, ["packages/agent-org/keep.mjs"]]]); // a population of one, not an empty map: the positive control
    assert.equal(readMergePaths({ checkout: join(checkout, "absent"), rowRepo: ROW_REPO, since: 0 }).paths.size, 0);
  } finally { rmSync(checkout, { recursive: true, force: true }); }
});

// THE DERIVATION: one transcript whose window growth is known by hand.
const order = (timestamp, session) => JSON.stringify({ type: "user", timestamp, message: { role: "user", content: `\n\n<pasted_content id="1">\nYou are \`${session}\` -- an order.\n</pasted_content>` } });
const result = (timestamp) => JSON.stringify({ type: "user", timestamp, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
const message = (timestamp, id, tools, [input, output, cacheRead, cacheWrite]) => JSON.stringify({
  type: "assistant", timestamp, message: { id, model: "claude-sonnet-5-5", role: "assistant", content: tools.map((name) => ({ type: "tool_use", id: `${id}-${name}`, name, input: {} })),
    usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cacheWrite } } },
});
const T = (minute) => `2026-10-04T10:${String(minute).padStart(2, "0")}:00.000Z`;
const READS = [
  order(T(0), "worker-9001"),
  message(T(1), "m1", ["Read"], [2, 40, 1000, 500]), // window 1502, output 40
  result(T(2)),
  message(T(3), "m2", ["Grep", "Glob"], [3, 10, 1500, 400]), // window 1903: grew 1903 - 1502 - 40 = 361 over m1, the Read's
  result(T(4)),
  message(T(5), "m3", ["Bash"], [1, 7, 1900, 800]), // window 2701: grew 2701 - 1903 - 10 = 788 over m2, a Grep and a Glob: mixed
  result(T(6)),
  message(T(7), "m4", ["Read"], [1, 5, 2700, 500]), // window 3201, over m3 which called no read tool: nothing
  order(T(8), "worker-9001"), // an order between m4 and m5: the window grew by more than a result
  message(T(9), "m5", ["Bash"], [1, 5, 3200, 700]),
].join("\n");
const readsOf = (events) => Object.fromEntries(events.filter((event) => event.kind === "turn").map((event) => [event.id.replace("turn:", ""), event.toolRead]));
const readTranscript = (text, carry = null) => eventsOfTranscript({ text, file: "t.jsonl", ledger: [], rowRepo: ROW_REPO, carry });

test("TOOL READ derivation: the window's growth less the previous output, the tool or mixed, nothing after a tool that is not read, null tokens after an order", () => {
  const reads = readsOf(readTranscript(READS).events);
  assert.deepEqual(reads.m1, null, "the first message follows an order and a Read of nothing: no read call came before it");
  assert.deepEqual(reads.m2, { tool: "Read", tokens: 361 }, "1903 - 1502 - 40");
  assert.deepEqual(reads.m3, { tool: "mixed", tokens: 788 }, "a Grep and a Glob in one message: in no tool's figure");
  assert.equal(reads.m4, null, "m3 called Bash only");
  assert.deepEqual(reads.m5, { tool: "Read", tokens: null }, "an order came between: not derivable, never a guess and never 0");
});

test("TOOL READ derivation: a read that resumes from the carry derives the same as one read of the whole transcript, and without the carry it cannot", () => {
  const lines = READS.split("\n");
  const first = readTranscript(`${lines.slice(0, 4).join("\n")}\n`);
  const resumed = readTranscript(`${lines.slice(4).join("\n")}`, first.carry);
  assert.deepEqual({ ...readsOf(first.events), ...readsOf(resumed.events) }, readsOf(readTranscript(READS).events), "the same as one whole read: m3, whose previous message m2 is in the first read, is derived in the second");
  assert.deepEqual(readsOf(resumed.events).m3, { tool: "mixed", tokens: 788 }, "POSITIVE CONTROL: the resumed read derives something");
  assert.equal(readsOf(readTranscript(`${lines.slice(4).join("\n")}`).events).m3, null, "with nothing carried there is no previous message to grow from: null");
});

test("TOOL-READ TOKENS: a Codex reviewer's turn is unmeasured and in no denominator, so it neither makes the figure a floor nor dilutes its share", () => {
  const events = [
    turn({ when: "2026-09-22T10:00:00Z", session: "worker-101", row: 101, cost: 1, tokens: [10, 0, 990, 0], toolRead: { tool: "Read", tokens: 100 } }),
    turn({ when: "2026-09-22T11:00:00Z", session: "reviewer-1101", pr: 1101, cost: null, model: "gpt-x", tokens: [10, 0, 99990, 0], harness: "codex" }), // no `toolRead`: Codex's tools are not Claude's
  ];
  const [{ byRepo: [cut] }] = aggregate({ events, pulls: [pull(1101, 101, "2026-09-22T08:00:00Z", "2026-09-23T10:00:00Z")], rowRepo: ROW_REPO, now: NOW, since: WEEK_A, held: { from: HELD_FROM, basis: "fixture" } }).weeks;
  assert.deepEqual([cut.toolRead.total, cut.toolRead.floorRows], [100, 0], "the Claude turn's 100 tokens, and no floor for a turn that was never measurable");
  near(cut.toolRead.share, 100 / 1000); // of the 1000 tokens of the turn that has the figure, not of the 101,000 the row holds
});

test("readMoves: the closing time of each move's row, null (never a guess) when the budget stopped the call, and a failure that is not the budget is thrown", () => {
  const closed = { 2974: "2026-10-02T18:13:06Z", 2703: "2026-10-06T05:54:15Z" };
  const moves = readMoves({ rowRepo: ROW_REPO, gh: (args) => ({ closed_at: closed[Number(args[0].split("/").pop())] }) });
  assert.deepEqual(moves.map((move) => [move.name, move.row, move.at]), [["agent-org", 2974, at(closed[2974])], ["lab", 2703, at(closed[2703])]]);
  const spent = readMoves({ rowRepo: ROW_REPO, gh: () => { throw Object.assign(new Error("budget"), { code: "GH_CALLS_SPENT" }); } });
  assert.deepEqual(spent.map((move) => move.at), [null, null]);
  assert.throws(() => readMoves({ rowRepo: ROW_REPO, gh: () => { throw new Error("HTTP 404"); } }), { message: /could not read when the move closed/ });
});
