// module: the plugin's `gh` for the work gate's executor -- the one process the gate's reads and writes run as (A11-160, step 6; moved from `src/work-gate/reads/read-memo-and-exit.ts`)
//
// The gate's EXECUTOR is core's: it decides what is asked twice (the tick's memo), what a GraphQL read costs (the tick's budget), which repository a call is aimed at and how long a call may take. The process
// that is started is the plugin's. `gateRunner` is one call, run to completion or cut at a bound, and `runGhTogether` is several started at once so they wait together. Both run through `deps.exec`, so a test
// injects the answer and core's `realExec` is the one that spawns.
import type { BatchAnswer, BatchCall, GateRunOptions } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { ExecResult, PluginDeps } from "../../../src/plugins/manifest.ts";
import { GhFailure } from "../gh.ts";

/** The most one `gh` call may print before it is refused: 32 MiB, as the gate has always allowed. */
const GATE_MAX_BUFFER = 32 * 1024 * 1024;

/** `ETIMEDOUT`, `ENOENT`, `ENOBUFS`: the code `execFileSync` put on the error of a program that was cut or could not start. */
const SPAWN_CODE = /\b(E[A-Z]+)\b/;

/**
 * What `execFileSync` threw for a `gh` that did not succeed. One that EXITED is a {@link GhFailure} (the status, stderr and stdout, and a message that holds the command and what gh printed). One that was CUT or could
 * not start has the spawn error for its message and no stderr of its own (`refusalOf` then names the signal that stopped it), and carries `code` (`ETIMEDOUT` for a call that hit the bound, which is a refusal every
 * reader already turns into `null` for ITS lane) and `signal`. One stopped by a signal with no spawn error (an out-of-memory kill) says which command failed.
 */
export function failureOf(args: readonly string[], result: ExecResult): GhFailure {
  if (result.status !== null) return new GhFailure(args, result);
  if (result.spawnError === undefined) return Object.assign(new GhFailure(args, { ...result, status: 1 }), { status: null, signal: result.signal });
  const code = SPAWN_CODE.exec(result.spawnError)?.[1];
  return Object.assign(new GhFailure(args, { ...result, stderr: result.spawnError }), { stderr: "", signal: result.signal, ...(code === undefined ? {} : { code }) });
}

/** Whether `stderr` is gh's own: not the spawn error `realExec` puts there when a program was cut or could not start. */
export const printedByGh = (result: ExecResult): boolean => result.spawnError === undefined && result.stderr !== "";

/**
 * `gh`, run to completion or cut at `timeoutMs` and killed with SIGKILL (a `gh` that has hung is not one that answers a polite request). A call that does not succeed throws {@link failureOf}. What gh prints on stderr
 * goes through to this process's own unless the call is `capture`d (a read whose refusal is an answer the caller handles), as `execFileSync` let it through.
 */
export function gateRunner(deps: Pick<PluginDeps, "exec" | "log">, { timeoutMs, capture }: GateRunOptions): (args: string[], repo?: string) => string {
  return (args, repo) => {
    const result = deps.exec("gh", args, { timeoutMs, killSignal: "SIGKILL", maxBuffer: GATE_MAX_BUFFER, ...(repo === undefined ? {} : { env: { GH_REPO: repo } }) });
    if (!capture && printedByGh(result)) deps.log(result.stderr.replace(/\n$/, ""));
    if (result.status === 0) return result.stdout;
    throw failureOf(args, result);
  };
}

/**
 * The `node` one batch runs: each call through ASYNC `execFile` so they wait together, answers printed as one JSON list in the order asked. `GH_REPO` aims a call exactly as the single runner does, so the
 * census (preloaded through `NODE_OPTIONS`) still counts each `gh` by repository.
 *
 * (#4148) THE FIRST LINE NAMES THE SCRIPT. The wrapper records the calling process's command line cut at 160 characters, and a `node -e <code>` has nothing in it that is a file, so 12% of the ledger's calls read
 * `/usr/bin/node` and belonged to no one. The comment is what the ledger's script-name pattern finds.
 */
const batchWorker = (maxBuffer: number): string => `/* work-gate.ts runBatch */
const { execFile } = require("node:child_process");
const one = ({ args, repo }) => new Promise((done) => execFile("gh", args,
  { encoding: "utf8", maxBuffer: ${maxBuffer}, timeout: Number(process.argv[2]), killSignal: "SIGKILL",
    env: repo === undefined ? process.env : { ...process.env, GH_REPO: repo } },
  (error, stdout, stderr) => done(error === null ? { stdout }
    : { failed: true, stdout, stderr, status: typeof error.code === "number" ? error.code : null,
        code: error.killed ? "ETIMEDOUT" : typeof error.code === "string" ? error.code : undefined })));
Promise.all(JSON.parse(process.argv[1]).map(one)).then((answers) => process.stdout.write(JSON.stringify(answers)));
`;

/**
 * (#3566, slice 2) `gh` CALLS ASKED TOGETHER WAIT TOGETHER. ONE synchronous spawn of a `node` that starts the calls at once costs the slowest of them instead of their sum. EACH CALL IS CUT AT `callMs`: a cut call
 * answers as a refused one (`failed`, `status: null`, `code: "ETIMEDOUT"`), so every caller's fail-open verdict stands and the other calls' answers are intact. The worker's own wait is `graceMs` longer, so it
 * reports the call it cut before it is killed; if it is killed anyway, this THROWS and the caller runs its calls one by one.
 */
export function runGhTogether(deps: Pick<PluginDeps, "exec" | "log">, { calls, env, callMs, graceMs, maxBuffer }: { calls: BatchCall[]; env: NodeJS.ProcessEnv; callMs: number; graceMs: number; maxBuffer: number }): BatchAnswer[] {
  const result = deps.exec(process.execPath, ["-e", batchWorker(maxBuffer), JSON.stringify(calls), String(callMs)], { timeoutMs: callMs + graceMs, killSignal: "SIGKILL", maxBuffer, env: definedOnly(env) });
  if (result.stderr !== "" && result.spawnError === undefined) deps.log(result.stderr.replace(/\n$/, ""));
  if (result.status !== 0) {
    const reason = result.spawnError ?? (result.stderr.trim().split("\n")[0] || `status ${result.status}`);
    const code = SPAWN_CODE.exec(result.spawnError ?? "")?.[1];
    throw Object.assign(new Error(`the batch of ${calls.length} gh calls did not finish: ${reason}`), code === undefined ? {} : { code });
  }
  return JSON.parse(result.stdout);
}

/** The variables an environment holds, without the ones set to nothing: `ExecOptions.env` is laid over this process's and takes text only. */
function definedOnly(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
