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
import { costOf, eventsForRow, repriceEvents, subjectOf, subjectsOf } from "./store.mjs";
import { BETWEEN, PHASES, waterfall } from "./waterfall.mjs";
import { mergedRows, reviewerTarget, rowsClosedBy } from "../wakes-per-row.ts";

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
  "    EACH CAUSE'S REPEATS ARE SPLIT three ways, read from the store's GitHub record and never guessed: AFTER A CHANGE (between the previous delivery of the key and the repeat, a `claimed`, `released`, `labeled` or `unlabeled` event on the row or pull request the key names, or, for a key that carries a head sha, a `head_moved` to a different head: a row worked a second time), UNCHANGED (the store holds no such record: the order re-sent, the waste), UNEXPLAINED (the store holds no GitHub event at all for the subject, or the key names none: nothing is known, so it is in neither column). The three add up to the cause's repeats, and their dollars to its dollars.",
  "  re-review: a `reviewed` event on a pull request after an earlier one. Dollars: the turns of that pull request's reviewer session between its first review and the later one.",
  "  re-queue: an `added_to_merge_queue` after an earlier one on the same pull request. Dollars: the turns on the pull request's rows between its last unmerged exit from the queue and the re-entry.",
  "  compaction: a compaction of a session. Dollars: the INPUT side (input, cacheRead, cacheWrite; not output) of the first turn the session took after it, which re-reads the window.",
  "  preamble reload: a wake that is not its session's first. Dollars: the INPUT side of its first turn, the re-read of the window every wake pays; the turn's own output is the work and is not waste.",
  "  CI re-run: a check run of a name already run on the same pull request. Counted with its runner time; CI minutes are not tokens, so its dollars are `not derivable`.",
  "  deferred wait: how long a busy seat held an order before it was typed. The deferral log is not in the store (#3510), so it is `not held`, never 0.",
  "PHASE SHARE (#3511): from each merged row's waterfall (`waterfall.mjs`, its own definitions): the wall-clock each phase has to ITSELF (each moment in the latest-started phase running at it; time no phase covers is `between`) and the dollars of the turns that ENDED in it, as a share of the week's merged rows' whole wall-clock (the first phase's start to the last one's end) and whole dollars. The shares add up to the whole, and a report whose do not THROWS instead of printing. A row with no phase record in the store (its GitHub events not read) has no waterfall, is counted apart and is in no share. Dollars are the priced turns only, so a row with an unpriced turn makes them a floor (marked).",
  "DEAREST PHASE (#3511): for each of the ten dearest rows, the phase whose turns cost most (priced dollars, a floor when a turn is unpriced) and the phase with the most wall-clock to itself, each with its share of that row's. The row's dollars here are the waterfall's own (the turns on the row and on the pull requests that close it), so they can differ from the per-row figure above, which also places a standing lead's `touched` write.",
  "BY REPOSITORY (#3967): the week's merged rows grouped by the repository of the LAST pull request that closed them (`MergedRow.repo`: a row closed by pull requests in two repositories is by the one that merged last), with the same per-row figures as above (tokens and dollars per row, P50 and P90, the count of rows behind them) for each repository. A repository with no merged row that week prints no figure, never 0.",
  "BEFORE AND AFTER THE MOVE (#3967): for agent-org and lab, the weeks before the row that moved the package against the weeks after it, each week its own population and never pooled. The move's time is the closing time of its row (agent-org #2974, lab #2703), read from GitHub. A week that holds the move is the MOVE WEEK and is on neither side. AFTER is the rows merged in the package's own repository. BEFORE is the rows merged in the primary repository whose pull requests changed ONLY paths under the package's old directory (`packages/agent-org/`, `packages/lab/`), read from `git log --first-parent` of the primary checkout's `origin/main`, as last fetched (a squash commit ending `(#n)` is read the same way): a row with a pull request that changed paths both under it and elsewhere is MIXED and a row with a pull request not found there is `paths not read`, and neither is on a side. Until a whole week has passed after the move the after side prints `not held`, never 0.",
  "FIRST-TURN SIZE (#3967): the window of the first turn of a transcript, `input + cacheRead + cacheWrite5m + cacheWrite1h`, P50 and P90, over the first turns of the per-row sessions (a spawned `worker-<n>` or `reviewer-<n>`) of the rows in the cut, NEVER of a standing seat, whose first turn is not a start-up. A transcript's first turn is its earliest turn in the store that is not a subagent's. It holds everything the session loads before it can act, and the order it was woken with: the fixed start-up context (the system prompt, the tool definitions, `CLAUDE.md`, `.claude/rules`, the memory index) is in it and is not separated from the order, so this figure is the start-up context plus one order. A cut with no such first turn in the store prints `not held`.",
  "TOOL-READ TOKENS (#3967): the tokens that `Read`, `Grep` and `Glob` results added to the window, MEASURED and not guessed (the store's `toolRead`, defined there): the window of the turn that carries a result, less the window of the message before it, less that message's own output. Summed per row and shown per tool, and as a share of the tokens (all five fields) of the turns that have the figure. Cache reads dominate that denominator and a result is counted once here and read again on every later turn, so the share is small by construction. A Codex reviewer's turns have no figure (its tools are not Claude's) and are in no denominator. A message that called more than one tool is `mixed`: it is in the total and in no per-tool figure, and it can hold results of a tool that is none of the three, so the total is not a floor on reads alone. It holds the few tokens of framing around a result, and counts a result at what the model was charged, which for code is about 2.5 characters a token (a characters-divided-by-four figure reads about half of it, and is never printed here). CHECKED on 20 single-result `Read` calls against their own character counts (2026-10-07): derived tokens are a median 1.76 times characters/4 (p10 1.59), and 5 of the 20 are 3.4 to 16 times it, because whatever else entered the window with the result is in the growth (a nested memory file loaded by the read is in two of them; three are unexplained). On this host the sessions call `Read` far less than `Bash` and have no `Grep` or `Glob` tool (357 `Read` against 11,084 `Bash` calls in three days of transcripts, counted 2026-10-07), so most of what they read through tools is a `Bash` result and is NOT in this figure, and Grep and Glob print 0 because they are not called, not because they were not measured. A turn whose window cannot be read that way (a prompt, an order or a compaction between, a window that shrank) is `not derivable`, and a turn stored before the reader has no figure (`not held`): either makes the row's figure a FLOOR (marked), and a cut whose rows have none prints `not held`.",
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
 * @typedef {{ count: number, dollars: number | typeof NOT_DERIVABLE, floor: boolean, tokens: number, unpriced: number }} Share
 * @typedef {Record<"afterChange" | "unchanged" | "unexplained", Share>} Split
 * @typedef {{ cause: string, deferred: boolean, count: number, keys: number, medianGapMs: number | null, dollars: number | typeof NOT_DERIVABLE, floor: boolean, tokens: number, unpriced: number, split: Split }} RedeliveredCause
 * @typedef {{ id: string, label: string, count: number, dollars: number | typeof NOT_DERIVABLE | typeof NOT_HELD, floor: boolean, tokens: number, unpriced?: number, ms?: number, causes?: RedeliveredCause[], split?: Split }} RepeatClass
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
 * @param {import("../wakes-per-row.ts").PullRequest[]} pulls @param {string} rowRepo
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
  const unpricedCodex = emptyTally(); // a Codex model PRICES has no row for (#4055): these turns are in no dollar figure, so they are counted on their own line and not inside a total
  const pricedCodex = emptyTally(); // the Codex turns that DO have a sourced rate (#4076): inside the dollar totals, and shown again on a line of their own so the Claude part can be read off
  for (const { turn, kind } of turns) {
    addTurn(all, turn);
    addTurn(kinds[kind], turn);
    if (typeof turn.costUsd !== "number") unpricedModels.set(String(turn.model), (unpricedModels.get(String(turn.model)) ?? 0) + 1);
    if (turn.harness === "codex") addTurn(typeof turn.costUsd === "number" ? pricedCodex : unpricedCodex, turn);
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
  return { all, ...kinds, standing, input, unpricedModels, unpricedCodex, pricedCodex };
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
    unpricedCodex: { turns: spend.unpricedCodex.turns, tokens: spend.unpricedCodex.tokens },
    pricedCodex: { turns: spend.pricedCodex.turns, tokens: spend.pricedCodex.tokens, dollars: spend.pricedCodex.dollars },
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

/** Every turn unpriced is NOT zero dollars: it is not derivable. @param {ReturnType<typeof priceOnce>} priced */
const dollarsOf = (priced) => (priced.priced === 0 && priced.unpriced > 0 ? NOT_DERIVABLE : priced.dollars);

/** A class whose every turn is unpriced is NOT zero dollars: it is not derivable, and says how many turns it could not price. @param {{ id: string, label: string, count: number }} head @param {ReturnType<typeof priceOnce>} priced @returns {RepeatClass} */
const classOf = (head, priced) => ({ ...head, dollars: dollarsOf(priced), floor: priced.floor, tokens: priced.tokens, unpriced: priced.unpriced });

const DEFERRED_MARK = "@deferred:";

/** What counts as a change to an order's subject: the claim, a release, or a wait label going on or off. A head moving counts only for a key that names a head. */
const CHANGE_KINDS = new Set(["claimed", "released", "labeled", "unlabeled"]);
/** The head a pull request's key carries (`worker-2667/pr-checks-failing/pr-2669/ed8208fe`): the gate's short prefix of the sha. */
const HEAD_OF_KEY = /\/pr-(?:[\w.-]+#)?\d+\/([0-9a-f]{7,40})$/;
const CHANGES = /** @type {const} */ (["afterChange", "unchanged", "unexplained"]);

/** The rows and pull requests a subject names, as keys that cannot be mistaken for one another. @param {Partial<TraceEvent>} named @param {Keys} keys */
const subjectKeys = (named, keys) => [
  ...[named.row, ...(named.rows ?? [])].filter((row) => typeof row === "number").map((row) => `row ${row}`),
  ...[named.pr, ...(named.prs ?? [])].filter((pr) => typeof pr === "number").map((pr) => prKey(keys, named.repo ?? null, pr)),
];

/** What GitHub saw of each row and pull request, by subject key. @param {TraceEvent[]} events @param {Keys} keys */
function githubRecord(events, keys) {
  /** @type {Map<string, TraceEvent[]>} */
  const record = new Map();
  for (const event of events.filter((candidate) => candidate.source === "github")) {
    for (const subject of subjectKeys(event, keys)) record.set(subject, [...(record.get(subject) ?? []), event]);
  }
  return record;
}

/**
 * Whether the order's subject changed between the previous delivery of its key and this repeat, from the store's GITHUB record alone. The subject is the one THE KEY names (not the
 * session's name: a worker's row is the store's attribution, not the order's), so a key that names none is `unexplained`, like a subject the store holds no GitHub event for: with no
 * record, "nothing changed" is not a finding. A change is in (previous delivery, this one]; one at the previous delivery's own instant is what that delivery answered.
 * @param {{ wake: TraceEvent, gapMs: number }} repeat @param {Map<string, TraceEvent[]>} record @param {Keys} keys
 * @returns {typeof CHANGES[number]}
 */
function changeOf({ wake, gapMs }, record, keys) {
  const key = String(wake.causeKey);
  const held = subjectKeys({ ...subjectOf(key), ...subjectsOf(key) }, keys).flatMap((subject) => record.get(subject) ?? []);
  if (held.length === 0) return "unexplained";
  const head = HEAD_OF_KEY.exec(key.split(DEFERRED_MARK)[0])?.[1];
  const movedAway = (/** @type {TraceEvent} */ event) => head !== undefined && event.kind === "head_moved" && typeof event.headSha === "string" && !event.headSha.startsWith(head);
  return held.some((event) => event.at > wake.at - gapMs && event.at <= wake.at && (CHANGE_KINDS.has(event.kind) || movedAway(event))) ? "afterChange" : "unchanged";
}

/**
 * The wakes of the week that repeat an order their session already had, each with its ledger key, the time since that key was last delivered (in this week or before it) and
 * whether the order's subject changed in between.
 * @param {TraceEvent[]} events @param {number} at the week's start @param {Keys} keys
 */
function repeatsOf(events, at, keys) {
  const record = githubRecord(events, keys);
  /** @type {Map<string, number>} */
  const lastDelivered = new Map();
  /** @type {{ wake: TraceEvent, key: string, gapMs: number, change: typeof CHANGES[number] }[]} */
  const repeats = [];
  for (const wake of events.filter((event) => event.kind === "wake" && event.causeKey).sort((a, b) => a.at - b.at)) {
    const key = `${wake.session}\t${String(wake.causeKey).split(DEFERRED_MARK)[0]}`;
    const before = lastDelivered.get(key);
    if (before !== undefined && inWeek(wake, at)) repeats.push({ wake, key, gapMs: wake.at - before, change: changeOf({ wake, gapMs: wake.at - before }, record, keys) });
    lastDelivered.set(key, wake.at);
  }
  return repeats;
}

/** @typedef {{ count: number, priced: ReturnType<typeof priceOnce> }} Part */

/** @param {Part} part @returns {Share} */
const figuresOf = ({ count, priced }) => ({ count, dollars: dollarsOf(priced), floor: priced.floor, tokens: priced.tokens, unpriced: priced.unpriced });

/** The several parts as one: their repeats and their priced turns, added. @param {Part[]} parts @returns {Part} */
const totalOf = (parts) => ({ count: parts.reduce((sum, part) => sum + part.count, 0), priced: sumPriced(parts.map((part) => part.priced)) });

/** The three parts of a cause's repeats, each priced once, so they add up to the cause. @param {ReturnType<typeof repeatsOf>} members @param {Repeat["turnsOf"]["wake"]} turnsOfWake @param {Set<string>} claimed */
const partsOf = (members, turnsOfWake, claimed) => /** @type {Record<typeof CHANGES[number], Part>} */ (Object.fromEntries(CHANGES.map((change) => {
  const own = members.filter((member) => member.change === change);
  return [change, { count: own.length, priced: priceOnce(own.flatMap(({ wake }) => turnsOfWake.get(wake.id) ?? []), claimed, "whole") }];
})));

/** @param {Record<typeof CHANGES[number], Part>} parts @returns {Split} */
const splitOf = (parts) => /** @type {Split} */ (Object.fromEntries(CHANGES.map((change) => [change, figuresOf(parts[change])])));

/**
 * The repeats by gate cause (the wake's own `cause`). A repeat whose key carries `@deferred` is the same order re-sent after a deferral, and is its own row: a deferral retry and a wake that was
 * delivered anyway are different defects. Dollars are priced once per turn through the shared `claimed`, so the rows add up to the class; the dearest cause is first (the chairman's order is in dollars), repeats beside it.
 * Each cause's repeats are split after a change / unchanged / unexplained (`changeOf`), and the three parts are priced apart and added for the cause, so the split adds up to the cause by construction.
 * @param {ReturnType<typeof repeatsOf>} repeats @param {Repeat["turnsOf"]["wake"]} turnsOfWake @param {Set<string>} claimed
 * @returns {{ causes: RedeliveredCause[], parts: Record<typeof CHANGES[number], Part>[] }}
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
    const parts = partsOf(members, turnsOfWake, claimed);
    const priced = sumPriced(CHANGES.map((change) => parts[change].priced));
    const money = classOf({ id: group, label: cause, count: members.length }, priced);
    return { parts, row: /** @type {RedeliveredCause} */ ({
      cause, deferred: deferred === "true", count: members.length, keys: new Set(members.map(({ key }) => key)).size, medianGapMs: nearestRank(members.map(({ gapMs }) => gapMs), FIRST_RANK_PERCENT),
      dollars: money.dollars, floor: money.floor, tokens: money.tokens, unpriced: priced.unpriced, split: splitOf(parts) }) };
  });
  const worth = (/** @type {RedeliveredCause} */ row) => (typeof row.dollars === "number" ? row.dollars : -1); // a cause with no derivable dollars sorts after every priced one, never as a free one
  entries.sort((a, b) => worth(b.row) - worth(a.row) || b.row.count - a.row.count || b.row.tokens - a.row.tokens || a.row.cause.localeCompare(b.row.cause) || Number(a.row.deferred) - Number(b.row.deferred));
  return { causes: entries.map(({ row }) => row), parts: entries.map(({ parts }) => parts) };
}

