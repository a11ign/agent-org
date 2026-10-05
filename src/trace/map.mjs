// @ts-check
// a11ign/a11ign#3514 (slice 7 of #3494): `trace --map` -- THE ACROSS-ROWS PROCESS MAP. A directly-follows graph of the merged rows' phases, as ONE self-contained HTML page:
// the picture of #3513's numbers.
//
// A PURE FUNCTION over what the store holds, like `aggregate.mjs`: it opens no file and calls no `gh`. `processMap` builds the model from the store's events and the merged pull
// requests; `renderMap` writes the page; `buildMap` is both. The page has no script, no stylesheet link and no URL: the SVG is inline, and the table under it says everything the
// picture does, so a reader who cannot see the colours loses nothing.
//
// NEVER A NODE FROM NOTHING. `boarded` is a node of the chairman's ten, and the store holds no event for it (a board status change is a GraphQL project field, and the store is
// REST only), so it is drawn marked `not held` with no edge and no figure. A row whose GitHub events were not read has only its merge, and is counted apart.
// NEVER ZERO FOR UNKNOWN. A phase with no priced turn prints `n/a`, a figure with an unpriced turn in it is a FLOOR (`>=`), and a row with no turn in the store has no dollars.
import { mergedRows, rowsClosedBy } from "../wakes-per-row.mjs";
import { nearestRank, weekStart } from "./aggregate.mjs";
import { costOf } from "./store.mjs";

export const MAP_DEFINITIONS = [
  "PHASES are the chairman's ten (#3494). A row's STEPS are the phases the store has an event for, in the order of those events' times: the graph is DIRECTLY-FOLLOWS, an edge from each step to the next one the same row took, so the map shows the order rows really went in, not the order the process says.",
  "  filed: the row's `filed` event. claimed: its first claim record. build: the first commit of a pull request that closes it. verify: the last commit before that pull request opened. PR: opened. review: the first review. CI: the first check run. queue: the first entry to the merge queue. merged: the row's merge (the last merge of the pull requests that close it).",
  "  build and verify are INFERRED from commit dates (a commit's own date, not the push's): nothing in the store says a verify ran. A row with one commit before its pull request opened has a build of 0. boarded is NOT HELD: no step is drawn for it.",
  "EDGE WIDTH and the number on an edge: how many rows took that step. A row is counted once per edge.",
  "NODE WAIT: the median, over the rows that were in the phase, of the time from entering it to entering the next step (nearest-rank, no interpolation). `merged` has none.",
  "NODE COLOUR and the dollars on a node: the median, over the rows in the phase that have any turn in the store, of the priced dollars of the turns of the row between entering it and the next step. A turn before a row's first step or after its merge is in no node. A phase with no such row is `n/a`; `>=` marks a median in which a row had an unpriced turn.",
  "LOOPS are red, dashed and named, and are drawn beside the steps because a row goes round them as well. review -> rework -> review: a review after an earlier one on the same row; the dollars are the row's turns from each review to the next (the rework and the re-review). queue -> eject -> queue: an exit from the merge queue that did not merge, followed by an entry; the dollars are the row's turns between them. wake -> compaction: a compaction of a session on the row; the dollars are the INPUT side of the first turn after it, which re-reads the window (aggregate.mjs's rule). The count is every traversal; the dollars are the priced turns of the rows that have any, and a loop of a row with none is counted and not priced (`>=`).",
  "FILTERS: --repo is the repository of the pull request that merged the row; --week is the Monday-first UTC week of the merge; --cause keeps the rows with at least one wake of that cause (the ledger's cause, the middle part of the key). Every figure on the page is of the rows the filters keep, and the page says which.",
];

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_MINUTE = 60 * 1000;
const MS_PER_SECOND = 1000;
const MEDIAN = 50;
const SMALL_DOLLARS = 0.01;

/**
 * @typedef {import("./store.mjs").TraceEvent} TraceEvent
 * @typedef {{ id: string, label: string }} Phase
 * @typedef {{ phase: string, at: number }} Step
 * @typedef {{ dollars: number, floor: boolean }} Spend
 * @typedef {{ repo?: string, week?: number, cause?: string }} MapFilter
 * @typedef {{ rowRepo: string, org: string, prRows: Map<string, number[]>, rowPrs: Map<number, string[]> }} Keys
 * @typedef {{ count: number, dollars: number, floor: boolean }} Loop
 */

