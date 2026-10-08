// a11ign/a11ign#3563: `trace --wake-cache`. Fixtures only: nothing here reads `~/.claude`, `~/.cache/a11ign` or GitHub.
// no-token: gh -- every source is an injected fixture; `wakeCache` is a pure function and calls no `gh`
//
// THE FIXTURE is one seat (`ceo`) woken eight times inside the window and once before it, so every class the report prints has a wake in it, and the hand-computed figures are in the
// comments beside the assertion that uses them. The wake before the window (w0) is the PREVIOUS turn of w1: a report that dropped events outside the window would lose w1's gap and its
// window action. A second seat (`orchestrator`) has turns that name no transcript, so what a wake did to its window cannot be told and must print `not derivable`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTION, DEFINITIONS, GAP, isCold, NOT_DERIVABLE, renderWakeCache, wakeCache } from "./wake-cache.mjs";

const T0 = Date.parse("2026-10-05T00:00:00Z");
const minute = (n) => T0 + n * 60_000;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
const WINDOW = { from: minute(0), to: minute(500) };

const wake = (id, session, at) => ({ id, kind: "wake", source: "wake-ledger", at: minute(at), session, row: null, pr: null, repo: null, cause: "x", causeKey: null, wakeId: id });
/** `write` is the 1-hour cache write and `write5m` the 5-minute one; `input` is the uncached input; `cost` null is an unpriced turn. */
const turn = ({ id, session = "ceo", wakeId, at, transcript, write, write5m = 0, input = 2, read = 0, cost, sidechain = false, harness }) => ({
  id: `turn:${id}`, kind: "turn", source: "transcript", at: minute(at), session, row: null, pr: null, repo: null, cause: null, causeKey: null, wakeId, ...(transcript ? { transcript } : {}),
  model: "claude-fable-5-1", tokens: { input, output: 10, cacheRead: read, cacheWrite5m: write5m, cacheWrite1h: write }, costUsd: cost, sidechain, ...(harness ? { harness } : {}),
});
const compaction = (at) => ({ id: `compaction:ceo:${at}`, kind: "compaction", source: "transcript", at: minute(at), session: "ceo", row: null, pr: null, repo: null, cause: null, causeKey: null, wakeId: null });

const CEO = [
  // w0 is BEFORE the window: it is w1's previous turn and no figure of its own.
  wake("w0", "ceo", -60), turn({ id: "t0", wakeId: "w0", at: -59, transcript: "Z", write: 9, cost: 0.01 }),
  // w1 at 0: 59 min after t0 (LONG), a new transcript (cleared). First turn writes 30,000; its second turn writes 0.
  wake("w1", "ceo", 0), turn({ id: "t1a", wakeId: "w1", at: 1, transcript: "A", write: 30_000, read: 23_711, cost: 0.2 }), turn({ id: "t1b", wakeId: "w1", at: 2, transcript: "A", write: 0, read: 54_000, cost: 0.02 }),
  // w2 at 5: 3 min after t1b (SHORT), same transcript (kept).
  wake("w2", "ceo", 5), turn({ id: "t2a", wakeId: "w2", at: 6, transcript: "A", write: 1_000, read: 55_000, cost: 0.03 }),
  // w3 at 20: 14 min after t2a (LONG), kept.
  wake("w3", "ceo", 20), turn({ id: "t3a", wakeId: "w3", at: 21, transcript: "A", write: 2_000, read: 56_000, cost: 0.04 }),
  // w4 at 25: 4 min after t3a (SHORT), new transcript B (cleared). A subagent's sidechain turn of the same wake wrote 50,000 first and is NOT the window's first turn.
  wake("w4", "ceo", 25), turn({ id: "s4", wakeId: "w4", at: 25.5, transcript: "B", write: 50_000, cost: 0.5, sidechain: true }), turn({ id: "t4a", wakeId: "w4", at: 26, transcript: "B", write: 29_000, read: 23_711, cost: 0.15 }),
  // w5 at 206: 180 min after t4a (LAPSED), same transcript (kept) and the cache lapsed, so it writes 31,000 again.
  wake("w5", "ceo", 206), turn({ id: "t5a", wakeId: "w5", at: 207, transcript: "B", write: 31_000, cost: 0.22 }), turn({ id: "t5b", wakeId: "w5", at: 208, transcript: "B", write: 100, read: 31_000, cost: 0.01 }),
  // w6 at 211: a compaction at 209, after t5b (SHORT: 3 min), and its first turn has NO PRICE.
  compaction(209), wake("w6", "ceo", 211), turn({ id: "t6a", wakeId: "w6", at: 212, transcript: "B", write: 33_000, read: 23_711, cost: null }),
  // w7 at 300 started no turn.
  wake("w7", "ceo", 300),
  // w8 at 400: 188 min after t6a (LAPSED), transcript C (cleared). Its two turns end at the SAME minute: the lower id is the first turn, whichever order the store lists them in.
  wake("w8", "ceo", 400), turn({ id: "t8b", wakeId: "w8", at: 401, transcript: "C", write: 7_000, read: 23_711, cost: 0.05 }), turn({ id: "t8a", wakeId: "w8", at: 401, transcript: "C", write: 500, cost: 0.01 }),
];

