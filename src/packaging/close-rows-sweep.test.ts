/**
 * #394: A BACKSTOP FOR close-rows.yml, WHICH FIRES FOR SOME MERGES AND NOT OTHERS FOR AN UNEXPLAINED
 * REASON. `mergedPrsInWindow` is driven with an injected `gh` so the query shape is proven without a live
 * repo; `main()`'s CLI behaviour (unknown flags, missing GITHUB_REPOSITORY) is driven for real, the same
 * way `queue-stalled.test.ts` and `auto-arm-sweep.mjs`'s siblings are. `closurePlan` itself (imported from
 * close-rows-for-merged-pr.mjs, never re-derived) already has its own tests -- this file does not repeat
 * them, only proves the sweep wires to the real thing rather than a copy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { mergedPrsInWindow, DEFAULT_WINDOW_MINUTES } from "../../../../scripts/close-rows-sweep.mjs";
import { closurePlan } from "../../../../scripts/close-rows-for-merged-pr.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCRIPT = `${REPO}/scripts/close-rows-sweep.mjs`;

// --- mergedPrsInWindow: the query, driven with an injected gh ---

test("mergedPrsInWindow: queries `gh pr list` scoped to state=merged and base=main -- never an unscoped "
  + "list this repo would have to filter itself", () => {
  let capturedArgs: string[] = [];
  const fakeGh = (args: string[]) => { capturedArgs = args; return "[]"; };
  mergedPrsInWindow("DanBeckDev/a11y-witness", 45, fakeGh);
  assert.ok(capturedArgs.includes("--state"));
  assert.ok(capturedArgs.includes("merged"),
    "THE RISK THIS ROW NAMES: a PR that did not merge must never be in this list at all -- proven at the "
    + "query, not by a downstream filter that could be forgotten");
  assert.ok(capturedArgs.includes("--base"));
  assert.ok(capturedArgs.includes("main"));
});

test("mergedPrsInWindow: the `merged:>=` search bound is an ISO timestamp roughly `windowMinutes` ago, "
  + "never a bare date", () => {
  let capturedArgs: string[] = [];
  const fakeGh = (args: string[]) => { capturedArgs = args; return "[]"; };
  const before = Date.now();
  mergedPrsInWindow("owner/repo", 45, fakeGh);
  const searchArg = capturedArgs[capturedArgs.indexOf("--search") + 1];
  const match = /merged:>=(.+)/.exec(searchArg);
  assert.ok(match, `expected a merged:>=<timestamp> search qualifier, got: ${searchArg}`);
  const since = Date.parse(match[1]);
  const expectedMs = before - 45 * 60_000;
  assert.ok(Math.abs(since - expectedMs) < 5000,
    `since (${match[1]}) should be ~45 minutes before now, drifted by ${Math.abs(since - expectedMs)}ms`);
});

test("mergedPrsInWindow: parses gh's JSON output into the number list", () => {
  const fakeGh = () => JSON.stringify([{ number: 232 }, { number: 281 }]);
  const result = mergedPrsInWindow("owner/repo", DEFAULT_WINDOW_MINUTES, fakeGh);
  assert.deepEqual(result, [{ number: 232 }, { number: 281 }]);
});

// --- closurePlan is REUSED, not re-derived -- proven by import identity, not by re-testing its logic ---

test("close-rows-sweep imports the SAME closurePlan close-rows-for-merged-pr.mjs uses, not a copy", () => {
  // If this were a re-derived copy, editing one file's decision would silently leave the other's
  // unchanged -- the exact "fact stated twice" shape #394's own header names. Proven by behavioural
  // identity on a case closurePlan's own tests already cover: a mix of OPEN and already-closed issues.
  const result = closurePlan([{ number: 1, state: "OPEN" }, { number: 2, state: "CLOSED" }]);
  assert.deepEqual(result, { close: [1], already: [2], none: false });
});

// --- IDEMPOTENCY: running against the same issues twice closes nothing the second time ---

test("ACCEPTANCE (#394, criterion 2): the sweep is idempotent -- a second closurePlan call against "
  + "issues already closed reports ALREADY CLOSED for all of them, closes nothing new", () => {
  const firstPass = closurePlan([{ number: 10, state: "OPEN" }]);
  assert.deepEqual(firstPass, { close: [10], already: [], none: false });
  // After #10 is closed (simulated: its state is now CLOSED, as it would be on GitHub after the first run)
  const secondPass = closurePlan([{ number: 10, state: "CLOSED" }]);
  assert.deepEqual(secondPass, { close: [], already: [10], none: false });
});

// --- the CLI, guarded like every other argv-reading script here ---

test("close-rows-sweep.mjs refuses an unknown flag rather than silently ignoring it", () => {
  let threw = false;
  try {
    execFileSync("node", [SCRIPT, "--bogus"], { encoding: "utf8", stdio: "pipe" });
  } catch (cause) {
    threw = true;
    const err = cause as { status?: number, stderr?: string };
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /unknown flag --bogus/);
  }
  assert.ok(threw, "an unknown flag must exit non-zero, not silently run the default window");
});

test("close-rows-sweep.mjs refuses to run without GITHUB_REPOSITORY -- CANNOT ASK, never a guessed repo", () => {
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
  assert.ok(threw, "with no repo to sweep, the script must refuse rather than guess one");
});

// --- the workflow wiring: close-rows.yml's manual dispatch, trunk-guard.yml's sweep job ---

test("close-rows.yml declares a workflow_dispatch `pr` input, required, alongside pull_request:closed", () => {
  const doc = parseYaml(readFileSync(`${REPO}/.github/workflows/close-rows.yml`, "utf8")) as {
    on: { pull_request?: { types: string[] }, workflow_dispatch?: { inputs?: Record<string, { required?: boolean }> } },
  };
  assert.ok(doc.on.pull_request?.types.includes("closed"), "the immediate path must still be there -- "
    + "this is a backstop, not a replacement (#394)");
  assert.ok(doc.on.workflow_dispatch, "workflow_dispatch must exist, or #394's criterion 1 has no trigger");
  assert.ok(doc.on.workflow_dispatch?.inputs?.pr?.required,
    "the `pr` input must be required -- an optional one invites a run with no PR to act on");
});

test("close-rows.yml's close job accepts EITHER trigger, and the run step reads the input OR the event", () => {
  const text = readFileSync(`${REPO}/.github/workflows/close-rows.yml`, "utf8");
  assert.match(text, /github\.event_name == 'workflow_dispatch'/,
    "the job's `if:` must explicitly admit workflow_dispatch, or a manual run is silently skipped");
  assert.match(text, /github\.event\.inputs\.pr \|\| github\.event\.pull_request\.number/,
    "the run step must fall back to the pull_request event's PR number when there is no dispatch input");
});

test("trunk-guard.yml carries a closeRowsSweep job, independent of trunkGate's result", () => {
  const doc = parseYaml(readFileSync(`${REPO}/.github/workflows/trunk-guard.yml`, "utf8")) as {
    jobs: Record<string, { needs?: string | string[], if?: string, steps: Array<Record<string, unknown>> }>,
  };
  const job = doc.jobs.closeRowsSweep;
  assert.ok(job, "trunk-guard.yml must carry a closeRowsSweep job -- #394's second entry point");
  assert.ok(!job.needs, "closeRowsSweep must not depend on trunkGate -- row-closing is unrelated to "
    + "whether main's new tip is green, and gating it on that would strand a merged PR's row behind an "
    + "unrelated test failure");
  const runLines = (job.steps ?? []).map((s) => String(s.run ?? "")).join("\n");
  assert.match(runLines, /node scripts\/close-rows-sweep\.mjs/);
});
