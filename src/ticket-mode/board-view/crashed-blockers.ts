// @ts-check
// module: a blocker whose run crashed, as the cards say it (A11-399) -- PURE
//
// ON 2026-10-28 A11-231 crashed on the network three times and stayed crashed for two days, and A11-232 sat queued behind it: its card read as an ordinary wait for a partial merge. A run that crashed holds the tickets
// blocked on it, so both cards say so: the blocked one "Waits on A11-231, which crashed", and the crashed one which tickets wait on it and what the board does next. Split from `pull-status-and-notes.ts`, whose public API is at
// its limit; the runs a blocker's ticket may still have at work are defined here, because `crashedRunOf` leaves a ticket with a live run to `liveRunOf`. Like the rest of `board-view/`, it is sent to the browser.
import { recentRestarts, restartFreeAt } from "../crash-retry.ts";
import { retryTime } from "../queue/start-reads.ts";
import type { ViewBlocker, ViewEntry } from "./view-types-and-filters.ts";
import { isStoppedFor } from "./waits-on.ts";

/** A parked run: a finished one that kept its herdr workspace, so a person can still answer its agent there. It holds no slot. */
export const isParked = (entry: ViewEntry): boolean => entry.phase === "finished" && entry.workspace !== undefined;

/** Whether a run is at work or waits on a question: it has not finished, or it has and its workspace is still held ({@link isParked}). */
const isAtWork = (run: Omit<ViewEntry, "talkFrom">): boolean => run.phase !== "finished" || isParked(run);

/**
 * The run of a blocker's ticket that is still at work, or null (A11-206): one queued, starting or running (planning, working, in a review round or waiting on a question), or finished but parked on a question,
 * whose workspace is still held ({@link isParked}). More of that ticket's work may come from it, whatever its pull requests did so far. A talk session is a person talking to a finished run, not more work on the
 * ticket, so it is judged by the run it resumed (`talkFrom`). PURE.
 */
export function liveRunOf(key: string, entries: readonly ViewEntry[]): Omit<ViewEntry, "talkFrom"> | null {
  for (const entry of entries.filter((e) => e.ticket.key === key)) {
    const judged = entry.talk === true ? entry.talkFrom : entry;
    if (judged !== undefined && isAtWork(judged)) return judged;
  }
  return null;
}

/** The finished, crashed run of ticket `key`, or null when it has none or a run of the ticket is at work ({@link liveRunOf} takes precedence: its card keeps its own wording). PURE. */
export function crashedRunOf(key: string, entries: readonly ViewEntry[]): ViewEntry | null {
  if (liveRunOf(key, entries) !== null) return null;
  return entries.find((entry) => entry.ticket.key === key && entry.phase === "finished" && entry.outcome?.kind === "crashed") ?? null;
}

/**
 * Whether `blocker` holds `entry` because its run crashed. A blocker the worker stopped for, and one a person decides about (canceled, a duplicate), are said in their own words, whatever their last run did. PURE.
 */
export const isCrashedBlocker = (entry: ViewEntry, blocker: ViewBlocker, entries: readonly ViewEntry[]): boolean =>
  !isStoppedFor(entry, blocker) && blocker.state !== "canceled" && blocker.state !== "duplicate" && crashedRunOf(blocker.key, entries) !== null;

/** How a card of a ticket blocked on a crashed run says the wait. PURE. */
export const crashedWait = (key: string): string => `Waits on ${key}, which crashed`;

/** The keys joined as a sentence: `A`, `A and B`, `A, B and C`. */
const joined = (keys: readonly string[]): string => (keys.length < 2 ? keys.join("") : `${keys.slice(0, -1).join(", ")} and ${keys[keys.length - 1]}`);

/** What the board does next about a crashed run, as the second clause of its note says it. A run with no mark is one a person retries. PURE. */
function nextStep({ crashRetry }: ViewEntry, now: number | undefined): string {
  if (crashRetry?.retryAt !== undefined) return `the board starts it again at ${retryTime(crashRetry.retryAt)}`;
  const notBefore = crashRetry?.recovery?.notBefore;
  if (notBefore === undefined) return "a person retries it";
  const at = now ?? notBefore;
  const freeAt = restartFreeAt(crashRetry?.recovery, at);
  if (freeAt === undefined) return `the board starts it again once its network calls succeed, not before ${retryTime(notBefore)}`;
  const restarts = recentRestarts(crashRetry?.recovery, at).length;
  return `the board has restarted it ${restarts} times today and starts it again after ${retryTime(Math.max(notBefore, freeAt))}`;
}

/**
 * The line on a crashed run's own card when queued tickets wait on it (`waiting`, their keys, which the caller reads from `waitsOn`), such as `A11-232 waits on A11-231, which crashed; the board starts it again once its network calls
 * succeed, not before 12:30Z`, or null when none does: a crashed run nothing waits on has no line. `now` is the viewer's clock, which tells whether the day's bound is used. PURE.
 */
export function crashedHoldsNote(entry: ViewEntry, waiting: readonly string[], now?: number): string | null {
  if (waiting.length === 0) return null;
  return `${joined(waiting)} ${waiting.length === 1 ? "waits" : "wait"} on ${entry.ticket.key}, which crashed; ${nextStep(entry, now)}`;
}
