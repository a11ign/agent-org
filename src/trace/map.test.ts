// a11ign/a11ign#3514 (slice 7 of #3494): `trace --map`. Fixtures only: nothing here reads `~/.claude`, `~/.cache/a11ign` or GitHub.
// no-token: gh -- every source is an injected fixture; `processMap` and `renderMap` are pure functions and call no `gh`
//
// FIVE MERGED ROWS in two weeks (A = Mon 2026-09-21, B = Mon 2026-09-28), the figures in the comments beside the assertions that use them are worked by hand:
//   101  week A, a11ign/a11ign   the full path, one review loop, one queue loop (an ejection), one compaction
//   102  week A, a11ign/a11ign   the plain path
//   201  week B, a11ign/agent-org  the plain path with no queue entry (review -> merged), a pull request in the OTHER repository
//   202  week B                  only `filed` and `merged` in the store: a step that skips eight columns
//   203  week B                  nothing in the store but its merge: counted as unread, in no edge
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregate } from "./aggregate.mjs";
import { buildMap, LOOPS, MAP_DEFINITIONS, PHASES, processMap, renderMap } from "./map.mjs";
import type { MapFilter } from "./map.mjs";
import type { TraceEvent } from "./store.mjs";
import type { PullRequest } from "../wakes-per-row.mjs";

const ROW_REPO = "a11ign/a11ign";
const at = (iso: string): number => Date.parse(iso);
const WEEK_A = at("2026-09-21T00:00:00Z");
const WEEK_B = at("2026-09-28T00:00:00Z");
const NOW = at("2026-10-05T12:00:00Z");
const WINDOW = { from: WEEK_A, to: NOW };
const SONNET = "claude-sonnet-5-5";
const near = (actual: number | null | undefined, expected: number): void => assert.ok(actual != null && Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

let serial = 0;
const base = (kind: TraceEvent["kind"], when: string, source: TraceEvent["source"], extra: Partial<TraceEvent>): TraceEvent => ({ id: `${kind}:${(serial += 1)}`, kind, source, at: at(when), session: source === "github" ? "github" : "worker", row: null, pr: null, repo: null, cause: null, causeKey: null, wakeId: null, ...extra });
const github = (kind: TraceEvent["kind"], when: string, extra: Partial<TraceEvent>): TraceEvent => base(kind, when, "github", extra);
const turn = (when: string, session: string, cost: number | null, extra: Partial<TraceEvent> = {}): TraceEvent => base("turn", when, "transcript", {
  session, costUsd: cost, model: SONNET, tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite5m: 0, cacheWrite1h: 0 }, wallClockMs: 1000, ...extra,
});
const wake = (when: string, row: number, cause: string): TraceEvent => base("wake", when, "wake-ledger", { session: `worker-${row}`, row, cause, causeKey: `worker-${row}/${cause}/row-${row}`, wakeId: `wake:${serial}` });
const pull = (repo: string, number: number, row: number, mergedIso: string): PullRequest => ({ repo, number, createdAt: "2026-09-20T00:00:00Z", mergedAt: mergedIso, body: `Closes ${repo === ROW_REPO ? "" : `${ROW_REPO}`}#${row}` });
/** The events of one pull request. `repo` is how the store keeps it: null for the primary, the short name for another. */
const prEvent = (kind: TraceEvent["kind"], when: string, number: number, repo: string | null, extra: Partial<TraceEvent> = {}): TraceEvent => github(kind, when, { pr: number, repo, ...extra });

const PULLS: PullRequest[] = [
  pull(ROW_REPO, 1101, 101, "2026-09-23T10:00:00Z"), pull(ROW_REPO, 1102, 102, "2026-09-21T15:00:00Z"),
  pull("a11ign/agent-org", 9201, 201, "2026-09-29T10:00:00Z"), pull(ROW_REPO, 1202, 202, "2026-09-30T10:00:00Z"), pull(ROW_REPO, 1203, 203, "2026-09-30T11:00:00Z"),
];

