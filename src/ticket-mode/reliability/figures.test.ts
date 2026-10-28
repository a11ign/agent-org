// no-token: none -- pure
// A11-366: the Figure line of a reliability ticket's Done-when, and the figures it may name
import { test } from "node:test";
import assert from "node:assert/strict";
import type { HealthFigures } from "../health-figures.ts";
import { BACKFILLED, breaches, DEFAULT_WINDOW_MS, figureOfDescription, MIN_CALLS, parseFigureText, readFigure, saySpec } from "./figures.ts";

const figures = (over: Partial<HealthFigures> = {}): HealthFigures => ({
  at: 0, uptimeMs: 0, loop: { lastMinute: { p50Ms: 1, p99Ms: 9 }, lastHour: { p50Ms: 1, p99Ms: 40 } }, syncHolds: { lastHour: 12, holdMs: 100 },
  calls: { linear: { calls: 200, failures: 6, failuresPer100: 3 }, github: { calls: 5, failures: 5, failuresPer100: 100 } },
  runs: { sinceLastStartMs: null, startable: 0, freeSlots: 3, starting: 0, oldestStartingMs: null, holding: null }, fill: { sinceLastCompletedMs: null, lastEarlyReturn: null, held: [] }, ...over,
});

test("the three examples of the ticket parse to a figure and a threshold, with the epic's 7 days when no window is named", () => {
  assert.deepEqual(parseFigureText("synchronous holds under 10 an hour"), { kind: "figure", spec: { figure: "sync-holds", threshold: 10, windowMs: DEFAULT_WINDOW_MS } });
  assert.deepEqual(parseFigureText("Linear failures under 1%"), { kind: "figure", spec: { figure: "linear-failures", threshold: 1, windowMs: DEFAULT_WINDOW_MS } });
  assert.deepEqual(parseFigureText("loop lag p99 under 100 ms"), { kind: "figure", spec: { figure: "loop-p99", threshold: 100, windowMs: DEFAULT_WINDOW_MS } });
});

test("a window is read after the threshold, and a bad one is refused", () => {
  assert.deepEqual(parseFigureText("sync holds under 5, for 3d"), { kind: "figure", spec: { figure: "sync-holds", threshold: 5, windowMs: 3 * 86_400_000 } });
  assert.deepEqual(parseFigureText("GitHub failures under 2.5% for 6h."), { kind: "figure", spec: { figure: "github-failures", threshold: 2.5, windowMs: 6 * 3_600_000 } });
  assert.match((parseFigureText("sync holds under 5, for 1w") as { why: string }).why, /not a number of minutes, hours or days/);
});

test("a figure the board does not serve, a unit that is not the figure's and a line that is no comparison are refused, each saying why", () => {
  assert.match((parseFigureText("disk space under 10") as { why: string }).why, /not a figure the board serves; it serves synchronous holds, loop lag p99, Linear failures, GitHub failures/);
  assert.match((parseFigureText("Linear failures under 1 ms") as { why: string }).why, /counted in %, not "ms"/);
  assert.match((parseFigureText("things are fine") as { why: string }).why, /is not "<figure> under <number>"/);
});

test("the Figure line is found in the Done-when section, as a bullet or bold, and nowhere else", () => {
  const section = (line: string): string => `## Why\n\n- Figure: Linear failures under 9%\n\n## Done-when\n\n### Before merge\n\n* A test.\n\n### After merge\n\n${line}\n\n## Decisions\n`;
  assert.deepEqual(figureOfDescription(section("* **Figure:** Linear failures under 1%")), { kind: "figure", spec: { figure: "linear-failures", threshold: 1, windowMs: DEFAULT_WINDOW_MS } });
  assert.deepEqual(figureOfDescription(section("Figure: `loop lag p99` under 100 ms, for 1d")), { kind: "figure", spec: { figure: "loop-p99", threshold: 100, windowMs: 86_400_000 } });
  assert.deepEqual(figureOfDescription(section("* Runner: board.")), { kind: "none" }, "the Figure line above the Done-when is not read");
  assert.deepEqual(figureOfDescription(null), { kind: "none" });
});

test("under is strict: a reading at the threshold is a breach", () => {
  assert.deepEqual([breaches(9, { threshold: 10 }), breaches(10, { threshold: 10 }), breaches(10.1, { threshold: 10 })], [false, true, true]);
});

test("each figure reads its place in the health figures; a failure rate over fewer than the least calls reads nothing", () => {
  const read = (id: Parameters<typeof readFigure>[0]) => readFigure(id, figures());
  assert.deepEqual([read("sync-holds"), read("loop-p99"), read("linear-failures"), read("github-failures")], [12, 40, 3, null]);
  assert.equal(MIN_CALLS, 20);
});

test("the tickets the epic closed before there was a watch hold the figures of their symptoms", () => {
  assert.equal(saySpec(BACKFILLED["A11-282"]), "synchronous holds under 10 an hour, for 7d");
  assert.equal(saySpec(BACKFILLED["A11-345"]), "Linear failures under 1%, for 7d");
});
