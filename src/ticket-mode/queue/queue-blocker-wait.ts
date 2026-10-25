// @ts-check
// module: a run whose worker waits on another ticket (A11-272) -- stopped and queued again behind that ticket, so it holds no slot and no path while it waits, and resumes its own session once the ticket is done
//
// A ticket can take hours or days. A run left `running` while its worker waits on one holds a slot and its whole footprint that long, and a ticket that needs those files is held behind it: the two wait on each
// other. So the board records the ticket as a blocker in the tracker, closes the run's workspace (`pool-ticket-wait.ts`) and queues it again here. `waitsOn` holds it behind the ticket, through the tracker's
// relation and through `stoppedForBlocker` while the tracker does not list it, and `prepare` resumes its Claude session when it starts, as it does for a run stopped for an update.
import type { Wait } from "../wait-on/wait-types.ts";
import { replace, type Entry, type Queue } from "./queue-entries-and-outcomes.ts";
import { requeueStopped } from "./queue-pins.ts";
import { unlistedStops } from "../board-view/waits-on.ts";

/**
 * Set on a run the board stopped and queued again because its worker declared a wait on other tickets (A11-272): when, the tickets it is queued behind (`keys`), the other events the same note declared
 * (`others`), and the tracker's state of each key the tracker does not list as a blocker yet, as last read (`states`). Dropped when its round starts.
 */
export type StoppedForBlocker = Readonly<{ at: number; keys: readonly string[]; others: readonly Wait[]; states?: Readonly<Record<string, string>> }>;

/** The tickets a stopped run is queued behind, and the other events its note declared. */
export type BlockerWait = Pick<StoppedForBlocker, "keys" | "others">;

/**
 * A live run whose worker waits on the tickets `wait.keys` is queued again behind them (A11-272), as {@link requeueStopped} queues one, with `stoppedForBlocker` saying when and on what, and `session` the Claude session
 * its agent had. Its `blockers` go, so the next fill reads them afresh, with the relation the board has just recorded. Only a live entry is changed. PURE.
 */
export function requeueBehindBlocker(queue: Queue, key: string, { session, ...wait }: BlockerWait & Readonly<{ session?: string }>, now: number): Queue {
  return requeueStopped(queue, key, now, { why: "blocker", record: { stoppedForBlocker: { at: now, ...wait } }, drops: ["blockers"], ...(session === undefined ? {} : { session }) });
}

/** Whether a run starts by resuming the Claude session the board stopped it in: a run stopped for an update (A11-169), or for a wait on another ticket (A11-272). */
export const resumesStoppedSession = (entry: Entry): boolean => entry.stoppedForUpdate !== undefined || entry.stoppedForBlocker !== undefined;

/**
 * The keys a queued stopped run waits on that the tracker's blockers, once read, do not list: the board reads their states itself, since no blocker read carries them. None before the blockers are read, since a run
 * whose blockers are unread does not start (`fill`). PURE.
 */
export const unlistedKeys = (entry: Entry): string[] => (entry.phase === "queued" && entry.blockers !== undefined ? unlistedStops(entry) : []);

/** Record the tracker's state of each unlisted key of the queued stopped run `key`, as read (see {@link unlistedKeys}). A key the read left out keeps what it had. PURE. */
export function recordStoppedStates(queue: Queue, key: string, states: ReadonlyMap<string, string>): Queue {
  return replace(queue, key, (entry) => {
    const stopped = entry.stoppedForBlocker;
    if (entry.phase !== "queued" || stopped === undefined) return entry;
    return { ...entry, stoppedForBlocker: { ...stopped, states: { ...stopped.states, ...Object.fromEntries(states) } } };
  });
}