/** Turns that name no transcript: a store written before #3589. */
const ORCHESTRATOR = [
  wake("o1", "orchestrator", 10), turn({ id: "o1a", session: "orchestrator", wakeId: "o1", at: 11, write: 30_000, read: 23_711, cost: 0.2 }),
  wake("o2", "orchestrator", 20), turn({ id: "o2a", session: "orchestrator", wakeId: "o2", at: 21, write: 1_000, read: 80_000, cost: 0.03 }),
];

/** The gap runs to the ORDER, not to the end of the first turn: lw2 arrives 4 min after l1a ended and its first turn ends 7 min after it. lw3 arrives BEFORE lw2's turn ended. */
const LIAISON = [
  wake("lw1", "liaison", 90), turn({ id: "l1a", session: "liaison", wakeId: "lw1", at: 100, transcript: "L", write: 500, cost: 0.01 }),
  wake("lw2", "liaison", 104), turn({ id: "l2a", session: "liaison", wakeId: "lw2", at: 107, transcript: "L", write: 700, cost: 0.01 }),
  wake("lw3", "liaison", 106), turn({ id: "l3a", session: "liaison", wakeId: "lw3", at: 110, transcript: "L", write: 900, cost: 0.01 }),
];

/**
 * A seat that writes the 5-minute kind, and sits on the cold boundary (#4062). Both first requests have a context of input + read + write = 1,000, so half is 500.
 * pw1: 100 + 400 + 500 = 1,000, write 500 is EXACTLY half (not cold). pw2: 100 + 399 + 501 = 1,000, write 501 is over half (cold).
 */
const PRODUCT_MANAGER = [
  wake("pw1", "product-manager", 10), turn({ id: "p1a", session: "product-manager", wakeId: "pw1", at: 11, transcript: "P", input: 100, read: 400, write: 0, write5m: 500, cost: 0.01 }),
  wake("pw2", "product-manager", 13), turn({ id: "p2a", session: "product-manager", wakeId: "pw2", at: 14, transcript: "P", input: 100, read: 399, write: 501, cost: 0.01 }),
];

const CODEX = [
  turn({ id: "c1", session: "reviewer-9", wakeId: null, at: 30, write: 0, read: 10_000, cost: null, harness: "codex" }),
  turn({ id: "c2", session: "reviewer-9", wakeId: null, at: 31, write: 0, read: 11_000, cost: null, harness: "codex" }),
  turn({ id: "c3", session: "reviewer-12", wakeId: null, at: 32, write: 0, read: 12_000, cost: null, harness: "codex" }),
];

const EVENTS = [...CEO, ...PRODUCT_MANAGER, ...ORCHESTRATOR, ...LIAISON, ...CODEX];
const report = wakeCache({ events: EVENTS, window: WINDOW });
const seat = (name, from = report) => from.seats.find((candidate) => candidate.seat === name);
const action = (name, which) => seat(name).actions.find((candidate) => candidate.action === which);
const gap = (name, which, bucket) => action(name, which).byGap.find((candidate) => candidate.gap === bucket);

test("the first turn after each wake is counted once per wake, never every turn (positive control: counting every turn is RED)", () => {
  const ceo = seat("ceo");
  assert.equal(ceo.wakes, 8); // w1..w8: w0 is before the window
  assert.equal(ceo.noTurn, 1); // w7
  // first turns: w1 30,000, w2 1,000, w3 2,000, w4 29,000 (the sidechain's 50,000 is not the window's), w5 31,000, w6 33,000, w8 500 (t8a, the lower id of two at the same minute)
  assert.equal(ceo.firstWrite, 126_500);
  // every non-sidechain turn written inside the window: the first turns, plus t1b 0, t5b 100 and t8b 7,000 (t0 is before the window)
  assert.equal(ceo.allWrite, 133_600);
  near(ceo.share, 126_500 / 133_600);
});

