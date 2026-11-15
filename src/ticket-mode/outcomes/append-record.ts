// @ts-check
// module: appending an outcome record from the pool (A11-430) -- a record that cannot be written is said on the board's log, and the run's end or review, which the queue holds already, stands

import { log, messageOf } from "../pool-state.ts";
import { appendOutcome, type OutcomeRecord, outcomesPath } from "./outcome-record.ts";

/** Append `record` to the outcome log in `stateDir`, or say on the board's log why it could not be written. */
export function appendOutcomeSaying(stateDir: string, record: OutcomeRecord): void {
  const path = outcomesPath(stateDir);
  try {
    appendOutcome(path, record);
  } catch (err) {
    log(`${record.ticket}: its outcome record could not be written to ${path} (${messageOf(err)})`);
  }
}
