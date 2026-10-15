// agent-org#1205: the floor from what the decision led to. Parsed decision-log lines only: no file, no switch, no provider, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { calibrateFloors, COMPACTIONS_TOO_MANY, FIRST_PASS_MERGED, FLAT_FLOOR, MIN_SAMPLE, TURNS_TOO_MANY } from "./confidence-floors.ts";

const USE = "model-routing";
const QUESTION = "mechanical";

/** A REQUEST line with one answer per question, each at the given confidence. */
const request = (id: string | undefined, confidence: number, at = 1): Record<string, unknown> => ({
  use: USE, ...(id === undefined ? {} : { id }), fields: ["title"], questions: [QUESTION],
  answers: { [QUESTION]: { value: "yes", confidence, fellBack: false } }, via: "jev", fellBack: false, outcome: "asked", at,
});
const outcome = (id: string, label: string): Record<string, unknown> => ({ use: USE, id, outcome: label, at: 2 });
/** `n` routings at one confidence, each closed by `label`, named from `prefix`. */
const routings = (prefix: string, n: number, confidence: number, label: string): Record<string, unknown>[] =>
  Array.from({ length: n }, (_, i) => [request(`${prefix}-${i}`, confidence), outcome(`${prefix}-${i}`, label)]).flat();

test("a floor moves UP when the answers just above the flat floor were wrong", () => {
  // Answers at 0.75 (above the flat 0.7) were not first-pass merges; answers at 0.95 were. The floor must sit above 0.75.
  const lines = [...routings("wrong", 40, 0.75, "not-first-pass"), ...routings("right", 40, 0.95, FIRST_PASS_MERGED)];
  const reading = calibrateFloors(lines, { use: USE }).floors[QUESTION];
  assert.equal(reading?.calibrated, true);
  assert.equal(reading?.floor, 0.8, "0.75 keeps 50% right, so the floor is the first grid value above it that keeps only the 0.95 answers");
  assert.ok((reading?.floor ?? 0) > FLAT_FLOOR);
  // Negative control: the same 0.75 answers, right instead of wrong, do not move the floor up.
  const control = [...routings("wrong", 40, 0.75, FIRST_PASS_MERGED), ...routings("right", 40, 0.95, FIRST_PASS_MERGED)];
  assert.equal(calibrateFloors(control, { use: USE }).floors[QUESTION]?.floor, 0.5, "all answers right: the floor drops to the bottom of the grid");
});

test("a floor moves DOWN when the answers below the flat floor were right", () => {
  // Answers at 0.6, under the flat 0.7, were first-pass merges, so the floor falls below 0.7.
  const lines = [...routings("low", 40, 0.6, FIRST_PASS_MERGED), ...routings("high", 40, 0.95, FIRST_PASS_MERGED)];
  const reading = calibrateFloors(lines, { use: USE }).floors[QUESTION];
  assert.equal(reading?.calibrated, true);
  assert.equal(reading?.floor, 0.5);
  assert.ok((reading?.floor ?? 1) < FLAT_FLOOR);
  // Negative control: the 0.6 answers wrong, and the floor stops at 0.65, which keeps only the 0.95 answers.
  const control = [...routings("low", 40, 0.6, "not-first-pass"), ...routings("high", 40, 0.95, FIRST_PASS_MERGED)];
  assert.equal(calibrateFloors(control, { use: USE }).floors[QUESTION]?.floor, 0.65);
});

test("a sample under the minimum keeps the flat floor, and says so", () => {
  const few = calibrateFloors(routings("few", MIN_SAMPLE - 1, 0.95, FIRST_PASS_MERGED), { use: USE }).floors[QUESTION];
  assert.equal(few?.calibrated, false);
  assert.equal(few?.floor, FLAT_FLOOR);
  assert.match(few?.reason ?? "", /under the minimum/);
  // Negative control: at the minimum the same answers are enough to measure a floor.
  const enough = calibrateFloors(routings("enough", MIN_SAMPLE, 0.95, FIRST_PASS_MERGED), { use: USE }).floors[QUESTION];
  assert.equal(enough?.calibrated, true);
  assert.equal(enough?.floor, 0.5);
});

