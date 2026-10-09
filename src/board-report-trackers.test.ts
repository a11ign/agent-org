// no-token: REPO
// This file imports board-report.mjs, whose closure reads REPO from board-data.mjs, which spawns `gh`. Every test here hands the readers a recorded
// `run` and renders from an injected fact set; nothing here calls or spawns it.
/**
 * #4080 (row 2 of #4056): THE EDITION READS EVERY DECLARED TRACKER, not the first one's board. A row filed in a second tracker was in no edition,
 * because `facts()` asked `issues()` of the one `REPO` and `render` printed one queue.
 *
 * POSITIVE CONTROL for the three tests that look for an absence or a name: `render` of the one-tracker facts is pinned to a recorded snapshot
 * (the last test), so the others cannot be passing because the renderer prints nothing at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as report from "./board-report.ts";
import { REPO } from "./board-data.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const SINCE = "2026-10-07T12:00:00.000Z";
const OTHER = "a11ign/agent-org";
const TRACKERS = [
  { key: "", repo: REPO, board: { owner: "a11ign", number: 1 } },
  { key: "agent-org", repo: OTHER, board: { owner: "a11ign", number: 2 } },
];

/** @param {number} number @param {string} title @param {Record<string, unknown>} [over] */
const node = (number: number, title: string, over: Record<string, unknown> = {}) => ({
  number, title, state: "OPEN", closedAt: null, url: `https://github.com/x/y/issues/${number}`,
  labels: { totalCount: 1, nodes: [{ name: "ready" }] }, milestone: null, ...over,
});

/** A GraphQL answer per repository: `rows[repo]` is the node list, a missing repository throws like a refused read. @param {Record<string, any[]>} rows */
function runOf(rows: Record<string, any[]>) {
  return (args: string[]) => {
    const owner = args.find((a) => a.startsWith("owner="))?.slice("owner=".length);
    const name = args.find((a) => a.startsWith("name="))?.slice("name=".length);
    const nodes = rows[`${owner}/${name}`];
    if (nodes === undefined) throw new Error(`HTTP 502 reading ${owner}/${name}`);
    return JSON.stringify({ data: { repository: { issues: { totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } });
  };
}

const MINIMAL_FACTS = {
  since: SINCE, sinceLabel: `commits and closures since ${SINCE}`, ms: null, merges: [], unpushed: null, strays: [], latestGate: null, gateIsFresh: true,
  fleetHours: null, closed: [], open: [], blockers: [], ready: [], awaiting: [],
  conflict: { since: SINCE, method: "fixture", opened: 0, merged: 0, closedUnmerged: 0, lifetimeMinutes: { count: 0, medianMinutes: null, p90Minutes: null },
    reconciliation: { neededReconciliation: 0, of: 0, unresolvable: 0 }, hotspotFiles: [] },
  flow: report.flowReadings({ rows: [], events: new Map(), now: NOW }),
};

/** The home tracker's open row #7, as `facts()` hands it to `render`; the Blockers table is where the home rows are printed by title. */
const homeSeven = { number: 7, title: "home seven", url: "https://github.com/a11ign/a11ign/issues/7", labelNames: ["ready"], state: "OPEN" };
const render = (d: any) => report.render(d, new Date(NOW), () => "agent-org vTEST");

/** @param {any[]} otherTrackers @param {any[]} [ready] */
const edition = (otherTrackers: any[], ready: any[] = []) => render({ ...MINIMAL_FACTS, open: ready, ready, blockers: ready, otherTrackers });

test("a row that exists only in the SECOND tracker appears in the edition", () => {
  const others = report.readOtherTrackers({ trackers: TRACKERS, since: SINCE, run: runOf({ [OTHER]: [node(12, "only in the org tracker")] }) });
  const out = edition(others);
  assert.match(out, /agent-org#12/);
  assert.match(out, /only in the org tracker/);
  assert.match(out, new RegExp(OTHER));
});

test("the same row number in both trackers stays TWO rows, `agent-org#7` and `#7`", () => {
  const others = report.readOtherTrackers({ trackers: TRACKERS, since: SINCE, run: runOf({ [OTHER]: [node(7, "org seven")] }) });
  const out = edition(others, [homeSeven]);
  assert.match(out, /\[agent-org#7\]\([^)]*\) org seven/);
  assert.match(out, /home seven/, "the home tracker's #7 is still reported");
  assert.match(out, /\| \[#7\]/, "as #7, not as the org tracker's row");
  assert.equal(report.trackerRowName("", 7), "#7");
  assert.equal(report.trackerRowName("agent-org", 7), "agent-org#7");
});

test("a read that fails on the second tracker NAMES that tracker, and the first tracker's rows are still reported", () => {
  const others = report.readOtherTrackers({ trackers: TRACKERS, since: SINCE, run: runOf({}) });
  const out = edition(others, [homeSeven]);
  assert.match(out, /NOT READ/);
  assert.match(out, new RegExp(`${OTHER}[^\\n]*502|502[^\\n]*${OTHER}`), "the refusal names the repository and the cause");
  assert.match(out, /home seven/);
  assert.doesNotMatch(out, /\*\*Ready 0\*\*[^]*Ready 0/, "a refused tracker is not printed as an empty one");
});

test("a closed row in the window is listed, one outside it is not, and a meta row is not counted", () => {
  const rows = [
    node(20, "closed inside", { state: "CLOSED", closedAt: "2026-10-08T01:00:00Z", labels: { totalCount: 0, nodes: [] } }),
    node(21, "closed before", { state: "CLOSED", closedAt: "2026-09-01T01:00:00Z", labels: { totalCount: 0, nodes: [] } }),
    node(22, "a container", { labels: { totalCount: 1, nodes: [{ name: "meta" }] } }),
  ];
  const out = edition(report.readOtherTrackers({ trackers: TRACKERS, since: SINCE, run: runOf({ [OTHER]: rows }) }));
  assert.match(out, /agent-org#20/);
  assert.doesNotMatch(out, /closed before|a container/);
});

test("with ONE declared tracker the edition equals today's: nothing is read for a second and nothing is printed", () => {
  assert.deepEqual(report.readOtherTrackers({ trackers: TRACKERS.slice(0, 1), since: SINCE, run: () => { throw new Error("no second read may be made"); } }), []);
  assert.equal(edition([]), render(MINIMAL_FACTS), "an empty list prints what a fact set without the field prints");
  const out = render(MINIMAL_FACTS);
  const headings = out.split("\n").filter((l) => l.startsWith("## "));
  assert.deepEqual(headings, ["## Release", "## Blockers", "## Issues closed", "## What merged",
    "## Last conformance gate result (`rules-real-pages`)", "## Fleet hours", "## Conflict metrics", "## Queue", "## Queue flow"], "the recorded section list of the edition before #4080");
});
