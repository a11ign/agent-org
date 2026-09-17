#!/usr/bin/env node
// @ts-check
// A GUARD THAT CANNOT STAND BEHIND ITS VERDICT SAYS SO -- #1014, ceo's ruling 2026-09-12.
//
// `row-claim.mjs` is POLICY code. When the policy changes by merge, every checkout that has not moved keeps
// enforcing the previous one -- silently, and with a confidently worded message naming a rule the org has
// retired. Measured the night this was filed: run from the primary checkout at `e9d175c9`, a claim was
// refused with
//
//     NOT CLAIMED: #1013 is still open and RED (a required check is failing) ... (this is B2: one PR in
//     flight per session)
//
// and BOTH HALVES of that sentence described rules that no longer existed -- the one-PR-in-flight predicate
// was replaced by #989/#1012, and cancelled-is-a-failure by #1007/#1008, two merges four minutes apart. The
// same command from an up-to-date worktree started immediately.
//
// NOT A BLANKET STALENESS REFUSAL. A checkout ten commits behind on documentation still holds the current
// rule, and refusing there would make the tool unusable in every worktree cut before the last docs commit.
// The refusal fires only when the diff touches the files the VERDICT is computed from.
//
// THE FILE LIST IS DERIVED, never typed: the local-import closure of `row-claim.mjs`, narrowed to the rule
// modules beside it. A sixth rule module added tomorrow is covered without anyone remembering to list it,
// which is the property a hand-typed list cannot have.
//
// A LEAF MODULE: its only import is `local-import-closure.mjs`, which imports nothing but `node:` builtins.
// `row-claim.mjs` is reachable from a pre-install entry, so a package specifier here would die with
// ERR_MODULE_NOT_FOUND before `npm ci` -- `pre-install-import-graph.test.ts` is what proves it.
import { execFileSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { localImports } from "../../../guards/src/local-import-closure.mjs";
import { sandboxGitEnv } from "../../../guards/src/git-env.mjs";

/**
 * Every git spawn here scrubs `GIT_*`. A hook or a parent process exports `GIT_DIR`/`GIT_INDEX_FILE`, and
 * a `cwd` is NOT isolation for a git subprocess -- `rev-list` would then answer about the inherited
 * repository while this function believes it asked about `repoRoot`, which is a verdict about the wrong
 * tree wearing the right one's name.
 * @param {string} repoRoot
 * @returns {(args: string[]) => string}
 */
const gitIn = (repoRoot) => (args) =>
  execFileSync("git", args,
    { cwd: repoRoot, encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] });

/** Where the rule modules live. A file outside this directory is the tool, not the verdict. */
const RULE_DIR = "packages/agent-org/src/row-claim/";

/**
 * The files this tool's VERDICT is computed from, repo-relative and sorted.
 *
 * Derived from `entry`'s own local-import closure and narrowed to `packages/agent-org/src/row-claim/` plus the entry
 * itself. Narrowed rather than taken whole because the closure reaches `merge-guard.mjs`,
 * `board-snapshot.mjs` and more -- real dependencies of the TOOL whose movement says nothing about whether
 * the RULE changed, and folding them in would turn this into the blanket refusal the row rules out.
 * @param {string} entry absolute path to `row-claim.mjs`
 * @param {string} repoRoot
 * @param {{ imports?: (file: string) => string[] }} [deps] `imports` is injectable so a test can drive the
 *   case this function cannot survive on its own -- see `rulePathspec`.
 * @returns {string[]}
 */
export function ruleFiles(entry, repoRoot, deps) {
  const imports = deps?.imports ?? localImports;
  const seen = new Set();
  const visit = (/** @type {string} */ file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const next of imports(file)) visit(next);
  };
  visit(entry);
  return [...seen]
    .map((file) => relative(repoRoot, file))
    .filter((rel) => rel.startsWith(RULE_DIR) || rel === relative(repoRoot, entry))
    .sort();
}

/**
 * WHAT THE COMPARISON ACTUALLY RUNS OVER: the derived closure, UNIONED with the rule directory itself.
 *
 * The union is not belt-and-braces, it is the whole point, and it was earned. **The derivation reads THIS
 * checkout's copy of the closure walker, and a stale checkout's walker is stale too** -- so the one tree
 * this guard exists for is the one tree whose file list cannot be trusted. Measured 2026-09-12 in a
 * throwaway worktree at `6dee44a4`, a main from before #1019 landed:
 *
 *     localImports("packages/agent-org/src/row-claim.mjs")  ->  0     (the pre-#1019 `stripComments` defect)
 *     ruleFiles(...)                         ->  ["packages/agent-org/src/row-claim.mjs"]
 *
 * Five rule modules missing, and the error runs toward NOT refusing: had only `own-pr-health-rule.mjs`
 * moved, that checkout would have answered "up to date" with a retired rule in its hands -- this row's own
 * defect, inside this row's own fix.
 *
 * `RULE_DIR` is a constant, so it cannot go stale with the tree, and `git` resolves a trailing-slash
 * pathspec as a directory prefix -- covering every rule module including ones the walker never saw. The
 * derivation is kept beside it because the prefix has the opposite gap: a rule module that lands OUTSIDE
 * this directory tomorrow is invisible to the prefix and obvious to the closure. Neither alone holds it.
 * @param {string} entry
 * @param {string} repoRoot
 * @param {{ imports?: (file: string) => string[] }} [deps]
 * @returns {string[]}
 */