const ROW_101: TraceEvent[] = [
  github("filed", "2026-09-21T08:00:00Z", { row: 101 }), github("claimed", "2026-09-22T08:00:00Z", { row: 101, claimant: "worker-101" }),
  prEvent("head_moved", "2026-09-22T09:00:00Z", 1101, null), prEvent("head_moved", "2026-09-22T10:00:00Z", 1101, null), prEvent("opened", "2026-09-22T10:30:00Z", 1101, null),
  prEvent("ci_run", "2026-09-22T10:31:00Z", 1101, null, { startedAt: at("2026-09-22T10:31:00Z"), completedAt: at("2026-09-22T10:40:00Z") }),
  prEvent("reviewed", "2026-09-22T12:00:00Z", 1101, null, { state: "CHANGES_REQUESTED" }), prEvent("head_moved", "2026-09-22T13:00:00Z", 1101, null), // a commit AFTER it opened is rework, not build
  prEvent("reviewed", "2026-09-22T14:00:00Z", 1101, null, { state: "APPROVED" }),
  prEvent("added_to_merge_queue", "2026-09-22T14:30:00Z", 1101, null), prEvent("removed_from_merge_queue", "2026-09-22T15:00:00Z", 1101, null, { outcome: "unmerged" }),
  prEvent("added_to_merge_queue", "2026-09-22T16:00:00Z", 1101, null), prEvent("removed_from_merge_queue", "2026-09-23T10:00:00Z", 1101, null, { outcome: "merged" }),
  prEvent("merged", "2026-09-23T10:00:00Z", 1101, null),
  base("compaction", "2026-09-22T11:00:00Z", "transcript", { session: "worker-101", row: 101 }),
  wake("2026-09-22T08:00:00Z", 101, "ready-row-unclaimed"), wake("2026-09-22T12:00:00Z", 101, "pr-review-blocked"),
  turn("2026-09-21T07:00:00Z", "worker-101", 9, { row: 101 }), // before the row was filed: in no node
  turn("2026-09-22T08:30:00Z", "worker-101", 1, { row: 101 }), turn("2026-09-22T09:30:00Z", "worker-101", 2, { row: 101 }), turn("2026-09-22T10:15:00Z", "worker-101", 0.5, { row: 101 }),
  turn("2026-09-22T12:30:00Z", "worker-101", 4, { row: 101, tokens: { input: 1000, output: 500, cacheRead: 100000, cacheWrite5m: 0, cacheWrite1h: 0 } }), // the first turn after the compaction
  turn("2026-09-22T13:30:00Z", "reviewer-1101", 0.75, { pr: 1101 }),
  turn("2026-09-22T15:30:00Z", "worker-101", null, { row: 101, model: "<synthetic>" }), turn("2026-09-22T15:45:00Z", "worker-101", 0.25, { row: 101 }),
];
const ROW_102: TraceEvent[] = [
  github("filed", "2026-09-21T09:00:00Z", { row: 102 }), github("claimed", "2026-09-21T10:00:00Z", { row: 102, claimant: "worker-102" }),
  prEvent("head_moved", "2026-09-21T11:00:00Z", 1102, null), prEvent("opened", "2026-09-21T11:30:00Z", 1102, null),
  prEvent("ci_run", "2026-09-21T11:31:00Z", 1102, null, { startedAt: at("2026-09-21T11:31:00Z"), completedAt: at("2026-09-21T11:40:00Z") }),
  prEvent("reviewed", "2026-09-21T13:00:00Z", 1102, null, { state: "APPROVED" }), prEvent("added_to_merge_queue", "2026-09-21T13:30:00Z", 1102, null), prEvent("merged", "2026-09-21T15:00:00Z", 1102, null),
  wake("2026-09-21T10:00:00Z", 102, "ready-row-unclaimed"),
  turn("2026-09-21T10:30:00Z", "worker-102", 3, { row: 102 }), turn("2026-09-21T11:15:00Z", "worker-102", 1, { row: 102 }), turn("2026-09-21T13:10:00Z", "worker-102", 2, { row: 102 }),
];
const ROW_201: TraceEvent[] = [
  github("filed", "2026-09-28T08:00:00Z", { row: 201 }), github("claimed", "2026-09-28T09:00:00Z", { row: 201, claimant: "worker-201" }),
  prEvent("head_moved", "2026-09-28T10:00:00Z", 9201, "agent-org"), prEvent("opened", "2026-09-28T10:30:00Z", 9201, "agent-org"),
  prEvent("ci_run", "2026-09-28T10:31:00Z", 9201, "agent-org", { startedAt: at("2026-09-28T10:31:00Z"), completedAt: at("2026-09-28T10:40:00Z") }),
  prEvent("reviewed", "2026-09-28T12:00:00Z", 9201, "agent-org", { state: "APPROVED" }), prEvent("merged", "2026-09-29T10:00:00Z", 9201, "agent-org"),
  wake("2026-09-28T09:00:00Z", 201, "ready-row-unclaimed"), turn("2026-09-28T09:30:00Z", "worker-201", 6, { row: 201 }),
];
const ROW_202: TraceEvent[] = [github("filed", "2026-09-29T08:00:00Z", { row: 202 })];
const EVENTS: TraceEvent[] = [...ROW_101, ...ROW_102, ...ROW_201, ...ROW_202];

