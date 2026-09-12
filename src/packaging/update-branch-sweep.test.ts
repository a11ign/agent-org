// no-token: gh
//
// #1100: THE FIXTURES SPEAK `statusCheckRollup`'s VOCABULARY AND THE EXPECTATIONS SPEAK THE NORMALISED
// ONE, and that asymmetry is the point rather than an inconsistency. `gh pr list --json statusCheckRollup`
// -- the call this file's subject is fed from -- returns `COMPLETED`/`SUCCESS`/`FAILURE`/`CANCELLED`,
// while `gh api .../check-runs` returns `completed`/`success`/`null`. **`newestConclusion` normalises at
// that edge**, alongside the zero date and the empty string, so every reader downstream has ONE
// vocabulary and the `NO_VERDICT` it imports from `checks-rule.mjs` means what it says.
//
// So the inputs below stay UPPER -- they are what the API really returns -- and the expected outputs are
// lower. **A fixture written in the other API's vocabulary is what let a dead branch read green once.**
//
// #1018: this file imports `update-branch-sweep.mjs`, whose `gh` helper (`:266`) spawns a real `gh`, and
// the parser charges a command its whole import closure. True of the IMPORT and false of the CALL: every
// test here is either pure (`updateBranchDecision`, `movedHeadRefusal`, `newestConclusion`) or injects its
// own runner (`isBehind`'s `runGit`, `readHeadNow`'s `run`). The same over-charge #827 fixed for
// board-markdown.test.ts -- a caller that REACHES a module which can spawn `gh` is not the same fact as
// this file's own tests ever doing so.
//
// PROVED, NOT ASSERTED, since #827's check is deliberately shallow: `GH_TOKEN` and `GITHUB_TOKEN` unset, a
// fake `gh` first on PATH that exits 97 and shouts -- 24 pass, 0 fail, and the fake is invoked ZERO times.
// The refusal is pre-existing, not new: `origin/main`'s own copy of this file derives `token` at the same
// `:266`, with none of this row's changes present.
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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { updateBranchDecision, isBehind, newestConclusion, movedHeadRefusal, readHeadNow, updateOnePr, sweepPrs }
  from "../../../../scripts/update-branch-sweep.mjs";
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
  assert.equal(newestConclusion(CANCELLED_THEN_SUCCESS, "gate"), "success");
});

test("newestConclusion: MUTATION TARGET -- the whole decision, on #485's real head, is UPDATE not SKIP", () => {
  const gateConclusion = newestConclusion(CANCELLED_THEN_SUCCESS, "gate");
  const d = updateBranchDecision({ armed: true, gateConclusion, behind: true });
  assert.equal(d.update, true,
    `#485 was green and 16 commits behind; the sweep skipped it. Decision said: ${d.reason}`);
});

test("newestConclusion: ARRAY ORDER IS NOT TRUSTED -- newest-first input gives the same answer", () => {
  const reversed = [...CANCELLED_THEN_SUCCESS].reverse();
  assert.equal(newestConclusion(reversed, "gate"), "success");
});

test("newestConclusion: a genuinely failing head is STILL read as failing -- the skip must survive", () => {
  const runs = [
    { name: "gate", conclusion: "SUCCESS", completedAt: "2026-09-08T07:00:00Z", startedAt: "2026-09-08T06:59:00Z" },
    { name: "gate", conclusion: "FAILURE", completedAt: "2026-09-08T08:00:00Z", startedAt: "2026-09-08T07:59:00Z" },
  ];
  assert.equal(newestConclusion(runs, "gate"), "failure");
  // #1100: THE READER'S ANSWER IS UNCHANGED AND IS WHAT THIS TEST IS ABOUT -- a genuinely failing head
  // still READS as failing. What changed is what the sweep DOES with that reading: an armed, behind PR is
  // now updated anyway, because `gate = FAILURE` has two causes and the update is the only thing that
  // tells them apart. The decision half is asserted here in its new direction rather than dropped, so
  // this file cannot silently stop saying anything about it.
  assert.equal(updateBranchDecision({ armed: true, gateConclusion: "FAILURE", behind: true }).update, true);
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
  assert.equal(newestConclusion(runs, "gate"), "success");
});