export function rulePathspec(entry, repoRoot, deps) {
  return [...new Set([...ruleFiles(entry, repoRoot, deps), RULE_DIR])].sort();
}

/**
 * How many commits `origin/main` has that this checkout does not, TOUCHING THE FILES GIVEN -- or `null`
 * when the comparison cannot be made at all.
 *
 * `null` is CANNOT_ASK and is deliberately NOT folded into zero: a checkout with no `origin/main` ref (a
 * fresh clone mid-fetch, a detached tree) cannot say whether its rule is current, and "could not ask" and
 * "up to date" are the two answers this repository has most often seen conflated.
 * @param {{ repoRoot: string, files: string[], run?: (args: string[]) => string }} options
 * @returns {number | null}
 */
export function commitsBehindOn({ repoRoot, files, run }) {
  const git = run ?? gitIn(repoRoot);
  try {
    const count = Number(git(["rev-list", "--count", "HEAD..origin/main", "--", ...files]).trim());
    // A NUMBER THIS DID NOT PARSE IS NOT A ZERO. `Number("")` is 0 and `Number("fatal: …")` is NaN, and a
    // guard that reads either as "up to date" is the defect it exists to prevent, one layer in.
    return Number.isInteger(count) ? count : null;
  } catch (error) {
    void error; // no origin/main here, or not a work tree: CANNOT_ASK, never "up to date"
    return null;
  }
}

/**
 * The refusal, or `null` when this checkout's copy of the rule is the current one.
 *
 * @param {{ repoRoot?: string, entry?: string, run?: (args: string[]) => string,
 *           files?: string[] }} [options] `files` is for tests: a real list, never a stub of git
 * @returns {string | null}
 */
export function staleRuleReason({ repoRoot, entry, run, files } = {}) {
  const root = repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const spec = files ?? rulePathspec(entry ?? resolve(root, "packages/agent-org/src/row-claim.mjs"), root);
  const behind = commitsBehindOn({ repoRoot: root, files: spec, run });
  if (behind === null) {
    return "CANNOT ASK whether this checkout's copy of the rule is current: `origin/main` is not\n"
      + "  resolvable here. A verdict computed from a rule that may have been replaced is worse than no\n"
      + "  verdict, so this refuses rather than assuming it is up to date. `git fetch origin main` and\n"
      + "  try again.";
  }
  if (behind === 0) return null;
  // NAMES WHAT MOVED, not what was searched. A refusal listing the whole pathspec makes the reader compare
  // two lists to find the one file that matters; `git diff --name-only` has already done that, and a
  // followable refusal is the difference between updating the checkout and arguing with the tool.
  const moved = movedFiles({ repoRoot: root, files: spec, run });
  return `THIS CHECKOUT'S COPY OF THE RULE IS ${behind} COMMIT(S) BEHIND \`origin/main\`.\n`
    + `  Moved: ${moved.length > 0 ? moved.join(", ") : spec.join(", ")}\n`
    + "  A refusal printed from a retired rule names a policy the org no longer has -- measured on\n"
    + "  2026-09-12, when a claim was refused by BOTH halves of a sentence describing rules that had been\n"
    + "  replaced four minutes apart. Update this checkout and ask again.";
}

/**
 * The rule files that actually differ from `origin/main`, repo-relative -- or `[]` when the question
 * cannot be asked. Used only to word the refusal, never to decide it: `commitsBehindOn` owns the verdict,
 * and a second command deciding the same thing is how two answers come to disagree.
 *
 * `HEAD...origin/main`, three-dot, and the reason is worth stating because this repository has a standing
 * warning against it. Three-dot is `diff(merge-base(HEAD, origin/main), origin/main)` -- "what origin/main
 * changed since we diverged" -- which EXCLUDES the author's own commits. Two-dot includes them, so on a
 * branch that legitimately edits a rule file the refusal would name the author's own work under `Moved:`,
 * and a message that accuses the reader of their own change is a message that gets argued with rather than
 * followed. (worker-judge, reviewing #1044.)
 *
 * The standing warning is about `A...B` where B is an ANCESTOR of A: that collapses to `diff(B, B)` and is
 * empty by construction, a false clean. It cannot mislead here, because this function does not decide
 * anything -- `commitsBehindOn` has already returned a non-zero count before this is called, which is only
 * possible when `origin/main` has commits HEAD does not.
 * @param {{ repoRoot: string, files: string[], run?: (args: string[]) => string }} options
 * @returns {string[]}
 */
export function movedFiles({ repoRoot, files, run }) {
  const git = run ?? gitIn(repoRoot);
  try {
    // `--no-renames`, tree-wide rule: a rename reported as one path makes the OTHER path invisible, and a
    // rule file that moved is exactly the case this refusal exists to name.
    return git(["diff", "--no-renames", "--name-only", "HEAD...origin/main", "--", ...files])
      .split("\n").filter(Boolean);
  } catch (error) {
    void error; // the count above already decided; this only words the message
    return [];
  }
}