const model = (filter: MapFilter = {}, events: TraceEvent[] = EVENTS) => processMap({ events, pulls: PULLS, rowRepo: ROW_REPO, window: WINDOW, filter });
const page = (filter: MapFilter = {}, events: TraceEvent[] = EVENTS): string => buildMap({ events, pulls: PULLS, rowRepo: ROW_REPO, window: WINDOW, filter, generatedAt: NOW });
type Model = ReturnType<typeof processMap>;
/** The node or loop called `id`: its absence fails here, by name, and not as a property read of undefined later. */
function node(m: Model, id: string): Model["nodes"][number] {
  const found = m.nodes.find((entry) => entry.id === id);
  assert.ok(found, `the model has a node ${id}`);
  return found;
}
function loop(m: Model, id: string): Model["loops"][number] {
  const found = m.loops.find((entry) => entry.id === id);
  assert.ok(found, `the model has a loop ${id}`);
  return found;
}
function rowOf(m: Model, row: number): Model["rows"][number] {
  const found = m.rows.find((entry) => entry.row === row);
  assert.ok(found, `the model has row ${row}`);
  return found;
}

/** The edges the page DRAWS, read back out of the string: `from>to` -> { rows, stroke }. */
function drawnEdges(html: string): Map<string, { rows: number, stroke: number }> {
  const found = [...html.matchAll(/<g class="edge" data-from="(\w+)" data-to="(\w+)"><title>[^<]*: (\d+) rows<\/title><(?:line|path)[^>]*stroke-width="([\d.]+)"/g)];
  return new Map(found.map(([, from, to, rows, stroke]) => [`${from}>${to}`, { rows: Number(rows), stroke: Number(stroke) }]));
}
const countsOf = (html: string): Record<string, number> => Object.fromEntries([...drawnEdges(html)].map(([key, { rows }]) => [key, rows]));

test("NODES: one per phase of the chairman's ten, the page draws them all, and boarded is drawn as NOT HELD with no step and no figure", () => {
  assert.deepEqual(PHASES.map((phase) => phase.id), ["filed", "boarded", "claimed", "build", "verify", "pr", "review", "ci", "queue", "merged"]);
  const m = model();
  assert.deepEqual(m.nodes.map((entry) => entry.id), PHASES.map((phase) => phase.id));
  const html = page();
  for (const phase of PHASES) assert.match(html, new RegExp(`<g class="node [\\w ]+" data-phase="${phase.id}">`), `${phase.id} is drawn`);
  const boarded = node(m, "boarded");
  assert.equal(boarded.held, false);
  assert.equal(boarded.rows, 0, "no row is counted in a phase the store has no event for");
  assert.ok(![...drawnEdges(html).keys()].some((key) => key.split(">").includes("boarded")), "and no edge touches it");
  assert.match(html, /<g class="node unheld" data-phase="boarded">[\s\S]*?not held/);
  assert.ok(MAP_DEFINITIONS.some((line) => /boarded is NOT HELD/.test(line)), "and the definitions say so");
});

