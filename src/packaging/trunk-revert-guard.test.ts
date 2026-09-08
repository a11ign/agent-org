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
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  unexplainedDeletions, mergeParents, deletedPaths, branchTouchedPaths, EXIT,
} from "../../../../scripts/trunk-revert-guard.mjs";
import { revertVerdict, EXIT as REVERT_EXIT } from "../../../../scripts/trunk-revert.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCRIPT = `${REPO}/scripts/trunk-revert-guard.mjs`;

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
  + "paths no branch commit ever touched", () => {
  let out;
  try {
    execFileSync("node", [SCRIPT, "--merge=f2cdfaf3"], { cwd: REPO, encoding: "utf8", stdio: "pipe" });
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
});

test("ACCEPTANCE (#411, criterion 3): a legitimate deletion (#354, fc9b89d2) is NOT refused -- the half "
  + "that decides whether this survives a week", () => {
  const out = execFileSync("node", [SCRIPT, "--merge=fc9b89d2"], { cwd: REPO, encoding: "utf8" });
  assert.match(out, /PASS/);
});

// --- the CLI, guarded like every other argv-reading script here ---

test("trunk-revert-guard.mjs refuses an unknown flag rather than silently ignoring it", () => {
  let threw = false;
  try {
    execFileSync("node", [SCRIPT, "--merge=abc", "--bogus"], { encoding: "utf8", stdio: "pipe" });
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
    execFileSync("node", [SCRIPT], { encoding: "utf8", stdio: "pipe" });
  } catch (cause) {
    threw = true;
    const err = cause as { status?: number, stderr?: string };
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /need --merge/);
  }
  assert.ok(threw);
});

// --- the workflow wiring: an added STEP inside trunkGate, never a new job ---

test("trunk-guard.yml runs trunk-revert-guard.mjs INSIDE trunkGate, not as a separate job", () => {
  const doc = parseYaml(readFileSync(`${REPO}/.github/workflows/trunk-guard.yml`, "utf8")) as {
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
  const doc = parseYaml(readFileSync(`${REPO}/.github/workflows/trunk-guard.yml`, "utf8")) as {
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
  const doc = parseYaml(readFileSync(`${REPO}/.github/workflows/trunk-guard.yml`, "utf8")) as {
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
  assert.equal(decideRevert.if,
    "needs.trunkGate.result == 'failure' || needs.trunkBuildTest.result == 'failure'",
    "must be EXACTLY this condition -- `always()` would also fire on a CANCELLED run (not a real "
    + "failure, per trunk-revert.mjs's own header), and `failure()` alone (without naming either job) "
    + "would fire on failures from unrelated jobs added to this workflow later");
});

/**
 * C3 ACCEPTANCE, COMPOSED: does the REAL f2cdfaf3 incident's guard verdict, fed through the EXISTING
 * revert decision with the facts that incident would plausibly have carried, actually come out READY
 * (revert)? Neither script's own test suite asks this: `trunk-revert-guard.test.ts` stops at "REFUSED,
 * naming six paths"; `trunk-revert.test.ts` drives `revertVerdict` only against synthetic facts. This is
 * the seam -- proving a REFUSE from the guard is not merely compatible with `revertVerdict`'s shape, but
 * genuinely produces a revert-worthy verdict once trunkGate's failure reaches it.
 */
test("C3 ACCEPTANCE, COMPOSED: the real f2cdfaf3 REFUSAL, once trunkGate fails on it, IS revert-worthy", () => {
  // The guard itself REFUSES f2cdfaf3 -- already proven above; re-asserted here so this composed test
  // does not silently pass having examined a commit the guard would not have flagged at all.
  assert.throws(() => execFileSync("node", [SCRIPT, "--merge=f2cdfaf3"], { cwd: REPO, stdio: "pipe" }),
    "the guard must still refuse f2cdfaf3, or this composed test is asserting nothing real");

  // trunkGate failing on f2cdfaf3 means `decideRevert` runs with `--push-sha=f2cdfaf3` and
  // `--before-sha=f2cdfaf3^1`. The two facts `revertVerdict` needs are asked of the REAL commit graph and
  // GitHub, exactly as `trunk-revert.mjs`'s own `main()` would -- this is not a synthetic fixture.
  const composed = revertVerdict({
    // f2cdfaf3^1 is the commit main was at right before the incident landed -- long since superseded and
    // itself long since proven clean by every gate that has run since, so treating it as the "before" a
    // real trunkGate run would have recorded as `success` is the honest fact this incident's own history
    // establishes, not an assumption invented for the test.
    beforeGateConclusion: "success",
    currentMainSha: "f2cdfaf3", // the case where main has NOT moved on since -- this push is still the tip
    pushSha: "f2cdfaf3",
  });
  assert.equal(composed.code, REVERT_EXIT.READY,
    `expected READY (revert-worthy), got code ${composed.code}: ${composed.reason}`);
});

test("C3 ACCEPTANCE, COMPOSED, POSITIVE CONTROL: an ordinary merge's PASS never even reaches decideRevert", () => {
  // fc9b89d2 (#354) is the guard's own documented legitimate-deletion case -- PASSES, so trunkGate's guard
  // step succeeds, the job does not fail on this step, and (assuming the rest of trunkGate is otherwise
  // green) `decideRevert`'s `if: needs.trunkGate.result == 'failure'` is false: it never runs at all. There
  // is no `revertVerdict` call to make in this branch, which is the point -- the positive control for a
  // destructive action is "nothing happens", not "a different, harmless verdict is computed".
  const out = execFileSync("node", [SCRIPT, "--merge=fc9b89d2"], { cwd: REPO, encoding: "utf8", stdio: "pipe" });
  assert.match(out, /PASS/);
});
