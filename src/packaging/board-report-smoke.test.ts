// no-token: REPO
// This file imports board-report.mjs, whose closure reads REPO from board-data.mjs, which spawns `gh`. Every test here
// renders from an injected fact set and, since #1442, an injected instant; nothing here calls or spawns it.
/**
 * Guard triage 4 of 6 (#906): the board's content/style guards retire with the org shape they policed.
 * What survives is this — that the board report renders at all — because a render failure is a defect a
 * reader catches slower than a build does, and the render is what a person reads before anything of the
 * board's is published. Everything the deleted tests asserted about WORDING, CAPS and SECTION DETAIL is
 * now the product-manager's own read of the rendered document, per the CI Reset's own risk acceptance:
 * "the style guards were catching a class of defect a reader catches faster, and they cost every pull
 * request to do it."
 *
 * See docs/operational-lessons.md, "Guard triage 4 of 6", for what each retired test asserted and why.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { render, flowReadings, filedAndClosedPerDay, mergeFlowRows } from "../board-report.ts";

const MINIMAL_FACTS = {
  since: "2026-09-05T00:00:00.000Z",
  sinceLabel: "commits and closures since 2026-09-05T00:00:00.000Z",
  ms: null,
  merges: [],
  unpushed: null,
  strays: [],
  latestGate: null,
  gateIsFresh: true,
  fleetHours: null,
  closed: [],
  open: [],
  blockers: [],
  ready: [],
  awaiting: [],
  conflict: {
    since: "2026-09-05T00:00:00.000Z", method: "smoke test fixture",
    opened: 0, merged: 0, closedUnmerged: 0,
    lifetimeMinutes: { count: 0, medianMinutes: null, p90Minutes: null },
    reconciliation: { neededReconciliation: 0, of: 0, unresolvable: 0 },
    hotspotFiles: [],
  },
  flow: flowReadings({ rows: [], events: new Map(), now: Date.parse("2026-09-05T12:00:00Z") }),
};

test("#906: the board report renders a non-empty document from a minimal, empty-everywhere fact set", () => {
  const out = render(MINIMAL_FACTS);
  assert.equal(typeof out, "string");
  assert.ok(out.length > 0, "render() produced an empty document");
  assert.match(out, /^# Board report/, "a rendered board must open with its own title");
});

test("#906 MUTATION TARGET: render() must not silently swallow a throwing section", () => {
  const broken = { ...MINIMAL_FACTS, conflict: null } as unknown as typeof MINIMAL_FACTS;
  assert.throws(() => render(broken),
    "a fact set missing a section render() depends on must fail loudly, not render a gap silently");
});

// --- #1442: the title's day is LONDON's, from editionDay, at an injected instant ---

test("#1442: the title names LONDON's day -- 23:30Z in BST is already the 14th", () => {
  // 2026-09-13T23:30Z is 00:30 BST on 14 September. A UTC slice titled it the 13th: the split #1302 removed from every
  // other edition script, one reader further on (board-schedule-liveness reads a day from this heading).
  assert.match(render(MINIMAL_FACTS, new Date("2026-09-13T23:30:00Z")), /^# Board report — 2026-09-14\n/);
});

test("#1442 POSITIVE CONTROL: at 07:13Z both zones agree, and in GMT 23:30Z is still the same day", () => {
  // A test asserting only these would pass for either zone; the BST case above is the one that decides.
  assert.match(render(MINIMAL_FACTS, new Date("2026-09-13T07:13:00Z")), /^# Board report — 2026-09-13\n/);
  assert.match(render(MINIMAL_FACTS, new Date("2026-12-13T23:30:00Z")), /^# Board report — 2026-12-13\n/);
});

// --- #2282: the queue's flow -- filed and closed per day, ready-to-claim latency, age of open rows ---

const NOW = Date.parse("2026-09-24T12:00:00Z");
const row = (number: number, createdAt: string, state: "OPEN" | "CLOSED", more: { labels?: string[]; closedAt?: string } = {}) =>
  ({ number, createdAt, state, closedAt: more.closedAt ?? null, labels: (more.labels ?? []).map((name) => ({ name })) });
const ev = (number: number, event: "labeled" | "unlabeled", label: string, at: string) => ({ number, event, label, at });

// A KNOWN HISTORY, so every printed figure below is derivable by hand from this list:
//   #1  filed 09-23 10:00, ready 10:05, claimed 10:35 (30 min), closed 09-24 09:00
//   #2  filed 09-23 11:00, ready 11:00, claimed 14:00 (3 h), still open
//   #3  filed 09-24 08:00, ready, never claimed                            (open, under 2 days)
//   #4  filed 09-20, backlog                                               (open, 2 to 7 days)
//   #5  filed 09-10, backlog                                               (open, over 7 days)
//   #6  filed and closed 09-24, no claim
//   #7  a META row filed 09-01: excluded from the ages, as the Queue section excludes it
//   #8  filed 09-23, claimed 15:00 with NO ready event before it           (cannot be timed)
//   #9  claimed 09-01, before the window                                   (out of the window)
//   #900 is a PULL REQUEST carrying a `session:` label: it is not in the issue listing, so it is no claim
const ROWS = [
  row(1, "2026-09-23T10:00:00Z", "CLOSED", { closedAt: "2026-09-24T09:00:00Z" }),
  row(2, "2026-09-23T11:00:00Z", "OPEN", { labels: ["in-progress"] }),
  row(3, "2026-09-24T08:00:00Z", "OPEN", { labels: ["ready"] }),
  row(4, "2026-09-20T08:00:00Z", "OPEN", { labels: ["backlog"] }),
  row(5, "2026-09-10T08:00:00Z", "OPEN", { labels: ["backlog"] }),
  row(6, "2026-09-24T09:00:00Z", "CLOSED", { closedAt: "2026-09-24T10:00:00Z" }),
  row(7, "2026-09-01T08:00:00Z", "OPEN", { labels: ["meta"] }),
  row(8, "2026-09-23T12:00:00Z", "OPEN", { labels: ["in-progress"] }),
  row(9, "2026-09-01T08:00:00Z", "CLOSED", { closedAt: "2026-09-02T08:00:00Z" }),
];
const CLAIMS = [
  ev(1, "labeled", "session:worker-a", "2026-09-23T10:35:00Z"),
  ev(2, "labeled", "session:worker-b", "2026-09-23T14:00:00Z"),
  ev(8, "labeled", "session:worker-c", "2026-09-23T15:00:00Z"),
  ev(9, "labeled", "session:worker-d", "2026-09-01T09:00:00Z"),
  ev(900, "labeled", "session:reviewer", "2026-09-23T16:00:00Z"),
];
const READY = [
  ev(1, "labeled", "ready", "2026-09-23T10:05:00Z"),
  ev(2, "labeled", "ready", "2026-09-23T11:00:00Z"),
  ev(9, "labeled", "ready", "2026-09-01T08:30:00Z"),
];
const eventMap = (events: ReturnType<typeof ev>[]) => {
  const byNumber = new Map<number, { event: string; label: string; at: string }[]>();
  for (const { number, ...rest } of events) byNumber.set(number, [...(byNumber.get(number) ?? []), rest]);
  return byNumber;
};
const flowSection = (input: Parameters<typeof flowReadings>[0]) => {
  const out = render({ ...MINIMAL_FACTS, flow: flowReadings(input) });
  return out.slice(out.indexOf("## Queue flow"));
};

test("#2282: filed and closed per day are the fixture's, day by day, with the window and the cap stated", () => {
  const out = flowSection({ rows: ROWS, events: eventMap([...READY, ...CLAIMS]), now: NOW });
  assert.match(out, /\| 2026-09-23 \| 3 \| 0 \| \+3 \|/);
  assert.match(out, /\| 2026-09-24 \| 2 \| 2 \| \+0 \|/);
  assert.match(out, /last 14 London days, today partial/);
  assert.match(out, /--limit 1000`, which returned \*\*9\*\* rows\. That listing is complete/);
});

test("#2282: ready-to-claim latency is the median and worst of the TIMED claims in the window", () => {
  const out = flowSection({ rows: ROWS, events: eventMap([...READY, ...CLAIMS]), now: NOW });
  assert.match(out, /\*\*2\*\* claims: median \*\*30 min\*\*, worst \*\*3\.0 h\*\*/);
  assert.match(out, /1 claim in the window had no `ready` event before them/,
    "#8 has a claim and no ready event: counted as un-timeable, never as a latency of zero");
});