test("EDGES: one per observed step with the number of ROWS that took it, parsed back out of the page; the width follows the count", () => {
  const html = page();
  // filed>claimed: 101, 102, 201. review>queue: 101 and 102 (201 has no queue entry, so its review goes to merged). 202 skips eight columns: filed>merged.
  assert.deepEqual(countsOf(html), {
    "filed>claimed": 3, "claimed>build": 3, "build>verify": 3, "verify>pr": 3, "pr>ci": 3, "ci>review": 3, "review>queue": 2, "queue>merged": 2, "review>merged": 1, "filed>merged": 1,
  });
  const edges = drawnEdges(html);
  assert.ok(edges.get("filed>claimed")!.stroke > edges.get("review>queue")!.stroke, "3 rows is wider than 2");
  assert.ok(edges.get("review>queue")!.stroke > edges.get("review>merged")!.stroke, "2 rows is wider than 1");
  assert.deepEqual(model().edges.map((edge) => `${edge.from}>${edge.to}`).sort(), Object.keys(countsOf(html)).sort(), "the model and the page agree");
});

test("STEPS: a row's steps are in the order of their times, build is the first commit and verify the last before the pull request opened, a later commit is neither", () => {
  const m = model();
  assert.equal(rowOf(m, 101).steps, 9, "filed claimed build verify pr ci review queue merged: the rework commit after opening adds no step");
  assert.equal(rowOf(m, 102).steps, 9, "one commit is both the first and the last: build and verify tie and both are entered");
  assert.equal(rowOf(m, 201).steps, 8);
  assert.equal(rowOf(m, 202).steps, 2);
  assert.equal(rowOf(m, 203).steps, 1, "a row with only its merge has one step");
  assert.equal(model().unread, 1, "and only row 203 is counted as having no GitHub events beyond its merge");
});

test("NODE FIGURES: the median wait and the median dollars are nearest-rank over the rows in the phase, and a floor is marked", () => {
  const m = model();
  // claimed: 101 waits 08:00 -> 09:00, 102 10:00 -> 11:00 and 201 09:00 -> 10:00 (1h each); dollars 1.0 (101: 08:30), 3.0 (102: 10:30) and 6.0 (201: 09:30): nearest-rank p50 of three is the middle, 3.0.
  assert.equal(node(m, "claimed").medianWaitMs, 60 * 60 * 1000 * 1);
  near(node(m, "claimed").medianDollars, 3);
  // review: 101 waits 12:00 -> 14:30 (2.5h) with 4.0 + 0.75 (reviewer-1101, keyed by the pull request) and 102 waits 13:00 -> 13:30 with 2.0, 201 12:00 -> the merge on the 29th with nothing in it: [0, 2.0, 4.75] -> 2.0.
  assert.equal(node(m, "review").rows, 3);
  near(node(m, "review").medianDollars, 2);
  // queue: 101 spends 0.25 plus an unpriced turn (a floor), 102 spends nothing; 201 never queued. [0, 0.25] -> 0, and the node is marked a floor.
  assert.equal(node(m, "queue").rows, 2);
  near(node(m, "queue").medianDollars, 0);
  assert.equal(node(m, "queue").floor, true);
  assert.equal(node(m, "merged").medianWaitMs, null, "the end has no wait");
  assert.match(page(), /wait 1\.0h/);
  // 101's turn before it was filed (9.0) is in no node, but it is in the row's own total: 9 + 1 + 2 + 0.5 + 4 + 0.75 + 0.25 = 17.5 priced dollars.
  near(rowOf(model(), 101).totalDollars, 17.5);
});

test("A ROW WITH NO TURN IN THE STORE has no dollars, never 0: its node figure is n/a and its loops are counted and not priced", () => {
  const events = EVENTS.filter((event) => event.kind !== "turn");
  const m = model({}, events);
  assert.equal(node(m, "claimed").medianDollars, null);
  assert.match(page({}, events), /<td>claimed<\/td><td>3<\/td><td>[^<]*<\/td><td>n\/a<\/td><td>0<\/td>/);
  assert.equal(rowOf(m, 101).totalDollars, null);
  assert.equal(loop(m, "review").count, 1, "the loop is still counted");
  assert.equal(loop(m, "review").priced, 0);
  assert.match(page({}, events), /<td class="loop-row">review -&gt; rework -&gt; review<\/td><td>1<\/td><td>1<\/td><td>n\/a<\/td>/);
});

