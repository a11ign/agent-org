#!/usr/bin/env node
// A GUARD THAT CANNOT STAND BEHIND ITS VERDICT SAYS SO -- #1014, ceo's ruling 2026-09-12.
//
// `row-claim.ts` is POLICY code. When the policy changes by merge, every checkout that has not moved keeps
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
// THE FILE LIST IS DERIVED, never typed: the local-import closure of `row-claim.ts`, narrowed to the rule
// modules beside it. A sixth rule module added tomorrow is covered without anyone remembering to list it,
// which is the property a hand-typed list cannot have.
//
// WHAT THE CHECKOUT IS COMPARED WITH IS THE RELEASE THE HOST CAN RUN, NOT `origin/main` (agent-org#889, a11ign/agent-org#885 class 2). The host runs the newest release tag
// (`update-tool` moves its checkout there and nowhere else), so a rule file merged to `main` and not yet released is a rule NO checkout the host can start holds, and counting
// `HEAD..origin/main` refused every claim for as long as releases were failing: 163 refusals between 08:09 and 09:15 on 2026-10-11, no worker started, and the worker that
// would have fixed the outage was one of them. The count is `HEAD..<newest release tag>` now. A checkout behind a RELEASE still refuses, which is #1014's case; a checkout
// behind only unreleased merges is current as far as the host can tell, and says what main holds that the release does not.
//
// THE TWO CANNOT ALWAYS BE TOLD APART, and the answer is then to let the claim through, said aloud: no release tag in the checkout (a shallow clone, tags not fetched) leaves
// nothing to name the release by. A refusal there is the storm again for every such checkout, and a guard that cannot stand behind a verdict does not refuse on it; it logs
// the rule files `origin/main` has that this checkout lacks, so the fail-open is never silent.
//
// A LEAF MODULE: its imports are `local-import-closure.ts`, `git-env.ts` and `release-tag.ts`, which import nothing but `node:` builtins (the last nothing at all).
// `row-claim.ts` is reachable from a pre-install entry, so a package specifier here would die with
// ERR_MODULE_NOT_FOUND before `pnpm install` -- `pre-install-import-graph.test.ts` is what proves it.
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { localImports } from "../lib/local-import-closure.ts";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { LATEST, chooseReleaseTag } from "../lib/release-tag.ts";

/**
 * Every git spawn here scrubs `GIT_*`. A hook or a parent process exports `GIT_DIR`/`GIT_INDEX_FILE`, and
 * a `cwd` is NOT isolation for a git subprocess -- `rev-list` would then answer about the inherited
 * repository while this function believes it asked about `repoRoot`, which is a verdict about the wrong
 * tree wearing the right one's name.
 */
const gitIn = (repoRoot: string): (args: string[]) => string => (args) =>
  execFileSync("git", args,
    { cwd: repoRoot, encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] });

/**
 * Where the rule modules live, repo-relative with a trailing slash: the `row-claim/` directory BESIDE `entry`.
 *
 * DERIVED FROM THE ENTRY'S OWN PATH, never typed (#3041). This was the literal `packages/agent-org/src/row-claim/`, the monorepo's layout, and in the
 * standalone `agent-org` checkout (`src/row-claim/`) it named a directory that does not exist: the guard then asked git about a pathspec that
 * matches nothing and read "0 commits behind" off it, which is the other way to be wrong and the quieter one.
 * @param entry absolute path to `row-claim.ts`
 */
export function ruleDirOf(entry: string, repoRoot: string): string {
  return `${relative(repoRoot, join(dirname(entry), "row-claim")).split(sep).join("/")}/`;
}

/**
 * The work tree this module lives in, by asking git from the module's own directory -- NOT by counting directories up, which is a statement
 * about ONE layout (#3041: four up from `packages/agent-org/src/row-claim/` is the product root; from `src/row-claim/` it is the parent of the
 * checkout, `/home/agent`). `null` when the module is not inside a git work tree.
 */
export function workTreeOf(dir: string): string | null {
  try {
    return gitIn(dir)(["rev-parse", "--show-toplevel"]).trim() || null;
  } catch (error) {
    void error; // not a work tree: the caller says so by name
    return null;
  }
}

