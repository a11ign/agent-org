// no-token: REPO
//
// #827's mechanism, and the declaration is checked rather than asserted. This file imports exactly one
// symbol -- `scheduleNeverFired` -- and calls exactly that; `REPO` arrives through the module's import
// closure (`board-schedule-liveness.mjs` -> `board-data.mjs:82`), never through anything this file
// invokes. Every input is injected: `events`, `createdAt`, `now` and `graceHours` are all arguments.
// So reaching `REPO` is not part of what is tested here, which is the condition the declaration names.
//
// A CONSUMER assertion reaches `REPO` on purpose and must NOT carry this line -- declaring it there
// would make a consumer test a unit test wearing its name. `livenessVerdict`'s own consumer coverage
// lives in `board-liveness.test.ts`, which declares `// no-token: gh` for the same reason and not this
// one.
/**
 * `board-schedule-liveness.mjs`'s comment/summary inference (`livenessVerdict`, tested in
 * `board-liveness.test.ts`) is BLIND to a workflow that has never fired and is still young -- #272,
 * measured live: `board-report.yml` had zero scheduled runs the day after it was added, and the
 * inference's trailing `STALE_AFTER_DAYS` window had nothing to read yet, so it reported ALIVE.
 *
 * `scheduleNeverFired` asks GitHub directly instead of inferring from editions -- has the SCHEDULE TRIGGER
 * ever fired, independent of what any run then did. These tests drive it with synthetic inputs, the same
 * discipline `board-liveness.test.ts`'s own header states: the state this checks for is indistinguishable
 * from "everything is fine, nothing happening", so the verdict must be provable without a network or a
 * clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { scheduleNeverFired } from "../../../../scripts/board-schedule-liveness.mjs";

const NOW = new Date("2026-09-08T08:00:00Z");
const CREATED_YESTERDAY = "2026-09-06T16:23:01.000+01:00"; // ~40h before NOW

test("a workflow that HAS fired on schedule at least once reads false, whatever else its history holds", () => {
  const events = ["workflow_dispatch", "schedule", "workflow_dispatch"];
  assert.equal(scheduleNeverFired({ events, createdAt: CREATED_YESTERDAY, now: NOW }), false);
});

test("TRUE: old enough (past the grace period) and zero schedule events anywhere in its history", () => {
  const events = ["workflow_dispatch", "workflow_dispatch"];
  assert.equal(scheduleNeverFired({ events, createdAt: CREATED_YESTERDAY, now: NOW }), true);
});

test("NULL: too new to judge yet, even with zero schedule events -- both daily windows deserve a fair chance", () => {
  const createdOneHourAgo = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
  assert.equal(scheduleNeverFired({ events: [], createdAt: createdOneHourAgo, now: NOW }), null,
    "an hour old having no scheduled run yet is not evidence of anything -- it has not reached its first window");
});

test("TRUE: exactly at the grace boundary already counts as old enough -- the boundary is inclusive", () => {
  const exactlyGraceHoursAgo = new Date(NOW.getTime() - 36 * 60 * 60 * 1000).toISOString();
  assert.equal(scheduleNeverFired({ events: [], createdAt: exactlyGraceHoursAgo, now: NOW }), true);
});

test("NULL: one millisecond short of the boundary is still too new", () => {
  const justShortOfGrace = new Date(NOW.getTime() - (36 * 60 * 60 * 1000 - 1)).toISOString();
  assert.equal(scheduleNeverFired({ events: [], createdAt: justShortOfGrace, now: NOW }), null);
});

test("MUTATION target: a lookup failure (either side null) is NULL, never coerced to true or false", () => {
  // Collapsing this into `true` would report a network blip as a dead schedule; collapsing it into `false`
  // would report a dead schedule as healthy on the exact day the lookup happens to fail. Neither is honest.
  assert.equal(scheduleNeverFired({ events: null, createdAt: CREATED_YESTERDAY, now: NOW }), null);
  assert.equal(scheduleNeverFired({ events: ["workflow_dispatch"], createdAt: null, now: NOW }), null);
  assert.equal(scheduleNeverFired({ events: null, createdAt: null, now: NOW }), null);
});

test("a genuinely empty run history (workflow never invoked by ANY trigger) is treated the same as no schedule events", () => {
  const justPastGrace = new Date(NOW.getTime() - (36 * 60 * 60 * 1000 + 1)).toISOString();
  assert.equal(scheduleNeverFired({ events: [], createdAt: justPastGrace, now: NOW }), true);
});

test("a custom graceHours is honoured, for a caller that wants a tighter or looser bootstrap window", () => {
  const twoHoursAgo = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
  assert.equal(scheduleNeverFired({ events: [], createdAt: twoHoursAgo, now: NOW, graceHours: 1 }), true,
    "with a 1-hour grace, 2 hours old with zero schedule events is already a finding");
  assert.equal(scheduleNeverFired({ events: [], createdAt: twoHoursAgo, now: NOW, graceHours: 3 }), null,
    "with a 3-hour grace, the same age is still too new to judge");
});

// --- #1263: a GHOST scheduled run is registered, never runs, and must not read as "it has fired" ------
//
// #1253 measured the shape: a workflow run GitHub creates and never schedules, `queued` forever with zero
// jobs and `updated_at` frozen at `created_at`. It carries its trigger's `event`, so a reader asking only
// "is there a schedule event in the history" answers `false` here -- "the schedule has fired" -- on the
// strength of a run that did nothing. The two on #1253 were still stuck 90 minutes after creation.

test("#1263: a GHOST scheduled run does NOT count as the schedule having fired", () => {
  const events = [{ event: "workflow_dispatch", status: "completed", conclusion: "success" },
    { event: "schedule", status: "queued", conclusion: null }];
  assert.equal(scheduleNeverFired({ events, createdAt: CREATED_YESTERDAY, now: NOW }), true,
    "a run that never ran is not evidence the schedule fired");
});

test("#1263 POSITIVE CONTROL: a COMPLETED scheduled run still counts", () => {
  // Without this, the change above is satisfied by a function that always says "never fired".
  const events = [{ event: "workflow_dispatch", status: "completed", conclusion: "success" },
    { event: "schedule", status: "completed", conclusion: "success" }];
  assert.equal(scheduleNeverFired({ events, createdAt: CREATED_YESTERDAY, now: NOW }), false);
});

test("#1263: a completed scheduled run that FAILED still counts as fired -- the question is whether the "
  + "schedule RUNS, not whether the workflow passed", () => {
  const events = [{ event: "schedule", status: "completed", conclusion: "failure" }];
  assert.equal(scheduleNeverFired({ events, createdAt: CREATED_YESTERDAY, now: NOW }), false);
});

test("#1263: the legacy string shape is still read as completed, so it cannot become a false alarm", () => {
  assert.equal(scheduleNeverFired({ events: ["schedule"], createdAt: CREATED_YESTERDAY, now: NOW }), false);
});
