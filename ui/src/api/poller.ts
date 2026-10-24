import { failedToSend, type Answer } from "./answer.ts";
import { nextDelay } from "./poll-schedule.ts";

/**
 * What a poll needs: a read that takes the signal to drop it by, and where each answer goes. `repeat: false` makes it a one-shot read: a success schedules no
 * further read (a failure still backs off and tries again), and only `refresh` reads again.
 */
export type PollerOptions<T> = Readonly<{ read: (signal: AbortSignal) => Promise<Answer<T>>; onAnswer: (answer: Answer<T>) => void; repeat?: boolean }>;

/**
 * A running poll: `refresh` reads now ("Check now", "Retry"), forgets the failures in a row so a failure it meets waits 2s, and resolves to that answer, or to the answer of the read already in flight, or to null when the read is dropped,
 * and `stop` ends the poll, dropping a read still in flight.
 */
export type Poller<T> = Readonly<{ refresh: () => Promise<Answer<T> | null>; stop: () => void }>;

const hidden = (): boolean => document.visibilityState === "hidden";

/**
 * Read, then wait and read again: after a success the wait is 5s, after the n-th failure in a row it is 2s doubling to 60s, and a success starts over. The next
 * read is scheduled when an answer arrives, never on a fixed interval, so a slow answer cannot pile reads up. While the page is hidden nothing is scheduled; when
 * it is shown again, or its window gains focus, the failures in a row are forgotten and the read is made at once. A read still in flight then, or when `refresh` is
 * asked, is left to finish and its answer is the fresh one; a read still in flight when the poll stops is dropped.
 * A one-shot poll (`repeat: false`) that has read successfully waits for `refresh`: neither the clock, nor the page being shown again, nor the window's focus reads it.
 */
export function startPolling<T>({ read, onAnswer, repeat = true }: PollerOptions<T>): Poller<T> {
  let failuresInARow = 0;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Readonly<{ controller: AbortController; answer: Promise<Answer<T> | null> }> | undefined;

  const cancelTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const scheduleNext = () => {
    cancelTimer();
    if (!hidden()) timer = setTimeout(readNow, nextDelay(failuresInARow));
  };
  async function settle(controller: AbortController): Promise<Answer<T> | null> {
    const answer = await read(controller.signal).catch(failedToSend);
    if (controller.signal.aborted) return null;
    inFlight = undefined;
    failuresInARow = answer.ok ? 0 : failuresInARow + 1;
    settled = !repeat && answer.ok;
    onAnswer(answer);
    if (!settled) scheduleNext();
    return answer;
  }
  function readNow(): Promise<Answer<T> | null> {
    cancelTimer();
    if (inFlight !== undefined) return inFlight.answer;
    const controller = new AbortController();
    const answer = settle(controller);
    inFlight = { controller, answer };
    return answer;
  }
  const readAfterWaking = () => {
    if (hidden() || settled) return;
    failuresInARow = 0;
    void readNow();
  };
  /** "Check now": the backoff starts over, then the read is made now (or joins the one in flight, which then counts as the first failure). */
  const refresh = (): Promise<Answer<T> | null> => {
    failuresInARow = 0;
    return readNow();
  };
  const onVisibility = () => (hidden() ? cancelTimer() : readAfterWaking());

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", readAfterWaking);
  if (!hidden()) void readNow();
  return {
    refresh,
    stop: () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", readAfterWaking);
      cancelTimer();
      inFlight?.controller.abort();
    },
  };
}
