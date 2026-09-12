// no-token: gh -- every command here is `git`, in a throwaway repository this test creates and deletes.
// Nothing reaches GitHub, and nothing reads this repository's own object database except the two
// derivation tests at the bottom, which only READ the checkout's source files.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { staleRuleReason, ruleFiles, rulePathspec }
  from "../../../../scripts/row-claim/stale-rule-guard.mjs";
import { sandboxGitEnv } from "../../../../scripts/git-env.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * A REAL GIT REPOSITORY, not a stubbed `run`. The thing under test is a claim about what `git rev-list`
 * and `git diff` say over a pathspec, and a hand-written stub of git is a second copy of the predicate
 * wearing git's name -- it would agree with whatever I believed while writing it. `-c user.name=` is
 * per-invocation: a CI runner has no global identity and `commit` refuses without one.
 */
function syntheticRepo(): { root: string; commit: (path: string, text: string) => string } {
  const root = mkdtempSync(join(tmpdir(), "a11y-stale-rule-"));
  const env = sandboxGitEnv();
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "user.name=stale-rule-fixture", "-c", "user.email=fixture@example.invalid",
      ...args], { cwd: root, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "--quiet", "-b", "main"]);
  const commit = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
    git(["add", path]);
    git(["commit", "--quiet", "-m", `touch ${path}`]);
    return git(["rev-parse", "HEAD"]);
  };
  return { root, commit };
}

const setRef = (root: string, ref: string, sha: string) =>
  execFileSync("git", ["update-ref", ref, sha], { cwd: root, env: sandboxGitEnv(), stdio: "pipe" });
const detach = (root: string, sha: string) =>
  execFileSync("git", ["checkout", "--quiet", "--detach", sha], { cwd: root, env: sandboxGitEnv(), stdio: "pipe" });

/** The pathspec the real guard uses, spelled for the fixture rather than derived from it. */
const SPEC = ["scripts/row-claim.mjs", "scripts/row-claim/"];

