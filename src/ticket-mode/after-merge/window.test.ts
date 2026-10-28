// no-token: none -- pure functions over records in memory
// A11-361: a check about a delay after release is scheduled for release + window, and one closed failed for want of a week is opened again
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CheckRecord, ChecksFile } from "./checks.ts";
import { plannedChecks, AFTER_MERGE_CHECKS_HEADING } from "./plan-section.ts";
import { awaitsWindow, delayInLine, delayOf, dueWords, reopenClosedTooSoon, scheduleWindows } from "./window.ts";

const DAY = 24 * 60 * 60 * 1000;

const check = (id: string, over: Partial<CheckRecord> = {}): CheckRecord => ({
  id, key: id.split("#")[0], url: null, line: "7 days after release, no stale-block note is on a run.", owner: null, runner: "agent", listedAt: 1_000, state: "open", ...over,
});
const fileOf = (...checks: CheckRecord[]): ChecksFile => ({ checks: Object.fromEntries(checks.map((one) => [one.id, one])) });

test("A11-361: the delay a line names is read from its words: '7 days after release', 'over 7 days', 'for a week'", () => {
  assert.equal(delayInLine("7 days after release, the doctor is clean."), 7 * DAY);
  assert.equal(delayInLine("Pass: no stale-block note on a run under its round cap over 7 days."), 7 * DAY);
  assert.equal(delayInLine("For a week, no run is lost."), 7 * DAY);
  assert.equal(delayInLine("Two weeks after the merge the page shows the field."), 14 * DAY);
  assert.equal(delayInLine("12 hours after release, the log is rotated."), 12 * 60 * 60_000);
  assert.equal(delayInLine("The doctor shows one version."), null);
  assert.equal(delayInLine("90 days after release the key is rotated."), null, "longer than a window may be: not read as one");
  for (const line of ["Run the migration command for 10 minutes and confirm it exits 0.", "A queue stalled for 2 hours is reported.", "The page loads in under 5 minutes from a cold start.",
    "Within 5 minutes after the restart the pool is back.", "30 minutes after restart the doctor is clean.", "The build takes less than 10 minutes following a clean cache."]) {
    assert.equal(delayInLine(line), null, line);
  }
});

test("A11-361: a plan's Window outranks the line, and an agent check may name one", () => {
  assert.equal(delayOf({ line: "7 days after release, ok.", windowMs: 3 * DAY }), 3 * DAY);
  assert.equal(delayOf({ line: "For a week, no run is lost.", observe: { spec: { kind: "wake" }, from: 0 } }), null, "a check the board watched has had its window");
  assert.equal(delayOf({ line: "For a week, no run is lost.", handedOff: "the board watched for wake for 7 days and did not see it" }), null, "and so has one it handed to an agent");
  const plan = `${AFTER_MERGE_CHECKS_HEADING}\n\n- \`The log is rotated.\`\n  - Runner: agent\n  - Window: 3d\n  - Evidence: quote the log\n`;
  assert.deepEqual(plannedChecks([plan]), { checks: [{ line: "The log is rotated.", runner: "agent", evidence: "quote the log", window: 3 * DAY }] });
  const withObserve = plan.replace("  - Window: 3d", "  - Pass: absent");
  assert.match(JSON.stringify(plannedChecks([withObserve])), /only a `board` runner does/);
  const bad = plan.replace("3d", "soon");
  assert.match(JSON.stringify(plannedChecks([bad])), /is not a number of minutes, hours or days/);
});

test("A11-361: a check is scheduled for its delay after it first reads as installed, once, and is held back until then", () => {
  const waiting = check("A11-352#1");
  const none = check("A11-310#1", { line: "The doctor shows one version." });
  assert.equal(scheduleWindows(fileOf(waiting), () => false, 5_000).checks["A11-352#1"].dueAt, undefined, "not installed: no clock yet");
  const scheduled = scheduleWindows(fileOf(waiting, none), () => true, 5_000);
  assert.deepEqual([scheduled.checks["A11-352#1"].dueAt, scheduled.checks["A11-310#1"].dueAt], [5_000 + 7 * DAY, undefined]);
  assert.equal(scheduleWindows(scheduled, () => true, 99_000), scheduled, "the due time is set once");
  const due = scheduled.checks["A11-352#1"];
  assert.deepEqual([awaitsWindow(waiting, 5_000), awaitsWindow(due, 5_000 + 7 * DAY - 1), awaitsWindow(due, 5_000 + 7 * DAY), awaitsWindow(none, 0)], [true, true, false, false]);
  assert.equal(dueWords(due), "due 1970-01-08");
  assert.equal(dueWords(none), null);
});

test("A11-361: only an open agent check is scheduled", () => {
  const others = fileOf(check("A11-1#1", { runner: "board" }), check("A11-2#1", { state: "passed" }), check("A11-3#1", { runner: "person", escalation: "legal" }));
  assert.equal(scheduleWindows(others, () => true, 5_000), others);
});

test("A11-361: a check closed failed before its window could end is opened again, due its delay after the close; any other failure stays", () => {
  const early = check("A11-352#1", { listedAt: 1_000, state: "failed", result: "window has not elapsed", closedBy: "agent", closedAt: 2_000, posted: true, followUp: "f1", verifier: { run: "c1", tries: 1 } });
  const late = check("A11-353#1", { listedAt: 1_000, state: "failed", result: "a stale-block note", closedBy: "agent", closedAt: 1_000 + 8 * DAY, followUp: "f2" });
  const person = check("A11-354#1", { listedAt: 1_000, state: "failed", result: "no", closedBy: "person", closedAt: 2_000 });
  const file = fileOf(early, late, person);
  const reopened = reopenClosedTooSoon(file);
  assert.deepEqual(reopened.checks["A11-352#1"], { id: "A11-352#1", key: "A11-352", url: null, line: early.line, owner: null, runner: "agent", listedAt: 1_000, state: "open", dueAt: 2_000 + 7 * DAY });
  const real = check("A11-355#1", { listedAt: 1_000, state: "failed", result: "drift seen on A11-9 on day 1", closedBy: "agent", closedAt: 2_000, followUp: "f3" });
  assert.deepEqual([reopened.checks["A11-353#1"], reopened.checks["A11-354#1"]], [late, person]);
  assert.equal(reopenClosedTooSoon(fileOf(real)).checks["A11-355#1"], real, "a failure that says what was seen stays failed, however early");
  assert.equal(reopenClosedTooSoon(reopened), reopened, "once");
});
