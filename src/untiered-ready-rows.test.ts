// no-token: gh -- every read here goes through a fake tracker reader; `ghReadyReader` is only constructed with a fake `run`, so no `gh` call is made.
// a11ign/agent-org#466 (epic a11ign/a11ign#4437, move 4): the retrospective's NUMBER of `ready` rows with no tier decision. Each fixture has its negative control:
// the label takes a row out, so does a `Tier: sonnet -- <reason>` line in the body or a comment, an EMPTY reason does not, an excluded row is listed apart and not
// counted, a second tracker is read, and a tracker that cannot be read makes the number `unknown`, never 0.
import test from "node:test";
import assert from "node:assert/strict";
import { untieredReadyRows, untieredLines, ghReadyReader, hasTierDecision, ROW_LIST_LIMIT, LISTED_ROWS } from "./untiered-ready-rows.ts";
import { buildReport, renderReport } from "./org-retro.ts";

const NOW = Date.parse("2026-10-09T10:30:00Z");

/** A `ready` row with no decision and no excluding label: the shape the count exists for. */
const BARE = Object.freeze({
  number: 466, title: "A mechanical row", body: "## What it is\n\nNothing about a tier.\n",
  labels: ["ready", "lane:any"].map((name) => ({ name })), comments: [{ body: "claimed" }],
});
const withLabel = (name: string, row: any = BARE) => ({ ...row, labels: [...row.labels, { name }] });
const withBody = (extra: string, row: any = BARE) => ({ ...row, body: `${row.body}\n${extra}\n` });
const withComment = (body: string, row: any = BARE) => ({ ...row, comments: [...row.comments, { body }] });

/** A tracker reader over `rows`; `rows` that is an Error is a refused read. */
const tracker = (rows: any, key = "", repo = "a11ign/a11ign") => ({
  key, repo,
  listRows: () => {
    if (rows instanceof Error) throw rows;
    return rows;
  },
});
const reading = (rows: any[]) => untieredReadyRows({ trackers: [tracker(rows)] });
const numbersOf = (ready: any) => (ready.status === "read" ? ready.rows.map((r: any) => r.number) : ready);
const apartOf = (ready: any) => (ready.status === "read" ? ready.apart.map((r: any) => r.number) : ready);

