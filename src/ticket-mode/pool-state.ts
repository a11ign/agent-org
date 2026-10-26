// @ts-check
// module: the pool's shared lookups -- where a run lives, whether it is planning, and the queue's updates for a run

import { type Entry, type Outcome, type PublishRun, type Queue, type RunChoice, type WriterRun } from "./queue/queue-entries-and-outcomes.ts";
import { batchDir, batchFolder, publishDir, publishFolder, type RunPlace } from "./pool-paths.ts";
import { herdrName } from "./pool-herdr.ts";
import { ticketDir, ticketFolder, writerDir, writerFolder } from "./ticket-paths.ts";
import { writerOf } from "./queue.ts";
import { type PoolContext } from "./pool-context.ts";

/** Listings in a row a run may be missing from before its workspace counts as gone: a running run is then crashed, and a parked one unparked. */
const MISSES_TO_GONE = 2;

/** A line in the board's log, which is its standard error. */
export const log = (line: string): void => { process.stderr.write(`ticket:serve: ${line}\n`); };

export const messageOf = (err: unknown): string => String((err as Error)?.message ?? err);

/** How a run that could not start ended: crashed, with the first line of its error. */
export const crashed = (err: unknown): Outcome => ({ kind: "crashed", reason: messageOf(err).split("\n")[0] });

/** A run is a planning run while its entry still needs its plan and this machine has a planner. */
export const isPlanning = (ctx: PoolContext, entry: Entry): boolean => {
  const { settings } = ctx;
  return entry.plan !== undefined && settings.planner !== null;
};

/**
 * The model and effort a run starts on: the planning ones for a planning run, the ones its plan was written with for the planner's round of a stand-off (A11-290, when the plan recorded them), and the entry's own otherwise.
 */
export const runChoice = (ctx: PoolContext, entry: Entry): RunChoice => {
  if (isPlanning(ctx, entry) && entry.plan) return entry.plan;
  return entry.standoff?.stage === "planner" && entry.plannedWith ? entry.plannedWith : entry;
};

export const update = (ctx: PoolContext, change: (queue: Queue) => Queue) => {
  const { store } = ctx;
  return store.set(change(store.get()));
};

/** Forget a run's bookkeeping: its missed listings, the start dialogs answered on it, whether the pool started it (A11-78), the plan attach it was trying again (A11-216), the result write it was trying again (A11-304), and the environment its pane lost (A11-279). Called where its workspace is closed and its record ends. */
export const forgetRun = (ctx: PoolContext, name: string): void => {
  const { answered, attachRetries, envLost, misses, reseating, startedHere, writeRetries } = ctx;
  misses.delete(name);
  answered.delete(name);
  startedHere.delete(name);
  attachRetries.delete(name);
  writeRetries.delete(name);
  envLost.delete(name);
  reseating.delete(name);
};

/** Apply `change` to each of `entries` in turn. */
export const updateEach = (ctx: PoolContext, entries: readonly Entry[], change: (queue: Queue, key: string) => Queue) =>
  update(ctx, (queue) => entries.reduce((next, entry) => change(next, entry.ticket.key), queue));

/** The pane a run's record holds, as a {@link RunPlace} carries it: none until the run has one. PURE. */
const paneOf = ({ pane }: Readonly<{ pane?: string }>): Pick<RunPlace, "pane"> => (pane === undefined ? {} : { pane });

/**
 * Where the run an entry is in lives: the herdr name of its workspace, the folder holding its brief and outcome, the folder its
 * agent starts in, and its pane. A ticket of a batch is in its batch's run, which is the only way a live or parked entry keeps its batch.
 */
export const runPlace = (ctx: PoolContext, entry: Entry): RunPlace => {
  const { settings } = ctx;
  return entry.batch === undefined
    ? { name: herdrName(entry.ticket.key), dir: ticketDir(settings, entry.ticket.key), folder: ticketFolder(settings, entry.ticket.key), ...paneOf(entry) }
    : { name: herdrName(entry.batch), dir: batchDir(settings, entry.batch), folder: batchFolder(settings, entry.batch), ...paneOf(entry) };
};

/** The entries in `entry`'s run, as the queue has them now: every ticket of its batch in the same phase and workspace, or else the entry alone. */
export const runMembers = (ctx: PoolContext, entry: Entry): Entry[] => {
  const { store } = ctx;
  return entry.batch === undefined ? [entry]
    : store.get().entries.filter((e) => e.batch === entry.batch && e.phase === entry.phase && e.workspace === entry.workspace);
};

/** Count one more listing in a row that the run named `name` was missing from. True once that reaches {@link MISSES_TO_GONE}. */
export function missedAgain(ctx: PoolContext, name: string): boolean {
  const { misses } = ctx;
  const count = (misses.get(name) ?? 0) + 1;
  misses.set(name, count);
  return count >= MISSES_TO_GONE;
}

/** Whether the run `entry` was taken from is still the run on the queue: not stopped, retried or started again since. */
export const sameRun = (ctx: PoolContext, entry: Entry): boolean => {
  const { store } = ctx;
  const now = store.get().entries.find((e) => e.ticket.key === entry.ticket.key);
  return now?.phase === "running" && now.workspace === entry.workspace && now.startedAt === entry.startedAt;
};

export const phaseOf = (ctx: PoolContext, key: string) => {
  const { store } = ctx;
  return store.get().entries.find((e) => e.ticket.key === key)?.phase;
};

/** Where a new-ticket run lives. Its herdr name is its id's, which no ticket's key can be. */
export const writerPlace = (ctx: PoolContext, run: WriterRun): RunPlace => {
  const { settings } = ctx;
  return { name: herdrName(`writer-${run.id}`), dir: writerDir(settings, run.id), folder: writerFolder(settings, run.id), ...paneOf(run) };
};

/** Whether the new-ticket run `id`'s agent is still running: a stop or a failure while its outcome is read is the last word, so nothing overwrites it. */
export const writerAgentRunning = (ctx: PoolContext, id: string): boolean => {
  const { store } = ctx;
  return writerOf(store.get(), id)?.phase === "running";
};

/** Where a publish run lives. Its herdr name is its id's, which no ticket's key can be. */
export const publishPlace = (ctx: PoolContext, publish: PublishRun): RunPlace => {
  const { settings } = ctx;
  return { name: herdrName(`publish-${publish.id}`), dir: publishDir(settings, publish.id), folder: publishFolder(settings), ...paneOf(publish) };
};
