/**
 * A CHECK ABOUT AN ABSENCE MUST BE SHOWN TO FIRE, because the state it watches for is indistinguishable
 * from the state where everything is fine: nothing happening.
 *
 * `board-schedule-liveness.mjs` answers "have the board editions stopped arriving" — the gap
 * `docs/backlog.md` records as *"every refusal is reported by the job itself, so a job that does not exist
 * reports nothing"*. Its whole value is in the one case nobody can arrange on demand, so the verdict is a
 * PURE function over `(last edition day, now, does a summary exist for day X)` and these drive it with
 * synthetic inputs. No network, no clock, no issue.
 *
 * THE THREE STATES THIS PINS, and the middle one is why the check is not a one-line date comparison:
 *
 *   - editions arriving        -> ALIVE
 *   - no editions, no summaries written -> ALIVE, and it says why: the 08:00 gate refuses without a
 *     summary, deliberately, so this is the pipeline working. Reporting it as a dead schedule would
 *     accuse the schedule of doing its job.
 *   - no editions, summaries WERE written -> STOPPED. The gate had no reason to refuse and nothing
 *     published anyway.
 *
 * Collapsing the middle into the third is the version of this check that gets switched off inside a week,
 * which is the same reason `packedButUntracked` had to learn ignored-versus-forgotten and the reason
 * `real-page-corpus-freshness.test.ts` keeps an EXEMPT table instead of a bare list.
 */
// no-token: gh
//
// #827. Every test here is driven with FIXTURES or an INJECTED `run` -- `livenessVerdict`,
// `missedTodaysWindow`, `daysSince`, `scheduleNeverFired`, `watchdogSilenceLine` all take their inputs as
// arguments, and `hoursSincePreviousRun` takes the runner as its first parameter, which these tests
// supply as a closure over a fixture string. The closure walk reaches `board-data.mjs`'s `gh` through
// `EXIT -> REPO`, a constant, rather than through anything these tests execute.
//
// The declaration is verified against the entry's own code, so if one of these functions ever starts
// doing its own lookups this refuses rather than trusting the comment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { EXIT, daysSince, livenessVerdict, newestEditionDay }
  from "../../../../scripts/board-schedule-liveness.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const NOW = new Date("2026-09-20T09:00:00Z");

/** No summary was ever written — the gate would refuse every day. */
const NO_SUMMARIES = () => false;
/** A summary was written every day — the gate had no reason to refuse on any of them. */
const ALL_SUMMARIES = () => true;

test("an edition from today reads ALIVE", () => {
  const v = livenessVerdict({ lastDay: "2026-09-20", now: NOW, hasSummary: ALL_SUMMARIES });
  assert.equal(v.code, EXIT.ALIVE);
});

test("a single missed day is not a finding — the gate refusing once is the pipeline working", () => {
  // The anti-noise half. Without it, "it fires" would mean "it fires on any gap", and a check that fires
  // on correct behaviour is one somebody disables rather than reads.
  const v = livenessVerdict({ lastDay: "2026-09-19", now: NOW, hasSummary: ALL_SUMMARIES });
  assert.equal(v.code, EXIT.ALIVE, "one day without an edition must not accuse the schedule");
});

test("STOPPED: a week of missed editions WITH summaries written accuses the schedule, and names the fix", () => {
  const v = livenessVerdict({ lastDay: "2026-09-13", now: NOW, hasSummary: ALL_SUMMARIES });
  assert.equal(v.code, EXIT.STOPPED);
  assert.match(v.detail, /disabled after 60 days/,
    "the detail must name the actual mechanism -- a scheduled workflow GitHub disabled for inactivity -- "
    + "because 'the editions stopped' sends a reader to the script and the cause is not in the script");
  assert.match(v.detail, /gh workflow enable board-report\.yml/,
    "and it must carry the command that fixes it: a diagnosis with no next command is where an "
    + "investigation stops");
});

test("NOT stopped: the same week of missed editions with NO summaries is the gate working, not a fault", () => {
  // THE DISTINCTION THE WHOLE CHECK TURNS ON. Identical absence, opposite verdicts, because the cause is
  // different and the two need opposite responses -- 'write the summary' against 'the schedule is dead'.
  const v = livenessVerdict({ lastDay: "2026-09-13", now: NOW, hasSummary: NO_SUMMARIES });
  assert.equal(v.code, EXIT.ALIVE,
    "no summary means the 08:00 job refused by design; accusing the schedule here would report a working "
    + "gate as a broken one");
  assert.match(v.detail, /the missing thing is the summary/);
});

test("never published at all is stated as its own state, not folded into 'stopped since'", () => {
  const v = livenessVerdict({ lastDay: null, now: NOW, hasSummary: ALL_SUMMARIES });
  assert.equal(v.code, EXIT.STOPPED);
  assert.match(v.headline, /NO board edition has ever been published/,
    "a pipeline nobody has run and one that has died need different first moves, so they must not print "
    + "the same sentence");
});

