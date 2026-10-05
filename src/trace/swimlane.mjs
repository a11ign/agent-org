// @ts-check
// a11ign/a11ign#3512 (slice 5 of #3494): THE SWIMLANE -- `trace -- <row> --html --out <path>` draws one row as a timeline, one lane per actor, time running left to right.
//
// A PURE FUNCTION from one row's events (what `eventsForRow` returns) to ONE HTML string: it opens no file, calls no `gh`, and the page loads nothing (no script, no stylesheet, no image, no font).
// It runs `waterfall` itself, so the repeats and the review waits are the waterfall's (#3511) and not a second reading of the same events.
//
// WHAT IS DRAWN (the chairman's list on #3494, 2026-10-04):
//   lanes     gate, product-manager, ceo, orchestrator, one per `worker-<n>` and `reviewer-<n>` that has something to draw, CI, merge queue. NO OTHER LANE: a turn by a session that has none (a standing seat
//             of another kind) is counted in the footer and in the table, never drawn on a lane it does not have.
//   bars      one per TURN (its span is the store's INFERRED `wallClockMs` before its end; a turn with none is a tick and says so), per CI RUN and per MERGE-QUEUE entry. A turn's bar is coloured by what
//             it cost; a turn with no price is grey and says "$?", never the cheapest colour. Every bar carries its cost, its cause and its model as TEXT too (title and table), because a colour is not a reading.
//   WAITS     hatched, behind the bars, naming what was waited on: an order deferred for a busy seat (`deferral`), a label held on the row, a review not yet posted (the waterfall's review runs), and the
//             approved draft not yet marked ready, which is INFERRED and is drawn and worded as such. A wait with no record is not drawn (the waterfall's "unexplained").
//   arrows    from an order's marker on the gate lane to the first turn of the session it woke (the first turn ending at or after the delivery and before that session's next order).
//   repeats   outlined in red, on the bar they happened at: a second review at a head, a re-queue at a head, the first re-run check of a wave, a re-wake with the same order, a compaction.
import { duration, waterfall } from "./waterfall.mjs";

/** @typedef {import("./store.mjs").TraceEvent} TraceEvent
 * @typedef {{ kind: string, at: number, phase: string, summary: string, evidence: string[] }} Repeat
 * @typedef {"turn" | "order" | "ci" | "queue" | "review" | "compaction"} BarKind
 * @typedef {{ id: string, lane: string, kind: BarKind, from: number, to: number, text: string, costUsd?: number | null, model?: string, cause?: string, note?: string, repeat?: Repeat }} Bar
 * @typedef {{ lane: string, from: number, to: number, text: string, source: string, inferred: boolean, evidence: string[] }} WaitSegment
 * @typedef {{ order: Bar, turn: Bar }} Arrow */

export const GATE = "gate";
export const CI_LANE = "CI";
export const QUEUE_LANE = "merge queue";
/** The actors with a lane of their own name; `worker-<n>` and `reviewer-<n>` are the other two kinds. */
const STANDING = ["product-manager", "ceo", "orchestrator"];
const SEAT_LANE = /^(?:worker|reviewer)-\d+$/;
const APPROVED = "APPROVED";
const COST_STEPS = 5;
const COST_DECIMALS = 4;
const SHORT_SHA = 7;

const LAYOUT = { labelWidth: 150, plotWidth: 1250, right: 20, top: 44, rowHeight: 28, rowGap: 4, lanePad: 8, minBarWidth: 4, compactRowHeight: 9, compactAbove: 3, barGap: 1, charWidth: 6.4, textPad: 4, tickTarget: 10 };
const MS_PER_MINUTE = 60 * 1000;
const NICE_STEPS_MS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080].map((minutes) => minutes * MS_PER_MINUTE);

/** @param {string} text */
export const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const short = (/** @type {string | undefined} */ sha) => (sha ?? "?").slice(0, SHORT_SHA);
const clock = (/** @type {number} */ ms) => new Date(ms).toISOString().slice("YYYY-MM-DDT".length, "YYYY-MM-DDTHH:MM:SS".length);
const stamp = (/** @type {number} */ ms) => new Date(ms).toISOString().slice(0, "YYYY-MM-DDTHH:MM:SS".length).replace("T", " ");
const byTime = (/** @type {{ from: number }} */ a, /** @type {{ from: number }} */ b) => a.from - b.from;

