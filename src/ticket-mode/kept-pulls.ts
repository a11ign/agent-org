// @ts-check
// module: the pull requests the board opened for a ticket and has not seen settle (A11-286) -- PURE
//
// THE RUN LOG IS THE BOARD'S RECORD OF A TICKET'S PULL REQUESTS. An entry holds its pull requests only in the outcome or the review round that names them, so the next plan step, a re-queue for a replan or a retry, and a Remove followed by a
// new Queue each build an entry that holds none, and the watch (`watchFeedback`, which reads a finished run's) never read those pull requests again. The run log survives every one of them (`logEvent`, `GONE_LOGS_MAX`) and records each pull request
// the board opened (`pr-opened`) and each merge it saw (`merged`), so a ticket's pull requests are what its log opened, less what is known to have settled.
import { openPulls, pullsOf } from "./board-view/view-types-and-filters.ts";
import { parsePull } from "./board-view/pull-url.ts";
import { SETTLED, type Entry, type PullRequest, type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { logOf } from "./queue/run-log.ts";

/**
 * The pull requests ticket `key` has from the board that are still open as far as the board knows: those its run log opened and the entry holds (`pullsOf`), each once, less the ones the log saw merge, the ones the entry's last read of the tracker
 * says merged or closed, and the ones a read of the code host found merged or closed (`settled`, which the pool keeps in memory, so a closed pull request is read once for a process). A log address that is no pull request on the code host has no
 * repository to name, and is left out. PURE.
 */
export function keptPullsOf(queue: Queue, key: string, settled: ReadonlySet<string>): readonly PullRequest[] {
  const entry = queue.entries.find((e) => e.ticket.key === key);
  const events = logOf(queue, key);
  const merged = new Set(events.flatMap((event) => (event.kind === "merged" ? [event.url] : [])));
  const opened = events.flatMap((event) => (event.kind === "pr-opened" ? [event.url] : [])).flatMap((url): PullRequest[] => {
    const repo = parsePull(url)?.repo;
    return repo === undefined ? [] : [{ repo, url }];
  });
  const held = entry === undefined ? [] : pullsOf<PullRequest>(entry);
  const open = (url: string): boolean => !merged.has(url) && !settled.has(url) && entry?.pullStates?.[url] !== "merged" && entry?.pullStates?.[url] !== "closed";
  const seen = new Set<string>();
  return [...held, ...opened].filter(({ url }) => open(url) && !seen.has(url) && seen.add(url));
}

/**
 * The pull requests of `entry`'s ticket that `watchFeedback` does not read: all of the kept ones for an entry that is not finished, and the ones outside its own open pull requests for a finished one, whose outcome or round names only the
 * pull requests it ended on. PURE.
 */
export function unwatchedPullsOf(queue: Queue, entry: Entry, settled: ReadonlySet<string>): readonly PullRequest[] {
  const watched = new Set(entry.phase === "finished" ? openPulls(entry).map(({ url }) => url) : []);
  return keptPullsOf(queue, entry.ticket.key, settled).filter(({ url }) => !watched.has(url));
}

/** Every kept pull request of every ticket on the queue that the tracker has not settled, each once: what the board's `pulls` map lists whatever phase the run is in. PURE. */
export function boardPullsOf(queue: Queue, settled: ReadonlySet<string>): readonly PullRequest[] {
  const seen = new Set<string>();
  return queue.entries.filter((entry) => !SETTLED.has(entry.trackerState ?? "")).flatMap((entry) => keptPullsOf(queue, entry.ticket.key, settled)).filter(({ url }) => !seen.has(url) && seen.add(url));
}
