import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { tmpDir } from "../../lib/tmp-fixture.ts";
import { batchShare, inputOutputOf, readTurns, roundTokens, type Turn } from "./round-tokens.ts";

const record = (id: string, at: number, usage: Record<string, number>, model = "claude-opus-5-5") =>
  JSON.stringify({ type: "assistant", timestamp: new Date(at).toISOString(), message: { id, model, usage } });

function transcript(lines: readonly string[]): string {
  const file = join(tmpDir("round-tokens-"), "s.jsonl");
  writeFileSync(file, lines.join("\n"));
  return file;
}

const tokens = (input: number, output: number, cacheRead = 0) => ({ input, output, cacheRead, cacheWrite5m: 0, cacheWrite1h: 0 });

test("a message written once per content block is one turn, read from its last block", () => {
  const file = transcript([
    record("m1", 10, { input_tokens: 5, output_tokens: 1 }),
    JSON.stringify({ type: "user", message: { content: "a tool result with \"usage\" in its text" } }),
    record("m1", 20, { input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 9 }),
    record("m2", 30, { input_tokens: 1, output_tokens: 2 }, "claude-sonnet-5-5"),
    "{\"type\":\"assistant\",\"message\":{\"usage\":", // a live transcript's half-written last line
  ]);
  const read = readTurns(file);
  assert.ok("turns" in read);
  assert.deepEqual(read.turns.map(({ id, at, model, tokens: spent }) => [id, at, model, spent.output]), [["m1", 20, "claude-opus-5-5", 9], ["m2", 30, "claude-sonnet-5-5", 2]]);
});

test("a transcript that is missing, or has a line that is not JSON before its end, is unreadable, never 0", () => {
  const none = readTurns(null);
  assert.match("unreadable" in none ? none.unreadable : "", /no transcript was found/);
  const missing = readTurns("/nowhere/s.jsonl");
  assert.match("unreadable" in missing ? missing.unreadable : "", /is missing/);
  const broken = readTurns(transcript(["{\"usage\": nope", record("m1", 10, { input_tokens: 1, output_tokens: 1 })]));
  assert.match("unreadable" in broken ? broken.unreadable : "", /line 1 of its transcript .* is not JSON/);
  const brokenWithoutUsage = readTurns(transcript(["not-json", record("m1", 10, { input_tokens: 1, output_tokens: 1 })]));
  assert.match("unreadable" in brokenWithoutUsage ? brokenWithoutUsage.unreadable : "", /line 1 of its transcript .* is not JSON/, "a broken line that names no usage still makes the transcript unreadable");
});

test("a round counts only the turns written after the previous round ended", () => {
  const turns: Turn[] = [
    { id: "m1", at: 10, model: "a", tokens: tokens(1, 1) },
    { id: "m2", at: 20, model: "a", tokens: tokens(2, 2) },
    { id: "m3", at: 30, model: "b", tokens: tokens(4, 4) },
    { id: "m4", at: Number.NaN, model: "a", tokens: tokens(8, 8) },
  ];
  assert.deepEqual(roundTokens(turns, undefined), { a: tokens(11, 11), b: tokens(4, 4) }, "the first round takes every turn, one with no time too");
  assert.deepEqual(roundTokens(turns, 20), { b: tokens(4, 4) }, "a later round takes none an earlier one counted");
  assert.deepEqual(roundTokens(turns, 30), {});
});

test("a batch's shares are whole tokens, the remainder one each to the first tickets, and add up to the run's", () => {
  const run = { a: tokens(10, 7, 101) };
  const shares = [0, 1, 2].map((index) => batchShare(run, index, 3).a);
  assert.deepEqual(shares.map((share) => [share?.input, share?.output, share?.cacheRead]), [[4, 3, 34], [3, 2, 34], [3, 2, 33]]);
  assert.deepEqual(inputOutputOf({ a: tokens(10, 7, 101) }), { input: 111, output: 7 });
});
