// @ts-check
// a11ign/a11ign#3563 (order token cost, 2): `trace --wake-cache` -- WHY A RE-WAKE OPENS WITH A CACHE WRITE, measured from the store and not guessed.
//
// A PURE FUNCTION over the store's events: it opens no file and calls no `gh`. For each standing seat (and the reviewers, pooled) it takes the FIRST turn after each wake and
// reports that turn's cache write, grouped by what the wake did to the window (kept, compacted, cleared) and by the gap since the seat's previous turn, which are the two
// candidate causes: the window was emptied, or the cache's lifetime lapsed between wakes.
//
// WHAT THE WAKE DID TO THE WINDOW IS DERIVED HERE, NOT READ: `last-order/<seat>` (#3440) holds the time of the LAST order only, so no record keeps the decision once the next order
// overwrites it. A /clear starts a new transcript file (measured on the live host: every transcript that carries a `/clear` record carries it as its first command), and a
// compaction is its own event in the store, so both are visible to a reader that compares a wake's first turn with the turn before it.
//
// NEVER ZERO FOR UNKNOWN (`aggregate.mjs`'s rule, the same word): a class no wake could be placed in prints `not derivable`, a seat's share with nothing written prints
// `not derivable`, a first turn with no price makes its dollars a FLOOR and a group of only unpriced turns prints `not derivable`.
import { nearestRank, NOT_DERIVABLE } from "./aggregate.mjs";

/** @typedef {import("./store.mjs").TraceEvent} TraceEvent */

export { NOT_DERIVABLE };

/** The seats whose window outlives a wake (or is cleared between wakes, #3440). Each is its own population, because each has its own CLAUDE.md and its own cadence. */
export const STANDING_SEATS = ["ceo", "product-manager", "orchestrator", "liaison"];
/** Reviewers are one instance per pull request, so they are read as one class: a sample of what a per-row instance pays, not a seat. */
export const REVIEWERS = "reviewer-*";
const REVIEWER_SESSION = /^reviewer-\d+$/;

const MS_PER_MINUTE = 60_000;
const MINUTES_IN_HOUR = 60;
const SHORT_CACHE_MINUTES = 5;
/** The 5-minute cache's lifetime and the 1-hour cache's. Every transcript read so far writes the 1-hour kind (`store.mjs`, COST), so the second is the one that decides, and the first is the gap below which no cache could have lapsed. */
export const SHORT_CACHE_MS = SHORT_CACHE_MINUTES * MS_PER_MINUTE;
export const LONG_CACHE_MS = MINUTES_IN_HOUR * MS_PER_MINUTE;
const MEDIAN = 50;
const NINETIETH = 90;
const PERCENT = 100;
const SHARE_DECIMALS = 1;
const COST_DECIMALS = 4;

export const ACTION = Object.freeze({ KEPT: "kept", COMPACTED: "compacted", CLEARED: "cleared", UNKNOWN: NOT_DERIVABLE });
export const GAP = Object.freeze({ SHORT: "gap up to 5 min", LONG: "gap over 5 min, up to 1 h", LAPSED: "gap over 1 h", UNKNOWN: NOT_DERIVABLE });
/** Print order: the three derivable classes first, the one with no derivation last. */
const ACTIONS = [ACTION.KEPT, ACTION.COMPACTED, ACTION.CLEARED, ACTION.UNKNOWN];
const GAPS = [GAP.SHORT, GAP.LONG, GAP.LAPSED, GAP.UNKNOWN];

