// A WAITING CONDITION IS DATA, NOT PROSE.
//
// Measured 2026-09-19: 0 open rows carried a machine-readable blocker, 5 stated one in prose. The gate is
// a pure function of what GitHub RECORDS, and every session writes its conclusions as sentences -- so the
// org can act on what it is told and cannot act on anything it learns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { waitingOn, notBeforeDate, todayIso, describeWaiting, proseBlockers, answerOwedBy }
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

test("a heading-style Not-before is read the same as a bare line (#1822)", () => {
  // `Region`, `Done-when` and `Acceptance` are all written as `## <Field>` in this repo's own row
  // convention, and #1663 wrote `Not-before:` the same way -- the bare-line-only regex silently read
  // that row as having nothing stopping it, so `waitingOn` returned `null` while the field said otherwise.
  assert.equal(notBeforeDate("## Not-before: 2026-09-23"), "2026-09-23");
  assert.equal(notBeforeDate("### Not-before: 2026-09-23"), "2026-09-23", "any heading level, not just h2");
  const row = { body: "## Not-before: 2026-09-23" };
  assert.deepEqual(waitingOn(row, "2026-09-20"), { kind: "date", date: "2026-09-23" });
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

// --- #2005: the third waiting condition -- a SESSION ---

/**
 * THIS MODULE IMPLEMENTED TWO OF THE THREE FOR THREE DAYS. The 2026-09-19 chairman's direction names a
 * row (`--blocked-by`), a date (`Not-before:`) and a SESSION (`answer:<session>`), and the one whose
 * referent is a session -- the one reached for when a DECISION rather than a dependency is outstanding --
 * was the one this file did not know about. So it was the one that did not hold a row: #2002 carried
 * `answer:ceo` and was promoted and offered anyway, at 2026-09-22T20:49:41Z.
 */
test("#2005: an answer:<session> label is a wait, and it names the session that clears it", () => {
  const held = { labels: [{ name: "ready" }, { name: "answer:ceo" }] };
  assert.deepEqual(waitingOn(held, "2026-09-23"), { kind: "answer", session: "ceo" });
  assert.equal(describeWaiting({ kind: "answer", session: "ceo" }), "waiting on ceo to answer");

  // IT CLEARS ITSELF, which is the property `blocked` lacks: removing the label IS the answer.
  assert.equal(waitingOn({ labels: [{ name: "ready" }] }, "2026-09-23"), null);
});

test("#2005: a bare `answer:` names nobody, so it is not a wait -- it FAILS OPEN", () => {
  // A wait on nobody is exactly the referent-less claim this module exists to refuse, and hiding a row
  // behind one would be `blocked` under a new name. Reading it as not-waiting leaves the row visible for
  // someone to find -- the same choice `notBeforeDate` makes for a malformed date.
  assert.equal(waitingOn({ labels: [{ name: "answer:" }] }, "2026-09-23"), null);
  assert.equal(waitingOn({ labels: [{ name: "answer:   " }] }, "2026-09-23"), null,
    "whitespace is not a session name either -- it would wake a session herdr reports as unknown");
  assert.equal(answerOwedBy({ labels: [{ name: "answer:" }, { name: "answer:ceo" }] }), "ceo",
    "and a real name later in the list is still found past an empty one");
});

test("#2005: the existing two conditions are asked FIRST, so no row changes the answer it already gave", () => {
  // The new kind may only ever change the verdict for a row previously reported as waiting on NOTHING.
  // A row carrying both must keep reporting the blocker it reported before, or this change has silently
  // rewritten every shelf line and every stall report that already worked.
  const both = { labels: [{ name: "answer:ceo" }],
    blockedBy: { nodes: [{ number: 1772, state: "OPEN" }] } };
  assert.deepEqual(waitingOn(both, "2026-09-23"), { kind: "row", numbers: [1772] });
  const dated = { labels: [{ name: "answer:ceo" }], body: "Not-before: 2099-01-01" };
  assert.deepEqual(waitingOn(dated, "2026-09-23"), { kind: "date", date: "2099-01-01" });

  // AND THE CONTROL: with the blocker CLOSED, the answer-wait is what is left -- so the row is still
  // held rather than falling through to "nothing is stopping this".
  const cleared = { labels: [{ name: "answer:ceo" }],
    blockedBy: { nodes: [{ number: 1772, state: "CLOSED" }] } };
  assert.deepEqual(waitingOn(cleared, "2026-09-23"), { kind: "answer", session: "ceo" });
});

test("#2005: a row that carries the label has ALREADY done what proseBlockers asks, so it is not nagged", () => {
  // Nagging a session that complied is how a smell becomes noise -- #1780's finding, where `unfiledEpics`
  // re-asked `product-manager` about an epic whose blocker it had just recorded. From outside, a session
  // doing the right thing and a session ignoring its orders then look identical.
  const complied = [{ number: 2002, labels: [{ name: "answer:ceo" }],
    body: "This is waiting on a ruling from ceo about which account the dispatch spends." }];
  assert.deepEqual(proseBlockers(complied), []);

  // THE POSITIVE CONTROL: the same body with no label is still the smell this cause exists to report.
  const prose = [{ number: 2002, body: complied[0].body }];
  assert.deepEqual(proseBlockers(prose).map((f) => f.number), [2002]);
});