/** The lane a session draws on, or `null` when it has none. @param {string} session */
export const laneOf = (session) => (STANDING.includes(session) || SEAT_LANE.test(session) ? session : null);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Reading the events into bars, waits and arrows

/** @param {TraceEvent} turn @returns {Bar | null} null when the session has no lane */
function turnBar(turn) {
  const lane = laneOf(turn.session);
  if (lane === null) return null;
  const span = Math.max(0, turn.wallClockMs ?? 0);
  const cost = typeof turn.costUsd === "number" ? `$${turn.costUsd.toFixed(COST_DECIMALS)}` : "$?";
  const cause = turn.cause ?? "no order recorded";
  const model = turn.model ?? "model unknown";
  return { id: turn.id, lane, kind: "turn", from: turn.at - span, to: turn.at, costUsd: turn.costUsd ?? null, cause, model, text: `${cost} ${cause} ${model}`,
    ...(turn.wallClockMs == null ? { note: "no duration recorded: drawn as a tick" } : {}) };
}

/** @param {TraceEvent} wake @param {Repeat[]} repeats @returns {Bar} */
function orderBar(wake, repeats) {
  const key = wake.causeKey ?? wake.cause ?? "an order";
  const repeat = repeats.find((one) => one.kind === "re-wake with the same cause key" && one.at === wake.at && one.summary === `${wake.session}: ${wake.causeKey}`);
  return { id: wake.id, lane: GATE, kind: "order", from: wake.at, to: wake.at, cause: key, text: `order ${key} to ${wake.session}`, ...(repeat ? { repeat } : {}) };
}

/** One bar per check-run, a run seen twice (running, then done) once, as the waterfall counts it. @param {TraceEvent[]} events @param {number} now @param {Repeat[]} repeats @returns {Bar[]} */
function ciBars(events, now, repeats) {
  /** @type {Map<string, TraceEvent>} */
  const runs = new Map();
  for (const run of events.filter((event) => event.kind === "ci_run")) {
    const key = `${run.pr}\t${run.headSha}\t${run.name}\t${run.startedAt}`;
    if (!runs.has(key) || (run.completedAt !== null && run.completedAt !== undefined)) runs.set(key, run);
  }
  return [...runs.values()].map((run) => {
    const from = run.startedAt ?? run.at;
    const repeat = repeats.find((one) => one.kind === "CI re-run at the same head" && one.at === from);
    return { id: run.id, lane: CI_LANE, kind: "ci", from, to: run.completedAt ?? now, text: `${run.name} ${run.state ?? "running"} at ${short(run.headSha)}`, ...(repeat ? { repeat } : {}) };
  });
}

/** Each queue entry, add to its exit (or the merge, or the reading). @param {TraceEvent[]} events @param {number} now @param {Repeat[]} repeats @returns {Bar[]} */
function queueBars(events, now, repeats) {
  const exits = events.filter((event) => event.kind === "removed_from_merge_queue" || event.kind === "merged").sort((a, b) => a.at - b.at);
  return events.filter((event) => event.kind === "added_to_merge_queue").map((add) => {
    const exit = exits.find((event) => event.at >= add.at && event.pr === add.pr);
    const how = exit === undefined ? "still queued" : exit.kind === "merged" || exit.outcome === "merged" ? "merged" : "ejected";
    const repeat = repeats.find((one) => one.kind === "re-queue at the same head" && one.at === add.at);
    return { id: add.id, lane: QUEUE_LANE, kind: "queue", from: add.at, to: exit?.at ?? now, text: `#${add.pr} in the merge queue: ${how}`, ...(repeat ? { repeat } : {}) };
  });
}

/** A review is a tick on its pull request's reviewer lane. @param {TraceEvent[]} events @param {Repeat[]} repeats @returns {Bar[]} */
function reviewBars(events, repeats) {
  return events.filter((event) => event.kind === "reviewed").map((review) => {
    const repeat = repeats.find((one) => one.kind === "second review at the same head" && one.at === review.at);
    return { id: review.id, lane: `reviewer-${review.pr}`, kind: "review", from: review.at, to: review.at, text: `review ${review.state} by ${review.actor} at head ${short(review.headSha)}`, ...(repeat ? { repeat } : {}) };
  });
}