/**
 * The files this tool's VERDICT is computed from, repo-relative and sorted.
 *
 * Derived from `entry`'s own local-import closure and narrowed to the `row-claim/` directory beside it plus the entry
 * itself. Narrowed rather than taken whole because the closure reaches `merge-guard.ts`,
 * `board-snapshot.ts` and more -- real dependencies of the TOOL whose movement says nothing about whether
 * the RULE changed, and folding them in would turn this into the blanket refusal the row rules out.
 * @param entry absolute path to `row-claim.ts`
 *
 * @param [deps] `imports` is injectable so a test can drive the
 *   case this function cannot survive on its own -- see `rulePathspec`.
 */
export function ruleFiles(entry: string, repoRoot: string, deps?: { imports?: (file: string) => string[]; }): string[] {
  const imports = deps?.imports ?? localImports;
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const next of imports(file)) visit(next);
  };
  visit(entry);
  return [...seen]
    .map((file) => relative(repoRoot, file))
    .filter((rel) => rel.startsWith(ruleDirOf(entry, repoRoot)) || rel === relative(repoRoot, entry))
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
 *     localImports("packages/agent-org/src/row-claim.ts")  ->  0     (the pre-#1019 `stripComments` defect)
 *     ruleFiles(...)                         ->  ["packages/agent-org/src/row-claim.ts"]
 *
 * Five rule modules missing, and the error runs toward NOT refusing: had only `own-pr-health-rule.ts`
 * moved, that checkout would have answered "up to date" with a retired rule in its hands -- this row's own
 * defect, inside this row's own fix.
 *
 * The rule directory is derived from the entry's PATH and not from the tree's contents, so it cannot go stale with the tree, and `git` resolves a trailing-slash
 * pathspec as a directory prefix -- covering every rule module including ones the walker never saw. The
 * derivation is kept beside it because the prefix has the opposite gap: a rule module that lands OUTSIDE
 * this directory tomorrow is invisible to the prefix and obvious to the closure. Neither alone holds it.
 */
export function rulePathspec(entry: string, repoRoot: string, deps?: { imports?: (file: string) => string[]; }): string[] {
  return [...new Set([...ruleFiles(entry, repoRoot, deps), ruleDirOf(entry, repoRoot)])].sort();
}

/**
 * How many commits `against` has that this checkout does not, TOUCHING THE FILES GIVEN -- or `null` when the comparison cannot be made at all. `against` is the
 * newest release tag when one is held (see `releaseRefOf`) and `origin/main` only when none is, where the answer is logged and never a refusal.
 *
 * `null` is CANNOT_ASK and is deliberately NOT folded into zero: a checkout with no `origin/main` ref (a
 * fresh clone mid-fetch, a detached tree) cannot say whether its rule is current, and "could not ask" and
 * "up to date" are the two answers this repository has most often seen conflated.
 */
export function commitsBehindOn({ repoRoot, files, run, against = MAIN_REF }: { repoRoot: string; files: string[]; run?: (args: string[]) => string; against?: string; }): number | null {
  const git = run ?? gitIn(repoRoot);
  try {
    const count = Number(git(["rev-list", "--count", `HEAD..${against}`, "--", ...files]).trim());
    // A NUMBER THIS DID NOT PARSE IS NOT A ZERO. `Number("")` is 0 and `Number("fatal: …")` is NaN, and a
    // guard that reads either as "up to date" is the defect it exists to prevent, one layer in.
    return Number.isInteger(count) ? count : null;
  } catch (error) {
    void error; // no such ref here, or not a work tree: CANNOT_ASK, never "up to date"
    return null;
  }
}

/** The ref a checkout is compared with when it holds no release tag, and the one the unreleased files are read off. */
const MAIN_REF = "origin/main";

/**
 * THE RELEASE THE HOST CAN RUN, as a ref this checkout holds: the newest `vX.Y.Z` tag, ordered numerically as `update-tool` selects (`chooseReleaseTag`), spelled
 * `refs/tags/<tag>` so a branch of the same name cannot be read for it. `null` when the checkout holds no release tag or git cannot list them, which is "cannot tell the
 * release from main" and not "the release is main".
 */
export function releaseRefOf({ repoRoot, run }: { repoRoot: string; run?: (args: string[]) => string; }): string | null {
  const git = run ?? gitIn(repoRoot);
  try {
    const tag = chooseReleaseTag(git(["tag", "--list"]).split("\n").map((line) => line.trim()).filter(Boolean), LATEST);
    return tag === null ? null : `refs/tags/${tag}`;
  } catch (error) {
    void error; // no tags to read: the caller says "no release known" by name
    return null;
  }
}

/**
 * The rule files `origin/main` holds that `release` does not -- the unreleased merges, repo-relative -- or `[]` when the question cannot be asked. Three-dot: what main
 * changed since the release, which is empty (and right to be) when the local `origin/main` is behind the release rather than a list of the release's own files.
 * Used only to word a log line, never to decide.
 */
export function unreleasedFiles({ repoRoot, files, release, run }: { repoRoot: string; files: string[]; release: string; run?: (args: string[]) => string; }): string[] {
  const git = run ?? gitIn(repoRoot);
  try {
    return git(["diff", "--no-renames", "--name-only", `${release}...${MAIN_REF}`, "--", ...files]).split("\n").filter(Boolean);
  } catch (error) {
    void error; // no origin/main here: nothing is claimed about it
    return [];
  }
}

/**
 * How many tracked files at HEAD the pathspec matches, or `null` when git cannot say (the next step then reports that, by its own name).
 */
export function trackedFileCount({ repoRoot, files, run }: { repoRoot: string; files: string[]; run?: (args: string[]) => string; }): number | null {
  const git = run ?? gitIn(repoRoot);
  try {
    return git(["ls-files", "--", ...files]).split("\n").filter(Boolean).length;
  } catch (error) {
    void error; // not a work tree, or git is absent: `commitsBehindOn` is asked next and says CANNOT ASK itself
    return null;
  }
}

/**
 * The commit an INSTALLED copy of this tool was built from, read off the package manager's own directory name -- or `null` when `entry` is not in
 * an installed layout, or is but names no commit (#3188).
 *
 * pnpm installs a GitHub dependency at `node_modules/.pnpm/agent-org@https+++codeload.github.com+a11ign+agent-org+tar.gz+<sha>_<peers>/node_modules/agent-org/`,
 * and the module's real path is that one. The sha is the answer to "which pin is this", and no file inside the package carries it.
 * @param entry absolute real path to `row-claim.ts`
 */
export function installedLayoutOf(entry: string): { installed: boolean; sha: string | null; packageRoot: string | null; } {
  const parts = entry.split(sep);
  const at = parts.lastIndexOf("node_modules");
  if (at === -1) return { installed: false, sha: null, packageRoot: null };
  const packageRoot = parts.slice(0, at + 2).join(sep);
  const sha = /\+tar\.gz\+([0-9a-f]{40})(?:_|\/|$)/.exec(entry)?.[1] ?? null;
  return { installed: true, sha, packageRoot };
}

/** The repository an installed copy of the rule was made from: the one `compare` is asked about. */
export const REPOSITORY = "a11ign/agent-org";

/** GitHub's compare lists at most 300 files: a list that long may have been cut, and a cut list cannot clear anything. */
const COMPARE_FILE_CAP = 300;

/**
 * Does a changed path fall under the rule pathspec? Entries ending `/` are directories, the rest are files.
 */
const underPathspec = (file: string, spec: string[]) => spec.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));

