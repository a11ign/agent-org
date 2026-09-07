/**
 * `scripts/stranded-branches.mjs` finds a pushed branch that has NEVER had a PR of any state and still
 * carries commits `origin/main` lacks -- see that file's own header for the incident
 * (`agent/ssh-key-defaults`, a finished security fix, pushed and invisible for eleven hours) and why the
 * obvious `git rev-list --count` check is defeated by squash merges on the wider population.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFileSync as rawExecFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchPushedBranches, fetchAllPRHeadRefs, branchesWithNoPR, aheadCount, strandedCandidates,
} from "../../../../scripts/stranded-branches.mjs";
import { sandboxGitEnv } from "../../../../scripts/git-env.mjs";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: sandboxGitEnv(), encoding: "utf8" });

/**
 * A disposable repo with THREE remote-tracking branches: `agent/no-pr-stranded` (genuinely ahead of main,
 * the shape this tool must catch), `agent/no-pr-empty` (no PR either, but ZERO commits ahead -- not a
 * candidate), and `agent/squash-merged` (represents a branch this repo's own `gh pr list` would report a
 * PR for -- the caller supplies that via the mocked `run`, not from this fixture, since PR state lives on
 * GitHub, not in git).
 */
function buildFixtureRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a11y-stranded-fixture-")));
  git(root, "init", "--quiet", "-b", "main");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "Fixture");
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, "add", "base.txt");
  git(root, "commit", "-q", "-m", "base");
  const baseSha = git(root, "rev-parse", "HEAD").trim();

  // Simulate a REMOTE by making a bare clone and adding it as `origin` -- `for-each-ref
  // refs/remotes/origin/*` needs a real remote-tracking namespace, which a purely-local repo does not have.
  const bareRoot = realpathSync(mkdtempSync(join(tmpdir(), "a11y-stranded-bare-")));
  git(bareRoot, "init", "--quiet", "--bare", "-b", "main");
  git(root, "remote", "add", "origin", bareRoot);
  git(root, "push", "-q", "origin", "main");

  const strandedBranch = "agent/no-pr-stranded";
  git(root, "checkout", "-q", "-b", strandedBranch, baseSha);
  writeFileSync(join(root, "stranded.txt"), "genuinely stranded work\n");
  git(root, "add", "stranded.txt");
  git(root, "commit", "-q", "-m", "work nobody proposed");
  git(root, "push", "-q", "origin", strandedBranch);

  const emptyBranch = "agent/no-pr-empty";
  git(root, "checkout", "-q", "-b", emptyBranch, baseSha);
  git(root, "push", "-q", "origin", emptyBranch); // pushed, no PR, but tip === main's tip

  const squashBranch = "agent/squash-merged";
  git(root, "checkout", "-q", "-b", squashBranch, baseSha);
  writeFileSync(join(root, "squashed.txt"), "landed via a real PR, squash-merged\n");
  git(root, "add", "squashed.txt");
  git(root, "commit", "-q", "-m", "will get a PR in the mocked run()");
  git(root, "push", "-q", "origin", squashBranch);

  git(root, "checkout", "-q", "main");
  git(root, "fetch", "-q", "origin");
  return { root, bareRoot, strandedBranch, emptyBranch, squashBranch };
}

function cleanup(root: string, bareRoot: string) {
  rmSync(root, { recursive: true, force: true });
  rmSync(bareRoot, { recursive: true, force: true });
}

// --- fetchPushedBranches: real git, real remote-tracking refs ---

test("fetchPushedBranches lists agent/* and lead/* branches, origin/ prefix stripped, main excluded", () => {
  const { root, bareRoot, strandedBranch, emptyBranch, squashBranch } = buildFixtureRepo();
  try {
    const run = (cmd: string, args: string[]) => rawExecFileSync(cmd, args, { cwd: root, env: sandboxGitEnv(), encoding: "utf8" });
    const branches = fetchPushedBranches({ run });
    assert.deepEqual(branches.sort(), [emptyBranch, squashBranch, strandedBranch].sort());
    assert.ok(!branches.includes("main"), "main itself must never be reported as a pushed feature branch");
  } finally { cleanup(root, bareRoot); }
});

test("MUTATION: git itself failing is a thrown error, never an empty (= nothing-pushed-reading) list", () => {
  const run = () => { throw new Error("git: not a repository"); };
  assert.throws(() => fetchPushedBranches({ run }), /could not list pushed branches/);
});

// --- fetchAllPRHeadRefs: the vacuity guard, mirroring fetchLabels/fetchOpenIssues exactly ---

function jsonRun(response: string) {
  return () => response;
}
function throwingRun(message: string) {
  return () => { throw new Error(message); };
}

test("fetchAllPRHeadRefs parses a well-formed gh response into a Set", () => {
  const run = jsonRun(JSON.stringify([{ headRefName: "agent/x" }, { headRefName: "lead/y" }]));
  const refs = fetchAllPRHeadRefs({ run });
  assert.ok(refs.has("agent/x"));
  assert.ok(refs.has("lead/y"));
  assert.equal(refs.size, 2);
});

test("MUTATION: gh itself failing is a thrown error, never an empty Set -- that would OVER-report every pushed branch as stranded", () => {
  const run = throwingRun("gh: authentication required");
  assert.throws(() => fetchAllPRHeadRefs({ run }), /could not list PRs/);
});

test("MUTATION: non-JSON output is a thrown error, never a silent empty Set", () => {
  const run = jsonRun("not json at all");
  assert.throws(() => fetchAllPRHeadRefs({ run }), /was not JSON/);
});

