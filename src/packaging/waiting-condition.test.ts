// A WAITING CONDITION IS DATA, NOT PROSE.
//
// Measured 2026-09-19: 0 open rows carried a machine-readable blocker, 5 stated one in prose. The gate is
// a pure function of what GitHub RECORDS, and every session writes its conclusions as sentences -- so the
// org can act on what it is told and cannot act on anything it learns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { waitingOn, notBeforeDate, todayIso, describeWaiting, proseBlockers, answerOwedBy, answersOwedBy, fleetWaitingOn,
  bareAnswerLabel, ANSWER_LABEL_GRACE_MS }
  from "../waiting-condition.mjs";
import { bareAnswerLabelOrders } from "../work-gate.mjs";

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

// --- #2113: the date field gains an HOUR, and the comparison moves to parsed time ---

/**
 * `Not-before:` COULD NOT EXPRESS A WAIT SHORTER THAN A DAY, so a row whose last done-when turns true at
 * a named HOUR read as startable from midnight.
 *
 * #2002's last done-when was a read of a `workflow_dispatch` run the host timer fires at 06:10Z. The row
 * carried `Not-before: 2026-09-23`; at 00:20Z that date had arrived and the run had not, so `waitingOn`
 * reported the row as waiting on NOTHING for the ~5h50m in between. The harm on #2002 itself was zero --
 * it was `in-progress` with an owner, who took the read at 07:14Z -- and the exposure is an unclaimed
 * `ready` row with a sub-day wait, offered to a session that cannot finish it.
 */
test("#2113: a `Not-before:` hour that has not arrived is a wait, and one that has passed is not", () => {
  const row = { body: "## Not-before: 2026-09-23T06:10:00Z" };
  const at = (iso: string) => Date.parse(iso);

  assert.deepEqual(waitingOn(row, "2026-09-23", at("2026-09-23T00:20:00Z")),
    { kind: "date", date: "2026-09-23T06:10:00Z" },
    "00:20Z on the named date is BEFORE the named hour -- today's defect read this as waiting on nothing");

  // THE ASSERTION THAT FAILS ON THE ONE-REGEX WIDENING, and it is the whole finding rather than a
  // corollary. Widening the regex alone leaves `waitingOn` comparing `date > today` against a
  // ten-character `today`, and a string is greater than its own prefix: `"2026-09-23T06:10:00Z" >
  // "2026-09-23"` is `true`, so the row would stay shelved for ALL of 2026-09-23 and clear at
  // 2026-09-24T00:00Z. A 6-hour wait turned into an 18-hour-late one -- the same defect, other sign.
  assert.equal(waitingOn(row, "2026-09-23", at("2026-09-23T07:14:00Z")), null,
    "07:14Z is past the named hour ON THE NAMED DATE: the wait has cleared and the row is startable");

  assert.equal(describeWaiting({ kind: "date", date: "2026-09-23T06:10:00Z" }),
    "not before 2026-09-23T06:10:00Z",
    "a reader deciding whether to wait needs the hour, not the day it falls in");
});

/**
 * THE DATE-ONLY EQUIVALENCE, PINNED AGAINST THE RULE IT REPLACES rather than against remembered cases.
 *
 * This is what makes #2113 a widening and not a behaviour change: `date > today` compared two
 * ten-character strings, and a parsed comparison with a date-only value read as MIDNIGHT UTC gives the
 * identical answer on every calendar-valid date-only row. The clock is varied across the whole day to
 * show it does not enter this path at all -- a date-only wait is a claim about a calendar day.
 */
test("#2113: every date-only value reports exactly what the lexical rule reported", () => {
  const dates = ["2026-09-19", "2026-09-21", "2026-09-22", "2026-12-01", "2099-01-01", "2024-02-29"];
  const todays = ["2026-09-19", "2026-09-21", "2026-09-22", "2026-09-23", "2027-01-01"];
  const clocks = ["2026-09-23T00:00:00Z", "2026-09-23T12:00:00Z", "2026-09-23T23:59:59Z"];
  for (const date of dates) {
    for (const today of todays) {
      const lexical = date > today ? { kind: "date", date } : null;
      for (const clock of clocks) {
        assert.deepEqual(waitingOn({ body: `Not-before: ${date}` }, today, Date.parse(clock)), lexical,
          `${date} against ${today} must answer as it did before #2113, whatever the clock reads`);
      }
    }
  }
});

