/**
 * C2 (#416's sibling): after a merge lands on `main`, push every armed, green-or-running PR up to its
 * current tip -- the fix half of `queue-stalled.mjs`'s report-only diagnosis. `updateBranchDecision` is the
 * whole decision, as one pure function, and `isBehind` drives the real `git merge-base --is-ancestor`
 * invocation with an injectable runner so it is tested against a real exit status rather than a guessed
 * shape. See update-branch-sweep.mjs's own header for why there is deliberately no `GITHUB_TOKEN` fallback.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { updateBranchDecision, isBehind, newestConclusion } from "../../../../scripts/update-branch-sweep.mjs";
import { sandboxGitEnv } from "../../../../scripts/git-env.mjs";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../scripts/update-branch-sweep.mjs");

// --- newestConclusion: #498, a superseded check run stays attached to the head for ever ---
//
// The rollup entries below are the REAL ones from PR #485's head `b9b9a0ee`, copied verbatim from
// `gh pr list --json statusCheckRollup` on 2026-09-08 -- a `gate` that FAILED inside a cancelled `ci.yml`
// run at 07:32, and the `gate` that SUCCEEDED in the live run three minutes later. Both are permanently
// attached to that head. The sweep read the first and skipped a green PR that was 16 commits behind.

/** PR #485's real `gate` rollup entries, oldest first -- the order GitHub actually returned. */
const CANCELLED_THEN_SUCCESS = [
  { name: "ts", conclusion: "CANCELLED", completedAt: "2026-09-08T07:32:30Z", startedAt: "2026-09-08T07:32:00Z" },
  { name: "gate", conclusion: "FAILURE", completedAt: "2026-09-08T07:32:37Z", startedAt: "2026-09-08T07:32:35Z" },
  { name: "gate", conclusion: "SUCCESS", completedAt: "2026-09-08T07:35:37Z", startedAt: "2026-09-08T07:35:34Z" },
];

test("newestConclusion: MUTATION TARGET -- a superseded FAILURE never outranks the newer SUCCESS (#498)", () => {
  assert.equal(newestConclusion(CANCELLED_THEN_SUCCESS, "gate"), "SUCCESS");
});

test("newestConclusion: MUTATION TARGET -- the whole decision, on #485's real head, is UPDATE not SKIP", () => {
  const gateConclusion = newestConclusion(CANCELLED_THEN_SUCCESS, "gate");
  const d = updateBranchDecision({ armed: true, gateConclusion, behind: true });
  assert.equal(d.update, true,
    `#485 was green and 16 commits behind; the sweep skipped it. Decision said: ${d.reason}`);
});

test("newestConclusion: ARRAY ORDER IS NOT TRUSTED -- newest-first input gives the same answer", () => {
  const reversed = [...CANCELLED_THEN_SUCCESS].reverse();
  assert.equal(newestConclusion(reversed, "gate"), "SUCCESS");
});

test("newestConclusion: a genuinely failing head is STILL read as failing -- the skip must survive", () => {
  const runs = [
    { name: "gate", conclusion: "SUCCESS", completedAt: "2026-09-08T07:00:00Z", startedAt: "2026-09-08T06:59:00Z" },
    { name: "gate", conclusion: "FAILURE", completedAt: "2026-09-08T08:00:00Z", startedAt: "2026-09-08T07:59:00Z" },
  ];
  assert.equal(newestConclusion(runs, "gate"), "FAILURE");
  assert.equal(updateBranchDecision({ armed: true, gateConclusion: "FAILURE", behind: true }).update, false);
});

test("newestConclusion: a still-running newest run reports null, which is 'not yet answered', not 'failing'", () => {
  const runs = [
    { name: "gate", conclusion: "FAILURE", completedAt: "2026-09-08T07:32:37Z", startedAt: "2026-09-08T07:32:35Z" },
    { name: "gate", conclusion: null, completedAt: null, startedAt: "2026-09-08T07:40:00Z" },
  ];
  assert.equal(newestConclusion(runs, "gate"), null);
  // `quietSeconds` since #488: a running gate updates only when the head has been still. Passing a quiet
  // head keeps this test's own subject -- that a running run is "not yet answered" rather than "failing".
  assert.equal(updateBranchDecision(
    { armed: true, gateConclusion: null, behind: true, quietSeconds: 600 }).update, true);
});

