// @ts-check
// module: a queued review round and the pull requests it names (A11-298) -- a pull request that merged or closed leaves the round, and a round left with none is dropped. PURE.
//
// ON 2026-10-25 A11-232 HAD A ROUND QUEUED FOR #18, and #18 merged at 13:57Z. The round never started (its ticket waited on A11-231), so nothing ended it, and `holds()` went on counting it: #18's files held every
// ticket of the repository for 30 hours. A finished run's pull requests are read by the tracker sweep (`recordPullStates`); a queued round is not finished, so these are read by the watch (`pool-round-pulls.ts`).
import type { PullState } from "../source.ts";
import { openPulls } from "../board-view/view-types-and-filters.ts";
import { find, replace, type Entry, type Queue } from "./queue-entries-and-outcomes.ts";
import { logEvent, logHas } from "./run-log.ts";
import { finish, recordPullStates } from "./queue-transitions.ts";

/** Whether a run is a queued review round: it answers the pull requests it names and has not started. A talk session is a person's, and keeps the pull requests it borrowed. PURE. */
const isQueuedRound = (entry: Entry): boolean => entry.phase === "queued" && entry.review !== undefined && entry.talk !== true && entry.plan === undefined;

/** The queued review rounds on the board. PURE. */
export const queuedRounds = (queue: Queue): Entry[] => queue.entries.filter(isQueuedRound);

/** Whether a state ends a pull request's part in a round: it merged, or it closed. */
const ended = (state: PullState | undefined): boolean => state === "merged" || state === "closed";

/** The open pull requests of a queued round that merged or closed, by URL, among the `states` the watch read. A pull request already read ended is no longer open, and is not settled twice. PURE. */
function settledPulls(entry: Entry, states: Readonly<Record<string, PullState>>): string[] {
  return openPulls(entry).map(({ url }) => url).filter((url) => ended(states[url]));
}

/** What the board did about the round of a ticket: the pull requests that left it, and whether the round went with them. */
export type RoundSettled = Readonly<{ left: readonly string[]; dropped: boolean }>;

/** What {@link settleRoundPulls} would do with the round of `key` given `states`, or null when none of its pull requests ended. PURE. */
export function roundSettled(queue: Queue, key: string, states: Readonly<Record<string, PullState>>): RoundSettled | null {
  const entry = find(queue, key);
  if (entry === undefined || !isQueuedRound(entry)) return null;
  const left = settledPulls(entry, states);
  if (left.length === 0) return null;
  return { left, dropped: left.length === openPulls(entry).length };
}

/** Log each pull request in `urls` merged, once: the log has not seen it merge. */
function logMerged(queue: Queue, key: string, urls: readonly string[], states: Readonly<Record<string, PullState>>, now: number): Queue {
  return urls.filter((url) => states[url] === "merged" && !logHas(queue, key, (event) => event.kind === "merged" && event.url === url))
    .reduce((next, url) => logEvent(next, key, now, { kind: "merged", url }), queue);
}

/**
 * The round of `key` with the states read of the pull requests that ended recorded in its `pullStates`, which is how a finished run's merged or closed pull requests stop being open ({@link openPulls}). They stay in `review`:
 * the run's record of what it answered keeps them, so a pull request closed with work no branch holds is still listed (A11-249), and the round's pull requests are all judged when it ends. PURE.
 */
const settle = (queue: Queue, key: string, left: readonly string[], states: Readonly<Record<string, PullState>>): Queue =>
  replace(queue, key, (round) => ({ ...round, pullStates: { ...round.pullStates, ...Object.fromEntries(left.map((url) => [url, states[url]])) } }));

/** The round of `key` ended as the finished run it continued: `reviewed` on its pull requests, which are recorded with the `states` read of them, for the sweep that settles a finished run. PURE. */
function drop(queue: Queue, entry: Entry, states: Readonly<Record<string, PullState>>, now: number): Queue {
  const review = entry.review ?? [];
  // What holds a queued round back, and since when, is not the finished run's.
  const { waitSince: _waiting, sessionWait: _session, stoppedForBlocker: _behind, ciHold: _held, pathsFailure: _plan, blockersFailure: _unread, ...round } = entry;
  const ended = finish(replace(queue, entry.ticket.key, () => round), entry.ticket.key, { kind: "reviewed", prs: review }, now);
  const read = review.flatMap(({ url }) => (states[url] === undefined ? [] : [[url, states[url]] as const]));
  return recordPullStates(ended, new Map([[entry.ticket.key, Object.fromEntries(read)]]), now);
}

/**
 * The queued round of `key` after the watch read its pull requests (`states`, by URL): a pull request that merged or closed is no longer one of its open pull requests and stops holding its files (see {@link settle}). A round left with a pull request
 * open goes on with that one. A round left with none is dropped: it answers nothing, so the ticket goes back to the board as the finished run it continued, ended on `reviewed` with its pull requests and their states, and
 * the sweep that settles a finished run completes the ticket, or queues its next plan step, from there. A round that is not queued, or whose pull requests are all still open, is left as it is. PURE.
 */
export function settleRoundPulls(queue: Queue, key: string, states: Readonly<Record<string, PullState>>, now: number): Queue {
  const settled = roundSettled(queue, key, states);
  const entry = find(queue, key);
  if (settled === null || entry === undefined) return queue;
  const logged = logMerged(queue, key, settled.left, states, now);
  return settled.dropped ? drop(logged, entry, states, now) : settle(logged, key, settled.left, states);
}
