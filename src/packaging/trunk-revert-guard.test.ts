/**
 * #411: A MERGE CAN DELETE WORK ALREADY ON `main`, AND EVERY CHECK PASSES.
 *
 * `unexplainedDeletions` is the whole decision, as one pure function. The discovery of its discriminator
 * -- a deleted path is EXPLAINED only when a non-merge commit unique to the branch actually touched it --
 * was verified against BOTH real commits in this repository's own history before being written down here:
 * `f2cdfaf3` (the incident: a deletion no branch commit ever mentions) and `fc9b89d2` (#354, a deliberate
 * consolidation: a real commit, `ca922204`, names the deletion). See trunk-revert-guard.mjs's own header
 * for why the more obvious instruments -- `git merge-tree` on the merge's own two parents, and GitHub's
 * `gh pr view --json files` -- both FAIL to distinguish the two, because the loss happened several commits
 * deep inside the branch's own internal main-sync history, not at the outermost merge.
 */
// requires: history
//
// #497. Every spawn below runs the guard against two REAL merges -- `f2cdfaf3` (the incident) and
// `fc9b89d2` (#354's documented legitimate deletion). The acceptance job checks out at depth 1,
// deliberately (`reusable-acceptance.yml`: "NO `fetch-depth: 0` HERE"), and a shallow checkout does not
// contain them:
//
//     fatal: ambiguous argument 'fc9b89d2': unknown revision or path not in the working tree
//
// Measured on #895's own acceptance run, 2026-09-09. NOT caused by the clone #890 introduced -- a clone
// of a shallow repository is shallow, and `cwd: REPO` against the same checkout fails identically.
// Naming this file in an acceptance command for the first time is what made a standing requirement
// visible; these tests could never have run there.
//
// The declaration is what turns that git failure into a refusal BY NAME, before the spawn, and lets a PR
// that needs them deepen the checkout with `History: full`.

// no-token: gh
//
// #827. `revertVerdict` takes its facts as an argument and returns a verdict -- `trunk-revert.mjs`'s
// caller does the lookups -- and this file calls it with a fixture. The closure walk reaches `gh` through
// that module's graph rather than through anything these tests execute.
//
// The spawned script runs `git`, not `gh`, and since #890 it runs against a local clone rather than the
// checkout hosting the suite.
//
// Verified against the entry's own code by #827's mechanism, so if `revertVerdict` ever starts doing its
// own lookups this refuses rather than trusting the comment.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { readFileSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { sandboxGitEnv } from "../../../../scripts/git-env.mjs";
import { parse as parseYaml } from "yaml";
import {
  unexplainedDeletions, mergeParents, deletedPaths, branchTouchedPaths, EXIT,
} from "../../../../scripts/trunk-revert-guard.mjs";
import { revertVerdict, EXIT as REVERT_EXIT } from "../../../../scripts/trunk-revert.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCRIPT = `${REPO}/scripts/trunk-revert-guard.mjs`;

/**
 * A LOCAL CLONE WITH ITS OWN `origin`, BECAUSE THIS SCRIPT REALLY FETCHES.
 *
 * `trunk-revert-guard.mjs` runs `git fetch origin --quiet` before it looks at anything (line ~145,
 * unconditional, and deliberately so -- worker-contracts' finding that the guard must not read a
 * remote-tracking ref that a checkout happens to have fetched an hour ago). Every spawn below used to
 * pass `cwd: REPO`, which resolves to whichever checkout is running the suite -- so a `npm test` in any
 * worktree fetched into the SHARED primary `.git`, writing its remote-tracking refs while another
 * worktree may be doing the same. A test mutating the checkout that drives the fleet, with a lock in the
 * failure mode. #640's class, found by worker-audit from a real collision (#890).
 *
 * `git clone --local` hardlinks the object store, so this costs almost nothing and keeps the real
 * history the tests need: `f2cdfaf3` and `fc9b89d2` are documented merges on main, and a synthetic
 * fixture could not stand in for them without inventing the very shapes the guard is being proved
 * against.
 *
 * THE CLONE'S `origin` IS THE PRIMARY, so the script's `fetch` READS it and writes only inside the
 * clone. Reading is not the hazard; the hazard was two writers on one ref namespace.
 *
 * Cloned ONCE for the whole file rather than per test -- four spawns, one clone -- and removed in
 * `after()`. A clone per spawn would be correct and four times the cost for no extra isolation, since
 * none of these tests writes to it.
 */
