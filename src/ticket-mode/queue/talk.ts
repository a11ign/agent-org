import { isParked, runActions } from "../board-view/pull-status-and-notes.ts";
import { find, replace, talkRound, type Entry, type Queue } from "./queue-entries-and-outcomes.ts";

/** Whether a talk session can be opened for `entry`: its run is finished, its terminal is closed, and it ended with something to talk about. PURE. */
function canTalk(entry: Entry | undefined): entry is Entry {
  return entry !== undefined && entry.phase === "finished" && !isParked(entry) && runActions(entry).includes("talk");
}

/**
 * A person opened a finished run's saved session to talk to its agent. The ticket goes back on the queue as a talk session, at the end. A batch planner's tickets share
 * one session, so every ticket of the batch that offers Talk is queued with it, at the same time, and starts in one pane (A11-171). Nothing changes for a run that is not
 * finished, one parked (its terminal is open already), or one a session cannot help: it concluded with nothing more to do.
 */
export function talk(queue: Queue, key: string, now: number): Queue {
  const entry = find(queue, key);
  if (!canTalk(entry)) return queue;
  const together = entry.batch === undefined ? [entry] : queue.entries.filter((other) => other.batch === entry.batch && canTalk(other));
  const keys = new Set(together.map(({ ticket }) => ticket.key));
  return { ...queue, entries: [...queue.entries.filter(({ ticket }) => !keys.has(ticket.key)), ...together.map((member) => talkRound(member, now))] };
}

/** A talk session that could not start: the run it replaced goes back on the board as it was. */
export function talkFailed(queue: Queue, key: string): Queue {
  return replace(queue, key, (entry) => (entry.talk && entry.talkFrom ? { ...entry.talkFrom } : entry));
}

