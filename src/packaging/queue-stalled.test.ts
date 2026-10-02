// no-token: gh -- the verdicts are pure and driven with recorded rollups; the script is only spawned to show it refuses
// before any gh call (an unknown flag, no GITHUB_REPOSITORY). #1623's route (a), product-manager 15:05Z.
/**
 * #361: AN ARMED, GREEN, CONFLICTING PR SITS FOREVER, AND NOTHING SAYS WHY.
 *
 * `stalledVerdict` is the whole decision, as one pure function, and `mergeTreeConflict` drives the real
 * `git merge-tree --write-tree --name-only` invocation with an injectable runner so the parsing is tested
 * against real, captured output rather than a guessed shape. See queue-stalled.mjs's own header for the
 * incident (#232/#281, 12.5 PR-hours invisible) and why `mergeable` is not the instrument.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  stalledVerdict, mergeTreeConflict, DEFAULT_STALL_THRESHOLD_MS,
  armedBehindVerdict, behindByCount, formatBehindWatchdogLine, DEFAULT_BEHIND_STALL_THRESHOLD_SECONDS, supersedingGateVerdict, supersededLine, examinePr,
  neverScheduledVerdict, neverScheduledLine, DEFAULT_NEVER_SCHEDULED_THRESHOLD_MS, headCommittedAt } from "../queue-stalled.mjs";
import { newestConclusion, headQuietSeconds } from "../update-branch-sweep.mjs";

// ---------------------------------------------------------------------------------------------------
// #1100: THIS FILE'S SUBJECT HAS A SECOND VOCABULARY, and it arrived through a shared function.
//
// `newestConclusion` lives in `update-branch-sweep.mjs` and normalises `gh`'s two spellings of the same
// verdict -- `SUCCESS` on `statusCheckRollup`, `success` on the REST check-runs API -- at its own edge.
// **That changed what THIS file reads**, and its three comparisons still spelled `"SUCCESS"`, so every
// green armed pull request reported "has not concluded SUCCESS" and the watchdog found 0 of 2.
//
// A fix applied at one call site when the behaviour reaches several: this repository's most expensive
// recurring shape, and the fix for a vocabulary split walked straight into it.
// ---------------------------------------------------------------------------------------------------

import { sandboxGitEnv } from "../lib/git-env.mjs";
import { queueEjectionOf, ejectionQueryArgs, armedFromApi } from "../pr-armed-state.mjs";
import { readEjections, decide, stallReasonOf, greenUnarmedOrders, STALL_REASON } from "../work-gate.mjs";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../queue-stalled.mjs");

// --- stalledVerdict: the pure decision ---

test("#1100: BOTH of gh's spellings reach the same verdict, in this file's predicates too", () => {
  // The regression was invisible to this suite because its fixtures are written in `statusCheckRollup`'s
  // vocabulary and the pure functions were compared against a literal in that same vocabulary -- the
  // agreement was between two copies of one spelling, not between the function and its real input.
  //
  // Driven in both, asserted on the WHOLE verdict rather than on `.stalled`, so a code or reason that
  // diverged by spelling would fail here rather than read as agreement.
  for (const [upper, lower] of [["SUCCESS", "success"], ["FAILURE", "failure"], ["CANCELLED", "cancelled"]]) {
    assert.deepEqual(
      armedBehindVerdict({ armed: true, gateConclusion: upper, behindBy: 14, quietSeconds: 3000 }),
      armedBehindVerdict({ armed: true, gateConclusion: lower, behindBy: 14, quietSeconds: 3000 }),
      `armedBehindVerdict must not care which API spelled \`${upper}\``);
    assert.deepEqual(
      stalledVerdict({ armed: true, gateConclusion: upper, conflict: false, ageMs: 9e8 }),
      stalledVerdict({ armed: true, gateConclusion: lower, conflict: false, ageMs: 9e8 }),
      `stalledVerdict must not care which API spelled \`${upper}\``);
  }

  // AND THE ONE THAT BROKE: a green armed PR must read as green through the real reader.
  const rollup = [{ name: "gate", conclusion: "SUCCESS", completedAt: "2026-09-12T12:00:00Z" }];
  const found = armedBehindVerdict({
    armed: true, gateConclusion: newestConclusion(rollup, "gate"), behindBy: 14, quietSeconds: 3000,
  });
  assert.equal(found.stalled, true,
    "fed from `newestConclusion` -- THE PRODUCTION PATH -- a green armed behind PR must still be found; "
    + "this is the assertion the regression would have failed, and the suite had none like it");
  assert.equal(found.code, "BEHIND", "and reported under its own code, not a neighbouring one");
});

test("stalledVerdict: not armed at all is never this check's concern", () => {
  const v = stalledVerdict({ armed: false, gateConclusion: "SUCCESS", conflict: true, ageMs: 1e9 });
  assert.equal(v.stalled, false);
  assert.equal(v.code, "NOT_ARMED");
});

test("stalledVerdict: armed with gate still running (no conclusion) is healthy, not stalled", () => {
  const v = stalledVerdict({ armed: true, gateConclusion: null, conflict: false, ageMs: 10 });
  assert.equal(v.stalled, false);
  assert.equal(v.code, "WAITING");
});

test("stalledVerdict: armed, gate FAILURE (not SUCCESS) is WAITING too -- a different problem, not this one", () => {
  const v = stalledVerdict({ armed: true, gateConclusion: "FAILURE", conflict: false, ageMs: 1e9 });
  assert.equal(v.stalled, false);
  assert.equal(v.code, "WAITING");
});

test("stalledVerdict: armed, green, no conflict -- waiting its turn, never reported", () => {
  const v = stalledVerdict({ armed: true, gateConclusion: "SUCCESS", conflict: false, ageMs: 1e9 });
  assert.equal(v.stalled, false);
  assert.equal(v.code, "HEALTHY");
});

test("stalledVerdict: a conflict younger than the threshold is TOO_RECENT, not stalled -- avoids a false "
  + "alarm against a stale local view of origin/main", () => {
  const v = stalledVerdict({ armed: true, gateConclusion: "SUCCESS", conflict: true, ageMs: 60_000 });
  assert.equal(v.stalled, false);
  assert.equal(v.code, "TOO_RECENT");
});

test("stalledVerdict: MUTATION TARGET -- armed, green, conflict, past the threshold IS stalled", () => {
  const v = stalledVerdict({
    armed: true, gateConclusion: "SUCCESS", conflict: true, ageMs: DEFAULT_STALL_THRESHOLD_MS + 1,
  });
  assert.equal(v.stalled, true);
  assert.equal(v.code, "CONFLICTING");
});

test("stalledVerdict: exactly AT the threshold counts as past it -- the floor is inclusive of staleness, "
  + "never a reason to wait one more tick", () => {
  const v = stalledVerdict({
    armed: true, gateConclusion: "SUCCESS", conflict: true, ageMs: DEFAULT_STALL_THRESHOLD_MS,
  });
  assert.equal(v.stalled, true);
});

test("stalledVerdict: a custom thresholdMs is honoured, not the default silently", () => {
  const v = stalledVerdict({ armed: true, gateConclusion: "SUCCESS", conflict: true, ageMs: 5000, thresholdMs: 1000 });
  assert.equal(v.stalled, true);
});

// --- mergeTreeConflict: real `git merge-tree` output, captured and replayed ---

test("mergeTreeConflict: a clean merge (exit 0, one tree-oid line) reports no conflict, no files", () => {
  const result = mergeTreeConflict("origin/main", "deadbeef",
    () => ({ status: 0, stdout: "dcbad582aeafecc9ed419818ab5cebf4c56247de\n" }));
  assert.deepEqual(result, { conflict: false, files: [] });
});

test("mergeTreeConflict: MUTATION TARGET -- real captured conflict output (PR #232's own shape) names "
  + "every conflicting file and none of the trailer noise", () => {
  // Captured verbatim from `git merge-tree --write-tree --name-only origin/main <head>` against a real
  // conflicting PR, 2026-09-07 -- never re-typed by hand, so this fixture cannot silently drift from what
  // git actually emits.
  const stdout = [
    "43bb45c033083196df4059b2d6b668f60c140698",
    "packages/agent-org/src/board-data.mjs",
    "packages/agent-org/src/board-document.mjs",
    "scripts/board-only-check.mjs",
    "packages/agent-org/src/board-report.mjs",
    "scripts/ci-changed.mjs",
    "packages/guards/src/isolation-gate.mjs",
    "",
    "Auto-merging packages/agent-org/src/board-data.mjs",
    "CONFLICT (content): Merge conflict in packages/agent-org/src/board-data.mjs",
    "Auto-merging packages/agent-org/src/board-document.mjs",
    "CONFLICT (content): Merge conflict in packages/agent-org/src/board-document.mjs",
    "",
  ].join("\n");
  const result = mergeTreeConflict("origin/main", "deadbeef", () => ({ status: 1, stdout }));
  assert.equal(result.conflict, true);
  assert.deepEqual(result.files, [
    "packages/agent-org/src/board-data.mjs", "packages/agent-org/src/board-document.mjs", "scripts/board-only-check.mjs",
    "packages/agent-org/src/board-report.mjs", "scripts/ci-changed.mjs", "packages/guards/src/isolation-gate.mjs",
  ]);
});

test("mergeTreeConflict: the tree-oid line itself is never reported as a conflicting FILE", () => {
  const stdout = "43bb45c033083196df4059b2d6b668f60c140698\nscripts/one.mjs\n\nAuto-merging scripts/one.mjs\n";
  const { files } = mergeTreeConflict("origin/main", "deadbeef", () => ({ status: 1, stdout }));
  assert.ok(!files.includes("43bb45c033083196df4059b2d6b668f60c140698"), "the tree oid must never be read as a path");
  assert.deepEqual(files, ["scripts/one.mjs"]);
});

test("mergeTreeConflict: runs the REAL git binary against real objects in this repo -- own head vs. own "
  + "head is trivially clean", () => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", env: sandboxGitEnv() }).trim();
  const result = mergeTreeConflict(head, head, (args) => {
    try {
      const stdout = execFileSync("git", args, { encoding: "utf8", env: sandboxGitEnv() });
      return { status: 0, stdout };
    } catch (cause) {
      const err = cause as { status?: number, stdout?: string };
      return { status: err.status ?? 1, stdout: err.stdout ?? "" };
    }
  });
  assert.equal(result.conflict, false);
});

// --- armedBehindVerdict: C5a/#509's pure decision ---

test("armedBehindVerdict: not armed is never this check's concern", () => {
  const v = armedBehindVerdict({ armed: false, gateConclusion: "SUCCESS", behindBy: 30, quietSeconds: 3000 });
  assert.equal(v.stalled, false);
  assert.equal(v.code, "NOT_ARMED");
});

test("armedBehindVerdict: gate not SUCCESS is WAITING, not stalled", () => {
  const v = armedBehindVerdict({ armed: true, gateConclusion: "FAILURE", behindBy: 30, quietSeconds: 3000 });
  assert.equal(v.stalled, false);
  assert.equal(v.code, "WAITING");
});

test("armedBehindVerdict: armed, green, current with main (behindBy 0) is HEALTHY", () => {
  const v = armedBehindVerdict({ armed: true, gateConclusion: "SUCCESS", behindBy: 0, quietSeconds: 3000 });
  assert.equal(v.stalled, false);
  assert.equal(v.code, "HEALTHY");
});

test("armedBehindVerdict: REFUSE RATHER THAN PRINT ZERO -- behind with no timed check run is "
  + "UNRESOLVABLE, never HEALTHY", () => {
  const v = armedBehindVerdict({ armed: true, gateConclusion: "SUCCESS", behindBy: 14, quietSeconds: null });
  assert.equal(v.stalled, false);
  assert.equal(v.code, "UNRESOLVABLE");
});

test("armedBehindVerdict: behind but the head is quiet only 3 minutes -- TOO_RECENT, matches the "
  + "issue's own 'synced 3 minutes ago' fixture naming none", () => {
  const v = armedBehindVerdict({ armed: true, gateConclusion: "SUCCESS", behindBy: 30, quietSeconds: 180 });
  assert.equal(v.stalled, false);
  assert.equal(v.code, "TOO_RECENT");
});

test("armedBehindVerdict: MUTATION TARGET -- armed, green, behind, quiet 40+ minutes IS stalled, "
  + "matching the issue's own fixture", () => {
  const v = armedBehindVerdict({ armed: true, gateConclusion: "SUCCESS", behindBy: 30, quietSeconds: 40 * 60 });
  assert.equal(v.stalled, true);
  assert.equal(v.code, "BEHIND");
});

test("armedBehindVerdict: exactly at the 15m threshold counts as past it -- inclusive of staleness", () => {
  const v = armedBehindVerdict({
    armed: true, gateConclusion: "SUCCESS", behindBy: 1, quietSeconds: DEFAULT_BEHIND_STALL_THRESHOLD_SECONDS,
  });
  assert.equal(v.stalled, true);
});

test("armedBehindVerdict: a custom thresholdSeconds is honoured, not the default silently", () => {
  const v = armedBehindVerdict({
    armed: true, gateConclusion: "SUCCESS", behindBy: 1, quietSeconds: 100, thresholdSeconds: 50,
  });
  assert.equal(v.stalled, true);
});

// --- behindByCount: the real commit-count git does not expose via the API ---

test("behindByCount: zero when base and head are the same object", () => {
  const n = behindByCount("origin/main", "origin/main", (args) => {
    try {
      const stdout = execFileSync("git", args, { encoding: "utf8", env: sandboxGitEnv() });
      return { status: 0, stdout };
    } catch (cause) {
      const err = cause as { status?: number, stdout?: string };
      return { status: err.status ?? 1, stdout: err.stdout ?? "" };
    }
  });
  assert.equal(n, 0);
});

test("behindByCount: reads the real rev-list --count output", () => {
  const n = behindByCount("origin/main", "deadbeef", () => ({ status: 0, stdout: "14\n" }));
  assert.equal(n, 14);
});

test("behindByCount: a failed git call reports 0, never a negative or NaN count", () => {
  const n = behindByCount("origin/main", "deadbeef", () => ({ status: 128, stdout: "" }));
  assert.equal(n, 0);
});

// --- formatBehindWatchdogLine: every number states its window, refuse rather than print zero ---

test("formatBehindWatchdogLine: zero stalled still STATES THE WINDOW -- how many were examined", () => {
  const line = formatBehindWatchdogLine([], [], 7, DEFAULT_BEHIND_STALL_THRESHOLD_SECONDS);
  assert.match(line, /0 of 7/);
  assert.match(line, /15m/);
});

test("formatBehindWatchdogLine: names every stalled PR and its own reason", () => {
  const line = formatBehindWatchdogLine(
    [{ number: 485, behindBy: 30, reason: "armed and green, 30 commit(s) behind" },
     { number: 490, behindBy: 14, reason: "armed and green, 14 commit(s) behind" }],
    [], 2, DEFAULT_BEHIND_STALL_THRESHOLD_SECONDS);
  assert.match(line, /#485/);
  assert.match(line, /#490/);
  assert.match(line, /2 of 2/);
});

test("formatBehindWatchdogLine: an UNRESOLVABLE PR is named on its own line, never folded into "
  + "'0 stalled' -- 'nothing stalled' and 'could not ask' must never be the same output", () => {
  const line = formatBehindWatchdogLine([], [{ number: 501, reason: "no timed check run" }], 1,
    DEFAULT_BEHIND_STALL_THRESHOLD_SECONDS);
  assert.match(line, /0 of 1/);
  assert.match(line, /UNRESOLVABLE/);
  assert.match(line, /#501/);
});

// --- the exact fixture the issue's own acceptance names: #485/#490, behind 14 and 30, stalled 40+ min ---

test("ACCEPTANCE FIXTURE: two PRs armed, latest gate SUCCESS, behind 14 and 30, quiet 40+ minutes -- "
  + "the watchdog line names both", () => {
  const now = new Date("2026-09-08T09:00:00Z");
  // Real shape (#498's own incident): a cancelled ci.yml run leaves a FAILED gate OLDER than the real
  // SUCCESS, and the rollup's array order is not chronological -- the older, failed run is listed FIRST.
  const rollup485 = [
    { name: "gate", conclusion: "FAILURE", startedAt: "2026-09-08T08:10:00Z", completedAt: "2026-09-08T08:10:05Z" },
    { name: "gate", conclusion: "SUCCESS", startedAt: "2026-09-08T08:15:34Z", completedAt: "2026-09-08T08:15:40Z" },
  ];
  const rollup490 = [
    { name: "gate", conclusion: "FAILURE", startedAt: "2026-09-08T08:05:00Z", completedAt: "2026-09-08T08:05:05Z" },
    { name: "gate", conclusion: "SUCCESS", startedAt: "2026-09-08T08:12:28Z", completedAt: "2026-09-08T08:12:33Z" },
  ];
  const prs = [
    { number: 485, behindBy: 30, rollup: rollup485 },
    { number: 490, behindBy: 14, rollup: rollup490 },
  ];
  const stalledList = [];
  for (const pr of prs) {
    const gateConclusion = newestConclusion(pr.rollup, "gate");
    const quietSeconds = headQuietSeconds(pr.rollup, now);
    const v = armedBehindVerdict({ armed: true, gateConclusion, behindBy: pr.behindBy, quietSeconds });
    if (v.stalled) stalledList.push({ number: pr.number, behindBy: pr.behindBy, reason: v.reason });
  }
  const line = formatBehindWatchdogLine(stalledList, [], prs.length, DEFAULT_BEHIND_STALL_THRESHOLD_SECONDS);
  assert.match(line, /#485/, "the watchdog must name #485");
  assert.match(line, /#490/, "the watchdog must name #490");
});

test("ACCEPTANCE FIXTURE, other half: the same two PRs synced 3 minutes ago -- the line names neither", () => {
  const now = new Date("2026-09-08T09:00:00Z");
  const recentRollup = [
    { name: "gate", conclusion: "SUCCESS", startedAt: "2026-09-08T08:57:00Z", completedAt: "2026-09-08T08:57:05Z" },
  ];
  const prs = [
    { number: 485, behindBy: 30, rollup: recentRollup },
    { number: 490, behindBy: 14, rollup: recentRollup },
  ];
  const stalledList = [];
  for (const pr of prs) {
    const gateConclusion = newestConclusion(pr.rollup, "gate");
    const quietSeconds = headQuietSeconds(pr.rollup, now);
    const v = armedBehindVerdict({ armed: true, gateConclusion, behindBy: pr.behindBy, quietSeconds });
    if (v.stalled) stalledList.push({ number: pr.number, behindBy: pr.behindBy, reason: v.reason });
  }
  const line = formatBehindWatchdogLine(stalledList, [], prs.length, DEFAULT_BEHIND_STALL_THRESHOLD_SECONDS);
  assert.doesNotMatch(line, /#485/);
  assert.doesNotMatch(line, /#490/);
  assert.match(line, /0 of 2/);
});

test("MUTATION: dropping the 'latest gate' read for the rollup's FIRST entry makes the acceptance "
  + "fixture miss both stalled PRs -- proving newestConclusion is load-bearing here, not decorative", () => {
  const rollup485 = [
    { name: "gate", conclusion: "FAILURE", startedAt: "2026-09-08T08:32:35Z", completedAt: "2026-09-08T08:32:40Z" },
    { name: "gate", conclusion: "SUCCESS", startedAt: "2026-09-08T08:15:34Z", completedAt: "2026-09-08T08:15:40Z" },
  ];
  // The OLD, buggy read #498 shipped with: the first matching entry in array order, not the newest.
  const buggyGateConclusion = rollup485.find((c) => c.name === "gate")?.conclusion ?? null;
  const v = armedBehindVerdict({
    armed: true, gateConclusion: buggyGateConclusion, behindBy: 30, quietSeconds: 40 * 60,
  });
  assert.equal(v.stalled, false, "the buggy 'first entry' read must miss the stall (WAITING on the "
    + "stale failure), which is exactly what made #485/#490 invisible for hours");
  assert.equal(v.code, "WAITING");
});

// --- neverScheduledVerdict: #1810, a PR GitHub never scheduled a run for ---

test("neverScheduledVerdict: ACCEPTANCE -- open, not draft, past the threshold, zero check runs -- flagged", () => {
  const v = neverScheduledVerdict({
    isDraft: false, ageMs: DEFAULT_NEVER_SCHEDULED_THRESHOLD_MS + 1, checkRunCount: 0,
  });
  assert.equal(v.stalled, true);
  assert.equal(v.code, "NEVER_SCHEDULED");
});

test("neverScheduledVerdict: exactly at the threshold counts as past it, same as every other floor in "
  + "this file", () => {
  const v = neverScheduledVerdict({ isDraft: false, ageMs: DEFAULT_NEVER_SCHEDULED_THRESHOLD_MS, checkRunCount: 0 });
  assert.equal(v.stalled, true);
});

test("neverScheduledVerdict: POSITIVE CONTROL -- a PR seconds old with no runs is TOO_RECENT, never "
  + "flagged -- ordinary Actions scheduling jitter is not this defect", () => {
  const v = neverScheduledVerdict({ isDraft: false, ageMs: 5000, checkRunCount: 0 });
  assert.equal(v.stalled, false);
  assert.equal(v.code, "TOO_RECENT");
});

test("neverScheduledVerdict: any check run at all -- whatever it concluded -- clears it, old or not", () => {
  for (const checkRunCount of [1, 3]) {
    const v = neverScheduledVerdict({
      isDraft: false, ageMs: DEFAULT_NEVER_SCHEDULED_THRESHOLD_MS * 10, checkRunCount,
    });
    assert.equal(v.stalled, false, `checkRunCount=${checkRunCount}`);
    assert.equal(v.code, "HAS_RUNS", `checkRunCount=${checkRunCount}`);
  }
});

test("neverScheduledVerdict: a draft is never flagged, however old and however empty its check runs", () => {
  const v = neverScheduledVerdict({ isDraft: true, ageMs: DEFAULT_NEVER_SCHEDULED_THRESHOLD_MS * 100, checkRunCount: 0 });
  assert.equal(v.stalled, false);
  assert.equal(v.code, "DRAFT");
});

test("neverScheduledVerdict: a custom thresholdMs is honoured, not the default silently", () => {
  const v = neverScheduledVerdict({ isDraft: false, ageMs: 2000, checkRunCount: 0, thresholdMs: 1000 });
  assert.equal(v.stalled, true);
});

test("neverScheduledLine: zero flagged still states the claim, not silence", () => {
  const line = neverScheduledLine([]);
  assert.match(line, /^QUEUE:/);
  assert.match(line, /nothing open with zero scheduled runs/);
});

test("neverScheduledLine: names every flagged PR", () => {
  const line = neverScheduledLine([1808, 1810]);
  assert.match(line, /#1808|1808/);
  assert.match(line, /1810/);
});

// Fake shas with an injected `runGit` (examinePr's third, optional argument -- same DI pattern
// `update-branch-sweep.mjs`'s `sweepPrs` already uses), never real commit objects. The acceptance job's
// own `fetch-depth: 1` checkout is exactly ONE commit: a real, historical sha picked for its committer
// date (as this suite used to) is unreachable there even though it is present in any full clone, so it
// passed under a reviewer's or an author's own full checkout and failed in CI (#1814's own red run) the
// moment `headCommittedAt`'s `git log` came back empty and `examinePr` silently read the unfetched head as
// age zero. Injecting the date removes the dependency on checkout depth entirely.
const OLD_HEAD = "a".repeat(40); // fake sha -- see HEAD_COMMITTED_AT below for its committer date
const FRESH_HEAD = "b".repeat(40);
const FORCE_PUSHED_HEAD = "c".repeat(40);
const HEAD_COMMITTED_AT = {
  [OLD_HEAD]: "2026-09-20T19:01:50Z",
  [FRESH_HEAD]: "2026-09-20T19:31:00Z",
  [FORCE_PUSHED_HEAD]: "2026-09-20T20:05:57Z",
};
const fakeHeadGit = (args: string[]) => {
  const sha = args.at(-1);
  const date = sha === undefined ? undefined : HEAD_COMMITTED_AT[sha as keyof typeof HEAD_COMMITTED_AT];
  return date === undefined ? { status: 1, stdout: "" } : { status: 0, stdout: `${date}\n` };
};

test("examinePr: #1810's own shape -- open, not armed, not draft, old head, zero check runs -- named by "
  + "number, independent of the armed/green precondition every other check in this file requires", () => {
  const now = Date.parse("2026-09-20T19:10:00Z"); // 8m10s after OLD_HEAD's own commit -- past the 5m floor
  const result = examinePr({
    number: 1810, headRefOid: OLD_HEAD, autoMergeRequest: null,
    statusCheckRollup: [], isDraft: false,
  }, now, fakeHeadGit);
  assert.equal(result.examined, false, "never armed/green -- the other checks correctly skip it");
  assert.equal(result.neverScheduled?.number, 1810);
  assert.match(result.neverScheduled?.reason ?? "", /GitHub did not schedule anything for this commit/);
});

test("examinePr: a fresh head (seconds old, no runs yet) is not flagged by the never-scheduled check", () => {
  const now = Date.parse("2026-09-20T19:31:05Z"); // 5s after FRESH_HEAD's own commit
  const result = examinePr({
    number: 1900, headRefOid: FRESH_HEAD, autoMergeRequest: null,
    statusCheckRollup: [], isDraft: false,
  }, now, fakeHeadGit);
  assert.equal(result.neverScheduled, undefined);
});

test("#1814 REGRESSION: an old pull request whose head was just force-pushed -- a brand-new headRefOid, "
  + "zero check runs, and the head itself only seconds old -- must NOT be flagged, even though the pull "
  + "request as a whole may have been open for a long time. `examinePr` no longer reads `pr.createdAt` at "
  + "all -- there is no such field on `QueuedPr` any more -- specifically because GitHub zeroes "
  + "`statusCheckRollup` on a force-push/synchronize while `createdAt` never moves, so the old code's "
  + "`prAgeMs` (from `createdAt`) could already be past the 5-minute floor before GitHub had scheduled "
  + "anything for the fresh head. Only the head commit's own committer date may drive this verdict.", () => {
  const now = Date.parse("2026-09-20T20:06:05Z"); // 8s after FORCE_PUSHED_HEAD's own commit
  const result = examinePr({
    number: 1814, headRefOid: FORCE_PUSHED_HEAD, autoMergeRequest: null,
    statusCheckRollup: [], isDraft: false,
  }, now, fakeHeadGit);
  assert.equal(result.neverScheduled, undefined);
});

test("examinePr: an old head with at least one check run, whatever its conclusion, is not flagged", () => {
  const now = Date.parse("2026-09-20T19:10:00Z");
  const result = examinePr({
    number: 1901, headRefOid: OLD_HEAD, autoMergeRequest: null,
    statusCheckRollup: [{ name: "gate", conclusion: "FAILURE" }], isDraft: false,
  }, now, fakeHeadGit);
  assert.equal(result.neverScheduled, undefined);
});

test("examinePr: an old, empty-rollup draft is never flagged", () => {
  const now = Date.parse("2026-09-20T19:10:00Z");
  const result = examinePr({
    number: 1902, headRefOid: OLD_HEAD, autoMergeRequest: null,
    statusCheckRollup: [], isDraft: true,
  }, now, fakeHeadGit);
  assert.equal(result.neverScheduled, undefined);
});

// --- headCommittedAt: #1814, the head commit's own committer date, never `pr.createdAt` ---

test("headCommittedAt: reads the committer date from a real, injected git log", () => {
  assert.equal(headCommittedAt("deadbeef", () => ({ status: 0, stdout: "2026-09-20T20:05:57+01:00\n" })),
    "2026-09-20T20:05:57+01:00");
});

test("headCommittedAt: a failed git (sha not fetched locally, or any other git failure) is `null`, never "
  + "coerced into an age of zero silently inside this function -- that choice belongs to the caller", () => {
  assert.equal(headCommittedAt("deadbeef", () => ({ status: 1, stdout: "" })), null);
  assert.equal(headCommittedAt("deadbeef", () => ({ status: 128 })), null);
});

test("headCommittedAt: empty stdout on a successful exit is also `null`, not an empty-string date", () => {
  assert.equal(headCommittedAt("deadbeef", () => ({ status: 0, stdout: "" })), null);
});

// --- the CLI, guarded like every other argv-reading script here ---

test("queue-stalled.mjs refuses an unknown flag rather than silently ignoring it", () => {
  let threw = false;
  try {
    execFileSync("node", [SCRIPT, "--bogus"], { encoding: "utf8", stdio: "pipe" });
  } catch (cause) {
    threw = true;
    const err = cause as { status?: number, stderr?: string };
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /unknown flag --bogus/);
  }
  assert.ok(threw, "an unknown flag must exit non-zero, not silently run the default");
});

test("queue-stalled.mjs refuses to run without GITHUB_REPOSITORY -- CANNOT ASK, never a guessed default", () => {
  let threw = false;
  try {
    const env = { ...process.env };
    delete env.GITHUB_REPOSITORY;
    execFileSync("node", [SCRIPT], { encoding: "utf8", stdio: "pipe", env });
  } catch (cause) {
    threw = true;
    const err = cause as { status?: number, stderr?: string };
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /GITHUB_REPOSITORY is unset/);
  }
  assert.ok(threw, "with no repo to examine, the script must refuse rather than guess one");
});

// --- #1623: an armed PR held by a superseding gate that did not succeed ---

/**
 * #1617's two `gate` entries at head `84f684dd`, as `statusCheckRollup` returned them (GraphQL, read 2026-09-14 by
 * worker-tooling), in GitHub's order and with the fields `gh pr list --json statusCheckRollup` carries. The CANCELLED
 * run is the NEWER workflow run (34858134371) and "completed" at 14:49:32Z, before it started and before the older
 * run's gate (34858130620) succeeded at 14:51:42Z.
 */
