// @ts-check
// module: the tracker's view of the queue -- refreshing what it says, completing merged tickets, and retargeting stacked pull requests

import { existsSync } from "node:fs";
import { headsToRead, readBlockers, readHeads } from "./pool-start.ts";
import { completableRuns, recordPullStates, recordRetargets, recordStackBase, recordTrackerStates, unsettledKeys } from "./queue/approve.ts";
import { SETTLED, type Entry } from "./queue/declared-remains.ts";
import { log, messageOf, update } from "./pool-state.ts";
import { restoreStranded } from "./pool-settle.ts";
import { openPulls, pullsOf, type StackBaseRecord } from "./board-view/view-ticket.ts";
import { settledByPulls } from "./board-view/settled-by-pulls.ts";
import { recordClosedByBoard } from "./queue.ts";
import { sweepRetargets } from "../ticket-port/stack-retarget.ts";
import { afterRebase, protectStack, rebaseDue, rebaseOnto, readStackBase, releaseStack, remoteHead, stackBaseFile, stackBaseIn, stackRef, type RebaseResult } from "./stack-rebase.ts";
import { worktreePath } from "./worktree.ts";
import { type PoolContext } from "./pool-context.ts";

/**
 * Ask the tracker where each finished run's ticket and pull requests stand, so a run whose pull requests merged reads as completed, and which
 * tickets block each queued run, so a relation changed in the tracker and a blocker finished outside the queue both count. A refused read
 * changes nothing.
 */
export async function refreshTracker(ctx: PoolContext): Promise<void> {
  const { source, store } = ctx;
  try {
    await readBlockers(ctx, store.get().entries.filter((entry) => entry.phase === "queued").map((entry) => entry.ticket.key));
  } catch {
    // the tracker could not be asked: the next refresh asks again
  }
  const keys = unsettledKeys(store.get());
  if (keys.length > 0) {
    try {
      if (source.stateTypes !== undefined) {
        const states = await source.stateTypes(keys);
        update(ctx, (queue) => recordTrackerStates(queue, states));
      }
      if (source.pullStates !== undefined) {
        const pulls = await source.pullStates(keys);
        update(ctx, (queue) => recordPullStates(queue, pulls));
      }
    } catch {
      // the tracker could not be asked: the next refresh asks again
    }
  }
  await completeMerged(ctx);
  // Last, so a restore the tracker is slow to answer delays none of the reads above.
  await restoreStranded(ctx);
  // The heads of the queued runs' stacked blockers come last of all: a git read per branch must not delay the tracker's own reads.
  const queued = store.get().entries.filter((entry) => entry.phase === "queued").map((entry) => entry.ticket.key);
  if (headsToRead(ctx, queued)) await readHeads(ctx, queued);
}

/**
 * Complete the ticket of each run whose pull requests merged while the ticket is still open, and whose body did not complete it (A11-92): the body may
 * have named the ticket with the non-closing keyword, or been wrong, so the board does not wait for the tracker to do it. The tracker is asked again for
 * those tickets first, so one it finished or canceled is left alone. A refusal is logged, and tried again at the next refresh.
 */
async function completeMerged(ctx: PoolContext): Promise<void> {
  const { source, store } = ctx;
  const { complete, stateTypes } = source;
  if (complete === undefined || stateTypes === undefined) return;
  const due = completableRuns(store.get());
  if (due.length === 0) return;
  try {
    const states = await stateTypes(due.map((entry) => entry.ticket.key));
    update(ctx, (queue) => recordTrackerStates(queue, states));
  } catch (err) {
    log(`the tracker could not say where the merged tickets stand: ${messageOf(err)}`);
    return;
  }
  for (const entry of completableRuns(store.get())) {
    const { ticket } = entry;
    const merged = pullsOf(entry).map(({ url }) => url).filter((url) => entry.pullStates?.[url] === "merged");
    const comment = `${merged.join(", ")} merged without closing ${ticket.key}, so the ticket board completed it.`;
    try {
      const note = await complete(ticket.key, comment);
      update(ctx, (queue) => recordClosedByBoard(queue, ticket.key));
      if (note !== null) log(note);
    } catch (err) {
      log(`${ticket.key}: the merged pull request could not complete its ticket: ${messageOf(err)}`);
    }
  }
}

/**
 * The branch each stacked run was branched from, kept current on the server's own sweep (A11-116). Each stacked run keeps its base commit reachable in its
 * clone, and the blocker's branch is read for a move: a finished run with a pull request still open, or its worktree on disk, and no worker in its workspace,
 * is rebased onto a moved branch by agent-org, never by its worker. A rebase that cannot be made is recorded against that head and not retried until the branch
 * moves again. A run that is not finished is only told the branch moved, so the board says it will be rebased when its worker stops.
 */
export async function rebaseStacked(ctx: PoolContext): Promise<void> {
  const { store } = ctx;
  for (const entry of store.get().entries) {
    if (entry.phase === "queued") continue;
    try {
      await rebaseOneStack(ctx, entry);
    } catch (err) {
      log(`${entry.ticket.key}: its stacked branch could not be checked: ${messageOf(err)}`);
    }
  }
}

