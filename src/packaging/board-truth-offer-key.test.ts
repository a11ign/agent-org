// no-token: gh -- every input is injected (the canary and pairs IO, the audit fixture, the pure pair step); the file imports org-health.ts for its constants and functions but calls no gh and never reaches isAppLogin
/**
 * agent-org#1670: THE BOARD-DISAGREES ORDER IS KEYED PER (ROW, QUESTION) PAIR, BEHIND `orgHealth.boardTruthPairKey` (default OFF).
 *
 * The order was keyed on the WHOLE findings set, so one new disagreement anywhere on the board changed the key and offered every standing
 * disagreement again. On 2026-10-16 (UTC) the journal holds 32 offers of `board-disagrees-with-reality` and 31 distinct keys, while the
 * distinct (row, question) pairs behind them number 36: the same pair was re-offered inside a key that had changed around it.
 *
 * What this file pins:
 *   (a) the pure step: a pair is offered on first sight, not again while it stands, not again when it leaves and returns inside
 *       `BOARD_TRUTH_CLEAR_MINUTES`, and offered as `:2` when it returns after that;
 *   (b) flag ON emits one tripped reading per offered pair, each keyed on its own pair;
 *   (c) flag OFF (or the canary unreadable) is the ORIGINAL set-keyed discriminator, byte for byte;
 *   (d) the 2026-10-16 journal fixture: 31 distinct keys over 36 pairs.
 *
 * Every IO here is injected. Nothing reads or writes the real state directory.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOARD_TRUTH_CLEAR_MINUTES, BOARD_TRUTH_PAIR_FLAG, boardTruthPairStep, boardTruthReading, boardTruthReadings, type BoardTruthPairs } from "../org-health/board-truth-and-access-readings.ts";
import { SIGNALS } from "../org-health/thresholds.ts";
import { boardTruthPairOffers, emptyCanaryState, machineryFlagOn, parseCanaryState, type BoardTruthPairIo } from "../org-health/fleet-build-readings.ts";
import { withMachineryFlag } from "../org-health.ts";

const MINUTE = 60_000;
const DAY = "2026-10-16";
const T0 = Date.parse("2026-10-16T09:00:00Z");
const SIGNAL = SIGNALS.BOARD_TRUTH;

type Finding = { question: string; number: number; field: string; detail: string; route: string; };
const finding = (number: number, question: string): Finding => ({ question, number, field: "state", detail: `row ${number} ${question}`, route: "product-manager" });
const auditOf = (...findings: Finding[]) => ({ findings, unread: [] as string[], filing: 0, merging: 0, notAsked: [] as string[] });

/** An in-memory IO: the canary file holds `flags`, the pairs file starts absent. */
function memoryIo(flags: Record<string, boolean> = {}): BoardTruthPairIo & { pairs: string | null; } {
  let state = emptyCanaryState();
  for (const [name, on] of Object.entries(flags)) state = withMachineryFlag(state, { name, on });
  const io = {
    pairs: null as string | null,
    readCanary: () => JSON.stringify(state),
    readPairs: () => io.pairs,
    writePairs: (text: string) => { io.pairs = text; },
  };
  return io;
}

/** Drive the pure step through a list of (minutes-from-T0, pairs present) ticks; returns each tick's offered pairs and discriminators. */
function run(ticks: [number, string[]][]) {
  let pairs: BoardTruthPairs = {};
  return ticks.map(([minutes, present]) => {
    const step = boardTruthPairStep({ pairs, present, now: T0 + minutes * MINUTE });
    pairs = step.pairs;
    return step.offers.map((offer) => offer.discriminator);
  });
}

describe("agent-org#1670: the pure pair step", () => {
  const PAIR = "5577wait-already-true";
  const KEY = `${SIGNAL}@${PAIR}`;

  it("offers a pair on first sight and never again while it stands", () => {
    assert.deepEqual(run([[0, [PAIR]], [10, [PAIR]], [60, [PAIR, "1549state-label"]]]), [[KEY], [], [`${SIGNAL}@1549state-label`]]);
  });

  it("does not re-offer a pair that leaves the board and returns inside the clear period, counted from its last sighting", () => {
    // Last on the board at minute 0, absent at 10, back at 119: 119 minutes after the last sighting, inside the period.
    assert.deepEqual(run([[0, [PAIR]], [10, []], [BOARD_TRUTH_CLEAR_MINUTES - 1, [PAIR]]]), [[KEY], [], []]);
  });

  it("re-offers a pair that returns after the clear period, as `:2`, then `:3`", () => {
    const gone = BOARD_TRUTH_CLEAR_MINUTES + 1;
    assert.deepEqual(run([[0, [PAIR]], [10, []], [10 + gone, [PAIR]], [20 + gone, []], [30 + 2 * gone, [PAIR]]]), [[KEY], [], [`${KEY}:2`], [], [`${KEY}:3`]]);
  });

  it("keeps the pair's clock running from its last sighting on the board, not from its first", () => {
    // Seen at 0, 100, 200 minutes: each sighting is inside the clear period of the one before, so none is re-offered.
    assert.deepEqual(run([[0, [PAIR]], [100, [PAIR]], [200, [PAIR]]]), [[KEY], [], []]);
  });
});

