// no-token: gh -- importing `work-gate.mjs` reaches `defaultRun` (`execFileSync("gh", ...)`), and this file never lets it run: `orgHealthNow` is handed the clock, the last merge, the fleet reading, the lab-job read, the waits and the log.
/**
 * THE PRIMARY MILESTONE HAS A CLOCK OF ITS OWN (#4231, the chairman's rule of 2026-10-08, root cause 3). The outcome clock (#3486) runs on open PRs and CLAIMED rows
 * only, so a milestone whose rows are all unclaimed, parked or date-held had no clock at all: v3 sat with open rows and nothing claimed or in a pull request for
 * hours, and the chairman found it. A primary milestone with open rows and no claim and no PR for 120 minutes is an alarm to `ceo` naming the oldest row.
 *
 * THESE TESTS RUN `orgHealthNow`, THE FUNCTION THE TICK CALLS, over the rows and pull requests the tick already reads (no call of its own: the primary milestone is
 * the `Primary: yes` line of a milestone description, which rides on the open-row read's `milestone` field). `readingOf` is the pure decider, for the two cases a tick
 * cannot show: a clear reading that says WHY, and a milestone with no open row (the tick only sees a milestone through its open rows).
 *
 * THE POSITIVE CONTROL is the first test: three open rows (parked, date-held, backlog), no claim and no PR for 121 minutes, and it offers an order naming the oldest
 * row and its state. Every "offers nothing" below is read against it, and each differs from it by ONE thing: 119 minutes, a claim, a PR, a merge 30 minutes ago, no
 * `Primary: yes`, no open row. The 120 is written out as `120`, never as `MILESTONE_CLOCK_MINUTES`, so moving the constant turns a test red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { orgHealthNow } from "../work-gate.mjs";
import * as health from "../org-health.mjs";

const MINUTE_MS = 60_000;
const NOW = Date.parse("2026-10-08T22:00:00Z");
const SUBJECT = "primary-milestone-idle";
const iso = (ms: number) => new Date(ms).toISOString();
const ago = (minutes: number) => NOW - minutes * MINUTE_MS;

const PRIMARY = { number: 10, title: "v3 — Ready for a first outside adopter", dueOn: null,
  description: "THE PRIMARY GOAL (chairman, 2026-10-08). Make a11ign adoptable.\n\nPrimary: yes" };
const ORDINARY = { number: 7, title: "Out of release", dueOn: null, description: "Rows deliberately outside every release." };

type Row = Record<string, unknown> & { number: number };
const row = (number: number, { labels = [], createdMinutesAgo, body = "", milestone = PRIMARY, blockedBy }:
  { labels?: string[]; createdMinutesAgo: number; body?: string; milestone?: unknown; blockedBy?: number[] }): Row => ({
  number, title: `row ${number}`, labels: labels.map((name) => ({ name })), body, milestone, createdAt: iso(ago(createdMinutesAgo)), updatedAt: iso(ago(1)),
  blockedBy: { nodes: (blockedBy ?? []).map((n) => ({ number: n, state: "OPEN" })) },
});

/** The three rows the row's own test names, the NEWEST opened `idle` minutes ago: parked (oldest), date-held, backlog. */
const threeRows = (idle: number, milestone: unknown = PRIMARY): Row[] => [
  row(101, { labels: ["parked", "lane:any"], createdMinutesAgo: idle + 300, milestone }),
  row(102, { labels: ["ready", "lane:any"], createdMinutesAgo: idle + 200, body: "Not-before: 2026-10-20", milestone }),
  row(103, { labels: ["backlog", "lane:any"], createdMinutesAgo: idle, milestone }),
];