test("#2282 POSITIVE CONTROL: the same history with the `session:` events removed says there were no claims, not a latency of zero", () => {
  const out = flowSection({ rows: ROWS, events: eventMap(READY), now: NOW });
  assert.match(out, /No claims in the window/);
  assert.doesNotMatch(out, /median/);
  assert.doesNotMatch(out, /0 min/);
});

test("#2282: a claim after a release is timed from the release, not from the row's first ready", () => {
  const reclaimed = [
    ev(2, "labeled", "ready", "2026-09-23T11:00:00Z"),
    ev(2, "labeled", "session:worker-b", "2026-09-23T11:10:00Z"),
    ev(2, "unlabeled", "session:worker-b", "2026-09-23T12:00:00Z"),
    ev(2, "labeled", "session:worker-e", "2026-09-23T16:00:00Z"),
  ];
  const out = flowSection({ rows: ROWS, events: eventMap(reclaimed), now: NOW });
  assert.match(out, /\*\*2\*\* claims: median \*\*10 min\*\*, worst \*\*4\.0 h\*\*/);
});

test("#2282: an event log that could not be read is reported as unread, never as no claims", () => {
  const out = flowSection({ rows: ROWS, events: null, eventsError: "gh api failed", now: NOW });
  assert.match(out, /Not read: gh api failed/);
  assert.doesNotMatch(out, /No claims in the window/);
});

