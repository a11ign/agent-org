// @ts-check
// module: the seams a plugin runs on a real machine -- programs, file modes, a probe of a port, and where the host keeps what a code host renders (A11-159, A11-160)
//
// Split from `active.ts` so the code host row mode loads on its own (`code-host-slot.ts`) can use them without loading the activation, whose graph holds the gate.
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ExecOptions, ExecResult, HostPlaceReading, ProbeRequest } from "./manifest.ts";

/** How long a program may run when its caller names no limit: a Keychain prompt a person is reading, or a marketplace add, takes minutes. */
const DEFAULT_EXEC_MS = 600_000;

/** The most a program may print: the GitHub CLI's listings are large, and the default of one megabyte would cut a long one off as a failure. */
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Runs `file` for real: the program's exit status (null when it could not start, with the reason in stderr) and what it printed. `inherit` gives it this process's terminal, and `env` is
 * laid over this process's environment for the run.
 */
export function realExec(file: string, args: readonly string[], options: ExecOptions = {}): ExecResult {
  const timeout = options.timeoutMs ?? DEFAULT_EXEC_MS;
  const env = { ...process.env, ...options.env };
  for (const name of options.withoutEnv ?? []) delete env[name];
  const result = options.inherit === true
    ? spawnSync(file, [...args], { stdio: "inherit", encoding: "utf8", env })
    : spawnSync(file, [...args], { encoding: "utf8", timeout, env, maxBuffer: EXEC_MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error !== undefined) return { status: null, stdout: "", stderr: result.error.message };
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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