test("kept, compacted and cleared wakes are three figures, never one (positive control: pooling them is RED)", () => {
  const kept = action("ceo", ACTION.KEPT);
  assert.equal(kept.wakes, 3); // w2, w3, w5
  assert.equal(kept.write.p50, 2_000); // nearest rank of [1,000 2,000 31,000]
  assert.equal(kept.write.total, 34_000);
  const compacted = action("ceo", ACTION.COMPACTED);
  assert.equal(compacted.wakes, 1); // w6, by the compaction at minute 209
  assert.equal(compacted.write.p50, 33_000);
  const cleared = action("ceo", ACTION.CLEARED);
  assert.equal(cleared.wakes, 3); // w1 (transcript Z to A), w4 (A to B), w8 (B to C)
  assert.equal(cleared.write.p50, 29_000); // nearest rank of [500 29,000 30,000]
  assert.equal(cleared.write.p90, 30_000);
  assert.equal(cleared.write.total, 59_500);
  assert.notEqual(kept.write.p50, cleared.write.p50);
  assert.equal(action("ceo", ACTION.UNKNOWN).wakes, 0); // every ceo wake had a previous turn, w0's, which lies BEFORE the window
});

test("each action is split by the gap since the previous turn, and a kept wake after a lapse is its own figure", () => {
  assert.equal(gap("ceo", ACTION.KEPT, GAP.SHORT).write.p50, 1_000); // w2
  assert.equal(gap("ceo", ACTION.KEPT, GAP.LONG).write.p50, 2_000); // w3
  assert.equal(gap("ceo", ACTION.KEPT, GAP.LAPSED).write.p50, 31_000); // w5: kept, and the one-hour cache lapsed
  assert.equal(gap("ceo", ACTION.CLEARED, GAP.SHORT).write.p50, 29_000); // w4
  assert.equal(gap("ceo", ACTION.CLEARED, GAP.LONG).write.p50, 30_000); // w1: 59 min
  assert.equal(gap("ceo", ACTION.CLEARED, GAP.LAPSED).write.p50, 500); // w8
  assert.equal(gap("ceo", ACTION.KEPT, GAP.UNKNOWN).wakes, 0);
});

test("a class with no derivation is `not derivable` and never 0", () => {
  // orchestrator's turns name no transcript, so no wake can be placed as kept or cleared, and there is no compaction
  for (const which of [ACTION.KEPT, ACTION.COMPACTED, ACTION.CLEARED]) assert.equal(action("orchestrator", which).wakes, NOT_DERIVABLE, which);
  assert.equal(action("orchestrator", ACTION.UNKNOWN).wakes, 2);
  assert.equal(gap("orchestrator", ACTION.UNKNOWN, GAP.UNKNOWN).wakes, 1); // o1 has no previous turn
});

test("the gap is the wake's time minus the previous turn's, and is derivable where the window action is not", () => {
  // o2 at minute 20, o1a ended at 11: 9 minutes, which is over 5 and under 60
  assert.equal(gap("orchestrator", ACTION.UNKNOWN, GAP.LONG).wakes, 1);
  assert.equal(gap("orchestrator", ACTION.UNKNOWN, GAP.SHORT).wakes, 0);
});

test("the gap runs to the order and an order that arrived early is in the shortest class", () => {
  assert.equal(gap("liaison", ACTION.KEPT, GAP.SHORT).wakes, 2); // lw2: 104 - 100 = 4 min (to its first turn's end it would be 7, LONG); lw3: 106 - 107 is negative
  assert.equal(gap("liaison", ACTION.KEPT, GAP.LONG).wakes, 0);
  assert.equal(gap("liaison", ACTION.UNKNOWN, GAP.UNKNOWN).wakes, 1); // lw1 has no previous turn
});

test("an unpriced first turn makes its dollars a floor, and a group of only unpriced turns is `not derivable`", () => {
  const compacted = action("ceo", ACTION.COMPACTED);
  assert.equal(compacted.dollars, NOT_DERIVABLE); // w6's turn has no price
  assert.equal(compacted.floor, true);
  assert.equal(compacted.wake.p50, NOT_DERIVABLE);
  const cleared = action("ceo", ACTION.CLEARED);
  near(cleared.dollars, 0.2 + 0.15 + 0.01);
  assert.equal(cleared.floor, false);
  near(cleared.wake.p50, 0.15); // whole wakes: w1 0.22, w4 0.15 (the sidechain turn is not the window's), w8 0.06
  near(action("ceo", ACTION.KEPT).wake.p50, 0.04); // w2 0.03, w3 0.04, w5 0.23
});