/** @param {ReturnType<typeof priceOnce>[]} tallies @returns {ReturnType<typeof priceOnce>} */
const sumPriced = (tallies) => tallies.reduce((sum, one) => ({ dollars: sum.dollars + one.dollars, tokens: sum.tokens + one.tokens, floor: sum.floor || one.floor, priced: sum.priced + one.priced, unpriced: sum.unpriced + one.unpriced }),
  { dollars: 0, tokens: 0, floor: false, priced: 0, unpriced: 0 });

/** @param {Repeat} context */
function redelivered({ events, turnsOf, at, claimed, keys }) {
  const repeats = repeatsOf(events, at, keys);
  const { causes, parts } = causesOf(repeats, turnsOf.wake, claimed);
  const whole = /** @type {Record<typeof CHANGES[number], Part>} */ (Object.fromEntries(CHANGES.map((change) => [change, totalOf(parts.map((own) => own[change]))])));
  return { ...classOf({ id: "redelivered", label: "re-delivered orders", count: repeats.length }, sumPriced(CHANGES.map((change) => whole[change].priced))), causes, split: splitOf(whole) };
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
 * @param {{ events: TraceEvent[], keys: Keys, pulls: import("../wakes-per-row.ts").PullRequest[] }} input
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
 * @param {{ reading: import("../wakes-per-row.ts").RowReading | undefined, claimedAt: number | null, heldFrom: number | null, store: number }} facts
 */
function whyDifferent({ reading, claimedAt, heldFrom, store }) {
  if (!reading) return "wakes-per-row has no reading for this row (it is not among the rows merged in its window)";
  if (!reading.measured) return `wakes-per-row has it UNMEASURED (${reading.unmeasured})`;
  if (heldFrom !== null && claimedAt !== null && claimedAt < heldFrom) return `the store starts at its ingest window (${new Date(heldFrom).toISOString()}), after the row was claimed`;
  return `UNEXPLAINED: the store holds ${store} wakes and wakes-per-row ${reading.wakes}`;
}

/**
 * @param {{ merged: MergedRow[], readings: import("../wakes-per-row.ts").RowReading[] | null, wakeCounts: Map<number, number>, claims: Map<number, number>,
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
// By repository, before and after a move, the first turn and the tokens read through tools (#3967)

/** The per-row sessions: a spawned worker or reviewer belongs to one row or pull request, so its first turn is a start-up for that row. */
const SPAWNED = /^(worker|reviewer)-/;

/** The two packages that left the primary repository, and the row that moved each: `at` is that row's closing time, which the caller reads (`null` when it could not). @typedef {{ name: string, repo: string, row: number, oldDir: string, at: number | null }} Move */
export const MOVES = [
  { name: "agent-org", repo: "a11ign/agent-org", row: 2974, oldDir: "packages/agent-org/" },
  { name: "lab", repo: "a11ign/lab", row: 2703, oldDir: "packages/lab/" },
];

/** The window of each transcript's first turn, by turn id: its earliest turn in the store that is a main thread's, Claude's own. @param {TraceEvent[]} turns in time order @returns {Map<string, number>} */
function firstTurnWindows(turns) {
  /** @type {Map<string, TraceEvent>} */
  const first = new Map();
  for (const turn of turns) {
    if (!turn.tokens || turn.sidechain === true || turn.harness === "codex" || !turn.transcript || first.has(turn.transcript)) continue;
    first.set(turn.transcript, turn);
  }
  return new Map([...first.values()].map((turn) => [turn.id, inputSide(/** @type {Tokens} */ (turn.tokens))]));
}

/**
 * What the turns of one row read through tools. A turn with no field was stored before the reader (`notHeld`), one with a field and no tokens could not be derived (`notDerivable`), and a Codex
 * reviewer's turn is `unmeasured` (its tools are not Claude's): none of the three is in `heldTokens`, the tokens of the turns that do have the figure, which is what a share is of.
 * @param {TraceEvent[]} turns
 */
function toolReadOfTurns(turns) {
  const read = { notHeld: 0, notDerivable: 0, unmeasured: 0, heldTurns: 0, heldTokens: 0, total: 0, mixed: 0, byTool: { Read: 0, Grep: 0, Glob: 0 } };
  for (const turn of turns) {
    const { toolRead } = turn;
    if (turn.harness === "codex") read.unmeasured += 1;
    else if (toolRead === undefined) read.notHeld += 1;
    else {
      read.heldTurns += 1;
      read.heldTokens += turn.tokens ? allTokens(turn.tokens) : 0;
      if (toolRead === null) continue;
      if (toolRead.tokens === null) read.notDerivable += 1;
      else if (toolRead.tool === "mixed") read.mixed += toolRead.tokens;
      else read.byTool[toolRead.tool] += toolRead.tokens;
    }
  }
  read.total = read.mixed + read.byTool.Read + read.byTool.Grep + read.byTool.Glob;
  return read;
}

/** @param {ReturnType<typeof toolReadOfTurns>[]} rows the rows of a cut that have turns */
function toolReadFigures(rows) {
  const held = rows.filter((row) => row.heldTurns > 0);
  const sum = (/** @type {(row: typeof held[number]) => number} */ pick) => held.reduce((all, row) => all + pick(row), 0);
  const tokens = sum((row) => row.heldTokens);
  return {
    rows: held.length, notHeldRows: rows.length - held.length, floorRows: held.filter((row) => row.notHeld > 0 || row.notDerivable > 0).length, notDerivableTurns: sum((row) => row.notDerivable),
    total: sum((row) => row.total), mixed: sum((row) => row.mixed), byTool: { Read: sum((row) => row.byTool.Read), Grep: sum((row) => row.byTool.Grep), Glob: sum((row) => row.byTool.Glob) },
    share: tokens > 0 ? sum((row) => row.total) / tokens : null, perRow: spread(held.map((row) => row.total)),
  };
}

/**
 * One cut of the week's rows (a repository, or one side of a move): the per-row figures, the first-turn size and the tokens read through tools.
 * @param {ReturnType<typeof rowFigures>[]} rows @param {{ turnsOfRow: Map<number, TraceEvent[]>, firstWindows: Map<string, number> }} held
 */
function cutFigures(rows, { turnsOfRow, firstWindows }) {
  /** @type {Map<string, number>} */
  const first = new Map();
  const reads = [];
  for (const row of rows) {
    const turns = turnsOfRow.get(row.row) ?? [];
    for (const turn of turns) if (SPAWNED.test(turn.session) && firstWindows.has(turn.id)) first.set(turn.id, /** @type {number} */ (firstWindows.get(turn.id)));
    if (row.held) reads.push(toolReadOfTurns(turns));
  }
  return { ...perRowSpread(rows), firstTurn: spread([...first.values()]), toolRead: toolReadFigures(reads) };
}

/** @param {ReturnType<typeof rowFigures>[]} rows @param {Parameters<typeof cutFigures>[1]} held */
function byRepository(rows, held) {
  const repos = [...new Set(rows.map((row) => row.repo))].sort();
  return repos.map((repo) => ({ repo, ...cutFigures(rows.filter((row) => row.repo === repo), held) }));
}

/**
 * Where a row merged in the primary repository belongs to a package that has since left it, by what its pull requests changed: `package` when every changed path of every pull request is under the
 * package's old directory, `mixed` when some are and some are not, `other` when none is, `unread` when the paths of one of its pull requests were not read.
 * @param {MergedRow} merged @param {{ move: Move, pullPaths: Map<string, string[]> }} input @returns {"package" | "mixed" | "other" | "unread"}
 */
function placement(merged, { move, pullPaths }) {
  const lists = merged.pulls.map((pull) => pullPaths.get(`${merged.repo}#${pull}`));
  if (lists.some((paths) => paths === undefined || paths.length === 0)) return "unread";
  const paths = lists.flatMap((list) => /** @type {string[]} */ (list));
  const inside = paths.filter((path) => path.startsWith(move.oldDir)).length;
  if (inside === paths.length) return "package";
  return inside > 0 ? "mixed" : "other";
}

/**
 * One move's reading of one week. `side` is `before`, `move-week` (the week that holds the move: on neither side), `after`, or `not held` when the move's time was not read.
 * @param {{ move: Move, start: number, rows: ReturnType<typeof rowFigures>[], merged: MergedRow[], rowRepo: string, pullPaths: Map<string, string[]>, held: Parameters<typeof cutFigures>[1] }} input
 */
function moveOfWeek({ move, start, rows, merged, rowRepo, pullPaths, held }) {
  const base = { name: move.name, row: move.row, at: move.at };
  if (move.at === null) return { ...base, side: /** @type {const} */ ("not held"), cut: null, placed: null };
  const moveWeek = weekStart(move.at);
  if (start === moveWeek) return { ...base, side: /** @type {const} */ ("move-week"), cut: null, placed: null };
  if (start > moveWeek) return { ...base, side: /** @type {const} */ ("after"), cut: cutFigures(rows.filter((row) => row.repo === move.repo), held), placed: null };
  const placed = { package: 0, mixed: 0, other: 0, unread: 0 };
  const ownRows = new Set();
  for (const entry of merged.filter((candidate) => candidate.repo === rowRepo)) {
    const where = placement(entry, { move, pullPaths });
    placed[where] += 1;
    if (where === "package") ownRows.add(entry.row);
  }
  return { ...base, side: /** @type {const} */ ("before"), cut: cutFigures(rows.filter((row) => ownRows.has(row.row)), held), placed };
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
  return { turns, placed, byRow, turnsOf, firstWindows: firstTurnWindows(turns) };
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
 * `moves` are the packages that left the primary repository (`MOVES`, each with its closing time) and `pullPaths` the paths each pull request of the primary repository changed, by `<repo>#<number>`.
 * `openRows` are the rows GitHub says are open at the reading (`null` when not asked: none is then called open). `unreadRows` are the merged rows whose GitHub events the run did not get to: a week holding one is PARTIAL.
 * @param {{ events: TraceEvent[], pulls: import("../wakes-per-row.ts").PullRequest[], rowRepo: string, now: number, since: number, held: { from: number | null, basis: string },
 *   readings?: Map<number, import("../wakes-per-row.ts").RowReading[]>, unreadable?: string[], unreadRows?: number[], openRows?: number[] | null, moves?: Move[], pullPaths?: Map<string, string[]> }} input
 */
export function aggregate({ events: stored, pulls, rowRepo, now, since, held, readings = new Map(), unreadable = [], unreadRows = [], openRows = null, moves = [], pullPaths = new Map() }) {
  const events = repriceEvents(stored); // every dollar below, the waterfalls' included, is at PRICES now and not at the price the turn was stored with (#3638)
  const keys = { rowRepo, org: rowRepo.split("/")[0], prRows: prRowsOf(pulls, rowRepo) };
  const { turns, placed, byRow, turnsOf, firstWindows } = indexes({ events, keys });
  const cutHeld = { turnsOfRow: turnsOf.row, firstWindows };
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
      byRepo: byRepository(rows, cutHeld), moves: moves.map((move) => moveOfWeek({ move, start, rows, merged, rowRepo, pullPaths, held: cutHeld })),
    });
  }
  return { weeks, ...unmerged({ byRow, merged: everyMerge, openRows }), held, since: weekStart(since), now, moves };
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

