// a11ign/a11ign#3512 (slice 5 of #3494): the swimlane, on a fixture row in the store's shapes. Nothing here reads `~/.claude`, `~/.cache/a11ign` or GitHub, and the page is only ever PARSED, never rendered.
// no-token: gh -- every event is a fixture; `swimlane` is a pure function and calls nothing
import assert from "node:assert/strict";
import { test } from "node:test";
import { laneOf, lanesOf, swimlane } from "./swimlane.mjs";
import { waterfall } from "./waterfall.mjs";

const REPO_ROW = 9001;
const PR = 9100;
const H1 = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const H2 = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const at = (hhmmss: string) => Date.parse(`2026-10-04T${hhmmss}Z`);
const MINUTE = 60 * 1000;
const NOW = at("13:30:00");
const ORDER_KEY = "engineers/ready-row-unclaimed/9001";
const DRAFT_KEY = "orchestrator/draft-convinced-not-ready/pr-9100/caf5b440";

const base = { repo: null, cause: null, causeKey: null, wakeId: null };
const ghRecord = (kind: string, time: string, extra = {}, subject = { pr: PR }) => ({ id: `gh:a11ign/a11ign#${subject.pr ?? REPO_ROW}:${kind}:${time}`, kind, source: "github", session: "github", at: at(time),
  row: subject.pr ? null : REPO_ROW, pr: subject.pr ?? null, ...base, actor: "worker-9001", ...extra });
const rowEvent = (kind: string, time: string, extra = {}) => ghRecord(kind, time, extra, { pr: null });
const review = (id: number, time: string, headSha: string, state = "APPROVED") => ghRecord("reviewed", time, { id: `gh:a11ign/a11ign#${PR}:reviewed:${id}:${headSha}`, state, headSha, actor: "external-reviewer" });
const run = (id: number, name: string, started: string, completed: string, headSha: string, conclusion = "success") => ghRecord("ci_run", completed ?? started, {
  id: `gh:a11ign/a11ign#${PR}:ci_run:${id}:${completed ? "completed" : "in_progress"}`, name, status: completed ? "completed" : "in_progress", state: completed ? conclusion : null,
  startedAt: at(started), completedAt: completed ? at(completed) : null, headSha });
const tokens = { input: 10, output: 20, cacheRead: 1000, cacheWrite5m: 0, cacheWrite1h: 0 };
const turn = (session: string, start: string, end: string, costUsd: number|null, extra = {}) => ({ id: `turn:${session}:${end}`, kind: "turn", source: "transcript", at: at(end), session, row: REPO_ROW, pr: null, ...base,
  model: costUsd === null ? "mystery-model" : "claude-sonnet-5-5", tokens, costUsd, wallClockMs: at(end) - at(start), ...extra });
const wake = (time: string, session: string, causeKey: string, extra = {}) => ({ id: `wake:${session}:${time}`, kind: "wake", source: "wake-ledger", at: at(time), session, row: null, pr: null, ...base, causeKey, deliveryLagMs: null, ...extra });

/**
 * waterfall.test.ts's ordinary row, with what a swimlane needs added: the turns carry their cause, the orchestrator's order is deferred for a busy seat 11:32-11:41 and delivered AGAIN (a repeat),
 * the draft is approved 11:30 and marked ready 11:50 (the INFERRED wait, on the orchestrator the orders went to), a second review at one head, a re-queue at one head, a CI re-run, a compaction,
 * and a turn by a session with no lane.
 */