test("positive control: a ready row with neither the label nor the line is counted, and the population is not empty", () => {
  const rows = [BARE];
  assert.ok(rows.length > 0, "the fixture population is non-empty, so an empty answer cannot pass for 'every row has decided'");
  const ready = reading(rows);
  assert.equal(ready.status, "read");
  assert.equal((ready as any).count, 1);
  assert.deepEqual(numbersOf(ready), [466]);
  assert.match(untieredLines(ready)[0], /: 1: first 1: #466$/);
});

test("negative control: the same row with `tier:haiku` is not counted", () => {
  assert.deepEqual(numbersOf(reading([withLabel("tier:haiku")])), []);
});

test("negative control: the same row with a `Tier: sonnet -- <reason>` line in its body, or in a comment, is not counted", () => {
  const line = "Tier: sonnet -- touches the claim path, which Haiku is refused";
  assert.deepEqual(numbersOf(reading([withBody(line)])), [], "in the body");
  assert.deepEqual(numbersOf(reading([withComment(line)])), [], "in a comment");
  assert.deepEqual(numbersOf(reading([withComment(`${line}\r\nMore.\r\n`)])), [], "in a comment GitHub stored with CRLF line ends");
  assert.deepEqual(numbersOf(reading([withComment("Looks fine.\n\n  tier: Sonnet -- needs a read of five files")])), [], "indented, and in another case");
});

test("a `Tier: sonnet --` with an EMPTY reason is counted, in the body and in a comment", () => {
  for (const empty of ["Tier: sonnet --", "Tier: sonnet --   ", "Tier: sonnet -- \r"]) {
    assert.deepEqual(numbersOf(reading([withBody(empty)])), [466], `${JSON.stringify(empty)} in the body is a decision nobody made`);
    assert.deepEqual(numbersOf(reading([withComment(empty)])), [466], `${JSON.stringify(empty)} in a comment is a decision nobody made`);
  }
});

test("a tier line that is not a line OPENING the form is not a decision: quoted in a fence, mid-sentence, or without the separator", () => {
  assert.deepEqual(numbersOf(reading([withBody("```\nTier: sonnet -- a reason\n```")])), [466], "inside a code fence");
  assert.deepEqual(numbersOf(reading([withBody("Say `Tier: sonnet -- reason` on the row.")])), [466], "inline, mid-line");
  assert.deepEqual(numbersOf(reading([withBody("Tier: sonnet because it is hard")])), [466], "no `--` separator");
  assert.deepEqual(numbersOf(reading([withBody("Tier: opus -- hard")])), [466], "another tier is not this decision");
  assert.deepEqual(numbersOf(reading([withBody("```\nx\n```\nTier: sonnet -- after the fence closed")])), [], "a line AFTER a closed fence is a line");
});

test("`hasTierDecision` agrees with the count on each of the forms, so one reader names the decision", () => {
  assert.equal(hasTierDecision(BARE), false);
  assert.equal(hasTierDecision(withLabel("tier:haiku")), true);
  assert.equal(hasTierDecision(withBody("Tier: sonnet -- why")), true);
});

test("a row that is not `ready` is not counted", () => {
  const notReady = { ...BARE, labels: [{ name: "backlog" }] };
  assert.deepEqual(numbersOf(reading([notReady])), []);
});

test("lane:ceo, lane:orchestrator, needs:chairman and hold:* rows are listed apart and not counted; a decided excluded row is neither", () => {
  const excluded = [
    { ...withLabel("lane:ceo"), number: 1 },
    { ...withLabel("lane:orchestrator"), number: 2 },
    { ...withLabel("needs:chairman"), number: 3 },
    { ...withLabel("hold:ceo"), number: 4 },
  ];
  const ready = reading([...excluded, { ...BARE, number: 5 }, { ...withLabel("tier:haiku", withLabel("lane:ceo")), number: 6 }]);
  assert.deepEqual(numbersOf(ready), [5], "only the unexcluded, undecided row is counted");
  assert.deepEqual(apartOf(ready), [1, 2, 3, 4], "the excluded rows with no decision are listed apart; #6 carries a decision and is neither");
  assert.equal((ready as any).count, 1);
  const line = untieredLines(ready)[0];
  assert.match(line, /: 1: first 1: #5; listed apart, not counted \(lane:ceo, lane:orchestrator, needs:chairman or hold:\*\): #1, #2, #3, #4$/);
});

test("rows of a SECOND tracker are read, and named by its key so the two row 7s are not one", () => {
  const first = tracker([{ ...BARE, number: 7 }], "", "a11ign/a11ign");
  const second = tracker([{ ...BARE, number: 7 }, { ...withLabel("tier:haiku"), number: 8 }], "agent-org", "a11ign/agent-org");
  const ready = untieredReadyRows({ trackers: [first, second] });
  assert.equal((ready as any).count, 2);
  assert.deepEqual((ready as any).rows.map((r: any) => r.name), ["#7", "agent-org#7"]);
  assert.match(untieredLines(ready)[0], /: 2: first 2: #7, agent-org#7$/);
  const onlyFirst = untieredReadyRows({ trackers: [first] });
  assert.equal((onlyFirst as any).count, 1, "control: the second tracker's row is not in the first's list");
});

test("a tracker that cannot be read makes the number `unknown`, naming it, and never 0, even when another is readable and empty", () => {
  const readable = tracker([], "", "a11ign/a11ign");
  const refused = tracker(new Error("HTTP 502\nsecond line"), "agent-org", "a11ign/agent-org");
  const ready = untieredReadyRows({ trackers: [readable, refused] });
  assert.equal(ready.status, "unknown");
  assert.deepEqual((ready as any).reads, ["the ready rows of a11ign/agent-org (HTTP 502)"]);
  assert.match(untieredLines(ready)[0], /: unknown \(could not read the ready rows of a11ign\/agent-org \(HTTP 502\)\)$/);
  assert.doesNotMatch(untieredLines(ready)[0], /: 0/);
  assert.equal(untieredReadyRows({ trackers: [readable] }).status, "read", "control: the readable tracker alone reads, and says 0");
  assert.match(untieredLines(untieredReadyRows({ trackers: [readable] }))[0], /: 0$/);
});

test("unknown names EVERY unreadable tracker, not the first", () => {
  const ready = untieredReadyRows({ trackers: [tracker(new Error("a"), "", "x/one"), tracker(new Error("b"), "two", "x/two")] });
  assert.deepEqual((ready as any).reads, ["the ready rows of x/one (a)", "the ready rows of x/two (b)"]);
});

test("no declared tracker, a list at its limit and a row with no labels or comments field are each `unknown`", () => {
  assert.equal(untieredReadyRows({ trackers: [] }).status, "unknown", "no tracker is not an empty stock");
  const full = Array.from({ length: ROW_LIST_LIMIT }, (_, i) => ({ ...BARE, number: i + 1 }));
  assert.equal(reading(full).status, "unknown", "a list at its limit may be cut short");
  assert.equal(reading(full.slice(1)).status, "read", "control: one row under the limit is a whole list");
  const noComments: any = { ...BARE, number: 9 };
  delete noComments.comments;
  assert.match((reading([noComments]) as any).reads[0], /the comments of #9 in a11ign\/a11ign/);
  const noLabels: any = { ...BARE, number: 10 };
  delete noLabels.labels;
  assert.match((reading([noLabels]) as any).reads[0], /the labels of #10/);
});

test("an absent reading is `unknown`, and the line says the trackers were not read", () => {
  assert.match(untieredLines(null)[0], /: unknown \(the trackers were not read\)$/);
  assert.match(untieredLines(undefined)[0], /: unknown/);
});

test("the line gives the FIRST TEN numbers and counts the rest", () => {
  const rows = Array.from({ length: LISTED_ROWS + 3 }, (_, i) => ({ ...BARE, number: 100 + i }));
  const line = untieredLines(reading(rows))[0];
  assert.match(line, new RegExp(`: ${LISTED_ROWS + 3}: first ${LISTED_ROWS}: #100, #101, #102, #103, #104, #105, #106, #107, #108, #109, and 3 more$`));
  assert.doesNotMatch(line, /#110/);
});

test("`ghReadyReader` asks the tracker for its open `ready` rows with the fields read, and a refusal throws to be named", () => {
  const asked: string[][] = [];
  const reader = ghReadyReader({ key: "agent-org", repo: "a11ign/agent-org" }, (args) => {
    asked.push(args);
    return JSON.stringify([BARE]);
  });
  assert.equal(reader.key, "agent-org");
  assert.deepEqual(reader.listRows().map((r) => r.number), [466]);
  const args = asked[0].join(" ");
  assert.match(args, /--repo a11ign\/agent-org/);
  assert.match(args, /--state open/);
  assert.match(args, /--label ready/);
  assert.match(args, /--json number,title,body,labels,comments/);
  const refusing = ghReadyReader({ key: "", repo: "a11ign/a11ign" }, () => { throw new Error("gh: rate limited"); });
  assert.equal(untieredReadyRows({ trackers: [refusing] }).status, "unknown");
});

test("the retrospective prints the line, and a refused or unmade read prints `unknown`", () => {
  const base: any = { merged: [], openPrs: [], journal: null, ledger: null, turns: null, handFixes: null };
  const counted = buildReport({ ...base, untiered: reading([BARE, { ...BARE, number: 467 }]) }, NOW);
  assert.match(renderReport(counted), /Ready rows with no tier decision[^\n]*: 2: first 2: #466, #467/);
  const refused = buildReport({ ...base, untiered: untieredReadyRows({ trackers: [tracker(new Error("boom"))] }) }, NOW);
  assert.match(renderReport(refused), /Ready rows with no tier decision[^\n]*: unknown \(could not read the ready rows of a11ign\/a11ign \(boom\)\)/);
  const unread = buildReport(base, NOW);
  assert.match(renderReport(unread), /Ready rows with no tier decision[^\n]*: unknown \(the trackers were not read\)/);
});
