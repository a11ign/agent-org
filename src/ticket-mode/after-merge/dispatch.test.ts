// no-token: none -- pure functions over in-memory check records
// A11-277, A11-302: a person's check waits under Needs you, and a board check the board could not settle is handed to an agent
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CheckRecord, ChecksFile } from "./checks.ts";
import { handOverdueToAgent, markOverdue, markShownToPerson, OVERDUE_MS, personItemOf, waitsOnPerson } from "./dispatch.ts";

const DAY = 24 * 60 * 60 * 1000;

const check = (id: string, fields: Partial<CheckRecord> = {}): CheckRecord => ({
  id, key: id.split("#")[0], url: null, line: "The next major arrives as a ticket.", owner: null, runner: "agent", listedAt: 1_000, state: "open", ...fields,
});

const fileOf = (...checks: CheckRecord[]): ChecksFile => ({ checks: Object.fromEntries(checks.map((one) => [one.id, one])) });

test("A11-302: only a person check on an item of the escalation list waits under Needs you; an agent's, a board's, a retired session's and a person's on no item do not", () => {
  const onList = check("A11-233#1", { owner: "The chairman", runner: "person", escalation: "legal" });
  const offList = check("A11-233#2", { owner: "The chairman", runner: "person" });
  const unknownItem = check("A11-233#3", { owner: "The chairman", runner: "person", escalation: "lunch" });
  const others = [check("A11-178#1"), check("A11-245#1", { runner: "board" }), check("A11-190#1", { runner: "session" })];
  assert.deepEqual([onList, offList, unknownItem, ...others].map(waitsOnPerson), [true, false, false, false, false, false]);
  assert.equal(personItemOf(onList)?.id, "legal");
  assert.equal(waitsOnPerson(check("A11-233#4", { runner: "person", escalation: "legal", state: "passed" })), false, "a closed check waits on no one");
});

test("A11-302: a Needs-you check is shown at the first sweep that lists it, and an agent's check is shown to no one", () => {
  const file = fileOf(check("A11-233#1", { runner: "person", escalation: "legal" }), check("A11-178#1"), check("A11-245#1", { runner: "board" }));
  const shown = markShownToPerson(file, 5_000);
  assert.deepEqual(Object.values(shown.checks).map(({ id, sentAt }) => [id, sentAt]), [["A11-233#1", 5_000], ["A11-178#1", undefined], ["A11-245#1", undefined]]);
  assert.equal(markShownToPerson(shown, 9_000), shown, "nothing is shown twice");
});

test("A11-302: a Needs-you check open 7 days after it was shown stays the person's, marked overdue once, and is never handed to anyone", () => {
  const shown = markShownToPerson(fileOf(check("A11-233#1", { owner: "The chairman", runner: "person", escalation: "legal", listedAt: 0 })), 5_000);
  assert.equal(markOverdue(shown, 5_000 + OVERDUE_MS - 1), shown, "a run that merged long ago does not start its 7 days");
  const held = markOverdue(shown, 5_000 + OVERDUE_MS);
  assert.deepEqual([held.checks["A11-233#1"].runner, held.checks["A11-233#1"].sentAt, held.checks["A11-233#1"].overdueAt], ["person", 5_000, 5_000 + OVERDUE_MS]);
  assert.equal(markOverdue(held, 5_000 + 9 * DAY), held, "once, and not again");
  assert.equal(handOverdueToAgent(held, 5_000 + 30 * DAY), held, "a person's check is never handed to an agent");
});

test("A11-302: an overdue mark is for a Needs-you check only: an org check is never marked overdue, however long it is listed", () => {
  const org = fileOf(check("A11-178#1", { listedAt: 0, sentAt: 0 }), check("A11-190#1", { runner: "session", listedAt: 0, sentAt: 0 }));
  assert.equal(markOverdue(org, 30 * DAY), org);
});

test("A11-302: a board check that watches an event and did not see it in 7 days is handed to an agent, keeping what it watched, and its 7 days start when the board began to watch", () => {
  const watch = { spec: { kind: "wake" as const }, from: 20 * DAY };
  const file = fileOf(check("A11-245#1", { runner: "board", listedAt: 0, observe: watch }));
  assert.equal(handOverdueToAgent(file, 20 * DAY), file, "a line seeded today from a run of 20 days ago is not overdue");
  assert.equal(handOverdueToAgent(file, 27 * DAY - 1), file);
  const handed = handOverdueToAgent(file, 27 * DAY).checks["A11-245#1"];
  assert.deepEqual([handed.runner, handed.observe, handed.handedOff], ["agent", watch, "the board watched for wake for 7 days and did not see it"]);
});

test("A11-302: a windowed board check decides its own handoff when its window closes, so the 7 days of an event do not apply to it", () => {
  const window = { spec: { kind: "run-log" as const, event: "finished" as const, pass: "absent" as const, windowMs: 30 * DAY }, from: 0, began: 0 };
  const file = fileOf(check("A11-294#1", { runner: "board", observe: window }));
  assert.equal(handOverdueToAgent(file, 20 * DAY), file, "a 30-day window is not cut at 7");
});

test("A11-277: a closed check never falls overdue", () => {
  const closed = fileOf(check("A11-178#1", { sentAt: 0, state: "passed", result: "seen", closedBy: "agent", closedAt: 10 }), check("A11-245#1", { runner: "board", state: "passed", observe: { spec: { kind: "wake" }, from: 0 } }));
  assert.equal(markOverdue(closed, 30 * DAY), closed);
  assert.equal(handOverdueToAgent(closed, 30 * DAY), closed);
});
