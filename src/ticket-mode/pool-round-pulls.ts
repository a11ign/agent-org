// @ts-check
// module: the watch of a queued review round's pull requests (A11-298) -- one that merged or closed leaves the round, and a round left with none is dropped
//
// A queued round is not finished, so the tracker sweep that records a finished run's pull request states (`recordPullStates`) never reads it, and `holds()` went on counting a merged pull request's files for 30 hours.
// The code host is asked about each pull request a queued round names, on the feedback cadence, and `settleRoundPulls` (`queue/queue-round-pulls.ts`) applies what it says.
import { pullLabel } from "./board-view/pull-label.ts";
import { type PoolContext } from "./pool-context.ts";
import { log, messageOf, update } from "./pool-state.ts";
import { queuedRounds, roundSettled, settleRoundPulls } from "./queue/queue-round-pulls.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
import type { PullState } from "./source.ts";

/** The host's words for a pull request's state, as the board records it. */
const STATES: Readonly<Record<string, PullState>> = { OPEN: "open", MERGED: "merged", CLOSED: "closed" };

/** The state of each pull request the round names that the host could say, by URL. One it cannot say is left out, and the next watch asks again. */
function readStates(ctx: PoolContext, entry: Entry): Record<string, PullState> {
  const states: Record<string, PullState> = {};
  for (const { url } of entry.review ?? []) {
    try {
      const state = STATES[ctx.codeHost.readPullState(url) ?? ""];
      if (state !== undefined) states[url] = state;
    } catch (err) {
      log(`${entry.ticket.key}: the state of ${url} could not be read (${messageOf(err).split("\n")[0]}), so its queued round keeps it; the next watch asks again`);
    }
  }
  return states;
}

/**
 * Read the state of every pull request each queued review round names. A pull request that merged or closed leaves the round and holds nothing; a round left with none is dropped, and its ticket goes back to the board as the
 * finished run it continued, which the tracker sweep completes or queues for its next step. Said in the log, once, when it happens.
 */
export function settleQueuedRounds(ctx: PoolContext): void {
  const { now, store } = ctx;
  for (const entry of queuedRounds(store.get())) {
    const key = entry.ticket.key;
    const states = readStates(ctx, entry);
    const settled = roundSettled(store.get(), key, states);
    if (settled === null) continue;
    update(ctx, (queue) => settleRoundPulls(queue, key, states, now()));
    const named = settled.left.map((url) => `${pullLabel(url)} ${states[url]}`).join(", ");
    log(`${key}: ${named}, so ${settled.dropped ? "its queued round was dropped and the ticket is back on the board for the next step" : "it left the queued round, which goes on with the pull requests still open"}`);
  }
}
