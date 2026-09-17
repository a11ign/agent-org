#!/usr/bin/env node
// @ts-check
// EVERY NETWORK/PROCESS LOOKUP `merge-guard.mjs`'s RULES READ -- kept separate from the rules themselves
// because a rule is a pure function of facts already looked up, and mixing the two is what made this file
// hard to read as eight decisions rather than one. `null` on failure, never an empty answer, throughout:
// "could not ask" and "asked and got nothing" are different states and a rule needs to tell them apart
// (`[]` reads as "nobody holds this row"; `null` reads as "I could not ask" -- collapsing them is this
// repo's oldest defect).
//
// `lookupBranchTip`'s `git ls-remote` spawn runs under `sandboxGitEnv()` -- a leaked `GIT_DIR` redirects
// a spawned git call onto the wrong repository (2026-09-06, "a closed row created the exposure"), and
// `git-spawn-classification.test.ts` discovers every git-spawning FILE and requires it. #455's own split
// found this gap: the original monolith's `lookupBranchTip` never used the helper either, and the check's
// per-file granularity was blind to it because a SIBLING function in that same file (the #188
// reconciliation log's `gitCommonDir`) happened to import and call it -- moving the two into separate
// files made the omission visible rather than introducing it.
import { execFileSync } from "node:child_process";
import { REPO } from "../../../../scripts/repo-identity.mjs";
import { sandboxGitEnv } from "../../../guards/src/git-env.mjs";
import { assertNoLeakInArgv } from "../../../lab/src/packaging/leak-patterns.mjs";

/** @param {string[]} args */
export const gh = (args) => {
  // #1053: `trunk-revert` reaches GitHub through this, and so does anything else that imports it.
  assertNoLeakInArgv("gh", args);
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
};

/**
 * Each lookup returns null on failure rather than an empty answer -- the distinction every rule needs.
 * @template T
 * @param {() => T} fn
 * @returns {T | null}
 */
export function lookup(fn) {
  try {
    return fn();
  } catch (error) {
    void error;
    return null;
  }
}

/** The branch-protection required status-check contexts for `main`, or `null` if the lookup failed. */
export function lookupRequiredContexts() {
  return lookup(() => JSON.parse(
    gh(["api", `repos/${REPO}/branches/main/protection/required_status_checks`])).contexts);
}

/**
 * The real, current tip of a branch on `origin` right now -- never GitHub's `headRefOid`, which is a
 * separate piece of bookkeeping that can lag a push (#294). `null` on failure, same as every lookup here;
 * an unparseable or empty `ls-remote` line is treated the same as a thrown error rather than as a real
 * empty-string sha, since neither means "the branch has no tip".
 * @param {string} branchName
 * @returns {string | null}
 */
export function lookupBranchTip(branchName) {
  return lookup(() => {
    const line = execFileSync("git", ["ls-remote", "origin", branchName],
      { encoding: "utf8", env: sandboxGitEnv() }).trim();
    const sha = line.split(/\s+/)[0];
    return sha || null;
  });
}

/**
 * Every check run recorded against a commit sha, or `null` if the lookup failed.
 * @param {string} sha
 * @returns {{name: string, status: string, conclusion: string | null, completedAt: string | null}[] | null}
 */
export function lookupCheckRuns(sha) {
  return lookup(() => JSON.parse(
    gh(["api", `repos/${REPO}/commits/${sha}/check-runs`, "--paginate"])).check_runs
    // #902: `id` IS CARRIED, because `checkReasons` groups by name and takes the newest, and an ordering
    // key it is never given is a rule it cannot apply. GitHub keeps EVERY check run for a head, so a
    // superseded or cancelled attempt sits in this list beside the one that actually decided.
    .map((/** @type {{id: number, name: string, status: string, conclusion: string | null, completed_at: string | null}} */ run) => (
      { id: run.id, name: run.name, status: run.status, conclusion: run.conclusion, completedAt: run.completed_at })));
}

/**
 * Which issues arming PR `number` would close, resolved by GitHub itself (never a `Closes #N` regex over
 * the PR body) -- #249. `null` on failure, same as every other lookup here.
 * @param {number} number
 * @returns {{number: number, title?: string, labels: string[]}[] | null}
 */
export function lookupClosingIssues(number) {
  return lookup(() => {
    const [owner, name] = REPO.split("/");
    const query = "query($owner:String!,$name:String!,$number:Int!){"
      + "repository(owner:$owner,name:$name){pullRequest(number:$number){"
      + "closingIssuesReferences(first:20){nodes{number title labels(first:20){nodes{name}}}}}}}";
    const data = JSON.parse(gh(["api", "graphql", "-f", `query=${query}`,
      "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`]));
    return data.data.repository.pullRequest.closingIssuesReferences.nodes.map(
      (/** @type {{number: number, title: string, labels: {nodes: {name: string}[]}}} */ issue) => ({
        number: issue.number, title: issue.title,
        labels: issue.labels.nodes.map((/** @type {{name: string}} */ l) => l.name),
      }));
  });
}
