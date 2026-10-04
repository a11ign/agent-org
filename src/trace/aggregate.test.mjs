// a11ign/a11ign#3513 (slice 6 of #3494): `trace --aggregate`. Fixtures only: nothing here reads `~/.claude`, `~/.cache/a11ign` or GitHub.
// no-token: gh -- every source is an injected fixture; `aggregate` is a pure function and calls no `gh`
//
// TWO WEEKS, so "never pooled" can fail: A (Mon 2026-09-21) holds rows 101 and 102, B (Mon 2026-09-28) holds 201 and 202, and the figures of the two differ. Row 301 is OPEN and
// dear, so an average that lets it in moves a figure the test names. The hand-computed numbers are in the comments beside the assertion that uses them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregate, compareWeeks, DEFINITIONS, nearestRank, NOT_DERIVABLE, NOT_HELD, renderAggregate, weekStart } from "./aggregate.mjs";

const ROW_REPO = "a11ign/a11ign";
const at = (iso) => Date.parse(iso);
const WEEK_A = at("2026-09-21T00:00:00Z");
const WEEK_B = at("2026-09-28T00:00:00Z");
const NOW = at("2026-10-06T00:00:00Z");
const HELD_FROM = at("2026-09-21T00:00:00Z"); // the store's first transcripts: the start of week A, so both weeks are complete
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

const SONNET = "claude-sonnet-5-5";
let serial = 0;
/** A turn event in the store's shape. `tokens` is [input, output, cacheRead, cacheWrite1h]; `cost` null is an unpriced turn. */
const turn = ({ when, session, row = null, cost, tokens = [1, 1, 1, 0], model = SONNET, ...rest }) => ({
  id: `turn:${(serial += 1)}`, kind: "turn", source: "transcript", at: at(when), session, row, pr: null, repo: null, cause: null, causeKey: null, wakeId: null, model,
  tokens: { input: tokens[0], output: tokens[1], cacheRead: tokens[2], cacheWrite5m: 0, cacheWrite1h: tokens[3] }, costUsd: cost, wallClockMs: 1000, sidechain: false, ...rest,
});
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
  turn({ when: "2026-09-29T10:05:00Z", session: "product-manager", cost: 0.7, tokens: [1000, 500, 100000, 0], wakeId: "wake:pm:3" }),
  turn({ when: "2026-09-30T12:05:00Z", session: "ceo", cost: 0.2, tokens: [500, 100, 50000, 0] }),
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
  assert.equal(total.floor, false);
});

test("REPEAT CLASSES: a class whose turns are all unpriced is not derivable (never 0), and the week before has none of week B's repeats", () => {
  const unpriced = EVENTS.map((event) => (event.id === EVENTS.find((candidate) => candidate.kind === "turn" && candidate.wakeId === "wake:pm:2").id ? { ...event, costUsd: null } : event));
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
