// no-token: none -- pure
// A11-363: what the header and doctor flag in the health figures
import { test } from "node:test";
import assert from "node:assert/strict";
import type { HealthFigures } from "./health-figures.ts";
import { CALL_FAILURES_WARN_PER_100, healthFlags, LOOP_P99_WARN_MS } from "./health-flags.ts";

const quiet: HealthFigures = {
  at: 0, uptimeMs: 0, loop: { lastMinute: { p50Ms: 1, p99Ms: 9 }, lastHour: { p50Ms: 1, p99Ms: 40 } }, syncHolds: { lastHour: 0, holdMs: 100 },
  calls: { linear: { calls: 100, failures: 1, failuresPer100: 1 }, github: { calls: 0, failures: 0, failuresPer100: 0 } },
  runs: { sinceLastStartMs: null, startable: 0, freeSlots: 3, starting: 0, oldestStartingMs: null, holding: null },
  fill: { sinceLastCompletedMs: null, lastEarlyReturn: null },
};
const withLoop = (lastMinute: number, lastHour: number): HealthFigures => ({ ...quiet, loop: { lastMinute: { p50Ms: 1, p99Ms: lastMinute }, lastHour: { p50Ms: 1, p99Ms: lastHour } } });

test("the limits are a loop p99 over 100 ms and call failures over 1 in 100: exactly at either is not flagged", () => {
  assert.deepEqual([LOOP_P99_WARN_MS, CALL_FAILURES_WARN_PER_100], [100, 1]);
  assert.deepEqual(healthFlags(quiet, null), []);
  assert.deepEqual(healthFlags(withLoop(100, 100), null), []);
  assert.equal(healthFlags(withLoop(100.1, 5), null).length, 1);
});

test("a loop over the limit in either window is flagged once, naming the windows that are over", () => {
  assert.deepEqual(healthFlags(withLoop(250, 5), null).map(({ text }) => text), ["Event loop lag p99 is 250 ms over the last minute, over 100 ms: background work is holding the board"]);
  assert.match(healthFlags(withLoop(250, 1_500), null)[0]!.text, /250 ms over the last minute and 1\.5 s over the last hour/);
});

test("each service over 1% is flagged on its own", () => {
  const sick: HealthFigures = { ...quiet, calls: { linear: { calls: 50, failures: 5, failuresPer100: 10 }, github: { calls: 200, failures: 3, failuresPer100: 1.5 } } };
  assert.deepEqual(healthFlags(sick, null).map(({ figure, text }) => [figure, text]), [["calls", "Linear calls fail 10 in 100 (5 of 50 in the last hour), over 1"], ["calls", "GitHub calls fail 1.5 in 100 (3 of 200 in the last hour), over 1"]]);
});

test("any watchdog restart in the last day is flagged, with the last one's reason, and a record with none is not", () => {
  const last = { at: 1, reason: "no-start" as const, detail: "2 queued runs could start" };
  assert.deepEqual(healthFlags(null, { restartsLastDay: 0, last: null }), []);
  assert.deepEqual(healthFlags(null, { restartsLastDay: 1, last }).map(({ text }) => text), ["The watchdog restarted the board 1 time in the last day; the last was for no-start: 2 queued runs could start"]);
  assert.match(healthFlags(quiet, { restartsLastDay: 3, last })[0]!.text, /^The watchdog restarted the board 3 times in the last day/);
});

test("an instance that serves no figures flags nothing about them", () => {
  assert.deepEqual([healthFlags(null, null), healthFlags(undefined, undefined)], [[], []]);
});