/** An open pull request with every field the tick reads, declaring what it closes in its body. */
const pr = (number: number, body: string) => ({ number, isDraft: false, headRefOid: "a".repeat(40), baseRefName: "main", statusCheckRollup: [], author: { login: "a11ign-ai-workers" },
  comments: [], labels: [], files: [], changedFiles: 0, body, reviewDecision: "", headRefName: `agent/x-${number}`, title: `pr ${number}`, createdAt: iso(ago(5)), updatedAt: iso(ago(5)),
  mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", reviews: [], closingIssuesReferences: [] });

const decideArgs = { prs: [], required: [], readyRows: [], prFiles: new Map(), rowBranches: [], openRows: [], primaryDrift: null, claimRefusals: [] };
const QUIET_FLEET = { captures24h: 3, lastCaptureAt: ago(10) };

/** One org-health tick as `main` runs it. `lastMerge` is minutes ago, or `null` for a refused read of it. */
function tick({ rows, prs = [], lastMerge = 600 }: { rows: Row[] | null; prs?: Record<string, unknown>[] | null; lastMerge?: number | null }) {
  const said: string[] = [];
  const orders = orgHealthNow(
    { prsRead: prs, readyRead: [], openRowsRead: rows, decideArgs, decided: [] } as never,
    { now: NOW, lastMergedAt: () => (lastMerge === null ? null : ago(lastMerge)), log: (line: string) => said.push(line), readCopies: () => [] as never,
      readCaptures: (() => QUIET_FLEET) as never, readLabJobs: () => [], readWaits: (() => null) as never, teamAccess: () => undefined },
  );
  return { clock: orders.filter((order: { subject: string }) => order.subject === SUBJECT), said };
}

// --- the failing case, and the controls that differ from it by one thing -----------------------------------------------

test("POSITIVE CONTROL: three open rows (parked, date-held, backlog), no claim and no PR for 121 minutes, trips and names the oldest row and its state", () => {
  const { clock } = tick({ rows: threeRows(121) });
  assert.equal(clock.length, 1, "exactly one order for the milestone clock");
  assert.equal(clock[0].session, "ceo");
  assert.equal(clock[0].cause, "org-health");
  assert.match(clock[0].prompt, /#101\b/, "the OLDEST open row is named, not the newest or the first listed");
  assert.match(clock[0].prompt, /parked/i, "and its state");
  assert.match(clock[0].prompt, /milestone 10\b/);
  assert.match(clock[0].prompt, /3 open row/);
});

test("the same at 119 minutes is clear", () => {
  assert.deepEqual(tick({ rows: threeRows(119) }).clock, []);
});

test("the same with ONE claimed row is clear", () => {
  const rows = threeRows(121);
  rows[2] = row(103, { labels: ["in-progress", "session:worker-103"], createdMinutesAgo: 121 });
  assert.deepEqual(tick({ rows }).clock, []);
});

test("a claim that names no session (`in-progress` alone) still counts as held: an unnamed holder is not proof of an idle milestone", () => {
  const rows = threeRows(121);
  rows[2] = row(103, { labels: ["in-progress"], createdMinutesAgo: 121 });
  assert.deepEqual(tick({ rows }).clock, []);
});

test("the same with ONE open PR closing one of its rows is clear; a PR closing some OTHER row does not clear it", () => {
  assert.deepEqual(tick({ rows: threeRows(121), prs: [pr(900, "Acceptance: x\n\nCloses #102")] }).clock, []);
  assert.equal(tick({ rows: threeRows(121), prs: [pr(901, "Acceptance: x\n\nCloses #555")] }).clock.length, 1);
});

test("a PR's `Closes: none` closes nothing, so it does not clear the milestone", () => {
  assert.equal(tick({ rows: threeRows(121), prs: [pr(902, "Closes: none -- a docs change")] }).clock.length, 1);
});

test("a merge 30 minutes ago restarts the clock, so the same rows are clear", () => {
  assert.deepEqual(tick({ rows: threeRows(121), lastMerge: 30 }).clock, []);
});

test("the clock starts at the NEWEST row opening: rows older than 120 minutes but one opened 60 minutes ago are clear", () => {
  const rows = [...threeRows(121), row(104, { labels: ["backlog"], createdMinutesAgo: 60 })];
  assert.deepEqual(tick({ rows }).clock, []);
});

// --- which row, and whose move -----------------------------------------------------------------------------------------

test("the oldest row's state is said: parked, date-held, backlog, blocked by #n, ready-unclaimed, and who owes the next move", () => {
  const cases: [string, Row, RegExp, RegExp][] = [
    ["parked", row(201, { labels: ["parked", "lane:any"], createdMinutesAgo: 500 }), /parked/i, /product-manager/],
    ["date-held", row(201, { labels: ["ready", "lane:any"], createdMinutesAgo: 500, body: "Not-before: 2026-10-20" }), /date-held/i, /product-manager/],
    ["backlog", row(201, { labels: ["backlog", "lane:any"], createdMinutesAgo: 500 }), /backlog/i, /product-manager/],
    ["blocked", row(201, { labels: ["ready", "lane:any"], createdMinutesAgo: 500, blockedBy: [77] }), /blocked by #77/i, /#77/],
    ["ready", row(201, { labels: ["ready", "lane:any"], createdMinutesAgo: 500 }), /ready, unclaimed/i, /engineer|product-manager/],
    ["lane", row(201, { labels: ["epic", "lane:ceo"], createdMinutesAgo: 500 }), /epic/i, /\bceo\b/],
  ];
  for (const [name, oldest, state, owes] of cases) {
    const { clock } = tick({ rows: [oldest, row(202, { labels: ["backlog"], createdMinutesAgo: 130 })] });
    assert.equal(clock.length, 1, name);
    assert.match(clock[0].prompt, /#201\b/, name);
    assert.match(clock[0].prompt, state, `${name}: state`);
    assert.match(clock[0].prompt, new RegExp(`owed by[^\\n]*${owes.source}`), `${name}: who owes the next move`);
  }
});

test("the order is keyed on the milestone and the named row, so a changed named row re-asks and the same one does not", () => {
  const first = tick({ rows: threeRows(121) }).clock[0];
  const later = tick({ rows: threeRows(240) }).clock[0];
  assert.equal(first.discriminator, later.discriminator, "same milestone, same oldest row: one offer");
  const other = tick({ rows: threeRows(121).filter((r) => r.number !== 101) }).clock[0];
  assert.notEqual(first.discriminator, other.discriminator, "the named row changed: ask again");
  assert.match(first.discriminator, /10/);
  assert.match(first.discriminator, /101/);
});

// --- clear, and why ----------------------------------------------------------------------------------------------------

test("no milestone marked `Primary: yes`: no order, and the reading says why", () => {
  assert.deepEqual(tick({ rows: threeRows(300, ORDINARY) }).clock, []);
  const reading = health.milestoneClockReading({ now: NOW, fact: { primaries: [], rows: [], prsClose: [], endedAt: ago(600) } });
  assert.equal(reading.status, "clear");
  assert.match(reading.detail, /no .*milestone .*Primary: yes/i, "the clear reading says why it is clear");
});

test("a primary milestone with NO open row is clear, saying so", () => {
  const reading = health.milestoneClockReading({ now: NOW, fact: { primaries: [{ number: 10, title: "v3" }], rows: [], prsClose: [], endedAt: ago(600) } });
  assert.equal(reading.status, "clear");
  assert.match(reading.detail, /no open row/i);
});

test("`Primary: yes` is a line of its own: a description that merely mentions it is not primary", () => {
  const mention = { ...ORDINARY, description: "Not the Primary: yes milestone, and never will be, Primary: yes is for v3 only" };
  assert.deepEqual(tick({ rows: threeRows(300, mention) }).clock, []);
});

// --- unknown is never clear --------------------------------------------------------------------------------------------

test("an unreadable open-row list is an UNKNOWN reading on stderr, never a clear one", () => {
  const { clock, said } = tick({ rows: null });
  assert.deepEqual(clock, []);
  assert.ok(said.some((line) => new RegExp(`${SUBJECT} UNKNOWN`).test(line)), said.join(""));
  const reading = health.milestoneClockReading({ now: NOW, fact: null });
  assert.equal(reading.status, "unknown");
  assert.notEqual(reading.status, "clear");
});

test("an unreadable PR list, once the idle time has passed, is UNKNOWN and not a trip and not clear", () => {
  const { clock, said } = tick({ rows: threeRows(121), prs: null });
  assert.deepEqual(clock, []);
  assert.ok(said.some((line) => new RegExp(`${SUBJECT} UNKNOWN`).test(line)), said.join(""));
});

test("an unreadable PR list BEFORE the idle time has passed says nothing: a refusal cannot make a healthy tick unknown", () => {
  const { clock, said } = tick({ rows: threeRows(119), prs: null });
  assert.deepEqual(clock, []);
  assert.ok(!said.some((line) => line.includes(SUBJECT)), said.join(""));
});

test("an unreadable last merge, once the rows alone are past the bound, is UNKNOWN: a merge may have restarted the clock", () => {
  const { clock, said } = tick({ rows: threeRows(121), lastMerge: null });
  assert.deepEqual(clock, []);
  assert.ok(said.some((line) => new RegExp(`${SUBJECT} UNKNOWN`).test(line)), said.join(""));
});

test("two milestones marked `Primary: yes` is UNKNOWN: the rule is one at a time, and the clock does not choose", () => {
  const second = { ...PRIMARY, number: 11, title: "v4" };
  const { clock, said } = tick({ rows: [...threeRows(300), row(110, { labels: ["backlog"], createdMinutesAgo: 300, milestone: second })] });
  assert.deepEqual(clock, []);
  assert.ok(said.some((line) => new RegExp(`${SUBJECT} UNKNOWN -- .*(10.*11|one at a time)`).test(line)), said.join(""));
});

test("a row with no creation time makes the start unknown rather than guessed", () => {
  const rows = threeRows(300);
  rows[2] = { ...rows[2], createdAt: undefined };
  const { clock, said } = tick({ rows });
  assert.deepEqual(clock, []);
  assert.ok(said.some((line) => new RegExp(`${SUBJECT} UNKNOWN`).test(line)), said.join(""));
});

test("the milestone clock is OFFERED only when the caller asks: an `orgHealthReadings` call without the fact has no such reading", () => {
  const readings = health.orgHealthReadings({ now: NOW, lastMergedAt: ago(10), work: null, redPrs: [], refusals: {}, drift: null, primarySince: null });
  assert.ok(!readings.some((reading: { signal: string }) => reading.signal === SUBJECT));
});
