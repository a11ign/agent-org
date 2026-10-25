// @ts-check
// module: a run whose worker waits on another ticket (A11-272) -- stopped and queued again behind that ticket, so it holds no slot and no path while it waits, and resumes its own session once the ticket is done
//
// A ticket can take hours or days. A run left `running` while its worker waits on one holds a slot and its whole footprint that long, and a ticket that needs those files is held behind it: the two wait on each
// other. So the board records the ticket as a blocker in the tracker, closes the run's workspace (`pool-ticket-wait.ts`) and queues it again here. `waitsOn` holds it behind the ticket, through the tracker's
// relation and through `stoppedForBlocker` while the tracker does not list it, and `prepare` resumes its Claude session when it starts, as it does for a run stopped for an update.
import type { Wait } from "../wait-on/wait-types.ts";
import { replace, type Entry, type Queue } from "./queue-entries-and-outcomes.ts";
import { requeueStopped } from "./queue-pins.ts";
import { ticketWaitEnded, unlistedStops } from "../board-view/waits-on.ts";
import { POLL_EVERY_MS } from "../wait-on/wait-watch.ts";

/**
 * Set on a run the board stopped and queued again because its worker declared a wait on other tickets (A11-272): when, the tickets it is queued behind (`keys`), the other events the same note declared
 * (`others`, kept as a record: the resumed worker decides what of them still matters), and the tracker's state of each key the tracker does not list as a blocker yet, as last read (`states`, at `readAt`).
 * Dropped when its round starts.
 */
export type StoppedForBlocker = Readonly<{ at: number; keys: readonly string[]; others: readonly Wait[]; states?: Readonly<Record<string, string>>; readAt?: number }>;

/** The tickets a stopped run is queued behind, and the other events its note declared. */
export type BlockerWait = Pick<StoppedForBlocker, "keys" | "others">;

/**
 * A live run whose worker waits on the tickets `wait.keys` is queued again behind them (A11-272), as {@link requeueStopped} queues one, with `stoppedForBlocker` saying when and on what, and `session` the Claude session
 * its agent had. Its `blockers` go, so the next fill reads them afresh, with the relation the board has just recorded. Only a live entry is changed. PURE.
 */
export function requeueBehindBlocker(queue: Queue, key: string, { session, ...wait }: BlockerWait & Readonly<{ session?: string }>, now: number): Queue {
  return requeueStopped(queue, key, now, { why: "blocker", record: { stoppedForBlocker: { at: now, ...wait } }, drops: ["blockers"], ...(session === undefined ? {} : { session }) });
}

/** Whether a run starts by resuming the Claude session the board stopped it in: a run stopped for an update (A11-169), for a wait on another ticket (A11-272), or held for its ticket's CI spend (A11-261). */
export const resumesStoppedSession = (entry: Entry): boolean => entry.stoppedForUpdate !== undefined || entry.stoppedForBlocker !== undefined || entry.ciHold !== undefined;

/**
 * The keys of a queued stopped run whose states the board is due to read at `now`: those the tracker's blockers, once read, do not list, since no blocker read carries their states, and whose wait has not ended as last
 * read. At most one read a minute ({@link POLL_EVERY_MS}), as the wait's own reading. None before the blockers are read, since a run whose blockers are unread does not start (`fill`). PURE.
 */
export function unlistedKeysDue(entry: Entry, now: number): string[] {
  const stopped = entry.stoppedForBlocker;
  if (stopped === undefined || !blockersRead(entry) || readLately(stopped, now)) return [];
  return unlistedStops(entry).filter((key) => !ticketWaitEnded(stopped.states?.[key] ?? "unknown"));
}

/** Whether a queued run's blockers have been read since it was queued. */
const blockersRead = (entry: Entry): boolean => entry.phase === "queued" && entry.blockers !== undefined;

/** Whether the states a stopped run waits on were read less than {@link POLL_EVERY_MS} before `now`. */
const readLately = ({ readAt }: StoppedForBlocker, now: number): boolean => readAt !== undefined && now - readAt < POLL_EVERY_MS;

/** Record the tracker's state of each unlisted key of the queued stopped run `key`, as read at `now` (see {@link unlistedKeysDue}). A key the read left out keeps what it had. PURE. */
export function recordStoppedStates(queue: Queue, key: string, states: ReadonlyMap<string, string>, now: number): Queue {
  return replace(queue, key, (entry) => {
    const stopped = entry.stoppedForBlocker;
    if (entry.phase !== "queued" || stopped === undefined) return entry;
    return { ...entry, stoppedForBlocker: { ...stopped, states: { ...stopped.states, ...Object.fromEntries(states) }, readAt: now } };
  });
}