test("the newest edition is read from the HEADING, and the newest wins regardless of comment order", () => {
  const bodies = [
    "# Board report — 2026-09-11\n\nsome text",
    "not an edition at all, just a comment",
    "# Board report — 2026-09-18\n\nsome text",
    "# Board report — 2026-09-04\n\nsome text",
  ];
  assert.equal(newestEditionDay(bodies), "2026-09-18");
});

test("a comment that merely MENTIONS an edition is not mistaken for one", () => {
  // The vacuity direction: a heading match anywhere in a body would let a reply quoting the report read as
  // a fresh edition, which would report a dead schedule as healthy -- the failure that matters most here.
  assert.equal(newestEditionDay(["I was reading the # Board report — 2026-09-18 and had a question"]), null,
    "the heading must be at the start of a line; an inline mention is somebody talking ABOUT an edition");
  assert.equal(newestEditionDay([]), null, "no comments is no edition, never a date");
});

test("daysSince counts whole days, so 'today' is 0 and does not read as stale", () => {
  assert.equal(daysSince("2026-09-20", NOW), 0);
  assert.equal(daysSince("2026-09-17", NOW), 3);
});

// #901: the watchdog is a step in `trunk.yml`'s `watchdogs` job since 2026-09-10, not a workflow of
// #909 (2026-09-12): the no-`schedule:` assertion below is on the WHOLE file, so it also covers `decideRevert`
// and `closeRows`, which live in `trunk.yml` as tenants -- measured by worker-capture on #1145: a cron added to
// trunk.yml fails this test AND the identical assertions in npm-token-liveness.test.ts and
// workflow-run-liveness.test.ts (measured by ceo, each file run alone: 1 red in all three). Three guards hold
// the constraint; a run that names only one of them has left the other two out of its set.
// its own -- same trigger, same script, no workflow run of its own. The pin follows it there.
const TRUNK_GUARD = path.join(REPO_ROOT, ".github/workflows/trunk.yml");

test("the check does NOT run on a schedule, which is the property it exists for", () => {
  // PINNED, because it is the one design decision that cannot be recovered by reading the script: a
  // watchdog moved onto a cron is disabled by the same repository inactivity it watches for, and the
  // change would look like tidying a push-triggered step into the nightly file.
  const workflow = readFileSync(TRUNK_GUARD, "utf8");
  assert.ok(!/^\s*schedule:/m.test(workflow),
    "trunk.yml must not be scheduled. GitHub disables scheduled workflows repository-wide after "
    + "60 days of inactivity, so a scheduled watchdog dies in the same breath as the jobs it guards. It "
    + "runs on push, which cannot be disabled by inactivity because a push IS the activity");
  assert.match(workflow, /^\s*push:/m, "it must run on push -- the trigger that inactivity cannot silence");
  assert.match(workflow, /run: node scripts\/board-schedule-liveness\.mjs --post --issue=20/,
    "the board watchdog step must still be in trunk.yml -- a watchdog in no workflow has silently stopped");
  const nightly = readFileSync(path.join(REPO_ROOT, ".github/workflows/nightly.yml"), "utf8");
  assert.doesNotMatch(nightly, /board-schedule-liveness\.mjs/,
    "the board watchdog must not ALSO be in nightly.yml -- a cron copy would look like it covers the gap");
});

// ---------------------------------------------------------------------------------------------------
// #590: THE HEADER CLAIMED TWO WORKFLOWS AND THE CODE GUARDED ONE.
//
// `board-liveness.yml`'s header has always said it watches both `board-report.yml` and
// `board-summary-check.yml`. `board-schedule-liveness.mjs` guarded only the first, through a single
// constant -- in the one place whose entire job is noticing silence. On 2026-09-08 the summary check
// stopped running for nineteen hours, nothing said so, and the first anyone knew was the next morning,
// when the missing summary turned main's own tip red and blocked every PR in the repository.
// ---------------------------------------------------------------------------------------------------
import { GUARDED_WORKFLOWS, missedTodaysWindow } from "../../../../scripts/board-schedule-liveness.mjs";
import { hoursSincePreviousRun, watchdogSilenceLine } from "../../../../scripts/board-schedule-liveness.mjs";

test("#590 every workflow the watchdog's HEADER names is one its code actually guards", () => {
  // DERIVED FROM THE HEADER, never a second hand-written list -- a second list is exactly what the first
  // constant became. If the header stops naming a workflow, or starts naming a third, this fails until
  // somebody decides which of the two is wrong.
  const header = readFileSync(TRUNK_GUARD, "utf8")
    .split("\n").filter((l) => l.trimStart().startsWith("#")).join("\n");
  const named = [...new Set([...header.matchAll(/`(board-[a-z-]+\.yml)`/g)].map((m) => m[1]))];
  assert.ok(named.length >= 2, `the header must still name the workflows it guards; found ${named.length}`);
  for (const workflow of named) {
    assert.ok(GUARDED_WORKFLOWS.includes(workflow),
      `${workflow} is named in trunk.yml's header but is not in GUARDED_WORKFLOWS -- the header `
      + "claiming more than the code guards is the defect #590 was filed for");
  }
});