/** @param {TraceEvent[]} events @param {Repeat[]} repeats @returns {Bar[]} */
function compactionBars(events, repeats) {
  return events.filter((event) => event.kind === "compaction" && laneOf(event.session) !== null).map((event) => {
    const repeat = repeats.find((one) => one.kind === "compaction" && one.at === event.at && one.summary.startsWith(`${event.session} `));
    return { id: event.id, lane: /** @type {string} */ (laneOf(event.session)), kind: "compaction", from: event.at, to: event.at, text: `${event.session} compacted its window`, ...(repeat ? { repeat } : {}) };
  });
}

/**
 * The first turn of the session each order woke: the first turn ending at or after the delivery and before the session's next order. An order whose session has no lane, or that woke no turn, has no arrow.
 * @param {Bar[]} orders @param {Bar[]} turns @param {TraceEvent[]} wakes @returns {Arrow[]}
 */
function arrowsOf(orders, turns, wakes) {
  return orders.flatMap((order, index) => {
    const wake = wakes[index];
    const nextOrder = wakes.slice(index + 1).find((next) => next.session === wake.session);
    const woken = turns.filter((turn) => turn.lane === wake.session && turn.to >= wake.at && (nextOrder === undefined || turn.to < nextOrder.at)).sort((a, b) => a.to - b.to)[0];
    return woken ? [{ order, turn: woken }] : [];
  });
}

/** The waits a RECORD places in time: an order deferred for a busy seat, and each label put on and taken off. @param {TraceEvent[]} events @param {number} now @returns {WaitSegment[]} */
function recordedWaits(events, now) {
  const deferrals = events.filter((event) => event.kind === "deferral").map((event) => ({
    lane: laneOf(event.session) ?? GATE, from: event.startedAt ?? event.at, to: event.completedAt ?? event.at, source: "deferral-log", inferred: false, evidence: [event.id],
    text: `order ${event.causeKey} deferred for busy ${event.session} (${event.how})` }));
  /** @type {Map<string, TraceEvent>} */
  const on = new Map();
  /** @type {WaitSegment[]} */
  const labels = [];
  const close = (/** @type {TraceEvent} */ put, /** @type {number} */ to) => labels.push({ lane: GATE, from: put.at, to, source: "label", inferred: false, evidence: [put.id], text: `label ${put.name} on (put on by ${put.actor})` });
  for (const event of events.filter((one) => one.source === "github" && (one.kind === "labeled" || one.kind === "unlabeled") && one.name)) {
    const key = `${event.row ?? ""}/${event.pr ?? ""}\t${event.name}`;
    const put = on.get(key);
    if (event.kind === "labeled" && !put) on.set(key, event);
    else if (event.kind === "unlabeled" && put) {
      close(put, event.at);
      on.delete(key);
    }
  }
  for (const put of on.values()) close(put, now);
  return [...deferrals, ...labels];
}

/**
 * A draft approved and not yet marked ready, INFERRED as the waterfall infers it (`approvedDraftSource`): it waits on the session the ledger's orders about it went to. The words and the
 * evidence are the waterfall's own, read back from its waits, so the page can never say a different thing about it; the PLACE is the approval to the ready mark.
 * @param {TraceEvent[]} events @param {ReturnType<typeof waterfall>} wf @returns {WaitSegment[]}
 */
function approvedDraftWaits(events, wf) {
  const waits = wf.phases.flatMap((phase) => phase.waits).filter((wait) => wait.source === "approved-draft");
  const pulls = [...new Set(events.flatMap((event) => (event.source === "github" && typeof event.pr === "number" ? [event.pr] : [])))];
  return pulls.flatMap((pr) => {
    const approval = events.find((event) => event.kind === "reviewed" && event.pr === pr && event.state === APPROVED);
    const ready = events.find((event) => event.kind === "ready_for_review" && event.pr === pr);
    if (!approval || !ready || approval.at >= ready.at) return [];
    const named = waits.find((wait) => wait.label.startsWith(`approved draft #${pr} `));
    const sessions = events.filter((event) => event.kind === "wake" && event.pr === pr && event.at >= approval.at && event.at <= ready.at).map((event) => event.session);
    const lane = sessions.map(laneOf).find((one) => one !== null) ?? GATE;
    return [{ lane, from: approval.at, to: ready.at, source: "approved-draft", inferred: true, evidence: named?.evidence ?? [], text: named?.label ?? `approved draft #${pr} not yet marked ready` }];
  });
}