const CLONE = realpathSync(mkdtempSync(join(tmpdir(), "a11y-revert-guard-")));
execFileSync("git", ["clone", "--local", "--quiet", REPO, CLONE], { stdio: "pipe", env: sandboxGitEnv() });

/**
 * A clone of a SHALLOW checkout is shallow, and the two real merges below are then simply absent --
 * `fatal: ambiguous argument 'fc9b89d2': unknown revision`, which the guard correctly reports as
 * CANNOT_ASK (exit 2), which these tests then read as a wrong verdict (expected 1 or PASS). That is what
 * turned main red for 27 hours from #895's merge (48aef3f2, 2026-09-09 19:11Z): trunk-guard's unscoped
 * build took the shallow checkout, and every later push was declined as INHERITED. #901.
 *
 * So each spawning test asks first whether the fixture is present, and SKIPS BY NAME when it is not --
 * the same shape `backlog-file-facts.test.ts` uses for a blob the checkout cannot see. A skip is honest
 * where a pass would be a lie and a fail blames the wrong thing; the job that must actually run these is
 * `trunk-guard`'s unscoped build, whose checkout is full-history since the same PR, and a PR body can
 * deepen the acceptance job's with `History: full`.
 */
/**
 * #1040: THE SKIP LINE STATES A CAUSE, AND `cat-file -e` CANNOT SUPPORT IT.
 *
 * `NO_FIXTURE` below says `(shallow clone)`. That is a diagnosis, and this catch was bare. Measured
 * 2026-09-12 against this repository:
 *
 *     missing object in a real repo   -> 128
 *     a directory that is NOT a repo  -> 128
 *     present object (control)        ->   0
 *
 * **No status separates them**, so #1023's remedy -- exit 1 is a real no, anything else is a failure --
 * does not transfer. It needs a POSITIVE CONTROL: prove the clone readable first, and then a 128 is
 * genuinely about the object. The same shape `assertOriginMainReadable` uses one file over.
 *
 * `cloneReadable` is computed ONCE and memoised, because the answer cannot change inside a run and
 * spawning git per fixture per test is the cost this file already avoids elsewhere.
 * @returns {boolean} true when `CLONE` is a readable repository
 */
function cloneReadable(cwd: string = CLONE): boolean {
  if (cwd !== CLONE) return objectPresent("HEAD", cwd);   // an injected clone is never memoised
  if (cloneProved === null) cloneProved = objectPresent("HEAD", CLONE);
  return cloneProved;
}
let cloneProved: boolean | null = null;

