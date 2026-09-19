// A WAITING CONDITION IS DATA, NOT PROSE.
//
// Measured 2026-09-19: 0 open rows carried a machine-readable blocker, 5 stated one in prose. The gate is
// a pure function of what GitHub RECORDS, and every session writes its conclusions as sentences -- so the
// org can act on what it is told and cannot act on anything it learns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { waitingOn, notBeforeDate, todayIso, describeWaiting, proseBlockers }
  from "../waiting-condition.mjs";

test("an OPEN blocker is a wait; a CLOSED one is a wait that has cleared", () => {
  // THE WHOLE POINT. `orchestrator` wrote "blocked by #1772" in a comment at 16:39; #1772 closed at
  // 17:43; nothing connected the two and it sat idle for 64 minutes with a healthy fleet.
  const blocked = { blockedBy: { nodes: [{ number: 1772, state: "OPEN" }] } };
  assert.deepEqual(waitingOn(blocked, "2026-09-19"), { kind: "row", numbers: [1772] });

  const cleared = { blockedBy: { nodes: [{ number: 1772, state: "CLOSED" }] } };
  assert.equal(waitingOn(cleared, "2026-09-19"), null,
    "a closed blocker is a condition that HAS cleared -- reading it as still blocking is the rot");
});

test("a future date is a wait; today and the past are not", () => {
  // `ceo` wrote "no need to re-check before tomorrow's 07:10 fire" on #1234 -- a row gated on wall-clock
  // time -- and the cause re-fired 2h later regardless, for about 18 more identical wakes.
  const row = { body: "## What it is\n\nNot-before: 2026-09-21\n\nmore text" };
  assert.deepEqual(waitingOn(row, "2026-09-19"), { kind: "date", date: "2026-09-21" });
  assert.equal(waitingOn(row, "2026-09-21"), null, "the day itself is not 'before' it");
  assert.equal(waitingOn(row, "2026-09-22"), null);
});

test("a MALFORMED date fails OPEN -- a typo must not hide a row silently", () => {
  // Hiding on a value we could not parse is the one direction with no witness: the row vanishes and
  // nobody learns why until a human reads the body. Fail open and someone finds it.
  for (const bad of ["Not-before: tomorrow", "Not-before: 21-09-2026", "Not-before:", "Not-before: 2026-9-1"]) {
    assert.equal(notBeforeDate(`x\n${bad}\ny`), null, `"${bad}" must not parse`);
    assert.equal(waitingOn({ body: `x\n${bad}\ny` }, "2026-09-19"), null);
  }
});

test("the field is anchored to its own line, so prose ABOUT it is not a declaration", () => {
  // The `Closes:` parser learned this the expensive way (#549): a body explaining the convention matched
  // its own regex. A row discussing `Not-before:` must not thereby acquire one.
  assert.equal(notBeforeDate("we should add a `Not-before: 2026-09-21` line to this row"), null,
    "mentioned mid-sentence is a discussion, not a declaration");
  assert.equal(notBeforeDate("Not-before: 2026-09-21"), "2026-09-21");
  assert.equal(notBeforeDate("not-before: 2026-09-21"), "2026-09-21", "case-insensitive on the key");
});

test("a row with NEITHER waits on nothing", () => {
  assert.equal(waitingOn({}, "2026-09-19"), null);
  assert.equal(waitingOn({ blockedBy: { nodes: [] }, body: "no field here" }, "2026-09-19"), null);
});

test("an open blocker outranks a date, because it is the nearer answer", () => {
  const both = { blockedBy: { nodes: [{ number: 9, state: "OPEN" }] }, body: "Not-before: 2026-12-01" };
  assert.deepEqual(waitingOn(both, "2026-09-19"), { kind: "row", numbers: [9] },
    "report the blocker a reader can act on, not the date they cannot");
});

test("every wait says what it waits on, in words a person can check", () => {
  // A report that says "waiting" without saying for what is the `blocked` label again.
  assert.equal(describeWaiting({ kind: "row", numbers: [1772, 9] }), "blocked by #1772, #9");
  assert.equal(describeWaiting({ kind: "date", date: "2026-09-21" }), "not before 2026-09-21");
});

test("today is the alphabet the field is written in", () => {
  assert.match(todayIso(new Date("2026-09-19T23:59:00Z")), /^2026-09-19$/);
  assert.match(todayIso(), /^\d{4}-\d{2}-\d{2}$/);
});

/**
 * THE WITNESS FOR THE RULE, without which the fix IS the defect.
 *
 * `agent-practices.md` now says a waiting condition goes in a field rather than a sentence -- and that
 * instruction is itself a sentence, in a document nothing checks. This repository has proved twice that
 * it cannot keep such a rule by habit: `/clear` was one until `wake.mjs` mechanised it, and the
 * author-prompt path then bypassed even that. A rule with no witness decays to the state it was written
 * to fix.
 */
test("a row stating a wait only in prose is named", () => {
  const rows = [{ number: 72, body: "Blocked on npmjs granting the scope.", blockedBy: { totalCount: 0 } }];
  assert.deepEqual(proseBlockers(rows), [{ number: 72, quote: "Blocked on npmjs granting the scope" }]);
});

test("a row that records it as DATA is not named -- either mechanism satisfies the rule", () => {
  // Both must count, or the check would nag rows that have already done the right thing -- which is how
  // a witness stops being read.
  const byEdge = [{ number: 68, body: "Blocked on ADR 0036 (#67)", blockedBy: { totalCount: 1 } }];
  const byDate = [{ number: 1234, body: "Not-before: 2026-09-21\nblocked by this until then",
    blockedBy: { totalCount: 0 } }];
  assert.deepEqual(proseBlockers(byEdge), []);
  assert.deepEqual(proseBlockers(byDate), []);
});

test("a row that says nothing about waiting is not named", () => {
  assert.deepEqual(proseBlockers([{ number: 1, body: "Ordinary row.", blockedBy: { totalCount: 0 } }]), []);
  assert.deepEqual(proseBlockers([]), []);
  assert.deepEqual(proseBlockers(undefined as never), []);
});

test("it is a SMELL, not a verdict, and the quote is what makes that usable", () => {
  // A row may legitimately DISCUSS blocking -- this very test does. So the check hands a reader the
  // sentence and lets them decide in ten seconds, rather than refusing anything.
  const discussing = [{ number: 2, blockedBy: { totalCount: 0 },
    body: "This row is about rows that are blocked by other rows and how we record that." }];
  const [found] = proseBlockers(discussing);
  assert.equal(found.number, 2);
  assert.match(found.quote, /blocked by other rows/,
    "the quote must carry enough for the reader to dismiss it without opening the row");
});