/** One part of a split as a table cell: how many repeats and what they cost. @param {Share} share */
const shareCell = (share) => `${share.count} ${typeof share.dollars === "number" ? dollars(share.dollars, share.floor) : "n/a"}`;
const SPLIT_COLUMNS = [["afterChange", "after a change"], ["unchanged", "unchanged"], ["unexplained", "unexplained"]];
const SPLIT_WIDTH = 16;

/** The three split cells of a row, in the header's order. @param {Split} split */
const splitCells = (split) => SPLIT_COLUMNS.map(([change]) => shareCell(split[/** @type {keyof Split} */ (change)]).padStart(SPLIT_WIDTH)).join(" ");

/** The re-delivered class's table by gate cause, under its line, with each cause's repeats split into after a change / unchanged / unexplained and a closing row for the class; no repeats, no table. @param {RepeatClass} entry */
function causeLines(entry) {
  if (!entry.causes || entry.causes.length === 0) return [];
  const row = (/** @type {string} */ name, /** @type {{ count: number, dollars: number | string, floor: boolean, unpriced?: number, keys?: number, medianGapMs?: number | null }} */ own, /** @type {Split | undefined} */ split) => {
    const money = typeof own.dollars === "number" ? dollars(own.dollars, own.floor) : `dollars: ${own.dollars}`;
    const keys = own.keys === undefined ? "" : String(own.keys);
    const median = own.medianGapMs === undefined ? "" : gap(own.medianGapMs);
    return `      ${name.padEnd(40)} ${String(own.count).padStart(5)} ${keys.padStart(13)}  ${median.padStart(9)}  ${splitCells(/** @type {Split} */ (split)).trimEnd()}  ${money}${own.unpriced ? ` (${own.unpriced} turns unpriced)` : ""}`;
  };
  const rows = entry.causes.map((own) => row(own.deferred ? `${own.cause} @deferred` : own.cause, own, own.split));
  const heads = SPLIT_COLUMNS.map(([, label]) => label.padStart(SPLIT_WIDTH)).join(" ");
  return [`      ${"by gate cause".padEnd(40)} ${"repeats".padStart(5)} ${"distinct keys".padStart(13)}  ${"median gap".padStart(9)}  ${heads}  dollars`, ...rows,
    ...(entry.split ? [row("all causes", entry, entry.split)] : [])];
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
    `    CODEX turns priced (OpenAI's list rate, sourced in store.mjs; INSIDE the dollars above, Claude = the rest): ${spend.pricedCodex.turns} turns, ${count(spend.pricedCodex.tokens)} tokens, ${dollars(spend.pricedCodex.dollars)}`,
    `    CODEX turns not priced (no rate sourced; in no dollar figure above): ${spend.unpricedCodex.turns} turns, ${count(spend.unpricedCodex.tokens)} tokens`,
    `  overhead (no row): ${dollars(spend.overhead.dollars, spend.overhead.unpriced > 0)} = ${percent(spend.overhead.share.dollars)} of the priced dollars (${spend.overhead.unpriced} of its ${spend.overhead.turns} turns unpriced), ${count(spend.overhead.tokens)} tokens = ${percent(spend.overhead.share.tokens)} of tokens`);
  for (const own of spend.overhead.bySession) lines.push(`    ${own.session.padEnd(24)} ${String(own.turns).padStart(5)} turns  ${dollars(own.dollars, own.unpriced > 0)}  ${count(own.tokens)} tokens  (${own.unpriced} unpriced; on a row: ${own.onRows.turns} turns ${dollars(own.onRows.dollars, own.onRows.unpriced > 0)})`);
  lines.push(`  UNMEASURED (not overhead): ${spend.unmeasured.turns} turns, ${dollars(spend.unmeasured.dollars)}; transcripts the ingest could not read: ${spend.unmeasured.unreadableTranscripts.length}${spend.unmeasured.unreadableTranscripts.map((file) => `\n    ${file}`).join("")}`,
    `  UNPLACED (a pull request closing no merged row): ${spend.unplaced.turns} turns, ${dollars(spend.unplaced.dollars)}`,
    `  cache-read share of input: ${percent(spend.cacheRead.share)} (${count(spend.cacheRead.cacheRead)} of ${count(spend.cacheRead.inputSide)} input-side tokens)`,
    `  REPEAT WASTE ${dollars(week.repeats.total.dollars, week.repeats.total.floor)} (${count(week.repeats.total.tokens)} tokens), by class:`, ...week.repeats.classes.flatMap((entry) => [classLine(entry, week.githubUnread), ...causeLines(entry)]));
  return [...lines, ...byRepoLines(week), ...phaseLines(week), ...dearestLines(week), ...wakeLines(week)];
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

