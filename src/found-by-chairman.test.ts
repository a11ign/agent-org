// no-token: LABEL -- every read here is an injected issue list; the live read is run by hand and pasted on the pull request
// a11ign/a11ign#4124: the weekly count of rows the chairman originated, with the target zero printed beside it.
//
// POSITIVE CONTROLS (the vacuity failure from both sides): each "not counted" case has a twin that IS counted over the same window, so a
// counter returning 0 for everything is red on the twin and a counter returning every row is red on the exclusion. `unknown` and `0`
// are asserted to differ in the same pair of cases. Mutations, both directions, are pasted in the pull request.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LABEL, TARGET, foundByChairman, foundByChairmanLine, weeksBefore } from "./found-by-chairman.ts";

// A Thursday run: the week read is the seven whole UTC days before it, 2026-10-01 to 2026-10-07; the one before is 2026-09-24 to 2026-09-30.
const NOW = new Date("2026-10-08T13:00:00Z");
// A Monday run, whose previous week lies wholly after the label's first use.
const LATER = new Date("2026-10-19T06:43:00Z");

/** @param {number} number @param {string} createdAt @param {string[]} [labelNames] */
const row = (number: number, createdAt: string, labelNames: string[] = [LABEL]) => ({ number, createdAt, labelNames });

test("the window is the seven whole UTC days before the run's day, and the week before that", () => {
  const { current, previous } = weeksBefore(NOW);
  assert.deepEqual(current, { since: "2026-10-01T00:00:00Z", until: "2026-10-08T00:00:00Z" });
  assert.deepEqual(previous, { since: "2026-09-24T00:00:00Z", until: "2026-10-01T00:00:00Z" });
});

test("a labelled row opened in the week is counted and named", () => {
  const report = foundByChairman([row(4101, "2026-10-03T09:00:00Z"), row(4102, "2026-10-07T23:59:59Z")], NOW);
  assert.equal(report.count, 2);
  assert.deepEqual(report.numbers, [4101, 4102]);
});

test("a labelled row opened before the week is not counted, and one opened after the window's end is not", () => {
  const rows = [row(4101, "2026-10-03T09:00:00Z"), row(4090, "2026-09-30T23:59:59Z"), row(4120, "2026-10-08T00:00:00Z")];
  const report = foundByChairman(rows, NOW);
  assert.deepEqual(report.numbers, [4101]);
  assert.equal(foundByChairman([row(4090, "2026-09-30T23:59:59Z")], NOW).count, 0, "the twin: the same row alone is a real zero, not a miss");
});

test("an unlabelled row opened in the week is not counted", () => {
  const report = foundByChairman([row(4101, "2026-10-03T09:00:00Z"), row(4103, "2026-10-04T09:00:00Z", ["ready"])], NOW);
  assert.deepEqual(report.numbers, [4101]);
});

test("the report line prints the target 0 beside the count, and the previous week's count with its direction word", () => {
  const rows = [row(4101, "2026-10-21T09:00:00Z"), row(4102, "2026-10-14T09:00:00Z"), row(4103, "2026-10-15T09:00:00Z")];
  const worse = foundByChairmanLine(foundByChairman(rows, new Date("2026-10-26T06:00:00Z")));
  assert.match(worse, /: 1 \(target 0\)/);
  assert.match(worse, /previous week 2026-10-12 to 2026-10-18: 2 \(better\)/);
  const better = foundByChairmanLine(foundByChairman(rows.slice(1), new Date("2026-10-26T06:00:00Z")));
  assert.match(better, /: 0 \(target 0\)/);
  const same = foundByChairmanLine(foundByChairman([row(5, "2026-10-21T09:00:00Z"), row(6, "2026-10-14T09:00:00Z")], new Date("2026-10-26T06:00:00Z")));
  assert.match(same, /previous week 2026-10-12 to 2026-10-18: 1 \(same\)/);
  const worseWord = foundByChairmanLine(foundByChairman([row(5, "2026-10-21T09:00:00Z"), row(6, "2026-10-22T09:00:00Z"), row(7, "2026-10-14T09:00:00Z")], new Date("2026-10-26T06:00:00Z")));
  assert.match(worseWord, /previous week 2026-10-12 to 2026-10-18: 1 \(worse\)/);
  assert.equal(TARGET, 0);
});

test("a week that begins before the label's first use has no baseline, not a zero", () => {
  const line = foundByChairmanLine(foundByChairman([row(4101, "2026-10-03T09:00:00Z")], NOW));
  assert.match(line, /previous week 2026-09-24 to 2026-09-30: no baseline/);
  assert.doesNotMatch(line, /previous week[^;]*: 0/);
});

test("a labelled row whose opening cannot be read prints unknown, never 0", () => {
  const noDate = foundByChairman([row(4101, "2026-10-03T09:00:00Z"), { number: 4104, labelNames: [LABEL] }], NOW);
  assert.equal(noDate.count, null, "a labelled row whose opening cannot be read makes the week unreadable, not smaller");
  assert.match(foundByChairmanLine(noDate), /: unknown \(target 0\)/);
  assert.doesNotMatch(foundByChairmanLine(noDate), /: 0 \(target 0\)/);
});

test("a week with no labelled rows prints 0 over a listing that was read", () => {
  const read = foundByChairmanLine(foundByChairman([row(4103, "2026-10-04T09:00:00Z", ["ready"])], NOW));
  assert.match(read, /: 0 \(target 0\)/);
  assert.doesNotMatch(read, /unknown \(target/);
  assert.equal(foundByChairman([], LATER).count, 0);
});