test("#2113: a time is only accepted with SECONDS and a `Z`, and anything else fails OPEN", () => {
  // `Fleet-hold-until:`'s rule, carried onto this path: requiring seconds means a malformed field is
  // refused as a whole rather than half-parsed. Failing open leaves the row visible for a human to find,
  // which is the one direction of error that has a witness.
  for (const bad of ["2026-09-23T06:10Z", "2026-09-23T06:10:00", "2026-09-23T06:10:00+01:00",
    "2026-09-23 06:10:00Z", "2026-09-23T6:10:00Z"]) {
    assert.equal(notBeforeDate(`Not-before: ${bad}`), null, `"${bad}" must not parse`);
    assert.equal(waitingOn({ body: `Not-before: ${bad}` }, "2026-09-23", 0), null,
      `"${bad}" must leave the row visible rather than hiding it on a value we could not read`);
  }
  assert.equal(notBeforeDate("Not-before: 2026-09-23T06:10:00Z"), "2026-09-23T06:10:00Z",
    "the positive control: the one spelling this field accepts");
});

/**
 * DIGIT-SHAPED IS NOT CALENDAR-VALID, and this rule ARRIVED WITH THE PARSED COMPARISON rather than
 * beside it.
 *
 * A lexical comparison cannot roll a date over, because it never parses one: `"2026-02-31" > today` was a
 * string question and February's missing 31st never came into it. The moment the comparison became a
 * parsed one, `Date` began silently repairing such a value -- `2026-02-31T00:00:00Z` is 2026-03-03, three
 * days later than typed -- so the round-trip refusal `fleetHoldUntil` has held since #1841 is part of
 * this change and not a separate tightening.
 */
test("#2113: a calendar-invalid value is REFUSED rather than silently rolled over", () => {
  for (const bad of ["2026-02-31", "2026-02-29", "2026-04-31", "2026-13-01", "2026-00-10",
    "2026-02-31T04:00:00Z", "2026-09-23T25:00:00Z"]) {
    assert.equal(notBeforeDate(`Not-before: ${bad}`), null, `"${bad}" is not a moment the calendar has`);
    assert.equal(waitingOn({ body: `Not-before: ${bad}` }, "2026-01-01", 0), null,
      "and it fails OPEN, the same direction a malformed value does");
  }
  // THE CONTROL, without which the assertions above pass on a parser that refuses everything: real dates
  // next door to each refusal, including the leap day 2026 lacks and 2024 has.
  assert.equal(notBeforeDate("Not-before: 2026-03-01"), "2026-03-01");
  assert.equal(notBeforeDate("Not-before: 2024-02-29"), "2024-02-29", "2024 IS a leap year");
  assert.equal(notBeforeDate("Not-before: 2026-04-30"), "2026-04-30");
  assert.equal(notBeforeDate("Not-before: 2026-09-23T23:59:59Z"), "2026-09-23T23:59:59Z");
});

test("#2113: the other conditions still outrank the date, whatever granularity it is written at", () => {
  // `waitingOn`'s own rule -- the existing conditions are asked FIRST -- is what bounds this change to
  // rows previously reported as waiting on NOTHING. A widened field must not reorder it.
  const blocked = { blockedBy: { nodes: [{ number: 9, state: "OPEN" }] },
    body: "Not-before: 2099-01-01T06:10:00Z" };
  assert.deepEqual(waitingOn(blocked, "2026-09-23", 0), { kind: "row", numbers: [9] });

  // AND THE COMPLEMENT: with the hour passed, the answer-wait beneath it is what is left, so the row is
  // still held rather than falling through to "nothing is stopping this".
  const answered = { labels: [{ name: "answer:ceo" }], body: "Not-before: 2026-09-23T06:10:00Z" };
  assert.deepEqual(waitingOn(answered, "2026-09-23", Date.parse("2026-09-23T07:14:00Z")),
    { kind: "answer", session: "ceo" });
});

