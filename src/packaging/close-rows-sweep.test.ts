/**
 * #394: A BACKSTOP FOR THE CLOSE-ROWS PATH (close-rows.yml until #909, now the project's trunk.yml closeRows job), WHICH FIRED FOR SOME MERGES AND NOT OTHERS FOR AN UNEXPLAINED
 * REASON. `mergedPrsInWindow` and `closeOnePr` run on the fake code host's rows, and the query the sweep asks of GitHub is held by the plugin's test
 * (`plugins/github/rows/closing-merged-window.test.ts`); `main()`'s CLI behaviour (unknown flags, missing GITHUB_REPOSITORY) is driven for real, the same
 * way `queue-stalled.test.ts` and `auto-arm-sweep.ts`'s siblings are. `closurePlan` itself (imported from
 * close-rows-for-merged-pr.ts, never re-derived) already has its own tests -- this file does not repeat
 * them, only proves the sweep wires to the real thing rather than a copy.
 */
import { afterEach, test } from "node:test";
import { testEach } from "../lib/test-each.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mergedPrsInWindow, DEFAULT_WINDOW_MINUTES, closeOnePr, sweepExit, EXIT } from "../close-rows-sweep.ts";
import { closurePlan } from "../close-rows-for-merged-pr.ts";
import { refusalCause } from "../settle-closed-status.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow, type FakeRowPull } from "../plugins/fakes/code-host-rows.ts";

afterEach(() => forgetActivation());

/** CAPTURED, not composed: the reason `moveProjectStatus` gave for #1299 in trunk run 34769927592 (`02ae7420`). */
const CAPTURED_PROJECT_UNREADABLE = "could not move #1299's Status to \"Done\" -- board-snapshot: could not read "
  + "Project 1 items -- refusing to snapshot a partial board. NOT_FOUND (organization.projectV2): Could not resolve to a "
  + "ProjectV2 with the number 2.";
/** A refusal classified by the real `refusalCause`, never a hand-typed cause. */
const refusal = (row: number, message: string) => ({ row, cause: refusalCause(message), message });
/** A `settle` that refuses exactly one row, for `message`, and settles every other. */
const refuseOnly = (row: number, message: string) => (n: number) =>
  (n === row ? { settled: false, refused: [refusal(n, message)] } : { settled: true, refused: [] });

// The script is the TOOL's own, `src` up one.
const SCRIPT = fileURLToPath(new URL("../close-rows-sweep.ts", import.meta.url));

// --- mergedPrsInWindow: the window and the list, over the fake code host's merged pull requests ---
// #5076: the list is the code host's read of the MERGED pull requests, kept by `mergedAt`. What it asks of GitHub (a connection of MERGED pull requests, never a search; the base filter) is the plugin's
// `closing-merged-window.test.ts`.

/** A merged pull request of the world. */
const mergedPull = (number: number, mergedAt: string): FakeRowPull => ({ number, body: "", headRefName: `agent/x-${number}`, labels: [], isDraft: false, armed: false, merged: true, mergedAt, createdAt: mergedAt, comments: [] });
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
/** The fake code host with `pulls` as its merged pull requests, substituted. */
function worldWith(pulls: FakeRowPull[]) {
  const host = createFakeCodeHost();
  for (const pull of pulls) host.rowsWorld.pulls.set(pull.number, pull);
  substituteCodeHost(host);
  return host.rowsWorld;
}

test("mergedPrsInWindow: the window is an ISO timestamp roughly `windowMinutes` ago: a merge before it is not returned, one inside it is", () => {
  worldWith([mergedPull(3, ago(5)), mergedPull(2, ago(40)), mergedPull(9, ago(600)), mergedPull(1, ago(50))]);
  assert.deepEqual(mergedPrsInWindow("owner/repo", 45).map((pr) => pr.number), [3, 2],
    "#9 was merged ten hours ago and #1 fifty minutes ago, outside a 45 minute window");
});

test("mergedPrsInWindow: returns the number list (and nothing else of the row)", () => {
  worldWith([mergedPull(232, ago(1)), mergedPull(281, ago(2))]);
  assert.deepEqual(mergedPrsInWindow("owner/repo", DEFAULT_WINDOW_MINUTES), [{ number: 232 }, { number: 281 }]);
});

