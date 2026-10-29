// @ts-check
// module: a run whose worker waits on another ticket lets go of its slot and its files (A11-272) -- the board records the ticket as its blocker, closes the run's workspace and queues it behind the ticket
//
// A11-245 READS A TICKET WAIT AND WAKES THE WORKER WHEN THE TICKET IS DONE, but a run left `running` that long holds a slot and its whole footprint, and a ticket that needs those files waits behind it: on
// 2026-10-25 A11-231 waited on A11-229 while A11-229 waited on A11-231's files. So once the wait's first reading finds a ticket not done, the run is stopped here, on the tick, before the slots are filled:
// the tracker is told the ticket blocks it, its workspace is closed the way an update's drain closes one, and it is queued again behind the ticket with the session its agent had (`queue-blocker-wait.ts`).
// A wait whose tickets are already done is an ordinary declared wait: the worker is woken for it as before. A batch's run is shared by its tickets, so it is left to that wake too.
import { closedOrGone } from "./pool-drain.ts";
import { forgetRun, log, messageOf, runPlace, update } from "./pool-state.ts";
import { find, type Entry, type WorkingNote } from "./queue/queue-entries-and-outcomes.ts";
import { type BlockerWait, recordStoppedStates, requeueBehindBlocker, unlistedKeysDue } from "./queue/queue-blocker-wait.ts";
import { judgedWait } from "./wait-on/wait-watch.ts";
import { waitCycles, type WaitCycle } from "./board-view/wait-cycles.ts";
import { tellWaitCycles, waitCyclesDue } from "./pool-wait-cycles.ts";
import { type TicketWait, type Wait, waitKey } from "./wait-on/wait-types.ts";
import { type PoolContext } from "./pool-context.ts";

const isTicketWait = (wait: Wait): wait is TicketWait => wait.kind === "ticket";

/** Whether a run is running, and its own: a batch's run is shared by its tickets. */
const parkedAlone = (entry: Entry): boolean => entry.phase === "running" && entry.batch === undefined;

/** Whether a note is a wait its idle worker sits in, and has not been woken from. */
const inUnwokenWait = (note: WorkingNote): boolean => note.waiting === true && note.woke === undefined;

/**
 * What lets a live run go, or null when nothing does: its worker is idle in a declared wait it has not been woken from, and the wait is not over. The wait's latest reading is still pending and found some ticket of
 * it, other than the run's own, not done; or, with no reading yet, the run is in a wait cycle (`cycle` holds the tickets of the cycle) and the wait names another ticket of it, which is on the board and so not done
 * (A11-272). Every ticket the wait names, not done, is what it is queued behind, and the wait's other events are kept beside them.
 */
function blockerWaitOf(ctx: PoolContext, entry: Entry, cycle?: ReadonlySet<string>): BlockerWait | null {
  const note = entry.working;
  if (!parkedAlone(entry) || note?.waits === undefined || !inUnwokenWait(note)) return null;
  const judged = judgedWait(ctx.waitPolls, runPlace(ctx, entry).name, note);
  // Two grounds to let go: the reading is pending and found a ticket not done, or there is no reading yet and a ticket the wait names is in a wait cycle with the run (it is on the board, so not done).
  const readingPending = judged !== null && judged.verdict.outcome === "pending";
  const ended = new Set((judged?.verdict.ended ?? []).map(waitKey));
  const tickets = note.waits.filter(isTicketWait).filter((wait) => wait.key !== entry.ticket.key && !ended.has(waitKey(wait)));
  const grounded = readingPending || (judged === null && tickets.some((wait) => cycle?.has(wait.key) === true));
  if (!grounded) return null;
  return tickets.length === 0 ? null : { keys: tickets.map(({ key }) => key), others: note.waits.filter((wait) => !isTicketWait(wait)) };
}

/** Record in the tracker that each of `keys` blocks ticket `key`. A tracker that cannot, or refuses, is said in the log: the stop's own record holds the run behind them all the same. */
async function addBlockers(ctx: PoolContext, key: string, keys: readonly string[]): Promise<void> {
  const { source } = ctx;
  const named = keys.join(", ");
  if (source.addBlockers === undefined) return log(`${key}: this tracker cannot record that ${named} blocks it, so the board alone holds it behind ${named}`);
  try {
    await source.addBlockers(key, keys);
  } catch (err) {
    log(`${key}: the tracker refused to record that ${named} blocks it (${messageOf(err)}), so the board alone holds it behind ${named}`);
  }
}

