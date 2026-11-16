// module: the real `deps.execAsync` a command run from a checkout gives the plugin's runner (`stack-live-check-command.ts`, `merge-flow-command.ts`)
//
// A COMMAND IS NOT GIVEN CORE'S DEPS: it runs `gh` through the plugin's own async runner, with this `spawn` for `deps.execAsync`, since a plugin imports core's types only (ADR 0001).
// It answers what the `spawnSync` it replaced answered (A11-433), without holding the process still while the program runs.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { ExecOptions, ExecResult } from "../../src/plugins/manifest.ts";

/** The most a program may print before the command stops reading it. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

type Child = ChildProcessByStdio<null, Readable, Readable>;

/** What `child` prints on stdout and stderr, kept until together it passes {@link MAX_OUTPUT_BYTES}, as `spawnSync` bounded it; `overflowed` is called on a chunk past that, and the chunk is dropped. */
function collectOutput(child: Child, overflowed: () => void): () => { stdout: string; stderr: string } {
  let bytes = 0;
  const keep = (stream: Readable) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) overflowed();
      else chunks.push(chunk);
    });
    return () => Buffer.concat(chunks).toString("utf8");
  };
  const stdout = keep(child.stdout);
  const stderr = keep(child.stderr);
  return () => ({ stdout: stdout(), stderr: stderr() });
}

/**
 * Runs a program for real, without holding the event loop: its status (null when it could not start, ran past `timeoutMs` or printed more than {@link MAX_OUTPUT_BYTES}, with the reason in stderr) and what
 * it printed. A program that a signal ended answers a null status and what it printed. Never rejects.
 */
export function commandExecAsync(file: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((done) => {
    const child = spawn(file, [...args], { env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
    // A cut program is answered at once, as `spawnSync` returned: its pipes are let go, so a grandchild still holding them cannot keep the answer waiting for `close`.
    const stop = (code: string) => {
      clearTimeout(timer);
      child.kill("SIGTERM");
      child.stdout.destroy();
      child.stderr.destroy();
      done({ status: null, stdout: "", stderr: `spawn ${file} ${code}` });
    };
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => stop("ETIMEDOUT"), options.timeoutMs);
    const printed = collectOutput(child, () => stop("ENOBUFS"));
    child.once("error", (error) => {
      clearTimeout(timer);
      done({ status: null, stdout: "", stderr: error.message });
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      done({ status, ...printed() });
    });
  });
}
