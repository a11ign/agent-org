// @ts-check
// module: how often the board's calls to Linear fail, over the last hour, for the board's log and for doctor (A11-359)
//
// THE BOARD WROTE NOTHING ABOUT ITS CALLS TO LINEAR, so two hours of `ECONNRESET` were found by a person reading the journal (A11-345, A11-359). Every attempt of a call is counted here, so a failure that a retry
// then covers still shows: a rate above one in a hundred means the connections are bad even though nothing visibly broke. The count is kept in memory for the hour, and a snapshot of it is written beside the
// board's state, where doctor (another process) reads it.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The window the rate is kept over. */
export const WINDOW_MS = 60 * 60 * 1000;
/** The file the snapshot is written to, in the state folder. */
export const CALLS_FILE = "linear-calls.json";
/** The longest a snapshot goes unwritten while calls are made. */
const WRITE_EVERY_MS = 15_000;
/** A failure is written sooner, so doctor sees a bad hour as it starts. */
const WRITE_AFTER_FAILURE_MS = 1_000;
/** The rate doctor flags: more than one failure in a hundred calls. */
export const FLAGGED_FAILURES = 1;
export const PER_CALLS = 100;

/** What the board wrote: when, over how long, and how many attempts were made and failed. */
export type CallCounts = Readonly<{ at: number; windowMs: number; calls: number; failures: number }>;

/** The log of attempts: `record` each, `counts` what the window holds. */
export type CallLog = Readonly<{ record: (failed: boolean) => CallCounts }>;

/** Whether `counts` is a rate to flag: more than one failure in a hundred calls, so two or more failures, and more than a hundredth of the calls. PURE. */
export const isFlagged = ({ calls, failures }: Pick<CallCounts, "calls" | "failures">): boolean => failures > FLAGGED_FAILURES && failures * PER_CALLS > calls * FLAGGED_FAILURES;

/** `counts` as a person reads it: `2 of 140 calls failed in the last hour (1.4%)`. PURE. */
export const describeCounts = ({ calls, failures }: Pick<CallCounts, "calls" | "failures">): string =>
  `${failures} of ${calls} calls failed in the last hour${calls === 0 ? "" : ` (${(failures * 100 / calls).toFixed(1)}%)`}`;

/** The snapshot as written, or null when `text` is none. PURE. */
export function readCounts(text: string): CallCounts | null {
  try {
    const found = JSON.parse(text) as Partial<CallCounts> | null;
    const numbers = [found?.at, found?.windowMs, found?.calls, found?.failures];
    return numbers.every((n) => typeof n === "number" && Number.isFinite(n)) ? found as CallCounts : null;
  } catch {
    return null;
  }
}

/**
 * A log kept over {@link WINDOW_MS}, written to `<stateDir>/linear-calls.json` at most every {@link WRITE_EVERY_MS} (and at once for the first). An empty `stateDir` writes nothing. A write that fails is not the
 * call's: the count goes on in memory.
 */
export function callLog({ stateDir, now = Date.now, write = writeFileSync }: Readonly<{ stateDir: string; now?: () => number; write?: typeof writeFileSync }>): CallLog {
  const attempts: { at: number; failed: boolean }[] = [];
  let wrote = Number.NEGATIVE_INFINITY;
  return {
    record(failed) {
      const at = now();
      attempts.push({ at, failed });
      while (attempts.length > 0 && attempts[0].at <= at - WINDOW_MS) attempts.shift();
      const counts: CallCounts = { at, windowMs: WINDOW_MS, calls: attempts.length, failures: attempts.filter((attempt) => attempt.failed).length };
      if (stateDir !== "" && at - wrote >= (failed ? WRITE_AFTER_FAILURE_MS : WRITE_EVERY_MS)) {
        wrote = at;
        try {
          const file = join(stateDir, CALLS_FILE);
          mkdirSync(dirname(file), { recursive: true });
          write(file, `${JSON.stringify(counts)}\n`);
        } catch {
          // the count is for a person to read: a state folder that cannot be written does not fail a call
        }
      }
      return counts;
    },
  };
}