test("LOOPS: review -> rework -> review, queue -> eject -> queue and wake -> compaction are counted with their dollars", () => {
  const m = model();
  assert.deepEqual(LOOPS.map((entry) => entry.id), ["review", "queue", "compaction"]);
  // review: 101 was reviewed twice, so one trip round. Its dollars are the row's turns from the first review to the second (12:00 -> 14:00): 4.0 + the reviewer's 0.75.
  assert.equal(loop(m, "review").count, 1);
  near(loop(m, "review").dollars, 4.75);
  // queue: 101 was ejected at 15:00 and re-entered at 16:00: one trip, and the turns between are 0.25 and one unpriced, so 0.25 is a floor.
  assert.equal(loop(m, "queue").count, 1);
  near(loop(m, "queue").dollars, 0.25);
  assert.equal(loop(m, "queue").floor, true);
  // compaction: one, priced at the INPUT side of the next turn of worker-101 (1000 input at $2/M + 100000 cache read at $0.20/M = 0.002 + 0.02), not its 4.0.
  assert.equal(loop(m, "compaction").count, 1);
  near(loop(m, "compaction").dollars, 0.022);
  assert.equal(m.wakes, 4, "wake, beside compaction: the wakes on the rows (101 has two, 102 and 201 one each)");
});

test("LOOPS: a compaction is priced at the session's own next turn, never a subagent's (sidechain) turn between", () => {
  // A subagent turn 30 minutes after the compaction, with a window an order of magnitude larger than the session's own: were it taken, the loop would cost $2.00 and not $0.022.
  const subagent = turn("2026-09-22T11:30:00Z", "worker-101", 1, { row: 101, sidechain: true, tokens: { input: 1000000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } });
  const m = model({}, [...EVENTS, subagent]);
  assert.equal(loop(m, "compaction").count, 1);
  near(loop(m, "compaction").dollars, 0.022);
  assert.equal(loop(m, "compaction").floor, false);
  // The positive control: the same turn NOT marked sidechain is the next turn, and is priced, so the guard above is what kept it out.
  near(loop(model({}, [...EVENTS, { ...subagent, sidechain: false }]), "compaction").dollars, 2);
});

