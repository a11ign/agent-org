// module: the plugin's one way to run the GitHub CLI (A11-160) -- the only place in the repository a `gh` process is started
//
// A PLUGIN RUNS PROGRAMS THROUGH `deps.exec`, so a test injects the answer and core's `realExec` is the one that spawns. Two runners are made of it. `ghRunner` answers the text `gh`
// printed and THROWS when it fails (the shape every reader in this plugin was written over, since `execFileSync` threw), with the message `execFileSync` gave: the command, then
// what `gh` printed on stderr, so a reader that tests for `HTTP 404` in it still finds it. `accountRunner` never throws: it answers the status and the output, as the extension's
// ensure and check read them, and acts as one account.
import type { ExecResult, PluginDeps } from "../../src/plugins/manifest.ts";
import type { Account, Program, ProgramRunner } from "./stack-extension.ts";

/** A read of GitHub that answers its text and throws when `gh` fails. */
export type Gh = (args: string[]) => string;

/** How long one `gh` call may run before it is cut: the same cut the instance has always given one. */
export const GH_TIMEOUT_MS = 30_000;

/**
 * A `gh` call that did not succeed: its arguments, the status it exited with (null when it could not start) and what it printed on stderr and on stdout. `stdout` is kept because a refused call can still
 * answer: `gh api graphql -i` exits non-zero on a rate-limit refusal and prints the headers that say when the pool returns, which `rawResponse` (api-pool.ts) reads off a thrown error's `stdout`, as it did off `execFileSync`'s.
 */
export class GhFailure extends Error {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
  constructor(args: readonly string[], result: ExecResult) {
    // A `gh` that could not start has no command to have failed: `execFileSync` threw the spawn error itself (`spawnSync gh ENOENT`), and so does this.
    super(result.status === null ? result.stderr : `Command failed: gh ${args.join(" ")}\n${result.stderr}`);
    this.status = result.status;
    this.stderr = result.stderr;
    this.stdout = result.stdout;
  }
}

/**
 * What a runner may be made with besides the account: `withoutEnv` names, when a call is made, the variables taken off its environment, and `echo` is told what `gh` printed on stderr, on success and on
 * failure alike, as `execFileSync` let it through to this process's own stderr (a row mode program's log says `! Pull request is already queued to merge` from it).
 */
export type RunnerOptions = Readonly<{ withoutEnv?: () => readonly string[]; echo?: (text: string) => void }>;

/** Runs `gh` with `args` as the process's own account, or as the one `env` names (with the variables `withoutEnv` names taken off), and answers its text. THROWS a {@link GhFailure} when it exits non-zero or cannot start. */
export function ghRunner(deps: Pick<PluginDeps, "exec">, env: Readonly<Record<string, string>> = {}, options: RunnerOptions = {}): Gh {
  return (args) => {
    const withoutEnv = options.withoutEnv?.() ?? [];
    const result = deps.exec("gh", args, { timeoutMs: GH_TIMEOUT_MS, env, ...(withoutEnv.length === 0 ? {} : { withoutEnv }) });
    if (options.echo !== undefined && result.stderr !== "") options.echo(result.stderr.replace(/\n$/, ""));
    if (result.status !== 0) throw new GhFailure(args, result);
    return result.stdout;
  };
}

/**
 * Runs `gh` as `account`: its status and its output, never a throw. A call that did not succeed has no output and says why, as it did when the runner was made of one that threw: what `gh`
 * printed on stderr, else the command that failed (`Command failed: gh extension list`), so the reason a caller quotes is never empty.
 */
export function accountRunner(deps: Pick<PluginDeps, "exec">, account: Account): ProgramRunner {
  return (args): Program => {
    const result = deps.exec("gh", args, { timeoutMs: GH_TIMEOUT_MS, env: account.GH_CONFIG_DIR === undefined ? {} : { GH_CONFIG_DIR: account.GH_CONFIG_DIR } });
    if (result.status === 0) return { status: 0, stdout: result.stdout, stderr: "" };
    return { status: result.status, stdout: "", stderr: result.stderr || `Command failed: gh ${args.join(" ")}` };
  };
}
