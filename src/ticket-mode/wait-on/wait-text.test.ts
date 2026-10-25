// no-token: none -- the card text is pure
import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingText, roundedEta, waitText } from "./wait-text.ts";
import type { Reading } from "./wait-types.ts";

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 25, 8, 0);
const job = (id: string, over: Record<string, unknown> = {}, status: "pending" | "finished" | "failed" = "pending"): Reading => ({
  wait: { kind: "fleetJob", id }, status, job: { state: "running", reason: null, results: null, progress: { done: 4, total: 6 }, estimatedFinish: NOW + 20 * MIN, ...over },
});

test("A11-236: a fleet job reads as the ticket shows it: pages done of total and about how long is left", () => {
  assert.equal(waitText([job("123")], NOW), "Waiting on fleet job 123 (4 of 6 pages, about 20 min)");
});

test("A11-245: the time left is rounded to 5 minutes, then to hours, so the text changes rarely", () => {
  const cases: [number, string | null][] = [[0, null], [-5, null], [1, "about 5 min"], [2, "about 5 min"], [3, "about 5 min"], [8, "about 10 min"], [20, "about 20 min"], [21, "about 20 min"], [23, "about 25 min"], [54, "about 55 min"], [58, "about 1 h"], [88, "about 1 h"],
    [60, "about 1 h"], [74, "about 1 h"], [89, "about 1 h"], [90, "about 2 h"], [148, "about 2 h"], [91, "about 2 h"], [180, "about 3 h"], [600, "about 10 h"]];
  for (const [minutes, text] of cases) assert.equal(roundedEta(minutes * MIN), text, `${minutes} min`);
});

test("A11-245: the same card text is built from readings a minute apart when the estimate has not moved by more than the rounding", () => {
  assert.equal(waitText([job("123", { estimatedFinish: NOW + 20 * MIN + 30_000 })], NOW), waitText([job("123", { estimatedFinish: NOW + 20 * MIN })], NOW + 10_000));
});

test("A11-245: a job with no estimate or no progress leaves the missing part out, and one past its estimate shows no time", () => {
  assert.equal(waitText([job("1", { estimatedFinish: null })], NOW), "Waiting on fleet job 1 (4 of 6 pages)");
  assert.equal(waitText([job("1", { progress: null, state: "queued", estimatedFinish: null })], NOW), "Waiting on fleet job 1 (queued)");
  assert.equal(waitText([job("1", { estimatedFinish: NOW - MIN })], NOW), "Waiting on fleet job 1 (4 of 6 pages)");
});

test("A11-245: a wait with no readings yet reads as just waiting", () => {
  assert.equal(waitText([], NOW), "Waiting");
});

test("A11-245: several items are joined with a semicolon, each in its own words", () => {
  const readings: Reading[] = [job("fj-1", { state: "done" }, "finished"),
    { wait: { kind: "ciRun", repository: "a11ign/x", runId: 9 }, status: "pending", run: { status: "in_progress", conclusion: null, url: "u", name: "ci", jobs: { done: 3, total: 5 } } },
    { wait: { kind: "pullRequest", url: "https://github.com/o/r/pull/1", until: "reviewed" }, status: "pending", pull: { state: "OPEN", review: null } },
    { wait: { kind: "ticket", key: "A11-243", until: "done" }, status: "pending", stateType: "started" }];
  assert.equal(waitText(readings, NOW), "Waiting on fleet job fj-1 (done); CI run a11ign/x#9 (running, 3 of 5 jobs); pull request https://github.com/o/r/pull/1 (open, not reviewed yet); ticket A11-243 (started)");
});

test("A11-245: an item that could not be read says so and why", () => {
  assert.equal(waitText([{ wait: { kind: "fleetJob", id: "fj-2" }, status: "unreadable", why: "fleet job status fj-2 did not answer in 30 s" }], NOW), "Waiting on fleet job fj-2 (could not read it: fleet job status fj-2 did not answer in 30 s)");
});

test("A11-245: a run that has declared a wait and not been read yet names what it waits on", () => {
  assert.equal(pendingText([{ kind: "fleetJob", id: "fj-1" }, { kind: "ciRun", repository: "a11ign/x", runId: 9 }]), "Waiting on fleet job fj-1; CI run a11ign/x#9");
});
