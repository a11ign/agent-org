// @ts-check
// module: the tracker's view of the queue -- refreshing what it says, completing merged tickets, and retargeting stacked pull requests

import { existsSync } from "node:fs";
import { headsToRead, readBlockers, readHeads, undoEarlyCompletion } from "./pool-start.ts";
import { completableRuns, MAX_FEEDBACK_ROUNDS, recordPullStates, recordRetargets, recordStackBase, recordTrackerStates, roundsLeft, unsettledKeys } from "./queue/queue-transitions.ts";
import { SETTLED, type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { earlyCompletions, nextStepRuns, queueNextStep } from "./queue/queue-next-step.ts";
import { afterMergeDue, afterMergeUnposted, markAfterMergePosted, markAfterMergeUnposted, recordAfterMerge } from "./queue/queue-after-merge.ts";
import { moveOutcomeHeads } from "./queue/queue-pull-heads.ts";
import { log, messageOf, update } from "./pool-state.ts";
import { restoreStranded } from "./pool-settle.ts";
import { startStackConflictRound } from "./pool-watch.ts";
import { openPulls, pullsOf, type StackBaseRecord } from "./board-view/view-types-and-filters.ts";
import { pullLabel } from "./board-view/pull-label.ts";
import { resumesOnConflict } from "./board-view/pull-status-and-notes.ts";
import { isPullReadyToMerge } from "./board-view/pull-readiness.ts";
import { handBackNote, isStackMergeNote, stackMergeRequestOf, stackMergeStep } from "./stack-merge.ts";
import { settledByPulls } from "./board-view/pull-settled.ts";
import { recordClosedByBoard } from "./queue.ts";
import { afterConflictCleared, afterMerge, conflictFeedback, mergedIn, mergeBaseIn, mergeDue, protectStack, readStackBase, releaseStack, remoteHead, stackBaseFile, stackBaseIn, stackRef, type MergeResult } from "./stack-rebase.ts";
import { worktreePath } from "./worktree.ts";
import { followTicketTexts, learnFromBlockers } from "./pool-ticket-text.ts";
import { readPlanSteps } from "./pool-plan-steps.ts";
import { readPullDeclarations } from "./pool-pull-declarations.ts";
import { type PoolContext } from "./pool-context.ts";

/**
 * Ask the tracker where each finished run's ticket and pull requests stand, so a run whose pull requests merged reads as completed, except a partial run whose ticket the tracker's integration completed, which is put back (A11-178) once the merged bodies are read, since a merged `Closes` or `Partial:` decides over the outcome's `partial`
 * (A11-181), and which tickets block each queued run, so a relation changed in the tracker and a blocker finished outside the queue both count. A refused read
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
        update(ctx, (queue) => recordPullStates(queue, pulls, ctx.now()));
      }
    } catch {
      // the tracker could not be asked: the next refresh asks again
    }
  }
  // What each merged pull request's body declares decides over the outcome's `partial`, so it is read before anything acts on the merge (A11-181).
  readPullDeclarations(ctx);
  // A ticket the tracker's integration completed on a partial merge is put back first, so the same sweep queues the next step (A11-178).
  for (const entry of earlyCompletions(store.get())) await undoEarlyCompletion(ctx, entry);
  await readPlanSteps(ctx);
  queueNextSteps(ctx);
  await completeMerged(ctx);
  await noteAfterMerge(ctx);
  // What each queued run's blockers' merged pull requests found reaches its planner, and a change in a ticket's description reaches its stamped plan or its live worker (A11-167).
  learnFromBlockers(ctx);
  try {
    await followTicketTexts(ctx);
  } catch {
    // the tracker could not be asked: the next refresh asks again
  }
  // Last, so a restore the tracker is slow to answer delays none of the reads above.
  await restoreStranded(ctx);
  // The heads of the queued runs' stacked blockers come last of all: a git read per branch must not delay the tracker's own reads.
  const queued = store.get().entries.filter((entry) => entry.phase === "queued").map((entry) => entry.ticket.key);
  if (headsToRead(ctx, queued)) await readHeads(ctx, queued);
}

/**
 * Queue the next plan step of each run whose partial pull requests merged (A11-168): the finished entry is replaced by a queued one on the same plan, which starts like any
 * queued run, with the slot cap, its blockers and the overlap wait applying. Run on every sweep, ahead of {@link completeMerged}, which leaves a partial run's ticket open
 * and so would have left the run on the board as finished. A run with no next step to queue is left finished, and the board says why on its card.
 */
function queueNextSteps(ctx: PoolContext): void {
  const { now, store } = ctx;
  for (const { entry, step } of nextStepRuns(store.get())) {
    update(ctx, (queue) => queueNextStep(queue, entry.ticket.key, step, now()));
    const counted = step.counted ? `the Partial line named no step; counted as step ${step.step} of ${step.of}; ` : `step ${step.step} of ${step.of} merged; `;
    log(`${entry.ticket.key}: ${counted}step ${step.step + 1} queued`);
  }
}

/**
 * List the After-merge checks of each Completed run whose pull requests merged (A11-173): the ticket's After-merge lines, with who runs each, are recorded on the run, which the board's
 * "After-merge checks" list shows, and then posted once as a comment on the ticket, whoever completed it. The post is marked before it is sent, so a second sweep never posts it beside the
 * first, and unmarked when it fails, so the next sweep tries again. A tracker that cannot comment has them on the board alone, and the log says so.
 */
async function noteAfterMerge(ctx: PoolContext): Promise<void> {
  const { source, store } = ctx;
  for (const { entry, lines } of afterMergeDue(store.get())) {
    update(ctx, (queue) => recordAfterMerge(queue, entry.ticket.key, lines));
    if (source.comment === undefined) log(`${entry.ticket.key}: its After-merge checks are on the board; this tracker cannot post them as a comment`);
  }
  if (source.comment === undefined) return;
  for (const entry of afterMergeUnposted(store.get())) {
    const key = entry.ticket.key;
    update(ctx, (queue) => markAfterMergePosted(queue, key));
    try {
      await source.comment(key, afterMergeComment(entry));
    } catch (err) {
      update(ctx, (queue) => markAfterMergeUnposted(queue, key));
      log(`${key}: its After-merge checks could not be posted as a comment, and are tried again at the next refresh: ${messageOf(err)}`);
    }
  }
}

/** The comment that lists a merged run's After-merge checks on its ticket. PURE. */
function afterMergeComment(entry: Entry): string {
  const merged = pullsOf(entry).filter(({ url }) => entry.pullStates?.[url] === "merged").map(({ url }) => pullLabel(url));
  const lines = (entry.afterMerge ?? []).map(({ line, owner }) => `- ${line} (${owner ?? "owner not named"})`);
  return [`After-merge checks for ${entry.ticket.key}, now that ${merged.join(", ")} merged:`, ...lines].join("\n");
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
    const comment = entry.declared?.kind === "closes" ? `${merged.join(", ")} merged and its body completes ${ticket.key}, which the tracker had not yet done, so the ticket board completed it.`
      : `${merged.join(", ")} merged without closing ${ticket.key}, so the ticket board completed it.`;
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
 * The stacked pull requests on the queue that need something said, asked on the server's own sweep (every `FEEDBACK_MS`), as `releaseReviewers` is (A11-106, A11-238). It is the one writer of a finished run's per-URL notes (`retargets`), so what it
 * records is one map: the stale bases first (`stack-retarget.ts`: a stacked pull request whose base merged is moved to the default branch, over a finished run stacked on a blocker's branch, and only its open pull requests whose base is one of those
 * branches), then the stack merge of every other open pull request ({@link sweepStackMerges}). The default branch of each repository is read once per sweep. The note is recorded when it changes.
 */
export function retargetStacked(ctx: PoolContext): void {
  const { codeHost, store } = ctx;
  const defaults = new Map<string, string>();
  for (const entry of store.get().entries) {
    // Only a finished run is asked: the board shows its note on a finished run alone, and a run that is not finished is not written to here. Only a run
    // stacked on a blocker's branch has a base the board moves; any other pull request's base is the worker's own, and is left as it is.
    if (entry.phase !== "finished") continue;
    const stacked = new Set((entry.blockers ?? []).flatMap(({ branch }) => (branch ? [branch] : [])));
    const urls = openPulls(entry).map(({ url }) => url);
    if (urls.length === 0) continue;
    const previous = entry.retargets ?? {};
    // The sweep of the bases keeps the note of a pull request it cannot read, so it is handed only the notes it wrote: one the stack merge wrote is the stack merge's to keep or clear.
    const baseNotesBefore = Object.fromEntries(Object.entries(previous).filter(([, note]) => !isStackMergeNote(note)));
    const bases = stacked.size === 0 ? {} : codeHost.sweepRetargets({ urls, previous: baseNotesBefore, stacked, defaults, log });
    const notes = { ...bases, ...sweepStackMerges(ctx, entry, urls, bases) };
    const next = Object.keys(notes).length === 0 ? undefined : notes;
    if (JSON.stringify(next ?? {}) !== JSON.stringify(previous)) update(ctx, (queue) => recordRetargets(queue, entry.ticket.key, next));
  }
}

/**
 * The stack merge of a finished run's open pull requests (A11-238): each one that is approved and green is read (`stackMergeFactsOf`) and goes through {@link stackMergeStep}, and when that asks, the arm bot is asked to merge it (`requestStackMerge`) and the ask is
 * remembered by head. The note a pull request needs is what GitHub refused it with, or that the arm bot could not be asked (and the ask is made again on the next sweep). A pull request with a note about its base has none here: its stack merge waits for the base. One that cannot be read keeps the note it had.
 * A pull request that is not ready is not read at all, and a head the watch read is not the head GitHub says now is not ready either. A code host that has neither operation (before contract 1.16) asks the arm bot for nothing.
 */
function sweepStackMerges(ctx: PoolContext, entry: Entry, urls: readonly string[], baseNotes: Readonly<Record<string, string>>): Record<string, string> {
  const { codeHost, now, stackMergeAsked } = ctx;
  const notes: Record<string, string> = {};
  if (codeHost.stackMergeFactsOf === undefined || codeHost.requestStackMerge === undefined) return notes;
  for (const url of urls) {
    if (baseNotes[url] !== undefined || !isPullReadyToMerge(entry, url)) continue;
    const facts = codeHost.stackMergeFactsOf(url);
    if (facts === null) {
      const kept = entry.retargets?.[url];
      if (kept !== undefined && isStackMergeNote(kept)) notes[url] = kept;
      continue;
    }
    const step = stackMergeStep({ url, facts, ready: entry.pullHeads?.[url]?.head === facts.head, asked: stackMergeAsked.get(url), now: now() });
    if (step.note !== null) notes[url] = step.note;
    const refused = step.ask ? askArmBot(ctx, url, facts.head) : null;
    if (refused !== null) notes[url] = refused;
  }
  return notes;
}

/** Asks the arm bot to stack-merge the pull request at `head` and remembers that it did. @returns the note to show when the ask was refused (it is made again on the next sweep), or null once it was made. */
function askArmBot(ctx: PoolContext, url: string, head: string): string | null {
  const request = stackMergeRequestOf(url);
  try {
    if (request === null) throw new Error("it is not a GitHub pull request address");
    ctx.codeHost.requestStackMerge?.(request);
    ctx.stackMergeAsked.set(url, { head, at: ctx.now() });
    log(`${url}: approved and green in a stack, so the arm bot was asked to merge it with the stack merge`);
    return null;
  } catch (err) {
    log(`${url}: the arm bot could not be asked to merge it: ${messageOf(err)}`);
    return handBackNote(url, messageOf(err));
  }
}