test("a routing that carries a confidence and no verdict is counted and named, and a verdict removes it", () => {
  const lines = [
    request("row-1", 0.9), outcome("row-1", "route reused"),
    request("row-2", 0.9),
    request(undefined, 0.9, 7),
    request("row-3", 0.9), outcome("row-3", FIRST_PASS_MERGED),
    outcome("row-9", FIRST_PASS_MERGED),
  ];
  const result = calibrateFloors(lines, { use: USE });
  assert.equal(result.judged, 1, "only row-3 has a verdict, and an outcome with no request judges nothing");
  assert.deepEqual(result.unjoined.map((u) => u.name), ["row-1", "row-2", "the request at 7"]);
  assert.equal(result.unjoined[0]?.reason, "no outcome that judges it (last: route reused)");
  assert.equal(result.unjoined[1]?.reason, "no outcome has been recorded");
  // Negative control: a verdict written after row-1's reuse judges it, and it leaves the list.
  const control = calibrateFloors([...lines, outcome("row-1", FIRST_PASS_MERGED)], { use: USE });
  assert.equal(control.judged, 2);
  assert.deepEqual(control.unjoined.map((u) => u.name), ["row-2", "the request at 7"]);
});

test("a later request for an id starts a new routing, and only its own outcomes judge it", () => {
  const lines = [request("row-5", 0.9), outcome("row-5", FIRST_PASS_MERGED), request("row-5", 0.9)];
  const result = calibrateFloors(lines, { use: USE });
  assert.equal(result.judged, 1);
  assert.deepEqual(result.unjoined.map((u) => u.name), ["row-5"], "the second request has no outcome of its own");
  // Negative control: the second request's own outcome judges it, and the first is still judged by its own.
  const control = calibrateFloors([...lines, outcome("row-5", "not-first-pass")], { use: USE });
  assert.equal(control.judged, 2);
  assert.deepEqual(control.unjoined, []);
});

test("a first-pass merge whose session compacted too often, or ran past the turn cap, is wrong, and a figure at the limit is not", () => {
  // Answers at 0.75 merged first-pass, but each session compacted 3 times (over the limit of 2): they are wrong, so the floor moves above 0.75.
  const compacted = new Map(Array.from({ length: 40 }, (_, i) => [`cmp-${i}`, { compactions: COMPACTIONS_TOO_MANY + 1 }] as const));
  const lines = [...routings("cmp", 40, 0.75, FIRST_PASS_MERGED), ...routings("ok", 40, 0.95, FIRST_PASS_MERGED)];
  const reading = calibrateFloors(lines, { use: USE, measured: compacted }).floors[QUESTION];
  assert.equal(reading?.floor, 0.8, "the 0.75 merges compacted over the limit, so only the 0.95 answers are right");
  assert.equal(reading?.calibrated, true);
  // Negative control: the same 0.75 merges with a count AT the limit are still right, and the floor falls to the bottom of the grid.
  const atLimit = new Map(Array.from({ length: 40 }, (_, i) => [`cmp-${i}`, { compactions: COMPACTIONS_TOO_MANY }] as const));
  assert.equal(calibrateFloors(lines, { use: USE, measured: atLimit }).floors[QUESTION]?.floor, 0.5);
  // Turns: the same shape, with the 0.75 merges over the turn cap (wrong) and the 0.95 merges under it.
  const ranLong = new Map(Array.from({ length: 40 }, (_, i) => [`cmp-${i}`, { turns: TURNS_TOO_MANY + 1 }] as const));
  assert.equal(calibrateFloors(lines, { use: USE, measured: ranLong }).floors[QUESTION]?.floor, 0.8, "the 0.75 merges ran past the cap, so only the 0.95 answers are right");
  const atCap = new Map(Array.from({ length: 40 }, (_, i) => [`cmp-${i}`, { turns: TURNS_TOO_MANY }] as const));
  assert.equal(calibrateFloors(lines, { use: USE, measured: atCap }).floors[QUESTION]?.floor, 0.5, "a session AT the cap is a first pass");
  // A figure never makes an unjudged routing judged: no outcome, no verdict, however many compactions or turns.
  const unjudged = calibrateFloors([request("cmp-x", 0.9)], { use: USE, measured: new Map([["cmp-x", { compactions: 9, turns: 999 }]]) });
  assert.equal(unjudged.judged, 0);
  assert.deepEqual(unjudged.unjoined.map((u) => u.name), ["cmp-x"]);
});
