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
import { updateBranchDecision, isBehind } from "../../../../scripts/update-branch-sweep.mjs";
import { sandboxGitEnv } from "../../../../scripts/git-env.mjs";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../scripts/update-branch-sweep.mjs");

// --- updateBranchDecision: the pure decision ---

test("updateBranchDecision: not armed at all is never this job's concern", () => {
  const d = updateBranchDecision({ armed: false, gateConclusion: "SUCCESS", behind: true });
  assert.equal(d.update, false);
});

test("updateBranchDecision: armed, gate still running (no conclusion), behind -- update, don't wait", () => {
  const d = updateBranchDecision({ armed: true, gateConclusion: null, behind: true });
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