/** The waterfall's review runs: a push or ready mark to the review after it, on the reviewer's lane. @param {ReturnType<typeof waterfall>} wf @param {number[]} pulls @returns {WaitSegment[]} */
function reviewWaits(wf, pulls) {
  const review = wf.phases.find((phase) => phase.phase === "review");
  return (review?.runs ?? []).map((run) => {
    const pr = Number(/^#(\d+) /.exec(run.label)?.[1] ?? pulls[0]);
    return { lane: `reviewer-${pr}`, from: run.from, to: run.end, source: "review", inferred: false, evidence: [], text: `waiting for a review: ${run.label}${run.state === "open" ? " (still open)" : ""}` };
  });
}

/**
 * @param {TraceEvent[]} events @param {ReturnType<typeof waterfall>} wf @param {number} now
 * @returns {{ bars: Bar[], waits: WaitSegment[], arrows: Arrow[], unlaned: Map<string, number> }}
 */
function collect(events, wf, now) {
  const sorted = events.filter((event) => event.kind !== "gh_call").sort((a, b) => a.at - b.at);
  const wakes = sorted.filter((event) => event.kind === "wake");
  const orders = wakes.map((wake) => orderBar(wake, wf.repeats));
  const drawn = sorted.filter((event) => event.kind === "turn").map(turnBar);
  const turns = /** @type {Bar[]} */ (drawn.filter((bar) => bar !== null));
  /** @type {Map<string, number>} */
  const unlaned = new Map();
  for (const turn of sorted.filter((event) => event.kind === "turn" && laneOf(event.session) === null)) unlaned.set(turn.session, (unlaned.get(turn.session) ?? 0) + 1);
  const pulls = [...new Set(sorted.flatMap((event) => (event.source === "github" && typeof event.pr === "number" ? [event.pr] : [])))];
  const bars = [...orders, ...turns, ...ciBars(sorted, now, wf.repeats), ...queueBars(sorted, now, wf.repeats), ...reviewBars(sorted, wf.repeats), ...compactionBars(sorted, wf.repeats)];
  const waits = [...recordedWaits(sorted, now), ...approvedDraftWaits(sorted, wf), ...reviewWaits(wf, pulls)];
  return { bars, waits, arrows: arrowsOf(orders, turns, wakes), unlaned };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Layout

/** The lanes, in the order they are drawn: the standing ones, then workers, reviewers, CI and the queue. Only the lanes with something to draw are kept, except the four a reader looks for. @param {string[]} used */
export function lanesOf(used) {
  const numbered = (/** @type {string} */ kind) => [...new Set(used.filter((lane) => lane.startsWith(`${kind}-`)))].sort((a, b) => Number(a.slice(kind.length + 1)) - Number(b.slice(kind.length + 1)));
  return [GATE, ...STANDING, ...numbered("worker"), ...numbered("reviewer"), CI_LANE, QUEUE_LANE];
}

/** @param {number} span @returns {number} the tick interval that gives about `tickTarget` ticks */
function tickStep(span) {
  return NICE_STEPS_MS.find((step) => span / step <= LAYOUT.tickTarget) ?? NICE_STEPS_MS[NICE_STEPS_MS.length - 1];
}

/**
 * A greedy packing of the items of one lane into rows so none overlaps another, each at least `minBarWidth` wide. @template {{ x0: number, x1: number }} T
 * @param {T[]} items sorted by `x0` @returns {(T & { row: number })[]}
 */
function pack(items) {
  /** @type {number[]} */
  const ends = [];
  return items.map((item) => {
    let row = ends.findIndex((end) => end <= item.x0);
    if (row === -1) row = ends.length;
    ends[row] = item.x1 + LAYOUT.barGap;
    return { ...item, row };
  });
}

/**
 * Where everything sits. The axis is linear, so a two-hour wait is two hours wide: that is the picture asked for.
 * @param {{ bars: Bar[], waits: WaitSegment[] }} model @param {{ start: number, end: number }} axis
 */
function layoutOf(model, axis) {
  const span = Math.max(axis.end - axis.start, MS_PER_MINUTE);
  const x = (/** @type {number} */ ms) => LAYOUT.labelWidth + ((ms - axis.start) / span) * LAYOUT.plotWidth;
  const lanes = lanesOf([...model.bars, ...model.waits].map((item) => item.lane));
  let top = LAYOUT.top;
  const placed = lanes.map((name) => {
    const packed = pack(model.bars.filter((bar) => bar.lane === name).sort(byTime).map((bar) => ({ bar, x0: x(bar.from), x1: Math.max(x(bar.to), x(bar.from) + LAYOUT.minBarWidth) })));
    const rows = Math.max(1, ...packed.map((item) => item.row + 1));
    const h = rows > LAYOUT.compactAbove ? LAYOUT.compactRowHeight : LAYOUT.rowHeight; // a lane of many parallel bars (thirty check-runs at once) is drawn thin, with its words in the table, rather than a page tall
    const bars = packed.map((item) => ({ ...item, h, y: top + LAYOUT.lanePad / 2 + item.row * (h + LAYOUT.rowGap) }));
    const waits = model.waits.filter((wait) => wait.lane === name).sort(byTime).map((wait) => ({ wait, x0: x(wait.from), x1: Math.max(x(wait.to), x(wait.from) + LAYOUT.minBarWidth) }));
    const height = rows * (h + LAYOUT.rowGap) + LAYOUT.lanePad + (h < LAYOUT.rowHeight ? LAYOUT.rowHeight - h : 0); // thin lanes keep room for the lane's name
    const lane = { name, top, height, bars, waits };
    top += height;
    return lane;
  });
  return { x, lanes: placed, height: top + LAYOUT.top / 2, ticks: tickStep(span), span };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Drawing

/** A bar's cost step, 1 (cheapest) to `COST_STEPS`, of the dearest priced turn in the row; `0` for a turn with no price. @param {Bar} bar @param {number} dearest */
function costStep(bar, dearest) {
  if (typeof bar.costUsd !== "number" || dearest <= 0) return 0;
  return Math.max(1, Math.ceil((bar.costUsd / dearest) * COST_STEPS));
}

/** @param {Bar} bar @param {number} dearest */
const barClass = (bar, dearest) => ["bar", bar.kind, bar.kind === "turn" ? `cost${costStep(bar, dearest)}` : "", bar.repeat ? "repeat" : ""].filter(Boolean).join(" ");

/** The title and the label a bar carries: its words, and what is repeated about it. @param {Bar} bar */
const barTitle = (bar) => `${bar.text}\n${clock(bar.from)}${bar.to > bar.from ? `-${clock(bar.to)} (${duration(bar.to - bar.from)})` : ""}${bar.note ? `\n${bar.note}` : ""}${bar.repeat ? `\nREPEAT: ${bar.repeat.kind}: ${bar.repeat.summary}` : ""}`;

/** The text that fits in a bar, cut with an ellipsis; none when not even a few characters fit. @param {string} text @param {number} width */
function fitted(text, width) {
  const room = Math.floor((width - 2 * LAYOUT.textPad) / LAYOUT.charWidth);
  if (room < 4) return "";
  return text.length <= room ? text : `${text.slice(0, room - 1)}…`;
}

/** @param {ReturnType<typeof layoutOf>["lanes"][number]["bars"][number]} item @param {number} dearest */
function barSvg(item, dearest) {
  const { bar, x0, x1, y, h } = item;
  const label = bar.kind === "order" || bar.kind === "review" || bar.kind === "compaction" || h < LAYOUT.rowHeight ? "" : fitted(bar.text, x1 - x0);
  return `<g class="${barClass(bar, dearest)}" id="bar-${esc(bar.id)}" data-lane="${esc(bar.lane)}" data-kind="${bar.kind}"${bar.repeat ? ` data-repeat="${esc(bar.repeat.kind)}"` : ""}><title>${esc(barTitle(bar))}</title>`
    + `<rect x="${x0.toFixed(1)}" y="${y}" width="${(x1 - x0).toFixed(1)}" height="${h}" rx="3"/>${label ? `<text x="${(x0 + LAYOUT.textPad).toFixed(1)}" y="${y + h / 2 + 4}">${esc(label)}</text>` : ""}</g>`;
}

/** @param {ReturnType<typeof layoutOf>["lanes"][number]["waits"][number]} item @param {number} laneTop @param {number} laneHeight */
function waitSvg(item, laneTop, laneHeight) {
  const { wait, x0, x1 } = item;
  const label = fitted(`${wait.inferred ? "INFERRED: " : ""}${wait.text}`, x1 - x0);
  const title = `${wait.inferred ? "INFERRED. " : ""}${wait.text}\n${clock(wait.from)}-${clock(wait.to)} (${duration(wait.to - wait.from)}) [${wait.source}]`;
  return `<g class="wait${wait.inferred ? " inferred" : ""}" data-lane="${esc(wait.lane)}" data-source="${esc(wait.source)}"><title>${esc(title)}</title>`
    + `<rect x="${x0.toFixed(1)}" y="${laneTop + 1}" width="${(x1 - x0).toFixed(1)}" height="${laneHeight - 2}" fill="url(#hatch)"/>${label ? `<text class="waittext" x="${(x0 + LAYOUT.textPad).toFixed(1)}" y="${laneTop + laneHeight - 5}">${esc(label)}</text>` : ""}</g>`;
}

/** @param {ReturnType<typeof layoutOf>} layout @param {{ start: number }} axis */
function axisSvg(layout, axis) {
  const first = Math.ceil(axis.start / layout.ticks) * layout.ticks;
  const ticks = [];
  for (let at = first; at <= axis.start + layout.span; at += layout.ticks) {
    const px = layout.x(at).toFixed(1);
    const label = layout.span > 24 * 60 * MS_PER_MINUTE ? stamp(at).slice("YYYY-".length, "YYYY-MM-DD HH:MM".length) : clock(at).slice(0, "HH:MM".length);
    ticks.push(`<line class="grid" x1="${px}" y1="${LAYOUT.top - 6}" x2="${px}" y2="${layout.height - LAYOUT.top / 2}"/><text class="tick" x="${px}" y="${LAYOUT.top - 12}" text-anchor="middle">${label}</text>`);
  }
  return ticks.join("");
}

/** An order's arrow runs from the foot of its tick on the gate lane to the head of the turn it woke. @param {Arrow} arrow @param {ReturnType<typeof layoutOf>} layout */
function arrowSvg({ order, turn }, layout) {
  const slots = layout.lanes.flatMap((lane) => lane.bars);
  const from = slots.find((item) => item.bar === order);
  const to = slots.find((item) => item.bar === turn);
  if (!from || !to) return "";
  return `<line class="arrow" data-order="${esc(order.id)}" data-turn="${esc(turn.id)}" x1="${from.x0.toFixed(1)}" y1="${from.y + from.h}" x2="${to.x0.toFixed(1)}" y2="${to.y}" marker-end="url(#head)"/>`;
}

const DEFS = `<defs><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" class="hatchbg"/><line x1="0" y1="0" x2="0" y2="8" class="hatchline"/></pattern>`
  + `<marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="headfill"/></marker></defs>`;

/** @param {ReturnType<typeof layoutOf>} layout @param {{ start: number }} axis @param {Arrow[]} arrows @param {number} dearest */
function svgOf(layout, axis, arrows, dearest) {
  const width = LAYOUT.labelWidth + LAYOUT.plotWidth + LAYOUT.right;
  const lanes = layout.lanes.map((lane, index) => `<g class="lane" data-lane="${esc(lane.name)}"><rect class="${index % 2 === 0 ? "band" : "band alt"}" x="0" y="${lane.top}" width="${width}" height="${lane.height}"/>`
    + `<text class="lanename" x="8" y="${lane.top + LAYOUT.rowHeight / 2 + 8}">${esc(lane.name)}</text>`
    + `${lane.waits.map((wait) => waitSvg(wait, lane.top, lane.height)).join("")}${lane.bars.map((bar) => barSvg(bar, dearest)).join("")}</g>`);
  return `<svg role="img" aria-labelledby="swim-title" viewBox="0 0 ${width} ${layout.height}" width="${width}" height="${layout.height}"><title id="swim-title">Swimlane timeline, one lane per actor, time running left to right, in UTC</title>${DEFS}`
    + `${axisSvg(layout, axis)}${lanes.join("")}${arrows.map((arrow) => arrowSvg(arrow, layout)).join("")}</svg>`;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// The page

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1f24;--muted:#57606a;--band:#f6f8fa;--band2:#eef1f4;--grid:#d0d7de;--bar:#9fb4cf;--cost1:#cfe3f5;--cost2:#9ec5ea;--cost3:#5f9fd6;--cost4:#2f6fb0;--cost5:#123e73;--costtext:#0b1a2b;--unpriced:#b9bfc7;--ci:#a8d5ba;--queue:#e9c98d;--tick:#59636e;--repeat:#d1242f;--hatch:#8a5a00;--hatchbg:#fff4d6;--infer:#6639ba}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9aa5b1;--band:#151b23;--band2:#1b222c;--grid:#30363d;--bar:#4a6385;--cost1:#25415f;--cost2:#2f5d8e;--cost3:#3f7fbf;--cost4:#6aa5de;--cost5:#a9d0f5;--costtext:#fff;--unpriced:#4b525b;--ci:#2c5a40;--queue:#6b5420;--tick:#9aa5b1;--repeat:#ff6b72;--hatch:#d9a441;--hatchbg:#2a2210;--infer:#b392f0}}
body{margin:0;padding:16px 20px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 6px}.sub{color:var(--muted);margin:0 0 12px}
.scroll{overflow-x:auto;border:1px solid var(--grid)}svg{display:block;font:11px system-ui,sans-serif}
.band{fill:var(--band)}.band.alt{fill:var(--band2)}.lanename{fill:var(--fg);font-weight:600;font-size:12px}.grid{stroke:var(--grid);stroke-width:1}.tick{fill:var(--muted)}
.bar rect{stroke:var(--bg);stroke-width:1}.bar text{fill:var(--costtext);pointer-events:none}
.bar.turn rect{fill:var(--unpriced)}.cost1 rect{fill:var(--cost1)}.cost2 rect{fill:var(--cost2)}.cost3 rect{fill:var(--cost3)}.cost4 rect{fill:var(--cost4)}.cost5 rect{fill:var(--cost5)}
.cost4 text,.cost5 text{fill:#fff}.bar.ci rect{fill:var(--ci)}.bar.queue rect{fill:var(--queue)}.bar.order rect,.bar.review rect,.bar.compaction rect{fill:var(--tick)}
.bar.repeat rect{stroke:var(--repeat);stroke-width:3}
.hatchbg{fill:var(--hatchbg)}.hatchline{stroke:var(--hatch);stroke-width:3}.wait rect{stroke:var(--hatch);stroke-width:1}.wait.inferred rect{stroke:var(--infer);stroke-dasharray:4 2;stroke-width:2}
.waittext{fill:var(--fg);font-style:italic}.arrow{stroke:var(--fg);stroke-width:1.2;opacity:.75}.headfill{fill:var(--fg)}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid var(--grid);padding:3px 6px;text-align:left;vertical-align:top}th{background:var(--band)}
td.num{text-align:right;font-variant-numeric:tabular-nums}.red{color:var(--repeat);font-weight:600}.inferred-mark{color:var(--infer);font-weight:600}
.legend span{display:inline-block;margin-right:14px}.sw{display:inline-block;width:14px;height:14px;vertical-align:-2px;margin-right:4px;border:1px solid var(--grid)}
`;

/** @param {number} dearest */
function legendOf(dearest) {
  const cost = (/** @type {number} */ step) => `<span><i class="sw" style="background:var(--cost${step})"></i>${step === 1 ? "cheapest" : step === COST_STEPS ? `dearest${dearest > 0 ? ` ($${dearest.toFixed(COST_DECIMALS)})` : ""}` : ""}</span>`;
  return `<p class="legend"><span>Turn colour = $ per turn, in ${COST_STEPS} steps up to the dearest turn in this row:</span>${[1, 2, 3, 4, 5].map(cost).join("")}<span><i class="sw" style="background:var(--unpriced)"></i>no price ($?)</span>`
    + `<span><i class="sw" style="background:var(--hatchbg);border-color:var(--hatch)"></i>hatched = WAITING (named in the segment)</span><span><i class="sw" style="border-color:var(--infer);border-style:dashed"></i>dashed = INFERRED wait</span>`
    + `<span><i class="sw" style="border:3px solid var(--repeat)"></i>red outline = a REPEAT</span><span>&rarr; arrow = an order and the turn it woke</span></p>`;
}

/** @param {Bar} bar */
const barRow = (bar) => `<tr><td>${esc(bar.lane)}</td><td>${bar.kind}</td><td>${clock(bar.from)}</td><td>${bar.to > bar.from ? duration(bar.to - bar.from) : "tick"}</td>`
  + `<td class="num">${bar.kind === "turn" ? (typeof bar.costUsd === "number" ? `$${bar.costUsd.toFixed(COST_DECIMALS)}` : "$?") : ""}</td><td>${esc(bar.cause ?? "")}</td><td>${esc(bar.model ?? "")}</td>`
  + `<td>${esc(bar.text)}${bar.repeat ? ` <span class="red">REPEAT: ${esc(bar.repeat.kind)}</span>` : ""}</td></tr>`;

/** @param {WaitSegment} wait */
const waitRow = (wait) => `<tr><td>${esc(wait.lane)}</td><td>${clock(wait.from)}-${clock(wait.to)}</td><td>${duration(wait.to - wait.from)}</td><td>${esc(wait.source)}</td>`
  + `<td>${wait.inferred ? '<span class="inferred-mark">INFERRED</span> ' : ""}${esc(wait.text)}${wait.evidence.length > 0 ? `<br><small>${wait.evidence.map(esc).join("; ")}</small>` : ""}</td></tr>`;

/** @param {Repeat} repeat */
const repeatRow = (repeat) => `<li><span class="red">${esc(repeat.kind)}</span> at ${clock(repeat.at)} (${esc(repeat.phase)}): ${esc(repeat.summary)}</li>`;

/**
 * The swimlane of one row, as one self-contained HTML page.
 * @param {{ events: TraceEvent[], now: number, title: string }} input `events` as `eventsForRow` returns them; `now` is the reading's time, which an open run extends to
 * @returns {string}
 */
export function swimlane({ events, now, title }) {
  const wf = waterfall({ events, now });
  const model = collect(events, wf, now);
  const all = [...model.bars, ...model.waits];
  const start = Math.min(wf.start ?? Infinity, ...all.map((item) => item.from));
  const end = Math.max(wf.end ?? -Infinity, ...all.map((item) => item.to));
  const empty = !Number.isFinite(start);
  const axis = { start: empty ? now : start, end: empty ? now : end };
  const dearest = Math.max(0, ...model.bars.map((bar) => (typeof bar.costUsd === "number" ? bar.costUsd : 0)));
  const layout = layoutOf(model, axis);
  const turns = model.bars.filter((bar) => bar.kind === "turn");
  const unlaned = [...model.unlaned].map(([session, count]) => `${session} (${count})`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Swimlane ${esc(title)}</title><style>${STYLE}</style></head>
<body><h1>Swimlane: ${esc(title)}</h1>
<p class="sub">${empty ? "No record in the store names this row: nothing to draw (widen --since)." : `${stamp(axis.start)} to ${wf.open ? "OPEN" : stamp(axis.end)} UTC, ${duration(axis.end - axis.start)} wall-clock; ${turns.length} turns, ${model.waits.length} waits, ${model.arrows.length} orders joined to the turn they woke, ${wf.repeats.length} repeats. Read ${stamp(now)}Z.`}</p>
${legendOf(dearest)}
<div class="scroll">${svgOf(layout, axis, model.arrows, dearest)}</div>
<h2>Waits</h2><table><thead><tr><th>lane</th><th>from-to</th><th>for</th><th>source</th><th>what was waited on</th></tr></thead><tbody>${model.waits.sort(byTime).map(waitRow).join("") || '<tr><td colspan="5">none recorded</td></tr>'}</tbody></table>
<h2>Repeats</h2>${wf.repeats.length > 0 ? `<ul>${wf.repeats.map(repeatRow).join("")}</ul>` : "<p>none</p>"}
<h2>Every bar</h2><table><thead><tr><th>lane</th><th>kind</th><th>at</th><th>for</th><th>cost</th><th>cause</th><th>model</th><th>what</th></tr></thead><tbody>${model.bars.sort(byTime).map(barRow).join("")}</tbody></table>
<p class="sub">${unlaned.length > 0 ? `Turns by sessions that have no lane here, not drawn: ${esc(unlaned.join(", "))}. ` : ""}A turn's span is the store's INFERRED model time before its end; a long tool call is in no turn's span, and a wait with no record is not drawn. Cost is the store's own $ per turn; a turn with no price is "$?", never zero. Times are UTC.</p>
</body></html>
`;
}