/** @typedef {ReturnType<typeof cutFigures>} Cut */

/** @param {Cut} cut */
function firstTurnText(cut) {
  const { firstTurn } = cut;
  if (firstTurn.n === 0) return `FIRST-TURN SIZE: ${NOT_HELD} (no first turn of a worker or reviewer session of these rows is in the store)`;
  return `FIRST-TURN SIZE: p50 ${count(firstTurn.p50)}  p90 ${count(firstTurn.p90)} tokens  (n=${firstTurn.n} first turns)`;
}

/** @param {Cut} cut */
function toolReadText(cut) {
  const read = cut.toolRead;
  if (read.rows === 0) return `TOOL-READ TOKENS: ${NOT_HELD} (${read.notHeldRows} of these rows' turns were stored before the reader; they are read again when their transcripts are)`;
  const floor = read.floorRows > 0 ? ">= " : "";
  const parts = `Read ${count(read.byTool.Read)}, Grep ${count(read.byTool.Grep)}, Glob ${count(read.byTool.Glob)}, mixed ${count(read.mixed)}`;
  const why = read.floorRows > 0 ? `; a FLOOR: ${read.floorRows} rows have a turn stored before the reader or not derivable (${read.notDerivableTurns} turns not derivable; ${read.notHeldRows} rows have no turn with the figure)` : "";
  return `TOOL-READ TOKENS: ${floor}${count(read.total)} = ${floor}${percent(read.share)} of the tokens of the turns of ${read.rows} rows that have it (${parts}); per row p50 ${count(read.perRow.p50)}  p90 ${count(read.perRow.p90)}${why}`;
}

