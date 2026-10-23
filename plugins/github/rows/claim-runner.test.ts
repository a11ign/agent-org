// no-token: none -- `exec` is a recorder: no GitHub CLI runs
/**
 * A11-160 (step 7): THE RUNNER A CLAIM'S `gh` IS MADE OF. Before the claim's calls moved into the code host they ran through `execFileSync` with no bound and with every `GIT_*` variable taken off; the code host's own
 * runner cuts a call at 30 s, which would report a partial claim for a write GitHub then applied. So the claim asks for a runner with its own bound, and asks for the variables a hook sets to be taken off.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakePluginDeps } from "../../../src/plugins/fakes/deps.ts";
import { createCodeHost } from "../code-host.ts";

function codeHost(env: Record<string, string>) {
  const calls: { args: readonly string[]; options: { timeoutMs?: number; withoutEnv?: readonly string[] } }[] = [];
  const host = createCodeHost(fakePluginDeps({ env, exec: (_file, args, options) => { calls.push({ args, options: options ?? {} }); return { status: 0, stdout: "ok", stderr: "" }; } }));
  return { calls, rows: host.rows! };
}

test("a runner with a bound asks `gh` for that bound, and one made without git's variables takes the ones that are set off the call", () => {
  const { calls, rows } = codeHost({ HOME: "/home/x", GIT_DIR: "/elsewhere/.git", GIT_WORK_TREE: "/elsewhere" });
  assert.equal(rows.ownRunWithin(600_000, { withoutGitEnv: true })(["api", "repos/o/r/issues/1"]), "ok");
  assert.equal(calls[0].options.timeoutMs, 600_000, "the claim's bound, not the plugin's 30 s");
  assert.deepEqual(calls[0].options.withoutEnv, ["GIT_DIR", "GIT_WORK_TREE"], "and `GIT_*` is taken off, and nothing else");
});

test("CONTROL: a runner made without that option takes nothing off the environment, and the plugin's own runner keeps its 30 s", () => {
  const { calls, rows } = codeHost({ GIT_DIR: "/elsewhere/.git" });
  rows.ownRunWithin(120_000)(["api", "x"]);
  assert.equal("withoutEnv" in calls[0].options, false);
  assert.equal(calls[0].options.timeoutMs, 120_000);
  rows.ownRun(["api", "x"]);
  assert.equal(calls[1].options.timeoutMs, 30_000);
});