test("MUTATION: a non-array response is refused rather than read as zero PRs", () => {
  const run = jsonRun(JSON.stringify({ not: "an array" }));
  assert.throws(() => fetchAllPRHeadRefs({ run }), /was not an array/);
});

test("MUTATION: a PR entry missing headRefName is refused, not silently skipped", () => {
  const run = jsonRun(JSON.stringify([{ number: 1 }]));
  assert.throws(() => fetchAllPRHeadRefs({ run }), /entry 0 has no headRefName/);
});

test("CONTROL: genuinely zero PRs anywhere is accepted as a real, empty Set", () => {
  const run = jsonRun(JSON.stringify([]));
  assert.equal(fetchAllPRHeadRefs({ run }).size, 0);
});

// --- branchesWithNoPR: pure ---

test("branchesWithNoPR keeps only branches absent from the PR head-ref set", () => {
  const pushed = ["agent/a", "agent/b", "lead/c"];
  const prHeadRefs = new Set(["agent/a"]);
  assert.deepEqual(branchesWithNoPR(pushed, prHeadRefs), ["agent/b", "lead/c"]);
});

test("branchesWithNoPR: a branch with ANY PR state (open, closed, merged) is excluded -- the caller decides which states go into the Set, this function only subtracts", () => {
  const pushed = ["agent/squash-merged"];
  const prHeadRefs = new Set(["agent/squash-merged"]); // caller already included closed/merged PRs
  assert.deepEqual(branchesWithNoPR(pushed, prHeadRefs), []);
});

// --- aheadCount: real git, and this is where the squash-merge trap would resurface if misused ---

test("aheadCount reads real commits ahead of main for a genuinely stranded branch", () => {
  const { root, bareRoot, strandedBranch } = buildFixtureRepo();
  try {
    const run = (cmd: string, args: string[]) => rawExecFileSync(cmd, args, { cwd: root, env: sandboxGitEnv(), encoding: "utf8" });
    assert.equal(aheadCount(strandedBranch, { run }), 1);
  } finally { cleanup(root, bareRoot); }
});

test("aheadCount reads ZERO for a pushed branch whose tip already equals main's", () => {
  const { root, bareRoot, emptyBranch } = buildFixtureRepo();
  try {
    const run = (cmd: string, args: string[]) => rawExecFileSync(cmd, args, { cwd: root, env: sandboxGitEnv(), encoding: "utf8" });
    assert.equal(aheadCount(emptyBranch, { run }), 0);
  } finally { cleanup(root, bareRoot); }
});

test("MUTATION: aheadCount throws rather than guessing when git cannot answer", () => {
  const run = () => { throw new Error("git: unknown revision"); };
  assert.throws(() => aheadCount("agent/does-not-exist", { run }), /could not compute how far/);
});

// --- strandedCandidates: pure, stage 2 of the filter ---

test("strandedCandidates keeps only branches with a POSITIVE ahead-count", () => {
  const noPR = ["agent/stranded", "agent/empty"];
  const counts = new Map([["agent/stranded", 3], ["agent/empty", 0]]);
  assert.deepEqual(strandedCandidates(noPR, counts), [{ branch: "agent/stranded", aheadCount: 3 }]);
});

test("strandedCandidates treats a missing map entry as zero, not as a crash", () => {
  const noPR = ["agent/never-looked-up"];
  const counts = new Map();
  assert.deepEqual(strandedCandidates(noPR, counts), []);
});

// --- THE SQUASH-MERGE TRAP, end to end: the exact defeat this file's header describes ---

test("THE TWO-STAGE FILTER: a squash-merged branch is excluded by stage 1, before stage 2's rev-list-count would have wrongly flagged it", () => {
  const { root, bareRoot, strandedBranch, emptyBranch, squashBranch } = buildFixtureRepo();
  try {
    const run = (cmd: string, args: string[]) => rawExecFileSync(cmd, args, { cwd: root, env: sandboxGitEnv(), encoding: "utf8" });
    const pushed = fetchPushedBranches({ run });
    // The squash-merged branch DID have a PR (closed, in this shape) -- supplied here exactly as
    // fetchAllPRHeadRefs would report it from a real `gh pr list --state all`.
    const prHeadRefs = new Set([squashBranch]);
    const noPR = branchesWithNoPR(pushed, prHeadRefs);
    assert.ok(!noPR.includes(squashBranch), "a branch with a PR of ANY state must never reach stage 2");
    assert.ok(noPR.includes(strandedBranch));
    assert.ok(noPR.includes(emptyBranch));

    const counts = new Map(noPR.map((b) => [b, aheadCount(b, { run })]));
    const candidates = strandedCandidates(noPR, counts);
    assert.deepEqual(candidates.map((c) => c.branch), [strandedBranch],
      "the empty-tip branch and the squash-merged branch must both be absent -- only genuinely ahead, PR-less work is a candidate");
  } finally { cleanup(root, bareRoot); }
});

// --- Live, read-only smoke test against the real repo and the real CLI ---

test("the real CLI runs against the real repo and exits with one of its own three documented codes", () => {
  const scriptPath = new URL("../../../../scripts/stranded-branches.mjs", import.meta.url).pathname;
  let exitCode = 0;
  try {
    execFileSync("node", [scriptPath], { encoding: "utf8" });
  } catch (error) {
    exitCode = (error as { status?: number }).status ?? -1;
  }
  assert.ok([0, 1, 2].includes(exitCode),
    `expected exit 0 (OK), 1 (candidates found) or 2 (could not ask); got ${exitCode}`);
});
