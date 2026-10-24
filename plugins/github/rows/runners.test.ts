// no-token: none -- `exec` and `execAsync` answer from a table, and the real-process cases put a stub `gh` first on PATH: the real one is never reached
/**
 * A11-160 (step 8): THE RUNNERS A CALLER THAT KEEPS ITS OWN POLICY ASKS THE CODE HOST FOR. The board runs `gh` in the checkout with a 32 MiB buffer behind the leak guard, the retro cuts a read at its bound and throws away
 * stderr, the chairman's watch runs it as a promise behind a read-only allowlist, and the trace hands it a comment body on standard input. The policy is the caller's and the process is the plugin's: the first block runs the three
 * runners over injected seams and holds what each asks of the process, the second runs the real seams over a stub `gh` that records its arguments, its directory and its standard input.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, ExecResult } from "../../../src/plugins/manifest.ts";
import { realExec, realExecAsync } from "../../../src/plugins/real-seams.ts";
import { GhFailure } from "../gh.ts";
import { asyncRunnerWith, answeringRunnerWith, runnerWith } from "./runners.ts";

type Called = { file: string; args: readonly string[]; options: ExecOptions };

function injected(answer: ExecResult, env: Record<string, string | undefined> = {}) {
  const called: Called[] = [];
  const told: string[] = [];
  const answerWith = (file: string, args: readonly string[], options: ExecOptions = {}): ExecResult => { called.push({ file, args, options }); return answer; };
  return { called, told, deps: { exec: answerWith, execAsync: (file: string, args: readonly string[], options?: ExecOptions) => Promise.resolve(answerWith(file, args, options)), log: (line: string) => told.push(line), env } };
}

test("a runner asks the process for exactly the policy it names, and nothing it does not name", () => {
  const { called, deps } = injected({ status: 0, stdout: "answer", stderr: "" }, { GIT_DIR: "/hook/.git", GIT_WORK_TREE: "/hook", HOME: "/h" });
  assert.equal(runnerWith(deps)(["issue", "list"]), "answer");
  assert.equal(runnerWith(deps, { cwd: "/checkout", maxBuffer: 1024, timeoutMs: 5_000, withoutGitEnv: true })(["pr", "list"]), "answer");
  assert.deepEqual(called, [
    { file: "gh", args: ["issue", "list"], options: {} },
    { file: "gh", args: ["pr", "list"], options: { timeoutMs: 5_000, maxBuffer: 1024, cwd: "/checkout", withoutEnv: ["GIT_DIR", "GIT_WORK_TREE"] } },
  ]);
});

test("a guard that throws stops the call before a process is started, whichever runner it is on", async () => {
  const { called, deps } = injected({ status: 0, stdout: "x", stderr: "" });
  const guard = (args: readonly string[]) => { if (args.includes("comment")) throw new Error("chairman-watch reads only"); };
  assert.throws(() => runnerWith(deps, { guard })(["issue", "comment", "1"]), /reads only/);
  await assert.rejects(() => asyncRunnerWith(deps, { guard })(["issue", "comment", "1"]), /reads only/);
  assert.throws(() => answeringRunnerWith(deps, { guard })(["issue", "comment", "1"]), /reads only/);
  assert.deepEqual(called, [], "no process was started for a refused argument list");
  assert.equal(runnerWith(deps, { guard })(["issue", "view", "1"]), "x", "an argument list the guard admits runs");
});

test("what gh printed on stderr goes through unless the caller keeps it, on a success and on a failure alike; a failure throws what execFileSync threw", () => {
  const { deps, told } = injected({ status: 1, stdout: "partial", stderr: "gh: Not Found (HTTP 404)\n" });
  assert.throws(() => runnerWith(deps)(["api", "x"]), (error: unknown) => error instanceof GhFailure && error.status === 1 && error.stdout === "partial" && /^Command failed: gh api x\ngh: Not Found/.test(error.message));
  assert.deepEqual(told, ["gh: Not Found (HTTP 404)"], "the line is told once, without its newline");
  assert.throws(() => runnerWith(deps, { echo: false })(["api", "x"]), GhFailure);
  assert.deepEqual(told, ["gh: Not Found (HTTP 404)"], "echo: false tells nothing");
});

test("a call that was cut or could not start carries the spawn error's code, which a caller that keeps a budget tests for", () => {
  const cut = injected({ status: null, stdout: "", stderr: "spawnSync gh ETIMEDOUT", spawnError: "spawnSync gh ETIMEDOUT", signal: "SIGTERM" });
  assert.throws(() => runnerWith(cut.deps, { timeoutMs: 1 })(["api", "x"]), (error: unknown) => (error as { code?: string }).code === "ETIMEDOUT");
  const absent = injected({ status: null, stdout: "", stderr: "spawnSync gh ENOENT", spawnError: "spawnSync gh ENOENT" });
  assert.throws(() => runnerWith(absent.deps)(["api", "x"]), (error: unknown) => (error as { code?: string }).code === "ENOENT");
});

test("the async runner resolves with the text and rejects with the same error the sync runner throws", async () => {
  const ok = injected({ status: 0, stdout: "text", stderr: "" });
  assert.equal(await asyncRunnerWith(ok.deps, { timeoutMs: 60_000, maxBuffer: 64_000_000 })(["issue", "view", "1"]), "text");
  assert.deepEqual(ok.called[0]!.options, { timeoutMs: 60_000, maxBuffer: 64_000_000 });
  const failed = injected({ status: 1, stdout: "", stderr: "gh: Label does not exist (HTTP 404)\n" });
  await assert.rejects(() => asyncRunnerWith(failed.deps, { echo: false })(["api", "x"]), (error: unknown) => error instanceof GhFailure && /Label does not exist/.test((error as GhFailure).stderr));
});

test("the answering runner never throws: it answers the status and what was printed, the spawn error where there was one, and hands its input on", () => {
  const exited = injected({ status: 1, stdout: "headers", stderr: "gh: HTTP 304" });
  assert.deepEqual(answeringRunnerWith(exited.deps)(["api", "-i", "p"], { input: "the body" }), { status: 1, stdout: "headers", stderr: "gh: HTTP 304" });
  assert.deepEqual(exited.called[0]!.options, { input: "the body" });
  const absent = injected({ status: null, stdout: "", stderr: "spawnSync gh ENOENT", spawnError: "spawnSync gh ENOENT" });
  assert.deepEqual(answeringRunnerWith(absent.deps)(["api"]), { status: null, stdout: "", stderr: "spawnSync gh ENOENT", error: "spawnSync gh ENOENT" });
});

// --- the real seams over a stub gh ---------------------------------------------------------------------------------------------------

/** A directory with a `gh` first on PATH that records its arguments, its directory and its standard input, and answers `answer`. */
function stubGh(answer: string, { exitCode = 0, sleepSeconds = 0 }: { exitCode?: number; sleepSeconds?: number } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "runners-test-"));
  mkdirSync(join(scratch, "bin"));
  const log = join(scratch, "log");
  writeFileSync(join(scratch, "bin", "gh"), ["#!/bin/sh", `echo "args: $*" >> "${log}"`, `echo "cwd: $(pwd)" >> "${log}"`, `echo "git: \${GIT_DIR:-unset}" >> "${log}"`,
    `case "$*" in *"--body-file -"*) printf 'stdin: ' >> "${log}"; cat >> "${log}"; echo >> "${log}";; esac`, sleepSeconds > 0 ? `exec sleep ${sleepSeconds}` : ":", exitCode === 0 ? `echo '${answer}'` : `echo '${answer}' >&2`, `exit ${exitCode}`].join("\n"));
  chmodSync(join(scratch, "bin", "gh"), 0o755);
  const env = { PATH: `${join(scratch, "bin")}:${process.env.PATH}`, GIT_DIR: "/not/a/repo" };
  return { scratch, log, env, read: () => (existsSync(log) ? readFileSync(log, "utf8") : ""), done: () => rmSync(scratch, { recursive: true, force: true }) };
}

