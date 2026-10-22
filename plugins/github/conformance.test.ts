// no-token: none -- GitHub is a recorded `exec` that answers the gh calls from one pull request held in memory; nothing reaches GitHub
//
// THE CODE HOST CONTRACT'S SUITE, RUN ON THE GITHUB PLUGIN (A11-160, Decision 11 of A11-157): `runCodeHostConformance` is the only definition of "a code host", so GitHub passes the same
// checks the fake does. The emulator below answers each `gh` call the plugin makes from pull request 7 of `owner/repo`, and refuses every other one, as GitHub does a pull request the
// account cannot see.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runCodeHostConformance } from "../../src/plugins/conformance/code-host.ts";
import type { WrapperInputs } from "../../src/plugins/contracts/code-host.ts";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import { corePolicy } from "../../src/plugins/policy.ts";
import { create } from "./index.ts";

export const REPOSITORY = "owner/repo";
export const PULL = `https://github.com/${REPOSITORY}/pull/7`;
export const MISSING = `https://github.com/${REPOSITORY}/pull/999`;
export const MERGED = `https://github.com/${REPOSITORY}/pull/8`;
const HEAD = "a".repeat(40);

const REFUSED = { status: 1, stdout: "", stderr: "gh: Could not resolve to a PullRequest (HTTP 404)\n" };

/** The gh calls the plugin makes, answered from pull request 7: its feedback, its fields, its state and the list it is in. */
function github(calls: string[][] = []) {
  return (file: string, args: readonly string[]) => {
    calls.push([file, ...args]);
    if (file !== "gh") return { status: null, stdout: "", stderr: `${file} cannot start` };
    const text = args.join(" ");
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });
    if (text === "api user --jq .login") return ok("worker-bot\n");
    if (args[0] === "api" && args[1] === "graphql") {
      const found = args.includes("number=7");
      return ok(JSON.stringify({ data: { repository: { pullRequest: found ? {
        state: "OPEN", headRefOid: HEAD, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", baseRefName: "main",
        files: { nodes: [{ path: "src/a.ts" }], pageInfo: { hasNextPage: false, endCursor: null } },
        reviews: { nodes: [] }, comments: { nodes: [] }, reviewThreads: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] },
      } : null } } }));
    }
    if (args[0] === "pr" && args[1] === "view" && args[2] === MERGED) return ok(JSON.stringify({ number: 8, title: "feat: replay", body: "What it found", state: "MERGED" }));
    if (args[0] === "pr" && args[1] === "diff" && args[2] === MERGED) return ok("diff --git a/docs/spike.md b/docs/spike.md\n--- a/docs/spike.md\n+++ b/docs/spike.md\n@@ -1 +1,3 @@\n+### Scripted replay\n+Cookie dialogs drop pages.\n");
    if (args[0] === "pr" && args[1] === "view") {
      if (args[2] !== "7" && args[2] !== PULL) return REFUSED;
      return ok(JSON.stringify({ state: "OPEN", headRefOid: HEAD, reviews: [], author: { login: "worker-bot" }, isCrossRepository: false, baseRefName: "main" }));
    }
    if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([{ number: 7, body: "" }]));
    return REFUSED;
  };
}

/** What the wrapper is asked about: a host whose tool is installed outside any temporary directory, with the workers' role an App. */
export const WRAPPER_INPUTS: WrapperInputs = {
  place: { binDir: "/opt/host/bin", tool: "/opt/agent-org", checkout: "/opt/project", stateEntry: (name) => `/opt/state/${name}` }, accounts: { workers: "/opt/workers", leads: "/opt/leads" },
  identity: { scheduler: { mode: "user-accounts" }, workers: { mode: "github-apps", appId: "1", keyPath: "/opt/workers.pem" }, managers: { mode: "user-accounts" }, reviewer: { mode: "user-accounts" } },
};

/** The policy a host with a loaded reviewer gate gives: the author is the org's own, and the checks have settled. */
const policy = corePolicy(() => ({ fields: "headRefOid,reviews,author,isCrossRepository", trustOf: () => "inside", settledOf: () => true }));

test("the GitHub plugin passes the code host contract suite, and the checks that ran are the ones asserted", async () => {
  const host = create({}, fakePluginDeps({ exec: github(), policy, readFile: (path) => readFileSync(path, "utf8"), env: { A11Y_APP_NODE: "false" } }));
  const { passed, skipped } = await runCodeHostConformance(host, { pull: PULL, repository: REPOSITORY, missing: MISSING, self: "worker-bot", wrapper: WRAPPER_INPUTS, merged: MERGED });
  assert.deepEqual(passed, [
    "shape", "readOwnLogin names the account or answers null", "readPullFeedback reads a pull request", "readPullFeedback answers null for a pull request it cannot read", "readReplies answers a list of replies, and null for a pull request it cannot read",
    "readPullState names the state or answers null", "readReviewState reads the head, the reviews and whether the checks settled", "openPullUrlsOf lists a repository's open pull requests",
    "sweepRetargets keeps the note of a pull request it cannot read", "sweepRetargets with no pull requests has no notes", "subscribe returns the function that cancels it",
    "readMergedFindings reads what a merged pull request found, and answers null for one it cannot read or that has not merged",
    "the wrapper is an owned file its own text agrees with", "the wrapper keeps its own text, and writes it", "the wrapper answers whether each declared role mints",
  ]);
  assert.deepEqual(skipped.map(({ check }) => check), ["readChange reads a change, and answers null for one it cannot", "armMerge arms the merge and says it is armed"],
    "the plugin makes no change reads and arms no merge yet, so the checks that need a change are skipped with their reason and not passed");
  assert.ok(skipped.every(({ reason }) => /the probe names no change/.test(reason)));
});

test("every call the plugin makes is to gh, and the contract's reads make no write", async () => {
  const calls: string[][] = [];
  const host = create({}, fakePluginDeps({ exec: github(calls), policy }));
  await runCodeHostConformance(host, { pull: PULL, repository: REPOSITORY, missing: MISSING, self: "worker-bot" });
  assert.ok(calls.length > 0, "POSITIVE CONTROL: the suite asked GitHub something");
  assert.deepEqual([...new Set(calls.map(([file]) => file))], ["gh"]);
  for (const [, ...args] of calls) assert.equal(args.some((arg) => ["--method", "-X", "edit", "merge", "close", "create"].includes(arg)), false, `a read of a pull request wrote: gh ${args.join(" ")}`);
});