/** The branch a run was branched from, as the pool keeps it: the one it recorded, or the one `ticket:worktree --from` wrote, matched to its blocker. */
function stackBaseOf(ctx: PoolContext, entry: Entry): StackBaseRecord | undefined {
  if (entry.stackBase !== undefined) return entry.stackBase;
  const file = readStackBase(stackBaseFile(ctx.settings, entry.ticket.key));
  const blocker = file === null ? undefined : (entry.blockers ?? []).find((b) => b.branch === file.branch);
  return file === null || blocker === undefined ? undefined : { key: blocker.key, repo: file.repo, branch: file.branch, sha: file.sha };
}

/** Whether a run's worker may hold its worktree: a run that is not finished, or one whose workspace is still open (a parked run's is closed first). PURE. */
const workerHoldsWorktree = (entry: Entry): boolean => entry.phase !== "finished" || entry.workspace !== undefined;

/** The stacked branch a run carries now, as the queue holds it: a rebase writes it back on top of what is there, not on a copy read before it. PURE. */

/** One run's stacked branch, for {@link rebaseStacked}: its base is kept reachable, and a moved branch is rebased or noted as due. */
async function rebaseOneStack(ctx: PoolContext, entry: Entry): Promise<void> {
  const { git, now, settings, store } = ctx;
  const key = entry.ticket.key;
  const found = stackBaseOf(ctx, entry);
  if (found === undefined) return;
  if (found !== entry.stackBase) update(ctx, (queue) => recordStackBase(queue, key, found));
  const clone = settings.clones[found.repo];
  if (clone === undefined) return;
  const ref = stackRef(key, found.key);
  // A run whose pull requests all merged or closed, or whose tracker state settled it, no longer needs its base kept.
  if (settledByPulls(entry) !== null || SETTLED.has(entry.trackerState ?? "")) {
    await releaseStack(git, clone, ref).catch(() => undefined);
    return;
  }
  // Without its worktree on this machine there is nothing to rebase, and no base to keep reachable for it: nothing is asked of the remote.
  const worktree = worktreePath(settings.worktreeRoot, key, found.repo);
  if (!existsSync(worktree)) return;
  await protectStack(git, clone, ref, found.sha);
  const head = await remoteHead(git, clone, found.branch);
  const seen = head !== null && head !== found.sha ? head : undefined;
  const record = store.get().entries.find((e) => e.ticket.key === key)?.stackBase ?? found;
  if (seen !== record.seen) update(ctx, (queue) => recordStackBase(queue, key, { ...record, seen }));
  // Read again now the awaits are over: the run may have been queued again, and a pool that starts it takes no part in this rebase.
  const fresh = store.get().entries.find((e) => e.ticket.key === key);
  // A rebase is made only when no worker holds the worktree, and only for a branch that moved from the one the run was branched from. The lock is taken
  // in the same turn as the check, so a round starting in the pool cannot begin while this rebase is in progress.
  const mayRebase = fresh !== undefined && !workerHoldsWorktree(fresh) && !ctx.rebasing.has(key);
  if (!mayRebase || head === null || !rebaseDue(record, head)) return;
  ctx.rebasing.add(key);
  let result: RebaseResult;
  try {
    result = await rebaseOnto({ git, clone, worktree, own: entry.ticket.branch, base: record });
  } finally {
    ctx.rebasing.delete(key);
  }
  update(ctx, (queue) => recordStackBase(queue, key, afterRebase(stackBaseIn(queue, key, record), head, result, now())));
  if (!result.ok) log(`${key}: the rebase onto ${found.key} ${result.reason}`);
}

/**
 * The stale bases of the open pull requests on the queue, asked on the server's own sweep (every `FEEDBACK_MS`), as `releaseReviewers` is (A11-106): a
 * stacked pull request whose base merged is moved to the default branch (`stack-retarget.ts`), and what a run still needs said of its bases is recorded
 * when it changes. The default branch of each repository is read once per sweep. Only a finished run stacked on a blocker's branch is asked, and only its open
 * pull requests whose base is one of those branches.
 */
export function retargetStacked(ctx: PoolContext): void {
  const { gh, store } = ctx;
  const defaults = new Map<string, string>();
  for (const entry of store.get().entries) {
    // Only a finished run is asked: the board shows its note on a finished run alone, and a run that is not finished is not written to here. Only a run
    // stacked on a blocker's branch has a base the board moves; any other pull request's base is the worker's own, and is left as it is.
    if (entry.phase !== "finished") continue;
    const stacked = new Set((entry.blockers ?? []).flatMap(({ branch }) => (branch ? [branch] : [])));
    const urls = openPulls(entry).map(({ url }) => url);
    if (stacked.size === 0 || urls.length === 0) continue;
    const previous = entry.retargets ?? {};
    const notes = sweepRetargets({ urls, previous, stacked, defaults, gh, log });
    const next = Object.keys(notes).length === 0 ? undefined : notes;
    if (JSON.stringify(next ?? {}) !== JSON.stringify(previous)) update(ctx, (queue) => recordRetargets(queue, entry.ticket.key, next));
  }
}