const realDeps = (env: Record<string, string>) => ({ exec: (file: string, args: readonly string[], options?: ExecOptions) => realExec(file, args, { ...options, env: { ...env, ...options?.env } }),
  execAsync: (file: string, args: readonly string[], options?: ExecOptions) => realExecAsync(file, args, { ...options, env: { ...env, ...options?.env } }), log: () => undefined, env });

test("REAL SEAMS: the process runs in the directory asked with the hook's git variables taken off; a body goes on standard input and not in an argument", () => {
  const gh = stubGh("ok");
  try {
    const here = mkdtempSync(join(tmpdir(), "runners-cwd-"));
    try {
      assert.equal(runnerWith(realDeps(gh.env), { cwd: here, withoutGitEnv: true, echo: false })(["api", "x"]).trim(), "ok");
      assert.equal(answeringRunnerWith(realDeps(gh.env), { echo: false })(["issue", "comment", "928", "--repo", "o/r", "--body-file", "-"], { input: "a body with a secret-looking 192.0.2.1 in it" }).status, 0);
      const log = gh.read();
      assert.match(log, /args: api x\ncwd: .*runners-cwd-.*\ngit: unset/, "the checkout is the directory and the hook's GIT_DIR is not seen");
      assert.match(log, /args: issue comment 928 --repo o\/r --body-file -\n/);
      assert.match(log, /stdin: a body with a secret-looking 192\.0\.2\.1 in it\n/);
      assert.ok(!/args:.*secret-looking/.test(log), "the body is not in the argument list");
    } finally {
      rmSync(here, { recursive: true, force: true });
    }
  } finally {
    gh.done();
  }
});

