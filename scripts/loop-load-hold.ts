// preload: a synchronous call that holds the board thread of loop-load's throwaway instance, for the test that proves the request thread answers while it is held (A11-282).
//
// The board thread used to hold itself: its tick read herdr's start from the service manager with a synchronous `systemctl`, and that call was what the test held. The board thread makes no such call now, so this stands
// in for ANY synchronous spawn it could make: when the test writes the START file, the main thread runs a shell that waits for the GATE file (at most HOLD_LIMIT_MS), and logs one line to LOG on the way in and one on the way out. It is a stand-in for the
// failure the request thread exists to survive, not part of the instance: nothing loads it but the throwaway environment `startThrowawayInstance` builds when it is asked to hold the board thread.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isMainThread } from "node:worker_threads";

/** How long the held call may last, in seconds: the cut the test's reads must fit inside. */
const HOLD_LIMIT_S = 5;
const POLL_MS = 50;
const { LOOP_LOAD_HOLD_START: start, LOOP_LOAD_HOLD_GATE: gate, LOOP_LOAD_HOLD_LOG: log } = process.env;

/** Whether this is the instance's board thread: the main thread of `ticket-mode/server.ts` (`bin.ts` starts it as a child), and the test asked to hold it. The programs the instance starts inherit this preload through NODE_OPTIONS, and would each hold themselves too. */
const holdsThisThread = (): boolean => isMainThread && (process.argv[1] ?? "").endsWith("ticket-mode/server.ts") && [start, gate, log].every((variable) => variable !== undefined);

if (holdsThisThread()) {
  const timer = setInterval(() => {
    if (!existsSync(start!)) return;
    clearInterval(timer);
    const polls = Math.round((HOLD_LIMIT_S * 1000) / POLL_MS);
    execFileSync("sh", ["-c", `echo held >> "$1"\ni=0\nwhile [ ! -e "$2" ] && [ "$i" -lt ${polls} ]; do sleep 0.05; i=$((i + 1)); done\necho released >> "$1"`, "sh", log!, gate!], { stdio: "ignore" });
  }, POLL_MS);
  timer.unref();
}