const cannotAskInstalled = (entry: string, why: string) => `CANNOT ASK whether the INSTALLED copy of the rule (${entry}) is current: ${why}\n`
  + "  This refuses rather than assuming it is up to date.";

/**
 * THE INSTALLED LAYOUT (#3188): the tool lives under `node_modules/`, so the consumer's repository holds no copy of the rule and `git rev-list HEAD..origin/main`
 * there asks about a path it does not contain. The question is the same one -- has the rule moved since this copy was made -- put to the repository the copy
 * came from: the commit pnpm installed against `a11ign/agent-org` `main`, narrowed to the rule files exactly as the other layouts are.
 *
 * Not a blanket refusal either: `main` moving on anything but the rule leaves the installed copy current, which is why this compares files and not tips.
 *
 * STILL COMPARED WITH `main`, NOT WITH THE NEWEST RELEASE (agent-org#889 moved the checkout layouts only): naming the release takes a second GitHub call in a pre-install
 * leaf, which `gh-call-baseline.json` counts, and an installed copy under `node_modules/` is no longer how the host runs the tool (#4389, the tool runs from a checkout).
 * So an installed pin is still refused for a rule file that `main` holds and no release does: the same defect, left in the one layout nobody is meant to run.
 */
export function installedStaleReason({ entry, sha, packageRoot, compare }: { entry: string; sha: string | null; packageRoot: string; compare?: (sha: string) => { status: string; files: string[]; } | null; }): string | null {
  if (sha === null) return cannotAskInstalled(entry, "the install directory names no commit, so there is nothing to compare with `main`.");
  // THE GUARD IS A LEAF AND SPAWNS NO `gh`: the caller hands it the question for GitHub (the code host's `compareShaWithMain`, aimed at {@link REPOSITORY}), and a caller that hands none cannot ask.
  if (compare === undefined) return cannotAskInstalled(entry, "nothing was given to ask GitHub with, so there is nothing to compare with `main`.");
  const result = compare(sha);
  if (result === null) return cannotAskInstalled(entry, `GitHub could not compare ${sha.slice(0, 12)} with ${REPOSITORY}'s main (offline, no \`gh\` token, or an unknown commit).`);
  if (result.status === "identical" || result.status === "behind") return null; // installed IS main, or is ahead of it
  const spec = rulePathspec(entry, packageRoot);
  const moved = result.files.filter((file) => underPathspec(file, spec));
  if (moved.length === 0 && result.files.length < COMPARE_FILE_CAP) return null;
  return `THE INSTALLED COPY OF THE RULE (${REPOSITORY}@${sha.slice(0, 12)}) IS BEHIND \`main\`.\n`
    + `  Moved: ${moved.length > 0 ? moved.join(", ") : `${COMPARE_FILE_CAP}+ files, too many to tell which are rule files`}\n`
    + "  The pin in `package.json` resolved to this commit and `main` has changed the rule since. Bump the pin\n"
    + "  (`pnpm update agent-org`) and ask again.";
}

