// @ts-check
// module: the reads a start is decided on, made in the background (A11-364) -- blockers, the heads of stacked blockers' branches, and the paths of plans
//
// A LIVE READ NEVER GATES A START. `fill` awaits no network call: it decides from what these reads last recorded on each queued run (`queue/start-reads.ts` says which run is held for what it does not know). A read is made
// here, beside the pass, with a timeout; a read that fails records why on the runs it was for and when it is asked again, and holds those runs alone. Runs whose state is known start whatever the tracker is doing.
//
// Blockers and plans are two reads, and each is made for the runs that are due and no read is out for: a read that hangs holds the runs it was for until its timeout, and none queued since. When a read ends the pool is woken, so a
// start that was waiting on it is decided at once and not at the next pass.
import { dueBlockerKeys, duePaths, recordBlockersFailure } from "./queue/queue-start-reads.ts";
import { READ_RETRY_MS, retryTime } from "./queue/start-reads.ts";
import { headsToRead, readBlockers, readHeads, readPaths } from "./pool-start.ts";
import { log, messageOf, update } from "./pool-state.ts";
import type { PoolContext } from "./pool-context.ts";

/** The reads that are out: each ends by itself, and `reading` holds what they are for (`blockers:<key>`, `plan:<key>`), so a run is not read twice at once. */
export type StartReadsState = Readonly<{ pending: Set<Promise<void>>; reading: Set<string> }>;

/** What `reading` holds for the blockers of the run `key`, and for its plan. */
const blockersReading = (key: string): string => `blockers:${key}`;
const planReading = (key: string): string => `plan:${key}`;

/** The first line of what went wrong, as the board says it. */
const whyOf = (err: unknown): string => messageOf(err).split("\n")[0];

/**
 * Read the blockers of `keys`. A read that fails, or does not answer in time, records why on each of `keys`, with when the board asks again (from when it started, so the next pass asks), and says so in the log: those runs are held by it while their blockers are
 * unread or too old to start on, and no other run is. True when the blockers were read. Never throws.
 */
export async function readBlockersRecorded(ctx: PoolContext, keys: readonly string[]): Promise<boolean> {
  const retryAt = ctx.now() + READ_RETRY_MS;
  try {
    await readBlockers(ctx, keys);
    return true;
  } catch (err) {
    log(`${keys.join(", ")}: the tracker could not say which tickets block ${keys.length === 1 ? "it" : "them"} (${whyOf(err)}); the board asks again at ${retryTime(retryAt)}`);
    recordFailure(ctx, keys, whyOf(err), retryAt);
    return false;
  }
}

/** Record why a read failed on the runs it was for. A queue that cannot be written is said, and the failure is not recorded: the read is asked again, as it would be. */
function recordFailure(ctx: PoolContext, keys: readonly string[], error: string, retryAt: number): void {
  try {
    update(ctx, (queue) => recordBlockersFailure(queue, keys, error, retryAt));
  } catch (err) {
    log(`${keys.join(", ")}: why their blockers could not be read was not recorded (${whyOf(err)})`);
  }
}

/** Read the blockers of `keys`, and then the heads of their stacked blockers' branches, which a stacked start decides on. Never throws. */
async function readBlockersAndHeads(ctx: PoolContext, keys: readonly string[]): Promise<void> {
  if (!await readBlockersRecorded(ctx, keys)) return;
  try {
    if (headsToRead(ctx, keys)) await readHeads(ctx, keys);
  } catch (err) {
    log(`${keys.join(", ")}: the heads of the blockers' branches could not be read (${whyOf(err)})`);
  }
}

/** Start `read` beside the pass, not waiting for it, holding `held` against a second read: when it ends they are free to be read again and `wake` decides what its answer lets start. */
function readBeside(ctx: PoolContext, held: readonly string[], read: () => Promise<void>, wake: () => Promise<void>): void {
  const { pending, reading } = ctx.startReads;
  for (const each of held) reading.add(each);
  const mine: Promise<void> = read().catch((err) => log(`a read for a start failed: ${whyOf(err)}`)).then(() => {
    for (const each of held) reading.delete(each);
    return wake().catch((err) => log(`the pass after a read for a start failed: ${whyOf(err)}`));
  }).finally(() => { pending.delete(mine); });
  pending.add(mine);
}

/**
 * Bring what a start is decided on up to date, in the pass before `fill`: the runs whose blockers were never read or are too old, and the runs whose plan paths were never read, each not waiting out the retry after a failed
 * read. A read the source can answer without the network is recorded now, so a run that needs none starts in this pass. The others are started beside the pass and NOT waited for (see {@link readBeside}), so a tracker that is
 * slow, down or hung holds the runs it was asked about and no other. A paused queue reads no plan: the plans are read when it is unpaused.
 */
export function refreshStartReads(ctx: PoolContext, wake: () => Promise<void>): void {
  const { settings, source, store } = ctx;
  const { reading } = ctx.startReads;
  const at = ctx.now();
  const queue = store.get();
  const keys = dueBlockerKeys(queue, at).filter((key) => !reading.has(blockersReading(key)));
  const plans = (queue.paused ? [] : duePaths(queue, at)).filter(({ ticket }) => !reading.has(planReading(ticket.key)));
  const remote = source.blockers !== undefined || source.projectSummaries !== undefined;
  if (keys.length > 0 && !remote) void readBlockersAndHeads(ctx, keys).catch((err) => log(`the blockers of ${keys.join(", ")} could not be recorded: ${whyOf(err)}`));
  if (plans.length > 0 && settings.plan === null) void readPaths(ctx, plans).catch((err) => log(`the plans of the queued runs could not be recorded: ${whyOf(err)}`));
  if (keys.length > 0 && remote) readBeside(ctx, keys.map(blockersReading), () => readBlockersAndHeads(ctx, keys), wake);
  if (plans.length > 0 && settings.plan !== null) readBeside(ctx, plans.map(({ ticket }) => planReading(ticket.key)), () => readPaths(ctx, plans), wake);
}

/** Settles once every read {@link refreshStartReads} started has ended and the pass it woke has run (at once when none is out). Never rejects. */
export async function startReadsSettled(ctx: PoolContext): Promise<void> {
  const { pending } = ctx.startReads;
  while (pending.size > 0) await Promise.all([...pending]);
}
