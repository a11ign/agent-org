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
import { stalledVerdict, mergeTreeConflict, DEFAULT_STALL_THRESHOLD_MS } from "../../../../scripts/queue-stalled.mjs";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../scripts/queue-stalled.mjs");

// --- stalledVerdict: the pure decision ---

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
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const result = mergeTreeConflict(head, head, (args) => {
    try {
      const stdout = execFileSync("git", args, { encoding: "utf8" });
      return { status: 0, stdout };
    } catch (cause) {
      const err = cause as { status?: number, stdout?: string };
      return { status: err.status ?? 1, stdout: err.stdout ?? "" };
    }
  });
  assert.equal(result.conflict, false);
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
