// @ts-check
// a11ign/a11ign#3513 (slice 6 of #3494): THE TOKEN-EFFICIENCY TRACKER -- `trace --aggregate`. Dollars, tokens and wall-clock per merged row, the overhead of the standing
// leads, the repeat waste by class and the cache-read share, PER WEEK, so a fix shows a before and an after.
//
// A PURE FUNCTION over what the store holds: it opens no file and calls no `gh`. `trace.mjs` reads the store, the merged pull requests and wakes-per-row's reading for each
// week and hands them in, so the test runs on fixtures. It reads wakes-per-row's WAKE COUNTS by import (`mergedRows`, `reviewerTarget`, `rowsClosedBy`, and the `measure`
// result it is handed) and does not count a second time beside them: where its own count of the same rows differs, the report says why (`compareWakes`).
//
// A FIGURE WITHOUT ITS DEFINITION IS THE DEFECT THIS SLICE EXISTS TO REMOVE, so `DEFINITIONS` is printed once at the top of every report. Three rules decide most numbers:
//   NEVER ZERO FOR UNKNOWN. A turn with no price makes its row's dollars a FLOOR (marked); a class with no derivation prints `not derivable`; a source the store does not hold
//   prints `not held`. A row with no turn in the store has no figure and is counted apart.
//   NEVER MIXED. A week is its own population: nothing is pooled across weeks, and a week the store holds only part of is marked PARTIAL and left out of the comparison.
//   NEVER AVERAGED OPEN. A row with no merge is listed apart and is in no percentile.
import { costOf, eventsForRow, repriceEvents } from "./store.mjs";
import { BETWEEN, PHASES, waterfall } from "./waterfall.mjs";
import { mergedRows, reviewerTarget, rowsClosedBy } from "../wakes-per-row.mjs";

export const DEFINITIONS = [
  "WEEK: Monday 00:00:00 UTC to the next Monday (UTC is the org's clock). A merged row is in the week of its MERGE time (the last merge of the pull requests that close it). The spend figures (overhead, cache-read share, repeat waste) are by the time of the turn or event, in the same week.",
  "PER MERGED ROW: dollars and tokens are the sum of every turn the store holds for the row, over all time, not only the week (a turn naming several rows is in each, so two rows' totals are not to be added). TOKENS are all five fields: input, output, cacheRead, cacheWrite5m, cacheWrite1h. DOLLARS are the priced turns only: a row with an unpriced turn is a FLOOR (marked), and a row with no priced turn has no dollar figure. P50 and P90 are NEAREST-RANK (the value at rank ceil(p x n) of the sorted rows), no interpolation.",
  "WALL-CLOCK PER ROW: from the row's first claim record (GitHub's `claimed` event) to its merge. A row with no claim in the store has none and is counted apart.",
  "A ROW WITH NO TURN IN THE STORE has no figure at all (never 0 dollars) and is counted apart: a row merged before the store's first transcript is not a free row.",
  "OVERHEAD: turns that name no row by any route (not `row`, `rows`, a pull request that closes a merged row, nor a `touchedRows` write), as a share of the week's priced dollars and of its tokens, one line per standing session. A standing session's turn that WROTE to a row is on that row, as the store places it, and is printed as its own `on a row` figure so the share does not hide it.",
  "UNMEASURED: turns of a session no order ever named (`unnamed:<file>`) or a Codex session in no reviewer directory (`codex:<dir>`), and transcripts that could not be read. They are counted apart and are NOT overhead: nobody knows whose they were.",
  "UNPLACED: turns on a pull request that closes no row merged in the window of this reading (a review of a pull request still open). Counted apart, in no average.",
  "OPEN ROW: a row GitHub says is open at the reading, with turns in the store. Listed apart with its spend so far, in no average. A row with turns that is neither open nor merged in the weeks of this reading (merged before them, or closed with no merge) is listed beside it as OUTSIDE: its spend is real, and it is in no average either.",
  "CACHE-READ SHARE OF INPUT: cacheRead / (input + cacheRead + cacheWrite5m + cacheWrite1h), summed over every turn of the week. Output tokens are not in the denominator.",
  "REPEAT WASTE, priced from the store, each turn priced ONCE in the first class that claims it, in this order, so the classes add up: re-delivered order, re-review, re-queue, compaction, preamble reload. A class never counts a turn another class already counted; its COUNT is every occurrence.",
  "  re-delivered order: a wake whose session and ledger key (without the `@deferred` suffix) were delivered before. Dollars: every turn that wake started.",
  "    BY GATE CAUSE (the wake's own `cause`, in the same week as the class, dearest first: a cause with no derivable dollars sorts last): repeats, distinct keys, the MEDIAN GAP between a repeat and the previous delivery of its key (whenever that was), and dollars (a floor, as every dollar here). A repeat whose key carries `@deferred` is the same order re-sent after a deferral, and is its own row (`<cause> @deferred`).",
  "  re-review: a `reviewed` event on a pull request after an earlier one. Dollars: the turns of that pull request's reviewer session between its first review and the later one.",
  "  re-queue: an `added_to_merge_queue` after an earlier one on the same pull request. Dollars: the turns on the pull request's rows between its last unmerged exit from the queue and the re-entry.",
  "  compaction: a compaction of a session. Dollars: the INPUT side (input, cacheRead, cacheWrite; not output) of the first turn the session took after it, which re-reads the window.",
  "  preamble reload: a wake that is not its session's first. Dollars: the INPUT side of its first turn, the re-read of the window every wake pays; the turn's own output is the work and is not waste.",
  "  CI re-run: a check run of a name already run on the same pull request. Counted with its runner time; CI minutes are not tokens, so its dollars are `not derivable`.",
  "  deferred wait: how long a busy seat held an order before it was typed. The deferral log is not in the store (#3510), so it is `not held`, never 0.",
  "PHASE SHARE (#3511): from each merged row's waterfall (`waterfall.mjs`, its own definitions): the wall-clock each phase has to ITSELF (each moment in the latest-started phase running at it; time no phase covers is `between`) and the dollars of the turns that ENDED in it, as a share of the week's merged rows' whole wall-clock (the first phase's start to the last one's end) and whole dollars. The shares add up to the whole, and a report whose do not THROWS instead of printing. A row with no phase record in the store (its GitHub events not read) has no waterfall, is counted apart and is in no share. Dollars are the priced turns only, so a row with an unpriced turn makes them a floor (marked).",
  "DEAREST PHASE (#3511): for each of the ten dearest rows, the phase whose turns cost most (priced dollars, a floor when a turn is unpriced) and the phase with the most wall-clock to itself, each with its share of that row's. The row's dollars here are the waterfall's own (the turns on the row and on the pull requests that close it), so they can differ from the per-row figure above, which also places a standing lead's `touched` write.",
  "WAKES, against wakes-per-row: for the rows of the week, the store's count of the wakes of the row's own worker and reviewer sessions (a reviewer's only inside its pull request's open-to-merge window, as wakes-per-row places them) is compared with wakes-per-row's `wakes` for the same row. The week prints how many rows agree and the reason for each that does not.",
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_WEEK = 7;
const WEEK_MS = DAYS_PER_WEEK * MS_PER_DAY;
const THURSDAY = 3; // 1970-01-01 was a Thursday, and a Monday-first week numbers Thursday 3
const FIRST_RANK_PERCENT = 50;
const LAST_RANK_PERCENT = 90;
const PERCENT = 100;
const DEAREST = 10;
const UNPRICED_LISTED = 5;
const DIFFERENCES_LISTED = 8;
/** The classes read off GitHub's events, which a week with unread rows holds only part of. */
const GITHUB_CLASSES = new Set(["rereview", "requeue", "ci-rerun"]);
const DOLLAR_DECIMALS = 4;
const SHARE_DECIMALS = 1;
export const NOT_DERIVABLE = "not derivable";
export const NOT_HELD = "not held";

/** The deferral log (#3510) is not merged: this is the one place that says so, and the reader is added with the log. */
const DEFERRAL_LOG_HELD = false;

/**
 * @typedef {import("./store.mjs").TraceEvent} TraceEvent
 * @typedef {import("./store.mjs").Tokens} Tokens
 * @typedef {{ row: number, repo: string, firstOpenedAt: number, lastOpenedAt: number, mergedAt: number, pulls: number[] }} MergedRow
 * @typedef {{ dollars: number, priced: number, unpriced: number, turns: number, tokens: number }} Tally
 * @typedef {{ cause: string, deferred: boolean, count: number, keys: number, medianGapMs: number | null, dollars: number | typeof NOT_DERIVABLE, floor: boolean, tokens: number, unpriced: number }} RedeliveredCause
 * @typedef {{ id: string, label: string, count: number, dollars: number | typeof NOT_DERIVABLE | typeof NOT_HELD, floor: boolean, tokens: number, unpriced?: number, ms?: number, causes?: RedeliveredCause[] }} RepeatClass
 */

/** @param {number} ms the Monday 00:00 UTC of the week holding `ms` */
export function weekStart(ms) {
  const day = Math.floor(ms / MS_PER_DAY);
  return (day - ((day + THURSDAY) % DAYS_PER_WEEK)) * MS_PER_DAY;
}

/** @param {number[]} values @param {number} percent @returns {number | null} */
export function nearestRank(values, percent) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((percent / PERCENT) * sorted.length) - 1)];
}

