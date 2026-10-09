// no-token: CORRECTION_KIND -- every read here is an injected ledger; the live line is the next daily retrospective, quoted on the row
// a11ign/a11ign#4453: chairman corrections per UTC day beside the spend pace (epic #4437's headline metric).
//
// POSITIVE CONTROLS (the vacuity failure from both sides): each "not counted" case has a twin counted over the same window, so a counter that returns 0 for
// everything is red on the twin and one that counts every line is red on the exclusion. `unknown`, `no baseline` and `0` are asserted to differ in the same
// pair of cases. Mutations, both directions, are pasted in the pull request.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FailureEntry } from "./failure-ledger.ts";
import { CORRECTION_KIND, correctionsLine, correctionsPerDay } from "./found-by-chairman.ts";
import { buildReport, renderReport } from "./org-retro.ts";

// A run on 2026-10-09 reads the seven whole UTC days 2026-10-02 .. 2026-10-08.
const NOW = new Date("2026-10-09T06:00:00Z");
const UNIDENTIFIED = "unidentified-caller-order";

const entry = (classKey: string, at: string, ref = `${classKey}@${at}`): FailureEntry => ({ classKey, at: Date.parse(at), ref });
const correction = (at: string) => entry(CORRECTION_KIND, at);
/** @param {ReturnType<typeof correctionsPerDay>} report @returns {Record<string, number | string>} day -> count */
const byDay = ({ days }: ReturnType<typeof correctionsPerDay>) => Object.fromEntries(days.map(({ day, count }) => [day, count]));
/** the ledger text `parseFailureLedger` reads */
const ledgerText = (entries: FailureEntry[]) => entries.map((e) => `${e.classKey}\t${e.at}\t${e.ref}\n`).join("");

// The earliest line of every ledger below, so only the days a test means are `no baseline`.
const FIRST = entry("main-red", "2026-10-01T00:00:00Z");

test("the window is the seven whole UTC days before the run's day, oldest first", () => {
  const { days } = correctionsPerDay([FIRST], NOW);
  assert.deepEqual(days.map((d) => d.day), ["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
});

test("three entries on one UTC day and one on the next print 3 and 1", () => {
  const entries = [FIRST, correction("2026-10-07T00:00:00Z"), correction("2026-10-07T09:30:00Z"), correction("2026-10-07T23:59:59Z"), correction("2026-10-08T12:00:00Z")];
  const report = correctionsPerDay(entries, NOW);
  assert.equal(byDay(report)["2026-10-07"], 3);
  assert.equal(byDay(report)["2026-10-08"], 1);
  assert.equal(byDay(report)["2026-10-06"], 0, "the twin: a day with none is a real 0 once the ledger has begun");
  assert.match(correctionsLine(report), /10-07 3, 10-08 1/);
});

test("a ledger that cannot be read prints unknown for every day, never 0", () => {
  const report = correctionsPerDay(null, NOW);
  assert.ok(report.days.every((d) => d.count === "unknown"));
  assert.equal(report.verdict, "unknown");
  assert.doesNotMatch(correctionsLine(report), /\d\d-\d\d 0\b/, "no day is printed as 0");
  assert.match(correctionsLine(report), /10-08 unknown/);
});

test("a day before the ledger's first line prints no baseline, and the day of it prints a count", () => {
  const entries = [entry("main-red", "2026-10-05T14:00:00Z"), correction("2026-10-06T01:00:00Z")];
  const counts = byDay(correctionsPerDay(entries, NOW));
  assert.equal(counts["2026-10-04"], "no baseline");
  assert.equal(counts["2026-10-02"], "no baseline");
  assert.equal(counts["2026-10-05"], 0, "the day holding the first line is read: a real 0 beside the no-baseline days");
  assert.equal(counts["2026-10-06"], 1);
});

test("a ledger read and holding no line has no first line: every day is no baseline, not 0", () => {
  const report = correctionsPerDay([], NOW);
  assert.ok(report.days.every((d) => d.count === "no baseline"));
  assert.equal(report.verdict, "no baseline");
});

test("unidentified-caller-order entries are not corrections", () => {
  const mixed = [FIRST, entry(UNIDENTIFIED, "2026-10-08T01:00:00Z"), entry(UNIDENTIFIED, "2026-10-08T02:00:00Z"), correction("2026-10-08T03:00:00Z")];
  assert.equal(byDay(correctionsPerDay(mixed, NOW))["2026-10-08"], 1);
  assert.equal(byDay(correctionsPerDay([FIRST, ...mixed.slice(1, 3)], NOW))["2026-10-08"], 0, "the twin: the proxy alone counts nothing");
});

test("an entry at midnight belongs to the day it opens, and one outside the window is not counted", () => {
  const entries = [FIRST, correction("2026-10-08T00:00:00Z"), correction("2026-10-09T00:00:00Z"), correction("2026-10-01T23:59:59Z")];
  const counts = byDay(correctionsPerDay(entries, NOW));
  assert.equal(counts["2026-10-08"], 1, "the run's own day is not a whole day and is not read");
  assert.equal(counts["2026-10-07"], 0);
  assert.equal(Object.keys(counts).includes("2026-10-01"), false);
});

test("the trend is the last whole day against the one before it, and a non-number is never a delta", () => {
  const verdict = (entries: FailureEntry[] | null) => correctionsPerDay(entries, NOW).verdict;
  assert.equal(verdict([FIRST, correction("2026-10-07T01:00:00Z"), correction("2026-10-07T02:00:00Z")]), "better");
  assert.equal(verdict([FIRST, correction("2026-10-08T01:00:00Z")]), "worse");
  assert.equal(verdict([FIRST, correction("2026-10-07T01:00:00Z"), correction("2026-10-08T01:00:00Z")]), "same");
  assert.equal(verdict([entry("main-red", "2026-10-08T01:00:00Z")]), "no baseline", "the day before the last precedes the ledger");
  assert.equal(verdict(null), "unknown");
});

test("the retrospective prints the line beside the spend pace, and an unreadable ledger says unknown there", () => {
  const reads = { merged: [], openPrs: [], journal: "", ledger: "", turns: [], handFixes: null };
  const now = NOW.getTime();
  const read = renderReport(buildReport({ ...reads, failureLedger: ledgerText([FIRST, correction("2026-10-07T01:00:00Z")]) }, now));
  assert.match(read, /Chairman corrections per UTC day \(target 0\): .*10-07 1, 10-08 0;/);
  const lines = read.split("\n");
  const at = (pattern: RegExp) => lines.findIndex((l) => pattern.test(l));
  assert.ok(at(/HAND FIXES/) < at(/Chairman corrections/), "after the hand-fix line of the spend block");
  for (const failureLedger of [null, undefined, "not a ledger line\n"]) {
    const refused = renderReport(buildReport({ ...reads, failureLedger }, now));
    assert.match(refused, /Chairman corrections per UTC day \(target 0\): 10-02 unknown,/, `failureLedger ${JSON.stringify(failureLedger)} is unknown`);
  }
});