const PR_1617_GATES = [
  { __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-09-14T14:49:33Z",
    completedAt: "2026-09-14T14:49:32Z", workflowName: "ci",
    detailsUrl: "https://github.com/a11ign/a11ign/actions/runs/34858134371/job/104022946741" },
  { __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-14T14:51:37Z",
    completedAt: "2026-09-14T14:51:42Z", workflowName: "ci",
    detailsUrl: "https://github.com/a11ign/a11ign/actions/runs/34858130620/job/104023707501" },
];
/**
 * #1605's pair at its merged head `8c1ebc44` (REST check-runs, read 2026-09-14), in the rollup's field shape: the
 * cancelled gate in the OLDER run 34855015256, the success in the LATER run 34855153052. Not blocked; merged.
 */
const PR_1605_GATES = [
  { __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-09-14T14:22:34Z",
    completedAt: "2026-09-14T14:22:33Z", workflowName: "ci",
    detailsUrl: "https://github.com/a11ign/a11ign/actions/runs/34855015256/job/104012833979" },
  { __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-14T14:26:18Z",
    completedAt: "2026-09-14T14:26:21Z", workflowName: "ci",
    detailsUrl: "https://github.com/a11ign/a11ign/actions/runs/34855153052/job/104014192412" },
];
/** The same entries with no run id -- what completion-time ordering alone sees. */
const withoutRunIds = (runs: { detailsUrl?: string }[]) => runs.map(({ detailsUrl, ...rest }) => {
  void detailsUrl; // dropped on purpose: what completion-time ordering alone sees
  return rest;
});

