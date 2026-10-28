// @ts-check
// module: how long the instance lets runs finish starting before it ends (A11-363)
//
// A RESTART KEEPS RUNNING RUNS RUNNING because their agents live in herdr's own service and the instance takes every pane herdr lists back when it starts (`pool-readopt.ts`). The one thing a restart can lose is a run
// whose agent is NOT OPEN YET: it is `starting`, and the instance that ends in that moment leaves herdr nothing to list, so the next instance queues it again (`why: restart`, A11-294). A stopping instance therefore waits
// for its starting runs, at most STARTS_WAIT_MS, before it exits. A wedged loop never reaches this, and the service manager ends the instance at its stop timeout as it always did.
import { setTimeout as sleep } from "node:timers/promises";

/** The longest a stopping instance waits for its runs to finish starting, in ms: inside the service manager's stop timeouts, systemd's 90 s and launchd's 20 s. */
export const STARTS_WAIT_MS = 15_000;
/** How often the count of starting runs is looked at while waiting, in ms. */
export const STARTS_POLL_MS = 250;

export type StartsWait = Readonly<{
  /** How many runs are starting now. */
  starting: () => number;
  /** Waits `ms`. */
  wait?: (ms: number) => Promise<unknown>;
  now?: () => number;
  limitMs?: number;
}>;

/** Waits until no run is starting, or `limitMs` has passed. Answers how many runs were still starting when it stopped waiting (0: none). */
export async function untilNoneStarting({ starting, wait = (ms) => sleep(ms), now = Date.now, limitMs = STARTS_WAIT_MS }: StartsWait): Promise<number> {
  const deadline = now() + limitMs;
  for (let left = starting(); left > 0; left = starting()) {
    if (now() >= deadline) return left;
    await wait(STARTS_POLL_MS);
  }
  return 0;
}
