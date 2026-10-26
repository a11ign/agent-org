// no-token: gh -- `readMergeFlow` is handed a stub `run`; nothing here spawns `gh` or needs a token.
//
// A11-291: whether a repository can merge a pull request by itself -- it allows auto-merge and its default branch holds the arm workflow, or it is private and holds the merge bot. a11ign/plugin#10 sat approved and
// green for a day in a repository with neither.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GhFailure } from "./gh.ts";
import { ARM_WORKFLOW_PATH, MERGE_BOT_WORKFLOW_PATH, readMergeFlow, readMergeFlows } from "./merge-flow.ts";

/** What GitHub answers for one repository: the setting, whether it is private, the default branch, and `arm` and `bot`, which are null where the head holds no such workflow. */
const repository = ({ autoMerge = true, isPrivate = false, arm = true, bot = false, branch = "main" } = {}) => ({
  autoMergeAllowed: autoMerge, isPrivate, defaultBranchRef: { name: branch }, object: arm ? { __typename: "Blob" } : null, bot: bot ? { __typename: "Blob" } : null,
});

/** A `run` that answers the one query with `data` (its aliases `r0`, `r1`, ...), and records each call. `failing` makes `gh` exit non-zero WITH the answer, as it does when GitHub could not read one repository. */
function answering(data: Record<string, unknown>, failing = false) {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    const text = JSON.stringify({ data, ...(failing ? { errors: [{ type: "NOT_FOUND" }] } : {}) });
    if (failing) throw new GhFailure(args, { status: 1, stdout: text, stderr: "gh: Could not resolve to a Repository" });
    return text;
  };
  return { calls, run };
}

const flowOf = (answer: Record<string, unknown>) => readMergeFlow("a11ign/plugin", answering({ r0: answer }).run);

test("A11-291: a repository that allows auto-merge and holds the arm workflow has a merge flow, read with one query for the setting, privacy, default branch and both files", () => {
  const { run, calls } = answering({ r0: repository() });
  assert.deepEqual(readMergeFlow("a11ign/plugin", run), { autoMerge: true, armWorkflow: true, defaultBranch: "main", private: false, mergeBot: false });
  assert.equal(calls.length, 1);
  const query = calls[0].find((arg) => arg.startsWith("query=")) ?? "";
  assert.match(query, /repository\(owner: "a11ign", name: "plugin"\) \{ autoMergeAllowed isPrivate defaultBranchRef \{ name \} object\(expression: "HEAD:\.github\/workflows\/auto-arm\.yml"\) \{ __typename \} bot: object\(expression: "HEAD:\.github\/workflows\/merge-bot\.yml"\)/);
  assert.deepEqual([ARM_WORKFLOW_PATH, MERGE_BOT_WORKFLOW_PATH], [".github/workflows/auto-arm.yml", ".github/workflows/merge-bot.yml"]);
});

test("A11-291: a repository with auto-merge off and no arm workflow (a11ign/plugin before A11-291) has neither, and one with only one of them says which", () => {
  assert.deepEqual(flowOf(repository({ autoMerge: false, arm: false })), { autoMerge: false, armWorkflow: false, defaultBranch: "main", private: false, mergeBot: false });
  assert.deepEqual(flowOf(repository({ arm: false, branch: "trunk" })), { autoMerge: true, armWorkflow: false, defaultBranch: "trunk", private: false, mergeBot: false });
  assert.deepEqual(flowOf(repository({ autoMerge: false })), { autoMerge: false, armWorkflow: true, defaultBranch: "main", private: false, mergeBot: false });
});

test("A11-291: a private repository is read as private, and whether it holds the merge bot is read apart from the arm workflow", () => {
  assert.deepEqual(flowOf(repository({ autoMerge: false, arm: false, isPrivate: true, bot: true })), { autoMerge: false, armWorkflow: false, defaultBranch: "main", private: true, mergeBot: true });
  assert.deepEqual(flowOf(repository({ autoMerge: false, arm: false, isPrivate: true })), { autoMerge: false, armWorkflow: false, defaultBranch: "main", private: true, mergeBot: false });
});

test("A11-291: many repositories are one call, each answered by its alias, and a repository GitHub would not read is null while the others are read", () => {
  const { run, calls } = answering({ r0: repository(), r1: null, r2: repository({ autoMerge: false, arm: false }) }, true);
  assert.deepEqual(readMergeFlows(["a11ign/lab", "a11ign/gone", "a11ign/plugin"], run), {
    "a11ign/lab": { autoMerge: true, armWorkflow: true, defaultBranch: "main", private: false, mergeBot: false }, "a11ign/gone": null,
    "a11ign/plugin": { autoMerge: false, armWorkflow: false, defaultBranch: "main", private: false, mergeBot: false },
  });
  assert.equal(calls.length, 1, "thirteen repositories do not take thirteen calls");
});

test("A11-291: a read that cannot be made is null, never 'no flow': a failed call, an answer that is not JSON or has no data, a missing setting, and a name that is not owner/name", () => {
  const failed = (args: string[]): never => { throw new GhFailure(args, { status: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)" }); };
  assert.equal(readMergeFlow("a11ign/plugin", failed), null, "a refused call");
  assert.equal(readMergeFlow("a11ign/plugin", () => "not json"), null);
  assert.equal(readMergeFlow("a11ign/plugin", () => JSON.stringify({ errors: [] })), null);
  assert.equal(flowOf({ defaultBranchRef: { name: "main" }, isPrivate: false, object: null }), null, "no setting is not 'off'");
  assert.equal(flowOf({ autoMergeAllowed: true, isPrivate: false, object: null }), null, "and no default branch is not one");
  assert.equal(flowOf({ autoMergeAllowed: true, defaultBranchRef: { name: "main" }, object: null }), null, "nor is an answer that does not say whether the repository is private");
  const stray = answering({});
  assert.deepEqual(readMergeFlows(["plugin", "a11ign/plugin/extra", 'a11ign/"x'], stray.run), { plugin: null, "a11ign/plugin/extra": null, 'a11ign/"x': null });
  assert.equal(stray.calls.length, 0, "a name that is not owner/name is not put in a query");
  const crashed = (): never => { throw new Error("spawn gh ENOENT"); };
  assert.equal(readMergeFlow("a11ign/plugin", crashed), null, "a gh that cannot start");
});
