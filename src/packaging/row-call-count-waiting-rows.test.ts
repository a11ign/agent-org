// no-token: GH_READS -- #3384. Importing anything from `work-gate.mjs` reaches `defaultRun` (`execFileSync("gh", ...)`), and this file never lets it
// run: `rowCallCountSignals` is handed an injected `waitClearedAt` and `readWaitClearedAt` an injected `run`.
/**
 * #3384: THE CALL-COUNT SIGNAL AUDITS A ROW THAT IS ONLY WAITING. #2905's one open item was a word from the chairman, and a standing seat
 * holding it kept working on other things, so the row's count climbed through the whole wait and cost `product-manager` three audits.
 *
 * A row that declares a wait is left out; a row whose wait has been lifted is counted from the lifting. Every case runs a row WITH the
 * wait and the same row WITHOUT it, so a predicate that excludes nothing (or everything) cannot pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rowCallCountSignals, ROW_CALL_COUNT_SPLIT_THRESHOLD } from "../work-gate.mjs";
import { readWaitClearedAt, rowDeclaresWait } from "../work-gate/row-call-count-orders.mjs";
import { CLAIM_RECORD_MARKER } from "../claim-labels.mjs";

const SESSION = "orchestrator";
const CLAIMED_AT = Date.parse("2026-10-03T05:00:00Z");
const OVER = ROW_CALL_COUNT_SPLIT_THRESHOLD + 1;
const MANY = 300;

/** `n` turns of `session`, one a millisecond apart from `from`. */
const turnsFrom = (from: number, n: number, session = SESSION) =>
  Array.from({ length: n }, (_, i) => ({ session, at: from + i })) as any[];

const claimRecord = (row: number, session = SESSION, at = CLAIMED_AT) => ({ number: row, comments: [
  { body: `${CLAIM_RECORD_MARKER}\n**Claim record** -- claimed by \`${session}\`.`, createdAt: new Date(at).toISOString() }] });

/** A claimed row, plus whatever makes it wait. */
const claimedRow = (number: number, extra: { labels?: string[], body?: string, blockedBy?: any } = {}) => ({
  number, body: extra.body ?? "", blockedBy: extra.blockedBy ?? { nodes: [] },
  labels: ["in-progress", `session:${SESSION}`, ...(extra.labels ?? [])].map((name) => ({ name })),
});

const neverCleared = () => 0;

/** The row with `wait` is silent at 300 calls; the same row without it signals, at the same count. */
function assertWaitSilences(wait: Parameters<typeof claimedRow>[1]) {
  const turns = turnsFrom(CLAIMED_AT + 1, MANY);
  assert.deepEqual(rowCallCountSignals([claimedRow(1, wait)], turns, [claimRecord(1)], { waitClearedAt: neverCleared }), []);
  assert.deepEqual(rowCallCountSignals([claimedRow(1)], turns, [claimRecord(1)], { waitClearedAt: neverCleared }),
    [{ row: 1, session: SESSION, calls: MANY }], "positive control: with no wait the same row signals");
}

test("(1) a claimed row labelled needs:chairman with 300 calls yields no signal; the same row without the label does", () => {
  assertWaitSilences({ labels: ["needs:chairman"] });
});

test("(2) the other waits the gate already reads each silence it too", () => {
  assertWaitSilences({ blockedBy: { nodes: [{ number: 9, state: "OPEN" }] } });
  assertWaitSilences({ body: "Not-before: 2999-01-01" });
  assertWaitSilences({ labels: ["answer:ceo"] });
  assertWaitSilences({ labels: ["parked"] });
  assertWaitSilences({ labels: ["blocked"] });
  assertWaitSilences({ labels: ["hold:chairman"] });
});

test("(2) a wait that has ENDED is no wait: a closed blocker and a past Not-before do not silence", () => {
  const now = Date.now();
  assert.equal(rowDeclaresWait(claimedRow(1, { blockedBy: { nodes: [{ number: 9, state: "CLOSED" }] } }), now), false);
  assert.equal(rowDeclaresWait(claimedRow(1, { body: "Not-before: 2020-01-01" }), now), false);
  assert.equal(rowDeclaresWait(claimedRow(1), now), false);
});

test("(3) a row whose wait CLEARED is counted from the clearing: 300 calls during the wait do not signal, 101 after do", () => {
  const clearedAt = CLAIMED_AT + 10_000;
  const during = turnsFrom(CLAIMED_AT + 1, MANY);
  const after = turnsFrom(clearedAt + 1, OVER);
  const options = { waitClearedAt: () => clearedAt };
  assert.deepEqual(rowCallCountSignals([claimedRow(1)], during, [claimRecord(1)], options), [],
    "300 calls, every one before the wait cleared");
  assert.deepEqual(rowCallCountSignals([claimedRow(1)], [...during, ...after], [claimRecord(1)], options),
    [{ row: 1, session: SESSION, calls: OVER }], "101 after the clearing signal, and the 300 before it are not added");
});

