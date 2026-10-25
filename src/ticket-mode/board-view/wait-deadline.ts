// @ts-check
// module: when a run's wait ends (A11-245, A11-272) -- the one rule the board's wake and the card's "until 16:30" both read. PURE. Like the rest of `board-view/`, it is sent to the browser as one script with its relative imports dropped.

/** How long a run waiting on background work may sit idle past its `working` outcome, when the outcome gives no `until`: three hours. */
export const BACKGROUND_WAIT_MS = 3 * 60 * 60_000;

/** The time (ms) a waiting note's wait ends: the `until` its outcome gave, whatever it is, or {@link BACKGROUND_WAIT_MS} after the outcome file was written, so a newer outcome starts it again. PURE. */
export const deadlineOf = ({ at, until }: Readonly<{ at: number; until?: number }>): number => until ?? at + BACKGROUND_WAIT_MS;
