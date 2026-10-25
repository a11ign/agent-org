// no-token: none -- the card's words and status for a parked run, in memory
// A11-272: a run parked on a wait is Waiting and says what it waits on and until when, never In progress or Working; a queued ticket held by an overlap names the ticket that holds it
import { test } from "node:test";
import assert from "node:assert/strict";
import { reasonOf } from "./run-reason.ts";
import { runStatus, shownStatus, statusCounts, waitNote, workingNote } from "./pull-status-and-notes.ts";
import { RUN_STATUSES, type ViewEntry } from "./view-types-and-filters.ts";
import { clockOf } from "./update-banner.ts";
import { waitText } from "../wait-on/wait-text.ts";
import type { Reading, Wait } from "../wait-on/wait-types.ts";

const AT = Date.UTC(2026, 9, 25, 13, 30);
const NOW = AT + 5 * 60_000;
const UNTIL = AT + 3 * 60 * 60_000;
const URL = "https://github.com/a11ign/lab/pull/7";
const JOB: Wait = { kind: "fleetJob", id: "fj-123" };
const RUN: Wait = { kind: "ciRun", repository: "a11ign/lab", runId: 9 };
const PULL: Wait = { kind: "pullRequest", url: URL, until: "merged" };
const TICKET: Wait = { kind: "ticket", key: "A11-229", until: "done" };

const reading = (wait: Wait): Reading => {
  switch (wait.kind) {
    case "fleetJob": return { wait, status: "pending", job: { state: "running", reason: null, results: null, progress: { done: 4, total: 6 }, estimatedFinish: NOW + 20 * 60_000 } };
    case "ciRun": return { wait, status: "pending", run: { status: "in_progress", conclusion: null, jobs: { done: 3, total: 5 } } as never };
    case "pullRequest": return { wait, status: "pending", pull: { state: "OPEN", review: null } };
    case "ticket": return { wait, status: "pending", stateType: "In Progress" };
  }
};

/** A running run parked on `wait`, with the words the board stored at its last poll. */
const parkedOn = (wait: Wait, over: Record<string, unknown> = {}) =>
  ({ ticket: { key: "A11-231" }, phase: "running", working: { reason: "step 2 needs it", at: AT, waiting: true, waits: [wait], waitText: waitText([reading(wait)], NOW), ...over } }) as unknown as ViewEntry;

const UNTIL_WORDS = `, until ${clockOf(UNTIL)}`;

test("A11-272: a run parked on a ticket says Waiting on that ticket, with the deadline, and its status is Waiting", () => {
  const run = parkedOn(TICKET);
  assert.equal(runStatus(run), "waiting");
  assert.equal(reasonOf(run, NOW).line, `Waiting on ticket A11-229 (In Progress)${UNTIL_WORDS}`);
});

test("A11-272: a run parked on a fleet job, a CI run or a pull request says so, with the deadline", () => {
  assert.equal(workingNote(parkedOn(JOB), NOW)?.text, `Waiting on fleet job fj-123 (4 of 6 pages, about 20 min)${UNTIL_WORDS}`);
  assert.equal(workingNote(parkedOn(RUN), NOW)?.text, `Waiting on CI run a11ign/lab#9 (running, 3 of 5 jobs)${UNTIL_WORDS}`);
  assert.equal(workingNote(parkedOn(PULL), NOW)?.text, `Waiting on pull request ${URL} (open)${UNTIL_WORDS}`);
  for (const wait of [JOB, RUN, PULL, TICKET]) assert.equal(runStatus(parkedOn(wait)), "waiting");
});

test("A11-272: the deadline is the `until` the outcome gave when it gave one", () => {
  const until = AT + 45 * 60_000;
  assert.equal(workingNote(parkedOn(TICKET, { until }), NOW)?.text, `Waiting on ticket A11-229 (In Progress), until ${clockOf(until)}`);
});

test("A11-272: a wait past its deadline still says Waiting and when it was due", () => {
  const run = parkedOn(JOB, { until: AT + 10 * 60_000 });
  assert.equal(workingNote(run, AT + 90 * 60_000)?.text.endsWith(`, until ${clockOf(AT + 10 * 60_000)}`), true);
  assert.equal(runStatus(run), "waiting");
});

test("A11-272: a wait on background work the worker holds itself says Waiting, for how long, and until when", () => {
  const run = { ticket: { key: "A11-231" }, phase: "running", working: { reason: "capture shells", at: AT, waiting: true, waitingOn: "the capture shells" } } as unknown as ViewEntry;
  assert.equal(workingNote(run, NOW)?.text, `Waiting on background work for 5 min: the capture shells${UNTIL_WORDS}`);
  assert.equal(runStatus(run), "waiting");
});

test("A11-272: a parked run is never In progress: only a run at work is, and a stalled one", () => {
  const atWork = { ticket: { key: "A11-1" }, phase: "running", working: { reason: "building", at: AT } } as unknown as ViewEntry;
  const stalled = { ticket: { key: "A11-2" }, phase: "running", working: { reason: "building", at: AT, stalled: true, stallReason: "idle with no newer outcome" } } as unknown as ViewEntry;
  assert.deepEqual([runStatus(atWork), runStatus(stalled), runStatus(parkedOn(TICKET))], ["working", "working", "waiting"]);
  assert.equal(RUN_STATUSES.find(({ status }) => status === "waiting")?.label, "Waiting");
  const counts = statusCounts([atWork, stalled, parkedOn(TICKET)]);
  assert.deepEqual([counts.get("working"), counts.get("waiting")], [2, 1]);
});

test("A11-272: a run that needs a person, or is being talked to, is still that and not Waiting", () => {
  assert.equal(runStatus({ ...parkedOn(TICKET), waiting: true } as ViewEntry), "needs-you");
  assert.equal(runStatus({ ...parkedOn(TICKET), talk: true } as ViewEntry), "talking");
  assert.equal(shownStatus(parkedOn(TICKET), undefined), "waiting");
});

test("A11-272: a queued ticket held by an overlap names the ticket that holds it, with its pull request when it has one and without", () => {
  const paths = ["lab:middleware/runtime/main.py"];
  const waiting = { ticket: { key: "A11-229" }, phase: "queued", paths } as unknown as ViewEntry;
  const running = { ticket: { key: "A11-231" }, phase: "running", paths } as unknown as ViewEntry;
  assert.equal(waitNote(waiting, [waiting, running]), "Waits on A11-231: both touch middleware/runtime/main.py");
  const finished = { ticket: { key: "A11-231" }, phase: "finished", paths, outcome: { kind: "ready-pr", prs: [{ url: URL, repo: "lab" }] }, pullFiles: { [URL]: ["middleware/runtime/main.py"] } } as unknown as ViewEntry;
  assert.equal(waitNote(waiting, [waiting, finished]), "Waits on A11-231 #7: both touch middleware/runtime/main.py");
});

test("A11-272: a planning run or a review round parked on a wait reads Waiting too, since nothing is at work in it; once woken it is Planning or Reviewing again", () => {
  assert.equal(runStatus({ ...parkedOn(TICKET), plan: { model: "opus", effort: "max" } } as ViewEntry), "waiting");
  assert.equal(runStatus({ ...parkedOn(TICKET), review: [{ url: URL }] } as ViewEntry), "waiting");
  const woken = { ...parkedOn(TICKET, { waiting: undefined }), plan: { model: "opus", effort: "max" } } as ViewEntry;
  assert.equal(runStatus(woken), "planning");
});
