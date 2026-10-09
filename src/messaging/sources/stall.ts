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

import { describeError } from "../ledger.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** The measured work-tick period (2.1 minutes), the unit "a tick is old" is counted in. */
export const TICK_INTERVAL_MS = 126_000;
const STALE_TICKS = 3;
const MINUTES_PER_HOUR = 60;

/** Typed wide: frozen literals would infer `noMergeHours: 6`, and a caller overriding the threshold is the point of it being config. @type {Readonly<{ noMergeHours: number, allIdleAfterMs: number, idleStates: readonly string[], maxTickAgeMs: number }>} */
export const DEFAULT_STALL_CONFIG: Readonly<{ noMergeHours: number; allIdleAfterMs: number; idleStates: readonly string[]; maxTickAgeMs: number; }> = Object.freeze({
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
export function instant(value: unknown, field: string): number {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new TypeError(`${field}: ${JSON.stringify(value)} is not a time (epoch ms or an ISO string)`);
  return ms;
}

/** @param {number} ms @returns {string} `6h 01m`, `42m`: how long a thing has stood, for a line a person reads */
export function span(ms: number): string {
  const minutes = Math.floor(ms / MINUTE_MS);
  return minutes < MINUTES_PER_HOUR ? `${minutes}m` : `${Math.floor(minutes / MINUTES_PER_HOUR)}h ${String(minutes % MINUTES_PER_HOUR).padStart(2, "0")}m`;
}

/**
 * Run ONE reader. A throw is `cannot-ask`: no event, one log line, and the result says which source and why.
 * @param {string} source @param {() => Promise<Record<string, unknown>[]> | Record<string, unknown>[]} read
 * @param {(line: string) => void} log @returns {Promise<Observation>}
 */
export async function observe(source: string, read: () => Promise<Record<string, unknown>[]> | Record<string, unknown>[], log: (line: string) => void): Promise<Observation> {
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
export function requireReader(readers: Record<string, unknown>, name: string): Function {
  const read = readers[name];
  if (typeof read !== "function") throw new TypeError(`no reader named \`${name}\` is wired`);
  return read;
}

/**
 * WHAT A SENT INCIDENT OR STALL MEANS, as a fixed table keyed by the event's own key (chairman point 2, #3424): the chairman who reads "main is red"
 * should not have to open anything to learn whether he must act. A TABLE AND NOT A COMPUTATION so the sentence cannot drift into a guess, and a key
 * with no entry says `not known` rather than a plausible sentence.
 */
export const IMPACT = Object.freeze({
  "incident:trunk-red": "Nothing can merge.",
  "incident:gate-crash": "No worker can be woken.",
  "incident:fleet-down": "Captures are paused.",
  "incident:ci-permission": "Pull requests waiting on the named workflows cannot get a passing check.",
  "stall:all-idle": "Rows are waiting and no seat is working on them.",
  "stall:no-merge": "No change has reached main.",
});

const NOT_KNOWN = "not known";
const QUOTE_LIMIT = 200;

/**
 * @typedef {{ number: number, comment?: { author: string, at: number | string, text: string } }} FixRow
 *   the open row that holds the fix, and the newest comment an org account left on it (absent: the org has said nothing there yet)
 * @typedef {(key: string) => Promise<FixRow | null> | FixRow | null} FixRowReader  by the event's key; `null` is "no row is open", a throw is "could not ask"
 * @typedef {{ status: "row", row: FixRow } | { status: "none" } | { status: "unknown" }} FixReading
 */

/**
 * What the org has done about an event, read once from the row the incident points at. `null` from the reader is the ONLY thing that says no row is
 * open: a reader that is not wired, throws or hands back something that is not a row is `unknown`, because absence is not proof.
 *
 * @param {Record<string, unknown>} readers `readFixRow(key)` is optional @param {string} key @param {(line: string) => void} log @returns {Promise<FixReading>}
 */
async function readFix(readers: Record<string, unknown>, key: string, log: (line: string) => void): Promise<FixReading> {
  if (typeof readers.readFixRow !== "function") return { status: "unknown" };
  try {
    const row = await readers.readFixRow(key);
    if (row === null) return { status: "none" };
    if (row === undefined || typeof row !== "object" || !Number.isInteger(row.number) || row.number <= 0) throw new TypeError(`not a row: ${JSON.stringify(row)?.slice(0, 80)}`);
    if (row.comment === undefined) return { status: "row", row: { number: row.number } };
    const { author, at, text } = row.comment;
    return { status: "row", row: { number: row.number, comment: { author: String(author), at: instant(at, "comment.at"), text: String(text) } } };
  } catch (error) {
    log(`cannot-ask fix-row ${key}: ${describeError(error)}`);
    return { status: "unknown" };
  }
}

/** @param {string} text @returns {string} the comment on one line, cut where a message must stop: a quote, not the comment */
function quoted(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= QUOTE_LIMIT ? line : `${line.slice(0, QUOTE_LIMIT - 1)}\u2026`;
}

/** @param {FixReading} fix @param {number} now @returns {string} */
function beingDoneLine(fix: FixReading, now: number): string {
  if (fix.status === "none") return "nobody has picked this up yet";
  if (fix.status === "unknown") return "I could not read it";
  const { number, comment } = fix.row;
  if (comment === undefined) return `row #${number} is open for this and the org has not commented on it yet`;
  return `row #${number}, ${comment.author} ${span(now - /** @type {number} */ (comment.at))} ago: "${quoted(comment.text)}"`;
}

/**
 * The two lines a SENT event carries beyond what started. A pure function of the key, one reading and the clock, so a test hands it a fixture.
 * @param {string} key @param {FixReading} fix @param {number} now @returns {string}
 */
export function meaningLines(key: string, fix: FixReading, now: number): string {
  return `Impact: ${IMPACT[/** @type {keyof typeof IMPACT} */ (key)] ?? NOT_KNOWN}\nBeing done: ${beingDoneLine(fix, now)}.`;
}

/**
 * How long a sent event stood. `readEpisodeStart(key)` answers with when the chairman was TOLD (the ledger's first send of the open episode), because the
 * source keeps no state of its own and a resolved reading no longer holds when the thing began. So it is a floor, and the line says `at least`.
 * `null` or a throw is `not known`: a duration nobody could read is never a short one.
 *
 * @param {Record<string, unknown>} readers @param {string} key @param {number} now @param {(line: string) => void} log @returns {Promise<string>}
 */
async function lastedLine(readers: Record<string, unknown>, key: string, now: number, log: (line: string) => void): Promise<string> {
  if (typeof readers.readEpisodeStart !== "function") return `Lasted: ${NOT_KNOWN}.`;
  try {
    const told = await readers.readEpisodeStart(key);
    if (told === null) return `Lasted: ${NOT_KNOWN}.`;
    return `Lasted: at least ${span(now - instant(told, "episode start"))} (counted from the message that told you).`;
  } catch (error) {
    log(`cannot-ask episode-start ${key}: ${describeError(error)}`);
    return `Lasted: ${NOT_KNOWN}.`;
  }
}

/**
 * Append Impact and Being done to every event that says something STARTED, and Lasted to every one that says it ENDED. The key, `firstSeenAt` and
 * everything else the core reads are not touched, so the hold-down and the dedupe see the same event as before. A failed read is said on its own line
 * (`I could not read it`, `not known`) and never costs the event.
 *
 * @param {Record<string, unknown>[]} events @param {Record<string, unknown>} readers @param {(line: string) => void} log @param {number} now
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function withMeaning(events: Record<string, unknown>[], readers: Record<string, unknown>, log: (line: string) => void, now: number): Promise<Record<string, unknown>[]> {
  return Promise.all(events.map(async (event) => {
    const key = String(event.key);
    const more = event.resolved === true ? await lastedLine(readers, key, now, log) : meaningLines(key, await readFix(readers, key, log), now);
    return { ...event, text: `${event.text}\n${more}` };
  }));
}

/**
 * @typedef {{ at: number | string, seats: { session: string, state: string }[], orders: unknown[] }} TickRecord
 *   what one tick recorded: when, every seat's state, and the orders the gate found (an order is a row or PR with nobody on it)
 */

/** @param {unknown} record @param {number} index @returns {{ at: number, seats: { session: string, state: string }[], waiting: number }} */
function readTickRecord(record: unknown, index: number): { at: number; seats: { session: string; state: string; }[]; waiting: number; } {
  const tick = /** @type {Record<string, any>} */ (record);
  if (tick === null || typeof tick !== "object" || !Array.isArray(tick.seats) || !Array.isArray(tick.orders)) {
    throw new TypeError(`ticks[${index}]: a record needs \`at\`, \`seats\` and \`orders\``);
  }
  return { at: instant(tick.at, `ticks[${index}].at`), seats: tick.seats, waiting: tick.orders.length };
}

/** @param {{ seats: { session: string, state: string }[] }} tick @param {readonly string[]} idleStates */
function everySeatIdle(tick: { seats: { session: string; state: string; }[]; }, idleStates: readonly string[]) {
  return tick.seats.length > 0 && tick.seats.every((seat) => idleStates.includes(seat.state));
}

/**
 * Every seat idle while rows wait. `ticks` is newest first. The newest tick decides whether it is true NOW; the streak behind it
 * decides since when, and the event waits for `allIdleAfterMs` of it.
 *
 * @param {TickRecord[]} ticks @param {number} now @param {typeof DEFAULT_STALL_CONFIG} config
 * @returns {Record<string, unknown>[]}
 */
export function allIdleEvents(ticks: TickRecord[], now: number, config: typeof DEFAULT_STALL_CONFIG): Record<string, unknown>[] {
  if (!Array.isArray(ticks) || ticks.length === 0) throw new TypeError("no tick has been recorded");
  const records = ticks.map((record, index) => readTickRecord(record, index));
  if (now - records[0].at > config.maxTickAgeMs) throw new RangeError(`the newest tick is ${span(now - records[0].at)} old`);
  const stalled = (/** @type {any} */ tick: any) => tick.waiting > 0 && everySeatIdle(tick, config.idleStates);
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
export function noMergeEvents(lastMergeAt: number | string, now: number, config: typeof DEFAULT_STALL_CONFIG): Record<string, unknown>[] {
  const last = instant(lastMergeAt, "lastMergeAt");
  const threshold = config.noMergeHours * HOUR_MS;
  const base = { key: "stall:no-merge", kind: "stall", severity: "warning", links: [] };
  if (now - last < threshold) return [{ ...base, firstSeenAt: now, text: "A merge landed on main.", resolved: true }];
  return [{ ...base, firstSeenAt: last + threshold, resolved: false,
    text: `Nothing has merged on main for ${span(now - last)} (last merge ${new Date(last).toISOString()}).` }];
}

/**
 * @param {{ now: () => number, config?: Partial<typeof DEFAULT_STALL_CONFIG>, log?: (line: string) => void,
 *   readers: { readTicks?: () => Promise<TickRecord[]> | TickRecord[], readLastMerge?: () => Promise<number | string> | number | string, readFixRow?: FixRowReader,
 *   readEpisodeStart?: (key: string) => Promise<number | null> | number | null } }} options
 * @returns {Promise<Observation>} both stall kinds, each independently able to fail to ask
 */
export async function observeStalls({ now, config: overrides = {}, log = console.error, readers }: {
        now: () => number; config?: Partial<typeof DEFAULT_STALL_CONFIG>; log?: (line: string) => void;
        readers: {
            readTicks?: () => Promise<TickRecord[]> | TickRecord[]; readLastMerge?: () => Promise<number | string> | number | string; readFixRow?: FixRowReader;
            readEpisodeStart?: (key: string) => Promise<number | null> | number | null;
        };
    }): Promise<Observation> {
  const config = { ...DEFAULT_STALL_CONFIG, ...overrides };
  const parts = await Promise.all([
    observe("stall:all-idle", async () => withMeaning(allIdleEvents(await requireReader(readers, "readTicks")(), now(), config), readers, log, now()), log),
    observe("stall:no-merge", async () => withMeaning(noMergeEvents(await requireReader(readers, "readLastMerge")(), now(), config), readers, log, now()), log),
  ]);
  return { events: parts.flatMap((part) => part.events), cannotAsk: parts.flatMap((part) => part.cannotAsk) };
}
