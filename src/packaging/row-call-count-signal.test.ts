// no-token: gh -- this file imports only `claimedRowSession`/`rowCallCountSignals`/`rowCallCountOrders`
// from `work-gate.mjs`, three pure functions that never call or spawn `gh`; `claudeTurns` from
// `token-audit.mjs` and `CLAIM_RECORD_MARKER` from `claim-labels.mjs` are pure, leaf modules for the same
// reason. The token charge belongs to the rest of `work-gate.mjs`'s exports, which this test never reaches.
// #2691: the chairman's token-efficiency reading (#928) asks for a LIVE signal, read from the transcripts
// the org already writes, naming a claimed row whose session has passed ~100 calls -- a split CANDIDATE
// for `product-manager`'s judgement, never an automatic split. The read reuses `token-audit.mjs`'s own
// `claudeTurns`/`transcriptFiles`/`summarise` (the same three `split-baseline.mjs` already imports) rather
// than a second transcript parser.
// #2710: the count is now WINDOWED to calls made while a row was actually held -- from its own claim
// record's `createdAt` up to whichever comes first, now or the same session's NEXT claim -- rather than
// the claiming session's whole lifetime. A STANDING seat (`ceo`, `orchestrator`, `product-manager`) holds
// several rows in sequence or at once; without the window, every row it holds reports the identical
// lifetime total, which is the live defect this file's newest cases pin.
//
// Every case is run against a fixture with the fault PRESENT and one without it, so a checker that finds
// nothing to check cannot pass (the emptiness's positive control).
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeTurns } from "../token-audit.mjs";
import { claimedRowSession, rowCallCountSignals, rowCallCountOrders, ROW_CALL_COUNT_SPLIT_THRESHOLD }
  from "../work-gate.mjs";
import { CLAIM_RECORD_MARKER } from "../claim-labels.mjs";

/** One usage line, with a unique `id` so `claudeTurns`'s dedup (`message.id`) counts it once. */
function callLine(id: string, ts: string) {
  return JSON.stringify({ timestamp: ts, message: { id, model: "m", usage: {
    input_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1, output_tokens: 1,
  } } });
}

/** A transcript naming `session` (via the wake prompt's own words), one call per given timestamp. */
function transcriptOf(session: string, timestamps: string[]) {
  const wake = JSON.stringify({ type: "user", message: { role: "user",
    content: `You are \`${session}\`, an org session in this repository.` } });
  const calls = timestamps.map((ts, i) => callLine(`${session}-${i}`, ts));
  return [wake, ...calls].join("\n");
}

/** `n` distinct calls, all at the same instant -- close enough for a case that only counts them. */
const sameInstant = (n: number, ts = "2026-09-27T10:00:00Z") => Array.from({ length: n }, () => ts);

const rowFixture = (number: number, session: string) =>
  ({ number, labels: [{ name: "in-progress" }, { name: `session:${session}` }] });

/** The claim-record comment `row-claim.mjs` posts on a claim, minimal but real enough for `claimRecordOf`
 * (`claim-stall.mjs`) to read: the marker, and "-- claimed by `<session>`" on the same body. */
const claimRecordComment = (session: string, at: string) =>
  ({ body: `${CLAIM_RECORD_MARKER}\n**Claim record** -- claimed by \`${session}\`.`, createdAt: at });

/** `readClaimedRowComments`'s own shape (`{ number, comments }[]`) -- one entry per row, its claim record
 * comment among them, exactly what the gate hands `rowCallCountSignals` today. */
const claimedComments = (...entries: { row: number, session: string, at: string }[]) =>
  entries.map(({ row, session, at }) => ({ number: row, comments: [claimRecordComment(session, at)] }));

test("positive control: a session over the threshold is reported, one at or under it is not", () => {
  const over = ROW_CALL_COUNT_SPLIT_THRESHOLD + 12;
  const under = 5;
  const turns = [
    ...claudeTurns(transcriptOf("worker-501", sameInstant(over))),
    ...claudeTurns(transcriptOf("worker-502", sameInstant(under))),
  ];
  const openRows = [rowFixture(501, "worker-501"), rowFixture(502, "worker-502")];
  const comments = claimedComments(
    { row: 501, session: "worker-501", at: "2026-09-27T09:00:00Z" },
    { row: 502, session: "worker-502", at: "2026-09-27T09:00:00Z" },
  );
  const signals = rowCallCountSignals(openRows, turns, comments);
  assert.deepEqual(signals, [{ row: 501, session: "worker-501", calls: over }],
    "the row over the threshold is named; the row at 5 calls is left out entirely, not reported as 0");
});

