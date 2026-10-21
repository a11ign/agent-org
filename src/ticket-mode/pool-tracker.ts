// @ts-check
// module: the tracker's view of the queue -- refreshing what it says, completing merged tickets, and retargeting stacked pull requests

import { existsSync } from "node:fs";
import { headsToRead, readBlockers, readHeads } from "./pool-start.ts";
import { completableRuns, MAX_FEEDBACK_ROUNDS, recordPullStates, recordRetargets, recordStackBase, recordTrackerStates, roundsLeft, unsettledKeys } from "./queue/queue-transitions.ts";
import { SETTLED, type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { moveOutcomeHeads } from "./queue/queue-pull-heads.ts";
import { log, messageOf, update } from "./pool-state.ts";
import { restoreStranded } from "./pool-settle.ts";
import { startStackConflictRound } from "./pool-watch.ts";
import { openPulls, pullsOf, type StackBaseRecord } from "./board-view/view-types-and-filters.ts";
import { resumesOnConflict, settledByPulls } from "./board-view/pull-status-and-notes.ts";
import { recordClosedByBoard } from "./queue.ts";
import { sweepRetargets } from "../ticket-port/stack-retarget.ts";
import { afterConflictCleared, afterMerge, conflictFeedback, mergedIn, mergeBaseIn, mergeDue, protectStack, readStackBase, releaseStack, remoteHead, stackBaseFile, stackBaseIn, stackRef, type MergeResult } from "./stack-rebase.ts";
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
 * The branch each stacked run was branched from, kept current on the server's own sweep (A11-116, A11-150). Each stacked run keeps its base commit reachable in
 * its clone, and the blocker's branch is read for a move. A finished run the board resumes on a conflict, with a pull request open in its repository, has the
 * blocker's branch merged in by agent-org when it moved, never by its worker. A merge that conflicts starts that run's conflict round, which merges the base in
 * and resolves it; a merge that cannot be made for another reason is tried again on the next sweep. A run that is not finished is only told the branch moved.
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

/** One run's stacked branch, for {@link rebaseStacked}: its base is kept reachable, and a moved branch is merged in, or noted as due. */
async function rebaseOneStack(ctx: PoolContext, entry: Entry): Promise<void> {
  const { git, settings, store } = ctx;
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
  // Without its worktree on this machine there is nothing to merge into, and no base to keep reachable for it: nothing is asked of the remote.
  const worktree = worktreePath(settings.worktreeRoot, key, found.repo);
  if (!existsSync(worktree)) return;
  await protectStack(git, clone, ref, found.sha);
  const head = await remoteHead(git, clone, found.branch);
  const seen = head !== null && head !== found.sha ? head : undefined;
  const record = store.get().entries.find((e) => e.ticket.key === key)?.stackBase ?? found;
  if (seen !== record.seen) update(ctx, (queue) => recordStackBase(queue, key, { ...record, seen }));
  // Read again now the awaits are over: the run may have been queued again, and a pool that starts it takes no part in this merge.
  const fresh = store.get().entries.find((e) => e.ticket.key === key);
  // A merge is made into a finished run's branch that no worker is running in: its workspace is closed, and it is not queued again. The lock is taken in the
  // same turn as the check, so a round starting in the pool cannot begin while this merge is in progress.
  if (fresh === undefined || !mergeable(fresh) || ctx.rebasing.has(key)) return;
  ctx.rebasing.add(key);
  try {
    await mergeMoved({ ctx, entry: fresh, found, record, head, worktree });
  } finally {
    ctx.rebasing.delete(key);
  }
}

/** Whether a run's branch may be merged into: the run is finished, and no workspace is open in it. PURE. */
const mergeable = (entry: Entry): boolean => entry.phase === "finished" && entry.workspace === undefined;

/**
 * Merge a moved blocker branch into a finished run's branch, under the sweep's lock (A11-150). A worker's round that merged the conflicting head in by hand
 * has resolved that conflict, so it clears first. A clean merge is recorded. A conflict is recorded, and starts the run's conflict round, only where a round
 * can start on it; elsewhere the merge is tried again on the next sweep, and a round that starts merges the base in first.
 */
async function mergeMoved({ ctx, entry, found, record, head, worktree }: {
  ctx: PoolContext; entry: Entry; found: StackBaseRecord; record: StackBaseRecord; head: string | null; worktree: string;
}): Promise<void> {
  const { git, now, store } = ctx;
  const key = entry.ticket.key;
  const cleared = record.conflict !== undefined && await mergedIn({ git, worktree, base: found, head: record.conflict.head });
  if (cleared) update(ctx, (queue) => recordStackBase(queue, key, afterConflictCleared(stackBaseIn(queue, key, record))));
  const current = cleared ? afterConflictCleared(record) : record;
  if (!mergeDue(current, head)) return;
  const result = await mergeBaseIn({ git, worktree, own: entry.ticket.branch, base: current });
  const latest = store.get().entries.find((e) => e.ticket.key === key) ?? entry;
  const roundable = resumesOnConflict(latest) && openPulls(latest).some((pr) => pr.repo === found.repo);
  const capped = roundsLeft(latest) ? undefined : MAX_FEEDBACK_ROUNDS;
  const recorded: MergeResult = !result.ok && result.conflict !== undefined && !roundable ? { ok: false, reason: result.reason } : result;
  update(ctx, (queue) => recordStackBase(queue, key, afterMerge(stackBaseIn(queue, key, current), head, recorded, now(), capped)));
  if (result.ok && result.pushed !== undefined) {
    const { from, to } = result.pushed;
    update(ctx, (queue) => moveOutcomeHeads(queue, key, from, to));
  }
  if (result.ok) return;
  if (result.conflict === undefined) {
    log(`${key}: the merge of ${found.key} ${result.reason}`);
    return;
  }
  if (!roundable) return;
  const urls = openPulls(latest).filter((pr) => pr.repo === found.repo).map((pr) => pr.url);
  startStackConflictRound(ctx, key, conflictFeedback(urls, found, result.conflict));
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
