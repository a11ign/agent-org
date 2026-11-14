import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { tmpDir } from "../../lib/tmp-fixture.ts";
import { appendOutcome, latestOutcomes, outcomeRecordOf, outcomesPath, readOutcomes } from "./outcome-record.ts";

const spent = (input: number) => ({ m: { input, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } });
const subject = { ticket: "A11-1", model: "opus", effort: "high", repos: ["agent-org"], labels: ["Bug"] };

test("a run's record adds up its rounds: tokens of the rounds read, the rounds that asked a person, and the time they ran", () => {
  const record = outcomeRecordOf(subject, { since: 100, rounds: [
    { startedAt: 100, endedAt: 400, outcome: "needs-human", tokens: spent(2) },
    { startedAt: 1_000, endedAt: 1_500, outcome: "ready-pr", unread: "its transcript is missing" },
    { startedAt: 2_000, endedAt: 2_100, outcome: "reviewed", tokens: spent(3) },
  ] });
  assert.deepEqual([record.run, record.at, record.final, record.needsYou, record.wallMs, record.tokens.m?.input], ["A11-1@100", 2_100, "reviewed", 1, 900, 5]);
  assert.throws(() => outcomeRecordOf(subject, { since: 1, rounds: [] }), /has no round to record/);
});

test("the log keeps every line, a reader takes each run's latest, and a line that is not a record is an error, not empty", () => {
  const path = outcomesPath(tmpDir("outcomes-"));
  assert.deepEqual(readOutcomes(path), [], "no log yet: no runs");
  const first = outcomeRecordOf(subject, { since: 1, rounds: [{ startedAt: 1, endedAt: 2, outcome: "ready-pr", tokens: spent(1) }] });
  const second = outcomeRecordOf(subject, { since: 1, rounds: [...first.rounds, { startedAt: 3, endedAt: 4, outcome: "reviewed", tokens: spent(1) }] });
  const other = outcomeRecordOf({ ...subject, ticket: "A11-2" }, { since: 5, rounds: [{ startedAt: 5, endedAt: 6, outcome: "checked", tokens: spent(1) }] });
  for (const record of [first, other, second]) appendOutcome(path, record);
  assert.deepEqual(latestOutcomes(readOutcomes(path)).map(({ run, rounds }) => [run, rounds.length]), [["A11-1@1", 2], ["A11-2@5", 1]]);
  appendFileSync(path, "{\"v\":1}\n");
  assert.throws(() => readOutcomes(path), /line 4 of the outcome log .* is not an outcome record/);
  appendFileSync(path, "nope\n");
  assert.throws(() => readOutcomes(path), /line 4/);
});
