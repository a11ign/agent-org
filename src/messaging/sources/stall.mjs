// @ts-check
// THE STALL SOURCES (a11ign/a11ign#2904, row 5 of 13; design #2899): is the org doing nothing while there is something to do?
// Two kinds, each returning ONE event with a stable `key` and a `resolved` reading, for the core to dedupe, hold down and clear.
//
//   stall:all-idle   every seat idle while rows are waiting, read from the last ticks' recorded orders
//   stall:no-merge   nothing has merged on `main` for N hours (default 6), from GitHub
//
// A LEAF, LIKE THE CORE: it imports siblings in `src/messaging/` and node's own, never the tool, so `node --test
// "src/messaging/**/*.test.mjs"` runs in this repository's `gate`. THE READS ARE INJECTED (`readers`), so a test hands a fixture to
// the same code the host hands `gh` and the tick's record to, and nothing here waits, spawns or touches the network. Wiring the real
// reads is row 6's, the first LIVE one.
//
// **A READ THAT FAILS PRODUCES NO EVENT, AND SAYS SO.** `observe` turns a thrown reader into `cannot-ask` in the result and one log
// line. It never returns `resolved: true` for it (a false "all clear" would ONE-message the chairman "cleared" about something nobody
// looked at) and never an event (a false alarm). Absence is not proof: "could not ask" and "asked, and it is fine" are different values.
//
// NO STATE OF ITS OWN. Every `firstSeenAt` is DERIVED from what the read holds (the first tick of the idle streak; the last merge plus
// N hours), so it is the same on every tick without a file, which is what the core's `already-cleared` rule needs from it.

import { describeError } from "../ledger.mjs";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** The measured work-tick period (2.1 minutes), the unit "a tick is old" is counted in. */
export const TICK_INTERVAL_MS = 126_000;
const STALE_TICKS = 3;
const MINUTES_PER_HOUR = 60;

export const DEFAULT_STALL_CONFIG = Object.freeze({
  /** No merge on `main` for this long is a stall (the row's default). */
  noMergeHours: 6,
  /**
   * Every seat idle with rows waiting must hold for this long before it is an event. A tick that records orders and idle seats is the
   * NORMAL moment before `wake` delivers them, so reading one record is a false alarm every time work arrives.
   */
  allIdleAfterMs: 10 * MINUTE_MS,
  /** A seat in one of these states is not doing anything (herdr's `idle`; `done` is what `wake` also treats as wakeable). */
  idleStates: Object.freeze(["idle", "done"]),
  /** The newest tick record older than this says nothing about now: that is `cannot-ask`, and the gate-crash incident covers why. */
  maxTickAgeMs: STALE_TICKS * TICK_INTERVAL_MS,
});

/**
 * @typedef {{ source: string, reason: string }} CannotAsk
 * @typedef {{ events: Record<string, unknown>[], cannotAsk: CannotAsk[] }} Observation
 */

/**
 * Anything a reader hands over as a time, as epoch milliseconds. A reader that cannot give one is a reader that could not ask.
 * @param {unknown} value @param {string} field @returns {number}
 */
export function instant(value, field) {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new TypeError(`${field}: ${JSON.stringify(value)} is not a time (epoch ms or an ISO string)`);
  return ms;
}

/** @param {number} ms @returns {string} `6h 01m`, `42m`: how long a thing has stood, for a line a person reads */
export function span(ms) {
  const minutes = Math.floor(ms / MINUTE_MS);
  return minutes < MINUTES_PER_HOUR ? `${minutes}m` : `${Math.floor(minutes / MINUTES_PER_HOUR)}h ${String(minutes % MINUTES_PER_HOUR).padStart(2, "0")}m`;
}

/**
 * Run ONE reader. A throw is `cannot-ask`: no event, one log line, and the result says which source and why.
 * @param {string} source @param {() => Promise<Record<string, unknown>[]> | Record<string, unknown>[]} read
 * @param {(line: string) => void} log @returns {Promise<Observation>}
 */
export async function observe(source, read, log) {
  try {
    return { events: await read(), cannotAsk: [] };
  } catch (error) {
    const reason = describeError(error);
    log(`cannot-ask ${source}: ${reason}`);
    return { events: [], cannotAsk: [{ source, reason }] };
  }
}

/**
 * @param {Record<string, unknown>} readers @param {string} name @returns {Function}
 */
export function requireReader(readers, name) {
  const read = readers[name];
  if (typeof read !== "function") throw new TypeError(`no reader named \`${name}\` is wired`);
  return read;
}