const ROW = [
  rowEvent("filed", "10:00:00", { actor: "product-manager" }),
  rowEvent("claimed", "10:30:00", { claimant: "worker-9001", actor: "a11ign-ai-workers" }),
  { id: "deferral:worker-9001:1", kind: "deferral", source: "deferral-log", at: at("10:35:00"), session: "worker-9001", row: REPO_ROW, pr: null, ...base, causeKey: ORDER_KEY,
    startedAt: at("10:30:00"), completedAt: at("10:35:00"), how: "delivered" },
  wake("10:40:00", "worker-9001", ORDER_KEY, { row: REPO_ROW }),
  turn("worker-9001", "10:40:00", "10:40:30", 0.1, { cause: ORDER_KEY }),
  turn("worker-9001", "10:50:00", "11:10:00", 0.5, { cause: ORDER_KEY }),
  turn("worker-9001", "11:15:00", "11:19:30", null, { cause: ORDER_KEY }),
  ghRecord("head_moved", "11:19:00", { headSha: H1, actor: null }),
  ghRecord("opened", "11:20:00"),
  ghRecord("labeled", "11:22:00", { name: "pr:hold" }), ghRecord("unlabeled", "11:24:00", { name: "pr:hold" }),
  run(1, "lint", "11:20:30", "11:28:00", H1), run(2, "test", "11:20:30", "11:27:00", H1),
  review(5001, "11:30:00", H1),
  wake("11:31:00", "orchestrator", DRAFT_KEY, { pr: PR }),
  turn("orchestrator", "11:31:00", "11:32:00", 0.2, { row: null, pr: PR, cause: DRAFT_KEY }),
  { id: "deferral:orchestrator:1", kind: "deferral", source: "deferral-log", at: at("11:41:00"), session: "orchestrator", row: null, pr: PR, ...base, causeKey: DRAFT_KEY,
    startedAt: at("11:32:00"), completedAt: at("11:41:00"), how: "delivered" },
  wake("11:41:00", "orchestrator", DRAFT_KEY, { pr: PR }),
  turn("orchestrator", "11:41:00", "11:42:00", 0.2, { row: null, pr: PR, cause: DRAFT_KEY }),
  turn("worker-tooling", "11:43:00", "11:44:00", 0.3, { row: null, pr: PR }),
  ghRecord("ready_for_review", "11:50:00"),
  ghRecord("head_moved", "12:00:00", { headSha: H2, actor: null }),
  turn("worker-9001", "12:00:00", "12:01:00", 0.05, { cause: ORDER_KEY }),
  { id: "compaction:worker-9001:1", kind: "compaction", source: "transcript", at: at("12:02:00"), session: "worker-9001", row: REPO_ROW, pr: null, ...base },
  run(3, "lint", "12:00:30", "12:10:00", H2), run(4, "test", "12:00:30", "12:15:00", H2), run(6, "test", "12:00:33", "12:14:00", H2), run(5, "lint", "12:16:30", "12:17:30", H2),
  review(5002, "12:20:00", H2), review(5003, "12:25:00", H2),
  ghRecord("added_to_merge_queue", "12:30:00", { id: "gh:a11ign/a11ign#9100:added_to_merge_queue:q1" }),
  ghRecord("removed_from_merge_queue", "12:35:00", { outcome: "unmerged" }),
  ghRecord("added_to_merge_queue", "12:40:00", { id: "gh:a11ign/a11ign#9100:added_to_merge_queue:q2" }),
  ghRecord("removed_from_merge_queue", "12:50:00", { outcome: "merged", id: "gh:a11ign/a11ign#9100:removed_from_merge_queue:end" }),
  ghRecord("merged", "12:50:00", { actor: "merge-queue" }), ghRecord("closed", "12:50:00"),
  rowEvent("closed", "12:50:05"),
];

const page = swimlane({ events: ROW, now: NOW, title: "row #9001" });
const wf = waterfall({ events: ROW, now: NOW });

