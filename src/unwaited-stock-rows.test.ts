// no-token: gh -- every read here goes through a fake tracker reader; `ghTrackerReader` is only constructed with a fake `run`, so no `gh` call is made.
// #4175: the retrospective's NUMBER of backlog or parked rows with no wait that moves them. Each wait takes the fixture out, each of its lapsed forms
// does not, the age is the stock label's and a comment does not move it, and a refused read is `unknown` and names itself.
import test from "node:test";
import assert from "node:assert/strict";
import { unwaitedStockRows, unwaitedLines, ghTrackerReader, UNWAITED_AFTER_MS, ROW_LIST_LIMIT } from "./unwaited-stock-rows.ts";
import { buildReport, renderReport, NUMBERS, undeclaredDirections } from "./org-retro.ts";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-08T18:00:00Z");
const ago = (hours) => new Date(NOW - hours * HOUR).toISOString();

/** #4122 as read at 17:00Z on 2026-10-08: `backlog`, `out-of-release`, `lane:ceo`, `found-by-chairman`, no `answer:*`, no open edge, no wait line. */
const ROW_4122 = Object.freeze({
  number: 4122, title: "A row the chairman found", body: "## What it is\n\nNothing waits on this.\n",
  labels: ["backlog", "out-of-release", "lane:ceo", "found-by-chairman"].map((name) => ({ name })), blockedBy: { nodes: [] },
});

const labeled = (label, at) => ({ event: "labeled", created_at: at, label: { name: label } });

/** A reader over `rows`, with `timelines` keyed by row number; a row with no entry throws, so a timeline read nobody expected is loud. */
function readerOf(rows, timelines) {
  const timelineReads = [];
  return {
    timelineReads,
    listRows: () => rows,
    timeline: (number) => {
      timelineReads.push(number);
      if (!(number in timelines)) throw new Error(`no timeline for #${number}`);
      const t = timelines[number];
      if (t instanceof Error) throw t;
      return t;
    },
  };
}

const TIMELINE_4122 = [{ event: "created", created_at: ago(30) }, labeled("backlog", ago(26)), labeled("lane:ceo", ago(26))];
const reading = (rows, timelines = { 4122: TIMELINE_4122 }) => unwaitedStockRows({ reader: readerOf(rows, timelines), now: NOW });
const numbersOf = (stock) => (stock.status === "read" ? stock.rows.map((r) => r.number) : stock);
const withBody = (extra) => ({ ...ROW_4122, body: `${ROW_4122.body}\n${extra}\n` });
const withLabel = (name) => ({ ...ROW_4122, labels: [...ROW_4122.labels, { name }] });

