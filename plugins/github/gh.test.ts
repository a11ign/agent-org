// no-token: none -- `exec` is a recorder: no GitHub CLI runs
import { test } from "node:test";
import assert from "node:assert/strict";
import { GH_TIMEOUT_MS, GhFailure, accountRunner, ghRunner } from "./gh.ts";

type Call = { file: string; args: readonly string[]; options: unknown };

/** An `exec` that records what it was asked to run and answers `answer`. */
function recording(answer: { status: number | null; stdout?: string; stderr?: string }) {
  const calls: Call[] = [];
  const exec = (file: string, args: readonly string[], options?: unknown) => {
    calls.push({ file, args, options });
    return { status: answer.status, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
  };
  return { calls, exec };
}

test("the runner starts `gh` with the arguments, a thirty-second cut and no environment of its own, and answers its text", () => {
  const { calls, exec } = recording({ status: 0, stdout: "worker-bot\n" });
  assert.equal(ghRunner({ exec })(["api", "user", "--jq", ".login"]), "worker-bot\n");
  assert.deepEqual(calls, [{ file: "gh", args: ["api", "user", "--jq", ".login"], options: { timeoutMs: GH_TIMEOUT_MS, env: {} } }]);
  assert.equal(GH_TIMEOUT_MS, 30_000);
});

test("a call that exits non-zero throws the command and what gh printed, so a reader that looks for HTTP 404 in it finds it", () => {
  const { exec } = recording({ status: 1, stderr: "gh: Not Found (HTTP 404)\n" });
  assert.throws(() => ghRunner({ exec })(["api", "repos/a/b/branches/x"]), (error: unknown) => error instanceof GhFailure
    && error.message === "Command failed: gh api repos/a/b/branches/x\ngh: Not Found (HTTP 404)\n" && error.status === 1 && /HTTP 404/.test(error.message));
});

test("a gh that cannot start is a failure with the reason, not a pass with no text", () => {
  const { exec } = recording({ status: null, stderr: "spawn gh ENOENT" });
  assert.throws(() => ghRunner({ exec })(["pr", "list"]), (error: unknown) => error instanceof GhFailure && error.status === null && /spawn gh ENOENT/.test(error.message));
});

test("a runner made with an environment runs every call with it", () => {
  const { calls, exec } = recording({ status: 0 });
  ghRunner({ exec }, { GH_CONFIG_DIR: "/roles/reviewer/gh" })(["pr", "view"]);
  assert.deepEqual((calls[0].options as { env: unknown }).env, { GH_CONFIG_DIR: "/roles/reviewer/gh" });
});

test("an account's runner acts as the account's config directory, and answers a failed call as its status and its error output, never a throw", () => {
  const { calls, exec } = recording({ status: 1, stderr: "gh: Not Found (HTTP 404)\n" });
  assert.deepEqual(accountRunner({ exec }, { GH_CONFIG_DIR: "/home/agent/workers/gh" })(["api", "repos/a/b/stacks"]), { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)\n" });
  assert.deepEqual((calls[0].options as { env: unknown }).env, { GH_CONFIG_DIR: "/home/agent/workers/gh" });
  accountRunner({ exec }, {})(["extension", "list"]);
  assert.deepEqual((calls[1].options as { env: unknown }).env, {}, "an account with no directory is the process's own");
});

test("an account's runner says why a call failed even when gh printed nothing, and drops the output of a failed call and the stderr of a good one", () => {
  const silent = recording({ status: 1, stdout: "partial listing\n", stderr: "" });
  assert.deepEqual(accountRunner({ exec: silent.exec }, {})(["extension", "list"]), { status: 1, stdout: "", stderr: "Command failed: gh extension list" });
  const warned = recording({ status: 0, stdout: "listed\n", stderr: "a warning" });
  assert.deepEqual(accountRunner({ exec: warned.exec }, {})(["extension", "list"]), { status: 0, stdout: "listed\n", stderr: "" });
  const missing = recording({ status: null, stderr: "spawn gh ENOENT" });
  assert.deepEqual(accountRunner({ exec: missing.exec }, {})(["extension", "list"]), { status: null, stdout: "", stderr: "spawn gh ENOENT" });
});
