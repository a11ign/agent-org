// @ts-check
// module: the commands a host asks to pass before a worker starts -- `tickets.preflight`, run by the pool, shown by the board, checked by doctor
//
// A MACHINE'S OWN CONDITION FOR STARTING WORK, WITH NOTHING OF IT IN THIS REPOSITORY. A host may name commands that must exit 0 before a ticket run starts: a login that
// has to be fresh, a disk that must have room, a service that must answer. A command that fails holds every run in the queue, which stays Queued, and the board says
// which command and what it printed, so a worker is never started into a failure it cannot fix. A command that passes costs nothing for a minute afterwards.
// This module knows no tool: the command is the host's, run by `sh -c`, and the first line it prints is the reason shown. A command must never print a secret.
//
// ABSENT, IT CHANGES NOTHING: a host with no `tickets.preflight` runs no command and holds no run.
import { execFile } from "node:child_process";

/** One command a host asks to pass before a run starts: the name the board shows, the shell command, and how long it may take. */
export type Preflight = Readonly<{ name: string; run: string; timeoutSeconds: number }>;

/** What a command did: its exit status (null when it was killed), whether it ran out of time, and what it printed. */
export type PreflightRun = Readonly<{ status: number | null; timedOut: boolean; output: string }>;

/** Run one shell command, with `timeoutMs` to answer. Injected, so a test runs no process. */
export type PreflightExec = (command: string, timeoutMs: number) => Promise<PreflightRun>;

/** Why runs are held: the command that failed, and the first line it printed or what became of it. */
export type Held = Readonly<{ name: string; reason: string; since: number }>;

/** The longest a command may be given, and the default. */
export const MAX_TIMEOUT_SECONDS = 600;
export const DEFAULT_TIMEOUT_SECONDS = 120;
/** How long a pass stands before the command is asked again, and how long a failure waits before the next try. */
export const PASS_FRESH_MS = 60_000;
export const FAIL_RETRY_MS = 60_000;
/** The longest reason the board shows. */
export const REASON_CHARS = 300;

/** What a command's own words are cleaned of before the board shows them: terminal colour codes. */
// eslint-disable-next-line no-control-regex -- an escape sequence is exactly what this removes
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** The first line a command printed, with no colour and at most {@link REASON_CHARS} characters, or null when it printed nothing. */
export function firstLine(output: string): string | null {
  const line = output.replace(ANSI, "").split("\n").map((l) => l.trim()).find((l) => l !== "");
  return line === undefined ? null : line.slice(0, REASON_CHARS);
}

/** The words that say why a run did not pass: what the command printed, or how it ended. PURE. */
export function reasonOf(run: PreflightRun, timeoutSeconds: number): string {
  if (run.timedOut) return firstLine(run.output) ?? `did not finish within ${timeoutSeconds} s`;
  return firstLine(run.output) ?? (run.status === null ? "was stopped before it finished" : `exited ${run.status} and printed nothing`);
}

/** What one pass over the commands came to: all passed, or the first that did not. */
export type PreflightResult = Readonly<{ ok: true }> | Readonly<{ ok: false; name: string; reason: string }>;

/** Run each command in order and stop at the first that does not exit 0. A command that cannot be started counts as failed, with its error as the reason. */
export async function runPreflights(list: readonly Preflight[], exec: PreflightExec): Promise<PreflightResult> {
  for (const { name, run, timeoutSeconds } of list) {
    let result: PreflightRun;
    try {
      result = await exec(run, timeoutSeconds * 1000);
    } catch (err) {
      return { ok: false, name, reason: String((err as Error)?.message ?? err).split("\n")[0].slice(0, REASON_CHARS) };
    }
    if (result.status !== 0 || result.timedOut) return { ok: false, name, reason: reasonOf(result, timeoutSeconds) };
  }
  return { ok: true };
}

/**
 * The gate the pool asks before it starts a run. A pass stands for {@link PASS_FRESH_MS}, and a failure is tried again only after {@link FAIL_RETRY_MS}, so
 * a slow command is not run at every tick. Two asks at once share one run. With no commands it always passes and runs nothing.
 */
export function createGate(list: readonly Preflight[], exec: PreflightExec, now: () => number = Date.now) {
  let settled: { at: number; result: PreflightResult } | null = null;
  let asking: Promise<PreflightResult> | null = null;
  let since: number | null = null;

  async function check(): Promise<PreflightResult> {
    if (list.length === 0) return { ok: true };
    if (settled !== null && now() - settled.at < (settled.result.ok ? PASS_FRESH_MS : FAIL_RETRY_MS)) return settled.result;
    asking ??= runPreflights(list, exec).then((result) => {
      settled = { at: now(), result };
      since = result.ok ? null : (since ?? now());
      return result;
    }).finally(() => { asking = null; });
    return asking;
  }

  /** Why runs are held now, or null while nothing is. */
  function held(): Held | null {
    return settled !== null && !settled.result.ok && since !== null ? { name: settled.result.name, reason: settled.result.reason, since } : null;
  }

  return { check, held };
}

/** The real executor: `sh -c` in the instance's own environment, with its output captured and no input. Resolves, whatever the exit status. */
export const shellPreflight: PreflightExec = (command, timeoutMs) => new Promise((done, fail) => {
  const child = execFile("sh", ["-c", command], { timeout: timeoutMs, encoding: "utf8", maxBuffer: 1_000_000 }, (error, stdout, stderr) => {
    const output = `${stdout}${stderr}`;
    if (error === null) return done({ status: 0, timedOut: false, output });
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string; signal?: string | null };
    if (typeof failure.code === "string" && failure.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return fail(failure);
    done({ status: typeof failure.code === "number" ? failure.code : null, timedOut: failure.killed === true && failure.signal === "SIGTERM", output });
  });
  child.stdin?.end();
});