/** @param {number[]} values */
const spread = (values) => ({ n: values.length, p50: nearestRank(values, FIRST_RANK_PERCENT), p90: nearestRank(values, LAST_RANK_PERCENT) });

/** @param {Tokens} tokens */
const allTokens = (tokens) => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;
/** @param {Tokens} tokens */
const inputSide = (tokens) => tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;

/** @returns {Tally} */
const emptyTally = () => ({ dollars: 0, priced: 0, unpriced: 0, turns: 0, tokens: 0 });

/** @param {Tally} tally @param {TraceEvent} turn */
function addTurn(tally, turn) {
  tally.turns += 1;
  tally.tokens += turn.tokens ? allTokens(turn.tokens) : 0;
  if (typeof turn.costUsd === "number") {
    tally.dollars += turn.costUsd;
    tally.priced += 1;
  } else tally.unpriced += 1;
}

/** @param {TraceEvent} event @param {number} at */
const inWeek = (event, at) => event.at >= at && event.at < at + WEEK_MS;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Where an event belongs: the rows it names, by any route the store keeps

/** @typedef {{ rowRepo: string, org: string, prRows: Map<string, number[]> }} Keys */

/** `a11ign/a11ign#3513`: the pull request's key, whatever repository it is in. `repo` is the store's short name, `null` for the primary. @param {Keys} keys @param {string | null} repo @param {number} number */
const prKey = (keys, repo, number) => `${repo === null ? keys.rowRepo : `${keys.org}/${repo}`}#${number}`;

/**
 * The rows an event names, and the pull requests it names that close no known row. A `touched` write counts only for a turn: a wake names its subject by the order.
 * @param {TraceEvent} event @param {Keys} keys
 * @returns {{ rows: number[], unresolved: boolean }}
 */
function subjectsOfEvent(event, keys) {
  const rows = new Set([event.row, ...(event.rows ?? []), ...(event.touchedRows ?? [])].filter((row) => typeof row === "number"));
  const named = [event.pr, ...(event.prs ?? [])].filter((pr) => typeof pr === "number").map((pr) => prKey(keys, event.repo, pr));
  named.push(...(event.touchedPrs ?? []).map((pr) => prKey(keys, null, pr)));
  let resolved = rows.size > 0;
  for (const key of named) {
    for (const row of keys.prRows.get(key) ?? []) rows.add(row);
    resolved ||= (keys.prRows.get(key) ?? []).length > 0;
  }
  return { rows: [...rows].sort((a, b) => a - b), unresolved: named.length > 0 && !resolved };
}

const UNATTRIBUTABLE = /^(unnamed|codex):/;

/**
 * @param {TraceEvent} turn @param {Keys} keys
 * @returns {{ kind: "rowed", rows: number[] } | { kind: "unplaced" | "unmeasured" | "overhead" }}
 */
function place(turn, keys) {
  const { rows, unresolved } = subjectsOfEvent(turn, keys);
  if (rows.length > 0) return { kind: "rowed", rows };
  if (unresolved) return { kind: "unplaced" };
  return { kind: UNATTRIBUTABLE.test(turn.session) ? "unmeasured" : "overhead" };
}

/**
 * @param {import("../wakes-per-row.mjs").PullRequest[]} pulls @param {string} rowRepo
 * @returns {Map<string, number[]>} pull request key -> the rows its body closes (a pull request that closes none is not in it)
 */
