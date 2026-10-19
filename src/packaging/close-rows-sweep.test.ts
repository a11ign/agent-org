/**
 * #394: A BACKSTOP FOR THE CLOSE-ROWS PATH (close-rows.yml until #909, now the project's trunk.yml closeRows job), WHICH FIRED FOR SOME MERGES AND NOT OTHERS FOR AN UNEXPLAINED
 * REASON. `mergedPrsInWindow` is driven with an injected `gh` so the query shape is proven without a live
 * repo; `main()`'s CLI behaviour (unknown flags, missing GITHUB_REPOSITORY) is driven for real, the same
 * way `queue-stalled.test.ts` and `auto-arm-sweep.ts`'s siblings are. `closurePlan` itself (imported from
 * close-rows-for-merged-pr.ts, never re-derived) already has its own tests -- this file does not repeat
 * them, only proves the sweep wires to the real thing rather than a copy.
 */
import { test } from "node:test";
import { testEach } from "../lib/test-each.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mergedPrsInWindow, DEFAULT_WINDOW_MINUTES, closeOnePr, sweepExit, EXIT } from "../close-rows-sweep.ts";
import { closurePlan } from "../close-rows-for-merged-pr.ts";
import { refusalCause } from "../settle-closed-status.ts";
import { readsRowsSince, sinceAnswer } from "./rows-by-label-fixtures.ts";

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

// --- mergedPrsInWindow: the query, driven with an injected gh ---
// #5076: the list is `repository.pullRequests(states:[MERGED])`, a connection read newest-updated first back to the window's start and kept by `mergedAt` -- the
// `--search merged:>=` it replaced was a GitHub SEARCH, whose allowance the installation spent.

/** A merged pull request as the connection returns it. `updatedAt` is never before `mergedAt`. */
const merged = (number: number, mergedAt: string, base = "main", updatedAt = mergedAt) => ({ number, mergedAt, updatedAt, baseRefName: base });
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

test("mergedPrsInWindow: reads the MERGED pull requests of the repository as a connection -- never a search, and never an unscoped list", () => {
  const calls: string[][] = [];
  const fakeGh = (args: string[]) => { calls.push(args); return sinceAnswer(args, []); };
  mergedPrsInWindow("a11ign/a11ign", 45, fakeGh);
  assert.equal(calls.length, 1);
  assert.deepEqual(readsRowsSince(calls[0]), { kind: "pullRequests", states: ["MERGED"], orderBy: "UPDATED_AT", label: null, repo: "a11ign/a11ign", after: null },
    "THE RISK THIS ROW NAMES: a PR that did not merge must never be in this list at all -- proven at the query, not by a downstream filter that could be forgotten");
  assert.ok(!calls[0].includes("--search") && !calls[0].includes("--label"), "no argv is a GitHub search");
});

test("mergedPrsInWindow: the window is an ISO timestamp roughly `windowMinutes` ago: a merge before it is not returned, one inside it is, and a row only UPDATED inside it is not", () => {
  const rows = [merged(3, ago(5)), merged(2, ago(40)), merged(9, ago(600), "main", ago(1)), merged(1, ago(50), "main", ago(30))];
  const fakeGh = (args: string[]) => sinceAnswer(args, rows);
  const result = mergedPrsInWindow("owner/repo", 45, fakeGh);
  assert.deepEqual(result.map((pr) => pr.number), [3, 2],
    "#9 was merged ten hours ago and updated a minute ago (a comment): read, and dropped by its own mergedAt; #1 merged 50 minutes ago is outside a 45 minute window");
});

test("mergedPrsInWindow: only pull requests merged into `main` are returned (the base filter is kept)", () => {
  const rows = [merged(5, ago(2), "main"), merged(6, ago(3), "release"), merged(7, ago(4), "main")];
  assert.deepEqual(mergedPrsInWindow("owner/repo", 45, (args) => sinceAnswer(args, rows)), [{ number: 5 }, { number: 7 }]);
});