/** The loops drawn red: every loop with a count is a `.loop` group, and the stylesheet paints `.loop` in the red that the red arrowhead uses and the ordinary edges do not. */
function assertLoopsRed(html: string): void {
  const groups = [...html.matchAll(/<g class="(loop)" data-loop="(\w+)" data-count="(\d+)">/g)];
  assert.deepEqual(groups.map((group) => group[2]).sort(), ["compaction", "queue", "review"], "every loop is drawn as a loop");
  const painted = /\.loop line \{ stroke: (#[0-9a-f]{6});/.exec(html)?.[1];
  const ordinary = /\.edge line, \.edge path \{ stroke: (#[0-9a-f]{6});/.exec(html)?.[1];
  const arrow = /<marker id="arrow-red"[^>]*><path[^>]*fill="(#[0-9a-f]{6})"/.exec(html)?.[1];
  assert.ok(painted && painted === arrow, `the loop colour is the red arrowhead's (${painted} vs ${arrow})`);
  assert.notEqual(painted, ordinary, "and not the ordinary edge colour");
  assert.match(String(painted), /^#(?:[b-f][0-9a-f]){1}[0-5][0-9a-f][0-5][0-9a-f]$/, "and it is a red: the red channel dominates");
  assert.deepEqual(groups.map((group) => [group[2], Number(group[3])]).sort(), [["compaction", 1], ["queue", 1], ["review", 1]], "with their counts on the group");
}

test("LOOPS ARE RED: the page paints every loop red with its count and dollars; a map that draws a loop in the ordinary colour is RED (positive control)", () => {
  const html = page();
  assertLoopsRed(html);
  assert.match(html, /<td class="loop-row">review -&gt; rework -&gt; review<\/td><td>1<\/td><td>1<\/td><td>\$4\.75<\/td>/);
  assert.match(html, /<td class="loop-row">queue -&gt; eject -&gt; queue<\/td><td>1<\/td><td>1<\/td><td>&gt;= \$0\.25<\/td>/);
  assert.match(html, /<text[^>]*>1× \$4\.75<\/text>/, "the loop's count and dollars are on the drawing too, not only in the table");
  // The control: the same page with the loops in the ordinary colour must fail the same assertion, or the assertion is not looking.
  const ordinary = html.replace(/\.loop line \{ stroke: #b3261e;/, ".loop line { stroke: #555555;");
  assert.notEqual(ordinary, html, "the mutation changed the page");
  assert.throws(() => assertLoopsRed(ordinary), /the loop colour is the red arrowhead's/);
  assert.throws(() => assertLoopsRed(html.replace(/ class="loop" data-loop="review"/, ' class="edge" data-loop="review"')), /every loop is drawn as a loop/);
});

test("FILTERS: each one changes the counts, and the page says which is on", () => {
  const all = model();
  assert.equal(all.rows.length, 5);
  const byRepo = model({ repo: "agent-org" });
  assert.deepEqual(byRepo.rows.map((row) => row.row), [201], "--repo is the repository of the pull request that merged the row (the short name or the full one)");
  assert.deepEqual(model({ repo: "a11ign/agent-org" }).rows.map((row) => row.row), [201]);
  assert.deepEqual(countsOf(page({ repo: "agent-org" })), { "filed>claimed": 1, "claimed>build": 1, "build>verify": 1, "verify>pr": 1, "pr>ci": 1, "ci>review": 1, "review>merged": 1 });
  const weekA = model({ week: WEEK_A });
  assert.deepEqual(weekA.rows.map((row) => row.row).sort(), [101, 102]);
  assert.equal(countsOf(page({ week: WEEK_A }))["filed>claimed"], 2);
  assert.equal(countsOf(page({ week: WEEK_B }))["filed>claimed"], 1);
  assert.equal(loop(weekA, "review").count, 1);
  assert.equal(loop(model({ week: WEEK_B }), "review").count, 0, "week B holds no review loop, so before and after can differ");
  assert.deepEqual(model({ cause: "pr-review-blocked" }).rows.map((row) => row.row), [101], "--cause keeps the rows woken by it");
  assert.deepEqual(model({ cause: "ready-row-unclaimed" }).rows.map((row) => row.row).sort(), [101, 102, 201]);
  assert.deepEqual(model({ cause: "no-such-cause" }).rows, []);
  assert.match(page({ repo: "agent-org", week: WEEK_B, cause: "ready-row-unclaimed" }), /Filter: repo agent-org, week of 2026-09-28, cause ready-row-unclaimed\./);
  assert.match(page(), /Filter: none \(every merged row in the window\)/);
  assert.match(page(), /repos [^;]*a11ign\/agent-org \(1\)[^;]*; weeks 2026-09-21 \(2\), 2026-09-28 \(3\); causes of a wake pr-review-blocked \(1\), ready-row-unclaimed \(3\)/, "the page lists what can be asked for");
});

/** Nothing the page loads or follows: no URL, no external script, stylesheet, image or link. */
function assertSelfContained(html: string): void {
  assert.doesNotMatch(html, /https?:\/\//i, "no URL");
  assert.doesNotMatch(html, /\/\/[a-z0-9.-]+\.[a-z]{2,}/i, "no protocol-relative URL");
  assert.doesNotMatch(html, /<script/i, "no script at all");
  assert.doesNotMatch(html, /<link\b/i, "no stylesheet link");
  assert.doesNotMatch(html, /\s(?:src|href)=/i, "no src or href");
  assert.doesNotMatch(html, /@import|url\((?!#)/i, "no CSS fetch (a `url(#marker)` is a reference inside the document, not a fetch)");
}

test("SELF-CONTAINED: no external URL and no `<script src>`; and the check sees one when there is one (positive control)", () => {
  const html = page();
  assertSelfContained(html);
  assert.match(html, /^<!doctype html>\n<html lang="en">/);
  assert.equal((html.match(/<html/g) ?? []).length, 1, "one document");
  assert.throws(() => assertSelfContained(html.replace("</main>", '<script src="https://cdn.example.com/mermaid.js"></script></main>')), /no URL/);
  assert.throws(() => assertSelfContained(html.replace("</main>", '<script src="/local.js"></script></main>')), /no script at all/);
  assert.throws(() => assertSelfContained(html.replace("</style>", "</style><link rel=stylesheet>")), /no stylesheet link/);
  assert.throws(() => assertSelfContained(html.replace(".note {", ".note { background: url(data:image/png;base64,AAAA);")), /no CSS fetch/);
  assert.match(html, /marker-end="url\(#arrow\)"/, "the in-document marker reference the check lets through is really in the page");
});

test("CAUSES: a wake with no cause is not offered as a cause to filter by, and a row woken twice by one cause counts once", () => {
  const events = [...EVENTS, base("wake", "2026-09-22T09:00:00Z", "wake-ledger", { session: "worker-102", row: 102, cause: null, wakeId: "w-null" }), wake("2026-09-21T12:00:00Z", 102, "ready-row-unclaimed")];
  const causes = model({}, events).population.causes;
  assert.deepEqual(causes, [{ value: "pr-review-blocked", rows: 1 }, { value: "ready-row-unclaimed", rows: 3 }]);
  assert.doesNotMatch(page({}, events), /null \(/);
});

test("ESCAPING: a cause or repository name from the store is text on the page, never markup", () => {
  const hostile = '<img src=x onerror="alert(1)">&';
  const events = [...EVENTS, wake("2026-09-22T09:00:00Z", 102, hostile)];
  const html = page({ cause: hostile }, events);
  assert.ok(!html.includes("<img"), "no element made of a cause");
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;"), "it is on the page, as text");
  assert.doesNotMatch(html, /<[a-z]+[^>]*\sonerror=/i, "and no element carries a handler");
});

test("ACCESSIBLE: the picture has a name and a description, and everything it shows is also in a table", () => {
  const html = page();
  assert.match(html, /<svg role="img" aria-labelledby="map-title map-desc"/);
  assert.match(html, /<title id="map-title">Across-rows process map<\/title>/);
  assert.match(html, /<desc id="map-desc">Process map of 5 merged rows: 10 steps between phases/);
  assert.match(html, /<h2>Phases<\/h2><table>/);
  assert.match(html, /<h2>Steps between phases<\/h2><table>/);
  assert.match(html, /<h2>Loops \(the waste\)<\/h2><table>/);
  assert.match(html, /<td>boarded<\/td><td colspan="4">not held/);
  assert.match(html, /<td>review<\/td><td>filed<\/td>|<td>filed<\/td><td>claimed<\/td><td>3<\/td>/);
});

test("AN EMPTY WINDOW is a page, not a crash: no rows, every figure n/a, and it says so", () => {
  const html = buildMap({ events: [], pulls: [], rowRepo: ROW_REPO, window: WINDOW, filter: {}, generatedAt: NOW });
  assert.match(html, /0 merged rows \(of 0 merged in the window\)/);
  assert.equal(drawnEdges(html).size, 0);
  assert.ok(processMap({ events: [], pulls: [], rowRepo: ROW_REPO, window: WINDOW }).nodes.every((entry) => entry.medianDollars === null && entry.rows === 0));
  assertSelfContained(html);
});

test("THE SAME MODEL PRINTS THE SAME PAGE: no clock is read inside, and a row's dollars here are aggregate's dollars for it", () => {
  assert.equal(renderMap(model(), { generatedAt: NOW }), renderMap(model(), { generatedAt: NOW }));
  const report = aggregate({ events: EVENTS, pulls: PULLS, rowRepo: ROW_REPO, now: NOW, since: WEEK_A, held: { from: WEEK_A, basis: "fixture" } });
  const theirs = new Map(report.weeks.flatMap((week) => week.rows).map((row) => [row.row, row.dollars] as const));
  /** Dollars to the micro-dollar, `null` kept as `null`: float noise is not a difference. */
  const micro = (dollars: number | null | undefined): number | null => (dollars == null ? null : Number(dollars.toFixed(6)));
  for (const row of model().rows) {
    assert.equal(micro(row.totalDollars), micro(theirs.get(row.row)), `row ${row.row}: the map's placement of turns is aggregate's`);
  }
  assert.equal(theirs.size, 5, "the same five rows");
});
