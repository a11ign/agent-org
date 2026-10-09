// a11ign/a11ign#4076 (#4055 move 10): the Codex reviewers are priced from a SOURCED OpenAI rate, or not at all. Fixtures only; nothing here reads the home directory.
// no-token: gh -- nothing here reaches GitHub
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregate, renderAggregate } from "./aggregate.mjs";
import { eventsOfCodexSession } from "./codex-turns.mjs";
import { costOf, PRICES } from "./store.mjs";

const ROW_REPO = "a11ign/a11ign";
const tokens = (input, output, cacheRead = 0) => ({ input, output, cacheRead, cacheWrite5m: 0, cacheWrite1h: 0 });
/** `costOf` rounds to 8 places to remove float noise, so an expected figure is rounded the same way. */
const rounded = (dollars) => Math.round(dollars * 1e8) / 1e8;
const SHORT_PROMPT = 200_000; // under the 272K tier, so the base rates apply
const SESSION_DOLLARS = rounded((3043 * 0.2 + 213 * 1.2 + 9984 * 0.02) / 1e6);

/** The rows that are not Claude's: the ones whose rate must be quoted from somewhere. */
const nonClaude = (rows) => rows.filter((row) => !(typeof row.prefix === "string" && row.prefix.startsWith("claude-")));
/** What a row owes: the URL it was quoted from and the day it was fetched. Returns the problems, empty when it is sourced. */
const unsourced = (row) => [
  ...(/^https:\/\/\S+$/.test(row.source ?? "") ? [] : ["source URL"]),
  ...(/^\d{4}-\d{2}-\d{2}$/.test(row.fetched ?? "") && !Number.isNaN(Date.parse(row.fetched)) ? [] : ["fetched date"]),
];

test("SOURCED: every non-Claude PRICES row carries a source URL and a fetched date; the same row with its source removed turns the check red", () => {
  const rows = nonClaude(PRICES);
  // POSITIVE CONTROL for the emptiness below: the population is not empty, and it holds the Codex model the reviewers run.
  assert.ok(rows.some((row) => row.model === "gpt-5.6-luna"), "the gpt-5.6-luna row is among the rows checked");
  assert.deepEqual(rows.flatMap((row) => unsourced(row).map((problem) => `${row.model ?? row.prefix}: ${problem}`)), []);
  const luna = rows.find((row) => row.model === "gpt-5.6-luna");
  const { source: _source, ...withoutSource } = luna;
  const { fetched: _fetched, ...withoutDate } = luna;
  assert.deepEqual(unsourced(withoutSource), ["source URL"], "negative control: no source, red");
  assert.deepEqual(unsourced(withoutDate), ["fetched date"], "negative control: no date, red");
  assert.deepEqual(unsourced({ ...luna, source: "see pricing page" }), ["source URL"], "a sentence is not a URL");
});

test("RATE: gpt-5.6-luna costs OpenAI's quoted $0.20 input, $0.02 cached input and $1.20 output per million tokens", () => {
  assert.equal(costOf("gpt-5.6-luna", tokens(SHORT_PROMPT, 0)), 0.04);
  assert.equal(costOf("gpt-5.6-luna", tokens(0, 0, SHORT_PROMPT)), 0.004);
  assert.equal(costOf("gpt-5.6-luna", tokens(0, 1_000_000)), 1.2);
  assert.equal(costOf("gpt-5.6-luna", tokens(0, 0)), 0, "a priced model with no tokens costs 0: that is a price, not an unknown");
});

test("ABOVE 272K: the page states a different rate there and not the cached one, so a request whose whole prompt is above 272K tokens is null, and 272K exactly is priced", () => {
  assert.equal(costOf("gpt-5.6-luna", tokens(272_000, 0)), rounded(272_000 * 0.2 / 1e6));
  assert.equal(costOf("gpt-5.6-luna", tokens(272_001, 0)), null);
  assert.equal(costOf("gpt-5.6-luna", tokens(100_000, 1_000, 172_001)), null, "cached tokens count toward the prompt");
  assert.equal(costOf("gpt-5.6-luna", tokens(100_000, 1_000_000, 172_000)), rounded((100_000 * 0.2 + 1_000_000 * 1.2 + 172_000 * 0.02) / 1e6), "output does not");
});

test("EXACT NAME: only the name the entry carries is priced; a neighbour (gpt-5.6-luna-pro, gpt-5.6-terra, a Claude-looking prefix) stays null, never the neighbour's rate", () => {
  for (const model of ["gpt-5.6-luna-pro", "gpt-5.6-terra", "gpt-5.6", "gpt-5.6-luna-2", "GPT-5.6-LUNA", "", undefined]) {
    assert.equal(costOf(model, tokens(1000, 1000, 1000)), null, `${model}`);
  }
  // POSITIVE CONTROL: the same tokens under the entry's own name are priced, so the nulls above are the match and not an empty table.
  assert.notEqual(costOf("gpt-5.6-luna", tokens(1000, 1000, 1000)), null);
});

const session = (model) => [
  { timestamp: "2026-10-04T20:09:10.032Z", type: "session_meta", payload: { id: "s", cwd: "/home/agent/reviews/reviewer-9100" } },
  { timestamp: "2026-10-04T20:09:10.355Z", type: "turn_context", payload: { model } },
  { timestamp: "2026-10-04T20:09:13.069Z", type: "token_usage_record", payload: { response_id: "r1", usage: { input_tokens: 13027, cached_input_tokens: 9984, output_tokens: 213 } } },
].map((line) => JSON.stringify(line)).join("\n") + "\n";
const turnsOf = (model) => eventsOfCodexSession({ text: session(model), file: "rollout-2026-10-04T20-09-10-00000000-0000-0000-0000-000000000000.jsonl", rowRepo: ROW_REPO }).events;

test("INGEST: a Codex turn is priced from the entry for its model, and the same session under another Codex model is stored null", () => {
  assert.equal(turnsOf("gpt-5.6-luna")[0].costUsd, SESSION_DOLLARS);
  assert.equal(turnsOf("gpt-5.6-terra")[0].costUsd, null);
});

test("REPORT: the priced Codex turns are a line of their own with their turn count and dollars, and the turns of a model with no entry still print as theirs", () => {
  const events = [...turnsOf("gpt-5.6-luna"), ...turnsOf("gpt-5.6-terra").map((event) => ({ ...event, id: "codex-turn:r2" }))];
  const at = events[0].at;
  const result = aggregate({ events, pulls: [], rowRepo: ROW_REPO, now: at + 2000, since: at - 1000, held: { from: at - 1000, basis: "t" } });
  const week = result.weeks[0];
  assert.deepEqual([week.spend.pricedCodex.turns, week.spend.unpricedCodex.turns], [1, 1], "one turn of each, in a line of its own each");
  assert.equal(week.spend.pricedCodex.dollars, SESSION_DOLLARS);
  const text = renderAggregate(result);
  assert.match(text, /CODEX turns priced \(.*\): 1 turns, 13,240 tokens, \$0\.00\d+/);
  assert.match(text, /CODEX turns not priced \(no rate sourced; in no dollar figure above\): 1 turns, 13,240 tokens/);
});
