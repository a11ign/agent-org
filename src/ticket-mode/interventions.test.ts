// no-token: gh -- pure transitions and one file in a temporary directory
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { DAYS_KEPT, countFix, countNeedsYou, dayOf, interventionsView } from "./queue/interventions.ts";
import { enqueue, type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { finish, markRunning, markStarting, observe } from "./queue/queue-transitions.ts";
import { logEvent } from "./queue/run-log.ts";
import { emptyQueue, loadQueue, saveQueue } from "./queue.ts";
import { passedOn } from "./remote-proxy.ts";
import type { Ticket } from "./source.ts";

// A11-257: the board's health number, the person-interventions per day.
const DAY = 86_400_000;
const NOON = Date.UTC(2026, 9, 26, 12);
const ticket = (key: string) => ({ key, title: key, description: "", url: `https://linear.app/x/${key}`, branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
const running = (key: string): Queue => markRunning(markStarting(enqueue(emptyQueue(1), [ticket(key)], { model: "opus", effort: "high" }, 1), key, 2, { instance: "agents", host: "agents-host" }), key, "w1", "w1:p1");

test("A11-257: a needs-you event adds one to its UTC day, and a day is the UTC day whatever the hour", () => {
  const late = Date.UTC(2026, 9, 26, 23, 59, 59);
  let queue = logEvent(emptyQueue(1), "A", NOON, { kind: "needs-you", reason: "post it?" });
  queue = logEvent(queue, "B", late, { kind: "needs-you", reason: "pay it?" });
  queue = logEvent(queue, "C", late + 1_000, { kind: "needs-you", reason: "next day" });
  assert.deepEqual(queue.interventions, { "2026-10-26": { needsYou: 2, fixes: 0 }, "2026-10-27": { needsYou: 1, fixes: 0 } });
});

test("A11-257: every other event adds nothing", () => {
  const queue = logEvent(logEvent(emptyQueue(1), "A", NOON, { kind: "answered", by: "respond" }), "A", NOON, { kind: "dismissed" });
  assert.equal(queue.interventions, undefined);
});

test("A11-257: a fix adds one to its day, beside the Needs-you cards of that day", () => {
  const queue = countFix(logEvent(emptyQueue(1), "A", NOON, { kind: "needs-you", reason: "post it?" }), NOON + 1_000);
  assert.deepEqual(queue.interventions, { "2026-10-26": { needsYou: 1, fixes: 1 } });
});

test("A11-257: days older than 30 are dropped, and the 30th is kept", () => {
  let queue = countFix(emptyQueue(1), NOON - DAYS_KEPT * DAY);
  queue = countFix(queue, NOON - (DAYS_KEPT - 1) * DAY);
  assert.deepEqual(Object.keys(queue.interventions ?? {}).length, 2);
  queue = countNeedsYou(queue, NOON);
  assert.deepEqual(Object.keys(queue.interventions ?? {}), [dayOf(NOON - (DAYS_KEPT - 1) * DAY), dayOf(NOON)], "the day 30 days back is gone, the one 29 days back stays");
});

test("A11-257: the same event logged again is not counted twice", () => {
  const event = { kind: "needs-you", reason: "post it?" } as const;
  const once = logEvent(emptyQueue(1), "A", NOON, event);
  const twice = logEvent(once, "A", NOON, event);
  assert.deepEqual(twice.interventions, once.interventions);
  assert.deepEqual(logEvent(once, "A", NOON + 1, event).interventions, { "2026-10-26": { needsYou: 2, fixes: 0 } }, "the same words a moment later are another card");
});

test("A11-257: a run that goes to Needs you through the queue's own transitions is counted once however many times the same event is applied", () => {
  let queue = observe(running("A"), "A", "blocked", "Allow this command?", NOON);
  queue = observe(queue, "A", "blocked", "Allow this command?", NOON + 1);
  assert.deepEqual(queue.interventions, { "2026-10-26": { needsYou: 1, fixes: 0 } });
  const ended = finish(running("B"), "B", { kind: "needs-human", reason: "post the note?", escalation: "outward" }, NOON);
  assert.deepEqual(ended.interventions, { "2026-10-26": { needsYou: 1, fixes: 0 } });
  assert.deepEqual(finish(ended, "B", { kind: "needs-human", reason: "post the note?", escalation: "outward" }, NOON + 5).interventions, ended.interventions, "finishing on the same outcome is one ending");
});

test("A11-257: the view is the last 7 days, oldest first, a day with none shown as 0, and today's total", () => {
  let queue = countNeedsYou(countNeedsYou(emptyQueue(1), NOON), NOON);
  queue = countFix(queue, NOON);
  queue = countNeedsYou(queue, NOON - 6 * DAY);
  queue = countNeedsYou(queue, NOON - 7 * DAY);
  const view = interventionsView(queue, NOON);
  assert.equal(view.days.length, 7);
  assert.deepEqual(view.days.map(({ date }) => date), ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"]);
  assert.deepEqual(view.days.map(({ total }) => total), [1, 0, 0, 0, 0, 0, 3], "the day 7 days back is not in the view");
  assert.deepEqual(view.days.at(-1), { date: "2026-10-26", needsYou: 2, fixes: 1, total: 3 });
  assert.equal(view.today, 3);
  assert.deepEqual(interventionsView(emptyQueue(1), NOON).days.map(({ total }) => total), [0, 0, 0, 0, 0, 0, 0]);
});

test("A11-257: the tally lasts across a restart with the queue's file", () => {
  const path = join(tmpDir("interventions-"), "queue.json");
  saveQueue(path, countFix(countNeedsYou(emptyQueue(1), NOON), NOON));
  assert.deepEqual(loadQueue(path, 1).interventions, { "2026-10-26": { needsYou: 1, fixes: 1 } });
  saveQueue(path, emptyQueue(1));
  assert.equal(loadQueue(path, 1).interventions, undefined);
});

test("A11-257: the page's proxy passes on the read of the health number, and not the write a chairman session makes straight to the instance", () => {
  assert.equal(passedOn("GET", "/api/interventions"), true);
  assert.equal(passedOn("POST", "/api/interventions"), false);
});

test("A11-300: the page's proxy passes on the read of the flaky tests, and not a write", () => {
  assert.equal(passedOn("GET", "/api/flakes"), true);
  assert.equal(passedOn("POST", "/api/flakes"), false);
});

test("A11-257: an event with no valid time counts nothing and logging it does not throw", () => {
  const queue = logEvent(emptyQueue(1), "A", Number.NaN, { kind: "needs-you", reason: "post it?" });
  assert.equal(queue.interventions, undefined);
  assert.equal(countFix(emptyQueue(1), Number.POSITIVE_INFINITY).interventions, undefined);
});
