// no-token: none -- `exec` is a recorder: no GitHub CLI runs
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExecOptions, ExecResult } from "../../src/plugins/manifest.ts";
import { depsFor } from "../../src/plugins/loader.ts";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import { createCallLedger } from "../../src/ticket-mode/call-outcomes.ts";
import { BREAKER_FAILURES, RETRY_WAITS_MS, ServiceUnavailable, createOutsideClient, isTransient } from "../../src/ticket-mode/outside-client.ts";
import { GH_TIMEOUT_MS, GhFailure, accountRunner, asyncAccountRunner, asyncGhRunner, ghRunner, isRead } from "./gh.ts";

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

test("a runner made with a longer cut (the wake's reports read for two minutes) starts `gh` with that cut and no other change", () => {
  const { calls, exec } = recording({ status: 0, stdout: "[]" });
  assert.equal(ghRunner({ exec }, {}, { timeoutMs: 120_000 })(["api", "repos/a/b/pulls"]), "[]");
  assert.deepEqual(calls, [{ file: "gh", args: ["api", "repos/a/b/pulls"], options: { timeoutMs: 120_000, env: {} } }]);
});

test("a call that exits non-zero throws the command and what gh printed, so a reader that looks for HTTP 404 in it finds it", () => {
  const { exec } = recording({ status: 1, stderr: "gh: Not Found (HTTP 404)\n" });
  assert.throws(() => ghRunner({ exec })(["api", "repos/a/b/branches/x"]), (error: unknown) => error instanceof GhFailure
    && error.message === "Command failed: gh api repos/a/b/branches/x\ngh: Not Found (HTTP 404)\n" && error.status === 1 && /HTTP 404/.test(error.message));
});

test("a refused call keeps what gh printed on stdout, because a rate-limit refusal still answers the headers that say when the pool returns", () => {
  const headers = "HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Limit: 5000\nX-Ratelimit-Reset: 1790000000\n";
  const { exec } = recording({ status: 1, stdout: headers, stderr: "gh: API rate limit exceeded\n" });
  assert.throws(() => ghRunner({ exec })(["api", "graphql", "-i"]), (error: unknown) => error instanceof GhFailure && (error as GhFailure).stdout === headers,
    "api-pool.ts's rawResponse reads the headers off a thrown error's stdout, as it did off execFileSync's");
});

test("a runner made with variables to take off hands them to every call, and one made with none hands no such option", () => {
  const { calls, exec } = recording({ status: 0 });
  ghRunner({ exec }, {}, { withoutEnv: () => ["GIT_DIR", "GIT_WORK_TREE"] })(["pr", "list"]);
  ghRunner({ exec })(["pr", "list"]);
  assert.deepEqual((calls[0].options as { withoutEnv: unknown }).withoutEnv, ["GIT_DIR", "GIT_WORK_TREE"]);
  assert.equal("withoutEnv" in (calls[1].options as object), false);
});

test("a runner given an echo tells it what gh printed on stderr, on success and on failure, without the last newline", () => {
  const said: string[] = [];
  const ok = recording({ status: 0, stdout: "x", stderr: "! Pull request #7 is already queued to merge\n" });
  ghRunner(ok, {}, { echo: (text) => said.push(text) })(["pr", "merge"]);
  const failed = recording({ status: 1, stderr: "HTTP 403\n" });
  assert.throws(() => ghRunner(failed, {}, { echo: (text) => said.push(text) })(["pr", "view"]), GhFailure);
  ghRunner(recording({ status: 0 }), {}, { echo: (text) => said.push(text) })(["pr", "list"]);
  assert.deepEqual(said, ["! Pull request #7 is already queued to merge", "HTTP 403"], "an empty stderr says nothing");
});

