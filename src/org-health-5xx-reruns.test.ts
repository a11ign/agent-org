// no-token: pure -- every reading is a function of facts handed in; nothing here calls `gh`, git or the fleet.
// agent-org#1218 (follow-up to #1180): org health counts the 5xx reruns, `required-red-on-5xx` and `manual-reruns`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SIGNALS, manualRerunsReading, orgHealthReadings, readRerunsOn5xx, requiredRedOn5xxReading, rerunsPerDay } from "./org-health.ts";
import { CI_RERUN_LEDGER_FILE, rerunLedgerLine } from "./ci-rerun-on-5xx.ts";

const NOON = Date.parse("2026-10-15T12:00:00Z");
const YESTERDAY = Date.parse("2026-10-14T12:00:00Z");
const line = (at: number, runId: number) => `${at}\t${rerunLedgerLine("a11ign/a11ign", runId, "abcdef12", { action: "rerun", reason: "the last error is a GitHub 5xx: HTTP 502" })}\n`;
const text5xx = "##[error]HTTP 502: Bad Gateway";

test("the ledger file name is the one the tick writes", () => {
  assert.equal(CI_RERUN_LEDGER_FILE, "ci-reruns-on-5xx");
});

test("required-red-on-5xx counts today's reruns with their run ids, and not another day's", () => {
  const reruns = readRerunsOn5xx({ path: "x", read: () => line(NOON, 20) + line(NOON, 10) + line(YESTERDAY, 5) });
  const reading = requiredRedOn5xxReading({ now: NOON + 1000, reruns });
  assert.equal(reading.signal, SIGNALS.REQUIRED_RED_ON_5XX);
  assert.equal(reading.status, "tripped");
  assert.match(reading.detail, /^2 required checks were rerun on a GitHub 5xx on 2026-10-15: run 10, run 20$/);
  assert.deepEqual([...rerunsPerDay(reruns!)].sort(), [["2026-10-14", [5]], ["2026-10-15", [10, 20]]]);
});

test("a day with no rerun is a zero, not an absent reading", () => {
  const reading = requiredRedOn5xxReading({ now: NOON, reruns: readRerunsOn5xx({ path: "x", read: () => line(YESTERDAY, 5) }) });
  assert.equal(reading.status, "clear");
  assert.match(reading.detail, /^0 required checks were rerun on a GitHub 5xx on 2026-10-15$/);
});

test("a missing ledger is zero reruns, and an unreadable or malformed one is unknown", () => {
  const enoent = () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); };
  assert.deepEqual(readRerunsOn5xx({ path: "x", read: enoent }), []);
  assert.equal(readRerunsOn5xx({ path: "x", read: () => { throw new Error("EACCES"); } }), null);
  assert.equal(readRerunsOn5xx({ path: "x", read: () => "not a ledger line\n" }), null);
  assert.equal(requiredRedOn5xxReading({ now: NOON, reruns: null }).status, "unknown");
});

test("manual-reruns counts a person's rerun of a run whose last error was a 5xx", () => {
  const ledger = [{ at: NOON, runId: 1, repo: "a11ign/a11ign" }];
  const seen = [
    { runId: 2, at: NOON, log: text5xx, byPerson: true },                       // a miss: counted
    { runId: 1, at: NOON, log: text5xx, byPerson: true },                       // the tick's own rerun, whoever the host names
    { runId: 3, at: NOON, log: "##[error]expected 1 to equal 2", byPerson: true }, // a person rerunning a real failure
    { runId: 4, at: NOON, log: text5xx, byPerson: false },                      // not a person
    { runId: 5, at: YESTERDAY, log: text5xx, byPerson: true },                  // another day
  ];
  const reading = manualRerunsReading({ now: NOON, seen, ledger });
  assert.equal(reading.signal, SIGNALS.MANUAL_RERUNS);
  assert.equal(reading.status, "tripped");
  assert.match(reading.detail, /^1 run whose last error was a GitHub 5xx was rerun by a person on 2026-10-15: run 2$/);
});

test("manual-reruns on a day with none is a zero, and an unread input is unknown, never zero", () => {
  const clear = manualRerunsReading({ now: NOON, seen: [], ledger: [] });
  assert.equal(clear.status, "clear");
  assert.match(clear.detail, /^0 runs whose last error was a GitHub 5xx were rerun by a person on 2026-10-15$/);
  assert.equal(manualRerunsReading({ now: NOON, seen: null, ledger: [] }).status, "unknown");
  assert.equal(manualRerunsReading({ now: NOON, seen: [], ledger: null }).status, "unknown");
});

test("orgHealthReadings carries both signals when asked and neither when not", () => {
  const base = { now: NOON, lastMergedAt: null, work: null, redPrs: null, refusals: null, drift: null, primarySince: null };
  const names = (facts: Parameters<typeof orgHealthReadings>[0]) => orgHealthReadings(facts).map((r) => r.signal);
  assert.ok(!names(base).includes(SIGNALS.REQUIRED_RED_ON_5XX));
  assert.ok(!names(base).includes(SIGNALS.MANUAL_RERUNS));
  const asked = names({ ...base, rerunsOn5xx: [], rerunsSeen: [] });
  assert.ok(asked.includes(SIGNALS.REQUIRED_RED_ON_5XX) && asked.includes(SIGNALS.MANUAL_RERUNS));
});