test("#1623 ACCEPTANCE: #1617's recorded shape is blocked by a superseding cancelled gate -- both runs and the re-run "
  + "named, in either order", () => {
  for (const runs of [PR_1617_GATES, [...PR_1617_GATES].reverse()]) {
    const verdict = supersedingGateVerdict({ armed: true, runs });
    assert.equal(verdict.code, "SUPERSEDED");
    assert.equal(verdict.reason, "blocked by a superseding cancelled gate: workflow run 34858134371's gate cancelled "
      + "after run 34858130620's gate succeeded at this head -- re-run workflow run 34858134371 to clear it");
  }
});

test("#1623 WIRING: the report's per-PR examination names #1617 by number and never examines it as green", () => {
  const result = examinePr({ number: 1617, headRefOid: "84f684dd57b246aab509855b309a7f3ddad9a97c",
    autoMergeRequest: { enabledAt: "2026-09-14T14:49:11Z" }, statusCheckRollup: PR_1617_GATES },
  Date.parse("2026-09-14T14:56:31Z"));
  assert.equal(result.examined, false);
  assert.equal(result.superseded?.number, 1617);
  assert.match(result.superseded?.reason ?? "", /^blocked by a superseding cancelled gate/);
});

test("#1623 CONTROL: #1605's shape -- the cancelled gate in the OLDER run, the success in a later one -- is not reported", () => {
  assert.equal(supersedingGateVerdict({ armed: true, runs: PR_1605_GATES }).code, "GREEN");
  assert.equal(supersedingGateVerdict({ armed: true, runs: [...PR_1605_GATES].reverse() }).code, "GREEN");
});