/**
 * Let one run go: the tracker is told its tickets block it, its workspace is closed, and it is queued behind them with its agent's session. A run whose worker moved on while the tracker answered (a newer note,
 * or a wake) is left alone, and so is one whose workspace would not close: the next tick tries again, and nothing is queued beside a live agent. True when the run was queued.
 */
async function release(ctx: PoolContext, entry: Entry, asked: BlockerWait, cycle?: ReadonlySet<string>): Promise<boolean> {
  const { claudeSessions, now, store } = ctx;
  const key = entry.ticket.key;
  await addBlockers(ctx, key, asked.keys);
  // Read again after the tracker answered: the worker may have written a newer note, or been woken, meanwhile.
  const current = find(store.get(), key);
  const wait = current === undefined || current.working?.at !== entry.working?.at ? null : blockerWaitOf(ctx, current, cycle);
  if (current === undefined || wait === null) return false;
  const behind = wait.keys.join(", ");
  if (!await closedOrGone(ctx, current, `to queue it behind ${behind}`)) return false;
  // The close was asked without holding the loop: a run that ended or was stopped meanwhile is not queued behind its blockers.
  if (find(store.get(), key)?.phase !== "running") return false;
  const session = current.workspace === undefined ? undefined : claudeSessions.get(current.workspace);
  forgetRun(ctx, runPlace(ctx, current).name);
  update(ctx, (queue) => requeueBehindBlocker(queue, key, { ...wait, session }, now()));
  log(`${key}: its worker waits on ${behind}, so its run was closed and queued behind ${behind}; it resumes its own session once ${wait.keys.length === 1 ? "that ticket is" : "those tickets are"} done`);
  return true;
}

/** The other tickets of the wait cycle a ticket is in, or undefined when it is in none: the tickets its wait may name for the board to let it go before it has read the wait. */
function cycleMates(cycles: readonly WaitCycle[], key: string): ReadonlySet<string> | undefined {
  const cycle = cycles.find(({ keys }) => keys.includes(key));
  return cycle === undefined ? undefined : new Set(cycle.keys.filter((member) => member !== key));
}

/**
 * Read where each ticket a queued stopped run waits on stands, when the tracker's blockers, once read, do not list it: the hold lets go of it once it is completed or canceled (`waitsOn`). At most once a minute per
 * run, and not once its wait has ended. A refused read changes nothing, and the next tick asks again.
 */
async function readUnlisted(ctx: PoolContext, due: readonly Readonly<{ entry: Entry; keys: readonly string[] }>[]): Promise<void> {
  const { now, source } = ctx;
  if (source.stateTypes === undefined) return;
  for (const { entry, keys } of due) {
    try {
      const states = await source.stateTypes(keys);
      update(ctx, (queue) => recordStoppedStates(queue, entry.ticket.key, states, now()));
    } catch {
      // the tracker could not be asked: the next tick asks again
    }
  }
}

/**
 * One pass: let go of every live run whose worker waits on a ticket not done, and, at once, every run in a wait cycle whose worker waits on another ticket of it, since a ticket on the board in the same cycle is not
 * done (A11-272); then tell the chairman's session of the cycles found (`pool-wait-cycles.ts`), and read the tickets queued stopped runs wait on that the tracker does not list. Null when none of it is due, so a tick
 * with nothing to do here awaits nothing, and its slots are filled in the same turn as before.
 */
export function releaseTicketWaits(ctx: PoolContext): Promise<void> | null {
  const { now, store } = ctx;
  const entries = store.get().entries;
  const cycles = waitCycles(entries);
  const releases = entries.flatMap((entry) => {
    const cycle = cycleMates(cycles, entry.ticket.key);
    const wait = blockerWaitOf(ctx, entry, cycle);
    return wait === null ? [] : [{ entry, wait, cycle }];
  });
  const reads = entries.map((entry) => ({ entry, keys: unlistedKeysDue(entry, now()) })).filter(({ keys }) => keys.length > 0);
  if (releases.length === 0 && reads.length === 0 && !waitCyclesDue(ctx, cycles)) return null;
  return (async () => {
    const released = new Set<string>();
    for (const { entry, wait, cycle } of releases) if (await release(ctx, entry, wait, cycle)) released.add(entry.ticket.key);
    await tellWaitCycles(ctx, cycles, released, new Set(releases.map(({ entry }) => entry.ticket.key).filter((key) => !released.has(key))));
    await readUnlisted(ctx, reads);
  })();
}