/** @type {Phase[]} */
export const PHASES = [
  { id: "filed", label: "filed" }, { id: "boarded", label: "boarded" }, { id: "claimed", label: "claimed" }, { id: "build", label: "build" }, { id: "verify", label: "verify" },
  { id: "pr", label: "PR" }, { id: "review", label: "review" }, { id: "ci", label: "CI" }, { id: "queue", label: "queue" }, { id: "merged", label: "merged" },
];
/** The phases the store holds no event for: drawn, and never given a step. */
const NOT_HELD_PHASES = new Set(["boarded"]);
/** The loops, and the nodes the loop adds beside the ten. */
export const LOOPS = [
  { id: "review", label: "review -> rework -> review", via: "rework", from: "review" },
  { id: "queue", label: "queue -> eject -> queue", via: "eject", from: "queue" },
  { id: "compaction", label: "wake -> compaction", via: "compaction", from: "wake" },
];

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Keys and placement: which rows an event is about. This repeats `aggregate.mjs`'s placement, which is not exported; the test pins the two to the same dollars per row.

/** @param {Keys} keys @param {string | null} repo @param {number} number */
const prKey = (keys, repo, number) => `${repo === null ? keys.rowRepo : `${keys.org}/${repo}`}#${number}`;

/** @param {import("../wakes-per-row.mjs").PullRequest[]} pulls @param {string} rowRepo @returns {Keys} */
function keysOf(pulls, rowRepo) {
  /** @type {Map<string, number[]>} */
  const prRows = new Map();
  /** @type {Map<number, string[]>} */
  const rowPrs = new Map();
  for (const pull of pulls) {
    const key = `${pull.repo}#${pull.number}`;
    for (const row of rowsClosedBy(pull.body ?? "", rowRepo)) {
      prRows.set(key, [...(prRows.get(key) ?? []), row]);
      rowPrs.set(row, [...(rowPrs.get(row) ?? []), key]);
    }
  }
  return { rowRepo, org: rowRepo.split("/")[0], prRows, rowPrs };
}

/** @param {unknown} value @returns {value is number} */
const isNumber = (value) => typeof value === "number";

/** @param {TraceEvent} event @param {Keys} keys @returns {number[]} */
function rowsOf(event, keys) {
  const rows = new Set([event.row, ...(event.rows ?? []), ...(event.touchedRows ?? [])].filter(isNumber));
  const named = [event.pr, ...(event.prs ?? [])].filter(isNumber).map((pr) => prKey(keys, event.repo, pr));
  named.push(...(event.touchedPrs ?? []).map((pr) => prKey(keys, null, pr)));
  for (const key of named) for (const row of keys.prRows.get(key) ?? []) rows.add(row);
  return [...rows];
}

/** @template T @param {Map<number | string, T[]>} map @param {number | string} key @param {T} value */
function pushTo(map, key, value) {
  map.set(key, [...(map.get(key) ?? []), value]);
}

/**
 * Every index the map reads, in one pass over the events, each list in time order.
 * @param {TraceEvent[]} events @param {Keys} keys
 */