/**
 * @typedef {{ at: number | string, seats: { session: string, state: string }[], orders: unknown[] }} TickRecord
 *   what one tick recorded: when, every seat's state, and the orders the gate found (an order is a row or PR with nobody on it)
 */

/** @param {unknown} record @param {number} index @returns {{ at: number, seats: { session: string, state: string }[], waiting: number }} */
function readTickRecord(record, index) {
  const tick = /** @type {Record<string, any>} */ (record);
  if (tick === null || typeof tick !== "object" || !Array.isArray(tick.seats) || !Array.isArray(tick.orders)) {
    throw new TypeError(`ticks[${index}]: a record needs \`at\`, \`seats\` and \`orders\``);
  }
  return { at: instant(tick.at, `ticks[${index}].at`), seats: tick.seats, waiting: tick.orders.length };
}

/** @param {{ seats: { session: string, state: string }[] }} tick @param {readonly string[]} idleStates */
function everySeatIdle(tick, idleStates) {
  return tick.seats.length > 0 && tick.seats.every((seat) => idleStates.includes(seat.state));
}

/**
 * Every seat idle while rows wait. `ticks` is newest first. The newest tick decides whether it is true NOW; the streak behind it
 * decides since when, and the event waits for `allIdleAfterMs` of it.
 *
 * @param {TickRecord[]} ticks @param {number} now @param {typeof DEFAULT_STALL_CONFIG} config
 * @returns {Record<string, unknown>[]}
 */
export function allIdleEvents(ticks, now, config) {
  if (!Array.isArray(ticks) || ticks.length === 0) throw new TypeError("no tick has been recorded");
  const records = ticks.map((record, index) => readTickRecord(record, index));
  if (now - records[0].at > config.maxTickAgeMs) throw new RangeError(`the newest tick is ${span(now - records[0].at)} old`);
  const stalled = (/** @type {any} */ tick) => tick.waiting > 0 && everySeatIdle(tick, config.idleStates);
  const base = { key: "stall:all-idle", kind: "stall", severity: "warning", links: [] };
  if (!stalled(records[0])) return [{ ...base, firstSeenAt: now, text: "Seats are no longer all idle with rows waiting.", resolved: true }];
  const streak = [];
  for (const tick of records) {
    if (!stalled(tick)) break;
    streak.push(tick);
  }
  const since = streak[streak.length - 1].at;
  if (now - since < config.allIdleAfterMs) return [];
  const { waiting, seats } = records[0];
  return [{ ...base, firstSeenAt: since, resolved: false,
    text: `Every seat has been idle for ${span(now - since)} with ${waiting} row${waiting === 1 ? "" : "s"} waiting (${seats.length} seats).` }];
}

/**
 * Nothing merged on `main` for N hours. `lastMergeAt` is the newest merge's time; the incident began when the threshold was crossed,
 * which is what makes `firstSeenAt` the same on every tick.
 *
 * @param {number | string} lastMergeAt @param {number} now @param {typeof DEFAULT_STALL_CONFIG} config
 * @returns {Record<string, unknown>[]}
 */
export function noMergeEvents(lastMergeAt, now, config) {
  const last = instant(lastMergeAt, "lastMergeAt");
  const threshold = config.noMergeHours * HOUR_MS;
  const base = { key: "stall:no-merge", kind: "stall", severity: "warning", links: [] };
  if (now - last < threshold) return [{ ...base, firstSeenAt: now, text: "A merge landed on main.", resolved: true }];
  return [{ ...base, firstSeenAt: last + threshold, resolved: false,
    text: `Nothing has merged on main for ${span(now - last)} (last merge ${new Date(last).toISOString()}).` }];
}

/**
 * @param {{ now: () => number, config?: Partial<typeof DEFAULT_STALL_CONFIG>, log?: (line: string) => void,
 *   readers: { readTicks?: () => Promise<TickRecord[]> | TickRecord[], readLastMerge?: () => Promise<number | string> | number | string } }} options
 * @returns {Promise<Observation>} both stall kinds, each independently able to fail to ask
 */
export async function observeStalls({ now, config: overrides = {}, log = console.error, readers }) {
  const config = { ...DEFAULT_STALL_CONFIG, ...overrides };
  const parts = await Promise.all([
    observe("stall:all-idle", async () => allIdleEvents(await requireReader(readers, "readTicks")(), now(), config), log),
    observe("stall:no-merge", async () => noMergeEvents(await requireReader(readers, "readLastMerge")(), now(), config), log),
  ]);
  return { events: parts.flatMap((part) => part.events), cannotAsk: parts.flatMap((part) => part.cannotAsk) };
}