test("exactly at the threshold is not a split candidate -- the comparison is strictly greater-than", () => {
  const turns = claudeTurns(transcriptOf("worker-503", sameInstant(ROW_CALL_COUNT_SPLIT_THRESHOLD)));
  const comments = claimedComments({ row: 503, session: "worker-503", at: "2026-09-27T09:00:00Z" });
  const signals = rowCallCountSignals([rowFixture(503, "worker-503")], turns, comments);
  assert.deepEqual(signals, [], "a row AT the threshold is not yet past it");
});

test("a row with no session label, or more than one, is left out rather than guessed at", () => {
  const turns = claudeTurns(transcriptOf("worker-504", sameInstant(ROW_CALL_COUNT_SPLIT_THRESHOLD + 1)));
  const noLabel = { number: 504, labels: [{ name: "in-progress" }] };
  const twoLabels = { number: 505, labels: [{ name: "session:worker-504" }, { name: "session:worker-999" }] };
  assert.equal(claimedRowSession(noLabel), null);
  assert.equal(claimedRowSession(twoLabels), null);
  assert.deepEqual(rowCallCountSignals([noLabel, twoLabels], turns), []);
});

test("a row not in the open population contributes nothing, even with a high-call session", () => {
  const turns = claudeTurns(transcriptOf("worker-506", sameInstant(ROW_CALL_COUNT_SPLIT_THRESHOLD + 50)));
  assert.deepEqual(rowCallCountSignals([], turns), [], "no open rows means no candidate, whatever the transcript says");
});

test("#2710: a row whose claim record cannot be read is left out, not guessed at", () => {
  const over = ROW_CALL_COUNT_SPLIT_THRESHOLD + 20;
  const turns = claudeTurns(transcriptOf("worker-507", sameInstant(over)));
  const openRows = [rowFixture(507, "worker-507")];
  assert.deepEqual(rowCallCountSignals(openRows, turns, []), [],
    "no claimed-row-comments entry for the row means no window to charge it against");
  assert.deepEqual(rowCallCountSignals(openRows, turns, [{ number: 507, comments: [] }]), [],
    "an entry present but carrying no claim-record comment reads the same as no entry at all");
});

test("#2710: calls made before the row's own claim are never charged to it", () => {
  const before = "2026-09-27T07:00:00Z";
  const claimedAt = "2026-09-27T09:00:00Z";
  const after = "2026-09-27T10:00:00Z";
  const preClaim = sameInstant(50, before);
  const postClaim = sameInstant(ROW_CALL_COUNT_SPLIT_THRESHOLD + 1, after);
  const turns = claudeTurns(transcriptOf("worker-508", [...preClaim, ...postClaim]));
  const comments = claimedComments({ row: 508, session: "worker-508", at: claimedAt });
  const signals = rowCallCountSignals([rowFixture(508, "worker-508")], turns, comments);
  assert.deepEqual(signals, [{ row: 508, session: "worker-508", calls: ROW_CALL_COUNT_SPLIT_THRESHOLD + 1 }],
    "the 50 calls made before the claim record's own createdAt never enter the count");
});

test("#2710: a standing seat holding two rows at once gets two DIFFERENT counts, never the same total on both", () => {
  // The live shape (row body, 2026-09-27): one session (here `orchestrator`, matching the real incident)
  // claims row A, accumulates calls past the threshold, THEN claims row B while still holding A, and makes
  // a few more calls. Today's code (pre-#2710) reports the SAME combined session total on both rows.
  const aClaimedAt = "2026-09-27T12:00:00Z";
  const beforeBClaimed = "2026-09-27T12:30:00Z"; // after A's claim, before B's
  const bClaimedAt = "2026-09-27T13:00:00Z";
  const afterBClaimed = "2026-09-27T13:30:00Z"; // after B's claim too

  const pastThreshold = sameInstant(ROW_CALL_COUNT_SPLIT_THRESHOLD + 50, beforeBClaimed);
  const fewMoreAfterB = sameInstant(ROW_CALL_COUNT_SPLIT_THRESHOLD + 5, afterBClaimed);
  const turns = claudeTurns(transcriptOf("orchestrator", [...pastThreshold, ...fewMoreAfterB]));

  const openRows = [rowFixture(2662, "orchestrator"), rowFixture(2657, "orchestrator")];
  const comments = claimedComments(
    { row: 2662, session: "orchestrator", at: aClaimedAt },
    { row: 2657, session: "orchestrator", at: bClaimedAt },
  );

  const signals = rowCallCountSignals(openRows, turns, comments);
  assert.deepEqual(signals, [
    { row: 2662, session: "orchestrator", calls: ROW_CALL_COUNT_SPLIT_THRESHOLD + 50 },
    { row: 2657, session: "orchestrator", calls: ROW_CALL_COUNT_SPLIT_THRESHOLD + 5 },
  ], "row A's window closes at row B's claim (its calls made only after B claimed are not its own), and "
    + "row B's window excludes A's pre-claim history -- the two counts differ, unlike the whole-lifetime bug");
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