test("#2113: a row declaring the sub-day form has recorded it as DATA, so it is not nagged", () => {
  // `proseBlockers` reads the same parser. A row that declares an hour has done what the rule asks, and
  // nagging a session that complied is how a smell becomes noise (#1780).
  const declared = [{ number: 2002, blockedBy: { totalCount: 0 },
    body: "Not-before: 2026-09-23T06:10:00Z\nwaiting on the 06:10Z dispatch before the last done-when" }];
  assert.deepEqual(proseBlockers(declared), []);

  // THE POSITIVE CONTROL: the same prose with the field malformed is still the smell, because a value
  // that fails open has recorded nothing.
  const malformed = [{ number: 2002, blockedBy: { totalCount: 0 },
    body: "Not-before: 2026-09-23T06:10Z\nwaiting on the 06:10Z dispatch before the last done-when" }];
  assert.deepEqual(proseBlockers(malformed).map((f) => f.number), [2002]);
});

test("#2113: a fleet-gated row's two conditions are read against the SAME clock", () => {
  // `fleetWaitingOn` takes a clock because `Fleet-hold-until:` has always been sub-day. Passing only
  // `today` down to `waitingOn` would have left a fleet-gated row's `Not-before:` measured against the
  // HOST clock while the hold beside it was measured against the injected one -- so a test that moved
  // time would move one of them, and `partitionFleetBatch` would dispatch a row whose hour had not come.
  const row = { body: "Not-before: 2026-09-23T06:10:00Z\nFleet-hold-until: 2026-09-23T04:00:00Z" };
  assert.deepEqual(fleetWaitingOn(row, "2026-09-23", Date.parse("2026-09-23T00:20:00Z")),
    { kind: "date", date: "2026-09-23T06:10:00Z" },
    "the general conditions are asked first, and the injected clock is what decides this one");

  // BOTH HOURS PASSED, ON THE SAME DATE: the row is dispatchable, and only the clock changed.
  assert.equal(fleetWaitingOn(row, "2026-09-23", Date.parse("2026-09-23T07:14:00Z")), null);

  // AND THE CONTROL that the hold is still read at all -- between the two hours it is the `Not-before:`
  // that has cleared and the hold that has not.
  const heldOnly = { body: "Fleet-hold-until: 2026-09-23T08:00:00Z" };
  assert.deepEqual(fleetWaitingOn(heldOnly, "2026-09-23", Date.parse("2026-09-23T07:14:00Z")),
    { kind: "fleet-hold", until: "2026-09-23T08:00:00Z" });
});

// --- #2711: a bare `answer:<session>` label carries no question, and nothing required one ---

/**
 * `PR #2649`'S OWN EVIDENCE: `worker-2632` added `answer:ceo` to its own PR twice with no comment either
 * time, and `ceo` cleared it twice with nothing to answer. A waiting condition must name what it waits on
 * (this module's whole point) -- but nothing said the LABEL had to carry the question, so the addressee
 * had no way to tell a real question from a label applied by habit or by mistake except by going and
 * looking, which is the cost every OTHER waiting condition in this file exists to save.
 */
test("#2711: a label with nothing posted since is bare, and names when it was applied", () => {
  const timeline = [{ event: "labeled", label: { name: "answer:ceo" }, created_at: "2026-09-26T12:42:47Z" }];
  assert.deepEqual(bareAnswerLabel(timeline, "ceo"), { labelledAt: "2026-09-26T12:42:47Z" });
});

test("#2711: a comment posted AT OR AFTER the label answers it -- presence, not content", () => {
  // "Any wording" is the point: this asks whether anything was posted, never what it says.
  for (const commentAt of ["2026-09-26T12:42:47Z", "2026-09-26T15:00:00Z"]) {
    const timeline = [
      { event: "labeled", label: { name: "answer:ceo" }, created_at: "2026-09-26T12:42:47Z" },
      { event: "commented", created_at: commentAt },
    ];
    assert.equal(bareAnswerLabel(timeline, "ceo"), null, `a comment at ${commentAt} must clear it`);
  }
});

test("#2711: a comment BEFORE the label does not answer it", () => {
  // The comment answered whatever was outstanding before this application; it says nothing about THIS one.
  const timeline = [
    { event: "commented", created_at: "2026-09-26T10:00:00Z" },
    { event: "labeled", label: { name: "answer:ceo" }, created_at: "2026-09-26T12:42:47Z" },
  ];
  assert.deepEqual(bareAnswerLabel(timeline, "ceo"), { labelledAt: "2026-09-26T12:42:47Z" });
});