test("#1014: a checkout BEHIND on a rule file refuses, naming the count and the file that moved", () => {
  const { root, commit } = syntheticRepo();
  try {
    const base = commit("scripts/row-claim/own-pr-health-rule.mjs", "export const inBuildReason = () => null;\n");
    setRef(root, "refs/remotes/origin/main", base);
    detach(root, base);
    const moved = commit("scripts/row-claim/own-pr-health-rule.mjs", "export const inBuildReason = () => 'B2';\n");
    setRef(root, "refs/remotes/origin/main", moved);
    detach(root, base); // the checkout sits where it was; origin/main has moved on

    const reason = staleRuleReason({ repoRoot: root, files: SPEC });
    assert.ok(reason, "a checkout holding a superseded rule must not produce a verdict at all");
    assert.match(reason, /1 COMMIT\(S\) BEHIND/, "the COUNT, so the reader knows how far behind they are");
    assert.match(reason, /scripts\/row-claim\/own-pr-health-rule\.mjs/,
      "and the FILE, because a refusal naming only a number is not followable -- the reader cannot tell "
      + "whether the rule they are being refused by is the one that moved");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#1014: a checkout behind on UNRELATED files answers normally -- this is not a staleness refusal", () => {
  const { root, commit } = syntheticRepo();
  try {
    const base = commit("scripts/row-claim.mjs", "export const claim = () => null;\n");
    setRef(root, "refs/remotes/origin/main", base);
    const ahead = commit("docs/operational-lessons.md", "a paragraph nobody's verdict is computed from\n");
    setRef(root, "refs/remotes/origin/main", ahead);
    detach(root, base);

    assert.equal(staleRuleReason({ repoRoot: root, files: SPEC }), null,
      "a worktree cut before the last docs commit still holds the CURRENT rule, and refusing there would "
      + "make the tool unusable in every checkout that is not seconds old");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#1014: a checkout LEVEL with origin/main answers normally", () => {
  const { root, commit } = syntheticRepo();
  try {
    const base = commit("scripts/row-claim.mjs", "export const claim = () => null;\n");
    setRef(root, "refs/remotes/origin/main", base);
    detach(root, base);
    assert.equal(staleRuleReason({ repoRoot: root, files: SPEC }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#1014: NO origin/main is CANNOT ASK, never 'up to date' -- the answer this repo most often conflates",
  () => {
    const { root, commit } = syntheticRepo();
    try {
      const base = commit("scripts/row-claim.mjs", "export const claim = () => null;\n");
      detach(root, base); // no refs/remotes/origin/main at all

      const reason = staleRuleReason({ repoRoot: root, files: SPEC });
      assert.ok(reason, "a checkout that cannot compare must say so rather than assume the happy answer");
      assert.match(reason, /CANNOT ASK/);
      assert.doesNotMatch(reason, /COMMIT\(S\) BEHIND/,
        "and it must not invent a count -- 'could not ask' and 'behind by N' are different reports");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

test("#1014: MUTATION TARGET -- comparing the checkout against ITSELF must stop refusing the stale case",
  () => {
    const { root, commit } = syntheticRepo();
    try {
      const base = commit("scripts/row-claim/runner-rule.mjs", "export const runnerReason = () => null;\n");
      setRef(root, "refs/remotes/origin/main", base);
      const moved = commit("scripts/row-claim/runner-rule.mjs", "export const runnerReason = () => 'no';\n");
      setRef(root, "refs/remotes/origin/main", moved);
      detach(root, base);

      // The mutation the row declares: swap `HEAD..origin/main` for a range that cannot see a difference.
      // Driven here as an INJECTED `run` so the mutation is expressed rather than described -- if this
      // assertion did not hold, a guard comparing HEAD to HEAD would pass every test above.
      const blind = (args: string[]) => execFileSync("git",
        args.map((a) => (a === "HEAD..origin/main" ? "HEAD..HEAD" : a === "origin/main" ? "HEAD" : a)),
        { cwd: root, encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] });
      assert.equal(staleRuleReason({ repoRoot: root, files: SPEC, run: blind }), null,
        "a comparison that cannot see a difference reports none -- which is why the real range is the "
        + "subject of this row and not an implementation detail");
      assert.ok(staleRuleReason({ repoRoot: root, files: SPEC }),
        "and the SAME fixture through the real range refuses, so the two are telling different stories "
        + "about the same tree rather than agreeing for the wrong reason");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

// --- the file list: derived from THIS repository, and what happens when the derivation fails ---

test("#1014: the rule-file list is DERIVED from row-claim's own import closure, not typed", () => {
  const derived = ruleFiles(resolve(REPO, "scripts/row-claim.mjs"), REPO);
  assert.ok(derived.includes("scripts/row-claim.mjs"), "the entry itself");
  assert.ok(derived.includes("scripts/row-claim/own-pr-health-rule.mjs"),
    "and the module whose replacement by #989/#1012 produced half the refusal this row was filed for");
  assert.ok(derived.length >= 5,
    `expected the rule modules beside row-claim.mjs, got ${derived.length}: ${derived.join(", ")}`);
  assert.ok(derived.every((f) => f === "scripts/row-claim.mjs" || f.startsWith("scripts/row-claim/")),
    "and NOTHING else -- the closure reaches merge-guard.mjs and board-snapshot.mjs, real dependencies of "
    + "the TOOL whose movement says nothing about whether the RULE changed. Folding those in would make "
    + "this the blanket staleness refusal the row rules out");
});

test("#1014: a BLINDED closure walker still refuses -- the one tree this guard is for is the one whose "
  + "walker cannot be trusted", () => {
  // Not hypothetical. Measured 2026-09-12 in a worktree at `6dee44a4`, a main from before #1019 fixed
  // `stripComments`: `localImports("scripts/row-claim.mjs")` returned 0 there, so the derivation produced
  // ONLY the entry and five rule modules were invisible. The error runs toward NOT refusing, which is this
  // row's own defect arriving inside this row's own fix.
  const blinded = rulePathspec(resolve(REPO, "scripts/row-claim.mjs"), REPO, { imports: () => [] });
  assert.deepEqual(blinded, ["scripts/row-claim.mjs", "scripts/row-claim/"],
    "the derivation collapses to the entry, and the RULE DIRECTORY is what is left holding it");

  const { root, commit } = syntheticRepo();
  try {
    const base = commit("scripts/row-claim/template-fields-rule.mjs", "export const templateFieldsReason = () => null;\n");
    setRef(root, "refs/remotes/origin/main", base);
    const moved = commit("scripts/row-claim/template-fields-rule.mjs", "export const templateFieldsReason = () => 'x';\n");
    setRef(root, "refs/remotes/origin/main", moved);
    detach(root, base);

    // A rule module moved and the walker never named it. The directory prefix is a constant, so it cannot
    // go stale with the tree -- and it is the only reason this refuses.
    assert.ok(staleRuleReason({ repoRoot: root, files: blinded }),
      "a rule module the walker could not see still has to stop the verdict");
    assert.equal(staleRuleReason({ repoRoot: root, files: ["scripts/row-claim.mjs"] }), null,
      "and WITHOUT the directory in the pathspec it does not -- which is what makes the union "
      + "load-bearing rather than decoration");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