test("#1623 CONTROL: a lone cancelled gate, with no success on the head, is an ordinary red and not this shape", () => {
  const verdict = supersedingGateVerdict({ armed: true, runs: [PR_1617_GATES[0]] });
  assert.equal(verdict.code, "RED");
  assert.match(verdict.reason, /ordinary red, not a superseded one/);
});

test("#1623: a newest gate still RUNNING after an older success is not reported -- it may yet succeed", () => {
  const running = { ...PR_1617_GATES[0], status: "IN_PROGRESS", conclusion: "", completedAt: "0001-01-01T00:00:00Z" };
  assert.equal(supersedingGateVerdict({ armed: true, runs: [running, PR_1617_GATES[1]] }).code, "RUNNING");
});

test("#1623: an unarmed PR, and a head with no gate run, are never this check's concern", () => {
  assert.equal(supersedingGateVerdict({ armed: false, runs: PR_1617_GATES }).code, "NOT_ARMED");
  assert.equal(supersedingGateVerdict({ armed: true, runs: [] }).code, "NO_GATE");
});

test("#1623: without run ids -- completion time alone -- #1617 reads SUCCESS and is not reported, which is how it "
  + "stayed invisible", () => {
  const byTime = withoutRunIds(PR_1617_GATES);
  assert.equal(newestConclusion(byTime, "gate"), "success");
  assert.equal(supersedingGateVerdict({ armed: true, runs: byTime }).code, "GREEN");
});

