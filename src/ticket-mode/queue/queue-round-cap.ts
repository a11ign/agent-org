// @ts-check
// module: the cap on the board's own rounds -- PURE
import type { Entry } from "./queue-entries-and-outcomes.ts";

/** The most review rounds the board starts on its own, on new feedback, between two of a person's approvals. */
export const MAX_FEEDBACK_ROUNDS = 3;

/** Whether the board may start one more round of its own on `entry`: it has started fewer than {@link MAX_FEEDBACK_ROUNDS} since a person approved. */
export const roundsLeft = (entry: Entry): boolean => (entry.rounds ?? 0) < MAX_FEEDBACK_ROUNDS;
