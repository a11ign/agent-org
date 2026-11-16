// module: the plugin's one way to run the GitHub CLI (A11-160) -- the only place in the repository a `gh` process is started
//
// A PLUGIN RUNS PROGRAMS THROUGH `deps.exec`, so a test injects the answer and core's `realExec` is the one that spawns. Two runners are made of it. `ghRunner` answers the text `gh`
// printed and THROWS when it fails (the shape every reader in this plugin was written over, since `execFileSync` threw), with the message `execFileSync` gave: the command, then
// what `gh` printed on stderr, so a reader that tests for `HTTP 404` in it still finds it. `accountRunner` never throws: it answers the status and the output, as the extension's
// ensure and check read them, and acts as one account.
//
// THE ASYNC RUNNERS, WHICH THE BOARD'S LOOP READS AND WRITES GITHUB THROUGH, MAKE EACH `gh` THROUGH THE BOARD'S OUTSIDE CLIENT (`deps.outside`, A11-436 step 2) where core hands one: the client cuts each attempt
// at its time, tries a `gh` that only reads and failed on the network or on GitHub again (a write is made once: {@link isRead}), refuses at once while GitHub's breaker is open, and counts the call once. Which failures those are is core's one rule, read off the
// program's exit; the plugin only hands it the exit. The synchronous runners make each call once: they are row mode's and `armMerge`'s, which nothing on the loop calls, and a retry's wait would hold the process.
import type { ExecOptions, ExecResult, PluginDeps } from "../../src/plugins/manifest.ts";
import type { ProgramExit } from "../../src/ticket-mode/outside-client.ts";
import type { Account, AsyncProgramRunner, Program, ProgramRunner } from "./stack-extension.ts";

/** A read of GitHub that answers its text and throws when `gh` fails. */
export type Gh = (args: string[]) => string;

/** {@link Gh} without holding the process still (A11-356): the answer arrives when `gh` has printed it, and the event loop goes on while it runs. Rejects where {@link Gh} throws. */
export type AsyncGh = (args: string[]) => Promise<string>;

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
  /** The exit core's one rule classes the failure by (`failureKindOf`): a reset or a 502 is transient, a 404 is GitHub's answer. */
  readonly exit: ProgramExit;
  constructor(args: readonly string[], result: ExecResult) {
    // A `gh` that could not start has no command to have failed: `execFileSync` threw the spawn error itself (`spawnSync gh ENOENT`), and so does this.
    super(result.status === null ? result.stderr : `Command failed: gh ${args.join(" ")}\n${result.stderr}`);
    this.status = result.status;
    this.stderr = result.stderr;
    this.stdout = result.stdout;
    this.exit = { status: result.status, stderr: result.stderr };
  }
}

/**
 * What a runner may be made with besides the account: `withoutEnv` names, when a call is made, the variables taken off its environment, and `echo` is told what `gh` printed on stderr, on success and on
 * failure alike, as `execFileSync` let it through to this process's own stderr (a row mode program's log says `! Pull request is already queued to merge` from it).
 */
export type RunnerOptions = Readonly<{ withoutEnv?: () => readonly string[]; echo?: (text: string) => void; timeoutMs?: number }>;

/** Runs `gh` with `args` as the process's own account, or as the one `env` names (with the variables `withoutEnv` names taken off), and answers its text. THROWS a {@link GhFailure} when it exits non-zero or cannot start. */
export function ghRunner(deps: Pick<PluginDeps, "exec">, env: Readonly<Record<string, string>> = {}, options: RunnerOptions = {}): Gh {
  return (args) => {
    const withoutEnv = options.withoutEnv?.() ?? [];
    const result = deps.exec("gh", args, { timeoutMs: options.timeoutMs ?? GH_TIMEOUT_MS, env, ...(withoutEnv.length === 0 ? {} : { withoutEnv }) });
    if (options.echo !== undefined && result.stderr !== "") options.echo(result.stderr.replace(/\n$/, ""));
    if (result.status !== 0) throw new GhFailure(args, result);
    return result.stdout;
  };
}

/**
 * How much later than `gh`'s own cut the client cuts an attempt, in ms: a `gh` that runs past its time is stopped by `exec` and answers no status, a {@link GhFailure} as it always was, and the client's cut
 * only ends an attempt whose `exec` never answers.
 */
const CLIENT_CUT_GRACE_MS = 1_000;

