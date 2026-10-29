// @ts-check
// module: a breaking update that is draining (A11-169) -- no run starts while the record exists, and once its deadline has passed the live runs are stopped and queued again
//
// THE INSTANCE OWNS ITS QUEUE, SO IT ACTS AND `update` ONLY READS. `update` writes `update-drain.json` when a breaking release is waiting on live runs (`install/update-drain.ts`). While that file exists
// `fill` starts nothing. When its `deadline` has passed (`tickets.updateMaxDeferHours` after it began) each live run is stopped and queued again, keeping its Claude session so the round that follows resumes it
// on the new version; the record is written back with `forcedAt` and the runs stopped, and the auto-update service is started at once, rather than at its next timer. `update` swaps, restarts and deletes the
// record once the queue holds no live run, and the restarted instance starts the queued runs as rounds.
import { homedir } from "node:os";
import { drainPath, readDrain, writeDrain, type Drain, type DrainRecord } from "../install/update-drain.ts";
import { defaultServiceDeps, runAutoUpdateNow } from "../install/service.ts";
import { herdrReason } from "../herdr-agents.ts";
import { herdrRefusal } from "./pool-herdr.ts";
import { isLive, liveRunCount, LIVE, writerLive, type Entry, type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { requeueForUpdate } from "./queue/queue-pins.ts";
import { writerFailed } from "./queue.ts";
import { endPublish, endWriter } from "./pool-board-runs.ts";
import { forgetRun, log, messageOf, publishPlace, runPlace, update } from "./pool-state.ts";
import { clockOf, type UpdateNote } from "./board-view/update-banner.ts";
import { type PoolContext } from "./pool-context.ts";

/** Where the pool reads and writes the drain record: the agent-org home's file by default, and a test's own. */
export type DrainStore = Readonly<{ read: () => Drain; write: (record: DrainRecord) => void }>;

export const defaultDrainStore = (): DrainStore => {
  const path = drainPath(process.env, homedir());
  return { read: () => readDrain(path), write: (record) => writeDrain(path, record) };
};

/** Starts the auto-update service now. A refusal is said and never thrown: the timer applies the update at its next run all the same. */
export const defaultStartUpdate = (): void => {
  try {
    runAutoUpdateNow(defaultServiceDeps());
  } catch (err) {
    log(`the update could not be started now (${messageOf(err)}); the next timer run applies it`);
  }
};

/** How long a workspace close may take, in ms: the cut the synchronous call had. The wait holds no loop (A11-282). */
const CLOSE_MS = 30_000;

const storeOf = (ctx: PoolContext): DrainStore => ctx.deps.drain ?? defaultDrainStore();

/**
 * Whether a drain record stands. One that cannot be read counts as standing: a corrupt file must not let a run start into an update, and `doctor` says the file is wrong. PURE apart from the read.
 */
export function isDraining(ctx: PoolContext): boolean {
  return storeOf(ctx).read().kind !== "none";
}

/**
 * Close a run's workspace, to stop it `forWhat` (the log's words: "for the update"). True when it is closed or already gone; false, said in the log, when herdr refuses for another reason: the agent may still be
 * running, so the run is not queued again beside it, and the next tick tries again.
 */
export async function closedOrGone(ctx: PoolContext, entry: Entry, forWhat: string): Promise<boolean> {
  if (entry.workspace === undefined) return true;
  try {
    // Asked without holding the loop (A11-282): a close takes 250 ms to 1 s, and the board thread answers every write meanwhile.
    await ctx.herdrCall(["--session", ctx.session.session, "workspace", "close", entry.workspace], CLOSE_MS);
    return true;
  } catch (err) {
    const why = `${herdrRefusal(err)} ${herdrReason(err)}`;
    if (/not_found|not found/i.test(why)) return true;
    log(`${entry.ticket.key}: its workspace ${entry.workspace} would not close ${forWhat} (${why.trim()}), so it is left running and tried again`);
    return false;
  }
}

/** Stop one live run's agent and record that it was stopped for the update: its workspace is closed, and the run is queued again with the session its agent had. False when the workspace would not close. */
async function stopEntry(ctx: PoolContext, entry: Entry, target: string): Promise<boolean> {
  const { claudeSessions, now } = ctx;
  if (!await closedOrGone(ctx, entry, "for the update")) return false;
  const id = entry.workspace === undefined ? undefined : claudeSessions.get(entry.workspace);
  forgetRun(ctx, runPlace(ctx, entry).name);
  update(ctx, (queue) => requeueForUpdate(queue, entry.ticket.key, target, now(), id));
  return true;
}

/** The keys of the tickets whose run is stopped, and the others stopped: the publish run and the new-ticket runs, which have no ticket to queue again. */
async function stopLiveRuns(ctx: PoolContext, target: string, at: string): Promise<string[]> {
  const { store } = ctx;
  const stopped: string[] = [];
  for (const listed of store.get().entries.filter(isLive)) {
    // Each close is asked without holding the loop, so the queue moves between two runs: a run that ended meanwhile is not stopped for the update.
    const entry = store.get().entries.find((e) => e.ticket.key === listed.ticket.key);
    if (entry !== undefined && isLive(entry) && await stopEntry(ctx, entry, target)) stopped.push(entry.ticket.key);
  }
  const { publish } = store.get();
  if (publish !== undefined && LIVE.has(publish.phase)) {
    endPublish(ctx, publish, { failure: `stopped for the update to ${target} at ${at}: publish again` });
    stopped.push("the publish run");
  }
  for (const run of (store.get().writers ?? []).filter(writerLive)) {
    const failure = `stopped for the update to ${target} at ${at}: ask again`;
    if (run.phase === "running") endWriter(ctx, run, failure);
    else update(ctx, (queue) => writerFailed(queue, run.id, failure, ctx.now()));
    stopped.push(`new-ticket run ${run.id}`);
  }
  return stopped;
}

/**
 * With a drain record whose deadline has passed and a run still live, stops every live run and queues it again, records it in the drain record, and starts the update. Nothing happens before the deadline,
 * with no record, or with no live run. A record that cannot be read has no deadline to read, so it forces nothing.
 */
export async function forceDrain(ctx: PoolContext): Promise<void> {
  const { now, store } = ctx;
  const drain = storeOf(ctx);
  const read = drain.read();
  if (read.kind !== "draining") return;
  const { record } = read;
  const live = store.get().entries.some(isLive) || (store.get().publish !== undefined && LIVE.has(store.get().publish!.phase)) || (store.get().writers ?? []).some(writerLive);
  if (!live || now() < Date.parse(record.deadline)) return;
  const stopped = await stopLiveRuns(ctx, record.target, clockOf(now()));
  log(`stopping ${stopped.length} ${stopped.length === 1 ? "run" : "runs"} for the update to ${record.target} (${stopped.join(", ")}): the wait of the update ended at ${record.deadline}`);
  drain.write({ ...record, forcedAt: record.forcedAt ?? new Date(now()).toISOString(), stopped: [...new Set([...record.stopped, ...stopped])] });
  (ctx.deps.startUpdate ?? defaultStartUpdate)();
}


/**
 * What the board is told of a draining update (A11-169), or null when none drains (and when the record cannot be read: the pool starts nothing then, and `doctor` says the file is wrong). `finishing` is the
 * runs still live, a batch counting once, as `update` counts them.
 */
export function updateNoteOf(drain: Drain, queue: Queue): UpdateNote | null {
  if (drain.kind !== "draining") return null;
  const { record } = drain;
  return { target: record.target, deadline: Date.parse(record.deadline), finishing: liveRunCount(queue), forced: record.forcedAt !== undefined, stopped: record.stopped.length };
}