/** @param {Cut} cut @param {string} pad */
function cutLines(cut, pad) {
  const rowsLine = `rows ${cut.rows} (no turn in the store: ${cut.noTurns}; dollars a floor: ${cut.floors})  dollars p50 ${dollars(cut.dollars.p50)}  p90 ${dollars(cut.dollars.p90)} (n=${cut.dollars.n})  tokens p50 ${count(cut.tokens.p50)}  p90 ${count(cut.tokens.p90)} (n=${cut.tokens.n})`;
  return [`${pad}${rowsLine}`, `${pad}${firstTurnText(cut)}`, `${pad}${toolReadText(cut)}`];
}

/** @param {ReturnType<typeof aggregate>["weeks"][number]} week */
function byRepoLines(week) {
  if (week.byRepo.length === 0) return ["  BY REPOSITORY: no merged row this week, so no figure"];
  return ["  BY REPOSITORY (the repository of each row's last merged pull request):", ...week.byRepo.flatMap((cut) => [`    ${cut.repo}`, ...cutLines(cut, "      ")])];
}

/** @param {ReturnType<typeof aggregate>["weeks"][number]["moves"][number]} entry */
const placedText = (entry) => (entry.placed === null ? "" : ` placed by paths: ${entry.placed.package} on the package, MIXED ${entry.placed.mixed} (on neither side), other ${entry.placed.other}, paths not read ${entry.placed.unread}.`);

