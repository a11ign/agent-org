// The poll's schedule is `reconnect.ts`'s, which the board page applies too; it is re-exported so the client's callers and tests keep this path.
export { MAX_BACKOFF_MS, MIN_BACKOFF_MS, nextDelay, POLL_MS } from "../../../src/ticket-mode/board-view/reconnect.ts";