/** Does `rev` resolve to a commit in `cwd`? The bare question, with no diagnosis attached. */
function objectPresent(rev: string, cwd: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${rev}^{commit}`], { cwd, stdio: "pipe", env: sandboxGitEnv() });
    return true;
  } catch {
    return false;
  }
}

/**
 * INJECTABLE `cwd`, and that is not a convenience. The fix is a positive control, and a control can only
 * be shown to work by pointing it at a clone that genuinely cannot be read -- which cannot be `CLONE`.
 * Without the seam, dropping the control turned **0 red**: the measurement was tested and the wiring was
 * not, which is the shape this whole night has been about.
 */
const fixturePresent = (sha: string, cwd: string = CLONE): boolean =>
  // NO CONTROL HERE, DELIBERATELY, AND I HAD ONE UNTIL A MUTATION SAID IT WAS DOING NOTHING. Guarding this
  // with `cloneReadable` returns `false` for an unreadable clone -- which `objectPresent` already does,
  // since git errors either way. Dropping the guard turned **0 red**, and the honest reading is that it
  // was never load-bearing: the two states are indistinguishable in the ANSWER and distinguishable only in
  // the DIAGNOSIS. So the control lives in `NO_FIXTURE`, where the cause is stated, and this stays the
  // bare question it always was. A line kept because it looks careful is a line nothing can hold.
  objectPresent(sha, cwd);
// #1040: TWO STATES, TWO LINES. The skip may name `(shallow clone)` only on the path where the clone was
// proved readable; an unreadable clone is a different report with a different remedy, and saying the first
// when the second is true sends a reader to deepen a checkout that is not the problem.
const NO_FIXTURE = (sha: string, cwd: string = CLONE) => (cloneReadable(cwd)
  ? `SKIPPED: fixture merge ${sha} is not in this checkout (shallow clone) -- the acceptance ran nowhere `
    + "here. trunk-guard's full-history build runs it; a PR body can declare `History: full` to run it in "
    + "acceptance."
  : `SKIPPED: the test clone at ${cwd} could not be read at all, so whether ${sha} is present is `
    + "UNKNOWN -- this is not a shallow checkout, it is an unreadable one, and deepening will not fix it.");

after(() => rmSync(CLONE, { recursive: true, force: true }));

// --- unexplainedDeletions: the pure decision ---

test("unexplainedDeletions: a path no branch commit touched is unexplained", () => {
  const result = unexplainedDeletions({ deletedPaths: ["a.ts"], branchTouchedPaths: new Set() });
  assert.deepEqual(result, ["a.ts"]);
});

test("unexplainedDeletions: MUTATION TARGET -- a path the branch DID touch is explained, not reported", () => {
  const result = unexplainedDeletions({ deletedPaths: ["a.ts"], branchTouchedPaths: new Set(["a.ts"]) });
  assert.deepEqual(result, []);
});

test("unexplainedDeletions: a mixed set reports only the untouched ones", () => {
  const result = unexplainedDeletions({
    deletedPaths: ["a.ts", "b.ts", "c.ts"], branchTouchedPaths: new Set(["b.ts"]),
  });
  assert.deepEqual(result, ["a.ts", "c.ts"]);
});

test("unexplainedDeletions: no deleted paths at all reports nothing", () => {
  assert.deepEqual(unexplainedDeletions({ deletedPaths: [], branchTouchedPaths: new Set() }), []);
});

// --- mergeParents: only a real, two-parent merge has something to check ---

test("mergeParents: a two-parent commit returns both, in order", () => {
  const fakeGit = () => "aaa bbb";
  assert.deepEqual(mergeParents("sha", fakeGit), { p1: "aaa", p2: "bbb" });
});

test("mergeParents: an ordinary, single-parent commit returns null -- nothing to check", () => {
  const fakeGit = () => "aaa";
  assert.equal(mergeParents("sha", fakeGit), null);
});

test("mergeParents: a root commit (no parents) also returns null, not a crash", () => {
  const fakeGit = () => "";
  assert.equal(mergeParents("sha", fakeGit), null);
});

// --- deletedPaths: parses ONLY the D lines, never A/M/R ---

test("deletedPaths: reads D lines and strips the status prefix", () => {
  const fakeGit = () => "D\tone.ts\nM\ttwo.ts\nA\tthree.ts\nD\tfour.ts";
  assert.deepEqual(deletedPaths("p1", "merge", fakeGit), ["one.ts", "four.ts"]);
});

test("deletedPaths: no deletions at all is an empty list, not an error", () => {
  const fakeGit = () => "M\tone.ts\nA\ttwo.ts";
  assert.deepEqual(deletedPaths("p1", "merge", fakeGit), []);
});

// --- branchTouchedPaths: which of the deleted paths a real branch commit mentions ---

test("branchTouchedPaths: a path with a non-empty log is touched", () => {
  const fakeGit = () => "abc123 some commit";
  const result = branchTouchedPaths("p1", "p2", ["a.ts"], fakeGit);
  assert.deepEqual([...result], ["a.ts"]);
});

test("branchTouchedPaths: a path with an empty log is NOT touched", () => {
  const fakeGit = () => "";
  const result = branchTouchedPaths("p1", "p2", ["a.ts"], fakeGit);
  assert.deepEqual([...result], []);
});

// --- ACCEPTANCE: driven live against this repository's own two real fixtures ---

test("ACCEPTANCE (#411, criterion 2): the real incident (f2cdfaf3) is REFUSED, naming the six deleted "
  + "paths no branch commit ever touched", (t) => {
  if (!fixturePresent("f2cdfaf3")) return t.skip(NO_FIXTURE("f2cdfaf3"));
  let out;
  try {
    execFileSync("node", [SCRIPT, "--merge=f2cdfaf3"], { cwd: CLONE, encoding: "utf8", stdio: "pipe" });
    assert.fail("expected the guard to refuse and exit non-zero");
  } catch (cause) {
    const err = cause as { status?: number, stderr?: string };
    assert.equal(err.status, EXIT.REFUSE);
    out = err.stderr ?? "";
  }
  for (const p of [
    "packages/lab/src/gates/furniture-heading-guard.test.ts",
    "packages/lab/src/packaging/workspace-scope.test.ts",
    "scripts/prune-stale-workspace-scope.mjs",
    "docs/schema-migration-history.md",
    "packages/lab/src/packaging/schema-migration-citations.test.ts",
    ".changeset/smart-squids-matter.md",
  ]) {
    assert.ok(out.includes(p), `expected the refusal to name ${p}, got:\n${out}`);
  }
  // #655: naming the deleted paths is not a remedy on its own -- decideRevert deliberately never
  // auto-reverts a trunkGate-only failure (a question this merge's own two parents cannot answer by
  // re-running a suite), so a human must be told what to actually DO, not just what is wrong.
  assert.match(out, /git revert -m 1 f2cdfaf3/,
    `expected the refusal to name the exact recovery command, got:\n${out}`);
  assert.match(out, /not auto-reverted/i,
    `expected the refusal to say this is NOT handled automatically, got:\n${out}`);
});

test("ACCEPTANCE (#411, criterion 3): a legitimate deletion (#354, fc9b89d2) is NOT refused -- the half "
  + "that decides whether this survives a week", (t) => {
  if (!fixturePresent("fc9b89d2")) return t.skip(NO_FIXTURE("fc9b89d2"));
  const out = execFileSync("node", [SCRIPT, "--merge=fc9b89d2"], { cwd: CLONE, encoding: "utf8" });
  assert.match(out, /PASS/);
});

// --- the CLI, guarded like every other argv-reading script here ---

test("trunk-revert-guard.mjs refuses an unknown flag rather than silently ignoring it", () => {
  let threw = false;
  try {
    execFileSync("node", [SCRIPT, "--merge=abc", "--bogus"],
      { cwd: CLONE, encoding: "utf8", stdio: "pipe" });
  } catch (cause) {
    threw = true;
    const err = cause as { status?: number, stderr?: string };
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /unknown flag --bogus/);
  }
  assert.ok(threw);
});

test("trunk-revert-guard.mjs refuses to run without --merge", () => {
  let threw = false;
  try {
    execFileSync("node", [SCRIPT], { cwd: CLONE, encoding: "utf8", stdio: "pipe" });
  } catch (cause) {
    threw = true;
    const err = cause as { status?: number, stderr?: string };
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /need --merge/);
  }
  assert.ok(threw);
});

// --- the workflow wiring: an added STEP inside trunkGate, never a new job ---

test("trunk.yml runs trunk-revert-guard.mjs INSIDE trunkGate, not as a separate job", () => {
  const doc = parseYaml(readFileSync(`${REPO}/.github/workflows/trunk.yml`, "utf8")) as {
    jobs: Record<string, { steps: Array<Record<string, unknown>> }>,
  };
  const trunkGateRuns = (doc.jobs.trunkGate.steps ?? []).map((s) => String(s.run ?? "")).join("\n");
  assert.match(trunkGateRuns, /node scripts\/trunk-revert-guard\.mjs/,
    "the guard must run as a step inside trunkGate -- a refusal there is what makes decideRevert's own "
    + "`if: needs.trunkGate.result == 'failure'` fire and drive the EXISTING revert machinery. A separate "
    + "job would need its own revert wiring, which ceo's ruling says not to build.");
  assert.match(trunkGateRuns, /--merge=\$\{\{ github\.sha \}\}/,
    "it must check the commit THIS push actually landed, not an inferred or default ref.");
});

/**
 * C3 (#465): THE OTHER HALF OF THE WIRING -- a refusal here is worthless unless it actually FAILS the
 * `trunkGate` job (never `continue-on-error`) and `decideRevert` is gated on exactly that failure, never
 * on a broader condition. This is the seam neither `trunk-revert-guard.test.ts` (which only proves the
 * GUARD's own verdict) nor `trunk-revert.test.ts` (which only proves `revertVerdict`'s own logic in
 * isolation) has ever tested: nothing before this asserted that the two are actually CONNECTED in the
 * workflow, and "a revert is the most destructive action in the whole plan" (ceo, on this row) is exactly
 * why that connection needs its own guard rather than an inference from reading the YAML once.
 */
test("C3 ACCEPTANCE: trunk-revert-guard.mjs's step has no continue-on-error -- its failure must reach the job", () => {
  const doc = parseYaml(readFileSync(`${REPO}/.github/workflows/trunk.yml`, "utf8")) as {
    jobs: Record<string, { steps: Array<Record<string, unknown>> }>,
  };
  const guardStep = doc.jobs.trunkGate.steps.find((s) =>
    String(s.run ?? "").includes("trunk-revert-guard.mjs"));
  assert.ok(guardStep, "the step running the guard must exist");
  assert.equal(guardStep!["continue-on-error"], undefined,
    "continue-on-error on this step would make a REFUSE verdict invisible to decideRevert -- the exact "
    + "shape of a guard whose wrongness is absorbed by another mechanism (#188's own rule) applied to the "
    + "step level instead of the job level.");
});

test("C3 ACCEPTANCE: decideRevert fires on trunkGate's or trunkBuildTest's failure, and ONLY those", () => {
  // A1 (#452) split the original single `trunkGate` job in two: `trunkGate` (the revert-guard check
  // alone) and `trunkBuildTest` (a CALL to reusable-build-test.yml). Either can now be the real failure,
  // so decideRevert must watch both -- but `trunkBuildTest`'s own `needs: trunkGate` already means it
  // reads `skipped`, never `failure`, when trunkGate itself failed, so checking both here does not
  // double-fire on one real failure.
  const doc = parseYaml(readFileSync(`${REPO}/.github/workflows/trunk.yml`, "utf8")) as {
    jobs: Record<string, { needs?: string | string[], if?: string, uses?: string }>,
  };
  const decideRevert = doc.jobs.decideRevert;
  assert.ok(decideRevert, "decideRevert must exist as its own job");
  const needs = Array.isArray(decideRevert.needs) ? decideRevert.needs : [decideRevert.needs];
  assert.ok(needs.includes("trunkGate"),
    "decideRevert must declare trunkGate among its needs -- without it, GitHub cannot resolve "
    + "`needs.trunkGate.result` at all and the job would fail to even start, not skip quietly");
  assert.ok(needs.includes("trunkBuildTest"),
    "decideRevert must also declare trunkBuildTest among its needs -- the real build/test suite now runs "
    + "there, and a revert decision that cannot see its result would miss the exact failure #316 exists "
    + "to catch");
  assert.ok(doc.jobs.trunkBuildTest?.uses, "trunkBuildTest must call a reusable workflow, not carry its "
    + "own steps -- otherwise this test is checking a job that no longer exists in this shape");
  // `always() &&` IS REQUIRED, not decorative -- and this assertion itself pinned the WRONG condition
  // until dispatcher measured the consequence directly: an `if:` with no status-check function carries an
  // IMPLICIT `success()`, so `needs.trunkGate.result == 'failure'` alone means
  // `success() && needs.trunkGate.result == 'failure'` -- self-contradictory, since `success()` is false
  // exactly when a needed job failed. Measured on the real repo: 5 of the newest 40 trunk-guard runs had
  // `trunkGate=failure`, and `decideRevert` read `skipped` in every one -- this job had never fired.
  // `always()` LIFTS the implicit success without making the job unconditional: the explicit
  // `result == 'failure'` checks still exclude a green run, and `cancelled` (someone manually cancelled
  // the run) is still excluded too, because `always()` does not turn a cancellation into a failure.
  assert.equal(decideRevert.if,
    "always() && (needs.trunkGate.result == 'failure' || needs.trunkBuildTest.result == 'failure')",
    "must be EXACTLY this condition, `always()` prefix included -- without it the job's default implicit "
    + "`success()` makes the whole condition unsatisfiable whenever it should fire, which is the exact "
    + "defect measured on the real repo (0 of 5 real failures reached this job)");
});

/**
 * C3 ACCEPTANCE, COMPOSED: does the REAL f2cdfaf3 incident's guard verdict, fed through the EXISTING
 * revert decision with the facts that incident would plausibly have carried, actually come out READY
 * (revert)? Neither script's own test suite asks this: `trunk-revert-guard.test.ts` stops at "REFUSED,
 * naming six paths"; `trunk-revert.test.ts` drives `revertVerdict` only against synthetic facts. This is
 * the seam -- proving a REFUSE from the guard is not merely compatible with `revertVerdict`'s shape, but
 * genuinely produces a revert-worthy verdict once trunkGate's failure reaches it.
 */
test("C3 ACCEPTANCE, COMPOSED: the real f2cdfaf3 REFUSAL, once trunkGate fails on it, IS revert-worthy", (t) => {
  // #928: THIS TEST WAS THE FOURTH ONE, AND IT DID NOT FAIL IN THE INCIDENT -- IT PASSED.
  //
  // The three tests #928 names skipped correctly once #923 gave them `fixturePresent`. This one spawns the
  // same fixture and was left unguarded, and its assertion was `assert.throws` with no code: **that accepts
  // ANY non-zero exit.** Measured in a deliberately shallow checkout on 2026-09-12:
  //
  //     full history   --merge=f2cdfaf3  ->  exit 1   REFUSE
  //     full history   --merge=fc9b89d2  ->  exit 0   PASS
  //     depth 1        --merge=f2cdfaf3  ->  exit 2   CANNOT_ASK
  //
  // So on a shallow checkout this test PASSED, having asserted "the guard must still refuse f2cdfaf3, or
  // this composed test is asserting nothing real" against a run that refused nothing. **A green test that
  // examined a question it could not ask** is worse than the three red ones beside it, because nothing in
  // the log says so. Both halves are fixed: the fixture is guarded like its siblings, AND the exit code is
  // asserted as REFUSE rather than as merely non-zero -- the second half closes it in ANY checkout.
  if (!fixturePresent("f2cdfaf3")) return t.skip(NO_FIXTURE("f2cdfaf3"));
  // `assert.throws` returns undefined, so the error is caught by hand -- the exit CODE is the subject here
  // and `throws` alone cannot see it. That is the whole defect in one line.
  let status: number | undefined;
  try {
    execFileSync("node", [SCRIPT, "--merge=f2cdfaf3"], { cwd: CLONE, stdio: "pipe" });
  } catch (cause) {
    status = (cause as { status?: number }).status;
  }
  assert.equal(status, EXIT.REFUSE,
    `expected REFUSE (${EXIT.REFUSE}); PASS (${EXIT.PASS}) would mean the guard did not flag it and `
    + `CANNOT_ASK (${EXIT.CANNOT_ASK}) is an unanswerable question, not a refusal -- reading the second as `
    + "the first is how this test passed while its three siblings failed for 27.8 hours");

  // trunkGate failing on f2cdfaf3 means `decideRevert` runs with `--push-sha=f2cdfaf3` and
  // `--before-sha=f2cdfaf3^1`. The two facts `revertVerdict` needs are asked of the REAL commit graph and
  // GitHub, exactly as `trunk-revert.mjs`'s own `main()` would -- this is not a synthetic fixture.
  const composed = revertVerdict({
    // f2cdfaf3^1 is the commit main was at right before the incident landed -- long since superseded and
    // itself long since proven clean by every gate that has run since, so treating it as the "before" a
    // real trunkGate run would have recorded as `success` is the honest fact this incident's own history
    // establishes, not an assumption invented for the test.
    // #582: EVERY trigger job, not one of them. `trunkGate` alone was the defect -- a parent with
    // `trunkGate: success` and `trunkBuildTest: failure` read as green, and this fixture would have
    // asserted READY on the strength of half an answer.
    beforeConclusions: { trunkGate: "success", trunkBuildTest: "success" },
    // #616: the composed acceptance now needs the parent's failing check RE-RUN, not just its recorded
    // conclusion. `f2cdfaf3^1` has been proven clean by every gate that has run since, so a re-check of
    // it passing is the honest fact this incident's own history establishes -- the same reasoning the
    // comment above gives for treating its recorded conclusion as `success`, applied to the second
    // question. Without this the case reads CANNOT_ASK, which is correct behaviour and not this test's
    // subject.
    parentRecheck: "pass" as const,
    currentMainSha: "f2cdfaf3", // the case where main has NOT moved on since -- this push is still the tip
    pushSha: "f2cdfaf3",
  });
  assert.equal(composed.code, REVERT_EXIT.READY,
    `expected READY (revert-worthy), got code ${composed.code}: ${composed.reason}`);
});

test("C3 ACCEPTANCE, COMPOSED, POSITIVE CONTROL: an ordinary merge's PASS never even reaches decideRevert", (t) => {
  if (!fixturePresent("fc9b89d2")) return t.skip(NO_FIXTURE("fc9b89d2"));
  // fc9b89d2 (#354) is the guard's own documented legitimate-deletion case -- PASSES, so trunkGate's guard
  // step succeeds, the job does not fail on this step, and (assuming the rest of trunkGate is otherwise
  // green) `decideRevert`'s `if: needs.trunkGate.result == 'failure'` is false: it never runs at all. There
  // is no `revertVerdict` call to make in this branch, which is the point -- the positive control for a
  // destructive action is "nothing happens", not "a different, harmless verdict is computed".
  const out = execFileSync("node", [SCRIPT, "--merge=fc9b89d2"], { cwd: CLONE, encoding: "utf8", stdio: "pipe" });
  assert.match(out, /PASS/);
});

/**
 * THE FIX IS THE `cwd`, SO THE `cwd` IS PINNED.
 *
 * Every spawn in this file runs a script that calls `git fetch origin` unconditionally. Pointed at the
 * real checkout — which is what `cwd: REPO` did until #890 — that fetch writes remote-tracking refs in
 * the `.git` every worktree shares, so a suite run anywhere could collide with another worktree's fetch.
 * worker-audit found it from a real collision.
 *
 * Reverting one `cwd` is a one-line edit that changes nothing a type or a lint check can see, and the
 * tests pass either way — the clone has the same history. **So the only thing that can catch it is a
 * check on the text.** That is this file's own lesson from `browser-session.mjs`'s comment, applied to
 * this file: a comment saying "the position is the property" is worth nothing unless something reads it.
 */
test("#890 every spawn runs against the CLONE, never the real checkout", () => {
  // INCLUDING THE TWO FLAG-REFUSAL SPAWNS, which today exit before the fetch -- `refuseUnknownFlags` and
  // the missing-`--merge` check both run first. That is a fact about the script's current statement
  // ORDER, and this row exists because a statement's position is exactly the property nothing else
  // notices moving. A uniform `cwd` needs no such reasoning to stay correct.
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const spawns = [...src.matchAll(/execFileSync\(\s*"node",[^)]*?\{([^}]*)\}/gs)].map((m) => m[1]);
  assert.ok(spawns.length >= 4,
    `only ${spawns.length} node spawn(s) found; this file had four when the guard was written, and a `
    + "check that examines fewer than it should reports cleanly about a population it never walked");
  for (const options of spawns) {
    assert.match(options, /cwd:\s*CLONE\b/, `a spawn runs with ${options.trim()} rather than cwd: CLONE`);
    assert.doesNotMatch(options, /cwd:\s*REPO\b/,
      "cwd: REPO points at whichever checkout runs the suite, and this script FETCHES");
  }
});

test("#1040 ACCEPTANCE: an UNREADABLE clone is reported as unreadable, never as a shallow checkout", () => {
  // The skip line used to state `(shallow clone)` as the cause, and `cat-file -e` cannot support it.
  // Measured against this repository: a missing object is 128 and a directory that is not a repository is
  // ALSO 128, so no status separates them and #1023's exit-code remedy does not transfer.
  //
  // Driven over a real directory rather than by stubbing git, for the reason this file already gives: a
  // hand-written stub of git is a second copy of the predicate wearing git's name.
  const notARepo = realpathSync(mkdtempSync(join(tmpdir(), "a11y-not-a-repo-")));
  try {
    const readable = (cwd: string) => {
      try {
        execFileSync("git", ["cat-file", "-e", "HEAD^{commit}"], { cwd, stdio: "pipe", env: sandboxGitEnv() });
        return true;
      } catch { return false; }
    };
    assert.equal(readable(notARepo), false, "a directory that is not a repository must not read as readable");
    assert.equal(readable(CLONE), true, "AND the real clone must -- or this control proves only that git errors");

    // The two 128s, side by side. This is the measurement the old skip line asserted without making.
    const status = (args: string[], cwd: string) => {
      try {
        execFileSync("git", args, { cwd, stdio: "pipe", env: sandboxGitEnv() });
        return 0;
      } catch (cause) { return (cause as { status?: number }).status; }
    };
    assert.equal(status(["cat-file", "-e", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef^{commit}"], CLONE), 128,
      "a missing OBJECT in a real repository");
    assert.equal(status(["cat-file", "-e", "HEAD^{commit}"], notARepo), 128,
      "and an unreadable REPOSITORY -- the same code, which is why a positive control is the only separator");
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }
});

test("#1040 ACCEPTANCE: against an UNREADABLE clone, fixturePresent says absent and the LINE says why -- "
  + "driven through the shipped functions, not through a copy of them", () => {
  const notARepo = realpathSync(mkdtempSync(join(tmpdir(), "a11y-not-a-repo-")));
  try {
    assert.equal(fixturePresent("f2cdfaf3", notARepo), false,
      "it cannot claim the fixture is present, and it must not throw either");
    const line = NO_FIXTURE("f2cdfaf3", notARepo);
    assert.match(line, /could not be read at all/);
    assert.match(line, /deepening will not fix it/,
      "the remedy, which is the whole point -- `(shallow clone)` sends a reader to deepen a checkout that "
      + "is not the problem");
    assert.doesNotMatch(line, /shallow clone/, "and NOT the other cause");
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }
});

test("#1040: the skip line names the cause it actually established", () => {
  // `CLONE` is readable here, so the line may say `(shallow clone)`. The other branch is exercised by the
  // control above, which proves the predicate it depends on rather than the string it produces.
  const line = NO_FIXTURE("f2cdfaf3");
  assert.match(line, /shallow clone/);
  assert.doesNotMatch(line, /could not be read at all/,
    "and only one of the two -- a line offering both causes is a line that established neither");
});
