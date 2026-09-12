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
  armedBehindVerdict, behindByCount, formatBehindWatchdogLine, DEFAULT_BEHIND_STALL_THRESHOLD_SECONDS,
} from "../../../../scripts/queue-stalled.mjs";
import { newestConclusion, headQuietSeconds } from "../../../../scripts/update-branch-sweep.mjs";

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

import { sandboxGitEnv } from "../../../../scripts/git-env.mjs";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../scripts/queue-stalled.mjs");

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
    "scripts/board-data.mjs",
    "scripts/board-document.mjs",
    "scripts/board-only-check.mjs",
    "scripts/board-report.mjs",
    "scripts/ci-changed.mjs",
    "scripts/isolation-gate.mjs",
    "",
    "Auto-merging scripts/board-data.mjs",
    "CONFLICT (content): Merge conflict in scripts/board-data.mjs",
    "Auto-merging scripts/board-document.mjs",
    "CONFLICT (content): Merge conflict in scripts/board-document.mjs",
    "",
  ].join("\n");
  const result = mergeTreeConflict("origin/main", "deadbeef", () => ({ status: 1, stdout }));
  assert.equal(result.conflict, true);
  assert.deepEqual(result.files, [
    "scripts/board-data.mjs", "scripts/board-document.mjs", "scripts/board-only-check.mjs",
    "scripts/board-report.mjs", "scripts/ci-changed.mjs", "scripts/isolation-gate.mjs",
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
