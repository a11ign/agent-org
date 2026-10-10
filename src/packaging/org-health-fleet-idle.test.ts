// no-token: pure -- the reading is a function of values handed in, and nothing here calls GitHub.
/**
 * `src/org-health.ts`, #2937: THE QUESTION THE GATE ASKS ABOUT THE FLEET -- it has captured nothing for a day while something waits for it. (The second question #2937
 * added, the drifting copies, is retired with the copies themselves: a11ign/agent-org#522.)
 *
 * THE THRESHOLD IS WRITTEN OUT AS 24 HOURS HERE, NEVER AS `FLEET_IDLE_HOURS`: a test built from the constant moves with it (`org-health.test.ts`'s rule, for its reason).
 *
 * POSITIVE CONTROL. The idle fleet is replayed as the chairman described it: zero captures for 4.9 days with a `fleet-gated` row waiting.
 *
 * MUTATION, run by hand and recorded on the row: drop the `something is waiting` condition from `fleetIdleReading` (the idle-nobody-needs test goes red and only it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FLEET_IDLE_HOURS, SIGNALS, fleetIdleReading, orgHealthReadings, orgHealthOrders, orgHealthTick,
} from "../org-health.ts";

const HOUR_MS = 3_600_000;
const NOW = Date.parse("2026-10-02T12:00:00Z");

const WAITING = { rows: [2870], labJobs: [] as string[] };
const NOTHING_WAITING = { rows: [] as (number | string)[], labJobs: [] as string[] };
const IDLE_FOR_A_DAY = { captures24h: 0, lastCaptureAt: NOW - 24 * HOUR_MS };

// --- the constant is the row's -------------------------------------------------------------------------------------------

test("the idle window is the chairman's 24 hours, written out here and pinned to the export", () => {
  assert.equal(FLEET_IDLE_HOURS, 24);
});

// --- 1. fleet-idle-while-work-waits ---------------------------------------------------------------------------------------

test("fleet idle: zero captures for 24 h with a row waiting TRIPS, and the detail carries the count and the last-capture time", () => {
  const reading = fleetIdleReading({ now: NOW, fleet: IDLE_FOR_A_DAY, waiting: WAITING });
  assert.equal(reading.status, "tripped");
  assert.equal(reading.signal, "fleet-idle-while-work-waits");
  assert.match(reading.detail, /^0 captures in the last 24 h/, "the count");
  assert.match(reading.detail, /2026-10-01T12:00:00Z/, "the last capture's time");
  assert.match(reading.detail, /#2870/, "what waits");
  assert.equal(reading.firstTrippedAt, NOW, "the last capture plus 24 h, derived rather than remembered");
});

test("fleet idle: a lab job waiting trips it as a row does, and the chairman's 4.9 days is the same reading with a larger age", () => {
  assert.equal(fleetIdleReading({ now: NOW, fleet: IDLE_FOR_A_DAY, waiting: { rows: [], labJobs: ["corpus-recapture"] } }).status, "tripped");
  const days = fleetIdleReading({ now: NOW, fleet: { captures24h: 0, lastCaptureAt: NOW - 118 * HOUR_MS }, waiting: WAITING });
  assert.equal(days.status, "tripped");
  assert.match(days.detail, /\(118 h ago\)/);
});

test("fleet idle: the SAME idleness with nothing waiting is clear -- an idle fleet nobody needs is healthy", () => {
  assert.equal(fleetIdleReading({ now: NOW, fleet: IDLE_FOR_A_DAY, waiting: NOTHING_WAITING }).status, "clear");
});

test("fleet idle: exactly 24 h trips and one millisecond under does not, the window is tested BEFORE what waits, and a capture inside it is clear", () => {
  assert.equal(fleetIdleReading({ now: NOW, fleet: { captures24h: 0, lastCaptureAt: NOW - 24 * HOUR_MS }, waiting: WAITING }).status, "tripped");
  const under = fleetIdleReading({ now: NOW, fleet: { captures24h: 0, lastCaptureAt: NOW - 24 * HOUR_MS + 1 }, waiting: WAITING });
  assert.equal(under.status, "unknown", "zero captures beside a last capture inside the window contradicts itself: said so, believed neither way");
  assert.match(under.detail, /zero captures in the window and a last capture inside it/);
  assert.equal(fleetIdleReading({ now: NOW, fleet: { captures24h: 3, lastCaptureAt: NOW - HOUR_MS }, waiting: null }).status, "clear",
    "a refused waiting read cannot turn a fleet that captured into an unknown");
});

test("fleet idle: an UNREADABLE fleet is unknown, never idle, whatever waits; and an unread waiting list is unknown too", () => {
  const refused = fleetIdleReading({ now: NOW, fleet: null, waiting: WAITING });
  assert.equal(refused.status, "unknown");
  assert.match(refused.detail, /could not be read, so it is not known to be idle/);
  const unasked = fleetIdleReading({ now: NOW, fleet: IDLE_FOR_A_DAY, waiting: null });
  assert.equal(unasked.status, "unknown");
  assert.match(unasked.detail, /what waits for it was not read/);
});

test("fleet idle: with no last-capture time the discriminator is keyed on WHAT WAITS, so a row joining is a new question and the same set is the same one", () => {
  const first = fleetIdleReading({ now: NOW, fleet: { captures24h: 0, lastCaptureAt: null }, waiting: { rows: [2870], labJobs: [] } });
  const again = fleetIdleReading({ now: NOW + HOUR_MS, fleet: { captures24h: 0, lastCaptureAt: null }, waiting: { rows: [2870], labJobs: [] } });
  const joined = fleetIdleReading({ now: NOW, fleet: { captures24h: 0, lastCaptureAt: null }, waiting: { rows: [2870, 2871], labJobs: [] } });
  assert.equal(first.status, "tripped");
  assert.equal(first.firstTrippedAt, null);
  assert.equal(first.discriminator, again.discriminator);
  assert.notEqual(first.discriminator, joined.discriminator);
  assert.match(first.detail, /never recorded/);
});

// --- the cause: it rides `org-health` ------------------------------------------------------------------------------------

test("the signal is OFFERED to ceo through the org-health cause, with the numbers in the prompt", () => {
  const facts = { now: NOW, lastMergedAt: NOW - HOUR_MS, work: null, redPrs: [], refusals: {}, drift: { behind: 0, ahead: 0, dirty: [] as string[] }, primarySince: null };
  const readings = orgHealthReadings({ ...facts, fleet: IDLE_FOR_A_DAY, waiting: WAITING });
  const orders = orgHealthOrders(readings);
  assert.deepEqual(orders.map((o) => [o.session, o.cause, o.subject]), [["ceo", "org-health", SIGNALS.FLEET_IDLE]]);
  assert.match(orders[0].prompt, /0 captures in the last 24 h/);
  assert.match(orders[0].prompt, /`orchestrator` owns fleet and lab questions/);
});

test("an OMITTED fleet fact is silent (the caller does not ask), a NULL one is a stated unknown, and the tick never reports a refusal as a trip", () => {
  const facts = { now: NOW, lastMergedAt: NOW - HOUR_MS, work: null, redPrs: [], refusals: {}, drift: { behind: 0, ahead: 0, dirty: [] as string[] }, primarySince: null };
  assert.equal(orgHealthReadings({ ...facts }).some((r) => r.signal === SIGNALS.FLEET_IDLE), false, "no fleet fact: no reading, so no unknown every tick");
  const said: string[] = [];
  const orders = orgHealthTick({ ...facts, fleet: null } as never, { log: (line) => said.push(line) });
  assert.deepEqual(orders, []);
  assert.match(said.join(""), /org-health: fleet-idle-while-work-waits UNKNOWN -- the fleet's captures could not be read, so it is not known to be idle; it is not read as clear\./);
});