// A page is parsed by the shapes this renderer writes: every element the assertions read carries a `class` or a `data-` attribute the renderer sets, and the parser is two regexes.
const groups = (html: string, className: string) => [...html.matchAll(new RegExp(`<g class="${className}[^"]*"[^>]*>.*?</g>`, "gs"))].map((match) => match[0]);
const attr = (element: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(element)?.[1];
const title = (element: string) => /<title>(.*?)<\/title>/s.exec(element)?.[1].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const width = (element: string) => Number(/<rect [^>]*width="([\d.]+)"/.exec(element)?.[1]);
const laneNames = (html: string) => [...html.matchAll(/<g class="lane" data-lane="([^"]*)"/g)].map((match) => match[1]);
const bars = (html: string) => groups(html, "bar");
const waits = (html: string) => groups(html, "wait");

test("LANES: one per actor the chairman named, and no other: a session with no lane is counted, never given one", () => {
  assert.deepEqual(laneNames(page), ["gate", "product-manager", "ceo", "orchestrator", "worker-9001", "reviewer-9100", "CI", "merge queue"]);
  assert.ok(!laneNames(page).includes("worker-tooling"), "worker-tooling is not a lane in the list");
  assert.match(page, /Turns by sessions that have no lane here, not drawn: worker-tooling \(1\)/);
  assert.equal(laneOf("worker-tooling"), null);
  assert.equal(laneOf("worker-3512"), "worker-3512");
  assert.equal(laneOf("reviewer-3512"), "reviewer-3512");
  assert.deepEqual(lanesOf([]), ["gate", "product-manager", "ceo", "orchestrator", "CI", "merge queue"], "the four a reader looks for, and CI and the queue, are always there; numbered lanes only when something is on them");
  assert.deepEqual(lanesOf(["worker-12", "worker-9", "reviewer-3"]), ["gate", "product-manager", "ceo", "orchestrator", "worker-9", "worker-12", "reviewer-3", "CI", "merge queue"], "numbered lanes in numeric order");
});

test("BARS: a bar per turn on its own session's lane, each carrying its cost, cause and model as text, and a turn with no price is not the cheapest colour", () => {
  const turns = bars(page).filter((bar) => attr(bar, "data-kind") === "turn");
  assert.equal(turns.length, ROW.filter((event) => event.kind === "turn").length - 1, "every turn but worker-tooling's");
  const priced = turns.find((bar) => attr(bar, "id") === "bar-turn:worker-9001:11:10:00");
  assert.equal(attr(priced, "data-lane"), "worker-9001");
  assert.match(title(priced), /^\$0\.5000 engineers\/ready-row-unclaimed\/9001 claude-sonnet-5-5\n10:50:00-11:10:00 \(20m00s\)/);
  assert.match(priced, /class="bar turn cost5"/, "the dearest turn of the row is the darkest step");
  const unpriced = turns.find((bar) => attr(bar, "id") === "bar-turn:worker-9001:11:19:30");
  assert.match(title(unpriced), /^\$\? engineers\/ready-row-unclaimed\/9001 mystery-model/);
  assert.match(unpriced, /class="bar turn cost0"/, "no price is grey and says $?, never the cheapest step");
  const cheap = turns.find((bar) => attr(bar, "id") === "bar-turn:worker-9001:12:01:00");
  assert.match(cheap, /class="bar turn cost1"/);
  assert.ok(width(priced) > width(cheap), "a 20-minute turn is wider than a 1-minute one: the axis is linear");
  assert.equal(bars(page).filter((bar) => attr(bar, "data-lane") === "CI").length, 6, "a bar per check-run");
  assert.equal(bars(page).filter((bar) => attr(bar, "data-lane") === "merge queue").length, 2, "a bar per queue entry");
});

test("WAITS: a hatched segment per recorded wait, with its source as text, and the approved draft INFERRED, on the session it waited on", () => {
  const hatched = waits(page);
  const deferred = hatched.find((wait) => attr(wait, "data-lane") === "orchestrator" && attr(wait, "data-source") === "deferral-log");
  assert.match(title(deferred), /^order orchestrator\/draft-convinced-not-ready\/pr-9100\/caf5b440 deferred for busy orchestrator \(delivered\)\n11:32:00-11:41:00 \(9m00s\) \[deferral-log\]/);
  assert.match(deferred, /fill="url\(#hatch\)"/, "hatched");
  const inferred = hatched.find((wait) => attr(wait, "data-source") === "approved-draft");
  assert.equal(attr(inferred, "data-lane"), "orchestrator", "waiting on the session the orders about it went to");
  assert.match(inferred, /class="wait inferred"/);
  assert.match(title(inferred), /^INFERRED\. approved draft #9100 not yet marked ready, waiting on orchestrator\n11:30:00-11:50:00 \(20m00s\) \[approved-draft\]/);
  assert.ok(hatched.some((wait) => attr(wait, "data-source") === "label" && /label pr:hold on/.test(title(wait))), "a hold is named");
  assert.ok(hatched.some((wait) => attr(wait, "data-source") === "review" && /waiting for a review: opened -> review/.test(title(wait))), "a review not yet posted is the waterfall's review run");
  const table = page.slice(page.indexOf("<h2>Waits</h2>"), page.indexOf("<h2>Repeats</h2>"));
  assert.match(table, /<span class="inferred-mark">INFERRED<\/span> approved draft #9100 not yet marked ready, waiting on orchestrator/, "the table says it in words too");
  assert.match(table, /review \S+ APPROVED by external-reviewer at 2026-10-04 11:30:00 at head 1111111/, "and carries the waterfall's evidence for it");
});

test("WAITS: the words of the inferred wait are the waterfall's own, so the page cannot say another thing about it", () => {
  const theirs = wf.phases.flatMap((phase) => phase.waits).find((wait) => wait.source === "approved-draft");
  assert.equal(theirs.inferred, true);
  assert.match(title(waits(page).find((wait) => attr(wait, "data-source") === "approved-draft")), new RegExp(theirs.label.replace(/[.*+?^${}()|[\]\\#]/g, "\\$&")));
});

test("AXIS: time is linear, so a wait is as wide as it was long", () => {
  const first = waits(page).find((wait) => attr(wait, "data-source") === "deferral-log" && attr(wait, "data-lane") === "worker-9001");
  const second = waits(page).find((wait) => attr(wait, "data-source") === "approved-draft");
  assert.ok(Math.abs(width(second) / width(first) - 20 / 5) < 0.01, `20 minutes over 5 minutes is 4x, got ${width(second) / width(first)}`);
});

test("ARROWS: one per order joined to the turn it woke, and none for an order that woke nothing", () => {
  const arrows = [...page.matchAll(/<line class="arrow" data-order="([^"]*)" data-turn="([^"]*)"/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(arrows, [
    ["wake:worker-9001:10:40:00", "turn:worker-9001:10:40:30"],
    ["wake:orchestrator:11:31:00", "turn:orchestrator:11:32:00"],
    ["wake:orchestrator:11:41:00", "turn:orchestrator:11:42:00"],
  ]);
  const lonely = swimlane({ events: [...ROW, wake("12:55:00", "worker-9001", "engineers/never-answered")], now: NOW, title: "row #9001" });
  assert.equal([...lonely.matchAll(/<line class="arrow"/g)].length, 3, "an order with no turn after it has a marker on the gate lane and no arrow");
  assert.equal(bars(lonely).filter((bar) => attr(bar, "data-kind") === "order").length, 4);
});

test("REPEATS: every repeat the waterfall found is outlined in red on its bar, and nothing else is", () => {
  const outlined = bars(page).filter((bar) => / repeat"/.test(bar.slice(0, bar.indexOf(">")))).map((bar) => attr(bar, "data-repeat"));
  const kinds = wf.repeats.map((repeat) => repeat.kind);
  assert.deepEqual([...new Set(kinds)].sort(), ["CI re-run at the same head", "compaction", "re-queue at the same head", "re-wake with the same cause key", "second review at the same head"],
    "the fixture holds one of each repeat kind: if the waterfall stops finding one, this test stops proving the outline for it");
  assert.deepEqual(outlined.sort(), kinds.sort(), "one outlined bar per repeat, of the repeat's kind");
  const rewake = bars(page).find((bar) => attr(bar, "data-repeat") === "re-wake with the same cause key");
  assert.equal(attr(rewake, "id"), "bar-wake:orchestrator:11:41:00", "the SECOND delivery is outlined, not the first");
  assert.match(title(rewake), /REPEAT: re-wake with the same cause key: orchestrator: /);
  assert.match(page, /\.bar\.repeat rect\{stroke:var\(--repeat\)/, "and the outline is red, in the stylesheet that draws it");
  const calm = bars(page).filter((bar) => attr(bar, "data-repeat") === undefined);
  assert.ok(calm.length > 0 && calm.every((bar) => !/ repeat"/.test(bar.slice(0, bar.indexOf(">")))), "a bar with no repeat has no outline");
});

test("REPEATS: the page lists them in words, with their evidence, so the red is not the only channel", () => {
  const section = page.slice(page.indexOf("<h2>Repeats</h2>"), page.indexOf("<h2>Every bar</h2>"));
  for (const repeat of wf.repeats) assert.ok(section.includes(repeat.kind), repeat.kind);
  assert.match(page, /<td>[^<]*<span class="red">REPEAT: second review at the same head<\/span>/, "and in the table of bars");
});

/** What would make a page not self-contained: anything the browser would fetch, or any script. */
const FETCHES = /<script|<link|<img|<iframe|<object|<embed|\ssrc=|\shref=|@import|\bhttps?:\/\//i;

test("SELF-CONTAINED: nothing in the page is fetched, and nothing in it runs", () => {
  assert.equal(page.match(FETCHES), null, `found ${page.match(FETCHES)?.[0]}`);
  assert.match(page, /^<!doctype html>\n<html lang="en">/);
  assert.equal(page.split("<style>").length, 2, "one inline stylesheet");
  assert.match(page, /<svg [^>]*role="img"/);
});

test("SELF-CONTAINED: the check finds what it is looking for (a positive control, in both directions)", () => {
  for (const bad of ['<script src="x.js"></script>', '<link rel="stylesheet" href="x.css">', '<img src="a.png">', "<style>@import url(x.css)</style>", "<a>https://example.com</a>", "<p>http://example.com</p>"]) {
    assert.ok(FETCHES.test(bad), bad);
  }
  assert.ok(!FETCHES.test(page.replace(/<style>.*?<\/style>/s, "")), "and it does not fire on the page");
});

test("ESCAPING: text from an event is text, never markup, and a link in it is not fetched", () => {
  const hostile = [...ROW, wake("12:56:00", "worker-9001", "<script>alert(1)</script>"), turn("worker-9001", "12:56:00", "12:57:00", 1, { cause: '"><img src=x onerror=1> https://example.com/x', model: "m<b>" })];
  const html = swimlane({ events: hostile, now: NOW, title: "row <#9001>" });
  assert.ok(!html.includes("<script>alert"), "the title and the cause are escaped");
  assert.ok(!html.includes("<img src=x"), "an attribute cannot be left");
  assert.ok(!html.includes("<b>"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("row &lt;#9001&gt;"));
});

test("EMPTY: a row the store has nothing on is one page that says so, not a crash and not a blank", () => {
  const html = swimlane({ events: [], now: NOW, title: "row #1" });
  assert.match(html, /No record in the store names this row: nothing to draw \(widen --since\)/);
  assert.deepEqual(laneNames(html), ["gate", "product-manager", "ceo", "orchestrator", "CI", "merge queue"]);
  assert.equal(html.match(FETCHES), null);
});

test("OPEN: a run still going is drawn to the reading, and the page says OPEN", () => {
  const open = ROW.filter((event) => !["merged", "closed"].includes(event.kind) && event.kind !== "removed_from_merge_queue" || event.id.includes(":q"));
  const html = swimlane({ events: open.filter((event) => event.id !== "gh:a11ign/a11ign#9100:removed_from_merge_queue:end"), now: NOW, title: "row #9001" });
  assert.match(html, /to OPEN UTC/);
  const queued = bars(html).filter((bar) => attr(bar, "data-lane") === "merge queue");
  assert.match(title(queued.at(-1)), /still queued/);
  assert.match(title(queued.at(-1)), /12:40:00-13:30:00/, "to the reading, 13:30");
});

test("THE CHAIRMAN'S READING of #3406: the wait between the approval and the ready mark is one hatched segment as wide as it was long, naming who it waited on", () => {
  const inferred = waits(page).find((wait) => attr(wait, "data-source") === "approved-draft");
  assert.match(title(inferred), /11:30:00-11:50:00 \(20m00s\)/);
  assert.match(title(inferred), /waiting on orchestrator/);
  assert.match(inferred, /INFERRED: approved/, "its text is on the segment as far as it fits, and in full in the title and the table");
});
