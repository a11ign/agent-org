// no-token: none -- pure
// A11-366: doctor lists the open reliability tickets with their current figures
import { test } from "node:test";
import assert from "node:assert/strict";
import type { HealthFigures } from "../health-figures.ts";
import { reliabilityRows } from "./rows.ts";
import { advance, newWatch, type Facts, type Watch } from "./watch.ts";

const figures = (holds: number): HealthFigures => ({
  at: 0, uptimeMs: 0, loop: { lastMinute: { p50Ms: 1, p99Ms: 9 }, lastHour: { p50Ms: 1, p99Ms: 40 } }, syncHolds: { lastHour: holds, holdMs: 100 },
  calls: { linear: { calls: 100, failures: 0, failuresPer100: 0 }, github: { calls: 0, failures: 0, failuresPer100: 0 } },
  runs: { sinceLastStartMs: null, startable: 0, freeSlots: 3, starting: 0, oldestStartingMs: null, holding: null }, fill: { sinceLastCompletedMs: null, lastEarlyReturn: null },
});
const spec = { figure: "sync-holds", threshold: 10, windowMs: 86_400_000 } as const;
const open = (key: string): Watch => newWatch({ key, title: `Title ${key}`, url: null, origin: "ticket" }, spec);
const facts = (value: number): Facts => ({ now: 1_000, completed: true, installed: true, read: { value, readings: { at: 1_000, lines: [] } } });

test("an open ticket is listed with its figure, its threshold and its current reading", () => {
  const [row] = reliabilityRows([open("A11-5")], figures(3));
  assert.deepEqual(row, { name: "reliability A11-5", detail: "Title A11-5: synchronous holds under 10 an hour, for 1d; synchronous holds 3 an hour now; not closed yet", warning: false, fix: null });
});

test("a watched ticket says when its window began and ends; one whose figure is at its threshold now is a warning", () => {
  const watching = advance(open("A11-6"), facts(2));
  const [row] = reliabilityRows([watching], figures(10));
  assert.match(row!.detail, /synchronous holds 10 an hour now; watched since 1970-01-01T00:00:01\.000Z, the window ends 1970-01-02T00:00:01\.000Z$/);
  assert.equal(row!.warning, true);
});

test("a held ticket is not listed, a ticket with no figure is a warning that says why, and rows are in key order", () => {
  const held: Watch = { ...open("A11-1"), state: "held" };
  const unmeasured = newWatch({ key: "A11-3", title: "t", url: null, origin: "ticket" }, null, "its Done-when has no `Figure:` line");
  const rows = reliabilityRows([open("A11-4"), held, unmeasured], null);
  assert.deepEqual(rows.map(({ name, warning }) => [name, warning]), [["reliability A11-3", true], ["reliability A11-4", false]]);
  assert.match(rows[0]!.detail, /^labelled board-reliability, and its Done-when has no `Figure:` line$/);
  assert.match(rows[0]!.fix ?? "", /the figures are synchronous holds, loop lag p99, Linear failures, GitHub failures/);
  assert.match(rows[1]!.detail, /no reading now/);
});

test("a backfilled ticket this board has never seen closed is not listed, so a board without A11-282 shows no row for it", () => {
  const backfill: Watch = { ...open("A11-282"), origin: "backfill" };
  assert.deepEqual(reliabilityRows([backfill], null), []);
  assert.equal(reliabilityRows([advance(backfill, facts(1))], null).length, 1);
});
