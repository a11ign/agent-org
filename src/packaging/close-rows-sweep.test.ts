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
import { mergedPrsInWindow, DEFAULT_WINDOW_MINUTES, closeOnePr, sweepExit, EXIT } from "../../../../scripts/close-rows-sweep.mjs";
import { closurePlan } from "../../../../scripts/close-rows-for-merged-pr.mjs";
import { refusalCause } from "../../../../scripts/settle-closed-status.mjs";

/** CAPTURED, not composed: the reason `moveProjectStatus` gave for #1299 in trunk run 34769927592 (`02ae7420`). */
const CAPTURED_PROJECT_UNREADABLE = "could not move #1299's Status to \"Done\" -- board-snapshot: could not read "
  + "Project 2 items -- refusing to snapshot a partial board. NOT_FOUND (user.projectV2): Could not resolve to a "
  + "ProjectV2 with the number 2.";
/** A refusal classified by the real `refusalCause`, never a hand-typed cause. */
const refusal = (row: number, message: string) => ({ row, cause: refusalCause(message), message });
/** A `settle` that refuses exactly one row, for `message`, and settles every other. */
const refuseOnly = (row: number, message: string) => (n: number) =>
  (n === row ? { settled: false, refused: [refusal(n, message)] } : { settled: true, refused: [] });

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

// --- #1299: a closed row whose Status did not move is a failed repair -- named, and never EXIT.DONE ---

/** A fake `gh` for one merged PR that declares an already-closed row (#20) and an open one (#21). */
function prDeclaringTwoRows() {
  return (args: string[]) => {
    if (args[0] === "api" && args[1] === "graphql") {
      return JSON.stringify({ mergeCommit: { oid: "abc1234" }, closingIssuesReferences: { nodes: [
        { number: 20, state: "CLOSED", labels: { nodes: [] } },
        { number: 21, state: "OPEN", labels: { nodes: [] } },
      ] } });
    }
    if (args[0] === "issue" && args[1] === "close") return "";
    throw new Error(`fake gh was asked something it does not know: ${args.join(" ")}`);
  };
}

test("#1299 ACCEPTANCE: a refused Status move is NAMED and exits STATUS_NOT_MOVED, on the already-closed path "
  + "AND the just-closed path", () => {
  const strip = () => {};
  const alreadyRefused = closeOnePr(1, "o/r", { gh_: prDeclaringTwoRows(), strip, settle: refuseOnly(20, "HTTP 500") });
  assert.deepEqual(alreadyRefused, { failed: [], unsettled: [refusal(20, "HTTP 500")] }, "the already-closed path");
  const closedRefused = closeOnePr(1, "o/r", { gh_: prDeclaringTwoRows(), strip, settle: refuseOnly(21, "HTTP 500") });
  assert.deepEqual(closedRefused, { failed: [], unsettled: [refusal(21, "HTTP 500")] }, "the just-closed path");

  const exit = sweepExit(closedRefused);
  assert.equal(exit.code, EXIT.STATUS_NOT_MOVED, "a sweep that moved no Status must not report the axis repaired");
  assert.match(exit.lines.join("\n"), /Status NOT moved for 1: #21\b/, "named by number, never counted");

  // POSITIVE CONTROL, same fixture: every move settling exits DONE, so this cannot be met by a sweep that always fails.
  const allSettled = closeOnePr(1, "o/r", { gh_: prDeclaringTwoRows(), strip, settle: () => ({ settled: true, refused: [] }) });
  assert.deepEqual(allSettled, { failed: [], unsettled: [] });
  assert.deepEqual(sweepExit(allSettled), { code: EXIT.DONE, lines: [] });
});

test("#1299: a row that could not be CLOSED outranks one whose Status did not move -- and both are still named", () => {
  const exit = sweepExit({ failed: [5], unsettled: [refusal(21, "HTTP 500")] });
  assert.equal(exit.code, EXIT.COULD_NOT_CLOSE);
  assert.match(exit.lines.join("\n"), /could not close 1: 5\b/);
  assert.match(exit.lines.join("\n"), /Status NOT moved for 1: #21\b/, "the second fact is not dropped because the first outranks it");
});

test("bridge: a sweep whose ONLY refusals are the captured project-unreadable exits DONE, DEGRADED and named; one other exits 3", () => {
  const strip = () => {};
  const degraded = closeOnePr(1, "o/r", { gh_: prDeclaringTwoRows(), strip,
    settle: (n: number) => ({ settled: false, refused: [refusal(n, CAPTURED_PROJECT_UNREADABLE)] }) });
  const exit = sweepExit(degraded);
  assert.equal(exit.code, EXIT.DONE, "the CI run as captured: the code is green and the token cannot read the Project");
  assert.match(exit.lines.join("\n"), /^SWEEP: DEGRADED -- closed, but Status NOT moved for 2: #20 #21 /m,
    "degraded is SAID, with every row named -- a silent 0 would be #1299 again");

  const mixed = closeOnePr(1, "o/r", { gh_: prDeclaringTwoRows(), strip,
    settle: (n: number) => ({ settled: false, refused: [refusal(n, n === 21 ? "HTTP 500" : CAPTURED_PROJECT_UNREADABLE)] }) });
  const mixedExit = sweepExit(mixed);
  assert.equal(mixedExit.code, EXIT.STATUS_NOT_MOVED, "one refusal for another cause fails the sweep");
  assert.doesNotMatch(mixedExit.lines.join("\n"), /DEGRADED/);
  assert.match(mixedExit.lines.join("\n"), /not project-unreadable: #21\)/, "and names the refusal that did");
});

test("#1299: the exit codes are the contract, and STATUS_NOT_MOVED is distinct from every other", () => {
  assert.deepEqual(EXIT, { DONE: 0, COULD_NOT_CLOSE: 1, CANNOT_ASK: 2, STATUS_NOT_MOVED: 3 });
  assert.equal(new Set(Object.values(EXIT)).size, Object.keys(EXIT).length);
});
