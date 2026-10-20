// no-token: gh -- `buildReport` takes every read as a value, so nothing here reaches `gh`
/**
 * agent-org#930 (a11ign/a11ign#5009's summary has no reader): THE DAILY RETRO PRINTS THE CIRCULAR WAITS THE GATE FOUND. B4 writes every cycle
 * it makes with a pull request into `blocking-impact.json`, and `deadlockSummary` counts them; nothing printed the count, so the chairman's
 * retro could not show how many cycles were broken in 24 hours or how long each one stood.
 *
 * Every figure is checked by hand against the fixture below. At `NOW`:
 *   standing  pr-a/row-7   since `NOW - 90 minutes`             (counted as standing; 90 minutes)
 *   broken    pr-b/row-8   minutes 42, read at `NOW - 1 hour`   (counted as broken; 42 minutes)
 *   broken    pr-c/row-9   minutes 500, read at `NOW - 25 hours` (outside the window: counted nowhere)
 * So the retro reads `2 found (1 broken, longest 90 minutes; 1 standing)`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport } from "./org-retro/journal-stats-and-verdicts.ts";
import { renderReport } from "./org-retro.ts";

const NOW = Date.parse("2026-10-12T00:22:00Z");
const HOUR = 3_600_000;
const MINUTE = 60_000;
const LINE = "- Circular waits";

const reads = { merged: [], openPrs: [], journal: "", ledger: "", turns: [], handFixes: null };
const lines = (blockingRecord: string | null | undefined) => renderReport(buildReport({ ...reads, blockingRecord } as any, NOW)).split("\n");
const lineOf = (blockingRecord: string | null | undefined) => lines(blockingRecord).find((l) => l.startsWith(LINE));

/** A record as the gate writes it: `deadlocks` for the cycles standing, `brokenDeadlocks` for the ones it stopped reading. */
function recordOf({ standing = [], broken = [] }: { standing?: { since: number }[]; broken?: { minutes: number; at: number }[] }): string {
  return JSON.stringify({
    at: NOW, episodes: {}, samples: [],
    deadlocks: Object.fromEntries(standing.map(({ since }, i) => [`pr-a/row-${7 + i}`, { shelved: 7 + i, pr: `#${50 + i}`, since, woke: null, escalated: false }])),
    brokenDeadlocks: broken.map(({ minutes, at }, i) => ({ key: `pr-b/row-${8 + i}`, shelved: 8 + i, pr: `#${51 + i}`, since: at - minutes * MINUTE, minutes, escalated: true, at })),
  });
}

test("a record with one broken and one standing cycle prints both counts and the longest minutes, the outside-window cycle counted nowhere", () => {
  const text = recordOf({
    standing: [{ since: NOW - 90 * MINUTE }],
    broken: [{ minutes: 42, at: NOW - HOUR }, { minutes: 500, at: NOW - 25 * HOUR }],
  });
  assert.equal(lineOf(text), "- Circular waits: 2 found (1 broken, longest 90 minutes; 1 standing)",
    "the standing 90 minutes beats the broken 42; the 500-minute cycle read 25 hours ago is outside the window");
});

test("the longest is taken over the broken cycles too, so a broken cycle that stood longer than the standing one is the longest", () => {
  const text = recordOf({ standing: [{ since: NOW - 20 * MINUTE }], broken: [{ minutes: 42, at: NOW - HOUR }] });
  assert.equal(lineOf(text), "- Circular waits: 2 found (1 broken, longest 42 minutes; 1 standing)",
    "positive control for the test above: the number follows the longest cycle, not whichever kind was listed first");
});

test("a record with no cycle prints `0 found`, a reading and not a gap", () => {
  assert.equal(lineOf(JSON.stringify({ at: NOW, episodes: {}, samples: [] })), "- Circular waits: 0 found");
});

test("a record whose only cycles are outside the window is `0 found`, not the count of what it once held", () => {
  assert.equal(lineOf(recordOf({ broken: [{ minutes: 500, at: NOW - 25 * HOUR }] })), "- Circular waits: 0 found");
});

test("only broken cycles, none standing, prints `0 standing`", () => {
  assert.equal(lineOf(recordOf({ broken: [{ minutes: 30, at: NOW - HOUR }] })), "- Circular waits: 1 found (1 broken, longest 30 minutes; 0 standing)");
});

test("a record nobody read, or one that does not parse, prints `unknown`, never `0 found`", () => {
  for (const text of [null, undefined, "{not json"]) {
    assert.match(lineOf(text)!, /^- Circular waits: unknown \(blocking-impact\.json could not be read/, `text: ${String(text)}`);
  }
});

test("the circular-wait line sits directly beneath the top blocker line", () => {
  const report = lines(recordOf({ standing: [{ since: NOW - 90 * MINUTE }] }));
  assert.equal(report.findIndex((l) => l.startsWith(LINE)), report.findIndex((l) => l.startsWith("- Top blocker")) + 1);
});
