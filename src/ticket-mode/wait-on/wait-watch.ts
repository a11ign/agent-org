// A leaf of ticket mode, run by no command: the board's polling of the events a worker declared it waits on (A11-245). Per run: at most one read per unfinished item a minute, only while the agent is idle or done, started off the tick (an
// async job whose last COMPLETED reading the next tick uses), and nothing once the worker has been woken. A reading belongs to the note it was taken for: a newer `working` outcome is a new note and starts afresh. Nothing here throws.
import type { WorkingNote } from "../queue/queue-entries-and-outcomes.ts";
import { MAX_WAKE_TRIES } from "./wait-note.ts";
import { type WaitSeams, readWaits } from "./wait-read.ts";
import { type Judged, judgeWaits } from "./wait-verdict.ts";
import { waitText } from "./wait-text.ts";
import { type Reading, waitKey } from "./wait-types.ts";

/** The least time between two reads of the same run's unfinished items: one minute. */
export const POLL_EVERY_MS = 60_000;

/** What the board last read of one run's declared wait, for the note written at `noteAt`. `judged` is the last COMPLETED reading, and `startedAt` when the last read began (a read still under way is `running`). */
type WaitPoll = { noteAt: number; readings: ReadonlyMap<string, Reading>; judged: Judged | null; startedAt: number | null; running: boolean };

/** The polls the board holds, by the run's herdr name: in memory, so a restart reads afresh and the note's own `woke` says whether the worker was already told. */
export type WaitPolls = Map<string, WaitPoll>;

/** The latest completed reading of a run's declared wait, or null when none has completed for the note it holds now. */
export function judgedWait(polls: WaitPolls, name: string, note: Pick<WorkingNote, "at">): Judged | null {
  const poll = polls.get(name);
  return poll !== undefined && poll.noteAt === note.at ? poll.judged : null;
}

/**
 * Whether a note's declared wait still needs reading: it has events, herdr is not refusing its wake, and its worker has not been woken for it. A repeat (see `repeatOf`) carries the earlier wake, and is read
 * until it is judged: once stalled for re-declaring what had ended, there is nothing left to read.
 */
const needsReading = (note: WorkingNote): boolean => {
  if (note.waits === undefined || (note.wakeTries ?? 0) >= MAX_WAKE_TRIES) return false;
  return note.repeat === true ? note.stalled !== true : note.woke === undefined;
};

/** The poll held for a note: the one for this note, or a fresh one that replaces any held for an earlier note. */
function pollFor(polls: WaitPolls, name: string, note: Pick<WorkingNote, "at">): WaitPoll {
  const held = polls.get(name);
  if (held?.noteAt === note.at) return held;
  const fresh: WaitPoll = { noteAt: note.at, readings: new Map(), judged: null, startedAt: null, running: false };
  polls.set(name, fresh);
  return fresh;
}

/**
 * Starts a read of a run's declared wait when one is due: the note declares events and has not woken its worker, no read is under way, and a minute has passed since the last began. Call it only while the run's agent is
 * idle or done. It returns at once; the reading is there for a later tick through {@link judgedWait}. A run with no wait to read drops what was held for it.
 */
export function pollWhenDue(polls: WaitPolls, name: string, note: WorkingNote, clock: () => number, seams: WaitSeams): void {
  const { waits } = note;
  if (waits === undefined) return void polls.delete(name);
  if (!needsReading(note)) return;
  const poll = pollFor(polls, name, note);
  const now = clock();
  if (poll.running || (poll.startedAt !== null && now - poll.startedAt < POLL_EVERY_MS)) return;
  poll.running = true;
  poll.startedAt = now;
  // `readWaits` never rejects (an item it cannot read is `unreadable`); the catch keeps a defect in this folder's own code from becoming an unhandled rejection that stops the board.
  void readWaits(waits, poll.readings, seams).then((readings) => {
    poll.readings = new Map(readings.map((reading) => [waitKey(reading.wait), reading]));
    poll.judged = { verdict: judgeWaits(readings), readAt: now, text: waitText(readings, clock()) };
  }).catch(() => undefined).finally(() => { poll.running = false; });
}