test("#1623: the summary line is stated when nothing is found, and names every blocked PR when something is", () => {
  assert.match(supersededLine([]), /^QUEUE: nothing blocked by a superseding gate/);
  assert.equal(supersededLine([1617, 1618]), "QUEUE: 2 blocked by a superseding gate: 1617 1618");
});

/**
 * #1631's review: pairs that do NOT carry two distinct workflow run ids. In each, the CANCELLED gate is the newer one BY TIME
 * (it completes at 14:52:00Z, after the success at 14:51:42Z), which is the only order `newestRun` can fall back to.
 */
const LATER_CANCELLED = { ...PR_1617_GATES[0], completedAt: "2026-09-14T14:52:00Z" };
const UNORDERED_PAIRS: Record<string, object[]> = {
  "both id-free": withoutRunIds([LATER_CANCELLED, PR_1617_GATES[1]]),
  "the newest without a run id, the success with one": [...withoutRunIds([LATER_CANCELLED]), PR_1617_GATES[1]],
  "the newest with a run id, the success without one": [LATER_CANCELLED, ...withoutRunIds([PR_1617_GATES[1]])],
  "one workflow run holding both (a re-run job)": [{ ...LATER_CANCELLED, detailsUrl: PR_1617_GATES[1].detailsUrl }, PR_1617_GATES[1]],
};