test("newestConclusion: startedAt is the fallback key when completedAt is absent on both", () => {
  const runs = [
    { name: "gate", conclusion: "FAILURE", completedAt: null, startedAt: "2026-09-08T07:00:00Z" },
    { name: "gate", conclusion: "SUCCESS", completedAt: null, startedAt: "2026-09-08T08:00:00Z" },
  ];
  assert.equal(newestConclusion(runs, "gate"), "success");
});

test("#498's rule is RELOCATED, not lost: the line still names the reading, now on the UPDATE (#1100)", () => {
  // THIS TEST USED TO PIN THE SKIP. #1100 removed that skip -- a red, armed, behind PR is updated,
  // because its red has two causes and updating is the only instrument that distinguishes them. **#498's
  // value was never the skip; it was that the line named the READING rather than only the verdict**, so
  // a wrong decision is falsifiable from the log alone. That property is asserted here on the new path.
  const d = updateBranchDecision({ armed: true, gateConclusion: "FAILURE", behind: true });
  assert.equal(d.update, true, "the decision reversed -- see #1100 and the ACCEPTANCE test in "
    + "update-branch-decision.test.ts");
  assert.match(d.reason, /gate = failure/,
    "the reason must still say WHAT IT READ, not merely that it acted");
  assert.match(d.reason, /#498/,
    "and it must still name #498, because the author still owns a red that survives the update");
  assert.match(d.reason, /if it CLEARS, the red was the base's/,
    "and it must say what the next reading MEANS -- otherwise the update is a cost paid on a guess "
    + "rather than the answer to the question the old skip guessed at");
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

test("updateBranchDecision: armed, gate FAILURE, behind -- UPDATED, and #1100 is why", () => {
  // REPLACED RATHER THAN DELETED. The old assertion (`update === false`, "a failing PR needs a fix, not a
  // stale-main push") was correct about a PR red on its OWN contents and wrong about one red because of
  // its base -- and nothing in the gate conclusion tells those apart. Measured on sweep run
  // `34692306488`: #1093 skipped here, red from a guard #1080 had deleted from main, with no fix its
  // author could push. The full argument lives in `update-branch-decision.test.ts`'s #1100 block.
  const d = updateBranchDecision({ armed: true, gateConclusion: "FAILURE", behind: true });
  assert.equal(d.update, true);
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

// --- #1018: THE DECISION IS PINNED TO THE HEAD IT WAS MADE FROM ---
//
// `gh pr list` names every open PR's `headRefOid` in one call; every decision above is computed from that
// snapshot; and the action, `gh pr update-branch <n>`, takes a PR NUMBER and no sha. So a push landing in
// the gap makes the DECISION wrong rather than the push, in BOTH directions: a PR already updated is
// pushed again on a stale `behind`, and a PR that has since fallen behind is skipped on a stale
// `up to date`. Neither printed anything a reader could act on.
//
// This row is NOT "`gh pr list` returns a stale head" -- that claim was considered and dropped on the row
// itself, because the observation is equally explained by the list lagging and by the read simply
// preceding the push. The property that holds either way is that a head is a value read at a time.

const SHA = (c: string) => c.repeat(40);

test("#1018 ACCEPTANCE: a head that MOVED between the decision and the action is refused, and the "
  + "refusal names the PR and both shas", () => {
  const refusal = movedHeadRefusal({ number: 1023, decidedFrom: SHA("a"), headNow: SHA("b") })!;
  assert.ok(refusal, "acting on a verdict computed from a head that no longer exists is the defect");
  assert.match(refusal, /#1023/, "which PR");
  assert.match(refusal, /aaaaaaaaaaaa/, "the sha it decided from");
  assert.match(refusal, /bbbbbbbbbbbb/, "and the sha the head is now, so a reader can tell a race from a fault");
  assert.match(refusal, /re-decided on the next sweep/,
    "and what happens next -- a refusal that does not say is indistinguishable from a dropped PR");
});

test("#1018 ACCEPTANCE (the direction this kind of fix fails in): an UNMOVED head still updates", () => {
  assert.equal(movedHeadRefusal({ number: 1023, decidedFrom: SHA("a"), headNow: SHA("a") }), null,
    "without this the pin becomes `never update`, which is a quieter version of the same outage");
});

test("#1018: an UNREADABLE head is refused, never treated as unchanged -- this sweep runs unattended and "
  + "pushes to other sessions' branches", () => {
  const refusal = movedHeadRefusal({ number: 1023, decidedFrom: SHA("a"), headNow: null })!;
  assert.ok(refusal);
  assert.match(refusal, /unreadable head is not an unchanged one/);
  assert.doesNotMatch(refusal, /MOVED/, "an unreadable head is a different report from a moved one");
});

test("#1018: readHeadNow returns null rather than a guess when the read fails or is unrecognisable", () => {
  const ok = readHeadNow({ number: 1, repo: "o/r", run: () => JSON.stringify({ headRefOid: SHA("c") }) });
  assert.equal(ok, SHA("c"), "and the reading path must work, or the refusals below prove nothing");
  for (const [name, run] of [
    ["a failed call", () => { throw new Error("gh: HTTP 502"); }],
    ["not JSON", () => "<html>proxy error</html>"],
    ["no headRefOid", () => JSON.stringify({ number: 1 })],
    ["an empty headRefOid", () => JSON.stringify({ headRefOid: "" })],
  ] as [string, () => string][]) {
    assert.equal(readHeadNow({ number: 1, repo: "o/r", run }), null, `${name} must read as null`);
  }
  // AND null FEEDS A REFUSAL, not a pass -- the two halves are only correct together.
  assert.ok(movedHeadRefusal({ number: 1, decidedFrom: SHA("a"),
    headNow: readHeadNow({ number: 1, repo: "o/r", run: () => { throw new Error("x"); } }) }));
});

test("#1018: `queue-stalled.mjs` is UNTOUCHED, and is not silently assumed to share this fix", () => {
  // The row's own instruction. `queue-stalled.mjs:320` reads the same snapshot the same way and REPORTS
  // rather than acting, so it has the same shape and a cheaper consequence -- worth the same fix, not the
  // same commit. This asserts the pair have not been quietly merged into one claim.
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const queueStalled = readFileSync(resolve(repo, "scripts/queue-stalled.mjs"), "utf8");
  assert.doesNotMatch(queueStalled, /movedHeadRefusal|readHeadNow/,
    "if queue-stalled starts importing these, the two files' guarantees have merged and this test should "
    + "be replaced by one asserting the shared behaviour -- not deleted");
  // AND NOT A THIRD ASSERTION THAT THE FILE STILL MENTIONS `expected_head_sha`. I wrote one, then
  // mutated it: deleting the heading of that comment block left the phrase elsewhere in the block and the
  // test stayed green -- so it was pinning a STRING, not the reasoning. Worse, pinning that a comment
  // survives is the exact shape #1027 is about (a check that reads the explanation of a thing instead of
  // the thing). The reasoning for not adopting the atomic form lives in the code and on the PR, where a
  // reader who disagrees can argue with it; a test cannot tell whether it is still true.
});

// --- #1018: AND THE CALL SITE IS HELD, NOT ONLY THE DECISION ---
//
// worker-capture's finding on this PR, and the finding I had made on theirs four hours earlier:
// `movedHeadRefusal` and `readHeadNow` were both driven thoroughly and NEITHER WAS WIRED TO ANYTHING A
// TEST COULD SEE. `if (false && refusal)` turned 0 red. Driving the function holds the function and
// misses the call being deleted, so these assert on what was SPAWNED rather than on what was computed.

test("#1018 ACCEPTANCE: a MOVED head means `gh pr update-branch` is never invoked at all", () => {
  const calls: string[][] = [];
  const outcome = updateOnePr(
    { pr: { number: 1023, headRefOid: SHA("a") }, repo: "o/r", reason: "behind, armed, gate green" },
    { run: (args: string[]) => { calls.push(args); return ""; }, readHead: () => SHA("b") },
  );
  assert.equal(outcome.acted, false);
  assert.equal(outcome.failed, false, "a refusal is not a failure -- it is re-decided next sweep");
  assert.deepEqual(calls, [],
    "NOTHING may be spawned. This is the assertion `if (false && refusal)` survived: the refusal string "
    + "was still computed and the push still happened");
  assert.match(outcome.line, /#1023 REFUSED/);
});

test("#1018 ACCEPTANCE: an UNMOVED head DOES invoke it, with the PR number -- the pin must not become "
  + "`never update`", () => {
  const calls: string[][] = [];
  const outcome = updateOnePr(
    { pr: { number: 1023, headRefOid: SHA("a") }, repo: "o/r", reason: "behind, armed, gate green" },
    { run: (args: string[]) => { calls.push(args); return ""; }, readHead: () => SHA("a") },
  );
  assert.equal(outcome.acted, true);
  assert.deepEqual(calls, [["pr", "update-branch", "1023", "--repo", "o/r"]]);
  assert.match(outcome.line, /#1023 UPDATED -- behind, armed, gate green/);
});

test("#1018: an UNREADABLE head spawns nothing either, and reads as a refusal rather than a failure", () => {
  const calls: string[][] = [];
  const outcome = updateOnePr(
    { pr: { number: 7, headRefOid: SHA("a") }, repo: "o/r", reason: "behind" },
    { run: (args: string[]) => { calls.push(args); return ""; }, readHead: () => null },
  );
  assert.deepEqual(calls, []);
  assert.equal(outcome.failed, false);
  assert.match(outcome.line, /unreadable head is not an unchanged one/);
});

test("#1018: a genuine `gh pr update-branch` failure is reported as FAILED, not as a refusal -- the two "
  + "have different remedies and the sweep's exit code distinguishes them", () => {
  const outcome = updateOnePr(
    { pr: { number: 9, headRefOid: SHA("a") }, repo: "o/r", reason: "behind" },
    { run: () => { throw new Error("merge conflict"); }, readHead: () => SHA("a") },
  );
  assert.equal(outcome.acted, false);
  assert.equal(outcome.failed, true);
  assert.match(outcome.line, /#9 FAILED -- .*merge conflict/);
});

test("#1018: THE LOOP ITSELF IS HELD -- a moved head in a real sweep spawns nothing for that PR and "
  + "still updates the others", () => {
  // Extracting `updateOnePr` alone was not enough: making `main`'s loop stop calling it turned 0 red,
  // because the loop was still inside a function no test can enter. Each extraction moves the unheld
  // surface up one level, and this is the last level worth moving -- what remains is argv and printing.
  const calls: string[][] = [];
  const heads: Record<number, string> = { 1: SHA("a"), 2: SHA("z") };  // #2's head moved under us
  const armed = { autoMergeRequest: {}, statusCheckRollup: [{ name: "gate", conclusion: "SUCCESS", completedAt: "2026-09-12T00:00:00Z", startedAt: "2026-09-12T00:00:00Z" }] };
  const result = sweepPrs(
    [{ number: 1, headRefOid: SHA("a"), ...armed }, { number: 2, headRefOid: SHA("b"), ...armed }],
    {
      repo: "o/r",
      run: (args: string[]) => { calls.push(args); return ""; },
      readHead: ({ number }: { number: number }) => heads[number],
      runGit: () => ({ status: 1 }),      // behind, so both are candidates to update
      now: new Date("2026-09-12T01:00:00Z"),
    },
  );
  assert.equal(result.updated, 1, "#1 updates");
  assert.deepEqual(result.failed, [], "and a refusal is not a failure");
  assert.deepEqual(calls, [["pr", "update-branch", "1", "--repo", "o/r"]],
    "EXACTLY ONE spawn, for #1 -- #2's moved head must reach no `gh` call at all");
  assert.ok(result.lines.some((l) => /#2 REFUSED/.test(l)), "and #2 is reported, not silently dropped");
});

test("#1018: a PR the DECISION declines is reported too -- an unattended sweep's log is the only reader "
  + "it gets, and a PR that vanishes from it reads as one that was handled", () => {
  const calls: string[][] = [];
  const result = sweepPrs(
    [{ number: 5, headRefOid: SHA("a"), autoMergeRequest: null, statusCheckRollup: [] }],  // not armed
    {
      repo: "o/r",
      run: (args: string[]) => { calls.push(args); return ""; },
      readHead: () => SHA("a"),
      runGit: () => ({ status: 1 }),
      now: new Date("2026-09-12T01:00:00Z"),
    },
  );
  assert.equal(result.updated, 0);
  assert.deepEqual(calls, [], "an unarmed PR is not touched");
  assert.equal(result.lines.length, 1, "and it still produces a line");
  assert.match(result.lines[0], /#5 SKIPPED -- /, "naming the PR and the reason it was declined");
});

/**
 * #1126: THE ORCHESTRATION HALF. `updateBranchDecision` is pure and takes both timestamps as inputs, so
 * something has to READ them — and until this row `sweepPrs` was not passing main's tip time at all. The
 * row warned that this reaches a third file; it is this one, and it is declared rather than discovered.
 */
test("#1126: main's tip time is read ONCE per sweep, not once per PR", () => {
  // One fact, every PR compared against the same one. Reading it in the loop would let the answer change
  // mid-sweep if main moved, so two PRs with identical gates could be classified differently by an
  // accident of ordering -- a verdict that depends on position in a list is not a verdict.
  const gitCalls: string[][] = [];
  const armedRed = {
    autoMergeRequest: {},
    statusCheckRollup: [{ name: "gate", conclusion: "FAILURE",
      completedAt: "2026-09-12T10:00:00Z", startedAt: "2026-09-12T09:00:00Z" }],
  };
  const result = sweepPrs(
    [{ number: 1, headRefOid: SHA("a"), ...armedRed }, { number: 2, headRefOid: SHA("b"), ...armedRed }],
    {
      repo: "o/r",
      run: () => "",
      readHead: ({ number }: { number: number }) => (number === 1 ? SHA("a") : SHA("b")),
      runGit: (args: string[]) => {
        gitCalls.push(args);
        if (args[0] === "log") return { status: 0, stdout: "2026-09-12T11:00:00Z\n" };
        return { status: 1 };   // merge-base: behind
      },
      now: new Date("2026-09-12T12:00:00Z"),
    },
  );
  const logCalls = gitCalls.filter((args) => args[0] === "log");
  assert.equal(logCalls.length, 1, `main's tip must be asked for once, got ${logCalls.length}`);
  assert.deepEqual(logCalls[0], ["log", "-1", "--format=%cI", "origin/main"],
    "the COMMITTER date: a rebased commit keeps an author date that can predate every gate on every open "
    + "PR, which would classify the whole queue as 'its own'");

  // And the classification reaches the line both PRs are logged with -- the decision being right is not
  // the same claim as the sweep printing it.
  assert.equal(result.lines.length, 2);
  for (const line of result.lines) {
    assert.match(line, /THE BASE'S/, `gate concluded 10:00Z, main's tip landed 11:00Z: ${line}`);
  }
});

test("#1126: when git cannot answer, the sweep falls back to #1100's sentence rather than guessing", () => {
  // The control for the test above. Without it, a sweep whose `mainTipAt` was silently always-null would
  // pass every assertion about the unreadable path while never exercising the readable one -- and the
  // existing suite did exactly that before this row, because its `runGit` returns status 1 for everything.
  const result = sweepPrs(
    [{ number: 1, headRefOid: SHA("a"), autoMergeRequest: {},
      statusCheckRollup: [{ name: "gate", conclusion: "FAILURE", completedAt: "2026-09-12T10:00:00Z" }] }],
    {
      repo: "o/r",
      run: () => "",
      readHead: () => SHA("a"),
      runGit: () => ({ status: 1 }),
      now: new Date("2026-09-12T12:00:00Z"),
    },
  );
  assert.match(result.lines[0], /CANNOT BE READ/);
  assert.match(result.lines[0], /if it CLEARS/);
});