test("REAL SEAMS: a call that runs past its bound is cut, and the async runner does not hold the event loop while it runs", async () => {
  const gh = stubGh("late", { sleepSeconds: 5 });
  try {
    assert.throws(() => runnerWith(realDeps(gh.env), { timeoutMs: 300, echo: false })(["api", "x"]), (error: unknown) => (error as { code?: string }).code === "ETIMEDOUT");
    let ticked = 0;
    const timer = setInterval(() => { ticked += 1; }, 20);
    await assert.rejects(() => asyncRunnerWith(realDeps(gh.env), { timeoutMs: 400, echo: false })(["api", "y"]), (error: unknown) => (error as { code?: string }).code === "ETIMEDOUT");
    clearInterval(timer);
    assert.ok(ticked >= 3, `the event loop ran while the call was out (${ticked} ticks)`);
  } finally {
    gh.done();
  }
});

test("REAL SEAMS: a failed async call rejects with what gh printed on stderr and the status, so a caller that tests for a message in it finds it", async () => {
  const gh = stubGh("gh: Label does not exist (HTTP 404)", { exitCode: 1 });
  try {
    await assert.rejects(() => asyncRunnerWith(realDeps(gh.env), { echo: false })(["api", "--method", "DELETE", "x"]),
      (error: unknown) => error instanceof GhFailure && error.status === 1 && /Label does not exist/.test(error.stderr));
  } finally {
    gh.done();
  }
});

test("REAL SEAMS: a child that printed more than its buffer is reported as out of room and not as a timeout; a child stopped by a signal from outside has neither", async () => {
  const gh = stubGh("x".repeat(5000));
  try {
    const crowded = await realExecAsync("gh", ["api", "x"], { env: gh.env, maxBuffer: 100 });
    assert.equal(crowded.status, null);
    assert.match(crowded.spawnError ?? "", /ENOBUFS/);
    assert.doesNotMatch(crowded.spawnError ?? "", /ETIMEDOUT/);
    const slow = stubGh("late", { sleepSeconds: 5 });
    try {
      assert.match((await realExecAsync("gh", ["api", "x"], { env: slow.env, timeoutMs: 200 })).spawnError ?? "", /ETIMEDOUT/);
    } finally {
      slow.done();
    }
    writeFileSync(join(gh.scratch, "bin", "gh"), "#!/bin/sh\nkill -9 $$\n");
    const stopped = await realExecAsync("gh", ["api", "x"], { env: gh.env });
    assert.equal(stopped.status, null);
    assert.equal(stopped.spawnError, undefined, "no spawn error: the child started and was stopped from outside");
    assert.equal(stopped.signal, "SIGKILL");
  } finally {
    gh.done();
  }
});

test("a runner that names no bound passes none on, so the process's own default of ten minutes applies (A11-160, step 9)", () => {
  const { called, deps } = injected({ status: 0, stdout: "answer", stderr: "" });
  runnerWith(deps, {})(["api", "graphql"]);
  assert.equal(called[0]!.options.timeoutMs, undefined, "no bound is named, so none is passed on");
  // The default is `realExec`'s, not the plugin's 30 s for its own reads: a caller that had no bound (the settle's population read) is cut at ten minutes.
  const source = readFileSync(new URL("../../../src/plugins/real-seams.ts", import.meta.url), "utf8");
  assert.match(source, /const DEFAULT_EXEC_MS = 600_000;/);
  assert.match(source, /options\.timeoutMs \?\? DEFAULT_EXEC_MS/);
});