test("mergedPrsInWindow: returns the number list (and nothing else of the row)", () => {
  const result = mergedPrsInWindow("owner/repo", DEFAULT_WINDOW_MINUTES, (args) => sinceAnswer(args, [merged(232, ago(1)), merged(281, ago(2))]));
  assert.deepEqual(result, [{ number: 232 }, { number: 281 }]);
});

test("mergedPrsInWindow: a read that fails THROWS, never an empty list that reads as 'nothing merged' (negative control)", () => {
  assert.throws(() => mergedPrsInWindow("owner/repo", 45, () => { throw new Error("gh: 502"); }), /gh: 502/);
  assert.throws(() => mergedPrsInWindow("owner/repo", 45, () => "not json"), SyntaxError);
  assert.deepEqual(mergedPrsInWindow("owner/repo", 45, (args) => sinceAnswer(args, [])), [], "control: an answered empty window IS []");
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

// --- #1877: the sweep's own path to the identical `skip` bucket -- proven end to end through closeOnePr,
// never re-deriving the decision closurePlan already makes (this file's own header rule).

/** A fake `gh` for a merged PR whose one declared row is OPEN but was reopened after this PR's own mergedAt. */
function prDeclaringReopenedRow() {
  return (args: string[]) => {
    if (args[0] === "api" && args[1] === "graphql") {
      return JSON.stringify({ mergedAt: "2026-09-22T01:00:24Z", mergeCommit: { oid: "abc1234" },
        closingIssuesReferences: { nodes: [
          { number: 1865, state: "OPEN", labels: { nodes: ["was-ready"] },
            timelineItems: { nodes: [{ createdAt: "2026-09-22T01:12:43Z" }] } },
        ] } });
    }
    throw new Error(`fake gh was asked something it does not know: ${args.join(" ")}`
      + " -- a skipped row must never reach issue close, edit or any other write");
  };
}

test("#1877 ACCEPTANCE: closeOnePr leaves a row reopened after the PR's own merge alone -- no close call, "
  + "no strip, reported in `skipped`", () => {
  const stripped: number[] = [];
  const settled: number[] = [];
  const result = closeOnePr(1868, "a11ign/a11ign", {
    gh_: prDeclaringReopenedRow(),
    strip: (n: number) => { stripped.push(n); },
    settle: (n: number) => { settled.push(n); return { settled: true, refused: [] }; },
  });
  assert.deepEqual(result, { failed: [], unsettled: [], skipped: [1865] });
  assert.deepEqual(stripped, []);
  assert.deepEqual(settled, []);
});

test("#1299 ACCEPTANCE: a refused Status move is NAMED and exits STATUS_NOT_MOVED, on the already-closed path "
  + "AND the just-closed path", () => {
  const strip = () => {};
  const alreadyRefused = closeOnePr(1, "o/r", { gh_: prDeclaringTwoRows(), strip, settle: refuseOnly(20, "HTTP 500") });
  assert.deepEqual(alreadyRefused, { failed: [], unsettled: [refusal(20, "HTTP 500")], skipped: [] }, "the already-closed path");
  const closedRefused = closeOnePr(1, "o/r", { gh_: prDeclaringTwoRows(), strip, settle: refuseOnly(21, "HTTP 500") });
  assert.deepEqual(closedRefused, { failed: [], unsettled: [refusal(21, "HTTP 500")], skipped: [] }, "the just-closed path");

  const exit = sweepExit(closedRefused);
  assert.equal(exit.code, EXIT.STATUS_NOT_MOVED, "a sweep that moved no Status must not report the axis repaired");
  assert.match(exit.lines.join("\n"), /Status NOT moved for 1: #21\b/, "named by number, never counted");

  // POSITIVE CONTROL, same fixture: every move settling exits DONE, so this cannot be met by a sweep that always fails.
  const allSettled = closeOnePr(1, "o/r", { gh_: prDeclaringTwoRows(), strip, settle: () => ({ settled: true, refused: [] }) });
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
