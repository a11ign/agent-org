// module: the runners the plugin makes for a caller that keeps its own policy (A11-160, step 8; moved from the spawns of `board-data`, `board-document`, `board-truth-audit`, `dora`, `org-retro`, `messaging/*` and `trace/*`)
//
// A CALLER OF ROW MODE THAT RUNS `gh` ITSELF (the board's reads, the retro's, the trace's, the chairman's watch) kept a spawn of its own with the working directory, the buffer, the bound and the stderr it wanted. The process
// is the plugin's now, and the policy is what the caller asks for: where it runs, how much it may print, how long it may take, whether the git variables of a hook are taken off, and a `guard` that refuses an argument list
// before it is run (core's leak guard, the chairman's read-only allowlist). Each runner goes through `deps.exec` or `deps.execAsync`, so a test injects the answer and core's real seams are the ones that spawn.
//   - `runnerWith` answers the text `gh` printed and THROWS when it fails, as `execFileSync` did (`failureOf`: the status, stderr and stdout, and `code` for a call that was cut or could not start).
//   - `asyncRunnerWith` is the same, answered as a promise, for a caller that must not hold the process still (the chairman's listener).
//   - `answeringRunnerWith` never throws: it answers the status and what was printed, for a caller that reads the status line of the answer itself (`gh api -i`), and takes the text for standard input.
import type { RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { AnsweringRun, AsyncRowsRun, RunnerRequest } from "../../../src/plugins/contracts/code-host-rows-facts.ts";
import type { ExecOptions, PluginDeps } from "../../../src/plugins/manifest.ts";
import { failureOf, printedByGh } from "./gate-runner.ts";

type Seams = Pick<PluginDeps, "exec" | "execAsync" | "log" | "env">;

/** The variables a hook sets (`GIT_DIR`, `GIT_WORK_TREE`, ...), which would aim a `gh` started from a worktree at the wrong repository. */
const gitVariablesOf = (env: Readonly<Record<string, string | undefined>>): string[] => Object.keys(env).filter((name) => name.startsWith("GIT_"));

/** What the request asks of `deps.exec`, and nothing it does not ask: a bound, a buffer and a directory only when they are named. */
function execOptionsOf(deps: Seams, request: RunnerRequest): ExecOptions {
  const withoutEnv = request.withoutGitEnv === true ? gitVariablesOf(deps.env) : [];
  return {
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.maxBuffer === undefined ? {} : { maxBuffer: request.maxBuffer }),
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(withoutEnv.length === 0 ? {} : { withoutEnv }),
  };
}

/** Runs `gh` as the process's own account with what `request` asks, and answers its text. THROWS as {@link failureOf} says; what `gh` printed on stderr goes through to this process's own unless `echo` is false. */
export function runnerWith(deps: Seams, request: RunnerRequest = {}): RowsRun {
  return (args) => {
    request.guard?.(args);
    const result = deps.exec("gh", args, execOptionsOf(deps, request));
    if (request.echo !== false && printedByGh(result)) deps.log(result.stderr.replace(/\n$/, ""));
    if (result.status === 0) return result.stdout;
    throw failureOf(args, result);
  };
}

/** {@link runnerWith}, answered as a promise: a refusal rejects with the same error. The guard throws before anything is started, as a rejection. */
export function asyncRunnerWith(deps: Seams, request: RunnerRequest = {}): AsyncRowsRun {
  return async (args) => {
    request.guard?.(args);
    const result = await deps.execAsync("gh", args, execOptionsOf(deps, request));
    if (request.echo !== false && printedByGh(result)) deps.log(result.stderr.replace(/\n$/, ""));
    if (result.status === 0) return result.stdout;
    throw failureOf(args, result);
  };
}

/** Runs `gh` and answers how it ended, never throwing: the status (`null` when it could not start or was cut), what it printed, and the spawn error where there was one. `options.input` is written to its standard input. */
export function answeringRunnerWith(deps: Seams, request: RunnerRequest = {}): AnsweringRun {
  return (args, options = {}) => {
    request.guard?.(args);
    const result = deps.exec("gh", args, { ...execOptionsOf(deps, request), ...(options.input === undefined ? {} : { input: options.input }) });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, ...(result.spawnError === undefined ? {} : { error: result.spawnError }) };
  };
}