describe("agent-org#1670: flag ON emits one reading per offered pair", () => {
  const audit = auditOf(finding(5577, "wait-already-true"), finding(1549, "state-label"));

  it("offers each standing pair on its own key, not the set", () => {
    const io = memoryIo({ [BOARD_TRUTH_PAIR_FLAG]: true });
    const offers = boardTruthPairOffers({ audit, now: T0, io, log: () => {} });
    // In findings order: the audit lists 5577 first.
    assert.deepEqual(offers?.map((offer) => offer.discriminator), [`${SIGNAL}@5577wait-already-true`, `${SIGNAL}@1549state-label`]);
    const readings = boardTruthReadings({ audit, day: DAY, offers });
    assert.deepEqual(readings.map((reading) => reading.discriminator), [`${SIGNAL}@5577wait-already-true`, `${SIGNAL}@1549state-label`]);
    assert.ok(readings.every((reading) => reading.signal === SIGNAL && reading.status === "tripped"));
  });

  it("writes the pairs file, so the next tick does not offer the same pairs again", () => {
    const io = memoryIo({ [BOARD_TRUTH_PAIR_FLAG]: true });
    boardTruthPairOffers({ audit, now: T0, io, log: () => {} });
    assert.ok(io.pairs !== null);
    const again = boardTruthPairOffers({ audit, now: T0 + MINUTE, io, log: () => {} });
    assert.deepEqual(again, []);
  });

  it("with the flag ON and a board with no disagreement, the tick clears the signal", () => {
    const io = memoryIo({ [BOARD_TRUTH_PAIR_FLAG]: true });
    const empty = auditOf();
    assert.equal(boardTruthPairOffers({ audit: empty, now: T0, io, log: () => {} }), undefined);
    assert.deepEqual(boardTruthReadings({ audit, day: DAY, offers: [] }).map((reading) => reading.status), ["clear"]);
  });

  it("a pairs file with a malformed entry makes no order this tick, logs it, and is left as it is", () => {
    const bad = `${JSON.stringify({ "1x": { offers: "bad", lastSeen: "bad" } })}\n`;
    const io = memoryIo({ [BOARD_TRUTH_PAIR_FLAG]: true });
    io.pairs = bad;
    const said: string[] = [];
    assert.deepEqual(boardTruthPairOffers({ audit, now: T0, io, log: (line) => said.push(line) }), []);
    assert.match(said.join(""), /the next tick offers again/);
    assert.equal(io.pairs, bad, "a malformed state is not rewritten");
  });

  it("refuses each malformed entry shape: a key that is not row and question, a fractional or zero count, a non-finite clock, a null entry", () => {
    const malformed = [
      { "row-one": { offers: 1, lastSeen: T0 } },
      { "1state-label": { offers: 1.5, lastSeen: T0 } },
      { "1state-label": { offers: 0, lastSeen: T0 } },
      { "1state-label": { offers: 1, lastSeen: null } },
      { "1state-label": null },
      { "1state-label": [1, 2] },
    ];
    for (const entries of malformed) {
      const text = JSON.stringify(entries);
      const io = memoryIo({ [BOARD_TRUTH_PAIR_FLAG]: true });
      io.pairs = text;
      assert.deepEqual(boardTruthPairOffers({ audit, now: T0, io, log: () => {} }), [], text);
      assert.equal(io.pairs, text, `${text} is not rewritten`);
    }
  });
});