test("#1623, #1631's review: WITHOUT two distinct run ids a later-cancelled pair is UNORDERED -- never superseded, and "
  + "never a re-run naming no run", () => {
  for (const [label, runs] of Object.entries(UNORDERED_PAIRS)) {
    const verdict = supersedingGateVerdict({ armed: true, runs });
    assert.equal(verdict.code, "UNORDERED", label);
    assert.doesNotMatch(verdict.reason, /re-run|no run id|workflow run \d/, label);
    assert.match(verdict.reason, /do not carry distinct workflow run ids/, label);
  }
});

test("#1623, #1631's review: the report's per-PR examination does not name an unordered pair", () => {
  for (const [label, runs] of Object.entries(UNORDERED_PAIRS)) {
    const result = examinePr({ number: 1631, headRefOid: "43cf24ed238afc244b0def8cba0af0464a354da6",
      autoMergeRequest: { enabledAt: "2026-09-14T15:00:00Z" }, statusCheckRollup: runs }, Date.parse("2026-09-14T15:30:00Z"));
    assert.equal(result.superseded, undefined, label);
    assert.equal(result.examined, false, label);
  }
});

// ---------------------------------------------------------------------------------------------------
// #3019: A PR THE QUEUE EJECTED FOR A RED QUEUE RUN IS NOT "UNARMED".
//
// The fixture is `a11ign/agent-org#16`'s real timeline, read 2026-10-02 from `timelineItems(last:10, ...)`: five commits, then
// ADDED 13:01:28Z, REMOVED failed_checks 13:03:59Z, ADDED 13:09:38Z, REMOVED failed_checks 13:15:05Z, `mergeQueueEntry` null.
// ---------------------------------------------------------------------------------------------------