function indexEvents(events, keys) {
  const sorted = [...events].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const index = { turns: new Map(), wakes: new Map(), compactions: new Map(), ofPr: new Map(), ofRow: new Map(), bySession: new Map() };
  for (const event of sorted) {
    if (event.kind === "turn") pushTo(index.bySession, event.session, event);
    if (event.source === "github") {
      if (typeof event.pr === "number") pushTo(index.ofPr, prKey(keys, event.repo, event.pr), event);
      else if (typeof event.row === "number") pushTo(index.ofRow, event.row, event);
      continue;
    }
    const target = { turn: index.turns, wake: index.wakes, compaction: index.compactions }[/** @type {"turn"} */ (event.kind)];
    if (target) for (const row of rowsOf(event, keys)) pushTo(target, row, event);
  }
  return /** @type {{ turns: Map<number, TraceEvent[]>, wakes: Map<number, TraceEvent[]>, compactions: Map<number, TraceEvent[]>, ofPr: Map<string, TraceEvent[]>, ofRow: Map<number, TraceEvent[]>, bySession: Map<string, TraceEvent[]> }} */ (index);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// One row's steps

/** @param {TraceEvent[]} events @param {string} kind @param {(event: TraceEvent) => number} [timeOf] @returns {number | undefined} */
function earliest(events, kind, timeOf = (event) => event.at) {
  const times = events.filter((event) => event.kind === kind).map(timeOf);
  return times.length === 0 ? undefined : Math.min(...times);
}

/** @param {TraceEvent[]} prEvents @param {number | undefined} opened @returns {{ build?: number, verify?: number }} */
function commitTimes(prEvents, opened) {
  if (opened === undefined) return {};
  const before = prEvents.filter((event) => event.kind === "head_moved" && event.at <= opened).map((event) => event.at);
  return before.length === 0 ? {} : { build: Math.min(...before), verify: Math.max(...before) };
}

/**
 * The time each phase the store holds an event for was first entered.
 * @param {{ entry: { row: number, mergedAt: number }, own: TraceEvent[], prEvents: TraceEvent[] }} input
 * @returns {Record<string, number | undefined>}
 */
function entryTimes({ entry, own, prEvents }) {
  const opened = earliest(prEvents, "opened");
  return {
    filed: earliest(own, "filed"), claimed: earliest(own, "claimed"), ...commitTimes(prEvents, opened), pr: opened, review: earliest(prEvents, "reviewed"),
    ci: earliest(prEvents, "ci_run", (event) => event.startedAt ?? event.at), queue: earliest(prEvents, "added_to_merge_queue"), merged: entry.mergedAt,
  };
}

/** The steps in the order of their times; a tie keeps the order of the ten. @param {Record<string, number | undefined>} times @returns {Step[]} */
function stepsOf(times) {
  const held = PHASES.filter((phase) => !NOT_HELD_PHASES.has(phase.id) && times[phase.id] !== undefined);
  return held.map((phase) => ({ phase: phase.id, at: /** @type {number} */ (times[phase.id]) })).sort((a, b) => a.at - b.at);
}

/** The priced dollars of `turns` in [from, to). @param {TraceEvent[]} turns @param {number} from @param {number} to @returns {Spend} */
function spendBetween(turns, from, to) {
  let dollars = 0;
  let floor = false;
  for (const turn of turns.filter((candidate) => candidate.at >= from && candidate.at < to)) {
    if (typeof turn.costUsd === "number") dollars += turn.costUsd;
    else floor = true;
  }
  return { dollars, floor };
}

/** @param {TraceEvent[]} turns @returns {Spend} */
const spendOf = (turns) => spendBetween(turns, -Infinity, Infinity);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// One row's loops

/** @param {Spend[]} spends @returns {Loop} */
const loopOf = (spends) => ({ count: spends.length, dollars: spends.reduce((sum, spend) => sum + spend.dollars, 0), floor: spends.some((spend) => spend.floor) });

/** The windows between a review and the next one. @param {TraceEvent[]} prEvents @returns {[number, number][]} */
function reviewLoops(prEvents) {
  const times = prEvents.filter((event) => event.kind === "reviewed").map((event) => event.at).sort((a, b) => a - b);
  return times.slice(1).map((time, index) => [times[index], time]);
}

/** The windows from an exit that did not merge to the next entry. @param {TraceEvent[]} prEvents @returns {[number, number][]} */
function queueLoops(prEvents) {
  const entries = prEvents.filter((event) => event.kind === "added_to_merge_queue").map((event) => event.at);
  const ejects = prEvents.filter((event) => event.kind === "removed_from_merge_queue" && event.outcome === "unmerged").map((event) => event.at);
  return ejects.flatMap((eject) => {
    const back = entries.filter((time) => time >= eject).sort((a, b) => a - b)[0];
    return back === undefined ? [] : [/** @type {[number, number]} */ ([eject, back])];
  });
}

/** The input side of the first turn the session took after the compaction: what re-reading the window cost. A subagent's turn is its own context, not the session re-reading its window, so it is skipped (as `aggregate` does). @param {TraceEvent} compaction @param {TraceEvent[]} sessionTurns @returns {Spend} */
function compactionSpend(compaction, sessionTurns) {
  const next = sessionTurns.find((turn) => !turn.sidechain && turn.at > compaction.at && turn.tokens);
  const cost = next?.tokens ? costOf(next.model, { ...next.tokens, output: 0 }) : null;
  return { dollars: cost ?? 0, floor: cost === null };
}

/**
 * Each loop the row went round, with its dollars from the row's turns. A row with no turn in the store has loops that are counted and not priced.
 * @param {{ prEvents: TraceEvent[], turns: TraceEvent[], compactions: TraceEvent[], bySession: Map<string, TraceEvent[]> }} input
 * @returns {Record<string, Loop>}
 */
function loopsOf({ prEvents, turns, compactions, bySession }) {
  const held = turns.length > 0;
  /** @param {[number, number][]} windows */
  const priced = (windows) => loopOf(windows.map(([from, to]) => (held ? spendBetween(turns, from, to) : { dollars: 0, floor: true })));
  return {
    review: priced(reviewLoops(prEvents)), queue: priced(queueLoops(prEvents)),
    compaction: loopOf(compactions.map((compaction) => compactionSpend(compaction, bySession.get(compaction.session) ?? []))),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// The population, and the filters over it

/** @param {number} ms the UTC day, as `YYYY-MM-DD` */
const day = (ms) => new Date(ms).toISOString().slice(0, "YYYY-MM-DD".length);

/** @param {{ mergedAt: number, repo: string, row: number }} entry @param {MapFilter} filter @param {Map<number, TraceEvent[]>} wakes */
function kept(entry, filter, wakes) {
  if (filter.repo !== undefined && entry.repo !== filter.repo && entry.repo.split("/")[1] !== filter.repo) return false;
  if (filter.week !== undefined && weekStart(entry.mergedAt) !== filter.week) return false;
  return filter.cause === undefined || (wakes.get(entry.row) ?? []).some((wake) => wake.cause === filter.cause);
}

/** What the unfiltered window holds, so a reader knows what to ask for. @template T @param {T[]} values @returns {{ value: T, rows: number }[]} */
function tally(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([value, rows]) => ({ value, rows })).sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// The model

/** @param {number[]} values @returns {number | null} */
const median = (values) => nearestRank(values, MEDIAN);

/**
 * The model of the map: nodes, edges and loops over the rows the filters keep.
 * @param {{ events: TraceEvent[], pulls: import("../wakes-per-row.mjs").PullRequest[], rowRepo: string, window: { from: number, to: number }, filter?: MapFilter }} input
 */
export function processMap({ events, pulls, rowRepo, window, filter = {} }) {
  const keys = keysOf(pulls, rowRepo);
  const index = indexEvents(events, keys);
  const population = mergedRows(pulls, window, rowRepo);
  const chosen = population.filter((entry) => kept(entry, filter, index.wakes));
  const rows = chosen.map((entry) => rowPath({ entry, keys, index }));
  return {
    window, filter, rows: rows.map(({ row, repo, mergedAt, steps, held, totalDollars, totalFloor }) => ({ row, repo, mergedAt, steps: steps.length, held, totalDollars, totalFloor })),
    population: { rows: population.length, repos: tally(population.map((entry) => entry.repo)), weeks: tally(population.map((entry) => weekStart(entry.mergedAt))),
      causes: causesOf(population, index.wakes) },
    nodes: nodesOf(rows), edges: edgesOf(rows), loops: foldLoops(rows), wakes: chosen.reduce((sum, entry) => sum + (index.wakes.get(entry.row) ?? []).length, 0),
    unread: rows.filter((row) => row.steps.length < 2).length,
  };
}

/** The causes the window's rows were woken by, each counted once per row. A wake with no cause cannot be asked for with `--cause`, so it is not listed. @param {{ row: number }[]} population @param {Map<number, TraceEvent[]>} wakes */
function causesOf(population, wakes) {
  const causes = population.flatMap((entry) => [...new Set((wakes.get(entry.row) ?? []).flatMap((wake) => (typeof wake.cause === "string" ? [wake.cause] : [])))]);
  return tally(causes);
}

/** @typedef {ReturnType<typeof rowPath>} RowPath */

/** One row: its steps, the dollars and wait in each, and the loops it went round. @param {{ entry: { row: number, repo: string, mergedAt: number }, keys: Keys, index: ReturnType<typeof indexEvents> }} input */
function rowPath({ entry, keys, index }) {
  const prEvents = (keys.rowPrs.get(entry.row) ?? []).flatMap((key) => index.ofPr.get(key) ?? []).sort((a, b) => a.at - b.at);
  const own = index.ofRow.get(entry.row) ?? [];
  const turns = index.turns.get(entry.row) ?? [];
  const steps = stepsOf(entryTimes({ entry, own, prEvents }));
  const held = turns.length > 0;
  const visits = steps.map((step, at) => {
    const next = steps[at + 1];
    return { phase: step.phase, waitMs: next ? next.at - step.at : null, spend: held && next ? spendBetween(turns, step.at, next.at) : null };
  });
  const total = spendOf(turns);
  return { ...entry, steps, visits, held, totalDollars: held ? total.dollars : null, totalFloor: total.floor,
    loops: loopsOf({ prEvents, turns, compactions: index.compactions.get(entry.row) ?? [], bySession: index.bySession }) };
}

/** @param {RowPath[]} rows */
function nodesOf(rows) {
  return PHASES.map((phase) => {
    const visits = rows.flatMap((row) => row.visits.filter((visit) => visit.phase === phase.id));
    const spends = visits.flatMap((visit) => (visit.spend ? [visit.spend] : []));
    return {
      id: phase.id, label: phase.label, held: !NOT_HELD_PHASES.has(phase.id), rows: visits.length,
      medianWaitMs: median(visits.flatMap((visit) => (visit.waitMs === null ? [] : [visit.waitMs]))),
      medianDollars: median(spends.map((spend) => spend.dollars)), floor: spends.some((spend) => spend.floor), priced: spends.length,
    };
  });
}

/** @param {RowPath[]} rows @returns {{ from: string, to: string, rows: number }[]} */
function edgesOf(rows) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const row of rows) {
    // A row enters a phase once, so its consecutive pairs are all different: a row is counted once per edge without asking.
    for (const [at, step] of row.steps.slice(1).entries()) {
      const key = `${row.steps[at].phase}>${step.phase}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts].map(([key, count]) => ({ from: key.split(">")[0], to: key.split(">")[1], rows: count })).sort((a, b) => b.rows - a.rows || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/** @param {RowPath[]} rows */
function foldLoops(rows) {
  return LOOPS.map((loop) => {
    const found = rows.map((row) => ({ held: row.held, loop: row.loops[loop.id] })).filter((entry) => entry.loop.count > 0);
    const count = found.reduce((sum, entry) => sum + entry.loop.count, 0);
    const priced = found.filter((entry) => entry.held || loop.id === "compaction");
    return { ...loop, count, rows: found.length, dollars: priced.reduce((sum, entry) => sum + entry.loop.dollars, 0), priced: priced.length,
      floor: found.some((entry) => entry.loop.floor || !(entry.held || loop.id === "compaction")) };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// The page

/** @param {unknown} text */
const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** @param {number | null} ms */
function span(ms) {
  if (ms === null) return "n/a";
  if (ms < MS_PER_MINUTE) return `${Math.round(ms / MS_PER_SECOND)}s`;
  if (ms < MS_PER_HOUR) return `${Math.round(ms / MS_PER_MINUTE)}m`;
  return ms < MS_PER_DAY ? `${(ms / MS_PER_HOUR).toFixed(1)}h` : `${(ms / MS_PER_DAY).toFixed(1)}d`;
}

/** @param {number | null} value @param {boolean} [floor] */
const money = (value, floor = false) => (value === null ? "n/a" : `${floor ? ">= " : ""}$${value.toFixed(value >= SMALL_DOLLARS ? 2 : 4)}`);

/** The dollars of a loop: `n/a` when no row of it had a priced turn. @param {{ count: number, priced: number, dollars: number, floor: boolean }} loop */
const loopMoney = (loop) => (loop.count === 0 ? "$0.00" : loop.priced === 0 ? "n/a" : money(loop.dollars, loop.floor));

const LAYOUT = { left: 80, gap: 150, width: 104, height: 76, steps: 230, loops: 410, pad: 70, canvas: 480 };
const SHADES = ["s0", "s1", "s2", "s3", "s4"];

/** @param {ReturnType<typeof processMap>["nodes"]} nodes */
function shadeOf(nodes) {
  const top = Math.max(0, ...nodes.map((node) => node.medianDollars ?? 0));
  return (/** @type {number | null} */ dollars) => (dollars === null ? "na" : SHADES[Math.min(SHADES.length - 1, top === 0 ? 0 : Math.floor((dollars / top) * SHADES.length))]);
}

/** @param {number} column */
const centreX = (column) => LAYOUT.left + column * LAYOUT.gap;

/** The page's position of each node: the ten in a row, the loop nodes under the phase the loop leaves, and `wake` beside `compaction`. @returns {Map<string, { x: number, y: number }>} */
function positions() {
  const at = new Map(PHASES.map((phase, column) => [phase.id, { x: centreX(column), y: LAYOUT.steps }]));
  at.set("rework", { x: centreX(PHASES.findIndex((phase) => phase.id === "review")), y: LAYOUT.loops });
  at.set("eject", { x: centreX(PHASES.findIndex((phase) => phase.id === "queue")), y: LAYOUT.loops });
  at.set("wake", { x: centreX(1), y: LAYOUT.loops });
  at.set("compaction", { x: centreX(2), y: LAYOUT.loops });
  return at;
}

/** A step that skips columns: an arc over the row (forward) or under it (back), higher the further it goes. @param {{ x: number, y: number }} from @param {{ x: number, y: number }} to @param {number} span columns apart, signed */
function arc(from, to, span) {
  const height = (span > 0 ? 24 : 20) + 14 * Math.abs(span);
  const lift = span > 0 ? -1 : 1;
  const edgeY = from.y + (LAYOUT.height / 2) * lift;
  const apex = edgeY + lift * height;
  return { d: `M ${from.x} ${edgeY} Q ${(from.x + to.x) / 2} ${edgeY + lift * height * 2} ${to.x} ${edgeY}`, labelX: (from.x + to.x) / 2, labelY: apex + (lift < 0 ? -5 : 14) };
}

/** @param {{ from: string, to: string, rows: number }} edge @param {number} widest @param {Map<string, { x: number, y: number }>} where */
function stepEdge(edge, widest, where) {
  const from = /** @type {{ x: number, y: number }} */ (where.get(edge.from));
  const to = /** @type {{ x: number, y: number }} */ (where.get(edge.to));
  const stroke = (1.5 + (6.5 * edge.rows) / widest).toFixed(1);
  const columns = Math.round((to.x - from.x) / LAYOUT.gap);
  const label = `${edge.rows}`;
  const title = `<title>${esc(edge.from)} to ${esc(edge.to)}: ${edge.rows} rows</title>`;
  if (Math.abs(columns) === 1) {
    const sign = Math.sign(columns);
    const x1 = from.x + sign * (LAYOUT.width / 2);
    const x2 = to.x - sign * (LAYOUT.width / 2);
    return `<g class="edge" data-from="${esc(edge.from)}" data-to="${esc(edge.to)}">${title}<line x1="${x1}" y1="${from.y}" x2="${x2}" y2="${to.y}" stroke-width="${stroke}" marker-end="url(#arrow)"/>`
      + `<text x="${(x1 + x2) / 2}" y="${from.y - 8 + (sign < 0 ? 22 : 0)}" text-anchor="middle">${label}</text></g>`;
  }
  const curve = arc(from, to, columns);
  return `<g class="edge" data-from="${esc(edge.from)}" data-to="${esc(edge.to)}">${title}<path d="${curve.d}" fill="none" stroke-width="${stroke}" marker-end="url(#arrow)"/>`
    + `<text x="${curve.labelX}" y="${curve.labelY}" text-anchor="middle">${label}</text></g>`;
}

/** The two red edges of a loop, one each way, beside each other, and the single one of the loop that has no way back. @param {ReturnType<typeof foldLoops>[number]} loop @param {Map<string, { x: number, y: number }>} where */
function loopEdges(loop, where) {
  const from = /** @type {{ x: number, y: number }} */ (where.get(loop.from));
  const via = /** @type {{ x: number, y: number }} */ (where.get(loop.via));
  const title = `<title>loop ${esc(loop.label)}: ${loop.count} times, ${esc(loopMoney(loop))}</title>`;
  const data = `class="loop" data-loop="${loop.id}" data-count="${loop.count}"`;
  const back = loop.id === "compaction" ? "" : `<line x1="${via.x + 22}" y1="${via.y - LAYOUT.height / 2}" x2="${from.x + 22}" y2="${from.y + LAYOUT.height / 2}" marker-end="url(#arrow-red)"/>`;
  const out = loop.id === "compaction"
    ? `<line x1="${from.x + LAYOUT.width / 2}" y1="${from.y}" x2="${via.x - LAYOUT.width / 2}" y2="${via.y}" marker-end="url(#arrow-red)"/>`
    : `<line x1="${from.x - 22}" y1="${from.y + LAYOUT.height / 2}" x2="${via.x - 22}" y2="${via.y - LAYOUT.height / 2}" marker-end="url(#arrow-red)"/>`;
  const where2 = loop.id === "compaction" ? { x: (from.x + via.x) / 2, y: from.y - 8 } : { x: from.x + 36, y: (from.y + via.y) / 2 };
  return `<g ${data}>${title}${out}${back}<text x="${where2.x}" y="${where2.y}" ${loop.id === "compaction" ? 'text-anchor="middle"' : ""}>${loop.count}× ${esc(loopMoney(loop))}</text></g>`;
}

/** @param {{ x: number, y: number }} spot @param {string[]} lines @param {string} classes @param {string} id */
function nodeBox(spot, lines, classes, id) {
  const left = spot.x - LAYOUT.width / 2;
  const top = spot.y - LAYOUT.height / 2;
  const text = lines.map((line, at) => `<text x="${spot.x}" y="${top + 17 + at * 15}" text-anchor="middle"${at === 0 ? ' class="name"' : ""}>${esc(line)}</text>`).join("");
  return `<g class="node ${classes}" data-phase="${esc(id)}"><rect x="${left}" y="${top}" width="${LAYOUT.width}" height="${LAYOUT.height}" rx="6"/>${text}</g>`;
}

/** @param {ReturnType<typeof processMap>} model */
function svgOf(model) {
  const where = positions();
  const shade = shadeOf(model.nodes);
  const widest = Math.max(1, ...model.edges.map((edge) => edge.rows));
  const boxes = model.nodes.map((node) => nodeBox(/** @type {{ x: number, y: number }} */ (where.get(node.id)),
    node.held ? [node.label, `${node.rows} rows`, node.id === "merged" ? "end" : `wait ${span(node.medianWaitMs)}`, money(node.medianDollars, node.floor)] : [node.label, "not held", "no event", "in the store"],
    node.held ? shade(node.medianDollars) : "unheld", node.id));
  const loopBoxes = model.loops.map((loop) => nodeBox(/** @type {{ x: number, y: number }} */ (where.get(loop.via)), [loop.via, `${loop.count}×`, loopMoney(loop)], "loopnode", loop.via));
  const wakeBox = nodeBox(/** @type {{ x: number, y: number }} */ (where.get("wake")), ["wake", `${model.wakes} wakes`], "loopnode", "wake");
  const width = centreX(PHASES.length - 1) + LAYOUT.pad + LAYOUT.width / 2;
  const summary = `Process map of ${model.rows.length} merged rows: ${model.edges.length} steps between phases, ${model.loops.map((loop) => `${loop.count} ${loop.label}`).join(", ")}. The tables below give every figure.`;
  return `<svg role="img" aria-labelledby="map-title map-desc" viewBox="0 0 ${width} ${LAYOUT.canvas}" width="${width}" height="${LAYOUT.canvas}">`
    + `<title id="map-title">Across-rows process map</title><desc id="map-desc">${esc(summary)}</desc>`
    + `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#555"/></marker>`
    + `<marker id="arrow-red" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#b3261e"/></marker></defs>`
    + `${model.edges.map((edge) => stepEdge(edge, widest, where)).join("")}${model.loops.map((loop) => loopEdges(loop, where)).join("")}${boxes.join("")}${loopBoxes.join("")}${wakeBox}</svg>`;
}

const STYLE = `
:root { color-scheme: light; }
body { font: 15px/1.45 system-ui, sans-serif; margin: 1.5rem; color: #1b1b1b; background: #fff; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; } h2 { font-size: 1.1rem; margin-top: 1.75rem; }
.scroll { overflow-x: auto; border: 1px solid #c8c8c8; padding: .5rem; }
svg text { font: 12px system-ui, sans-serif; fill: #1b1b1b; } svg .name { font-weight: 700; font-size: 13px; }
.edge line, .edge path { stroke: #555; } .edge text { fill: #333; }
.loop line { stroke: #b3261e; stroke-width: 3; stroke-dasharray: 7 4; } .loop text { fill: #b3261e; font-weight: 700; }
.node rect { stroke: #1b1b1b; stroke-width: 1.5; }
.s0 rect { fill: #eaf2fb; } .s1 rect { fill: #bcd7f0; } .s2 rect { fill: #7fb0e0; } .s3 rect { fill: #2b67ad; } .s4 rect { fill: #0b3d7a; }
.s3 text, .s4 text { fill: #fff; }
.na rect, .unheld rect { fill: #e6e6e6; stroke-dasharray: 5 3; } .loopnode rect { fill: #fff; stroke: #b3261e; stroke-dasharray: 7 4; } .loopnode text { fill: #b3261e; }
table { border-collapse: collapse; margin: .5rem 0; } th, td { border: 1px solid #c8c8c8; padding: .25rem .6rem; text-align: left; } th { background: #f0f0f0; }
td.loop-row { color: #b3261e; font-weight: 700; }
.note { color: #444; max-width: 70rem; }
`;

/** @param {MapFilter} filter */
function filterLine(filter) {
  const parts = [filter.repo === undefined ? null : `repo ${filter.repo}`, filter.week === undefined ? null : `week of ${day(filter.week)}`, filter.cause === undefined ? null : `cause ${filter.cause}`];
  const named = parts.filter((part) => part !== null);
  return named.length === 0 ? "none (every merged row in the window)" : named.join(", ");
}

/** @param {{ value: unknown, rows: number }[]} entries @param {(value: any) => string} show */
const options = (entries, show) => (entries.length === 0 ? "none held" : entries.map((entry) => `${esc(show(entry.value))} (${entry.rows})`).join(", "));

/** @param {ReturnType<typeof processMap>} model */
function tables(model) {
  const nodeRows = model.nodes.map((node) => (node.held
    ? `<tr><td>${esc(node.label)}</td><td>${node.rows}</td><td>${node.id === "merged" ? "end" : span(node.medianWaitMs)}</td><td>${money(node.medianDollars, node.floor)}</td><td>${node.priced}</td></tr>`
    : `<tr><td>${esc(node.label)}</td><td colspan="4">not held: the store has no event for it, so no row is counted and no edge is drawn</td></tr>`)).join("");
  const edgeRows = model.edges.map((edge) => `<tr><td>${esc(edge.from)}</td><td>${esc(edge.to)}</td><td>${edge.rows}</td></tr>`).join("");
  const loopRows = model.loops.map((loop) => `<tr><td class="loop-row">${esc(loop.label)}</td><td>${loop.count}</td><td>${loop.rows}</td><td>${esc(loopMoney(loop))}</td></tr>`).join("");
  return `<h2>Phases</h2><table><tr><th>phase</th><th>rows</th><th>median wait</th><th>median $ spent there</th><th>rows priced</th></tr>${nodeRows}</table>`
    + `<h2>Steps between phases</h2><table><tr><th>from</th><th>to</th><th>rows that took it</th></tr>${edgeRows}</table>`
    + `<h2>Loops (the waste)</h2><table><tr><th>loop</th><th>times round</th><th>rows</th><th>$ in them</th></tr>${loopRows}</table>`;
}

/**
 * The page. `generatedAt` is printed, so the same model prints the same page.
 * @param {ReturnType<typeof processMap>} model @param {{ generatedAt: number }} context
 */
export function renderMap(model, { generatedAt }) {
  const { window } = model;
  const unfiltered = model.population;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Across-rows process map</title><style>${STYLE}</style></head>
<body><main>
<h1>Across-rows process map</h1>
<p class="note">${model.rows.length} merged rows (of ${unfiltered.rows} merged in the window), merged ${esc(new Date(window.from).toISOString())} to ${esc(new Date(window.to).toISOString())}. Filter: ${esc(filterLine(model.filter))}. Generated ${esc(new Date(generatedAt).toISOString())}. ${model.unread} of the rows have no GitHub events in the store beyond their merge, so they are in no edge.</p>
<p class="note">Edge width and the number on an edge: rows that took the step. Node colour (darker is dearer), and its dollars: the median spent there. Node wait: the median time there. <strong>Red dashed loops are the waste</strong>, with their counts and dollars. Boarding is not held.</p>
<div class="scroll">${svgOf(model)}</div>
${tables(model)}
<h2>Filters</h2>
<p class="note">Narrow with <code>trace --map --repo &lt;r&gt; --week &lt;n&gt; --cause &lt;c&gt;</code>. In the window: repos ${options(unfiltered.repos, String)}; weeks ${options(unfiltered.weeks, day)}; causes of a wake ${options(unfiltered.causes, String)}.</p>
<h2>Definitions</h2>
<ul>${MAP_DEFINITIONS.map((line) => `<li class="note">${esc(line.trim())}</li>`).join("")}</ul>
</main></body></html>
`;
}

/** The page, from the store's events. @param {Parameters<typeof processMap>[0] & { generatedAt: number }} input */
export function buildMap({ generatedAt, ...input }) {
  return renderMap(processMap(input), { generatedAt });
}
