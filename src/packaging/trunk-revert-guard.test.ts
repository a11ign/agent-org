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
