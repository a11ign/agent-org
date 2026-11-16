// no-token: gh -- pure functions over stored runs and outcome records
/**
 * A11-440, step 2 of 2: the epic's bar for the pre-PR review. With tickets.localReview off and on at one sha, the key turns on only when the first-pass verdict is better AND the pre-PR
 * reviews' tokens are no more than the feedback rounds they save; a miss says which and by how much.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { type TicketResult } from "../run-eval.ts";
import { type OutcomeRecord } from "../ticket-mode/outcomes/outcome-record.ts";
import { barText, feedbackRoundTokens, preReviewBar } from "./pre-review-bar.ts";
import { type StoredRun } from "./store.ts";

type Verdict = TicketResult["scores"]["verdict"];

const row = (ticket: string, verdict: Verdict, localReviews?: { count: number; tokens: number | null }): TicketResult => ({
  entry: { repo: "a11ign/agent-org", ticket, baseSha: "0".repeat(40), mergedPr: 1 }, dir: `/eval/${ticket}`, notes: [],
  scores: { tests: false, verdict, similarity: 0.1, outside: [], tokens: 5_000_000, wallMs: 60_000, ...(localReviews === undefined ? {} : { localReviews }) },
});
const SHA = "a1b2c3d".padEnd(40, "0");
const runOf = (on: boolean, results: readonly TicketResult[], over: Partial<StoredRun> = {}): StoredRun =>
  ({ v: 1, set: "first", sha: SHA, dirty: false, key: { name: "tickets.localReview", on }, model: "opus", effort: "medium", at: 0, stopped: null, results, ...over });
const ROUND = { tokens: 2_000_000, rounds: 52 };

const OFF = runOf(false, [row("A11-1", "not convinced"), row("A11-2", "convinced"), row("A11-3", "not convinced"), row("A11-4", null)]);

test("a better first-pass verdict, for reviewer tokens within the rounds it saves, meets the bar", () => {
  const on = runOf(true, [row("A11-1", "convinced", { count: 2, tokens: 900_000 }), row("A11-2", "convinced", { count: 1, tokens: 500_000 }),
    row("A11-3", "convinced", { count: 3, tokens: 1_000_000 }), row("A11-4", "not convinced", { count: 0, tokens: 0 })]);
  assert.deepEqual(preReviewBar(OFF, on, ROUND), { tickets: 4, convincedOff: 1, convincedOn: 3, better: true, roundsSaved: 2, savedTokens: 4_000_000, reviews: 6, reviewed: 3,
    reviewerTokens: 2_400_000, affordable: true, met: true });
  const { text, met } = barText(OFF, on, ROUND);
  assert.equal(met, true);
  assert.match(text, /^first-pass verdict: 1 → 3 convinced of 4 \(\+2\): better$/m);
  assert.match(text, /^feedback rounds saved: 2, at 2,000,000 tokens a round \(the median of 52 rounds after a run's first in the outcome log\) = 4,000,000 tokens$/m);
  assert.match(text, /^reviewer tokens of the pre-PR reviews: 2,400,000 in 6 reviews on 3 of 4 tickets: within the 4,000,000 of the rounds saved$/m);
  assert.match(text, /^A11-1 +not convinced → convinced +2 +900,000 +5,000,000 → 5,000,000$/m);
  assert.match(text, /^BAR MET: tickets\.localReview turns on by default$/m);
});

test("reviewer tokens equal to the rounds saved still meet the bar: no more than, not less than", () => {
  const on = runOf(true, [row("A11-1", "convinced", { count: 1, tokens: 2_000_000 }), row("A11-2", "convinced", { count: 0, tokens: 0 }),
    row("A11-3", "not convinced", { count: 0, tokens: 0 }), row("A11-4", null, { count: 0, tokens: 0 })]);
  assert.equal(preReviewBar(OFF, on, ROUND).met, true);
  assert.equal(preReviewBar(OFF, on, { ...ROUND, tokens: 1_999_999 }).met, false);
});

test("a miss keeps the key off and says which condition failed and by how much: a verdict no better whatever the tokens, or reviewer tokens over the rounds saved", () => {
  const cases = [{
    on: runOf(true, [row("A11-1", "not convinced", { count: 1, tokens: 1 }), row("A11-2", "convinced", { count: 1, tokens: 1 }),
      row("A11-3", "not convinced", { count: 1, tokens: 1 }), row("A11-4", "not convinced", { count: 1, tokens: 1 })]),
    says: [/^first-pass verdict: 1 → 1 convinced of 4 \(\+0\): NOT better, 1 more convinced needed$/m, /^feedback rounds saved: 0, .* = 0 tokens$/m],
  }, {
    on: runOf(true, [row("A11-1", "convinced", { count: 4, tokens: 2_500_000 }), row("A11-2", "convinced", { count: 1, tokens: 0 }),
      row("A11-3", "not convinced", { count: 0, tokens: 0 }), row("A11-4", null, { count: 0, tokens: 0 })]),
    says: [/^first-pass verdict: 1 → 2 convinced of 4 \(\+1\): better$/m,
      /^reviewer tokens of the pre-PR reviews: 2,500,000 in 5 reviews on 2 of 4 tickets: 500,000 MORE than the 2,000,000 of the rounds saved$/m],
  }];
  for (const { on, says } of cases) {
    const { text, met } = barText(OFF, on, ROUND);
    assert.equal(met, false);
    for (const line of [...says, /^BAR MISSED: tickets\.localReview stays off$/m]) assert.match(text, line);
  }
});

test("an unknown reviewer total, a ticket the on run did not record, or a lost convinced ticket never helps the bar", () => {
  const unknown = runOf(true, [row("A11-1", "convinced", { count: 1, tokens: null }), row("A11-2", "convinced", { count: 0, tokens: 0 }), row("A11-3", "convinced", { count: 0, tokens: 0 })]);
  assert.equal(preReviewBar(OFF, unknown, ROUND).affordable, false);
  assert.match(barText(OFF, unknown, ROUND).text, /unknown \(a review's tokens could not be read\) .*: NOT shown to be within the rounds saved$/m);
  const unrecorded = runOf(true, [row("A11-1", "convinced"), row("A11-2", "convinced", { count: 0, tokens: 0 })]);
  assert.equal(preReviewBar(OFF, unrecorded, ROUND).reviewerTokens, null, "a run stored before reviews were kept has no reviewer total");
  const lost = runOf(true, [row("A11-1", "not convinced", { count: 1, tokens: 0 }), row("A11-2", "not convinced", { count: 1, tokens: 0 })]);
  assert.deepEqual([preReviewBar(OFF, lost, ROUND).roundsSaved, preReviewBar(OFF, lost, ROUND).tickets], [0, 2], "a net loss saves no round, and only shared tickets count");
});

test("only the key's off run and on run, at one committed sha, are set against the bar", () => {
  const on = runOf(true, [row("A11-1", "convinced", { count: 1, tokens: 1 })]);
  assert.throws(() => preReviewBar(on, OFF, ROUND), /needs a run with tickets\.localReview=off, then one with tickets\.localReview=on/);
  assert.throws(() => preReviewBar(runOf(false, [], { key: { name: "tickets.drafts", on: false } }), on, ROUND), /needs a run with tickets\.localReview=off/);
  assert.throws(() => preReviewBar(runOf(false, [], { key: null }), on, ROUND), /needs a run with tickets\.localReview=off/);
  assert.throws(() => preReviewBar(runOf(false, [], { sha: "0d450e9".padEnd(40, "0") }), on, ROUND), /different shas \(0d450e9 and a1b2c3d\)/);
  assert.throws(() => preReviewBar(OFF, runOf(true, [], { dirty: true }), ROUND), /uncommitted changes/);
  assert.throws(() => preReviewBar(OFF, runOf(true, [], { model: "sonnet" }), ROUND), /different workers \(opus at medium, sonnet at medium\)/);
  assert.throws(() => preReviewBar(OFF, runOf(true, [], { effort: "high" }), ROUND), /different workers/);
});

test("a run the token cap stopped is named, and the bar is over the tickets both ran", () => {
  const on = runOf(true, [row("A11-1", "convinced", { count: 1, tokens: 1 })], { stopped: { ran: 1, of: 4, tokens: 9, cap: 9, notStarted: ["A11-2", "A11-3", "A11-4"] } });
  const { text } = barText(OFF, on, ROUND);
  assert.match(text, /^the on run was stopped by the token cap after 1 of 4 tickets: the bar is over the tickets both ran$/m);
  assert.match(text, /^first-pass verdict: 0 → 1 convinced of 1 /m);
});

const tokens = (input: number) => ({ "claude-opus-5-5": { input, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } });
const round = (input: number | null) => ({ startedAt: 0, endedAt: 1, outcome: "reviewed", ...(input === null ? { unread: "x" } : { tokens: tokens(input) }) });
const record = (run: string, rounds: ReturnType<typeof round>[]): OutcomeRecord =>
  ({ v: 1, run, ticket: "A11-1", model: "opus", effort: "medium", repos: [], labels: [], prs: [], at: 0, rounds, final: "ready-pr", needsYou: 0, wallMs: 0, tokens: {} }) as unknown as OutcomeRecord;

test("a feedback round costs the median of every run's rounds after its first whose tokens were read; a log with none refuses", () => {
  assert.deepEqual(feedbackRoundTokens([record("a", [round(90_000_000), round(3), round(1)]), record("b", [round(50), round(null), round(2)])]), { tokens: 2, rounds: 3 },
    "first rounds and unread rounds are left out");
  assert.deepEqual(feedbackRoundTokens([record("a", [round(9), round(2), round(5)])]), { tokens: 4, rounds: 2 }, "an even count takes the mean of the middle two, rounded");
  assert.throws(() => feedbackRoundTokens([record("a", [round(9)])]), /holds no round after a run's first/);
});