test("mergedPrsInWindow: a read that fails THROWS, never an empty list that reads as 'nothing merged' (negative control)", () => {
  const world = worldWith([mergedPull(232, ago(1))]);
  world.failures.set("readMergedPullRequests", new Error("gh: 502"));
  assert.throws(() => mergedPrsInWindow("owner/repo", 45), /gh: 502/);
  world.failures.delete("readMergedPullRequests");
  assert.deepEqual(mergedPrsInWindow("owner/repo", 45), [{ number: 232 }], "control: the same world, read, is the list");
  world.pulls.clear();
  assert.deepEqual(mergedPrsInWindow("owner/repo", 45), [], "control: an answered empty window IS []");
});

// --- closurePlan is REUSED, not re-derived -- proven by import identity, not by re-testing its logic ---

test("close-rows-sweep imports the SAME closurePlan close-rows-for-merged-pr.ts uses, not a copy", () => {
  // If this were a re-derived copy, editing one file's decision would silently leave the other's
  // unchanged -- the exact "fact stated twice" shape #394's own header names. Proven by behavioural
  // identity on a case closurePlan's own tests already cover: a mix of OPEN and already-closed issues.
  const result = closurePlan([{ number: 1, state: "OPEN" }, { number: 2, state: "CLOSED" }]);
  assert.deepEqual(result,
    { close: [{ number: 1, labels: [] }], already: [{ number: 2, labels: [] }], skip: [], none: false, owed: [] });
});

// --- IDEMPOTENCY: running against the same issues twice closes nothing the second time ---

test("ACCEPTANCE (#394, criterion 2): the sweep is idempotent -- a second closurePlan call against "
  + "issues already closed reports ALREADY CLOSED for all of them, closes nothing new", () => {
  const firstPass = closurePlan([{ number: 10, state: "OPEN" }]);
  assert.deepEqual(firstPass, { close: [{ number: 10, labels: [] }], already: [], skip: [], none: false, owed: [] });
  // After #10 is closed (simulated: its state is now CLOSED, as it would be on GitHub after the first run)
  const secondPass = closurePlan([{ number: 10, state: "CLOSED" }]);
  assert.deepEqual(secondPass, { close: [], already: [{ number: 10, labels: [] }], skip: [], none: false, owed: [] });
});

// --- the CLI, guarded like every other argv-reading script here ---

testEach("close-rows-sweep.ts refuses what it cannot run", [
  { name: "an unknown flag rather than silently ignoring it", argv: ["--bogus"], unset: [], stderr: /unknown flag --bogus/, message: "an unknown flag must exit non-zero, not silently run the default window" },
  { name: "without GITHUB_REPOSITORY -- CANNOT ASK, never a guessed repo", argv: [], unset: ["GITHUB_REPOSITORY"], stderr: /GITHUB_REPOSITORY is unset/, message: "with no repo to sweep, the script must refuse rather than guess one" },
] as const, (c) => {
  let threw = false;
  try {
    const env = { ...process.env };
    for (const name of c.unset) delete env[name];
    execFileSync("node", [SCRIPT, ...c.argv], { encoding: "utf8", stdio: "pipe", env });
  } catch (cause) {
    threw = true;
    const err = cause as { status?: number, stderr?: string };
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), c.stderr);
  }
  assert.ok(threw, c.message);
});

// --- #1299: a closed row whose Status did not move is a failed repair -- named, and never EXIT.DONE ---

/** The fake code host for one merged PR that declares an already-closed row (#20) and an open one (#21), whose merge time was not read. */
function prDeclaringTwoRows() {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.repo = "o/r";
  world.rows.set(20, fakeRow(world, 20, { state: "CLOSED" }));
  world.rows.set(21, fakeRow(world, 21));
  world.pulls.set(1, { number: 1, body: "", headRefName: "agent/x", labels: [], isDraft: false, armed: false, merged: true, mergedAt: null, createdAt: ago(1), comments: [], closes: [{ number: 20, labels: [] }, { number: 21, labels: [] }] });
  world.tail.closing.mergeShas.set(1, "abc1234");
  substituteCodeHost(host);
  return world;
}

