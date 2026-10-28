// @ts-check
// module: the tracker's view of the queue -- refreshing what it says, completing merged tickets, and retargeting stacked pull requests

import { joinRunning } from "./pool-reads.ts";
import { existsSync } from "node:fs";
import { headsToRead, readHeads, undoEarlyCompletion } from "./pool-start.ts";
import { readBlockersRecorded } from "./pool-start-reads.ts";
import { completableRuns, MAX_FEEDBACK_ROUNDS, recordPullStates, recordRetargets, recordStackBase, recordTrackerStates, roundsLeft, unsettledKeys } from "./queue/queue-transitions.ts";
import { SETTLED, type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { earlyCompletions, nextStepRuns, queueNextStep } from "./queue/queue-next-step.ts";
import { afterMergeDue, afterMergeUnposted, markAfterMergePosted, markAfterMergeUnposted, recordAfterMerge } from "./queue/queue-after-merge.ts";
import { moveOutcomeHeads } from "./queue/queue-pull-heads.ts";
import { log, messageOf, update } from "./pool-state.ts";
import { restoreStranded } from "./pool-settle.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { resumeTicketWaits } from "./pool-cap.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { startStackConflictRound } from "./pool-watch.ts";
import { openPulls, pullsOf, type StackBaseRecord } from "./board-view/view-types-and-filters.ts";
import { pullLabel } from "./board-view/pull-label.ts";
import { resumesOnConflict } from "./board-view/pull-status-and-notes.ts";
import { isPullReadyToMerge } from "./board-view/pull-readiness.ts";
import { handBackNote, isStackMergeNote, stackMergeRequestOf, stackMergeStep } from "./stack-merge.ts";
import { settledByPulls } from "./board-view/pull-settled.ts";
import { recordClosedByBoard } from "./queue.ts";
import type { StackMergeFacts } from "../plugins/contracts/code-host.ts";
import { afterConflictCleared, afterMerge, conflictFeedback, mergedIn, mergeBaseIn, mergeDue, protectStack, readStackBase, releaseStack, remoteHead, stackBaseFile, stackBaseIn, stackRef, type MergeResult } from "./stack-rebase.ts";
import { worktreePath } from "./worktree.ts";
import { followTicketTexts, learnFromBlockers } from "./pool-ticket-text.ts";
import { readPlanSteps } from "./pool-plan-steps.ts";
import { readPullDeclarations } from "./pool-pull-declarations.ts";
import { adoptNamedBlockers, releaseMergedBlockers } from "./pool-blocker-cleared.ts";
import { askUpdate } from "./pool-checks.ts";
import { recordClosedWork } from "./pool-closed-work.ts";
import { closeEmptyMember, followHead } from "./pool-restack-close.ts";
import { isClosedMemberNote, isEmptyMemberNote, isRestackedNote, type ConflictRound, isRestackNote, isRestackProblemNote, restackedAfter, restackFeedback, restackNote, restackStep, type RestackBelow, type RestackOutcome } from "./stack-restack.ts";
import { type PoolContext } from "./pool-context.ts";
import { syncAfterMergeChecks } from "./after-merge/sweep.ts";
import { syncReliabilityWatches } from "./reliability/sweep.ts";

/**
 * Ask the tracker where each finished run's ticket and pull requests stand, so a run whose pull requests merged reads as completed, except a partial run whose ticket the tracker's integration completed, which is put back (A11-178) once the merged bodies are read, since a merged `Closes` or `Partial:` decides over the outcome's `partial`
 * (A11-181), and which tickets block each queued run, so a relation changed in the tracker and a blocker finished outside the queue both count. A refused read
 * changes nothing.
 */
export async function refreshTracker(ctx: PoolContext): Promise<void> {
  const { source, store } = ctx;
  // A refused or hung read is recorded on the runs it was for and said in the log (A11-364); the next refresh asks again.
  await readBlockersRecorded(ctx, store.get().entries.filter((entry) => entry.phase === "queued").map((entry) => entry.ticket.key));
  const keys = unsettledKeys(store.get());
  if (keys.length > 0) {
    try {
      if (source.stateTypes !== undefined) {
        const states = await source.stateTypes(keys);
        update(ctx, (queue) => recordTrackerStates(queue, states));
      }
      if (source.pullStates !== undefined) {
        const pulls = await source.pullStates(keys);
        // Before the record: a needs-human run that holds no pull request waits on the ones its reason names, which it is told apart from context by having been read open (A11-258).
        adoptNamedBlockers(ctx, pulls);
        update(ctx, (queue) => recordPullStates(queue, pulls, ctx.now()));
      }
    } catch {
      // the tracker could not be asked: the next refresh asks again
    }
  }
  // A run the planner marked as waiting on another ticket starts again once that ticket's pull request merged (A11-343).
  await resumeTicketWaits(ctx);
  // What each merged pull request's body declares decides over the outcome's `partial`, so it is read before anything acts on the merge (A11-181).
  await readPullDeclarations(ctx);
  // A ticket the tracker's integration completed on a partial merge is put back first, so the same sweep queues the next step (A11-178).
  for (const entry of earlyCompletions(store.get())) await undoEarlyCompletion(ctx, entry);
  // A parked needs-human run whose pull requests merged lets go of its workspace, which the next-step and plan-count sweeps below require (A11-258).
  releaseMergedBlockers(ctx);
  await readPlanSteps(ctx);
  queueNextSteps(ctx);
  await completeMerged(ctx);
  await noteAfterMerge(ctx);
  // What each queued run's blockers' merged pull requests found reaches its planner, and a change in a ticket's description reaches its stamped plan or its live worker (A11-167).
  await learnFromBlockers(ctx);
  try {
    await followTicketTexts(ctx);
  } catch {
    // the tracker could not be asked: the next refresh asks again
  }
  // Last, so a restore the tracker is slow to answer delays none of the reads above.
  await restoreStranded(ctx);
  // A pull request closed without merging holds work no branch has: it is listed, kept and posted on its ticket (A11-249). After the reads above, since each one costs a code host read and a comment.
  await recordClosedWork(ctx);
  // The heads of the queued runs' stacked blockers come after the tracker's own reads: a git read per branch must not delay them.
  const queued = store.get().entries.filter((entry) => entry.phase === "queued").map((entry) => entry.ticket.key);
  if (headsToRead(ctx, queued)) await readHeads(ctx, queued);
  // Then: the After-merge lines listed above become checks of their own, which outlive their runs, and each close is posted on its ticket (A11-277). A close waiting to be posted delays none of the reads above.
  await syncAfterMergeChecks(ctx);
  // Then the board-reliability tickets: each is watched on the figure it names, and reopened once, with the readings, when the figure does not hold (A11-366).
  await syncReliabilityWatches(ctx);
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
export function afterMergeComment(entry: Entry): string {
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
export function retargetStacked(ctx: PoolContext): Promise<void> {
  return joinRunning(RETARGETING, ctx, () => retargetEach(ctx));
}

const RETARGETING = new WeakMap<object, Promise<void>>();

/** {@link retargetStacked}, one pass. */
async function retargetEach(ctx: PoolContext): Promise<void> {
  const { codeHost, store } = ctx;
  const defaults = new Map<string, string>();
  const told = { unsupported: false };
  for (const entry of store.get().entries) {
    // Only a finished run is asked: the board shows its note on a finished run alone, and a run that is not finished is not written to here. Only a run
    // stacked on a blocker's branch has a base the board moves; any other pull request's base is the worker's own, and is left as it is.
    if (entry.phase !== "finished") continue;
    const stacked = new Set((entry.blockers ?? []).flatMap(({ branch }) => (branch ? [branch] : [])));
    const urls = openPulls(entry).map(({ url }) => url);
    if (urls.length === 0) continue;
    const previous = entry.retargets ?? {};
    // The sweep of the bases keeps the note of a pull request it cannot read, so it is handed only the notes it wrote: one the stack merge or the restack wrote is theirs to keep or clear.
    const baseNotesBefore = Object.fromEntries(Object.entries(previous).filter(([, note]) => !isStackMergeNote(note) && !isRestackNote(note)));
    const bases = stacked.size === 0 ? {} : codeHost.sweepRetargets({ urls, previous: baseNotesBefore, stacked, defaults, log });
    const facts = new Map<string, StackMergeFacts | null>();
    const restacks = await sweepRestacks(ctx, entry, { urls, bases, facts, told });
    const merges = sweepStackMerges(ctx, entry, urls, { skip: new Set([...Object.keys(bases), ...restacks.moved]), facts });
    const notes = noteOf(urls, { bases, restacks: restacks.notes, merges });
    const next = Object.keys(notes).length === 0 ? undefined : notes;
    if (JSON.stringify(next ?? {}) !== JSON.stringify(previous)) update(ctx, (queue) => recordRetargets(queue, entry.ticket.key, next));
    // The round starts after its note is recorded: the note is written over a finished run alone.
    if (restacks.feedback.length > 0) startStackConflictRound(ctx, entry.ticket.key, restacks.feedback.join("\n"));
  }
}

/** The one note each pull request shows, in the order of what it needs first: its base, a restack that conflicts or was refused, its stack merge, then that it was restacked. PURE. */
function noteOf(urls: readonly string[], { bases, restacks, merges }: { bases: Readonly<Record<string, string>>; restacks: Readonly<Record<string, string>>; merges: Readonly<Record<string, string>> }): Record<string, string> {
  const notes: Record<string, string> = { ...bases };
  for (const url of urls) {
    const restack = restacks[url];
    const note = bases[url] ?? (restack !== undefined && isRestackProblemNote(restack) ? restack : undefined) ?? merges[url] ?? restack;
    if (note !== undefined) notes[url] = note;
  }
  return notes;
}

/**
 * The stack merge of a finished run's open pull requests (A11-238): each one that is approved and green is read (`stackMergeFactsOf`) and goes through {@link stackMergeStep}, and when that asks, the arm bot is asked to merge it (`requestStackMerge`) and the ask is
 * remembered by head. The note a pull request needs is what GitHub refused it with, or that the arm bot could not be asked (and the ask is made again on the next sweep). A pull request with a note about its base has none here: its stack merge waits for the base. Nor has one the restack just moved or found conflicting (A11-248): its head is not the one the watch read ready. One that cannot be read keeps the note it had.
 * A pull request that is not ready is not read at all, and a head the watch read is not the head GitHub says now is not ready either. A code host that has neither operation (before contract 1.16) asks the arm bot for nothing.
 */
function sweepStackMerges(ctx: PoolContext, entry: Entry, urls: readonly string[], { skip, facts: read }: { skip: ReadonlySet<string>; facts: Map<string, StackMergeFacts | null> }): Record<string, string> {
  const { codeHost, now, stackMergeAsked } = ctx;
  const notes: Record<string, string> = {};
  if (codeHost.stackMergeFactsOf === undefined || codeHost.requestStackMerge === undefined) return notes;
  for (const url of urls) {
    if (skip.has(url) || !isPullReadyToMerge(entry, url)) continue;
    const facts = factsOf(ctx, url, read);
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

/** What the code host says of a pull request's stack, read once for the sweep of a run and kept for whoever asks next. A code host that cannot say reads as null. */
function factsOf(ctx: PoolContext, url: string, read: Map<string, StackMergeFacts | null>): StackMergeFacts | null {
  if (!read.has(url)) read.set(url, ctx.codeHost.stackMergeFactsOf?.(url) ?? null);
  return read.get(url) ?? null;
}

/** What {@link sweepRestacks} decided for a run: the note of each pull request, the pull requests whose branch it moved, found conflicting or has closed (or is to close), and the feedback of the conflict round to start. */
type RestackSweep = Readonly<{ notes: Record<string, string>; moved: ReadonlySet<string>; feedback: readonly string[] }>;

/** What the restack decided for one pull request: its note (null clears it), whether its branch moved or conflicts or the member is empty, and the feedback of the conflict round it earns. */
type MemberRestack = Readonly<{ note: string | null; moved: boolean; feedback: string | null }>;

/** The restack notes a run has now, for the pull requests it still holds open. */
const restackNotesOf = (entry: Entry, urls: readonly string[]): Record<string, string> =>
  Object.fromEntries(urls.flatMap((url) => (entry.retargets?.[url] !== undefined && isRestackNote(entry.retargets[url]) ? [[url, entry.retargets[url]]] : [])));

/** The notes that stay true whatever happens next: that a pull request was restacked. A note about a conflict or a refusal is only said while the sweep can see it. PURE. */
const restackedOnly = (notes: Readonly<Record<string, string>>): Record<string, string> => Object.fromEntries(Object.entries(notes).filter(([, note]) => isRestackedNote(note)));

/**
 * The open member of a stack above one that merged is brought up to date with the default branch (A11-248, `stack-restack.ts`). It applies to a finished run stacked on a blocker's branch, whose pull requests in the stack's repository are open, once for each
 * merged member below, and only when no workspace is open in the run and no merge of the blocker's branch is under way (the guards of {@link mergeable} and `rebasing`). The member below is read live (`readPullState`), so a merge is seen on the first sweep after it, before
 * the conflict watch can read the conflict. The merge is the code host's `updateBranch`: no rebase and no force-push. Where the run resumes on a conflict and has rounds left, the conflicts of one sweep share one conflict round, whose feedback names the stack and the member that merged.
 * What a pull request needs said is its note. One the sweep cannot decide for keeps the restack note it had; one it will never decide for (no stack, no blocker pull request, a code host that cannot) keeps only the note that it was restacked.
 */
async function sweepRestacks(ctx: PoolContext, entry: Entry, { urls, bases, facts, told }: { urls: readonly string[]; bases: Readonly<Record<string, string>>; facts: Map<string, StackMergeFacts | null>; told: { unsupported: boolean } }): Promise<RestackSweep> {
  const kept = restackNotesOf(entry, urls);
  const found = restackMembers(ctx, entry, bases);
  if (found === null || !canRestack(ctx, told)) return { notes: restackedOnly(kept), moved: new Set(), feedback: [] };
  if (!mergeable(entry) || ctx.rebasing.has(entry.ticket.key)) return { notes: kept, moved: new Set(), feedback: [] };
  const { stack, members, candidates } = found;
  const round = conflictRoundOf(entry);
  const notes = { ...kept };
  const moved = new Set<string>();
  const feedback: string[] = [];
  for (const { url } of members) {
    const decided = await restackMember(ctx, entry, { url, stack, candidates, facts, round });
    if (decided === null) continue;
    if (decided.note === null) delete notes[url];
    else notes[url] = decided.note;
    if (decided.moved) moved.add(url);
    if (decided.feedback !== null) feedback.push(decided.feedback);
  }
  return { notes, moved, feedback };
}

/** The stack a run is in, its open pull requests in the stack's repository that have no base note, and the blocker's pull requests there; null when the run has no stack, no member or no blocker pull request to look at, which is said once in the log. */
function restackMembers(ctx: PoolContext, entry: Entry, bases: Readonly<Record<string, string>>): { stack: StackBaseRecord; members: readonly { url: string }[]; candidates: readonly string[] } | null {
  const stack = entry.stackBase;
  if (stack === undefined) return null;
  const members = openPulls(entry).filter((pr) => pr.repo === stack.repo && bases[pr.url] === undefined);
  if (members.length === 0) return null;
  const blocker = ctx.store.get().entries.find((e) => e.ticket.key === stack.key);
  const candidates = blocker === undefined ? [] : pullsOf(blocker).filter((pr) => pr.repo === stack.repo).map((pr) => pr.url);
  if (candidates.length > 0) return { stack, members, candidates };
  const said = `${entry.ticket.key}:${stack.key}`;
  if (!ctx.restackSaid.has(said)) {
    log(`${entry.ticket.key}: ${blocker === undefined ? `its blocker ${stack.key} is not on the queue` : `its blocker ${stack.key} has no pull request in ${stack.repo}`}, so its pull request is left as it is when the member below merges`);
    ctx.restackSaid.add(said);
  }
  return null;
}

/** What a conflict found by the restack earns the run: a conflict round where it resumes on one and has rounds left, none at the cap, and none where the board does not resume it. PURE. */
function conflictRoundOf(entry: Entry): ConflictRound {
  if (resumesOnConflict(entry)) return roundsLeft(entry) ? "round" : "capped";
  return "none";
}

/** Whether the code host can update a branch and read a stack, which the restack needs. A host that cannot is said so once for the sweep. */
function canRestack(ctx: PoolContext, told: { unsupported: boolean }): boolean {
  const { codeHost } = ctx;
  if (codeHost.updateBranch !== undefined && codeHost.stackMergeFactsOf !== undefined) return true;
  if (!told.unsupported) log("the code host cannot update a branch or read a stack, so a stacked pull request is not brought up to date after the one below it merged");
  told.unsupported = true;
  return false;
}

/** One open member of a stack: merge the default branch into it when the member below has merged and it has not been done, and say what happened. Null: nothing is decided for it, so its note stands. */
async function restackMember(ctx: PoolContext, entry: Entry, { url, stack, candidates, facts, round }: {
  url: string; stack: StackBaseRecord; candidates: readonly string[]; facts: Map<string, StackMergeFacts | null>; round: ConflictRound;
}): Promise<MemberRestack | null> {
  const key = entry.ticket.key;
  const previous = entry.retargets?.[url];
  const done = ctx.restacked.get(url) ?? doneFromNote(previous, url);
  const below = await belowOf(ctx, stack.key, candidates, done);
  const read = below === null ? null : factsOf(ctx, url, facts);
  if (below === null || read === null) return null;
  const step = restackStep({ facts: read, below, done, previousNote: previous });
  if (!step.restack) {
    const closing = done === undefined ? null : await closeEmptyMember(ctx, entry, { url, below, done, read, previousNote: previous });
    const note = closing ?? step.note;
    // A member that is closed is not handed to the arm bot, on this sweep or the ones before the board lists it closed. One that is empty and could not be closed still is, as it was before.
    return { note, moved: note !== null && isClosedMemberNote(note), feedback: null };
  }
  const result = askUpdate(ctx, url, read.head);
  const outcome: RestackOutcome = result.kind === "conflict" ? { kind: "conflict", round } : result;
  const note = restackNote({ url, defaultBranch: read.defaultBranch, below, outcome });
  if (result.kind !== "refused") ctx.restacked.set(url, { merged: below.url, head: read.head, ...(result.kind === "up-to-date" ? { upToDate: true as const } : {}) });
  if (result.kind === "updated") followHead(ctx, key, url, read.head);
  log(`${key}: ${note}`);
  const feedback = result.kind === "conflict" && round === "round" ? restackFeedback({ url, defaultBranch: read.defaultBranch, below, key }) : null;
  return { note, moved: result.kind === "updated" || result.kind === "conflict", feedback };
}

/** The restack a pull request's note says was made: the note stands in for the memory a restart lost. A note about a conflict or a refusal does not, so the restack is made again and finds the conflict, or finds it resolved. */
function doneFromNote(note: string | undefined, url: string): { merged: string } | undefined {
  const merged = note === undefined || !(isRestackedNote(note) || isEmptyMemberNote(note)) ? null : restackedAfter(note, url);
  return merged === null ? undefined : { merged };
}

/** The first of `urls` the code host says is merged, read in turn and no further than that one. */
async function firstMerged(ctx: PoolContext, urls: readonly string[]): Promise<string | undefined> {
  for (const url of urls) if ((await ctx.codeHost.readPullState(url)) === "MERGED") return url;
  return undefined;
}

/** The member below that merged: the one the restack was made after, or else the first of the blocker's pull requests in the repository that the code host says is merged now, or null when none is. */
async function belowOf(ctx: PoolContext, blockerKey: string, candidates: readonly string[], done: Readonly<{ merged: string }> | undefined): Promise<RestackBelow | null> {
  const merged = done !== undefined && candidates.includes(done.merged) ? done.merged : await firstMerged(ctx, candidates);
  return merged === undefined ? null : { key: blockerKey, url: merged, state: "MERGED" };
}
