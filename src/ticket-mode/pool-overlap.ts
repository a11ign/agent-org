// @ts-check
// module: the pool's side of "overlap means stack, not wait" (A11-374) -- what the overlap hold is given to decide on, and the record of the stack a run starts on
//
// THE HOLD DECIDES FROM THE QUEUE ALONE (A11-362: a live read never gates a start), so what it reads is recorded beside the pass: the paths each queued and live run's ticket Region names (from the description the board holds, and again whenever the
// board reads it), the commit a live run's own branch is at once it has pushed it (a queued run that overlaps it builds on that branch while it has no pull request), and, as a run is started, the run it is stacked on. A stack whose base is done is cleared.
import { repoOf } from "./board-view/waits-on.ts";
import { overlapHits } from "./board-view/overlap-hold.ts";
import { blockingHits } from "./board-view/overlap-stack.ts";
import { READ_RETRY_MS } from "./queue/start-reads.ts";
import { dropSettledOverlapStacks, recordOverlapStack, recordPushedHeads, recordRegionPaths, sameList } from "./queue/queue-overlap-stack.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
import { log, messageOf, update } from "./pool-state.ts";
import { regionClaimsOf } from "./region-claims.ts";
import { remoteHead } from "./stack-rebase.ts";
import { withinTime } from "../install/time-limit.ts";
import type { PoolContext } from "./pool-context.ts";

/** Record the Region of `description` on the run `key`, when it is not the one the run holds. Nothing is written for a run that is gone or holds it already. */
export function noteRegion(ctx: PoolContext, key: string, description: string): void {
  const entry = ctx.store.get().entries.find((each) => each.ticket.key === key);
  if (entry === undefined || !isQueuedOrLive(entry)) return;
  // A ticket stored on the queue before its text was read has none: it names no Region.
  const paths = regionClaimsOf(description ?? "", Object.keys(ctx.settings.clones));
  if (!sameList(entry.regionPaths, paths)) update(ctx, (queue) => recordRegionPaths(queue, key, paths));
}

/** Whether a run is queued, or at work. PURE. */
const isQueuedOrLive = (entry: Entry): boolean => entry.phase === "queued" || entry.phase === "starting" || entry.phase === "running";

/**
 * What a pass does before it chooses what to start (A11-374): reads the Region of each queued and live run that has none from the ticket text the board holds (`noteRegion` keeps it current whenever the tracker is read), and clears the overlap stacks whose base
 * is done. No read is made, so no pass waits for one.
 */
export function followOverlaps(ctx: PoolContext): void {
  const { entries } = ctx.store.get();
  // Only a run whose Region was never read: the ticket text the queue holds is the one the run was queued with, and the board's later reads of the tracker (`followTicketTexts`) are newer than it.
  for (const entry of entries) if (entry.regionPaths === undefined && isQueuedOrLive(entry)) noteRegion(ctx, entry.ticket.key, entry.ticket.description);
  const next = dropSettledOverlapStacks(ctx.store.get());
  if (next !== ctx.store.get()) update(ctx, () => next);
}

/** Record the run each of `starts` stacks on, before its worker is prepared: the brief reads it (`stackedOn`). */
export function recordStacks(ctx: PoolContext, starts: readonly Entry[]): void {
  for (const { ticket, overlapStack } of starts) if (overlapStack !== undefined) update(ctx, (queue) => recordOverlapStack(queue, ticket.key, overlapStack));
}

/** When the branches of the runs at work were last asked for, by pool: a remote that cannot say is not asked on every pass, since a read that ends wakes the pass that asks again. */
const branchesAskedAt = new WeakMap<object, number>();

/**
 * The runs whose own branch the board is to read now (A11-374): a run at work in a repository this machine has, with no branch read as pushed yet, that a queued run waits for to push one (`blockingHits`). Asked for at most once in {@link READ_RETRY_MS},
 * and the time is taken here, as the read is begun.
 */
export function takeBranchesToRead(ctx: PoolContext): Entry[] {
  const { entries } = ctx.store.get();
  const asked = branchesAskedAt.get(ctx.store);
  if (asked !== undefined && ctx.now() - asked < READ_RETRY_MS) return [];
  const waitedFor = new Set(entries.filter((entry) => entry.phase === "queued").flatMap((entry) => blockingHits(entry, overlapHits(entry, entries)).map(({ holder }) => holder.ticket.key)));
  const runs = entries.filter((entry) => waitedFor.has(entry.ticket.key) && isBranchToRead(ctx, entry));
  if (runs.length > 0) branchesAskedAt.set(ctx.store, ctx.now());
  return runs;
}

/** Whether the branch of `entry` is to be read: it is at work (not planning), its repository is cloned here, and it was not read as pushed yet. PURE. */
function isBranchToRead(ctx: PoolContext, entry: Entry): boolean {
  const repo = repoOf(entry);
  const atWork = (entry.phase === "starting" || entry.phase === "running") && entry.plan === undefined;
  return atWork && entry.pushed === undefined && repo !== null && ctx.settings.clones[repo] !== undefined;
}

/**
 * Record which of the branches of `runs` are pushed, and at what commit: `git ls-remote` of each in the clone of its repository, all at once and each given `ctx.readMs` (A11-359), so a remote that never answers costs the pass one wait. A branch not pushed
 * records nothing, and is read again once {@link READ_RETRY_MS} has passed ({@link takeBranchesToRead}). A failed or late read is logged once for the run and records nothing. Never throws.
 */
export async function readPushedHeads(ctx: PoolContext, runs: readonly Entry[]): Promise<void> {
  const found = await Promise.all(runs.map(async (run) => {
    const repo = repoOf(run) ?? "";
    try {
      const head = await withinTime(ctx.readMs, `the remote's read of ${run.ticket.branch}`, remoteHead(ctx.git, ctx.settings.clones[repo], run.ticket.branch));
      return head === null ? null : ([run.ticket.key, { repo, head }] as const);
    } catch (err) {
      // Said once for a run, not on every try.
      if (!ctx.recordSaid.has(`pushed:${run.ticket.key}`)) log(`${run.ticket.key}: the remote could not say whether ${run.ticket.branch} is pushed: ${messageOf(err)}`);
      ctx.recordSaid.add(`pushed:${run.ticket.key}`);
      return null;
    }
  }));
  const pushed = new Map(found.filter((each) => each !== null));
  if (pushed.size > 0) update(ctx, (queue) => recordPushedHeads(queue, pushed));
}