test("#590 NOT A STALENESS THRESHOLD: 'not yet' and 'did not' stay different answers", () => {
  const today = "2026-09-09";
  // Before the deadline hour, a missing run is NOT YET -- null, never false and never true.
  assert.equal(missedTodaysWindow({ runDays: [], today, londonHour: 6, afterHour: 8 }), null);
  // After it, a missing run is the finding.
  assert.equal(missedTodaysWindow({ runDays: ["2026-09-08"], today, londonHour: 9, afterHour: 8 }), true);
  // And a run today is fine however old the rest of the history is.
  assert.equal(missedTodaysWindow({ runDays: [today, "2026-09-01"], today, londonHour: 9, afterHour: 8 }), false);
  // A failed lookup is never an answer.
  assert.equal(missedTodaysWindow({ runDays: null, today, londonHour: 9, afterHour: 8 }), null);
});

test("#590 MUTATION TARGET: the nineteen-hour silence a staleness threshold could not have caught", () => {
  // The obvious check -- "the newest scheduled run is more than N hours old" -- would have missed this.
  // board-summary-check.yml fires four daily crons whose largest legitimate gap is about 22 hours, so a
  // nineteen-hour silence sits inside any honest threshold. The measured incident: last run 2026-09-08
  // 12:17Z, nothing overnight, and the summary was missing by 07:09Z the next morning.
  assert.equal(
    missedTodaysWindow({ runDays: ["2026-09-08"], today: "2026-09-09", londonHour: 8, afterHour: 8 }),
    true, "a run yesterday and none today, asked after the deadline hour, is the finding");
});

// ---------------------------------------------------------------------------------------------------
// #272: THE WATCHDOG REPORTS ITS OWN SILENCE.
//
// This check runs on `push` and only on `push`, and the test above pins that. The cost of the choice is
// a gap: on a day nobody pushes to main it does not run, and a missing edition goes unreported until the
// next push. **Not noticed and nothing wrong look identical from the outside** — which is the failure
// this whole file exists to end, turned on the file itself.
//
// Two alternatives were refused, and the reasons are the row's: a `schedule:` contradicts the header and
// the pinned test; a second event trigger buys a workflow firing on every label change — measured on
// `ready-label-audit` the same day at 200 runs, 175 cancelled, 0 succeeded — to cover a gap that has not
// occurred once (a push to main on every one of the last 15 days).

test("#272 the previous run is read at INDEX 1, because index 0 is this run reporting on itself", () => {
  const now = new Date("2026-09-09T18:00:00Z");
  const runs = [{ createdAt: "2026-09-09T17:59:00Z" }, { createdAt: "2026-09-09T12:00:00Z" }];
  const hours = hoursSincePreviousRun(() => JSON.stringify(runs), now);
  assert.equal(Math.round(hours ?? -1), 6,
    "index 0 would answer ~0h — true, useless, and indistinguishable from a healthy answer");
});

test("#272 UNREADABLE SAYS SO -- a failed lookup is not `it ran recently`", () => {
  assert.equal(hoursSincePreviousRun(() => { throw new Error("gh: not authenticated"); }, new Date()), null);
  assert.equal(hoursSincePreviousRun(() => JSON.stringify([{ createdAt: "2026-09-09T17:59:00Z" }]), new Date()),
    null, "one run means there is no PREVIOUS run to measure -- the answer is unknown, not zero");
  assert.match(String(watchdogSilenceLine(null)), /UNKNOWN/);
  assert.match(String(watchdogSilenceLine(null)), /Unknown is not recent/);
});

test("#272 past the threshold the line is a warning ABOUT THE CHECK, not about the board -- a reader who "
  + "sees `editions are arriving` has no way to know the sentence is a day old", () => {
  const quiet = String(watchdogSilenceLine(30));
  assert.match(quiet, /WARNING ABOUT THIS CHECK, NOT ABOUT THE BOARD/);
  assert.match(quiet, /30h/);
  assert.match(quiet, /nobody pushed/, "it must name the mechanism, or the reader cannot act on it");

  const fine = String(watchdogSilenceLine(3));
  assert.match(fine, /3h/, "and under the threshold it still prints the number");
  assert.doesNotMatch(fine, /WARNING/, "a number a reader can weigh beats an alarm they learn to ignore");
});

test("#272 MUTATION: the threshold is 26h, not 24 -- a full day plus a margin, so ordinary drift between "
  + "one push and the next does not read as a dead watchdog", () => {
  assert.doesNotMatch(String(watchdogSilenceLine(25)), /WARNING/);
  assert.match(String(watchdogSilenceLine(26)), /WARNING/);
});