test("newestConclusion: no run of that name, an empty rollup and a null rollup are all null, never a throw", () => {
  assert.equal(newestConclusion(CANCELLED_THEN_SUCCESS, "mergeSafety"), null);
  assert.equal(newestConclusion([], "gate"), null);
  assert.equal(newestConclusion(null, "gate"), null);
  assert.equal(newestConclusion(undefined, "gate"), null);
});

test("newestConclusion: an UNTIMED entry never outranks a timed one -- absence is not newness", () => {
  const runs = [
    { name: "gate", conclusion: "SUCCESS", completedAt: "2026-09-08T07:35:37Z", startedAt: "2026-09-08T07:35:34Z" },
    { name: "gate", conclusion: "FAILURE", completedAt: null, startedAt: null },
  ];
  assert.equal(newestConclusion(runs, "gate"), "SUCCESS");
});

test("newestConclusion: startedAt is the fallback key when completedAt is absent on both", () => {
  const runs = [
    { name: "gate", conclusion: "FAILURE", completedAt: null, startedAt: "2026-09-08T07:00:00Z" },
    { name: "gate", conclusion: "SUCCESS", completedAt: null, startedAt: "2026-09-08T08:00:00Z" },
  ];
  assert.equal(newestConclusion(runs, "gate"), "SUCCESS");
});

test("the skip message NAMES THE READING, so a wrong skip is falsifiable from the log alone (#498)", () => {
  const d = updateBranchDecision({ armed: true, gateConclusion: "FAILURE", behind: true });
  assert.equal(d.update, false);
  assert.match(d.reason, /NEWEST gate run on the head/,
    "the reason must say the conclusion was the newest, not merely that the gate failed");
  assert.match(d.reason, /#498/, "the reason must name the shape to report if the PR looks green");
});

// --- updateBranchDecision: the pure decision ---

test("updateBranchDecision: not armed at all is never this job's concern", () => {
  const d = updateBranchDecision({ armed: false, gateConclusion: "SUCCESS", behind: true });
  assert.equal(d.update, false);
});

test("updateBranchDecision: armed, gate still running, behind, AND THE HEAD IS QUIET -- update", () => {
  // #488 narrowed this: "still running" alone is no longer enough, because an author who has just pushed
  // HAS a running gate, and syncing under them rejects their next push. The head must also have been
  // still for `HEAD_QUIET_SECONDS`. The case this test was written for -- a SLOW CI on a settled head --
  // is unchanged and is what `quietSeconds: 600` expresses.
  const d = updateBranchDecision({ armed: true, gateConclusion: null, behind: true, quietSeconds: 600 });
  assert.equal(d.update, true);
});

test("updateBranchDecision: armed, gate FAILURE, behind -- a failing PR needs a fix, not a stale-main push", () => {
  const d = updateBranchDecision({ armed: true, gateConclusion: "FAILURE", behind: true });
  assert.equal(d.update, false);
});

test("updateBranchDecision: armed, green, already up to date -- nothing to do", () => {
  const d = updateBranchDecision({ armed: true, gateConclusion: "SUCCESS", behind: false });
  assert.equal(d.update, false);
});

test("updateBranchDecision: MUTATION TARGET -- armed, gate green, behind IS updated", () => {
  const d = updateBranchDecision({ armed: true, gateConclusion: "SUCCESS", behind: true });
  assert.equal(d.update, true);
});

// --- isBehind: real `git merge-base --is-ancestor`, captured status, never a guessed shape ---

test("isBehind: exit 0 (base IS an ancestor of head) means NOT behind", () => {
  assert.equal(isBehind("origin/main", "deadbeef", () => ({ status: 0 })), false);
});

test("isBehind: MUTATION TARGET -- non-zero exit (base is NOT an ancestor) means behind", () => {
  assert.equal(isBehind("origin/main", "deadbeef", () => ({ status: 1 })), true);
});

test("isBehind: runs the REAL git binary against real objects in this repo -- own head vs. own head is "
  + "trivially an ancestor of itself, so it is never reported as behind", () => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", env: sandboxGitEnv() }).trim();
  const result = isBehind(head, head, (args) => {
    try {
      execFileSync("git", args, { encoding: "utf8", env: sandboxGitEnv() });
      return { status: 0 };
    } catch (cause) {
      const err = cause as { status?: number };
      return { status: err.status ?? 1 };
    }
  });
  assert.equal(result, false);
});

// --- the CLI, guarded like every other argv-reading script here ---

test("update-branch-sweep.mjs refuses an unknown flag rather than silently ignoring it", () => {
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

test("update-branch-sweep.mjs refuses to run without GITHUB_REPOSITORY -- CANNOT ASK, never a guessed default", () => {
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
