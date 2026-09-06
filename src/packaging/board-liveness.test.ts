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

test("the check does NOT run on a schedule, which is the property it exists for", () => {
  // PINNED, because it is the one design decision that cannot be recovered by reading the script: a
  // watchdog moved onto a cron is disabled by the same repository inactivity it watches for, and the
  // change would look like tidying two scheduled jobs into three.
  const workflow = readFileSync(path.join(REPO_ROOT, ".github/workflows/board-liveness.yml"), "utf8");
  assert.ok(!/^\s*schedule:/m.test(workflow),
    "board-liveness.yml must not be scheduled. GitHub disables scheduled workflows repository-wide after "
    + "60 days of inactivity, so a scheduled watchdog dies in the same breath as the jobs it guards. It "
    + "runs on push, which cannot be disabled by inactivity because a push IS the activity");
  assert.match(workflow, /^\s*push:/m, "it must run on push -- the trigger that inactivity cannot silence");
});
