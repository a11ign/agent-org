// @ts-check
// module: the seams a plugin runs on a real machine -- programs, file modes, a probe of a port, and where the host keeps what a code host renders (A11-159, A11-160)
//
// Split from `active.ts` so the code host row mode loads on its own (`code-host-slot.ts`) can use them without loading the activation, whose graph holds the gate.
//
// A TEST NEVER RUNS THE REAL `tailscale` (A11-279). On 2026-10-25 a test that switched a plugin off reached the real Tailscale plugin's `release` through this `exec`, and it removed the agents
// host's live serves (the board on :9443 and the terminals on :9444) twice. The plugin imports core's types only (ADR 0001), so it cannot tell this `exec` from a test's stand-in: the refusal
// sits here, before anything is spawned.
import { execFile, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename } from "node:path";
import { RUN_ROOT_ENV } from "../private-tmp.ts";
import type { ExecOptions, ExecResult, HostPlaceReading, ProbeRequest } from "./manifest.ts";

/** How long a program may run when its caller names no limit: a Keychain prompt a person is reading, or a marketplace add, takes minutes. */
const DEFAULT_EXEC_MS = 600_000;

/** The most a program may print: the GitHub CLI's listings are large, and the default of one megabyte would cut a long one off as a failure. */
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;

/** The variable a test sets to `1` to run a `tailscale` on purpose (a shim on `PATH`), under the test runner. */
export const TAILSCALE_OPT_IN_ENV = "A11Y_TESTS_MAY_RUN_TAILSCALE";

/** What a `tailscale` refused under the test runner answers. */
export const TAILSCALE_UNDER_TESTS = `refused: a test never runs the real tailscale (A11-279); inject a stand-in exec, or set ${TAILSCALE_OPT_IN_ENV}=1 on purpose`;

/**
 * Why `file` must not run in an environment of `env`, or null when it may: `tailscale` is refused while the test runner's run root is set (only rstest's globalSetup sets `A11Y_PRIVATE_TMP_RUN`),
 * unless the test opted in. The run root and not the base is the marker, because a base may be set in any shell, where `agent-org doctor` must still read the machine's real serves.
 */
export function refuseUnderTests(file: string, env: Readonly<Record<string, string | undefined>>): string | null {
  if (basename(file) !== "tailscale" || !env[RUN_ROOT_ENV] || env[TAILSCALE_OPT_IN_ENV] === "1") return null;
  return TAILSCALE_UNDER_TESTS;
}

/** The environment a program runs in: this process's, with `env` laid over it and `withoutEnv` taken out. */
function envOf(options: ExecOptions): NodeJS.ProcessEnv {
  const env = { ...process.env, ...options.env };
  for (const name of options.withoutEnv ?? []) delete env[name];
  return env;
}

/** The answer of a program that was never started, with the reason. */
const notStarted = (why: string): ExecResult => ({ status: null, stdout: "", stderr: why, spawnError: why, signal: null });

/**
 * Runs `file` for real: the program's exit status (null when it could not start, with the reason in stderr) and what it printed. `inherit` gives it this process's terminal, and `env` is
 * laid over this process's environment for the run.
 */
export function realExec(file: string, args: readonly string[], options: ExecOptions = {}): ExecResult {
  const timeout = options.timeoutMs ?? DEFAULT_EXEC_MS;
  const env = envOf(options);
  const refused = refuseUnderTests(file, env);
  if (refused !== null) return notStarted(refused);
  const result = options.inherit === true
    ? spawnSync(file, [...args], { stdio: "inherit", encoding: "utf8", env, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) })
    : spawnSync(file, [...args], { encoding: "utf8", timeout, env, maxBuffer: options.maxBuffer ?? EXEC_MAX_BUFFER, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }), ...(options.killSignal === undefined ? {} : { killSignal: options.killSignal }) });
  if (result.error !== undefined) return { status: null, stdout: "", stderr: result.error.message, spawnError: result.error.message, signal: result.signal };
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", signal: result.signal };
}

/**
 * {@link realExec} without holding this process still: the program runs under `execFile`, so the event loop goes on while it does. It answers as `realExec` does and never rejects: a program that cannot start answers no status and
 * the reason in `stderr` and `spawnError`; one cut at its bound answers `spawnError` naming `ETIMEDOUT`, and one that printed more than `maxBuffer` names `ENOBUFS`.
 */
export function realExecAsync(file: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
  const env = envOf(options);
  const refused = refuseUnderTests(file, env);
  if (refused !== null) return Promise.resolve(notStarted(refused));
  return new Promise((done) => {
    execFile(file, [...args], { encoding: "utf8", timeout: options.timeoutMs ?? DEFAULT_EXEC_MS, env, maxBuffer: options.maxBuffer ?? EXEC_MAX_BUFFER, ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.killSignal === undefined ? {} : { killSignal: options.killSignal }) }, (error, stdout, stderr) => {
      if (error === null) return done({ status: 0, stdout, stderr, signal: null });
      const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null };
      if (typeof failure.code === "number") return done({ status: failure.code, stdout, stderr, signal: failure.signal ?? null });
      // Node kills a child it ran out of patience with (`killed`: its bound) or out of room for (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`); a child stopped by a signal from outside has neither a code nor a spawn error.
      const code = failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "ENOBUFS" : failure.killed === true ? "ETIMEDOUT" : undefined;
      if (code === undefined && failure.signal != null) return done({ status: null, stdout, stderr, signal: failure.signal });
      const spawnError = code === undefined ? failure.message : `spawn ${file} ${code}`;
      done({ status: null, stdout, stderr: spawnError, spawnError, signal: failure.signal ?? null });
    });
  });
}

/** A file's permission bits, or null when it cannot be read. */
export function realMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

/**
 * GETs `/` of `host:port` for real: the status, or null when nothing answered within the time (a refused connection, a failed handshake, a timeout). `servername` and `hostHeader` let a
 * plugin reach a machine by its address and still name it, as a browser does by its name.
 */
export function realProbe({ host, port, tls, servername, hostHeader, timeoutMs }: ProbeRequest): Promise<number | null> {
  return new Promise((done) => {
    const options = { host, port, path: "/", method: "GET", timeout: timeoutMs, ...(servername === undefined ? {} : { servername }), ...(hostHeader === undefined ? {} : { headers: { Host: hostHeader } }) };
    const call = (tls ? httpsRequest : httpRequest)(options, (response) => {
      response.resume();
      done(response.statusCode ?? null);
    });
    call.on("timeout", () => call.destroy());
    call.on("error", () => done(null));
    call.end();
  });
}

/** Where this machine's host file says it keeps what a code host's wrapper is rendered from: read when asked, so the host file's reader is imported only by a process that asks (doctor's rows). */
export const realPlace = (): Promise<HostPlaceReading> => import("./host-place.ts").then(({ readHostPlace }) => readHostPlace())
  .catch((cause: unknown): HostPlaceReading => ({ kind: "unreadable", reason: String((cause as Error)?.message ?? cause).split("\n")[0] }));