describe("agent-org#1670: flag OFF is the original set-keyed discriminator, byte for byte", () => {
  const audit = auditOf(finding(5577, "wait-already-true"), finding(1549, "state-label"));
  const ORIGINAL = `${SIGNAL}@5577wait-already-true,1549state-label`;

  it("the reading with no offers is the set-keyed string the journal holds", () => {
    assert.equal(boardTruthReading({ audit, day: DAY }).discriminator, ORIGINAL);
    const [reading] = boardTruthReadings({ audit, day: DAY });
    assert.equal(reading.discriminator, ORIGINAL);
    assert.equal(reading.status, "tripped");
  });

  it("the plural reading with `offers` null is the same single set-keyed reading", () => {
    const [reading] = boardTruthReadings({ audit, day: DAY, offers: null });
    assert.equal(reading.discriminator, boardTruthReading({ audit, day: DAY }).discriminator);
  });

  it("flag OFF offers nothing, so the tick passes no offers and the set-keyed reading stands", () => {
    const io = memoryIo();
    assert.equal(boardTruthPairOffers({ audit, now: T0, io, log: () => {} }), undefined);
    assert.equal(io.pairs, null, "a flag-off tick writes no pairs file");
    const [reading] = boardTruthReadings({ audit, day: DAY, offers: undefined });
    assert.equal(reading.discriminator, ORIGINAL);
  });

  it("an unreadable canary reads the flag OFF, logs it, and offers nothing", () => {
    const io: BoardTruthPairIo = { readCanary: () => "{not json", readPairs: () => null, writePairs: () => assert.fail("no write when the flag reads OFF") };
    const said: string[] = [];
    assert.equal(boardTruthPairOffers({ audit, now: T0, io, log: (line) => said.push(line) }), undefined);
    assert.equal(said.length, 1);
    assert.match(said[0], /reads OFF/);
  });

  it("an absent board (no audit) gives no pair offers, and the reading stays unknown", () => {
    const io = memoryIo({ [BOARD_TRUTH_PAIR_FLAG]: true });
    assert.equal(boardTruthPairOffers({ audit: null, now: T0, io, log: () => {} }), undefined);
    assert.equal(boardTruthReadings({ audit: null, day: DAY, offers: undefined })[0].status, "unknown");
  });

  it("a pairs file that cannot be written makes no order this tick, and logs it", () => {
    const io: BoardTruthPairIo = { ...memoryIo({ [BOARD_TRUTH_PAIR_FLAG]: true }), writePairs: () => { throw new Error("EACCES"); } };
    const said: string[] = [];
    assert.deepEqual(boardTruthPairOffers({ audit, now: T0, io, log: (line) => said.push(line) }), []);
    assert.match(said.join(""), /the next tick offers again/);
  });

  it("the flag is registered by name and reads ON only when set to on", () => {
    assert.equal(machineryFlagOn(emptyCanaryState(), BOARD_TRUTH_PAIR_FLAG), false);
    assert.equal(machineryFlagOn(parseCanaryState(JSON.stringify(withMachineryFlag(emptyCanaryState(), { name: BOARD_TRUTH_PAIR_FLAG, on: true }))), BOARD_TRUTH_PAIR_FLAG), true);
  });
});


/**
 * THE 2026-10-16 JOURNAL, UTC: the `board-disagrees-with-reality` offer lines of the wake ledger, `<ISO time> <discriminator>`, in ledger order. The
 * discriminators are the set-keyed strings the code wrote then (`board-disagrees-with-reality@` is dropped here). `5577wait-already-true` is offered at
 * 00:17Z and again at 05:17Z: the same pair, under two different set keys.
 */
