// @ts-check
// module: a queued review round and the pull requests it names (A11-298) -- a pull request that merged or closed leaves the round, and a round left with none is dropped. PURE.
//
// ON 2026-10-25 A11-232 HAD A ROUND QUEUED FOR #18, and #18 merged at 13:57Z. The round never started (its ticket waited on A11-231), so nothing ended it, and `holds()` went on counting it: #18's files held every
// ticket of the repository for 30 hours. A finished run's pull requests are read by the tracker sweep (`recordPullStates`); a queued round is not finished, so these are read by the watch (`pool-round-pulls.ts`).
import type { PullState } from "../source.ts";
import { find, replace, type Entry, type Queue } from "./queue-entries-and-outcomes.ts";
import { logEvent, logHas } from "./run-log.ts";
import { finish, recordPullStates } from "./queue-transitions.ts";

/** Whether a run is a queued review round: it answers the pull requests it names and has not started. A talk session is a person's, and keeps the pull requests it borrowed. PURE. */
const isQueuedRound = (entry: Entry): boolean => entry.phase === "queued" && entry.review !== undefined && entry.talk !== true && entry.plan === undefined;

/** The queued review rounds on the board. PURE. */
export const queuedRounds = (queue: Queue): Entry[] => queue.entries.filter(isQueuedRound);

/** Whether a state ends a pull request's part in a round: it merged, or it closed. */
const ended = (state: PullState | undefined): boolean => state === "merged" || state === "closed";

/** The pull requests of a queued round that merged or closed, by URL, among the `states` the watch read. PURE. */
function settledPulls(entry: Entry, states: Readonly<Record<string, PullState>>): string[] {
  return (entry.review ?? []).map(({ url }) => url).filter((url) => ended(states[url]));
}

/** What the board did about the round of a ticket: the pull requests that left it, and whether the round went with them. */
export type RoundSettled = Readonly<{ left: readonly string[]; dropped: boolean }>;

/** What {@link settleRoundPulls} would do with the round of `key` given `states`, or null when none of its pull requests ended. PURE. */
export function roundSettled(queue: Queue, key: string, states: Readonly<Record<string, PullState>>): RoundSettled | null {
  const entry = find(queue, key);
  if (entry === undefined || !isQueuedRound(entry)) return null;
  const left = settledPulls(entry, states);
  if (left.length === 0) return null;
  return { left, dropped: left.length === (entry.review ?? []).length };
}

/** Log each pull request in `urls` merged, once: the log has not seen it merge. */
function logMerged(queue: Queue, key: string, urls: readonly string[], states: Readonly<Record<string, PullState>>, now: number): Queue {
  return urls.filter((url) => states[url] === "merged" && !logHas(queue, key, (event) => event.kind === "merged" && event.url === url))
    .reduce((next, url) => logEvent(next, key, now, { kind: "merged", url }), queue);
}

/** The round of `key` without the pull requests `left`, which go on with the ones still open. PURE. */
const prune = (queue: Queue, key: string, left: readonly string[]): Queue =>
  replace(queue, key, (round) => ({ ...round, review: (round.review ?? []).filter(({ url }) => !left.includes(url)) }));

/** The round of `key` ended as the finished run it continued: `reviewed` on its pull requests, which are recorded with the `states` read of them, for the sweep that settles a finished run. PURE. */
function drop(queue: Queue, entry: Entry, states: Readonly<Record<string, PullState>>, now: number): Queue {
  const review = entry.review ?? [];
  const { waitSince: _waiting, ...round } = entry;
  const ended = finish(replace(queue, entry.ticket.key, () => round), entry.ticket.key, { kind: "reviewed", prs: review }, now);
  const read = review.flatMap(({ url }) => (states[url] === undefined ? [] : [[url, states[url]] as const]));
  return recordPullStates(ended, new Map([[entry.ticket.key, Object.fromEntries(read)]]), now);
}

/**
 * The queued round of `key` after the watch read its pull requests (`states`, by URL): a pull request that merged or closed leaves the round's `review` and stops holding its files. A round left with a pull request
 * open goes on with that one. A round left with none is dropped: it answers nothing, so the ticket goes back to the board as the finished run it continued, ended on `reviewed` with its pull requests and their states, and
 * the sweep that settles a finished run completes the ticket, or queues its next plan step, from there. A round that is not queued, or whose pull requests are all still open, is left as it is. PURE.
 */
export function settleRoundPulls(queue: Queue, key: string, states: Readonly<Record<string, PullState>>, now: number): Queue {
  const settled = roundSettled(queue, key, states);
  const entry = find(queue, key);
  if (settled === null || entry === undefined) return queue;
  const logged = logMerged(queue, key, settled.left, states, now);
  return settled.dropped ? drop(logged, entry, states, now) : prune(logged, key, settled.left);
}