const commit = (committedDate: string) => ({ __typename: "PullRequestCommit", commit: { committedDate } });
const added = (createdAt: string) => ({ __typename: "AddedToMergeQueueEvent", createdAt });
const removed = (createdAt: string, reason: string) => ({ __typename: "RemovedFromMergeQueueEvent", createdAt, reason });

const COMMITS_OF_16 = ["10:54:07", "10:58:42", "11:14:57", "11:34:17", "11:39:15"].map((t) => commit(`2026-10-02T${t}Z`));
const QUEUE_EVENTS_OF_16 = [
  added("2026-10-02T13:01:28Z"), removed("2026-10-02T13:03:59Z", "failed_checks"),
  added("2026-10-02T13:09:38Z"), removed("2026-10-02T13:15:05Z", "failed_checks"),
];
/** `#16` as the API returned it, and the same pull request with its queue events deleted (the control). */
const EJECTED_16 = { mergeQueueEntry: null, timelineItems: { nodes: [...COMMITS_OF_16, ...QUEUE_EVENTS_OF_16] } };
const NEVER_QUEUED_16 = { mergeQueueEntry: null, timelineItems: { nodes: [...COMMITS_OF_16] } };

test("#3019 done-when 1: a PR whose newest queue event is a failed_checks removal, head unmoved, is EJECTED", () => {
  assert.deepEqual(queueEjectionOf(EJECTED_16), { ejected: true, removedAt: "2026-10-02T13:15:05Z" },
    "the NEWEST removal, not the first of the two");
  assert.equal(armedFromApi(EJECTED_16), false, "and `armed` still reads false -- which is exactly why it was called unarmed");
});

test("#3019 done-when 3, THE CONTROL: the same fixture with the events deleted is NOT ejected, so the branch is reachable and not vacuous", () => {
  assert.deepEqual(queueEjectionOf(NEVER_QUEUED_16), { ejected: false, removedAt: null });
  // End to end through the reader: the pair splits, one each way.
  const answers: Record<string, unknown> = { "16": EJECTED_16, "17": NEVER_QUEUED_16 };
  const run = fakeGh(answers);
  const split = readEjections([16, 17], run);
  assert.deepEqual(split?.unarmed, [17], "the never-queued PR stays unarmed, and goes where it always went");
  assert.deepEqual([...(split?.ejections.keys() ?? [])], [16], "and the ejected one leaves the unarmed set");
});

test("#3019 done-when 2: no events, another removal reason, or a removal followed by a push are classified exactly as today", () => {
  const manual = { mergeQueueEntry: null, timelineItems: { nodes: [...COMMITS_OF_16, added("2026-10-02T13:01:28Z"), removed("2026-10-02T13:03:59Z", "dequeued")] } };
  const pushedSince = { mergeQueueEntry: null, timelineItems: { nodes: [...COMMITS_OF_16, ...QUEUE_EVENTS_OF_16, commit("2026-10-02T13:30:00Z")] } };
  const forcePushedSince = { mergeQueueEntry: null, timelineItems: { nodes: [...COMMITS_OF_16, ...QUEUE_EVENTS_OF_16, { __typename: "HeadRefForcePushedEvent" }] } };
  const reQueued = { mergeQueueEntry: { state: "AWAITING_CHECKS" }, timelineItems: { nodes: [...COMMITS_OF_16, ...QUEUE_EVENTS_OF_16, added("2026-10-02T13:40:00Z")] } };
  const stillInTheQueue = { ...EJECTED_16, mergeQueueEntry: { state: "AWAITING_CHECKS" } };
  for (const [what, pr] of Object.entries({ manual, pushedSince, forcePushedSince, reQueued, stillInTheQueue })) {
    assert.equal(queueEjectionOf(pr)?.ejected, false, `${what} is not an ejection to answer`);
  }
  assert.equal(queueEjectionOf({ mergeQueueEntry: null, timelineItems: { nodes: [] } })?.ejected, false, "no queue history at all");
});

