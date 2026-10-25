// module: a run held for its CI spend (A11-261) -- stopped and queued again as the update drain stops one, held back for two passes of the board, and started again with the reason in its brief -- PURE
//
// NOTHING PAUSES A LIVE RUN IN PLACE, so the hold is the drain's own stop: the run's workspace is closed (by the caller) and the entry is queued again with the Claude session its agent had, `ciHold` saying why. `nextStarts` holds a queued
// run whose hold has not lasted {@link HOLD_PASSES} passes, the pass counts it (`ageHolds`), and the run that then starts resumes its session, with the reason and the push-once rule at the head of its brief. No person releases it. A run that
// has finished is not stopped and nothing holds it: its next round is only told the reason in its brief.
import { find, replace, type Entry, type Queue } from "../queue/queue-entries-and-outcomes.ts";
import { requeueStopped } from "../queue/queue-pins.ts";
import { HOLD_PASSES, type CiHold } from "./store.ts";

const hold = (reason: string, at: number): CiHold => ({ reason, at, passes: 0 });

/** A live run is stopped for its CI spend and queued again (A11-261), with `ciHold` saying why and `session` the Claude session its agent had: see {@link requeueStopped}. Only a live entry is changed. PURE. */
export function requeueForCiHold(queue: Queue, key: string, reason: string, now: number, session?: string): Queue {
  // A run that started before the board recorded its first start is counted from its latest start, which the stop drops: it is kept.
  const entry = find(queue, key);
  const since = entry?.ciSince === undefined && entry?.startedAt !== undefined ? { ciSince: entry.startedAt } : {};
  return requeueStopped(queue, key, now, { why: "ci-budget", record: { ciHold: hold(reason, now), ...since }, ...(session === undefined ? {} : { session }) });
}

/** A finished run is not stopped and nothing holds it: its next round, whoever starts it, is told the reason in its brief. Only a finished entry is changed. PURE. */
export const tellFinishedRun = (queue: Queue, key: string, reason: string): Queue =>
  replace(queue, key, (entry) => (entry.phase === "finished" ? { ...entry, ciTold: reason } : entry));

/** Whether a queued entry is held back for its CI spend: it has a hold that has not seen {@link HOLD_PASSES} passes of the board. PURE. */
export const isCiHeld = (entry: Entry): boolean => entry.ciHold !== undefined && entry.ciHold.released !== true;

/** One pass of the board has gone by: each queued entry with a hold has seen one more, and a hold that has seen {@link HOLD_PASSES} is released. PURE. */
export function ageHolds(queue: Queue): Queue {
  if (!queue.entries.some((entry) => entry.phase === "queued" && isCiHeld(entry))) return queue;
  return { ...queue, entries: queue.entries.map((entry) => {
    if (entry.phase !== "queued" || entry.ciHold === undefined || !isCiHeld(entry)) return entry;
    const passes = entry.ciHold.passes + 1;
    return { ...entry, ciHold: { ...entry.ciHold, passes, ...(passes >= HOLD_PASSES ? { released: true as const } : {}) } };
  }) };
}