const cannotAskNoTree = (dir: string) => `CANNOT ASK whether this checkout's copy of the rule is current: ${dir} is not inside a git work tree, so there is\n`
  + "  no repository to compare against `origin/main`. This refuses rather than assuming it is up to date.";

const cannotAskNothingTracked = (root: string, spec: string[]) => `CANNOT ASK whether this checkout's copy of the rule is current: the rule pathspec `
  + `(${spec.length === 0 ? "empty" : spec.join(", ")}) matches no tracked file in ${root}, so a count of "0 commits behind" would be read off\n`
  + "  nothing. The tool's own layout is not the one this guard was asked about; this refuses rather than assuming it is up to date.";

/**
 * The refusal, or `null` when this checkout's copy of the rule is the one the host can run.
 *
 *   `files` is for tests: a real list, never a stub of git. `compare` is the installed layout's GitHub question, injectable for the same reason. `log` is where a
 *   claim let through on unreleased rule files says so (stderr by default).
 */
export function staleRuleReason({ repoRoot, entry, run, files, compare, log = logToStderr }: {
    repoRoot?: string; entry?: string; run?: (args: string[]) => string;
    files?: string[]; compare?: (sha: string) => { status: string; files: string[]; } | null; log?: (line: string) => void;
} = {}): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const installed = installedLayoutOf(entry ?? resolve(here, "..", "row-claim.ts"));
  if (installed.installed && repoRoot === undefined && files === undefined) {
    return installedStaleReason({ entry: entry ?? resolve(here, "..", "row-claim.ts"), sha: installed.sha, packageRoot: (installed.packageRoot as string), compare });
  }
  const root = repoRoot ?? workTreeOf(here);
  if (root === null) return cannotAskNoTree(here);
  const spec = files ?? rulePathspec(entry ?? resolve(here, "..", "row-claim.ts"), root);
  // A PATHSPEC THAT MATCHES NO TRACKED FILE CANNOT SAY "UP TO DATE": `git rev-list HEAD..origin/main -- <nothing>` counts 0 and that zero is not a
  // reading of anything (#3041, the same conflation `commitsBehindOn` already refuses for a missing `origin/main`).
  if (spec.length === 0 || trackedFileCount({ repoRoot: root, files: spec, run }) === 0) return cannotAskNothingTracked(root, spec);
  const release = releaseRefOf({ repoRoot: root, run });
  if (release === null) return withoutRelease({ root, spec, run, log });
  const behind = commitsBehindOn({ repoRoot: root, files: spec, run, against: release });
  if (behind === null) {
    return `CANNOT ASK whether this checkout's copy of the rule is current: the newest release (${release.replace("refs/tags/", "")}) is not\n`
      + "  resolvable here. A verdict computed from a rule that may have been replaced is worse than no\n"
      + "  verdict, so this refuses rather than assuming it is up to date. `git fetch --tags origin` and\n"
      + "  try again.";
  }
  if (behind === 0) {
    // NOT REFUSED, AND NOT SILENT: main holds rule files no release has, so no checkout the host can start holds them either.
    const unreleased = unreleasedFiles({ repoRoot: root, files: spec, release, run });
    if (unreleased.length > 0) log(`stale-rule-guard: origin/main holds ${unreleased.length} rule file(s) that ${release.replace("refs/tags/", "")} does not (${unreleased.join(", ")}); not refusing, the host cannot run them yet.`);
    return null;
  }
  // NAMES WHAT MOVED, not what was searched. A refusal listing the whole pathspec makes the reader compare
  // two lists to find the one file that matters; `git diff --name-only` has already done that, and a
  // followable refusal is the difference between updating the checkout and arguing with the tool.
  const moved = movedFiles({ repoRoot: root, files: spec, run, against: release });
  return `THIS CHECKOUT'S COPY OF THE RULE IS ${behind} COMMIT(S) BEHIND THE RELEASE THE HOST RUNS (${release.replace("refs/tags/", "")}).\n`
    + `  Moved: ${moved.length > 0 ? moved.join(", ") : spec.join(", ")}\n`
    + "  A refusal printed from a retired rule names a policy the org no longer has -- measured on\n"
    + "  2026-09-12, when a claim was refused by BOTH halves of a sentence describing rules that had been\n"
    + "  replaced four minutes apart. Update this checkout and ask again.";
}