test("#3019 done-when 4: a refused read yields no order -- null, never an all-clear and never an accusation", () => {
  assert.equal(queueEjectionOf(null), null);
  assert.equal(queueEjectionOf({ mergeQueueEntry: null }), null, "an answer carrying no timeline is unreadable, not empty");
  assert.equal(readEjections(null), null, "the candidates themselves were refused: the existing `null` rule");
  const refused = () => { throw new Error("HTTP 403: rate limit exceeded"); };
  const split = readEjections([16], refused);
  assert.deepEqual(split?.unarmed, [], "a candidate whose own read was refused is not called unarmed either");
  assert.equal(split?.ejections.size, 0, "and not called ejected");
  assert.deepEqual(decide({ prs: [], readyRows: [], unarmed: null }).filter((o: { cause: string }) => o.cause === "pr-green-unarmed"), []);
  assert.deepEqual(greenUnarmedOrders(split?.unarmed ?? null), [], "an empty remainder sends no order");
});

const GREEN_16 = { number: 16, isDraft: false, headRefOid: "b7143468da00ec074d40d3c512c69c48b8606dea", mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED", statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }],
  labels: [{ name: "session:worker-16" }] };

test("#3019 done-when 1, the ORDER: it goes to the PR's owner, names the failed run and its subtests, and is NOT pr-green-unarmed", () => {
  const split = readEjections([16], fakeGh({ "16": EJECTED_16 }));
  const ejection = split?.ejections.get(16);
  assert.deepEqual(ejection, { removedAt: "2026-10-02T13:15:05Z", runId: 37011501222,
    failingTests: ["#2174: work-gate.mjs loads in a tree with NO node_modules", "the count of non-test files carrying the literal"] },
  "the run is the newest failed merge_group run no later than the removal (13:12:50Z, not the 13:09:54Z one)");
  const pr = { ...GREEN_16, armed: false, ejection };
  assert.equal(stallReasonOf(pr, ["gate"]), STALL_REASON.EJECTED);
  assert.equal(stallReasonOf({ ...pr, ejection: undefined }, ["gate"]), STALL_REASON.UNARMED, "THE CONTROL: without the stamp it is `unarmed` as before");
  const orders = decide({ prs: [pr], readyRows: [], required: ["gate"], unarmed: split?.unarmed }) as { session: string, cause: string, prompt: string }[];
  const [order, ...rest] = orders.filter((o) => o.cause === "pr-checks-failing" || o.cause === "pr-green-unarmed");
  assert.ok(orders.length > 0, "THE CONTROL on the population: the PR was ordered at all, so `rest` below is not empty for want of an order");
  assert.deepEqual(rest, [], "one order, and none of it is pr-green-unarmed");
  assert.equal(order?.cause, "pr-checks-failing");
  assert.equal(order?.session, "worker-16", "the PR's owner (`ownerOfPr`), never product-manager");
  assert.match(order?.prompt ?? "", /run 37011501222/);
  assert.match(order?.prompt ?? "", /#2174: work-gate\.mjs loads in a tree with NO node_modules/);
  assert.match(order?.prompt ?? "", /RE-ARMING IT WITHOUT A PUSH WILL FAIL THE SAME WAY/);
});

test("#3019 the order says so when the run or the subtests could not be read, and never invents them", () => {
  const unreadable = fakeGh({ "16": EJECTED_16 }, { runs: "throw" });
  const ejection = readEjections([16], unreadable)?.ejections.get(16);
  assert.deepEqual(ejection, { removedAt: "2026-10-02T13:15:05Z", runId: null, failingTests: null });
  const orders = decide({ prs: [{ ...GREEN_16, armed: false, ejection }], readyRows: [], required: ["gate"] }) as { cause: string, prompt: string }[];
  const order = orders.find((o) => o.cause === "pr-checks-failing");
  assert.match(order?.prompt ?? "", /run id could NOT be read/);
  assert.match(order?.prompt ?? "", /failing subtests could NOT be read/);
});

test("#3019 the query names the three things the reading depends on", () => {
  const query = ejectionQueryArgs({ number: 16, repo: "a11ign/agent-org" }).join(" ");
  for (const needle of ["REMOVED_FROM_MERGE_QUEUE_EVENT", "PULL_REQUEST_COMMIT", "HEAD_REF_FORCE_PUSHED_EVENT", "reason"]) {
    assert.ok(query.includes(needle), `without ${needle} the reading cannot tell an ejection from a push or a manual dequeue`);
  }
});

/** A fake `gh` for the three reads an ejection costs: the timeline, the merge_group runs, and the failed run's log. */
function fakeGh(timelines: Record<string, unknown>, { runs = "ok" }: { runs?: "ok" | "throw" } = {}) {
  return (args: string[]) => {
    if (args[0] === "api" && args[1] === "graphql") {
      const n = args[args.indexOf("-F") + 1].replace("n=", "");
      return JSON.stringify(timelines[n]);
    }
    if (args[0] === "api" && args[1].includes("actions/runs")) {
      if (runs === "throw") throw new Error("HTTP 403");
      return JSON.stringify([
        { id: 37011501222, head_branch: "gh-readonly-queue/main/pr-16-474b45f", conclusion: "failure", created_at: "2026-10-02T13:12:50Z" },
        { id: 37011180948, head_branch: "gh-readonly-queue/main/pr-16-ccea9e5", conclusion: "failure", created_at: "2026-10-02T13:09:54Z" },
        { id: 37010289767, head_branch: "gh-readonly-queue/main/pr-16-474b45f", conclusion: "failure", created_at: "2026-10-02T13:16:00Z" },
        { id: 99, head_branch: "gh-readonly-queue/main/pr-17-aaa", conclusion: "failure", created_at: "2026-10-02T13:14:00Z" },
      ]);
    }
    if (args[0] === "run" && args[1] === "view") {
      return ["gate\tTest\t2026-10-02T13:14:00Z # Subtest: x",
        "gate\tTest\t2026-10-02T13:14:01Z not ok 301 - #2174: work-gate.mjs loads in a tree with NO node_modules",
        "gate\tTest\t2026-10-02T13:14:02Z not ok 302 - the count of non-test files carrying the literal",
        "gate\tTest\t2026-10-02T13:14:03Z # fail 2"].join("\n");
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
}
