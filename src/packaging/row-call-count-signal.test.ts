// no-token: gh -- this file imports only `claimedRowSession`/`rowCallCountSignals`/`rowCallCountOrders`
// from `work-gate.mjs`, three pure functions that never call or spawn `gh`; the token charge belongs to
// the rest of that file's exports, which this test never reaches.
// #2691: the chairman's token-efficiency reading (#928) asks for a LIVE signal, read from the transcripts
// the org already writes, naming a claimed row whose session has passed ~100 calls -- a split CANDIDATE
// for `product-manager`'s judgement, never an automatic split. The read reuses `token-audit.mjs`'s own
// `claudeTurns`/`transcriptFiles`/`summarise` (the same three `split-baseline.mjs` already imports) rather
// than a second transcript parser.
//
// Every case is run against a fixture with the fault PRESENT and one without it, so a checker that finds
// nothing to check cannot pass (the emptiness's positive control).
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeTurns } from "../token-audit.mjs";
import { claimedRowSession, rowCallCountSignals, rowCallCountOrders, ROW_CALL_COUNT_SPLIT_THRESHOLD }
  from "../work-gate.mjs";

/** One usage line, with a unique `id` so `claudeTurns`'s dedup (`message.id`) counts it once. */
function callLine(id: string, ts: string) {
  return JSON.stringify({ timestamp: ts, message: { id, model: "m", usage: {
    input_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1, output_tokens: 1,
  } } });
}

/** A transcript naming `session` (via the wake prompt's own words) with `n` distinct calls in it. */
function transcriptOf(session: string, n: number) {
  const wake = JSON.stringify({ type: "user", message: { role: "user",
    content: `You are \`${session}\`, an org session in this repository.` } });
  const calls = Array.from({ length: n }, (_, i) => callLine(`${session}-${i}`, "2026-09-27T10:00:00Z"));
  return [wake, ...calls].join("\n");
}

const rowFixture = (number: number, session: string) =>
  ({ number, labels: [{ name: "in-progress" }, { name: `session:${session}` }] });

test("positive control: a session over the threshold is reported, one at or under it is not", () => {
  const over = ROW_CALL_COUNT_SPLIT_THRESHOLD + 12;
  const under = 5;
  const turns = [
    ...claudeTurns(transcriptOf("worker-501", over)),
    ...claudeTurns(transcriptOf("worker-502", under)),
  ];
  const openRows = [rowFixture(501, "worker-501"), rowFixture(502, "worker-502")];
  const signals = rowCallCountSignals(openRows, turns);
  assert.deepEqual(signals, [{ row: 501, session: "worker-501", calls: over }],
    "the row over the threshold is named; the row at 5 calls is left out entirely, not reported as 0");
});

test("exactly at the threshold is not a split candidate -- the comparison is strictly greater-than", () => {
  const turns = claudeTurns(transcriptOf("worker-503", ROW_CALL_COUNT_SPLIT_THRESHOLD));
  const signals = rowCallCountSignals([rowFixture(503, "worker-503")], turns);
  assert.deepEqual(signals, [], "a row AT the threshold is not yet past it");
});

test("a row with no session label, or more than one, is left out rather than guessed at", () => {
  const turns = claudeTurns(transcriptOf("worker-504", ROW_CALL_COUNT_SPLIT_THRESHOLD + 1));
  const noLabel = { number: 504, labels: [{ name: "in-progress" }] };
  const twoLabels = { number: 505, labels: [{ name: "session:worker-504" }, { name: "session:worker-999" }] };
  assert.equal(claimedRowSession(noLabel), null);
  assert.equal(claimedRowSession(twoLabels), null);
  assert.deepEqual(rowCallCountSignals([noLabel, twoLabels], turns), []);
});

test("a row not in the open population contributes nothing, even with a high-call session", () => {
  const turns = claudeTurns(transcriptOf("worker-506", ROW_CALL_COUNT_SPLIT_THRESHOLD + 50));
  assert.deepEqual(rowCallCountSignals([], turns), [], "no open rows means no candidate, whatever the transcript says");
});

test("rowCallCountOrders: empty signals emit nothing, and the order addresses product-manager as a judgment", () => {
  assert.deepEqual(rowCallCountOrders([]), []);
  const [order] = rowCallCountOrders([{ row: 501, session: "worker-501", calls: 112 }]);
  assert.equal(order.session, "product-manager");
  assert.equal(order.cause, "row-call-count-signal");
  assert.match(order.prompt, /#501/);
  assert.match(order.prompt, /112/);
  assert.match(order.prompt, /signal, not an automatic split/);
});

test("the causeKey carries the count, so a climbing or clearing row is a new question", () => {
  const first = rowCallCountOrders([{ row: 501, session: "worker-501", calls: 112 }])[0];
  const climbed = rowCallCountOrders([{ row: 501, session: "worker-501", calls: 130 }])[0];
  const again = rowCallCountOrders([{ row: 501, session: "worker-501", calls: 112 }])[0];
  assert.notEqual(first.causeKey, climbed.causeKey, "a changed count is a new question");
  assert.equal(first.causeKey, again.causeKey, "an unchanged count mints the same key");
});