const JOURNAL_2026_10_16 = [
  "2026-10-16T00:17:29.567Z 5577wait-already-true",
  "2026-10-16T00:26:50.023Z 1549state-label",
  "2026-10-16T01:24:58.947Z 5584wait-already-true",
  "2026-10-16T05:17:55.505Z 5577wait-already-true",
  "2026-10-16T08:24:19.639Z 5311wait-already-true",
  "2026-10-16T10:29:31.155Z 5600wait-already-true",
  "2026-10-16T10:50:13.520Z 5606duplicate-or-superseded",
  "2026-10-16T10:52:43.295Z 5606duplicate-or-superseded,5608duplicate-or-superseded",
  "2026-10-16T10:56:40.666Z 5606duplicate-or-superseded,5608duplicate-or-superseded,5612duplicate-or-superseded,5613duplicate-or-superseded,5614duplicate-or-superseded,1579duplicate-or-superseded",
  "2026-10-16T11:01:11.643Z 5606duplicate-or-superseded,5608duplicate-or-superseded,5612duplicate-or-superseded,5613duplicate-or-superseded,5614duplicate-or-superseded,5616duplicate-or-superseded,1579duplicate-or-superseded",
  "2026-10-16T11:11:41.143Z 5606duplicate-or-superseded,5608duplicate-or-superseded,5612duplicate-or-superseded,5613duplicate-or-superseded,5614duplicate-or-superseded,5616duplicate-or-superseded",
  "2026-10-16T11:29:36.793Z 5606duplicate-or-superseded,5608duplicate-or-superseded,5612duplicate-or-superseded,5614duplicate-or-superseded,5614parked-without-condition,5616duplicate-or-superseded",
  "2026-10-16T11:40:28.961Z 5603parked-without-condition,5606duplicate-or-superseded,5608duplicate-or-superseded,5612duplicate-or-superseded,5613closing-pr-merged,5613duplicate-or-superseded,5614duplicate-or-superseded,5616duplicate-or-superseded",
  "2026-10-16T11:45:27.517Z 5606duplicate-or-superseded,5608duplicate-or-superseded,5612duplicate-or-superseded,5613closing-pr-merged,5613duplicate-or-superseded,5614duplicate-or-superseded,5616duplicate-or-superseded",
  "2026-10-16T11:48:47.938Z 5605parked-without-condition,5606duplicate-or-superseded,5608duplicate-or-superseded,5612duplicate-or-superseded,5613closing-pr-merged,5613duplicate-or-superseded,5614duplicate-or-superseded,5616duplicate-or-superseded",
  "2026-10-16T12:32:01.488Z 5603parked-without-condition,5607parked-without-condition,5613closing-pr-merged,5615parked-without-condition,5617parked-without-condition,1602duplicate-or-superseded",
  "2026-10-16T12:55:57.580Z 5611parked-without-condition,5613closing-pr-merged,1602duplicate-or-superseded",
  "2026-10-16T13:03:00.503Z 5613closing-pr-merged,1602duplicate-or-superseded",
  "2026-10-16T13:08:13.452Z 5613closing-pr-merged,1602duplicate-or-superseded,1614state-label",
  "2026-10-16T13:22:44.032Z 5604parked-without-condition,5607parked-without-condition,5613closing-pr-merged,1602duplicate-or-superseded",
  "2026-10-16T13:44:37.211Z 5608parked-without-condition,5613closing-pr-merged,5615parked-without-condition,1602duplicate-or-superseded",
  "2026-10-16T14:29:30.234Z 5613closing-pr-merged,5616parked-without-condition,1602duplicate-or-superseded",
  "2026-10-16T14:35:00.241Z 1602duplicate-or-superseded",
  "2026-10-16T14:53:32.845Z 5604wait-already-true,1602duplicate-or-superseded",
  "2026-10-16T14:57:45.153Z 5611parked-without-condition,5618parked-without-condition,1602duplicate-or-superseded",
  "2026-10-16T15:29:37.992Z 5612parked-without-condition,5628wait-already-true,1602duplicate-or-superseded",
  "2026-10-16T16:04:45.112Z 5549parked-without-condition,5605parked-without-condition",
  "2026-10-16T16:12:18.149Z 1620wait-already-true",
  "2026-10-16T16:44:30.840Z 5606parked-without-condition,5609parked-without-condition",
  "2026-10-16T17:06:14.718Z 5610parked-without-condition",
  "2026-10-16T19:20:51.521Z 1646state-label",
  "2026-10-16T19:41:22.196Z 5661wait-already-true,5661wait-already-true",
];

/** The pairs one journal discriminator names: `5577wait-already-true,1549state-label` is two. */
const pairsOf = (discriminator: string) => discriminator.split(",");

describe("agent-org#1670: the 2026-10-16 journal, 31 distinct keys over 36 pairs", () => {
  const discriminators = JOURNAL_2026_10_16.map((line) => line.split(" ")[1]);

  it("holds 32 offer lines of the signal on the day", () => {
    assert.equal(discriminators.length, 32);
  });

  it("holds 31 distinct set-keyed discriminators, which is what the whole-set key produced", () => {
    assert.equal(new Set(discriminators).size, 31);
  });

  it("names 36 distinct (row, question) pairs across those keys: the per-pair key's count for the day", () => {
    const pairs = new Set(discriminators.flatMap(pairsOf));
    assert.equal(pairs.size, 36);
  });

  it("names the one pair offered twice, 5h apart, and the clear period is far shorter than that gap", () => {
    const hours = (time: string) => Date.parse(time) / 3_600_000;
    const times = JOURNAL_2026_10_16.filter((line) => line.endsWith(" 5577wait-already-true")).map((line) => hours(line.split(" ")[0]));
    assert.equal(times.length, 2);
    assert.ok((times[1] - times[0]) * 60 > BOARD_TRUTH_CLEAR_MINUTES, "a pair that left the board between the two offers is offered again, as :2");
  });
});
