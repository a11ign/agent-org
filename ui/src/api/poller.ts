import { failedToSend, type Answer } from "./answer.ts";
import { nextDelay } from "./poll-schedule.ts";

/** What a poll needs: a read that takes the signal to drop it by, and where each answer goes. */
export type PollerOptions<T> = Readonly<{ read: (signal: AbortSignal) => Promise<Answer<T>>; onAnswer: (answer: Answer<T>) => void }>;

/** A running poll: `refresh` reads now ("Check now"), and `stop` ends it, dropping a read still in flight. */
export type Poller = Readonly<{ refresh: () => void; stop: () => void }>;

const hidden = (): boolean => document.visibilityState === "hidden";

/**
 * Read, then wait and read again: after a success the wait is 5s, after the n-th failure in a row it is 2s doubling to 60s, and a success starts over. The next
 * read is scheduled when an answer arrives, never on a fixed interval, so a slow answer cannot pile reads up. While the page is hidden nothing is scheduled; when
 * it is shown again the read is made at once. A read that is still in flight when the poll stops or `refresh` is asked again is dropped.
 */
export function startPolling<T>({ read, onAnswer }: PollerOptions<T>): Poller {
  let failuresInARow = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: AbortController | undefined;

  const cancelTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const scheduleNext = () => {
    cancelTimer();
    if (!hidden()) timer = setTimeout(readNow, nextDelay(failuresInARow));
  };
  async function readNow() {
    cancelTimer();
    if (inFlight !== undefined) return;
    const mine = new AbortController();
    inFlight = mine;
    const answer = await read(mine.signal).catch(failedToSend);
    if (mine.signal.aborted) return;
    inFlight = undefined;
    failuresInARow = answer.ok ? 0 : failuresInARow + 1;
    onAnswer(answer);
    scheduleNext();
  }
  const onVisibility = () => {
    if (hidden()) return cancelTimer();
    void readNow();
  };

  document.addEventListener("visibilitychange", onVisibility);
  if (!hidden()) void readNow();
  return {
    refresh: () => void readNow(),
    stop: () => {
      document.removeEventListener("visibilitychange", onVisibility);
      cancelTimer();
      inFlight?.abort();
    },
  };
}