test("#2711: a label removed and reapplied is a NEW wait -- the LAST application is what counts", () => {
  const timeline = [
    { event: "labeled", label: { name: "answer:ceo" }, created_at: "2026-09-26T12:42:47Z" },
    { event: "unlabeled", label: { name: "answer:ceo" }, created_at: "2026-09-26T12:45:31Z" },
    { event: "labeled", label: { name: "answer:ceo" }, created_at: "2026-09-26T15:00:19Z" },
  ];
  assert.deepEqual(bareAnswerLabel(timeline, "ceo"), { labelledAt: "2026-09-26T15:00:19Z" },
    "the second application is a new wait even though the first was never answered either");
});

test("#2711: never applied, or a different session's label, is not bare -- there is nothing to be bare", () => {
  assert.equal(bareAnswerLabel([], "ceo"), null);
  assert.equal(bareAnswerLabel(undefined, "ceo"), null);
  const forSomeoneElse = [{ event: "labeled", label: { name: "answer:orchestrator" }, created_at: "2026-09-26T12:42:47Z" }];
  assert.equal(bareAnswerLabel(forSomeoneElse, "ceo"), null);
});

// --- the grace window: a session that labels first and comments second is not yet unexplained ---

/** #3566's own timeline: labelled 06:32:28Z, and the order to the labeller went out at 06:34:23Z, 7 s before the question. */
const LABELLED_AT = "2026-10-05T06:32:28Z";
const LABEL_EVENT = { event: "labeled", label: { name: "answer:product-manager" }, created_at: LABELLED_AT };
const at = (offsetMs: number) => Date.parse(LABELLED_AT) + offsetMs;

test("a label one minute old with no comment yet is NOT bare -- the labeller is still typing the question", () => {
  assert.equal(bareAnswerLabel([LABEL_EVENT], "product-manager", at(60_000)), null);
  assert.equal(bareAnswerLabel([LABEL_EVENT], "product-manager", at(0)), null, "nor is one the instant it is applied");
});

test("POSITIVE CONTROL: the same label past the window with no comment IS bare, and the boundary is the constant", () => {
  assert.deepEqual(bareAnswerLabel([LABEL_EVENT], "product-manager", at(ANSWER_LABEL_GRACE_MS)), { labelledAt: LABELLED_AT },
    "a label exactly one window old has had its whole window");
  assert.equal(bareAnswerLabel([LABEL_EVENT], "product-manager", at(ANSWER_LABEL_GRACE_MS - 1)), null);
  assert.deepEqual(bareAnswerLabel([LABEL_EVENT], "product-manager", at(ANSWER_LABEL_GRACE_MS * 12)), { labelledAt: LABELLED_AT });
});

test("a comment after the label inside the window is not bare either, and neither is one after the window", () => {
  const commented = [LABEL_EVENT, { event: "commented", created_at: "2026-10-05T06:34:30Z" }];
  assert.equal(bareAnswerLabel(commented, "product-manager", at(60_000)), null);
  assert.equal(bareAnswerLabel(commented, "product-manager", at(ANSWER_LABEL_GRACE_MS * 12)), null);
});

test("an unparseable label time stays bare rather than being excused by the window", () => {
  const broken = [{ ...LABEL_EVENT, created_at: "not-a-time" }];
  assert.deepEqual(bareAnswerLabel(broken, "product-manager", at(0)), { labelledAt: "not-a-time" });
});

test("the gate hands its own clock through: the same row is silent inside the window and ordered after it", () => {
  const row = { number: 3566, labels: [{ name: "session:worker-3566" }, { name: "answer:product-manager" }] };
  const timeline = () => JSON.stringify(LABEL_EVENT);
  assert.deepEqual(bareAnswerLabelOrders([row], timeline as never, at(60_000)), []);
  const [order] = bareAnswerLabelOrders([row], timeline as never, at(ANSWER_LABEL_GRACE_MS)) as { session: string }[];
  assert.equal(order.session, "worker-3566", "past the window it is the labeller who is ordered, as before");
});

test("#2202: answersOwedBy lists EVERY owing session and answerOwedBy is its first -- one decision about a name", () => {
  const row = { labels: [{ name: "backlog" }, { name: "answer:" }, { name: "answer:ceo" }, "answer:orchestrator"] };
  assert.deepEqual(answersOwedBy(row), ["ceo", "orchestrator"], "a bare `answer:` names nobody; strings and label objects both read");
  assert.equal(answerOwedBy(row), answersOwedBy(row)[0]);
  assert.deepEqual(answersOwedBy({ labels: [{ name: "backlog" }] }), [], "a row owing nobody is the control");
  assert.equal(answerOwedBy({}), null);
});
