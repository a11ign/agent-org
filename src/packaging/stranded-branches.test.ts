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
  fetchPushedBranches, fetchAllPRHeadRefs, branchesWithNoPR, aheadCount, strandedCandidates, PR_LIST_LIMIT, decideForPR, staleClosureComment, sweepPullRequests, prForDecision } from "../../../../scripts/stranded-branches.mjs";
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

/**
 * #321: `gh pr list` is NEWEST-first, so a response that arrives at exactly `PR_LIST_LIMIT` cannot be
 * told apart from "there are more, and the oldest ones just fell off the end" -- and the oldest branches
 * are precisely the ones stage 1 of this file's own filter ("has this branch EVER had a PR") most needs
 * to be right about. A silent truncation there does not make the tool miss a stranded branch, it makes
 * the tool MANUFACTURE one.
 */
test("MUTATION (#321): a response landing EXACTLY at the configured limit is refused, not read as 'a lot of PRs'", () => {
  const atCap = Array.from({ length: PR_LIST_LIMIT }, (_, i) => ({ headRefName: `agent/x${i}` }));
  const run = jsonRun(JSON.stringify(atCap));
  assert.throws(() => fetchAllPRHeadRefs({ run }), /exactly \d+ PRs.*cannot tell whether/s);
});

test("CONTROL: one PR short of the limit is a real, trustworthy count -- the guard must not fire early", () => {
  const almost = Array.from({ length: PR_LIST_LIMIT - 1 }, (_, i) => ({ headRefName: `agent/x${i}` }));
  const run = jsonRun(JSON.stringify(almost));
  assert.equal(fetchAllPRHeadRefs({ run }).size, PR_LIST_LIMIT - 1);
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

/**
 * A PULL REQUEST LIVES FOUR HOURS — B1, and what it REFUSES to close is the substance.
 *
 * Closing a PR is the most destructive action in this toolset, so the tests below are weighted the way
 * the risk is: one for the action, four for the refusals. p90 to merge is 2.5 h and the median is 12
 * minutes; the two PRs closed by hand at 02:00Z had been open ~25 hours at 373 and 392 commits behind,
 * and neither was ever going to merge.
 *
 * **`update-branch` changed what "old" means**, and without that the threshold reads as aggressive: PRs no
 * longer drift unattended, so an old PR is one that is genuinely ABANDONED rather than merely stale.
 */
test("THE BOUNDARY: 3h59m is spared and 4h01m is closed — the row's own mutation", () => {
  const spared = decideForPR({ number: 1, ageHours: 3 + 59 / 60 }, { maxAgeHours: 4 });
  const closed = decideForPR({ number: 2, ageHours: 4 + 1 / 60 }, { maxAgeHours: 4 });
  assert.equal(spared.action, "keep");
  assert.equal(closed.action, "close");
  // The rendering matters AT the boundary, which is exactly where somebody checks whether the sweep was
  // right. `toFixed(1)` rendered both as "4.0h", so a spared PR read "4.0h old, under the 4h line" — a
  // number contradicting its own sentence in the one place it would be read closely.
  assert.match(spared.why, /3h59m/);
  assert.match(closed.why, /4h01m/);
});

test("A DRAFT IS NEVER CLOSED BY THE CLOCK — it was never offered for merge", () => {
  const d = decideForPR({ number: 3, ageHours: 30, isDraft: true }, { maxAgeHours: 4 });
  assert.equal(d.action, "keep");
  assert.match(d.why, /draft/);
});

test("`blocked` OUTRANKS THE CLOCK — a person refused it, and a sweep does not overrule a person", () => {
  const d = decideForPR({ number: 4, ageHours: 30, labels: ["blocked"] }, { maxAgeHours: 4 });
  assert.equal(d.action, "keep", "the auto-arm sweep already skips `blocked` for this reason; a sweep "
    + "that closes must honour it at least as strictly as one that merely arms");
});

test("GREEN AND BEHIND IS THE TRAIN'S, waiting its turn — B3's interaction, decided here", () => {
  // #460 asks for this to be settled in the row rather than discovered at 4h01m. While syncing is
  // serialised a PR can legitimately wait hours through no fault of its own, and closing it would punish
  // it for the queue's latency. B3 is temporary; this rule is not.
  const queued = decideForPR({ number: 5, ageHours: 9, checksGreen: true, behind: 12 }, { maxAgeHours: 4 });
  assert.equal(queued.action, "keep");
  assert.match(queued.why, /waiting its turn/);
  // But RED and behind is not waiting on the train — the train skips red PRs, so nothing is coming for it.
  const abandoned = decideForPR({ number: 6, ageHours: 9, checksGreen: false, behind: 12 }, { maxAgeHours: 4 });
  assert.equal(abandoned.action, "close");
});

test("THE CLOSURE COMMENT SAYS STALE, NAMES THE BRANCH, AND SAYS IT IS KEPT", () => {
  // A sweep that closed AND deleted would have destroyed #172's work, which turned out to be sound and
  // was re-derived from the branch in an hour. "Stale" and "rejected" need different words because the
  // recoveries are opposite: rebuild this, versus do not.
  const comment = staleClosureComment({ number: 7, headRefName: "agent/example-row" }, "9h00m old");
  assert.match(comment, /STALE by the lifetime sweep, not rejected/);
  assert.match(comment, /agent\/example-row/, "the comment must name the branch somebody has to rebuild from");
  assert.match(comment, /is kept/);
  assert.doesNotMatch(comment, /reject(ed|ing) (this|the) work/i);
});

test("THE SWEEP IS DRY BY DEFAULT — closing is a thing somebody types", () => {
  // `corpus-prune-orphans.mjs` (#195) set this shape and it matters more here: a scheduled job that
  // forgot a flag must not close pull requests. Without `--close` this names what it WOULD close and
  // touches nothing.
  const calls: string[][] = [];
  const run = (_cmd: string, args: string[]) => {
    calls.push(args);
    return JSON.stringify([{ number: 9, headRefName: "agent/old", createdAt: "2026-09-08T00:00:00Z",
      isDraft: false, labels: [], mergeStateStatus: "DIRTY" }]);
  };
  const closing = sweepPullRequests({ now: new Date("2026-09-08T10:00:00Z"), run });
  assert.equal(closing.length, 1, "a 10h-old PR nothing is waiting on is past the line");
  assert.equal(calls.length, 1, "dry by default: one `gh pr list`, and no close and no comment");
  assert.ok(!calls.some((a) => a.includes("close")), "nothing may be closed without --close");
});

test("WITH --close IT COMMENTS FIRST, CLOSES SECOND, AND NEVER DELETES THE BRANCH", () => {
  const calls: string[][] = [];
  const run = (_cmd: string, args: string[]) => {
    calls.push(args);
    return JSON.stringify([{ number: 9, headRefName: "agent/old", createdAt: "2026-09-08T00:00:00Z",
      isDraft: false, labels: [], mergeStateStatus: "DIRTY" }]);
  };
  sweepPullRequests({ now: new Date("2026-09-08T10:00:00Z"), close: true, run });
  const verbs = calls.map((a) => a[1]);
  assert.deepEqual(verbs, ["list", "comment", "close"],
    "the comment must land BEFORE the close, or a reader finds a closed PR with no explanation");
  // THE SAFETY PROPERTY IS AN ABSENT FLAG, which is invisible in review unless something asserts it.
  // #172's branch was kept and its work re-derived from it; a sweep that deleted would have destroyed it.
  assert.ok(!calls.some((a) => a.includes("--delete-branch")),
    "the branch must survive: `gh pr close` without --delete-branch is the whole safety property");
});

test("checksGreen is NOT read from statusCheckRollup — that field unions superseded runs", () => {
  // Measured tonight: the rollup reported three PRs as failing whose latest run had succeeded, and two
  // sessions read them as red (#450). A sweep that CLOSES on a wrong red is the worst consumer of it.
  const now = new Date("2026-09-08T10:00:00Z");
  const behind = prForDecision({ number: 1, headRefName: "b", createdAt: "2026-09-08T00:00:00Z",
    isDraft: false, labels: [], mergeStateStatus: "BEHIND" }, now);
  assert.equal(behind.checksGreen, true);
  assert.equal(decideForPR(behind, { maxAgeHours: 4 }).action, "keep");
  const dirty = prForDecision({ number: 2, headRefName: "d", createdAt: "2026-09-08T00:00:00Z",
    isDraft: false, labels: [], mergeStateStatus: "DIRTY" }, now);
  assert.equal(dirty.checksGreen, false, "DIRTY is the PR's own problem; the train will not touch it");
});