const logToStderr = (line: string) => { process.stderr.write(`${line}\n`); };

/**
 * A CHECKOUT THAT HOLDS NO RELEASE TAG cannot tell the release from `origin/main`, and the verdict it can give is only ever about main. Main ahead on the rule files is
 * then LET THROUGH AND LOGGED, naming the files: refusing here is the claim-refusal storm for every checkout without tags. Main unresolvable is still CANNOT ASK, because
 * with no release and no main there is nothing to compare with at all.
 */
function withoutRelease({ root, spec, run, log }: { root: string; spec: string[]; run?: (args: string[]) => string; log: (line: string) => void; }): string | null {
  const behind = commitsBehindOn({ repoRoot: root, files: spec, run });
  if (behind === null) {
    return "CANNOT ASK whether this checkout's copy of the rule is current: `origin/main` is not\n"
      + "  resolvable here and the checkout holds no release tag. A verdict computed from a rule that may\n"
      + "  have been replaced is worse than no verdict, so this refuses rather than assuming it is up to\n"
      + "  date. `git fetch --tags origin` and try again.";
  }
  if (behind === 0) return null;
  const moved = movedFiles({ repoRoot: root, files: spec, run });
  log(`stale-rule-guard: this checkout holds no release tag, so origin/main's ${behind} commit(s) on the rule files (${moved.length > 0 ? moved.join(", ") : spec.join(", ")}) `
    + "cannot be told from the release; not refusing.");
  return null;
}

/**
 * The rule files that actually differ from `against` (the release, or `origin/main` where none is held), repo-relative -- or `[]` when the question
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
 */
export function movedFiles({ repoRoot, files, run, against = MAIN_REF }: { repoRoot: string; files: string[]; run?: (args: string[]) => string; against?: string; }): string[] {
  const git = run ?? gitIn(repoRoot);
  try {
    // `--no-renames`, tree-wide rule: a rename reported as one path makes the OTHER path invisible, and a
    // rule file that moved is exactly the case this refusal exists to name.
    return git(["diff", "--no-renames", "--name-only", `HEAD...${against}`, "--", ...files])
      .split("\n").filter(Boolean);
  } catch (error) {
    void error; // the count above already decided; this only words the message
    return [];
  }
}
