// no-token: none -- pure functions over in-memory check records
// A11-277: each After-merge check is sent to its runner, and one left open 7 days is sent again, once, overdue
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CheckRecord, ChecksFile } from "./checks.ts";
import { markOverdue, markSent, markShownToPerson, OVERDUE_MS, runnerSentTo, sentToSession, waitsOnPerson } from "./dispatch.ts";

const DAY = 24 * 60 * 60 * 1000;

const check = (id: string, fields: Partial<CheckRecord> = {}): CheckRecord => ({
  id, key: id.split("#")[0], url: null, line: "Chairman session: the next major arrives as a ticket.", owner: "Chairman session", runner: "session", listedAt: 1_000, state: "open", ...fields,
});

const fileOf = (...checks: CheckRecord[]): ChecksFile => ({ checks: Object.fromEntries(checks.map((one) => [one.id, one])) });

test("A11-277: a session check is sent to the session, a person check on the escalation list waits under Needs you, and a board check is the board's", () => {
  const onList = check("A11-233#1", { owner: "The chairman", runner: "person", escalation: "legal" });
  const offList = check("A11-233#2", { owner: "The chairman", runner: "person" });
  const unknownItem = check("A11-233#3", { owner: "The chairman", runner: "person", escalation: "lunch" });
  const watched = check("A11-245#1", { runner: "board" });
  assert.deepEqual([check("A11-178#1"), onList, offList, unknownItem, watched].map((one) => [sentToSession(one), waitsOnPerson(one)]), [
    [true, false], [false, true], [true, false], [true, false], [false, false],
  ]);
  assert.equal(sentToSession(check("A11-178#1", { state: "passed" })), false, "a closed check is sent to no one");
});

test("A11-277: a check is sent the first time the session's queue lists it, and a second listing keeps when it was sent", () => {
  const file = fileOf(check("A11-178#1"), check("A11-233#1", { runner: "person", escalation: "legal" }), check("A11-245#1", { runner: "board" }));
  const sent = markSent(file, 5_000);
  assert.deepEqual(Object.values(sent.checks).map(({ id, sentAt }) => [id, sentAt]), [["A11-178#1", 5_000], ["A11-233#1", undefined], ["A11-245#1", undefined]]);
  assert.equal(markSent(sent, 9_000), sent, "nothing is sent twice");
});

test("A11-277: a session check open 7 days after it was sent is sent again, once, marked overdue, and an 8th or a 9th day changes nothing", () => {
  const sent = fileOf(check("A11-178#1", { sentAt: 5_000 }));
  assert.equal(markOverdue(sent, 5_000 + OVERDUE_MS - 1), sent, "not before 7 days");
  const overdue = markOverdue(sent, 5_000 + OVERDUE_MS);
  assert.deepEqual(overdue.checks["A11-178#1"], { ...sent.checks["A11-178#1"], sentAt: 5_000 + OVERDUE_MS, overdueAt: 5_000 + OVERDUE_MS });
  assert.equal(markOverdue(overdue, 5_000 + 8 * DAY), overdue, "the 8th day sends nothing");
  assert.equal(markOverdue(overdue, 5_000 + 9 * DAY), overdue, "nor the 9th");
});

test("A11-277: a session check the session has not been sent yet is not overdue, however long ago it was listed", () => {
  const unsent = fileOf(check("A11-169#1", { listedAt: 0 }));
  assert.equal(markOverdue(unsent, 30 * DAY), unsent);
});

test("A11-277: a board check nobody saw pass for 7 days goes to the session, overdue, and keeps what it watches", () => {
  const watch = { spec: { kind: "wake" as const }, from: 1_000 };
  const overdue = markOverdue(fileOf(check("A11-245#1", { runner: "board", observe: watch })), 1_000 + OVERDUE_MS);
  const moved = overdue.checks["A11-245#1"];
  assert.deepEqual([moved.runner, moved.sentAt, moved.overdueAt, moved.observe], ["session", 1_000 + OVERDUE_MS, 1_000 + OVERDUE_MS, watch]);
  assert.equal(sentToSession(moved), true);
});

test("A11-277: a Needs-you check open 7 days after it was shown to the person stays the person's, marked overdue, and is never sent to the session", () => {
  const shown = markShownToPerson(fileOf(check("A11-233#1", { owner: "The chairman", runner: "person", escalation: "legal", listedAt: 0 })), 5_000);
  assert.equal(shown.checks["A11-233#1"].sentAt, 5_000, "shown under Needs you at the sweep that first lists it");
  assert.equal(markOverdue(shown, 5_000 + OVERDUE_MS - 1), shown, "a run that merged long ago does not start its 7 days");
  const held = markOverdue(shown, 5_000 + OVERDUE_MS).checks["A11-233#1"];
  assert.deepEqual([held.runner, held.sentAt, held.overdueAt], ["person", 5_000, 5_000 + OVERDUE_MS]);
  assert.equal(markSent(shown, 5_000 + OVERDUE_MS), shown, "the session is not sent it");
});

test("A11-277: a board check's 7 days start when the board began to watch it, not when its run merged", () => {
  const watched = fileOf(check("A11-245#1", { runner: "board", listedAt: 0, observe: { spec: { kind: "wake" }, from: 20 * DAY } }));
  assert.equal(markOverdue(watched, 20 * DAY), watched, "a line seeded today from a run of 20 days ago is not overdue");
  assert.equal(markOverdue(watched, 27 * DAY).checks["A11-245#1"].runner, "session");
});

test("A11-277: a row names the runner the check is sent to: a person check on no escalation item is the session's", () => {
  const person = { owner: "The chairman", runner: "person" as const };
  assert.deepEqual([check("A11-233#1", person), check("A11-233#2", { ...person, escalation: "legal" }), check("A11-245#1", { runner: "board" })].map(runnerSentTo), ["session", "person", "board"]);
});

test("A11-277: a closed check never falls overdue", () => {
  const closed = fileOf(check("A11-178#1", { sentAt: 0, state: "passed", result: "seen", closedBy: "session", closedAt: 10 }));
  assert.equal(markOverdue(closed, 30 * DAY), closed);
});
