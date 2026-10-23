// no-token: none -- `exec` answers from a table, and the real-process cases put a stub `gh` first on PATH: the real one is never reached
/**
 * A11-160 (step 6): THE PROCESS THE WORK GATE'S EXECUTOR STARTS. The executor's policy (the memo, the budget, the line told when a call is cut) is core's and tested there; here is the process: `gh`, run to completion
 * or cut at a bound, aimed at a repository, with its stderr let through or captured, and several calls started at once. The first block runs it over an injected `exec`, the second over a stub `gh` that really sleeps.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callerScript } from "../../../src/gh-ledger.ts";
import type { ExecOptions, ExecResult } from "../../../src/plugins/manifest.ts";
import { realExec } from "../../../src/plugins/real-seams.ts";
import { GhFailure } from "../gh.ts";
import { gateRunner, runGhTogether } from "./gate-runner.ts";

type Called = { file: string; args: readonly string[]; options: ExecOptions };

function injected(answer: ExecResult) {
  const called: Called[] = [];
  const told: string[] = [];
  return { called, told, deps: { exec: (file: string, args: readonly string[], options: ExecOptions = {}): ExecResult => { called.push({ file, args, options }); return answer; }, log: (line: string) => told.push(line) } };
}

test("a call is `gh` with the bound, aimed by GH_REPO where the caller names a repository and by nothing where it names none", () => {
  const { called, deps } = injected({ status: 0, stdout: "answer\n", stderr: "" });
  const run = gateRunner(deps, { timeoutMs: 30_000, capture: false });
  assert.equal(run(["pr", "list"]), "answer\n");
  assert.equal(run(["pr", "list"], "o/r"), "answer\n");
  assert.deepEqual(called, [
    { file: "gh", args: ["pr", "list"], options: { timeoutMs: 30_000 } },
    { file: "gh", args: ["pr", "list"], options: { timeoutMs: 30_000, env: { GH_REPO: "o/r" } } },
  ]);
});

test("a failed call throws what `execFileSync` threw: the status, stderr and stdout, and a message that holds the command and what gh printed (a reader tests for `HTTP 404` in it)", () => {
  const { deps } = injected({ status: 1, stdout: "partial", stderr: "gh: Not Found (HTTP 404)\n" });
  const run = gateRunner(deps, { timeoutMs: 1, capture: true });
  try {
    run(["api", "x"]);
    assert.fail("a failed gh must throw");
  } catch (error) {
    assert.ok(error instanceof GhFailure);
    assert.deepEqual([error.status, error.stderr, error.stdout], [1, "gh: Not Found (HTTP 404)\n", "partial"]);
    assert.match(error.message, /^Command failed: gh api x\ngh: Not Found \(HTTP 404\)/);
    assert.equal((error as { code?: string }).code, undefined, "a refusal that is not a timeout carries no timeout code");
  }
});

test("a call that hit the bound throws with code ETIMEDOUT, the refusal every reader turns into null for its own lane", () => {
  const { deps } = injected({ status: null, stdout: "", stderr: "spawnSync gh ETIMEDOUT" });
  const refusal = (() => { try { gateRunner(deps, { timeoutMs: 400, capture: true })(["pr", "list"]); } catch (error) { return error as { code?: string; status?: number | null }; } })();
  assert.equal(refusal?.code, "ETIMEDOUT");
  assert.equal(refusal?.status, null);
});

test("what gh prints on stderr goes through to this process's own unless the call is captured (a read whose refusal is an answer the caller handles)", () => {
  const letThrough = injected({ status: 0, stdout: "x", stderr: "warning: a thing\n" });
  gateRunner(letThrough.deps, { timeoutMs: 1, capture: false })(["pr", "list"]);
  assert.deepEqual(letThrough.told, ["warning: a thing"]);
  const captured = injected({ status: 0, stdout: "x", stderr: "warning: a thing\n" });
  gateRunner(captured.deps, { timeoutMs: 1, capture: true })(["pr", "list"]);
  assert.deepEqual(captured.told, []);
});

test("a batch is ONE `node` with the worker's text, the calls as JSON and the bound; its answers are parsed in order, and a batch that did not finish THROWS", () => {
  const { called, deps } = injected({ status: 0, stdout: JSON.stringify([{ stdout: "a" }, { failed: true, stdout: "", stderr: "slow", status: null, code: "ETIMEDOUT" }]), stderr: "" });
  const calls = [{ args: ["a"], repo: undefined }, { args: ["b"], repo: "o/r" }];
  const answers = runGhTogether(deps, { calls, env: { PATH: "/stub", GONE: undefined }, callMs: 500, graceMs: 5_000, maxBuffer: 1024 });
  assert.deepEqual(answers, [{ stdout: "a" }, { failed: true, stdout: "", stderr: "slow", status: null, code: "ETIMEDOUT" }]);
  const [call] = called;
  assert.equal(call.file, process.execPath);
  assert.equal(call.args[0], "-e");
  assert.ok(String(call.args[1]).startsWith("/* work-gate.ts runBatch */\n"), "the worker names its script on its first line (#4148): the ledger reads it there");
  assert.match(String(call.args[1]), /maxBuffer: 1024, timeout: Number\(process\.argv\[2\]\), killSignal: "SIGKILL"/);
  assert.deepEqual([call.args[2], call.args[3], call.options], [JSON.stringify(calls), "500", { timeoutMs: 5_500, env: { PATH: "/stub" } }]);
  const dead = injected({ status: null, stdout: "", stderr: "spawnSync node ETIMEDOUT" });
  assert.throws(() => runGhTogether(dead.deps, { calls, env: {}, callMs: 1, graceMs: 1, maxBuffer: 1 }), /^Error: the batch of 2 gh calls did not finish: spawnSync node ETIMEDOUT$/);
});

