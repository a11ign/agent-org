// no-token: none -- the number is a pure function of the queue's run logs
// module: the board's health number counts the stand-offs it settled without a person, beside the person-interventions (A11-290, A11-257)
import { test } from "node:test";
import assert from "node:assert/strict";
import { healthNumber } from "./health-number.ts";
import { emptyQueue } from "./queue.ts";
import { logEvent } from "./queue/run-log.ts";
import { settleStandoff } from "./queue/queue-standoff.ts";
import type { Entry, Queue } from "./queue/queue-entries-and-outcomes.ts";

const DAY = 24 * 60 * 60_000;
const NOON = Date.parse("2026-10-26T12:00:00Z");
const URL = "https://github.com/a11ign/agent-org/pull/1933";

const ticket = { key: "A11-270", title: "t", description: "", url: "u", branch: "b", status: "s", statusOrder: 0, team: "A11", project: null, priority: 0 };

/** A queue whose run holds a stand-off at `h1`, and whose pull request is now read at `head`, approved or not. */
const standoffQueue = (head: string, review: "approved" | "changes-requested"): Queue => ({
  ...emptyQueue(3),
  entries: [{ ticket, repos: [], model: "m", effort: "e", phase: "finished", queuedAt: 0,
    standoff: { url: URL, head: "h1", review: null, reasons: "still 340 KB", reply: null, stage: "done" }, pullHeads: { [URL]: { head, approved: review === "approved", review } } } as unknown as Entry],
});

test("A11-290: a stand-off settled by a new head or by an approval is counted on the day it was settled, beside that day's Needs-you cards", () => {
  let queue = standoffQueue("h2", "changes-requested");
  queue = settleStandoff(queue, "A11-270", NOON - DAY);
  queue = logEvent(queue, "A11-270", NOON - DAY, { kind: "needs-you", reason: "a question" });
  queue = logEvent(queue, "A11-270", NOON, { kind: "needs-you", reason: "another" });
  const week = healthNumber(queue, NOON);
  assert.equal(week.length, 7);
  assert.deepEqual(week.at(-2), { day: "2026-10-25", personInterventions: 1, standoffsSettled: 1 });
  assert.deepEqual(week.at(-1), { day: "2026-10-26", personInterventions: 1, standoffsSettled: 0 });
  assert.equal(week.slice(0, 5).every((day) => day.personInterventions === 0 && day.standoffsSettled === 0), true, "a day with nothing logged is there with zeros");
  const approved = settleStandoff(standoffQueue("h1", "approved"), "A11-270", NOON);
  assert.equal(healthNumber(approved, NOON).at(-1)?.standoffsSettled, 1, "an approval at the head the stand-off was about settles it too");
});

test("A11-290: a stand-off that is still at its head and blocked is not settled, and counts nothing", () => {
  const queue = settleStandoff(standoffQueue("h1", "changes-requested"), "A11-270", NOON);
  assert.equal(queue.entries[0].standoff?.stage, "done");
  assert.equal(healthNumber(queue, NOON).every((day) => day.standoffsSettled === 0), true);
});

test("A11-290: the queue the page polls carries the health number", async () => {
  const { queueView } = await import("./read-routes.ts");
  const queue = settleStandoff(standoffQueue("h2", "changes-requested"), "A11-270", Date.now());
  const view = queueView({ store: { get: () => queue, set: () => undefined }, pool: {}, update: () => null, settings: { ciBudgetMinutes: 0 } } as never);
  assert.equal(view.health.at(-1)?.standoffsSettled, 1);
});
