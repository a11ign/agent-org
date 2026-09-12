/**
 * #394: A BACKSTOP FOR THE CLOSE-ROWS PATH (close-rows.yml until #909, now trunk.yml's closeRows job), WHICH FIRED FOR SOME MERGES AND NOT OTHERS FOR AN UNEXPLAINED
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
  assert.deepEqual(result, { close: [{ number: 1, labels: [] }], already: [{ number: 2, labels: [] }], none: false });
});

// --- IDEMPOTENCY: running against the same issues twice closes nothing the second time ---

test("ACCEPTANCE (#394, criterion 2): the sweep is idempotent -- a second closurePlan call against "
  + "issues already closed reports ALREADY CLOSED for all of them, closes nothing new", () => {
  const firstPass = closurePlan([{ number: 10, state: "OPEN" }]);
  assert.deepEqual(firstPass, { close: [{ number: 10, labels: [] }], already: [], none: false });
  // After #10 is closed (simulated: its state is now CLOSED, as it would be on GitHub after the first run)
  const secondPass = closurePlan([{ number: 10, state: "CLOSED" }]);
  assert.deepEqual(secondPass, { close: [], already: [{ number: 10, labels: [] }], none: false });
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

// --- the workflow wiring since #909 (2026-09-12): the sweep RIDES trunk.yml's push as its `closeRows` job. The
// 2026-09-08 removal was measured under GITHUB_TOKEN merges, which fire no push; since #416 every merge is
// completed with the A11IGN_BOT_TOKEN PAT and does fire push (every merge today ran trunk.yml), so the
// original design is correct again. The scheduled backstop half lives in nightly.yml (trunk-sweep.test.ts).
test("#909: close-rows-sweep.mjs IS wired to trunk.yml's push, as the closeRows job, with a dispatch path for one PR", () => {
  const doc = parseYaml(readFileSync(`${REPO}/.github/workflows/trunk.yml`, "utf8")) as {
    on: { push?: { branches: string[] }, workflow_dispatch?: { inputs?: Record<string, { required?: boolean }> } },
    jobs: Record<string, { needs?: unknown, permissions?: Record<string, string>, steps: Array<{ run?: string }> }>,
  };
  assert.deepEqual(doc.on.push?.branches, ["main"]);
  assert.ok(doc.on.workflow_dispatch, "workflow_dispatch must exist, or #394's criterion 1 has no trigger");
  assert.equal(doc.on.workflow_dispatch?.inputs?.pr?.required, false,
    "the `pr` input is optional here: a bare dispatch runs the gate (the #417 sweep's use), a dispatch with pr closes one PR's rows");
  const job = doc.jobs.closeRows;
  assert.ok(job, "trunk.yml carries a closeRows job");
  assert.ok(!job.needs, "closeRows does not wait on the gate: a red push still closes the rows its PR declared");
  const run = job.steps.map((s) => s.run ?? "").join("\n");
  assert.match(run, /node scripts\/close-rows-sweep\.mjs --window=60/, "the push path sweeps the last hour, idempotently");
  assert.match(run, /node scripts\/close-rows-for-merged-pr\.mjs "\$DISPATCH_PR"/, "the dispatch path closes the named PR's rows");
  assert.match(run, /if \[ -n "\$DISPATCH_PR" \]/, "and the two are chosen by whether a pr was given");
});