test("#4148: the batch worker NAMES ITSELF to the ledger (the 852 calls that read /usr/bin/node): the first line of its text is where the wrapper's cut command line finds a script", () => {
  const { called, deps } = injected({ status: 0, stdout: "[]", stderr: "" });
  runGhTogether(deps, { calls: [], env: {}, callMs: 1, graceMs: 1, maxBuffer: 1 });
  const cmdline = `/usr/bin/node -e ${String(called[0].args[1]).replace(/\s+/g, " ")}`.slice(0, 160); // the ledger keeps 160 characters of the caller
  assert.equal(callerScript(cmdline), "work-gate.ts");
  assert.equal(callerScript("/usr/bin/node -e const { execFile } = require(\"node:child_process\"); const one"), "/usr/bin/node", "the control: without the name it IS the unnamed caller");
});

// --- over a stub gh that really sleeps ----------------------------------------------------------------------------------------------------

const BOUND_MS = 400;
const SLACK_MS = 5_000;

/** Runs `body` with a stub `gh` first on PATH. `exec sleep` replaces the shell, so the kill reaches the sleeper and not an orphan holding the pipe. */
function withStub<T>(script: string, body: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "gate-runner-"));
  const outerPath = process.env.PATH;
  try {
    writeFileSync(join(dir, "gh"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, "gh"), 0o755);
    process.env.PATH = `${dir}:${outerPath}`;
    return body();
  } finally {
    process.env.PATH = outerPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a `gh` that never returns ends at the bound with ETIMEDOUT, while one that answers inside it is returned and one that is refused keeps its status", () => {
  withStub(`case "$1" in\n  hang) exec sleep 60 ;;\n  ok) echo answered ;;\n  *) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;\nesac`, () => {
    const run = gateRunner({ exec: realExec, log: () => undefined }, { timeoutMs: BOUND_MS, capture: true });
    const began = Date.now();
    const refusal = (() => { try { run(["hang"]); } catch (error) { return error as { code?: string }; } })();
    const tookMs = Date.now() - began;
    assert.equal(refusal?.code, "ETIMEDOUT");
    assert.ok(tookMs >= BOUND_MS && tookMs < BOUND_MS + SLACK_MS, `ended at the bound, not at the sleeper's minute: ${tookMs} ms`);
    assert.equal(run(["ok"]), "answered\n");
    const refused = (() => { try { run(["nope"]); } catch (error) { return error as { code?: string; status?: number | null }; } })();
    assert.deepEqual([refused?.status, refused?.code], [1, undefined]);
  });
});

test("a batch whose first call stalls ends at about the bound and the second call's answer is intact; a cut call answers as a refused one", () => {
  withStub(`if [ "$1" = stall ]; then echo "slow" >&2; exec sleep 30; fi\necho "$1"`, () => {
    const began = Date.now();
    const [cut, fine] = runGhTogether({ exec: realExec }, { calls: [{ args: ["stall"], repo: undefined }, { args: ["fine"], repo: undefined }], env: { ...process.env, GH_REPO: "" }, callMs: BOUND_MS, graceMs: 5_000, maxBuffer: 1024 * 1024 });
    assert.ok(Date.now() - began < 10_000, "the batch waited for the bound, not for the sleeper");
    assert.deepEqual(fine, { stdout: "fine\n" });
    assert.ok("failed" in cut);
    assert.deepEqual([cut.status, cut.code, cut.stderr], [null, "ETIMEDOUT", "slow\n"]);
  });
});