test("a Codex reviewer request is counted apart and enters no figure, because it has no cache-write field", () => {
  assert.equal(seat("reviewer-*").wakes, 0);
  assert.deepEqual(report.codexReviewers, { requests: 3, sessions: 2 });
  assert.ok(renderWakeCache(report).includes(`reviewer-*: ${NOT_DERIVABLE}: no wake of a Claude-run reviewer is in the store; 3 Codex requests of 2 reviewer sessions`));
});

test("ties break the same way twice: the order the store lists events in does not change the report", () => {
  const again = wakeCache({ events: [...EVENTS].reverse(), window: WINDOW });
  assert.deepEqual(again, report);
  assert.equal(JSON.stringify(wakeCache({ events: EVENTS, window: WINDOW })), JSON.stringify(report));
});

test("every definition is printed once, at the top, before any seat's figures", () => {
  const text = renderWakeCache(report);
  for (const line of DEFINITIONS) assert.equal(text.split(line).length - 1, 1, line.slice(0, 40));
  assert.ok(text.lastIndexOf(DEFINITIONS.at(-1)) < text.indexOf("ceo: 8 wakes"));
  assert.match(text, /\n {2}kept {11}not derivable\n/); // orchestrator's kept row
  assert.match(text, /ceo: 8 wakes \(7 with a turn, 1 with no turn\)/);
});

test("an empty window is 0 wakes for a seat, never a figure invented from nothing", () => {
  const none = wakeCache({ events: EVENTS, window: { from: minute(1_000), to: minute(2_000) } });
  assert.equal(none.wakes, 0);
  assert.equal(seat("ceo", none).share, NOT_DERIVABLE);
  assert.equal((none.seats[0].actions.find((a) => a.action === ACTION.CLEARED)).wakes, 0);
});