test("#2282: open-row ages bucket ready, backlog and the rest, and leave the meta row out", () => {
  const out = flowSection({ rows: ROWS, events: eventMap(CLAIMS), now: NOW });
  assert.match(out, /\| ready \| 1 \| 0 \| 0 \|/);
  assert.match(out, /\| backlog \| 0 \| 1 \| 1 \|/);
  assert.match(out, /\| other \| 2 \| 0 \| 0 \|/, "#2 and #8 are in-progress; meta #7 is not counted at all");
});

test("#2282: a listing AT its cap that reaches past the window says FILED is complete and CLOSED is a floor", () => {
  const out = flowSection({ rows: ROWS, listLimit: ROWS.length, events: eventMap(CLAIMS), now: NOW });
  assert.match(out, /AT the cap[^\n]*Filed is complete[^\n]*2026-09-01T08:00:00Z[^\n]*CLOSED IS A FLOOR/);
  assert.match(out, /the counts are floors/);
});

test("#2282: a listing AT its cap that stops inside the window says BOTH columns are floors", () => {
  const recent = ROWS.filter((r) => r.createdAt >= "2026-09-20");
  const out = flowSection({ rows: recent, listLimit: recent.length, events: eventMap(CLAIMS), now: NOW });
  assert.match(out, /AT the cap[^\n]*BOTH columns are FLOORS[^\n]*2026-09-20T08:00:00Z/);
  assert.doesNotMatch(out, /Filed is complete/);
});

test("#2282: a listing AT its cap says the over-7-days column is a FLOOR, because the missing rows are the oldest", () => {
  const out = flowSection({ rows: ROWS, listLimit: ROWS.length, events: eventMap(CLAIMS), now: NOW });
  assert.match(out, /at its cap, so an open row older than its oldest row is missed[^\n]*FLOOR/);
});

test("#2282 POSITIVE CONTROL: a complete read makes no such claim about the ages", () => {
  const out = flowSection({ rows: ROWS, events: eventMap(CLAIMS), now: NOW });
  assert.doesNotMatch(out, /is a FLOOR/);
  assert.doesNotMatch(out, /at its cap/);
});

test("#2282: a reader that pages says how it read, and a full ROW COUNT is not a cap when it declares itself complete", () => {
  const out = flowSection({ rows: ROWS, listLimit: ROWS.length, capped: false, source: "a paged read", events: eventMap(CLAIMS), now: NOW });
  assert.match(out, /Read from a paged read, which returned \*\*9\*\* rows\. That listing is complete/);
  assert.doesNotMatch(out, /AT the cap/);
  assert.doesNotMatch(out, /is a FLOOR/);
});

test("#2282: the open rows and the window's rows merge to one entry per issue, the window's copy of a shared row kept out", () => {
  const open = [{ number: 1, state: "OPEN", tag: "open" }, { number: 2, state: "OPEN", tag: "open" }];
  const window = [{ number: 2, state: "OPEN", tag: "window" }, { number: 3, state: "CLOSED", tag: "window" }];
  const merged = mergeFlowRows(open, window);
  assert.deepEqual(merged.map((r) => r.number).sort(), [1, 2, 3], "every issue once, none twice");
  assert.equal(merged.find((r) => r.number === 2)?.tag, "open", "the open listing is the fresher read of an open row");
});

test("#2282: the report states that it sets no threshold", () => {
  assert.match(flowSection({ rows: ROWS, events: eventMap(CLAIMS), now: NOW }),
    /This report sets no threshold and proposes no ceiling/);
});

test("#2282: a 23-hour day is not skipped -- 00:10 BST on 30 March steps back 24 hours into the 28th", () => {
  // Spring forward makes 2026-03-29 23 hours long. A 24-hour step from 00:10 BST on the 30th (23:10Z on the 29th) lands
  // on 23:10 GMT on the 28th and the whole 29th disappears; a table missing a day reads as a day with nothing filed.
  const days = filedAndClosedPerDay([], Date.parse("2026-03-29T23:10:00Z")).map((d) => d.day);
  assert.equal(days.length, 14);
  assert.ok(days.includes("2026-03-29"), `the 23-hour day is missing from ${days.join(" ")}`);
  assert.equal(days.at(-1), "2026-03-30");
  assert.equal(new Set(days).size, 14);
});
