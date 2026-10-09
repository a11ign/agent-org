// A multi-reading row declares its schedule as DATA (#4638): the gate advances the wait itself, and no taker hand-sets the next reading.
// Fixtures only: rows, comments and the clock are literals, so nothing here reaches the network or `corpus`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextNotBefore, readingsDeclared, readingsPosted } from "./reading-schedule.ts";
import { waitingOn } from "./waiting-condition.ts";

const R1 = "2026-10-09T19:03:00Z";
const R2 = "2026-10-10T19:00:00Z";
const R3 = "2026-10-11T19:00:00Z";
const BODY = `## What it is\n\nThree daily readings.\n\nReading: 1 at ${R1}\nReading: 2 at ${R2}\nReading: 3 at ${R3}\n`;
const posted = (...ns: number[]) => ns.map((n) => ({ body: `Reading ${n} posted: 133 worktrees` }));

test("the next reading is the first declared one with no receipt, and it ADVANCES as receipts land", () => {
  assert.equal(nextNotBefore({ body: BODY, comments: [] }), R1);
  assert.equal(nextNotBefore({ body: BODY, comments: posted(1) }), R2);
  assert.equal(nextNotBefore({ body: BODY, comments: posted(1, 2) }), R3);
});

test("when the last reading is posted the wait is gone", () => {
  assert.equal(nextNotBefore({ body: BODY, comments: posted(1, 2, 3) }), null);
});

test("a receipt is by number, not by order: reading 2 posted before reading 1 leaves reading 1 owed", () => {
  assert.equal(nextNotBefore({ body: BODY, comments: posted(2) }), R1);
});

test("the readings come back in reading order whatever order the body wrote them", () => {
  const body = `Reading: 3 at ${R3}\nReading: 1 at ${R1}\nReading: 2 at ${R2}`;
  assert.deepEqual(readingsDeclared(body).map((r) => r.n), [1, 2, 3]);
});

test("a row with no Reading: line declares nothing (the control)", () => {
  assert.deepEqual(readingsDeclared("Not-before: 2026-10-10T19:00:00Z\n"), []);
  assert.equal(nextNotBefore({ body: "no schedule here", comments: posted(1) }), null);
  assert.equal(nextNotBefore({ body: null, comments: null }), null);
});

test("a malformed line FAILS OPEN: seconds and the Z are required, and a date the calendar lacks is refused", () => {
  const body = [
    "Reading: 1 at 2026-10-09",
    "Reading: 2 at 2026-10-10T19:00Z",
    "Reading: 3 at 2026-10-11T19:00:00",
    "Reading: 4 at 2026-02-31T04:00:00Z",
    `Reading: 5 at ${R3}`,
  ].join("\n");
  assert.deepEqual(readingsDeclared(body), [{ n: 5, at: R3 }]);
});

test("a repeated number keeps its FIRST line, so a later edit cannot quietly move a reading", () => {
  const body = `Reading: 1 at ${R1}\nReading: 1 at ${R3}`;
  assert.deepEqual(readingsDeclared(body), [{ n: 1, at: R1 }]);
});

test("a receipt must open its line: a quotation, a sentence about one and a different reading do not count", () => {
  const comments = [
    { body: "> Reading 1 posted" },
    { body: "I have not yet written Reading 1 posted" },
    { body: "Reading 11 posted" },
    { body: "Reading: 1 at 2026-10-09T19:03:00Z" },
  ];
  assert.deepEqual([...readingsPosted(comments)], [11]);
});

test("a receipt may sit on any line of a comment, in any case", () => {
  assert.deepEqual([...readingsPosted([{ body: "Result:\n\nreading 2 POSTED -- 99" }])], [2]);
});

test("#3870's schedule, as `Reading:` lines, at 2026-10-10T19:30Z with reading 1 taken: reading 2 is next and is already due", () => {
  const next = nextNotBefore({ body: BODY, comments: posted(1) });
  assert.equal(next, R2);
  assert.ok(Date.parse(next as string) <= Date.parse("2026-10-10T19:30:00Z"));
});

const now = Date.parse("2026-10-10T18:00:00Z");
const waiting = (row: object) => waitingOn(row, "2026-10-10", now);

test("waitingOn: the row waits until the NEXT reading, then offers itself, then waits for the one after", () => {
  assert.deepEqual(waiting({ body: BODY, comments: posted(1) }), { kind: "date", date: R2 });
  assert.equal(waitingOn({ body: BODY, comments: posted(1) }, "2026-10-10", Date.parse("2026-10-10T19:30:00Z")), null);
  assert.deepEqual(waitingOn({ body: BODY, comments: posted(1, 2) }, "2026-10-10", Date.parse("2026-10-10T19:30:00Z")), { kind: "date", date: R3 });
});

test("waitingOn: the last receipt lifts the wait, even over a stale Not-before: left in the body", () => {
  const stale = `${BODY}\nNot-before: 2099-01-01T00:00:00Z\n`;
  assert.equal(waiting({ body: stale, comments: posted(1, 2, 3) }), null);
});

test("waitingOn: the schedule supersedes a Not-before: line the last taker left behind", () => {
  const stale = `${BODY}\nNot-before: 2026-10-10T19:00:00Z\n`;
  assert.deepEqual(waiting({ body: stale, comments: posted(1, 2) }), { kind: "date", date: R3 });
});

test("waitingOn: a caller that never fetched the comments gets the Not-before: answer, unchanged", () => {
  const body = `${BODY}\nNot-before: 2026-10-10T19:00:00Z\n`;
  assert.deepEqual(waiting({ body }), { kind: "date", date: R2 });
  assert.equal(waiting({ body: BODY }), null);
});

test("waitingOn: a row with no Reading: line behaves exactly as today, comments or none (the control)", () => {
  const body = "Not-before: 2026-10-11T19:00:00Z\n";
  const expected = { kind: "date", date: "2026-10-11T19:00:00Z" };
  assert.deepEqual(waiting({ body }), expected);
  assert.deepEqual(waiting({ body, comments: posted(1, 2, 3) }), expected);
  assert.equal(waiting({ body: "nothing", comments: [] }), null);
});

test("waitingOn: an open blocker still outranks the schedule", () => {
  const row = { body: BODY, comments: posted(1), blockedBy: { nodes: [{ number: 7, state: "OPEN" }] } };
  assert.deepEqual(waiting(row), { kind: "row", numbers: [7] });
});
