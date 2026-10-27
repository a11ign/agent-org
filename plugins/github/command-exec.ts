// module: the real `deps.exec` a command run from a checkout gives the plugin's runner (`stack-live-check-command.ts`, `merge-flow-checks.ts`)
//
// A COMMAND IS NOT GIVEN CORE'S DEPS: it runs `gh` through the plugin's own runner, with this `spawnSync` for `deps.exec`, since a plugin imports core's types only (ADR 0001).
import { spawnSync } from "node:child_process";
import type { ExecOptions, ExecResult } from "../../src/plugins/manifest.ts";

/** The most a program may print before the command stops reading it. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Runs a program for real: its status (null when it could not start, with the reason in stderr) and what it printed. */
export function commandExec(file: string, args: readonly string[], options: ExecOptions = {}): ExecResult {
  const result = spawnSync(file, [...args], { encoding: "utf8", timeout: options.timeoutMs, env: { ...process.env, ...options.env }, maxBuffer: MAX_OUTPUT_BYTES, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error !== undefined) return { status: null, stdout: "", stderr: result.error.message };
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
