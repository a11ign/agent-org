// @ts-check
// module: taking a live pane back, and losing a run to a restart (A11-240) -- the queue's side of what the pool does when herdr is asked who is still there
//
// HERDR, NOT THE QUEUE FILE, SAYS WHETHER A RUN SURVIVED A RESTART. A run caught `starting` has no workspace on record yet, but its herdr name is fixed before it opens anything, so the pool finds it by that name and
// these record what it found. A run whose pane is gone is lost in the restart, and is queued again ONCE when the board has no pull request on record for it: the mark `lostInRestart` rides the entry through a start and a second end, which
// all spread it, and is dropped only by a rebuild (a person's Retry, a review round), so a second loss in the same chain is the run's end.
import { openPulls } from "../board-view/view-types-and-filters.ts";
import { find, replace, retry, type Entry, type Outcome, type Queue } from "./queue-entries-and-outcomes.ts";
import { finish, markRunning } from "./queue-transitions.ts";

/** How a run is ended when its herdr workspace is gone after a restart. */
export const LOST_IN_RESTART: Outcome = { kind: "crashed", reason: "lost in a restart: its herdr workspace is gone" };

/**
 * Whether a lost run goes back on the queue: a work or planning run (a review round has its pull requests, a talk session is a person's) with no pull request ON RECORD, which was not queued again by a restart already.
 * A live run records its pull requests only when it ends, so one the worker opened before the restart is not seen here: the brief of the run queued again lists the ticket's pull requests (A11-240, step 2). PURE.
 */
export const requeuesOnLoss = (entry: Entry): boolean =>
  entry.review === undefined && entry.talk !== true && entry.lostInRestart === undefined && openPulls(entry).length === 0;

/** A run caught `starting` by a restart, whose pane herdr lists: it is running in that workspace and pane, and the card says it was taken back. A run that is no longer starting is left alone. PURE. */
export function adoptStarting(queue: Queue, key: string, workspace: string, pane: string, now: number): Queue {
  if (find(queue, key)?.phase !== "starting") return queue;
  return replace(markRunning(queue, key, workspace, pane), key, (entry) => ({ ...entry, readopted: { at: now, from: "starting" } }));
}

/**
 * A run the board marked crashed whose worker herdr lists working: it is running again in that workspace and pane, and the card says what it had been marked. Its outcome and end time go, since it did not end; its
 * pull requests and the rest of its record stay. Only a finished run that ended `crashed` and holds no workspace is taken back. PURE.
 */
export function adoptCrashed(queue: Queue, key: string, workspace: string, pane: string, now: number): Queue {
  return replace(queue, key, (entry) => {
    if (entry.phase !== "finished" || entry.outcome?.kind !== "crashed" || entry.workspace !== undefined) return entry;
    // What the end recorded goes as it does when a person answers a parked run (`markResumed`): the tracker state, the pull request states and heads, and a hand-back belong to the outcome it replaces.
    const { outcome, finishedAt: _ended, lastTerminal: _closed, trackerState: _tracked, pullStates: _pulls, outcomeHeads: _outcomeHeads, pullHeads: _heads, handedBack: _handed, ...rest } = entry;
    return { ...rest, phase: "running", workspace, pane, seenWorking: true, readopted: { at: now, from: "crashed", reason: outcome.reason } };
  });
}

/**
 * A live run's herdr workspace is gone after a restart: it ends `crashed`, "lost in a restart", and goes back on the queue once when {@link requeuesOnLoss}, at its FRONT (A11-279): it was running, so it starts again before
 * any run that was only waiting, and its brief says its worktree holds the earlier run's work. PURE.
 */
export function loseInRestart(queue: Queue, key: string, now: number): Queue {
  const entry = find(queue, key);
  if (entry === undefined) return queue;
  const ended = finish(queue, key, LOST_IN_RESTART, now);
  if (!requeuesOnLoss(entry)) return ended;
  return toFront(replace(retry(ended, key, now), key, (queued) => (queued.phase === "queued" ? { ...queued, lostInRestart: { at: now } } : queued)), key, now);
}

/**
 * The queue with ticket `key`'s entry moved to the front, which is the order runs start in: behind the runs this same restart (`now`) already lost and moved there, so the runs it lost start in the order the queue held
 * them, a batch's tickets included. PURE.
 */
function toFront(queue: Queue, key: string, now: number): Queue {
  const entry = find(queue, key);
  if (entry === undefined) return queue;
  const others = queue.entries.filter((e) => e.ticket.key !== key);
  const lostNow = others.findIndex((e) => !(e.phase === "queued" && e.lostInRestart?.at === now));
  const at = lostNow === -1 ? others.length : lostNow;
  return { ...queue, entries: [...others.slice(0, at), entry, ...others.slice(at)] };
}

/**
 * When a restart lost the run this queued entry starts again, or undefined: only while it is still the queueing the loss made (its `queuedAt` is the loss's), so a run lost once and later stopped and queued again for
 * another reason is not told of the old loss in its next brief (A11-279). PURE.
 */
export const lostBeforeThisStart = ({ lostInRestart, queuedAt }: Entry): number | undefined => (lostInRestart?.at === queuedAt ? lostInRestart?.at : undefined);