test("positive control: #4122's shape is NAMED and the number counts it, and the population is not empty", () => {
  const rows = [ROW_4122];
  assert.ok(rows.length > 0, "the fixture population is non-empty, so an empty answer cannot pass for 'no unwaited rows'");
  const stock = reading(rows);
  assert.equal(stock.status, "read");
  assert.equal(stock.count, 1);
  assert.deepEqual(numbersOf(stock), [4122]);
  assert.equal(stock.rows[0].state, "backlog");
  assert.equal(stock.rows[0].since, Date.parse(ago(26)));
  assert.match(unwaitedLines(stock)[0], /: 1: #4122 \(backlog since 2026-10-07T16:00Z\)$/);
});

test("each of the four waits, added to the same fixture, takes it out of the number", () => {
  const waits = {
    "an answer:* label": withLabel("answer:ceo"),
    "an OPEN blocked-by edge": { ...ROW_4122, blockedBy: { nodes: [{ number: 4081, state: "OPEN" }] } },
    "a Waiting-for: line": withBody("Waiting-for: closed #4081"),
    "a Waits-on-done-when: line": withBody("Waits-on-done-when: 3778.1"),
    "a FUTURE Not-before: date": withBody("Not-before: 2026-10-20"),
    "a FUTURE Not-before: hour": withBody("Not-before: 2026-10-08T20:00:00Z"),
  };
  for (const [name, row] of Object.entries(waits)) {
    assert.deepEqual(numbersOf(reading([row])), [], `${name} is a wait that moves the row`);
  }
});

const SENTENCE = "Waiting-for: ceo's dispatched run ... ends";
/** #4090 as the order read it: `parked`, labelled 34 hours before the reading, parked on a sentence outside the grammar and nothing else. */
const ROW_4090 = Object.freeze({ ...ROW_4122, number: 4090, labels: [{ name: "parked" }], body: `## What it is\n\n${SENTENCE}\n` });
const TIMELINE_4090 = { 4090: [labeled("parked", ago(34))] };
const withSentence = (extra) => ({ ...ROW_4090, body: `${ROW_4090.body}\n${extra}\n` });

test("#4237 positive control: a row parked on a SENTENCE is counted and named with `unreadable wait`, and the population is not empty", () => {
  const rows = [ROW_4090];
  assert.ok(rows.length > 0, "the fixture population is non-empty, so an empty answer cannot pass for 'no unwaited rows'");
  const stock = reading(rows, TIMELINE_4090);
  assert.deepEqual(numbersOf(stock), [4090]);
  assert.equal(stock.rows[0].unreadableWait, true);
  assert.match(unwaitedLines(stock)[0], /: 1: #4090 \(parked since 2026-10-07T08:00Z, unreadable wait\)$/);
  assert.doesNotMatch(unwaitedLines(reading([ROW_4122]))[0], /unreadable wait/, "a row with no wait line at all is not blamed on a sentence");
});

test("#4237: the same fixture with the sentence replaced by each READABLE form, or by `manual`, is not counted", () => {
  const readable = ["closed #4081", "merged a11ign/agent-org#401", "labelled ready #4081", "unlabelled hold:ceo #4081", "published agent-org@next", "tagged v0.85.8", "manual"];
  for (const form of readable) {
    const row = { ...ROW_4090, body: `Waiting-for: ${form}\n` };
    assert.deepEqual(numbersOf(reading([row], TIMELINE_4090)), [], `Waiting-for: ${form} is a wait`);
  }
});

test("#4237: the sentence KEPT beside a real wait is not counted, and beside a wait that ended it is", () => {
  const live = {
    "an OPEN blocked-by edge": { ...ROW_4090, blockedBy: { nodes: [{ number: 4081, state: "OPEN" }] } },
    "an answer:* label": { ...ROW_4090, labels: [...ROW_4090.labels, { name: "answer:ceo" }] },
    "a FUTURE Not-before:": withSentence("Not-before: 2026-10-20"),
    "a readable Waiting-for: line": withSentence("Waiting-for: closed #4081"),
  };
  for (const [name, row] of Object.entries(live)) assert.deepEqual(numbersOf(reading([row], TIMELINE_4090)), [], `${name} still moves the row`);
  const ended = {
    "a CLOSED edge": { ...ROW_4090, blockedBy: { nodes: [{ number: 4081, state: "CLOSED" }] } },
    "a PAST Not-before:": withSentence("Not-before: 2026-10-01"),
  };
  for (const [name, row] of Object.entries(ended)) {
    const stock = reading([row], TIMELINE_4090);
    assert.deepEqual(numbersOf(stock), [4090], `${name} has ended, so the sentence is all that is left`);
    assert.equal(stock.rows[0].unreadableWait, true);
  }
});

test("#4237: a Waiting-for: sentence inside a code fence is not a line, so that fixture has none and is not named for one", () => {
  const stock = reading([{ ...ROW_4090, body: `\`\`\`\n${SENTENCE}\n\`\`\`\n` }], TIMELINE_4090);
  assert.deepEqual(numbersOf(stock), [4090]);
  assert.equal(stock.rows[0].unreadableWait, false);
  assert.doesNotMatch(unwaitedLines(stock)[0], /unreadable wait/);
});

test("#4237: Waits-on-done-when: stays counted as a wait beside a sentence", () => {
  assert.deepEqual(numbersOf(reading([withSentence("Waits-on-done-when: 3778.1")], TIMELINE_4090)), []);
});

test("a CLOSED edge and a PAST Not-before are waits that ended, so they count as none", () => {
  const closedEdge = { ...ROW_4122, blockedBy: { nodes: [{ number: 4081, state: "CLOSED" }] } };
  assert.deepEqual(numbersOf(reading([closedEdge])), [4122]);
  for (const past of ["Not-before: 2026-10-01", "Not-before: 2026-10-08", "Not-before: 2026-10-08T17:00:00Z"]) {
    assert.deepEqual(numbersOf(reading([withBody(past)])), [4122], `${past} has passed at ${new Date(NOW).toISOString()}`);
  }
});

test("a wait line quoted inside a code fence is an example, not a wait", () => {
  assert.deepEqual(numbersOf(reading([withBody("```\nWaiting-for: closed #4081\nWaits-on-done-when: 3778.1\n```")])), [4122]);
});

test("labelled 23 hours before the reading is not counted, 25 hours before is", () => {
  const at = (hours) => ({ 4122: [labeled("backlog", ago(hours))] });
  assert.equal(UNWAITED_AFTER_MS, 24 * HOUR);
  assert.deepEqual(numbersOf(reading([ROW_4122], at(23))), []);
  assert.deepEqual(numbersOf(reading([ROW_4122], at(25))), [4122]);
});

test("a comment added to the fixture does not reset its age, and neither does createdAt", () => {
  const commented = [...TIMELINE_4122, { event: "commented", created_at: ago(0.1) }, { event: "labeled", created_at: ago(0.1), label: { name: "lane:ceo" } }];
  const recentlyCreated = { ...ROW_4122, createdAt: ago(1), updatedAt: ago(0.1) };
  assert.deepEqual(numbersOf(reading([recentlyCreated], { 4122: commented })), [4122]);
});

test("the age is the NEWEST stock label the row still carries: a row that left parked and came back is aged from the return", () => {
  const parked = { ...ROW_4122, labels: [{ name: "parked" }] };
  const timeline = [labeled("parked", ago(100)), labeled("backlog", ago(50)), labeled("parked", ago(2))];
  assert.deepEqual(numbersOf(reading([parked], { 4122: timeline })), [], "returned to parked 2h ago");
  assert.deepEqual(numbersOf(reading([parked], { 4122: timeline.slice(0, 2) })), [4122], "a backlog label it no longer carries does not age it");
});

test("only open backlog or parked rows are read: a ready row is not stock, and a waited row never costs a timeline read", () => {
  const ready = { ...ROW_4122, number: 1, labels: [{ name: "ready" }] };
  const waited = { ...withLabel("answer:ceo"), number: 2 };
  const reader = readerOf([ready, waited, ROW_4122], { 4122: TIMELINE_4122 });
  assert.deepEqual(numbersOf(unwaitedStockRows({ reader, now: NOW })), [4122]);
  assert.deepEqual(reader.timelineReads, [4122]);
});

test("a reader that throws for one row's timeline makes the number unknown, and the printed line names that row", () => {
  const other = { ...ROW_4122, number: 20, labels: [{ name: "parked" }] };
  const stock = reading([ROW_4122, other], { 4122: TIMELINE_4122, 20: new Error("HTTP 502") });
  assert.equal(stock.status, "unknown");
  const line = unwaitedLines(stock)[0];
  assert.match(line, /: unknown \(could not read the timeline of #20 \(HTTP 502\)\)$/);
  assert.doesNotMatch(line, /#4122/, "the row that read fine is not blamed");
  assert.equal(NUMBERS.find((n) => n.id === "unwaitedStockRows").of({ unwaited: stock }), null, "unknown is null in the number, never 0");
});

test("a refused list, a missing edge field, a timeline with no labeled event and a full list are each unknown, and name themselves", () => {
  const refused = unwaitedStockRows({ reader: { listRows: () => { throw new Error("rate limited\nsecond line"); }, timeline: () => [] }, now: NOW });
  assert.deepEqual(refused, { status: "unknown", reads: ["the open-row list (rate limited)"] });
  const { blockedBy: _edges, ...noEdges } = ROW_4122;
  assert.deepEqual(reading([noEdges]), { status: "unknown", reads: ["the blocked-by edges of #4122"] });
  const unlabeled = reading([ROW_4122], { 4122: [{ event: "created", created_at: ago(30) }] });
  assert.equal(unlabeled.status, "unknown");
  assert.match(unlabeled.reads[0], /^the timeline of #4122 \(no `labeled` event/);
  const full = reading(Array.from({ length: ROW_LIST_LIMIT }, (_, i) => ({ ...ROW_4122, number: 5000 + i })));
  assert.equal(full.status, "unknown");
  assert.match(full.reads[0], /reached the 500 limit/);
});

test("a list with no stock rows reads 0, and says so rather than unknown", () => {
  const stock = reading([{ ...ROW_4122, labels: [{ name: "ready" }] }]);
  assert.deepEqual(stock, { status: "read", count: 0, rows: [] });
  assert.match(unwaitedLines(stock)[0], /: 0$/);
});

test("the oldest row is named first, and several are all named", () => {
  const rows = [{ ...ROW_4122, number: 2568 }, { ...ROW_4122, number: 20 }, { ...ROW_4122, number: 1740 }];
  const stock = reading(rows, { 2568: [labeled("backlog", ago(47))], 20: [labeled("backlog", ago(800))], 1740: [labeled("backlog", ago(60))] });
  assert.deepEqual(numbersOf(stock), [20, 1740, 2568]);
  assert.match(unwaitedLines(stock)[0], /: 3: #20 \(backlog since [^)]+\); #1740 \(.*\); #2568 \(/);
});

test("NUMBERS carries the new id with a declared direction, and the retrospective's printed report holds the line", () => {
  const entry = NUMBERS.find((n) => n.id === "unwaitedStockRows");
  assert.equal(entry.better, "lower");
  assert.deepEqual(undeclaredDirections({ unwaitedStockRows: 1 }), []);
  const reads = { merged: [], openPrs: [], journal: "", ledger: "", turns: [], handFixes: null, unwaited: reading([ROW_4122]) };
  const report = buildReport(reads, NOW);
  assert.equal(report.numbers.unwaitedStockRows, 1);
  const text = renderReport(report);
  assert.match(text, /^- Unwaited stock rows \(backlog or parked over 24h, no wait that moves them\): 1: #4122 \(backlog since /m);
  assert.match(text, /^- Unwaited stock rows: /m, "and the trend block trends it against yesterday");
  const unread = renderReport(buildReport({ ...reads, unwaited: null }, NOW));
  assert.match(unread, /^- Unwaited stock rows \(.*\): unknown \(the tracker was not read\)$/m);
  assert.equal(buildReport({ ...reads, unwaited: null }, NOW).numbers.unwaitedStockRows, null);
});

test("the real reader asks the tracker for the edges in the one list and projects the timeline, with no gh call here", () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    return args[0] === "issue" ? JSON.stringify([ROW_4122])
      : `${JSON.stringify({ event: "labeled", created_at: ago(30), label: { name: "backlog" } })}\n\n`;
  };
  const stock = unwaitedStockRows({ reader: ghTrackerReader("a11ign/a11ign", run), now: NOW });
  assert.deepEqual(numbersOf(stock), [4122]);
  assert.deepEqual(calls[0].slice(0, 5), ["issue", "list", "--repo", "a11ign/a11ign", "--state"]);
  assert.match(calls[0].join(" "), /--json number,title,body,labels,blockedBy/);
  assert.match(calls[1].join(" "), /^api repos\/a11ign\/a11ign\/issues\/4122\/timeline --paginate --jq /);
});
