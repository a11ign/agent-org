// @ts-check
// module: the wrapper every service command's entry runs its `main` through, so an exit with the work unfinished says which command it was (A11-225)
//
// NODE ENDS A PROCESS WITH EXIT CODE 13 WHEN THE EVENT LOOP EMPTIES WHILE A TOP-LEVEL `await` IS STILL PENDING, and says only "Detected unsettled top-level await" with a file and a line. The person
// at the terminal learns neither the command nor what it had done. `runCommand` holds a listener on the process's `exit` while the body has not settled: if the process exits first, it writes one line
// naming the command. It cannot resume the lost work, so the exit code stays Node's 13 and a script still sees the failure.
import type { EventEmitter } from "node:events";

/** The exit code Node gives a process whose event loop emptied while a top-level `await` was pending. An exit with any other code is a decision, and not this. */
const UNSETTLED_AWAIT_EXIT = 13;

/** The part of `process` the wrapper uses; a test passes a stand-in. */
export type CommandProcess = EventEmitter & { exitCode?: number | string | null; stderr: { write: (text: string) => unknown } };

/**
 * Run `body`, set the process's exit code from its result, and name `label` on stderr if the process exits before `body` settled.
 * @param label the command as the person typed it, such as `start herdr --move`
 * @returns once `body` settled
 */
export async function runCommand(label: string, body: () => Promise<number>, proc: CommandProcess = process): Promise<void> {
  const onExit = (code: number): void => {
    if (code !== UNSETTLED_AWAIT_EXIT) return;
    proc.stderr.write(`agent-org ${label}: ended before it finished, waiting on something nothing could finish (Node exit ${code}). This is a bug in agent-org: what it printed above was done, and nothing after it was.\n`);
  };
  proc.on("exit", onExit);
  try {
    proc.exitCode = await body();
  } finally {
    proc.off("exit", onExit);
  }
}