/** One move across the report's weeks, each week its own line and never pooled. @param {ReturnType<typeof aggregate>} report @param {number} index */
function moveLines(report, index) {
  const move = report.moves[index];
  if (move.at === null) return [`BEFORE AND AFTER THE MOVE, ${move.name} (#${move.row}): ${NOT_HELD}: the closing time of the row was not read, so no week can be placed on a side`];
  const moveWeek = weekStart(move.at);
  const lines = [`BEFORE AND AFTER THE MOVE, ${move.name} (#${move.row}, closed ${new Date(move.at).toISOString()}; ${move.repo}, before it packages/${move.name}/ of the primary repository). Each week is its own population; the week of the move is on neither side:`];
  for (const week of report.weeks) {
    const entry = week.moves[index];
    const flag = week.partial === null ? "" : "  PARTIAL, not compared";
    if (entry.side === "move-week") lines.push(`  ${day(week.start)}  MOVE WEEK: on neither side${flag}`);
    else if (entry.cut === null) lines.push(`  ${day(week.start)}  ${NOT_HELD}`);
    else lines.push(`  ${day(week.start)}  ${entry.side.toUpperCase()}${flag}${placedText(entry)}`, ...(entry.cut.rows === 0 ? ["      no merged row on this side this week: no figure"] : cutLines(entry.cut, "      ")));
  }
  const whole = report.weeks.some((week) => week.start > moveWeek && week.partial === null);
  lines.push(whole ? "  AFTER: the whole weeks above are the reading" : `  AFTER: ${NOT_HELD}: no whole week has passed since the move (the first is the week of ${day(moveWeek + WEEK_MS)}, which ends ${day(moveWeek + 2 * WEEK_MS)})`);
  return lines;
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
  for (const index of report.moves.keys()) lines.push("", ...moveLines(report, index));
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