function prRowsOf(pulls, rowRepo) {
  const closing = pulls.map((pull) => /** @type {[string, number[]]} */ ([`${pull.repo}#${pull.number}`, rowsClosedBy(pull.body ?? "", rowRepo)]));
  return new Map(closing.filter(([, rows]) => rows.length > 0));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// The week's spend

/**
 * @typedef {{ turn: TraceEvent, kind: "rowed" | "unplaced" | "unmeasured" | "overhead", rows?: number[] }} Placed
 */

/** @param {Placed[]} turns */
function spendOf(turns) {
  const all = emptyTally();
  const kinds = { rowed: emptyTally(), unplaced: emptyTally(), unmeasured: emptyTally(), overhead: emptyTally() };
  /** @type {Map<string, Tally & { onRows: Tally }>} */
  const standing = new Map();
  const input = { cacheRead: 0, side: 0 };
  /** @type {Map<string, number>} */
  const unpricedModels = new Map();
  for (const { turn, kind } of turns) {
    addTurn(all, turn);
    addTurn(kinds[kind], turn);
    if (typeof turn.costUsd !== "number") unpricedModels.set(String(turn.model), (unpricedModels.get(String(turn.model)) ?? 0) + 1);
    if (turn.tokens) {
      input.cacheRead += turn.tokens.cacheRead;
      input.side += inputSide(turn.tokens);
    }
    if (kind === "overhead" || (kind === "rowed" && isStanding(turn.session))) {
      const own = standing.get(turn.session) ?? { ...emptyTally(), onRows: emptyTally() };
      addTurn(kind === "overhead" ? own : own.onRows, turn);
      standing.set(turn.session, own);
    }
  }
  return { all, ...kinds, standing, input, unpricedModels };
}

/** A standing lead: not a spawned worker or reviewer, which belong to one row or pull request. @param {string} session */
const isStanding = (session) => !/^(worker|reviewer)-/.test(session) && !UNATTRIBUTABLE.test(session);

/** @param {Tally} part @param {Tally} whole */
function shareOf(part, whole) {
  return { dollars: whole.dollars > 0 ? part.dollars / whole.dollars : null, tokens: whole.tokens > 0 ? part.tokens / whole.tokens : null };
}

/** @param {ReturnType<typeof spendOf>} spend @param {string[]} unreadable the transcripts the ingest could not read: no turn of theirs is in the store, so they are listed, not folded in */
function spendFigures(spend, unreadable) {
  const standing = [...spend.standing].filter(([, own]) => own.turns > 0).sort(([a], [b]) => a.localeCompare(b));
  return {
    turns: spend.all.turns, dollars: spend.all.dollars, unpriced: spend.all.unpriced, tokens: spend.all.tokens,
    overhead: { ...spend.overhead, share: shareOf(spend.overhead, spend.all), bySession: standing.map(([session, own]) => ({ session, ...own, onRows: own.onRows })) },
    unmeasured: { ...spend.unmeasured, unreadableTranscripts: unreadable },
    unplaced: spend.unplaced,
    unpricedModels: [...spend.unpricedModels].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).slice(0, UNPRICED_LISTED),
    cacheRead: { share: spend.input.side > 0 ? spend.input.cacheRead / spend.input.side : null, cacheRead: spend.input.cacheRead, inputSide: spend.input.side },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Per merged row

/** The first claim record of each row: the earliest `claimed` event, in one pass. @param {TraceEvent[]} events @returns {Map<number, number>} */
export function claimsOf(events) {
  /** @type {Map<number, number>} */
  const first = new Map();
  for (const event of events) {
    if (event.kind === "claimed" && typeof event.row === "number") first.set(event.row, Math.min(first.get(event.row) ?? event.at, event.at));
  }
  return first;
}

/**
 * @param {MergedRow} merged @param {{ byRow: Map<number, Tally>, claims: Map<number, number> }} held
 */
function rowFigures(merged, { byRow, claims }) {
  const tally = byRow.get(merged.row);
  const claimedAt = claims.get(merged.row) ?? null;
  const base = { row: merged.row, repo: merged.repo, mergedAt: merged.mergedAt, wallClockMs: claimedAt === null ? null : Math.max(0, merged.mergedAt - claimedAt) };
  if (!tally || tally.turns === 0) return { ...base, held: false, turns: 0, tokens: null, dollars: null, floor: false, unpriced: 0 };
  return { ...base, held: true, turns: tally.turns, tokens: tally.tokens, dollars: tally.priced > 0 ? tally.dollars : null, floor: tally.unpriced > 0, unpriced: tally.unpriced };
}

/** The dearest first; a tie in dollars is broken by tokens, then by row number, so two runs print the same list. @param {ReturnType<typeof rowFigures>[]} rows */
function dearest(rows) {
  return rows.filter((row) => row.dollars !== null)
    .sort((a, b) => /** @type {number} */ (b.dollars) - /** @type {number} */ (a.dollars) || /** @type {number} */ (b.tokens) - /** @type {number} */ (a.tokens) || a.row - b.row).slice(0, DEAREST);
}

/** @param {ReturnType<typeof rowFigures>[]} rows */
function perRowSpread(rows) {
  const held = rows.filter((row) => row.held);
  const priced = held.filter((row) => row.dollars !== null);
  return {
    rows: rows.length, noTurns: rows.length - held.length, noPrice: held.length - priced.length, floors: priced.filter((row) => row.floor).length,
    dollars: spread(priced.map((row) => /** @type {number} */ (row.dollars))), tokens: spread(held.map((row) => /** @type {number} */ (row.tokens))),
    wallClock: spread(rows.flatMap((row) => (row.wallClockMs === null ? [] : [row.wallClockMs]))), noClaim: rows.filter((row) => row.wallClockMs === null).length,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Where a row's time and dollars went, by phase (#3511)

const SUM_TOLERANCE = 1e-9;
/** @typedef {ReturnType<typeof waterfall>} Waterfall */

/** The eight phases and `between`, in the order the report counts them. @param {Waterfall} wf */
const countedPhases = (wf) => [...wf.phases, wf.between];

/** @param {number[]} values */
const total = (values) => values.reduce((sum, value) => sum + value, 0);

/**
 * Each phase's share of the rows' whole wall-clock and whole dollars. The denominators are the rows' OWN totals (their wall-clock from the first phase's start to the last one's end, and
 * the dollars of all their turns), not the sum of the phases, so the shares add up to the whole only if every moment and every turn is in exactly one phase, and a share that does not
 * sum to the whole THROWS: a printed table that leaves a part out would look complete.
 * @param {Waterfall[]} waterfalls only those with a phase record (`start` not null): a row with none has turns and no phases, and its turns would sit in `between`
 */
export function phaseShares(waterfalls) {
  const wallClockMs = total(waterfalls.map((wf) => wf.whole.wallClockMs));
  const dollars = total(waterfalls.map((wf) => wf.spend.dollars));
  const shares = [...PHASES, BETWEEN].map((phase) => {
    const own = waterfalls.flatMap((wf) => countedPhases(wf).filter((one) => one.phase === phase));
    const exclusiveMs = total(own.map((one) => one.exclusiveMs));
    const spent = total(own.map((one) => one.spend.dollars));
    return { phase, exclusiveMs, wallShare: wallClockMs > 0 ? exclusiveMs / wallClockMs : null, dollars: spent, dollarShare: dollars > 0 ? spent / dollars : null, unpriced: total(own.map((one) => one.spend.unpriced)) };
  });
  for (const [name, key, whole] of /** @type {const} */ ([["wall-clock", "wallShare", wallClockMs], ["dollars", "dollarShare", dollars]])) {
    const added = total(shares.map((share) => share[key] ?? 0));
    if (whole > 0 && Math.abs(added - 1) > SUM_TOLERANCE) throw new Error(`the phase shares of ${name} add up to ${added}, not the whole: refusing to print a table that leaves a part out`);
  }
  return { rows: waterfalls.length, wallClockMs, dollars, unpriced: total(waterfalls.map((wf) => wf.spend.unpriced)), shares };
}

/**
 * The phase whose turns cost most of the row, and the phase with the most wall-clock to itself. A waterfall with no phase record has none: its turns would all fall in `between`,
 * which would read as a finding about the row when it is only the absence of the row's GitHub history.
 * @param {Waterfall} wf
 */
export function dearestPhase(wf) {
  if (wf.start === null) return { costliest: null, longest: null };
  const parts = countedPhases(wf);
  const costly = [...parts].sort((a, b) => b.spend.dollars - a.spend.dollars)[0];
  const long = [...parts].sort((a, b) => b.exclusiveMs - a.exclusiveMs)[0];
  return {
    costliest: wf.spend.priced > 0 && costly ? { phase: costly.phase, dollars: costly.spend.dollars, share: costly.spend.dollars / wf.spend.dollars, floor: wf.spend.unpriced > 0 } : null,
    longest: wf.whole.wallClockMs > 0 && long ? { phase: long.phase, ms: long.exclusiveMs, share: long.exclusiveMs / wf.whole.wallClockMs } : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Repeat waste

/**
 * @typedef {{ events: TraceEvent[], turns: TraceEvent[], keys: Keys, at: number, claimed: Set<string>,
 *   turnsOf: { wake: Map<string, TraceEvent[]>, session: Map<string, TraceEvent[]>, row: Map<number, TraceEvent[]> } }} Repeat
 */

/** Price `turns` once each (a turn another class took is skipped), whole or by its input side. @param {TraceEvent[]} turns @param {Set<string>} claimed @param {"whole" | "input"} part */
function priceOnce(turns, claimed, part) {
  let dollars = 0;
  let tokens = 0;
  let floor = false;
  let priced = 0;
  let unpriced = 0;
  for (const turn of turns) {
    if (claimed.has(turn.id) || !turn.tokens) continue;
    claimed.add(turn.id);
    const cost = part === "whole" ? turn.costUsd ?? null : costOf(turn.model, { ...turn.tokens, output: 0 });
    tokens += part === "whole" ? allTokens(turn.tokens) : inputSide(turn.tokens);
    if (typeof cost === "number") {
      dollars += cost;
      priced += 1;
    } else {
      floor = true;
      unpriced += 1;
    }
  }
  return { dollars, tokens, floor, priced, unpriced };
}

/** A class whose every turn is unpriced is NOT zero dollars: it is not derivable, and says how many turns it could not price. @param {{ id: string, label: string, count: number }} head @param {ReturnType<typeof priceOnce>} priced @returns {RepeatClass} */
const classOf = (head, priced) => ({ ...head, dollars: priced.priced === 0 && priced.unpriced > 0 ? NOT_DERIVABLE : priced.dollars, floor: priced.floor, tokens: priced.tokens, unpriced: priced.unpriced });

const DEFERRED_MARK = "@deferred:";

/**
 * The wakes of the week that repeat an order their session already had, each with its ledger key and the time since that key was last delivered (in this week or before it).
 * @param {TraceEvent[]} events @param {number} at the week's start
 */
function repeatsOf(events, at) {
  /** @type {Map<string, number>} */
  const lastDelivered = new Map();
  /** @type {{ wake: TraceEvent, key: string, gapMs: number }[]} */
  const repeats = [];
  for (const wake of events.filter((event) => event.kind === "wake" && event.causeKey).sort((a, b) => a.at - b.at)) {
    const key = `${wake.session}\t${String(wake.causeKey).split(DEFERRED_MARK)[0]}`;
    const before = lastDelivered.get(key);
    if (before !== undefined && inWeek(wake, at)) repeats.push({ wake, key, gapMs: wake.at - before });
    lastDelivered.set(key, wake.at);
  }
  return repeats;
}

/**
 * The repeats by gate cause (the wake's own `cause`). A repeat whose key carries `@deferred` is the same order re-sent after a deferral, and is its own row: a deferral retry and a wake that was
 * delivered anyway are different defects. Dollars are priced once per turn through the shared `claimed`, so the rows add up to the class; the dearest cause is first (the chairman's order is in dollars), repeats beside it.
 * @param {ReturnType<typeof repeatsOf>} repeats @param {Repeat["turnsOf"]["wake"]} turnsOfWake @param {Set<string>} claimed
 * @returns {{ causes: RedeliveredCause[], priced: ReturnType<typeof priceOnce>[] }}
 */
function causesOf(repeats, turnsOfWake, claimed) {
  /** @type {Map<string, typeof repeats>} */
  const groups = new Map();
  for (const repeat of repeats) {
    const group = `${repeat.wake.cause ?? "unknown"}\t${String(repeat.wake.causeKey).includes(DEFERRED_MARK)}`;
    groups.set(group, [...(groups.get(group) ?? []), repeat]);
  }
  const entries = [...groups].map(([group, members]) => {
    const [cause, deferred] = group.split("\t");
    const priced = priceOnce(members.flatMap(({ wake }) => turnsOfWake.get(wake.id) ?? []), claimed, "whole");
    const money = classOf({ id: group, label: cause, count: members.length }, priced);
    return { priced, row: /** @type {RedeliveredCause} */ ({
      cause, deferred: deferred === "true", count: members.length, keys: new Set(members.map(({ key }) => key)).size, medianGapMs: nearestRank(members.map(({ gapMs }) => gapMs), FIRST_RANK_PERCENT),
      dollars: money.dollars, floor: money.floor, tokens: money.tokens, unpriced: priced.unpriced }) };
  });
  const worth = (/** @type {RedeliveredCause} */ row) => (typeof row.dollars === "number" ? row.dollars : -1); // a cause with no derivable dollars sorts after every priced one, never as a free one
  entries.sort((a, b) => worth(b.row) - worth(a.row) || b.row.count - a.row.count || b.row.tokens - a.row.tokens || a.row.cause.localeCompare(b.row.cause) || Number(a.row.deferred) - Number(b.row.deferred));
  return { causes: entries.map(({ row }) => row), priced: entries.map(({ priced }) => priced) };
}

/** @param {ReturnType<typeof priceOnce>[]} tallies @returns {ReturnType<typeof priceOnce>} */
const sumPriced = (tallies) => tallies.reduce((sum, one) => ({ dollars: sum.dollars + one.dollars, tokens: sum.tokens + one.tokens, floor: sum.floor || one.floor, priced: sum.priced + one.priced, unpriced: sum.unpriced + one.unpriced }),
  { dollars: 0, tokens: 0, floor: false, priced: 0, unpriced: 0 });

/** @param {Repeat} context */
function redelivered({ events, turnsOf, at, claimed }) {
  const repeats = repeatsOf(events, at);
  const { causes, priced } = causesOf(repeats, turnsOf.wake, claimed);
  return { ...classOf({ id: "redelivered", label: "re-delivered orders", count: repeats.length }, sumPriced(priced)), causes };
}

/** The events of one kind, by pull request key, in time order. @param {TraceEvent[]} events @param {string} kind @param {Keys} keys */
function byPullRequest(events, kind, keys) {
  /** @type {Map<string, TraceEvent[]>} */
  const groups = new Map();
  for (const event of events.filter((candidate) => candidate.kind === kind && typeof candidate.pr === "number").sort((a, b) => a.at - b.at)) {
    const key = prKey(keys, event.repo, /** @type {number} */ (event.pr));
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return groups;
}

/** @param {Repeat} context */
function rereviews({ events, turns, keys, at, claimed }) {
  let count = 0;
  /** @type {TraceEvent[]} */
  const between = [];
  for (const [key, reviews] of byPullRequest(events, "reviewed", keys)) {
    const later = reviews.slice(1).filter((review) => inWeek(review, at));
    count += later.length;
    if (later.length === 0) continue;
    const reviewers = turns.filter((turn) => { const target = reviewerTarget(turn.session, keys.rowRepo); return target !== null && `${target.repo}#${target.number}` === key; });
    between.push(...reviewers.filter((turn) => turn.at > reviews[0].at && turn.at <= later[later.length - 1].at && inWeek(turn, at)));
  }
  return classOf({ id: "rereview", label: "re-reviews", count }, priceOnce(between, claimed, "whole"));
}

/** @param {Repeat} context */
function requeues({ events, keys, at, claimed, turnsOf }) {
  let count = 0;
  /** @type {TraceEvent[]} */
  const between = [];
  const exits = byPullRequest(events, "removed_from_merge_queue", keys);
  for (const [key, entries] of byPullRequest(events, "added_to_merge_queue", keys)) {
    for (const [index, entry] of entries.entries()) {
      if (index === 0 || !inWeek(entry, at)) continue;
      count += 1;
      const exit = (exits.get(key) ?? []).filter((candidate) => candidate.outcome === "unmerged" && candidate.at < entry.at).pop();
      const from = exit?.at ?? entries[index - 1].at;
      for (const row of keys.prRows.get(key) ?? []) between.push(...(turnsOf.row.get(row) ?? []).filter((turn) => turn.at > from && turn.at <= entry.at));
    }
  }
  return classOf({ id: "requeue", label: "re-queues", count }, priceOnce(between, claimed, "whole"));
}

/** @param {Repeat} context */
function compactions({ events, turnsOf, at, claimed }) {
  const made = events.filter((event) => event.kind === "compaction" && inWeek(event, at));
  const after = made.flatMap((event) => (turnsOf.session.get(event.session) ?? []).filter((turn) => !turn.sidechain && turn.at > event.at).slice(0, 1));
  return classOf({ id: "compaction", label: "compactions (re-read of the window after each)", count: made.length }, priceOnce(after, claimed, "input"));
}

/** @param {Repeat} context */
function preambles({ events, turnsOf, at, claimed }) {
  /** @type {Map<string, TraceEvent[]>} */
  const bySession = new Map();
  for (const wake of events.filter((event) => event.kind === "wake").sort((a, b) => a.at - b.at)) bySession.set(wake.session, [...(bySession.get(wake.session) ?? []), wake]);
  const later = [...bySession.values()].flatMap((wakes) => wakes.slice(1)).filter((wake) => inWeek(wake, at));
  const first = later.flatMap((wake) => (turnsOf.wake.get(wake.id) ?? []).filter((turn) => !turn.sidechain).slice(0, 1));
  return classOf({ id: "preamble", label: "preamble reloads at each wake after the first", count: later.length }, priceOnce(first, claimed, "input"));
}

/** @param {Repeat} context @returns {RepeatClass} */
function ciReruns({ events, keys, at }) {
  const runs = events.filter((event) => event.kind === "ci_run" && typeof event.pr === "number");
  const seen = new Set();
  const again = runs.sort((a, b) => a.at - b.at).filter((run) => {
    const key = `${prKey(keys, run.repo, /** @type {number} */ (run.pr))}\t${run.name}`;
    const repeat = seen.has(key);
    seen.add(key);
    return repeat && inWeek(run, at);
  });
  const ms = again.reduce((sum, run) => sum + Math.max(0, (run.completedAt ?? run.startedAt ?? 0) - (run.startedAt ?? 0)), 0);
  return { id: "ci-rerun", label: "CI re-runs", count: again.length, dollars: NOT_DERIVABLE, floor: false, tokens: 0, ms };
}

/** @returns {RepeatClass} */
const deferredWaits = () => ({ id: "deferred", label: "deferred waits", count: 0, dollars: DEFERRAL_LOG_HELD ? 0 : NOT_HELD, floor: false, tokens: 0 });

/** Every class for one week, the whole-turn ones before the input-side ones: the ORDER is the definition of who claims a turn. @param {Repeat} context */
function repeatClasses(context) {
  return [redelivered(context), rereviews(context), requeues(context), compactions(context), preambles(context), ciReruns(context), deferredWaits()];
}

/** The headline: the dollars of the classes that have a derivation, a floor when any class has a turn it could not price (the tokens are every class's: they are measured). @param {RepeatClass[]} classes */
function repeatTotal(classes) {
  const priced = classes.filter((entry) => typeof entry.dollars === "number");
  return { dollars: priced.reduce((sum, entry) => sum + /** @type {number} */ (entry.dollars), 0), floor: classes.some((entry) => entry.floor), tokens: classes.reduce((sum, entry) => sum + entry.tokens, 0) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Wake counts, against wakes-per-row's

/**
 * @typedef {{ row: number, store: number, wakesPerRow: number | null, reason: string }} WakeDifference
 */

/**
 * How many wakes of each row's own worker and reviewer sessions the store holds, by wakes-per-row's placement rule (a reviewer's wake counts only inside its pull request's
 * open-to-merge window). The standing leads' wakes naming the row are the store's alone and are not in this count.
 * @param {{ events: TraceEvent[], keys: Keys, pulls: import("../wakes-per-row.mjs").PullRequest[] }} input
 * @returns {Map<number, number>}
 */
function storeWakeCounts({ events, keys, pulls }) {
  const windows = new Map(pulls.map((pull) => [`${pull.repo}#${pull.number}`, { from: Date.parse(pull.createdAt), to: Date.parse(pull.mergedAt) }]));
  /** @type {Map<number, number>} */
  const counts = new Map();
  for (const wake of events.filter((event) => event.kind === "wake" && /^(worker|reviewer)-/.test(event.session))) {
    const target = reviewerTarget(wake.session, keys.rowRepo);
    const inside = target ? windows.get(`${target.repo}#${target.number}`) : undefined;
    if (target && !(inside && wake.at >= inside.from && wake.at <= inside.to)) continue;
    for (const row of subjectsOfEvent(wake, keys).rows) counts.set(row, (counts.get(row) ?? 0) + 1);
  }
  return counts;
}

/**
 * Why the store's count of a row's wakes and wakes-per-row's differ, from what is known of the two: a row wakes-per-row could not measure, a row claimed before the store's
 * ingest window (its first transcripts are not here), else UNEXPLAINED, which is printed as such and counted.
 * @param {{ reading: import("../wakes-per-row.mjs").RowReading | undefined, claimedAt: number | null, heldFrom: number | null, store: number }} facts
 */
function whyDifferent({ reading, claimedAt, heldFrom, store }) {
  if (!reading) return "wakes-per-row has no reading for this row (it is not among the rows merged in its window)";
  if (!reading.measured) return `wakes-per-row has it UNMEASURED (${reading.unmeasured})`;
  if (heldFrom !== null && claimedAt !== null && claimedAt < heldFrom) return `the store starts at its ingest window (${new Date(heldFrom).toISOString()}), after the row was claimed`;
  return `UNEXPLAINED: the store holds ${store} wakes and wakes-per-row ${reading.wakes}`;
}

/**
 * @param {{ merged: MergedRow[], readings: import("../wakes-per-row.mjs").RowReading[] | null, wakeCounts: Map<number, number>, claims: Map<number, number>,
 *   heldFrom: number | null }} input
 */
function compareWakes({ merged, readings, wakeCounts, claims, heldFrom }) {
  if (readings === null) return null;
  /** @type {WakeDifference[]} */
  const differ = [];
  for (const { row } of merged) {
    const reading = readings.find((candidate) => candidate.row === row);
    const store = wakeCounts.get(row) ?? 0;
    if (reading?.measured && reading.wakes === store) continue;
    differ.push({ row, store, wakesPerRow: reading?.measured ? reading.wakes : null, reason: whyDifferent({ reading, claimedAt: claims.get(row) ?? null, heldFrom, store }) });
  }
  return { rows: merged.length, agree: merged.length - differ.length, differ };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// The report

/** @param {{ events: TraceEvent[], keys: Keys }} input */
function indexes({ events, keys }) {
  const turns = events.filter((event) => event.kind === "turn").sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const placed = turns.map((turn) => ({ turn, ...place(turn, keys) }));
  /** @type {Map<number, Tally>} */
  const byRow = new Map();
  /** @type {{ wake: Map<string, TraceEvent[]>, session: Map<string, TraceEvent[]>, row: Map<number, TraceEvent[]> }} */
  const turnsOf = { wake: new Map(), session: new Map(), row: new Map() };
  for (const entry of placed) {
    const { turn } = entry;
    if (turn.wakeId) turnsOf.wake.set(turn.wakeId, [...(turnsOf.wake.get(turn.wakeId) ?? []), turn]);
    turnsOf.session.set(turn.session, [...(turnsOf.session.get(turn.session) ?? []), turn]);
    if (entry.kind !== "rowed") continue;
    for (const row of entry.rows) {
      addTurn(byRow.get(row) ?? byRow.set(row, emptyTally()).get(row) ?? emptyTally(), turn);
      turnsOf.row.set(row, [...(turnsOf.row.get(row) ?? []), turn]);
    }
  }
  return { turns, placed, byRow, turnsOf };
}

/**
 * @param {{ start: number, now: number, held: { from: number | null, basis: string }, unread: number }} input
 * @returns {string | null} why the week is partial, or `null` when the store holds all of it
 */
function partialReason({ start, now, held, unread }) {
  const reasons = [];
  if (start + WEEK_MS > now) reasons.push("the week is not over");
  if (unread > 0) reasons.push(`GitHub's events are not yet read for ${unread} of its merged rows (a second run continues; the claims, reviews, queue entries and CI runs of those rows are missing)`);
  if (held.from === null) reasons.push(`the store's window is unknown (${held.basis})`);
  else if (start < held.from) reasons.push(`the store holds transcripts only from ${new Date(held.from).toISOString()} (${held.basis})`);
  return reasons.length === 0 ? null : reasons.join("; ");
}

/**
 * The report. `readings` is wakes-per-row's `measure` result for each week by its start (`null` for a week it was not run for).
 * `openRows` are the rows GitHub says are open at the reading (`null` when not asked: none is then called open). `unreadRows` are the merged rows whose GitHub events the run did not get to: a week holding one is PARTIAL.
 * @param {{ events: TraceEvent[], pulls: import("../wakes-per-row.mjs").PullRequest[], rowRepo: string, now: number, since: number, held: { from: number | null, basis: string },
 *   readings?: Map<number, import("../wakes-per-row.mjs").RowReading[]>, unreadable?: string[], unreadRows?: number[], openRows?: number[] | null }} input
 */
export function aggregate({ events: stored, pulls, rowRepo, now, since, held, readings = new Map(), unreadable = [], unreadRows = [], openRows = null }) {
  const events = repriceEvents(stored); // every dollar below, the waterfalls' included, is at PRICES now and not at the price the turn was stored with (#3638)
  const keys = { rowRepo, org: rowRepo.split("/")[0], prRows: prRowsOf(pulls, rowRepo) };
  const { turns, placed, byRow, turnsOf } = indexes({ events, keys });
  const everyMerge = mergedRows(pulls, { from: -Infinity, to: Infinity }, rowRepo);
  const claims = claimsOf(events);
  const unreadSet = new Set(unreadRows);
  const wakeCounts = storeWakeCounts({ events, keys, pulls });
  const traceEvents = events.filter((event) => event.kind !== "gh_call");
  const weeks = [];
  for (let start = weekStart(since); start <= weekStart(now); start += WEEK_MS) {
    const merged = everyMerge.filter((entry) => entry.mergedAt >= start && entry.mergedAt < start + WEEK_MS);
    const rows = merged.map((entry) => rowFigures(entry, { byRow, claims }));
    const githubUnread = merged.filter((entry) => unreadSet.has(entry.row)).length;
    const classes = repeatClasses({ events, turns, keys, at: start, claimed: new Set(), turnsOf });
    const waterfalls = new Map(merged.map((entry) => [entry.row, waterfall({ events: eventsForRow(traceEvents, { rows: [entry.row], prs: entry.pulls }), now })]));
    const drawn = [...waterfalls.values()].filter((wf) => wf.start !== null);
    weeks.push({
      start, end: start + WEEK_MS, githubUnread, partial: partialReason({ start, now, held, unread: githubUnread }), rows: rows.sort((a, b) => a.row - b.row), perRow: perRowSpread(rows),
      dearest: dearest(rows).map((row) => ({ ...row, phase: dearestPhase(/** @type {Waterfall} */ (waterfalls.get(row.row))) })),
      phases: { ...phaseShares(drawn), noRecord: merged.length - drawn.length },
      spend: spendFigures(spendOf(placed.filter((entry) => inWeek(entry.turn, start))), unreadable), repeats: { classes, total: repeatTotal(classes) },
      wakes: compareWakes({ merged, readings: readings.get(start) ?? null, wakeCounts, claims, heldFrom: held.from }),
    });
  }
  return { weeks, ...unmerged({ byRow, merged: everyMerge, openRows }), held, since: weekStart(since), now };
}

/**
 * Rows with turns and no merge IN THIS READING, split by what GitHub says of them: still open (`openRows`, read at the run), or not open and not merged in the window of this
 * reading (merged before it, or closed with no merge): their spend is real and in no average. With `openRows` unknown, none is called open.
 * @param {{ byRow: Map<number, Tally>, merged: MergedRow[], openRows: number[] | null }} input
 */
function unmerged({ byRow, merged, openRows }) {
  const done = new Set(merged.map((entry) => entry.row));
  const stillOpen = new Set(openRows ?? []);
  const listed = [...byRow].filter(([row]) => !done.has(row)).map(([row, tally]) => ({
    row, status: /** @type {"open" | "outside"} */ (stillOpen.has(row) ? "open" : "outside"), turns: tally.turns, tokens: tally.tokens,
    dollars: tally.priced > 0 ? tally.dollars : null, floor: tally.unpriced > 0,
  })).sort((a, b) => (b.dollars ?? -1) - (a.dollars ?? -1) || b.tokens - a.tokens || a.row - b.row);
  return { open: listed.filter((entry) => entry.status === "open"), outside: listed.filter((entry) => entry.status === "outside"), openKnown: openRows !== null };
}

/** Consecutive COMPLETE weeks only: a partial week is printed and never compared (a week the store holds half of would read as a saving). @param {ReturnType<typeof aggregate>["weeks"]} weeks */
export function compareWeeks(weeks) {
  const complete = weeks.filter((week) => week.partial === null);
  return complete.slice(1).map((week, index) => {
    const before = complete[index];
    const delta = (/** @type {number | null} */ a, /** @type {number | null} */ b) => (a === null || b === null ? null : b - a);
    return {
      from: before.start, to: week.start,
      p50Dollars: delta(before.perRow.dollars.p50, week.perRow.dollars.p50), p90Dollars: delta(before.perRow.dollars.p90, week.perRow.dollars.p90),
      overheadShare: delta(before.spend.overhead.share.dollars, week.spend.overhead.share.dollars), repeatDollars: week.repeats.total.dollars - before.repeats.total.dollars,
      cacheReadShare: delta(before.spend.cacheRead.share, week.spend.cacheRead.share),
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Text

/** @param {number} ms */
const day = (ms) => new Date(ms).toISOString().slice(0, "YYYY-MM-DD".length);
/** @param {number} ms */
const hours = (ms) => `${(ms / (60 * 60 * 1000)).toFixed(1)}h`;
/** @param {number | null} value @param {boolean} [floor] */
const dollars = (value, floor = false) => (value === null ? "n/a" : `${floor ? ">= " : ""}$${value.toFixed(DOLLAR_DECIMALS)}`);
/** @param {number | null} value */
const percent = (value) => (value === null ? "n/a" : `${(value * PERCENT).toFixed(SHARE_DECIMALS)}%`);
/** @param {number | null} value */
const count = (value) => (value === null ? "n/a" : Math.round(value).toLocaleString("en-US"));

/** @param {RepeatClass} entry @param {number} githubUnread the merged rows of the week whose GitHub events were not read */
function classLine(entry, githubUnread) {
  const unpriced = entry.unpriced ? ` (${entry.unpriced} turns unpriced)` : "";
  const money = typeof entry.dollars === "number" ? `${dollars(entry.dollars, entry.floor)}, ${count(entry.tokens)} tokens${unpriced}` : `dollars: ${entry.dollars}${unpriced}, ${count(entry.tokens)} tokens`;
  const fromGithub = githubUnread > 0 && GITHUB_CLASSES.has(entry.id) ? `  [FLOOR: GitHub unread for ${githubUnread} rows of this week]` : "";
  return `    ${entry.label.padEnd(48)} ${String(entry.count).padStart(5)}  ${money}${entry.ms === undefined ? "" : `, ${hours(entry.ms)} of runner time`}${fromGithub}`;
}

const MINUTE_MS = 60 * 1000;
/** A gap between two deliveries: minutes under an hour (a nag every 22 minutes is not "0.4h"), hours above. @param {number | null} ms */
const gap = (ms) => (ms === null ? "n/a" : ms < 60 * MINUTE_MS ? `${Math.round(ms / MINUTE_MS)} min` : hours(ms));

/** The re-delivered class's table by gate cause, under its line; no repeats, no table. @param {RepeatClass} entry */
function causeLines(entry) {
  if (!entry.causes || entry.causes.length === 0) return [];
  const rows = entry.causes.map((own) => {
    const money = typeof own.dollars === "number" ? dollars(own.dollars, own.floor) : `dollars: ${own.dollars}`;
    const name = own.deferred ? `${own.cause} @deferred` : own.cause;
    return `      ${name.padEnd(40)} ${String(own.count).padStart(5)} ${String(own.keys).padStart(13)}  ${gap(own.medianGapMs).padStart(9)}  ${money}${own.unpriced ? ` (${own.unpriced} turns unpriced)` : ""}`;
  });
  return [`      ${"by gate cause".padEnd(40)} ${"repeats".padStart(5)} ${"distinct keys".padStart(13)}  ${"median gap".padStart(9)}  dollars`, ...rows];
}

/** @param {ReturnType<typeof aggregate>["weeks"][number]} week */
function weekLines(week) {
  const { perRow, spend } = week;
  const head = `WEEK ${day(week.start)} .. ${day(week.end)}  ${week.partial === null ? "complete" : `PARTIAL, not compared: ${week.partial}`}`;
  const lines = [head, `  merged rows: ${perRow.rows} (no turn in the store: ${perRow.noTurns}; turns but no priced one: ${perRow.noPrice}; dollars a floor: ${perRow.floors})`];
  lines.push(`  per merged row  dollars   p50 ${dollars(perRow.dollars.p50)}  p90 ${dollars(perRow.dollars.p90)}  (n=${perRow.dollars.n})`,
    `                  tokens    p50 ${count(perRow.tokens.p50)}  p90 ${count(perRow.tokens.p90)}  (n=${perRow.tokens.n})`,
    `                  wall-clock p50 ${perRow.wallClock.p50 === null ? "n/a" : hours(perRow.wallClock.p50)}  p90 ${perRow.wallClock.p90 === null ? "n/a" : hours(perRow.wallClock.p90)}  (n=${perRow.wallClock.n}; no claim record: ${perRow.noClaim})`);
  lines.push(`  the week's spend by turn time: ${dollars(spend.dollars, spend.unpriced > 0)} over ${spend.turns - spend.unpriced} priced turns; ${spend.unpriced} turns have a model with no price and are NOT in it (${percent(spend.turns > 0 ? spend.unpriced / spend.turns : null)}), ${count(spend.tokens)} tokens`,
    `    models with no price, by turns: ${spend.unpricedModels.map(([model, turns]) => `${model} ${turns}`).join(", ") || "none"}`,
    `  overhead (no row): ${dollars(spend.overhead.dollars, spend.overhead.unpriced > 0)} = ${percent(spend.overhead.share.dollars)} of the priced dollars (${spend.overhead.unpriced} of its ${spend.overhead.turns} turns unpriced), ${count(spend.overhead.tokens)} tokens = ${percent(spend.overhead.share.tokens)} of tokens`);
  for (const own of spend.overhead.bySession) lines.push(`    ${own.session.padEnd(24)} ${String(own.turns).padStart(5)} turns  ${dollars(own.dollars, own.unpriced > 0)}  ${count(own.tokens)} tokens  (${own.unpriced} unpriced; on a row: ${own.onRows.turns} turns ${dollars(own.onRows.dollars, own.onRows.unpriced > 0)})`);
  lines.push(`  UNMEASURED (not overhead): ${spend.unmeasured.turns} turns, ${dollars(spend.unmeasured.dollars)}; transcripts the ingest could not read: ${spend.unmeasured.unreadableTranscripts.length}${spend.unmeasured.unreadableTranscripts.map((file) => `\n    ${file}`).join("")}`,
    `  UNPLACED (a pull request closing no merged row): ${spend.unplaced.turns} turns, ${dollars(spend.unplaced.dollars)}`,
    `  cache-read share of input: ${percent(spend.cacheRead.share)} (${count(spend.cacheRead.cacheRead)} of ${count(spend.cacheRead.inputSide)} input-side tokens)`,
    `  REPEAT WASTE ${dollars(week.repeats.total.dollars, week.repeats.total.floor)} (${count(week.repeats.total.tokens)} tokens), by class:`, ...week.repeats.classes.flatMap((entry) => [classLine(entry, week.githubUnread), ...causeLines(entry)]));
  return [...lines, ...phaseLines(week), ...dearestLines(week), ...wakeLines(week)];
}

/** @param {ReturnType<typeof aggregate>["weeks"][number]} week */
function dearestLines(week) {
  if (week.dearest.length === 0) return [`  the ${DEAREST} dearest merged rows: none, because no merged row has a priced turn`];
  return [`  the ${DEAREST} dearest merged rows:`, ...week.dearest.flatMap((row) => [`    #${row.row}`.padEnd(10) + `${dollars(row.dollars, row.floor)}  ${count(row.tokens)} tokens  ${row.turns} turns${row.floor ? `  (FLOOR: ${row.unpriced} unpriced turns)` : ""}`,
    `      ${dearestPhaseText(row.phase)}`])];
}

/** @param {ReturnType<typeof dearestPhase>} phase */
function dearestPhaseText(phase) {
  if (phase.costliest === null && phase.longest === null) return "phases: none (no phase record of this row in the store)";
  const cost = phase.costliest ? `${phase.costliest.phase} ${dollars(phase.costliest.dollars, phase.costliest.floor)} (${percent(phase.costliest.share)} of its turns' dollars)` : "no priced turn";
  return `dearest phase: ${cost}; most wall-clock to itself: ${phase.longest ? `${phase.longest.phase} ${hours(phase.longest.ms)} (${percent(phase.longest.share)})` : "n/a"}`;
}

/** @param {ReturnType<typeof aggregate>["weeks"][number]} week */
function phaseLines(week) {
  const { phases } = week;
  if (phases.rows === 0) return [`  PHASE SHARE: none of the ${phases.noRecord} merged rows has a phase record in the store (their GitHub events are not read), so no share is given`];
  return [`  PHASE SHARE over ${phases.rows} merged rows (${phases.noRecord} with no phase record are in no share): ${hours(phases.wallClockMs)} of wall-clock, ${dollars(phases.dollars, phases.unpriced > 0)} in the turns of their waterfalls`,
    ...phases.shares.map((share) => `    ${share.phase.padEnd(8)} ${percent(share.wallShare).padStart(6)} of wall-clock (${hours(share.exclusiveMs)} to itself)  ${percent(share.dollarShare).padStart(6)} of dollars (${dollars(share.dollars, share.unpriced > 0)})`)];
}

/** @param {ReturnType<typeof aggregate>["weeks"][number]} week */
function wakeLines(week) {
  if (week.wakes === null) return ["  wakes: wakes-per-row was not run for this week, so the counts are not compared"];
  return [`  wakes against wakes-per-row: ${week.wakes.agree} of ${week.wakes.rows} rows agree`,
    ...groupByReason(week.wakes.differ)];
}

/** @param {ReturnType<typeof aggregate>} report @param {{ ingestFooter?: string[] }} [footer] */
export function renderAggregate(report, footer = {}) {
  const lines = ["TRACE --AGGREGATE (a reading at a moment: re-run it, do not quote it)", "", "DEFINITIONS", ...DEFINITIONS.map((line) => `- ${line}`), "",
    `reading taken ${new Date(report.now).toISOString()}; weeks from ${day(report.since)}; the store holds transcripts from ${report.held.from === null ? "an unknown time" : new Date(report.held.from).toISOString()} (${report.held.basis})`, ""];
  for (const week of report.weeks) lines.push(...weekLines(week), "");
  const trend = compareWeeks(report.weeks);
  lines.push("WEEK OVER WEEK (complete weeks only; a partial week is never compared):");
  for (const step of trend) lines.push(`  ${day(step.from)} -> ${day(step.to)}: p50 dollars ${signed(step.p50Dollars)}, p90 ${signed(step.p90Dollars)}, overhead share ${signedShare(step.overheadShare)}, repeat waste ${signed(step.repeatDollars)}, cache-read share ${signedShare(step.cacheReadShare)}`);
  if (trend.length === 0) lines.push("  fewer than two complete weeks: nothing to compare yet");
  lines.push("", `OPEN ROWS, in no average (${report.openKnown ? report.open.length : "not asked"}); the ${DEAREST} dearest:`, ...report.open.slice(0, DEAREST).map(openLine),
    `ROWS MERGED BEFORE THESE WEEKS OR CLOSED WITH NO MERGE (OUTSIDE), in no average (${report.outside.length}); the ${DEAREST} dearest:`, ...report.outside.slice(0, DEAREST).map(openLine));
  return [...lines, ...(footer.ingestFooter ?? [])].join("\n");
}

/** @param {number | null} value */
const signed = (value) => (value === null ? "n/a" : `${value < 0 ? "-" : "+"}$${Math.abs(value).toFixed(DOLLAR_DECIMALS)}`);
/** @param {number | null} value */
const signedShare = (value) => (value === null ? "n/a" : `${value < 0 ? "-" : "+"}${Math.abs(value * PERCENT).toFixed(SHARE_DECIMALS)} points`);
/** @param {ReturnType<typeof unmerged>["open"][number]} row */
const openLine = (row) => `  #${row.row}`.padEnd(10) + `${dollars(row.dollars, row.floor)}  ${count(row.tokens)} tokens  ${row.turns} turns  (${row.status})`;

/** One line per reason, with the rows it explains and, for a row whose two counts are both known, what they were: a reason is stated once, however many rows share it. @param {WakeDifference[]} differ */
function groupByReason(differ) {
  /** @type {Map<string, WakeDifference[]>} */
  const groups = new Map();
  for (const entry of differ) {
    const reason = entry.reason.replace(/\d+ wakes and wakes-per-row \d+$/, "N wakes and wakes-per-row M");
    groups.set(reason, [...(groups.get(reason) ?? []), entry]);
  }
  return [...groups].sort(([, a], [, b]) => b.length - a.length).map(([reason, entries]) => {
    const shown = entries.slice(0, DIFFERENCES_LISTED).map((entry) => `#${entry.row} (${entry.store} v ${entry.wakesPerRow ?? "n/a"})`).join(", ");
    return `    ${entries.length} rows -- ${reason}: ${shown}${entries.length > DIFFERENCES_LISTED ? `, and ${entries.length - DIFFERENCES_LISTED} more` : ""}`;
  });
}