test("a clearing that cannot be read keeps today's whole window, and says so on stderr", () => {
  const turns = turnsFrom(CLAIMED_AT + 1, MANY);
  assert.deepEqual(rowCallCountSignals([claimedRow(1)], turns, [claimRecord(1)], { waitClearedAt: () => null }),
    [{ row: 1, session: SESSION, calls: MANY }]);
  const lines: string[] = [];
  const original = console.error;
  console.error = (m: string) => { lines.push(String(m)); };
  try {
    const refusing = () => { throw new Error("HTTP 403"); };
    assert.equal(readWaitClearedAt(claimedRow(7), refusing), null);
  } finally { console.error = original; }
  assert.match(lines.join("\n"), /#7.*HTTP 403.*counting from the claim/);
});

test("the clearing is read ONCE, and only for a row over the threshold that declares no wait", () => {
  const asked: number[] = [];
  const options = { waitClearedAt: (row: any) => { asked.push(row.number); return 0; } };
  const rows = [claimedRow(1), claimedRow(2, { labels: ["needs:chairman"] }), claimedRow(3)];
  const comments = [claimRecord(1, "a"), claimRecord(2, "b"), claimRecord(3, "c")];
  const turns = [...turnsFrom(CLAIMED_AT + 1, MANY, "a"), ...turnsFrom(CLAIMED_AT + 1, MANY, "b"), ...turnsFrom(CLAIMED_AT + 1, 5, "c")];
  const rowsOf = rows.map((r, i) => ({ ...r, labels: [{ name: "in-progress" }, { name: `session:${"abc"[i]}` }, ...r.labels.slice(2)] }));
  rowCallCountSignals(rowsOf, turns, comments, options);
  assert.deepEqual(asked, [1], "row 2 waits and row 3 is at 5 calls: neither pays the read");
});

test("a waiting row still ends the window of the same session's EARLIER row when it is claimed later", () => {
  const laterClaim = CLAIMED_AT + 1_000;
  const turns = [...turnsFrom(CLAIMED_AT + 1, OVER), ...turnsFrom(laterClaim + 1, MANY)];
  const rows = [claimedRow(1), claimedRow(2, { labels: ["needs:chairman"] })];
  const comments = [claimRecord(1), claimRecord(2, SESSION, laterClaim)];
  assert.deepEqual(rowCallCountSignals(rows, turns, comments, { waitClearedAt: neverCleared }),
    [{ row: 1, session: SESSION, calls: OVER }], "the 300 calls after row 2 was claimed are not row 1's, though row 2 is left out");
});

test("readWaitClearedAt: the latest lifting of a WAIT label, a passed Not-before, and nothing for other labels", () => {
  const events = (...e: { name: string, at: string }[]) => () => e.map((x) => JSON.stringify(x)).join("\n");
  const lifted = events({ name: "needs:chairman", at: "2026-10-03T12:00:00Z" }, { name: "parked", at: "2026-10-03T13:00:00Z" },
    { name: "epic", at: "2026-10-03T23:00:00Z" });
  assert.equal(readWaitClearedAt(claimedRow(1), lifted), Date.parse("2026-10-03T13:00:00Z"),
    "the later wait label wins and the unlabeled `epic` is not a wait");
  assert.equal(readWaitClearedAt(claimedRow(1), events({ name: "epic", at: "2026-10-03T23:00:00Z" })), 0, "no wait ever lifted: 0, not null");
  assert.equal(readWaitClearedAt(claimedRow(1, { body: "Not-before: 2026-10-03T14:00:00Z" }), lifted), Date.parse("2026-10-03T14:00:00Z"),
    "a Not-before that has passed is the clearing when it is the latest");
});

test("the tick's own call passes `readWaitClearedAt`, because the default reads nothing", () => {
  const source = readFileSync(new URL("../work-gate.mjs", import.meta.url), "utf8");
  assert.match(source, /rowCallCountSignals\(allOpen, liveClaudeTurns\(\), claimedComments, \{ waitClearedAt: readWaitClearedAt \}\)/);
  assert.deepEqual(rowCallCountSignals([claimedRow(1)], turnsFrom(CLAIMED_AT + 1, MANY), [claimRecord(1)]),
    [{ row: 1, session: SESSION, calls: MANY }], "positive control: called without it, the whole window from the claim counts");
});
