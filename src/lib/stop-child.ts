// no-token: none -- signals a child process this code started, and its process group; nothing here reaches `gh`, `herdr` or `git`
/**
 * THE ONE WAY A CHILD PROCESS THIS CODE STARTED IS STOPPED (a11ign/agent-org#2034): SIGTERM, then SIGKILL once `graceMs` has passed, and the
 * promise resolves only once the process has EXITED. A caller that cleans up after it (a test's private TMPDIR, a capture's scratch directory)
 * therefore cannot race a process that is still shutting down and still writing. `capture-command.ts` and `scripts/loop-load.ts` both stop their
 * children through it, so the two cannot drift.
 *
 * A CHILD THAT STARTS PROGRAMS OF ITS OWN IS STOPPED WITH ITS WHOLE PROCESS GROUP (A11-449). `stopChild` waits for the child alone: what the child
 * started (`bin.ts`'s `ticket:serve`, and that one's stand-in `gh` and `herdr` calls) outlived it, re-parented, and wrote on after the caller had
 * cleaned up. `stopGroup` stops a child started with `detached: true` (so it leads a group of its own) as `stopChild` does, then kills what is left
 * of its group, and resolves only once nothing in the group is left.
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

/** How often `stopGroup` looks whether the group is gone. */
const GROUP_POLL_MS = 20;
/** How long `stopGroup` waits for a killed group to be gone (reaped) before it says what is left. */
const GROUP_GONE_MS = 5_000;

/** Whether the process `pid` is still there (not yet reaped), or, for a negative `pid`, any process of the group `-pid` leads. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Sends `signal` to every process of the group `pgid` leads; a group that is gone already is not an error. */
export function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // the group has ended already
  }
}

/**
 * Stops `child`, which leads a process group of its own (started with `detached: true`), and every process of that group: the child as `stopChild` does, so
 * it shuts down in order, then SIGKILL to what it left behind. Resolves `true` once no process of the group is left, or `false` when one is still there
 * after `goneMs` (one nobody reaps, say), so a caller can say so. It never rejects: a caller that stops in a `finally` keeps the failure it is reporting.
 */
export async function stopGroup(child: ChildProcess, graceMs: number, goneMs: number = GROUP_GONE_MS): Promise<boolean> {
  await stopChild(child, graceMs);
  const pgid = child.pid;
  if (pgid === undefined) return true;
  signalGroup(pgid, "SIGKILL");
  const until = Date.now() + goneMs;
  while (isRunning(-pgid)) {
    if (Date.now() >= until) return false;
    await new Promise((done) => setTimeout(done, GROUP_POLL_MS));
  }
  return true;
}
