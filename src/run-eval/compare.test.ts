// no-token: gh -- a pure function over two stored runs
/** A11-431, step 2 of 2: two stored runs of a set side by side, each score's change per ticket and in total, over the tickets both have. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareTable } from "./compare.ts";
import { type StoredRun } from "./store.ts";
import { type TicketResult } from "../run-eval.ts";

const row = (ticket: string, scores: Partial<TicketResult["scores"]> = {}): TicketResult => ({
  entry: { repo: "a11ign/agent-org", ticket, baseSha: "0".repeat(40), mergedPr: 1 }, dir: `/eval/${ticket}`, notes: [],
  scores: { tests: true, verdict: "convinced", similarity: 0.5, outside: [], tokens: 1000, wallMs: 60_000, ...scores },
});
const AT = Date.UTC(2026, 10, 16);
const runOf = (sha: string, results: readonly TicketResult[], over: Partial<StoredRun> = {}): StoredRun =>
  ({ v: 1, set: "first", sha: sha.padEnd(40, "0"), dirty: false, key: null, model: "opus", effort: "high", at: AT, stopped: null, results, ...over });

/** The cells of a printed row, split on the two or more spaces between columns. */
const cellsOf = (text: string, first: string): string[] => (text.split("\n").find((line) => line.startsWith(`${first} `)) ?? "").split(/ {2,}/);

test("each ticket's scores are shown before → after with the change, and the totals the same way; an unknown has no change and is left out of the totals", () => {
  const before = runOf("0d450e9", [row("A11-1", { tests: false, verdict: "not convinced", similarity: 0.25, outside: ["x.ts", "y.ts"], tokens: 1000, wallMs: 60_000 }), row("A11-2")]);
  const after = runOf("a1b2c3d", [row("A11-1", { similarity: 0.5, outside: ["x.ts"], tokens: 800, wallMs: 45_000 }), row("A11-2", { tests: null, verdict: null, similarity: null, tokens: null })]);
  const text = compareTable(before, after);
  assert.deepEqual(text.split("\n").slice(0, 4), [
    "worker eval of first, A → B",
    "A: 0d450e9 (opus, effort high, finished 2026-11-16T00:00:00.000Z)",
    "B: a1b2c3d (opus, effort high, finished 2026-11-16T00:00:00.000Z)",
    "",
  ]);
  assert.deepEqual(cellsOf(text, "ticket"), ["ticket", "tests", "verdict", "similarity", "outside", "tokens", "wall"]);
  assert.deepEqual(cellsOf(text, "A11-1"), ["A11-1", "fail → pass", "not convinced → convinced", "0.25 → 0.50 (+0.25)", "2 → 1 (-1)", "1000 → 800 (-200)", "60s → 45s (-15s)"]);
  assert.deepEqual(cellsOf(text, "A11-2"), ["A11-2", "pass → ?", "convinced → ?", "0.50 → ?", "0 → 0 (+0)", "1000 → ?", "60s → 60s (+0s)"]);
  // A11-2's similarity and tokens are unknown in B: the totals of both are over A11-1 alone, never A's 2000 against B's 800.
  assert.deepEqual(cellsOf(text, "total"), ["total", "1 → 1 (+0) of 2", "1 → 1 (+0) convinced", "0.25 → 0.50 (+0.25) (1 unknown left out)", "2 → 1 (-1)", "1000 → 800 (-200) (1 unknown left out)", "120s → 105s (-15s)"]);
});

test("the totals count only the tickets both runs have, and the others are named under the table", () => {
  const before = runOf("0d450e9", [row("A11-1"), row("A11-2"), row("A11-3")]);
  const after = runOf("a1b2c3d", [row("A11-1", { tokens: 500 }), row("A11-4")]);
  const text = compareTable(before, after);
  assert.deepEqual(cellsOf(text, "total").slice(0, 2), ["total", "1 → 1 (+0) of 1"]);
  assert.equal(cellsOf(text, "total")[5], "1000 → 500 (-500)");
  assert.match(text, /^only in A, not in the totals: A11-2, A11-3$/m);
  assert.match(text, /^only in B, not in the totals: A11-4$/m);
});

test("a run with a key set off and on are named side by side, with what makes either not a plain run", () => {
  const off = runOf("0d450e9", [row("A11-1")], { key: { name: "tickets.drafts", on: false }, dirty: true });
  const on = runOf("0d450e9", [row("A11-1")], { key: { name: "tickets.drafts", on: true }, stopped: { ran: 1, of: 3, tokens: 1000, cap: 900, notStarted: ["A11-2", "A11-3"] } });
  const lines = compareTable(off, on).split("\n");
  assert.equal(lines[1], "A: 0d450e9 with tickets.drafts off (opus, effort high, finished 2026-11-16T00:00:00.000Z), uncommitted changes");
  assert.equal(lines[2], "B: 0d450e9 with tickets.drafts on (opus, effort high, finished 2026-11-16T00:00:00.000Z), stopped by the token cap after 1 of 3 tickets");
});