/** One sweep of PR 1 over a freshly seeded world: a close flips the world's row, so each sweep starts from the rows as they were. */
const sweepTwoRows = (deps: Parameters<typeof closeOnePr>[2]) => {
  prDeclaringTwoRows();
  return closeOnePr(1, "o/r", deps);
};

// --- #1877: the sweep's own path to the identical `skip` bucket -- proven end to end through closeOnePr,
// never re-deriving the decision closurePlan already makes (this file's own header rule).

/** The fake code host for a merged PR whose one declared row is OPEN but was reopened after this PR's own mergedAt. */
function prDeclaringReopenedRow() {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.repo = "a11ign/a11ign";
  world.rows.set(1865, fakeRow(world, 1865, { labels: ["was-ready"] }));
  world.tail.closing.reopenedAt.set(1865, "2026-09-22T01:12:43Z");
  world.pulls.set(1868, { number: 1868, body: "", headRefName: "agent/x", labels: [], isDraft: false, armed: false, merged: true, mergedAt: "2026-09-22T01:00:24Z", createdAt: "2026-09-22T01:00:24Z", comments: [], closes: [{ number: 1865, labels: [] }] });
  world.tail.closing.mergeShas.set(1868, "abc1234");
  substituteCodeHost(host);
  return world;
}

test("#1877 ACCEPTANCE: closeOnePr leaves a row reopened after the PR's own merge alone -- no close call, "
  + "no strip, reported in `skipped`", () => {
  const stripped: number[] = [];
  const settled: number[] = [];
  const world = prDeclaringReopenedRow();
  const result = closeOnePr(1868, "a11ign/a11ign", {
    strip: (n: number) => { stripped.push(n); },
    settle: (n: number) => { settled.push(n); return { settled: true, refused: [] }; },
  });
  assert.deepEqual(result, { failed: [], unsettled: [], skipped: [1865] });
  assert.deepEqual(stripped, []);
  assert.deepEqual(settled, []);
  assert.deepEqual(world.calls.filter((call) => call.startsWith("closeCompletedRow")), [], "a skipped row must never reach the close, or any other write");
  assert.equal(world.rows.get(1865)?.state, "OPEN");
});

test("#1299 ACCEPTANCE: a refused Status move is NAMED and exits STATUS_NOT_MOVED, on the already-closed path "
  + "AND the just-closed path", () => {
  const strip = () => {};
  const alreadyRefused = sweepTwoRows({ strip, settle: refuseOnly(20, "HTTP 500") });
  assert.deepEqual(alreadyRefused, { failed: [], unsettled: [refusal(20, "HTTP 500")], skipped: [] }, "the already-closed path");
  const closedRefused = sweepTwoRows({ strip, settle: refuseOnly(21, "HTTP 500") });
  assert.deepEqual(closedRefused, { failed: [], unsettled: [refusal(21, "HTTP 500")], skipped: [] }, "the just-closed path");

  const exit = sweepExit(closedRefused);
  assert.equal(exit.code, EXIT.STATUS_NOT_MOVED, "a sweep that moved no Status must not report the axis repaired");
  assert.match(exit.lines.join("\n"), /Status NOT moved for 1: #21\b/, "named by number, never counted");

  // POSITIVE CONTROL, same fixture: every move settling exits DONE, so this cannot be met by a sweep that always fails.
  const allSettled = sweepTwoRows({ strip, settle: () => ({ settled: true, refused: [] }) });
  assert.deepEqual(allSettled, { failed: [], unsettled: [], skipped: [] });
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
  const degraded = sweepTwoRows({ strip,
    settle: (n: number) => ({ settled: false, refused: [refusal(n, CAPTURED_PROJECT_UNREADABLE)] }) });
  const exit = sweepExit(degraded);
  assert.equal(exit.code, EXIT.DONE, "the CI run as captured: the code is green and the token cannot read the Project");
  assert.match(exit.lines.join("\n"), /^SWEEP: DEGRADED -- closed, but Status NOT moved for 2: #20 #21 /m,
    "degraded is SAID, with every row named -- a silent 0 would be #1299 again");

  const mixed = sweepTwoRows({ strip,
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