test("a gh that cannot start is a failure with the reason, not a pass with no text", () => {
  const { exec } = recording({ status: null, stderr: "spawn gh ENOENT" });
  assert.throws(() => ghRunner({ exec })(["pr", "list"]), (error: unknown) => error instanceof GhFailure && error.status === null && error.message === "spawn gh ENOENT", "the message is the spawn error itself, as execFileSync threw it");
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

/** The code host's deps as the board's loader makes them (`depsFor`), over a client with its own ledger whose waits take no time, and an `execAsync` that answers `answers` in turn (the last one again). */
function boardGh(...answers: Partial<ExecResult>[]) {
  const ledger = createCallLedger(() => 1_000);
  const waits: number[] = [];
  const runs: ExecOptions[] = [];
  const execAsync = async (_file: string, _args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> => {
    runs.push(options);
    const answer = answers[Math.min(runs.length, answers.length) - 1];
    return { status: answer.status ?? 0, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
  };
  const deps = depsFor("codeHost", { ...fakePluginDeps(), execAsync }, createOutsideClient({ ledger, sleep: async (ms) => { waits.push(ms); } }));
  return { deps, ledger, waits, runs };
}

test("A11-436: the board's gh call that met a connection reset is tried again through the outside client, answers the try that worked, and is one failed call in the figure", async () => {
  const { deps, ledger, waits, runs } = boardGh({ status: 1, stderr: "read tcp: connection reset by peer\n" }, { status: 0, stdout: "worker-bot\n" });
  assert.equal(await asyncGhRunner(deps)(["api", "user", "--jq", ".login"]), "worker-bot\n");
  assert.deepEqual(waits, [RETRY_WAITS_MS[0]]);
  assert.deepEqual(runs.map(({ countedByCaller, timeoutMs }) => [countedByCaller, timeoutMs]), [[true, GH_TIMEOUT_MS], [true, GH_TIMEOUT_MS]], "the client counts the call, so exec does not count it again");
  assert.deepEqual(ledger.figures().github, { calls: 1, failures: 1, failuresPer100: 100 });
});

test("A11-436: a gh answer GitHub gave (a 404) is not tried again, and still rejects with the GhFailure a reader looks for HTTP 404 in", async () => {
  const { deps, ledger, runs } = boardGh({ status: 1, stderr: "gh: Not Found (HTTP 404)\n" });
  await assert.rejects(asyncGhRunner(deps)(["api", "repos/a/b/branches/x"]), (error: unknown) => error instanceof GhFailure && /HTTP 404/.test(error.message) && !isTransient(error));
  assert.equal(runs.length, 1);
  assert.deepEqual(ledger.figures().github, { calls: 1, failures: 0, failuresPer100: 0 });
});

test("A11-436: given gh fails 10 times in a row on a connection reset, the board's next gh call is refused at once and says GitHub is unavailable", async () => {
  const { deps, runs } = boardGh({ status: 1, stderr: "read tcp: connection reset by peer\n" });
  const gh = asyncGhRunner(deps);
  await assert.rejects(gh(["pr", "list"]), (error: unknown) => error instanceof GhFailure && isTransient(error), "every try failed: the last try's failure, transient");
  await assert.rejects(gh(["pr", "list"]), GhFailure);
  await assert.rejects(gh(["pr", "list"]), ServiceUnavailable);
  assert.equal(runs.length, BREAKER_FAILURES);
  await assert.rejects(gh(["pr", "view", "1"]), /GitHub is unavailable/);
  assert.equal(runs.length, BREAKER_FAILURES, "refused at once: gh did not run");
  const doctor = await asyncAccountRunner(deps, {})(["extension", "list"]);
  assert.deepEqual([doctor.status, runs.length], [1, BREAKER_FAILURES + 1], "a doctor row asks gh itself and says what it answers now, not the loop's breaker");
});

test("A11-436: a runner with no outside client (a process that is not the board) runs gh once, and exec counts it", async () => {
  const runs: ExecOptions[] = [];
  const execAsync = async (_file: string, _args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> => { runs.push(options); return { status: 1, stdout: "", stderr: "HTTP 502\n" }; };
  await assert.rejects(asyncGhRunner({ execAsync })(["pr", "list"]), GhFailure);
  assert.deepEqual(runs, [{ timeoutMs: GH_TIMEOUT_MS, env: {} }]);
});

test("A11-436: the client cuts a gh attempt only after gh's own cut, so a gh that runs past its time answers as it always did, a GhFailure with no status", async () => {
  let asked: { attemptMs?: number } = {};
  const outside = async <T>(attempt: (signal: AbortSignal) => Promise<T>, options?: { attemptMs?: number }): Promise<T> => { asked = options ?? {}; return attempt(new AbortController().signal); };
  const execAsync = async (): Promise<ExecResult> => ({ status: null, stdout: "", stderr: "spawn gh ETIMEDOUT" });
  await assert.rejects(asyncGhRunner({ execAsync, outside }, {}, { timeoutMs: 120_000 })(["api", "x"]), (error: unknown) => error instanceof GhFailure && error.status === null);
  assert.equal(asked.attemptMs !== undefined && asked.attemptMs > 120_000, true);
});

test("A11-436: a gh write that failed on the network is made once, because a second try could repeat it (a comment posted twice); the breaker and the figure still see it", async () => {
  const { deps, ledger, runs, waits } = boardGh({ status: 1, stderr: "HTTP 502: Bad Gateway\n" });
  await assert.rejects(asyncGhRunner(deps)(["api", "-X", "POST", "repos/a/b/issues/1/comments", "-f", "body=hi"]), GhFailure);
  assert.deepEqual([runs.length, waits], [1, []]);
  assert.deepEqual(ledger.figures().github, { calls: 1, failures: 1, failuresPer100: 100 });
});

test("A11-436: a gh call is a read only when it cannot change anything: an api GET or a GraphQL query, or a command that only views or lists", () => {
  const reads = [["api", "--paginate", "repos/a/b/pulls"], ["api", "user", "--jq", ".login"], ["api", "-X", "GET", "repos/a/b/labels", "-f", "per_page=100"], ["api", "graphql", "-f", "query=query { viewer { login } }"],
    ["pr", "view", "3"], ["pr", "checks", "3"], ["run", "view", "9"], ["extension", "list"], ["search", "prs", "x"]];
  const writes = [["api", "-X", "POST", "repos/a/b/issues/1/comments", "-f", "body=x"], ["api", "repos/a/b/issues/1/labels", "-f", "labels[]=x"], ["api", "--method", "PUT", "repos/a/b/pulls/1/update-branch"],
    ["api", "graphql", "-f", "query=mutation { x }"], ["pr", "merge", "1"], ["pr", "close", "1"], ["run", "rerun", "9", "--failed"], ["workflow", "run", "arm-approved"], ["stack", "link"]];
  assert.deepEqual([reads.map(isRead), writes.map(isRead)], [reads.map(() => true), writes.map(() => false)]);
});
