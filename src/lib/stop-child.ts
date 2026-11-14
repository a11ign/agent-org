// no-token: none -- signals a child process this code started; nothing here reaches `gh`, `herdr` or `git`
/**
 * THE ONE WAY A CHILD PROCESS THIS CODE STARTED IS STOPPED (a11ign/agent-org#2034): SIGTERM, then SIGKILL once `graceMs` has passed, and the
 * promise resolves only once the process has EXITED. A caller that cleans up after it (a test's private TMPDIR, a capture's scratch directory)
 * therefore cannot race a process that is still shutting down and still writing. `capture-command.ts` and `scripts/loop-load.ts` both stop their
 * children through it, so the two cannot drift.
 */
import type { ChildProcess } from "node:child_process";

/** Stops `child` and resolves once it has exited: at once when it already has, else after SIGTERM, or SIGKILL when it outlives `graceMs`. */
export function stopChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((done) => {
    const killer = setTimeout(() => { child.kill("SIGKILL"); }, graceMs);
    child.once("exit", () => { clearTimeout(killer); done(); });
    child.kill("SIGTERM");
  });
}