test("the 5-minute and the 1-hour cache writes are two totals, and 5m 0 is a reading beside a seat that has some (positive control: a constant split is RED)", () => {
  // ceo's turns carry only the 1-hour kind: every non-sidechain turn in the window, 133,600 (the same sum as `allWrite`), and no 5-minute token
  assert.deepEqual(seat("ceo").writesByTtl, { fiveMinute: 0, oneHour: 133_600 });
  // product-manager: p1a wrote 500 as 5-minute tokens, p2a 501 as 1-hour tokens
  assert.deepEqual(seat("product-manager").writesByTtl, { fiveMinute: 500, oneHour: 501 });
  const text = renderWakeCache(report);
  assert.match(text, /\nceo: [\s\S]*?\n {2}cache writes of the seat's turns in the window: 5m 0 {2}1h 133,600\n/);
  assert.match(text, /\nproduct-manager: [\s\S]*?\n {2}cache writes of the seat's turns in the window: 5m 500 {2}1h 501\n/);
  for (const name of ["ceo", "product-manager", "orchestrator", "liaison"]) {
    const { fiveMinute, oneHour } = seat(name).writesByTtl;
    assert.equal(fiveMinute + oneHour, seat(name).allWrite, name); // the two kinds are the whole of what the seat wrote
  }
});

test("a first request is cold when its write is MORE than half of input + read + write, and exactly half is not", () => {
  // 100 + 400 + 500 = 1,000: half is 500, and 500 is not more than 500
  assert.equal(isCold({ input: 100, read: 400, write: 500 }), false);
  // 100 + 399 + 501 = 1,000: 501 is more than 500
  assert.equal(isCold({ input: 100, read: 399, write: 501 }), true);
  // 2 + 0 + 500 = 502: half is 251, a write of 500 is cold; and a request with nothing in it is not cold
  assert.equal(isCold({ input: 2, read: 0, write: 500 }), true);
  assert.equal(isCold({ input: 0, read: 0, write: 0 }), false);
  // the same two requests through the report: pw1 (exact half) is the product-manager's `not derivable`-action wake, pw2 (501) is its kept one
  assert.equal(action("product-manager", ACTION.UNKNOWN).cold.cold, 0);
  assert.equal(action("product-manager", ACTION.KEPT).cold.cold, 1);
});

test("the cold rate is printed per window action, and a kept wake after a gap over 5 minutes is not cold unless the 1-hour cache lapsed too", () => {
  // first requests: w1 30,000 write of 53,713 (cold), w2 1,000 of 56,002 (not), w3 2,000 of 58,002 (not), w4 29,000 of 52,713 (cold), w5 31,000 of 31,002 (cold),
  // w6 33,000 of 56,713 (cold), w8 500 of 502 (cold: 500 is over 251)
  const rate = (which, bucket) => (bucket ? gap("ceo", which, bucket) : action("ceo", which)).cold;
  assert.deepEqual([rate(ACTION.KEPT).cold, rate(ACTION.KEPT).wakes], [1, 3]); // only w5
  near(rate(ACTION.KEPT).rate, 1 / 3);
  assert.deepEqual([rate(ACTION.COMPACTED).cold, rate(ACTION.COMPACTED).wakes], [1, 1]);
  assert.deepEqual([rate(ACTION.CLEARED).cold, rate(ACTION.CLEARED).wakes], [3, 3]); // w1, w4, w8
  // the lapse-versus-cleared distinction: kept at 5 min to 1 h (w3, 14 min) is warm; kept past 1 h (w5, 180 min) is the one cold kept wake
  assert.deepEqual([rate(ACTION.KEPT, GAP.LONG).cold, rate(ACTION.KEPT, GAP.LONG).wakes], [0, 1]);
  assert.deepEqual([rate(ACTION.KEPT, GAP.SHORT).cold, rate(ACTION.KEPT, GAP.SHORT).wakes], [0, 1]);
  assert.deepEqual([rate(ACTION.KEPT, GAP.LAPSED).cold, rate(ACTION.KEPT, GAP.LAPSED).wakes], [1, 1]);
  // the seat as a whole: 5 of the 7 first requests with a turn (w7 started none)
  assert.deepEqual([seat("ceo").cold.cold, seat("ceo").cold.wakes], [5, 7]);
  assert.match(renderWakeCache(report), /\n {2}kept {11}3 wakes .*? 1 of 3 cold \(33\.3%\)/);
  assert.match(renderWakeCache(report), /\n {2}cleared {8}3 wakes .*? 3 of 3 cold \(100\.0%\)/);
  assert.match(renderWakeCache(report), /cold-wake rate over all first requests \(write over half the context\): 5 of 7 cold \(71\.4%\)/);
});

test("a seat or a class with no first request prints `not derivable` for the rate, never 0%", () => {
  assert.equal(action("ceo", ACTION.UNKNOWN).cold.rate, NOT_DERIVABLE); // every ceo wake had a previous turn, so none is unplaced: "0 wakes" and no rate
  assert.equal(action("orchestrator", ACTION.KEPT).cold.rate, NOT_DERIVABLE); // no wake of the seat could be placed as kept
  near(seat("orchestrator").cold.rate, 1 / 2); // o1 30,000 of 53,713 (cold), o2 1,000 of 81,002 (not)
  // a window holding only w7, which started no turn: a wake, and no first request, and no turn of the seat to total either
  const noTurn = wakeCache({ events: EVENTS, window: { from: minute(299), to: minute(301) } });
  assert.equal(seat("ceo", noTurn).wakes, 1);
  assert.equal(seat("ceo", noTurn).cold.rate, NOT_DERIVABLE);
  assert.deepEqual(seat("ceo", noTurn).writesByTtl, { fiveMinute: NOT_DERIVABLE, oneHour: NOT_DERIVABLE });
  const text = renderWakeCache(noTurn);
  assert.match(text, /cold-wake rate over all first requests \(write over half the context\): not derivable: the seat has no first request in the window/);
  assert.match(text, /5m not derivable {2}1h not derivable/);
  assert.doesNotMatch(text.slice(text.indexOf("\nwindow ")), /\(0\.0%\)|\b0%/); // the DEFINITIONS above say "never 0%" and are not a figure
  // an empty window: every seat
  const none = wakeCache({ events: EVENTS, window: { from: minute(1_000), to: minute(2_000) } });
  for (const each of none.seats) assert.equal(each.cold.rate, NOT_DERIVABLE, each.seat);
});

test("DEFINITIONS states the cold rule in #4055's words", () => {
  const rule = DEFINITIONS.find((line) => line.startsWith("COLD-WAKE RATE"));
  assert.ok(rule, "no COLD-WAKE RATE definition");
  assert.ok(rule.includes("the share of first requests after an order whose `cache_creation_input_tokens` exceed half the context"));
  assert.ok(DEFINITIONS.some((line) => line.startsWith("CACHE WRITES BY TTL")));
});