/**
 * One `gh` through the board's outside client when core handed one (`deps.outside`): tried again by core's one rule, refused at once while GitHub's breaker is open (the client's `ServiceUnavailable`, which says
 * GitHub is unavailable), and counted once by the client, so `exec` is told not to count it again. Without a client, `gh` runs once and `exec` counts it. It answers the last attempt's result.
 */
function runGh(deps: Pick<PluginDeps, "execAsync" | "outside">, args: readonly string[], options: ExecOptions): Promise<ExecResult> {
  const { outside } = deps;
  if (outside === undefined) return deps.execAsync("gh", args, options);
  return outside(() => deps.execAsync("gh", args, { ...options, countedByCaller: true }),
    { exitOf: (result) => result, attemptMs: (options.timeoutMs ?? GH_TIMEOUT_MS) + CLIENT_CUT_GRACE_MS, once: !isRead(args) });
}

/** The `gh` commands that only read: trying one again cannot repeat anything. */
const READ_COMMANDS = new Set(["pr view", "pr list", "pr checks", "pr diff", "pr status", "run view", "run list", "repo view", "extension list", "auth status", "issue view", "issue list", "workflow list", "workflow view",
  "release view", "release list"]);
const METHOD_FLAGS = new Set(["-X", "--method"]);
const FIELD_FLAGS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);
const MUTATION = /^query=\s*mutation\b/;

/**
 * Whether a `gh` call only reads, so the client may try it again (A11-436). `gh api` reads with GET, which it sends unless a method is named or a field is given; a GraphQL call reads unless its query is a
 * mutation. Any other command reads only when {@link READ_COMMANDS} names it: a command not named is taken to write, and is made once. PURE.
 */
export function isRead(args: readonly string[]): boolean {
  if (args[0] === "search") return true;
  if (args[0] !== "api") return READ_COMMANDS.has(args.slice(0, 2).join(" "));
  if (args.includes("graphql")) return !args.some((arg) => MUTATION.test(arg));
  const method = args.find((_, at) => at > 0 && METHOD_FLAGS.has(args[at - 1]));
  if (method !== undefined) return method.toUpperCase() === "GET";
  return !args.some((arg) => FIELD_FLAGS.has(arg));
}

/**
 * {@link ghRunner} over `deps.execAsync`: the same `gh`, the same cut, the same {@link GhFailure} (as a rejection), and the process is not held still while GitHub answers. The instance's loop reads GitHub only through this runner (A11-356),
 * and each call goes through the board's outside client ({@link runGh}): a call its breaker refuses rejects with the client's own error, which says GitHub is unavailable.
 */
export function asyncGhRunner(deps: Pick<PluginDeps, "execAsync" | "outside">, env: Readonly<Record<string, string>> = {}, options: RunnerOptions = {}): AsyncGh {
  return async (args) => {
    const withoutEnv = options.withoutEnv?.() ?? [];
    const result = await runGh(deps, args, { timeoutMs: options.timeoutMs ?? GH_TIMEOUT_MS, env, ...(withoutEnv.length === 0 ? {} : { withoutEnv }) });
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
  return (args): Program => programOf(args, deps.exec("gh", args, accountOptions(account)));
}

/**
 * {@link accountRunner} without holding the process still (A11-356): the instance's doctor rows ask GitHub through it. It runs `gh` directly, not through the board's outside client: a doctor row says what `gh`
 * answers now, which a breaker the loop opened would hide behind "unavailable" (and doctor's own failures would open it for the loop), and `exec` counts the call.
 */
export function asyncAccountRunner(deps: Pick<PluginDeps, "execAsync">, account: Account): AsyncProgramRunner {
  return async (args): Promise<Program> => programOf(args, await deps.execAsync("gh", args, accountOptions(account)));
}

const accountOptions = (account: Account): ExecOptions => ({ timeoutMs: GH_TIMEOUT_MS, env: account.GH_CONFIG_DIR === undefined ? {} : { GH_CONFIG_DIR: account.GH_CONFIG_DIR } });

/** What an account's runner answers of a program's result: a good call's output, or a failed one's status and the reason. */
function programOf(args: readonly string[], result: ExecResult): Program {
  if (result.status === 0) return { status: 0, stdout: result.stdout, stderr: "" };
  return { status: result.status, stdout: "", stderr: result.stderr || `Command failed: gh ${args.join(" ")}` };
}