export const DEFINITIONS = [
  "WAKE: a `wake` event of the store, a delivery that started a model turn (`store.mjs`). A wake is counted when its time falls in the window.",
  "FIRST TURN: the earliest turn of the wake's session that carries the wake's id, the session's own turns only (a subagent's `sidechain` turns are not its window). Ties in time break by the event's id, so a re-run reads the same turn. A wake with no such turn is counted apart (`no turn`), never as a wake that wrote nothing.",
  "CACHE WRITE of a turn: `cacheWrite5m` + `cacheWrite1h`. CACHE READ: `cacheRead`. Both are the API's own `usage` for the message (MEASURED); the window action and the gap below are DERIVED, and said to be.",
  "GAP: the wake's time minus the time the session's PREVIOUS turn ended (a turn's time is its last block), so it is measured to the ORDER and not to the first turn's end; an order that arrived while that turn still ran has a negative gap and is in the shortest class. `gap up to 5 min` is inside both caches' lifetimes; `gap over 5 min, up to 1 h` is past the 5-minute one only; `gap over 1 h` is past both. A first turn with no previous turn in the store has no gap: `not derivable`.",
  "WINDOW ACTION (DERIVED, because the decision is not kept: `last-order/` holds the last order's time only): `compacted` when a compaction of the session falls after the previous turn and at or before the first turn; else `cleared` when the first turn's transcript file is not the previous turn's (a /clear starts a new file); else `kept` when both are the same file. `not derivable` when there is no previous turn or either turn has no transcript name (a store written before #3589 names none: re-ingest it).",
  "A CLASS PRINTS `not derivable`, NEVER 0, WHEN NO WAKE OF THE SEAT COULD BE PLACED IN ANY CLASS; where some could, a class with none says `0 wakes` and its figures are `-`.",
  "WHOLE WAKE: every turn of the session that carries the wake's id, summed in dollars; P50 over the wakes whose every turn is priced (the count is printed), so a wake with an unpriced turn is left out of that figure and never counted as free. Which wakes are kept and which cleared is NOT random (a window is kept when the last order was recent and the window small), so a kept wake's whole-wake figure is a reading beside a cleared one's, never an experiment.",
  "SHARE: the first turns' cache write over every cache write of the seat's own turns in the window. It pools classes on purpose (it is how much of the seat's writing is a wake's first turn) and is the only figure that does.",
  "DOLLARS: the first turns' `costUsd`, summed over the priced turns; a group with an unpriced turn is a FLOOR (marked), one with only unpriced turns is `not derivable`. P50 and P90 are nearest-rank (the value at rank ceil(p x n)), no interpolation.",
  `REVIEWERS (\`${REVIEWERS}\`) are every Claude-run \`reviewer-<n>\` session pooled as one class (the pooling is of seats, never of classes). A Codex reviewer's request carries no cache-write field (\`codex-turns.mjs\`: 0 in every record, Codex has no write TTL), so its first-turn write is \`not derivable\`, never 0: the count of Codex requests is printed and none enters a figure. A reviewer's first wake in the store has no previous turn, so it is \`not derivable\` by definition: it is a launch, not a re-wake.`,
];

/** @param {TraceEvent} turn */
export const writeOf = (turn) => (turn.tokens?.cacheWrite5m ?? 0) + (turn.tokens?.cacheWrite1h ?? 0);

/** The one order every pick in this file uses, so a tie breaks the same way twice. @param {TraceEvent} a @param {TraceEvent} b */
const inTimeOrder = (a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** @param {string} session @returns {string | null} the seat a session is read as, or null for one this report does not cover */
export function seatOf(session) {
  if (STANDING_SEATS.includes(session)) return session;
  return REVIEWER_SESSION.test(session) ? REVIEWERS : null;
}

/** @param {number | null} gapMs */
export function gapClass(gapMs) {
  if (gapMs === null) return GAP.UNKNOWN;
  if (gapMs <= SHORT_CACHE_MS) return GAP.SHORT;
  return gapMs <= LONG_CACHE_MS ? GAP.LONG : GAP.LAPSED;
}

/** @param {{ previous: TraceEvent | null, first: TraceEvent, compactions: TraceEvent[] }} input */
export function windowAction({ previous, first, compactions }) {
  if (previous === null) return ACTION.UNKNOWN;
  if (compactions.some((event) => event.at > previous.at && event.at <= first.at)) return ACTION.COMPACTED;
  if (!previous.transcript || !first.transcript) return ACTION.UNKNOWN;
  return previous.transcript === first.transcript ? ACTION.KEPT : ACTION.CLEARED;
}

/** @typedef {{ first: TraceEvent, previous: TraceEvent | null, turns: TraceEvent[] }} WakeTurns */

/**
 * Each wake id's turns in order, the first of them with the turn before it.
 * @param {TraceEvent[]} turns one session's own, sorted
 * @returns {Map<string, WakeTurns>}
 */
function firstTurnsOf(turns) {
  /** @type {Map<string, WakeTurns>} */
  const firsts = new Map();
  turns.forEach((turn, index) => {
    if (!turn.wakeId) return;
    const known = firsts.get(turn.wakeId);
    if (known) known.turns.push(turn);
    else firsts.set(turn.wakeId, { first: turn, previous: turns[index - 1] ?? null, turns: [turn] });
  });
  return firsts;
}

/** @param {TraceEvent[]} events @param {TraceEvent["kind"]} kind @returns {Map<string, TraceEvent[]>} the events of one kind by session, each list in time order */
function bySession(events, kind) {
  /** @type {Map<string, TraceEvent[]>} */
  const sessions = new Map();
  for (const event of events.filter((candidate) => candidate.kind === kind && candidate.sidechain !== true && candidate.harness !== "codex").toSorted(inTimeOrder)) {
    sessions.set(event.session, [...(sessions.get(event.session) ?? []), event]);
  }
  return sessions;
}

/** @typedef {{ session: string, wakeId: string, at: number, action: string, gap: string, gapMs: number | null, write: number, read: number, costUsd: number | null, wakeDollars: number | null }} FirstTurn */

/**
 * @param {{ wake: TraceEvent, firsts: ReturnType<typeof firstTurnsOf>, compactions: TraceEvent[] }} input @returns {FirstTurn | null} null for a wake with no turn
 */
function readWake({ wake, firsts, compactions }) {
  const found = firsts.get(wake.id);
  if (!found) return null;
  const { first, previous, turns } = found;
  const gapMs = previous === null ? null : wake.at - previous.at;
  return {
    session: wake.session, wakeId: wake.id, at: wake.at, action: windowAction({ previous, first, compactions }), gap: gapClass(gapMs), gapMs,
    write: writeOf(first), read: first.tokens?.cacheRead ?? 0, costUsd: first.costUsd ?? null,
    wakeDollars: turns.some((turn) => turn.costUsd == null) ? null : turns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0),
  };
}

/** @param {FirstTurn[]} firstTurns @returns {{ write: { p50: number | null, p90: number | null, total: number }, read: { p50: number | null }, dollars: number | typeof NOT_DERIVABLE, floor: boolean, wake: { p50: number | typeof NOT_DERIVABLE, priced: number } }} */
function figures(firstTurns) {
  const writes = firstTurns.map((turn) => turn.write);
  const priced = firstTurns.filter((turn) => turn.costUsd !== null);
  const wholeWakes = firstTurns.flatMap((turn) => (turn.wakeDollars === null ? [] : [turn.wakeDollars]));
  return {
    write: { p50: nearestRank(writes, MEDIAN), p90: nearestRank(writes, NINETIETH), total: writes.reduce((sum, value) => sum + value, 0) },
    read: { p50: nearestRank(firstTurns.map((turn) => turn.read), MEDIAN) },
    dollars: priced.length === 0 ? NOT_DERIVABLE : priced.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0),
    floor: priced.length < firstTurns.length,
    wake: { p50: nearestRank(wholeWakes, MEDIAN) ?? NOT_DERIVABLE, priced: wholeWakes.length },
  };
}

/**
 * One window action's wakes: its figures, and the same figures by gap. `placed` is whether ANY wake of the seat could be classed, which decides between `0 wakes` and `not derivable`.
 * @param {{ action: string, firstTurns: FirstTurn[], placed: boolean }} input
 */
function actionFigures({ action, firstTurns, placed }) {
  const own = firstTurns.filter((turn) => turn.action === action);
  const gapsPlaced = firstTurns.length === 0 || firstTurns.some((turn) => turn.gap !== GAP.UNKNOWN);
  return {
    action, wakes: placed || action === ACTION.UNKNOWN ? own.length : NOT_DERIVABLE, ...figures(own),
    byGap: GAPS.map((gap) => ({ gap, wakes: gapsPlaced || gap === GAP.UNKNOWN ? own.filter((turn) => turn.gap === gap).length : NOT_DERIVABLE, ...figures(own.filter((turn) => turn.gap === gap)) })),
  };
}

/**
 * @param {{ seat: string, sessions: string[], wakes: TraceEvent[], turns: Map<string, TraceEvent[]>, compactions: Map<string, TraceEvent[]>, window: { from: number, to: number } }} input
 */
function seatReport({ seat, sessions, wakes, turns, compactions, window }) {
  /** @type {FirstTurn[]} */
  const firstTurns = [];
  let noTurn = 0;
  for (const session of sessions) {
    const firsts = firstTurnsOf(turns.get(session) ?? []);
    for (const wake of wakes.filter((candidate) => candidate.session === session)) {
      const read = readWake({ wake, firsts, compactions: compactions.get(session) ?? [] });
      if (read === null) noTurn += 1;
      else firstTurns.push(read);
    }
  }
  const written = sessions.flatMap((session) => turns.get(session) ?? []).filter((turn) => turn.at >= window.from && turn.at <= window.to).reduce((sum, turn) => sum + writeOf(turn), 0);
  const first = firstTurns.reduce((sum, turn) => sum + turn.write, 0);
  const placed = firstTurns.length === 0 || firstTurns.some((turn) => turn.action !== ACTION.UNKNOWN);
  return {
    seat, sessions: sessions.length, wakes: firstTurns.length + noTurn, noTurn, firstWrite: first, allWrite: written, share: written === 0 ? NOT_DERIVABLE : first / written,
    actions: ACTIONS.map((action) => actionFigures({ action, firstTurns, placed })),
  };
}

/**
 * THE REPORT. `events` is the whole store (a previous turn before the window is still the previous turn); `window` is the wakes it counts.
 * @param {{ events: TraceEvent[], window: { from: number, to: number } }} input
 */
export function wakeCache({ events, window }) {
  const turns = bySession(events, "turn");
  const compactions = bySession(events, "compaction");
  const wakes = events.filter((event) => event.kind === "wake" && event.at >= window.from && event.at <= window.to).toSorted(inTimeOrder);
  const seats = [...STANDING_SEATS, REVIEWERS].map((seat) => {
    const sessions = [...new Set(wakes.map((wake) => wake.session))].filter((session) => seatOf(session) === seat).toSorted();
    return seatReport({ seat, sessions, wakes: wakes.filter((wake) => sessions.includes(wake.session)), turns, compactions, window });
  });
  const codex = events.filter((event) => event.kind === "turn" && event.harness === "codex" && seatOf(event.session) === REVIEWERS && event.at >= window.from && event.at <= window.to);
  return { window, wakes: seats.reduce((sum, seat) => sum + seat.wakes, 0), seats, codexReviewers: { requests: codex.length, sessions: new Set(codex.map((event) => event.session)).size } };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Rendering

/** @param {number | string | null} value */
const count = (value) => (typeof value === "number" ? Math.round(value).toLocaleString("en-US") : (value ?? "-"));
/** @param {number | typeof NOT_DERIVABLE} dollars @param {boolean} floor */
const money = (dollars, floor) => (dollars === NOT_DERIVABLE ? NOT_DERIVABLE : `${floor ? ">= " : ""}$${dollars.toFixed(COST_DECIMALS)}`);

/** @param {ReturnType<typeof actionFigures>["byGap"][number] | ReturnType<typeof actionFigures>} entry */
function figureLine(entry) {
  if (entry.wakes === NOT_DERIVABLE) return NOT_DERIVABLE;
  if (entry.wakes === 0) return "0 wakes";
  return `${entry.wakes} wakes  write p50 ${count(entry.write.p50)} p90 ${count(entry.write.p90)} total ${count(entry.write.total)}  read p50 ${count(entry.read.p50)}  ${money(entry.dollars, entry.floor)}  whole wake p50 ${typeof entry.wake.p50 === "number" ? money(entry.wake.p50, false) : NOT_DERIVABLE} (${entry.wake.priced} fully priced)`;
}

/** @param {ReturnType<typeof wakeCache>["codexReviewers"]} codex */
const reviewerLine = (codex) => `${REVIEWERS}: ${NOT_DERIVABLE}: no wake of a Claude-run reviewer is in the store; ${codex.requests} Codex requests of ${codex.sessions} reviewer sessions are, and a Codex request has no cache-write field`;

/** @param {ReturnType<typeof seatReport>} seat */
function seatLines(seat) {
  const share = typeof seat.share === "number" ? `${(seat.share * PERCENT).toFixed(SHARE_DECIMALS)}%` : NOT_DERIVABLE;
  const lines = [`${seat.seat}: ${seat.wakes} wakes (${seat.wakes - seat.noTurn} with a turn, ${seat.noTurn} with no turn)${seat.seat === REVIEWERS ? `, ${seat.sessions} sessions` : ""}`,
    `  first-turn cache write ${count(seat.firstWrite)} of ${count(seat.allWrite)} written by the seat's turns in the window: share ${share}`];
  for (const action of seat.actions) {
    lines.push(`  ${action.action.padEnd(14)} ${figureLine(action)}`);
    if (typeof action.wakes === "number" && action.wakes > 0) {
      for (const gap of action.byGap.filter((entry) => entry.wakes !== 0)) lines.push(`      ${gap.gap.padEnd(28)} ${figureLine(gap)}`);
    }
  }
  return lines;
}

/** @param {ReturnType<typeof wakeCache>} report @param {{ footer?: string[] }} [extra] */
export function renderWakeCache(report, extra = {}) {
  const lines = ["TRACE --WAKE-CACHE (a reading at a moment: re-run it, do not quote it)", "", "DEFINITIONS", ...DEFINITIONS.map((line) => `- ${line}`), "",
    `window ${new Date(report.window.from).toISOString()} to ${new Date(report.window.to).toISOString()}: ${report.wakes} wakes of the seats below and of no other session`, ""];
  for (const seat of report.seats) lines.push(...(seat.seat === REVIEWERS && seat.wakes === 0 ? [reviewerLine(report.codexReviewers)] : seatLines(seat)), "");
  return [...lines, ...(extra.footer ?? [])].join("\n");
}
