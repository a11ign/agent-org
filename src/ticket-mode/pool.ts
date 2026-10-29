// @ts-check
// module: the worker pool -- starts queued tickets while there is room, watches each worker in herdr, and records how each run ended
//
// ONE WORKER PER TICKET, IN ITS OWN HERDR SESSION. Each run opens a workspace labelled with the ticket's key in ticket mode's session (never the
// org's), starts Claude in the ticket's first worktree, and points it at its brief. The herdr calls are the org's own (`herdr-agents.ts`).
//
// A RUN HAS ENDED WHEN ITS OUTCOME FILE EXISTS AND ITS AGENT IS IDLE OR DONE. `idle` alone proves nothing: an agent reads `idle` before it has taken
// its first prompt, and a `done` agent turns `idle` once someone looks at its pane (`wake.ts` measured both). So:
//   - outcome file, and idle or done: finished, with the worker's outcome;
//   - no outcome file, and done, or idle after it was seen working: finished, `no-outcome`;
//   - its workspace missing from two complete listings in a row, or `unknown` twice: `crashed`;
//   - any other status (a dialog, a prompt waiting on a person) is shown on the board as waiting, with the first line of the dialog when its pane can be read, and the run continues;
//     except a Claude Code safety prompt (A11-174, `pool-decline.ts`): it is answered No with Esc, up to three times a run, and the agent is told in one message which command was refused and
//     why; the board says "A safety prompt was declined automatically" and the run is not waiting on a person. A talk session is never declined: a person is at its terminal.
//
// A TICKET WITH NO PLAN CAN BE PLANNED FIRST. Its first run is a planning run, on the planning model and effort, told to plan and change no code,
// and refused anything that would (`PLANNING_DENY`). When it writes `planned`, the board attaches the files it left in the ticket's `plan` folder
// and queues the ticket again to be worked, where it was. A plan the tracker will not take ends the run for a person, with its files kept.
//
// A RUN THAT HANDS ITS TICKET BACK IS PARKED, NOT CLOSED. On `needs-human`, `wrong-repo` or `no-outcome` its workspace stays open and holds no
// slot, so the person can answer the agent in its terminal. An agent seen working again has been answered: its outcome is marked stale, so
// the stop hook asks for a new one, and the run is live again. Close ends a parked run's workspace; a workspace closed by hand is noticed.
//
// A RUN THAT CONCLUDED IS CLOSED AT ONCE. On `checked` (the worker looked and found nothing to change), `done` (every Done-when verified, and the
// board completed the ticket) or `planned`, nobody will answer the agent, so its workspace is closed as the outcome is recorded rather than left open
// with a finished agent in it. `checked` is not Needs you.
//
// A `done` RUN COMPLETES ITS TICKET, AND ONLY THE BOARD DOES (A11-91). A worker with no code to change verifies each Done-when item and writes `done`
// with its evidence. The board moves the ticket to the tracker's completed state and posts the reason and the evidence on it, through the tracker's own
// `complete`. A refusal (a planning or review run, a parent with open sub-issues, a tracker that cannot complete it) hands the run to a person instead.
// A worker's proposed edit to its ticket's text (`edit`) is stored on its outcome with the text the tracker held, and written only when a person
// applies it (`applyEdit`), and only while the ticket still holds that text.
//
// DISMISS TAKES A FINISHED RUN OFF THE BOARD. Without it a finished run stayed for ever. It closes the run's workspace when it is still open
// (parked), then drops the queue's record: the ticket, its branch and its pull requests are never touched. A queued or live run is refused.
//
// TICKETS QUEUED TOGETHER ARE PLANNED BY ONE RUN. Where the planner's instruction names `{keys}`, the tickets one press of Queue plans first
// form a batch (`enqueue`), and one planning run plans it, in a folder of its own (`batchDir`). Every ticket of the batch shows that run's
// workspace and pane, and the batch holds one slot. Only the run's agent is watched, and how it ends is how each of them ends, except
// `planned`: then each ticket's own folder of the plan folder decides, its plan attached or its question handed to a person, and the batch's
// `order.json` is recorded in the tracker as "blocks" relations before any of them can start (`attachBatch`).
//
// A REVIEW RUN RESUMES THE WORKER THAT WROTE THE CODE. A person who approves a run's pull requests queues the ticket again as a review run
// (`approve`). It starts in the same ticket folder with `claude --resume` on the session the first run ended in, so it keeps that worker's
// context, and a brief that has it mark the pull requests ready, answer what is on them and end at the push (A11-306). A run whose session was not
// recorded resumes the newest transcript Claude Code kept for that folder, and a fresh worker starts only when there is none.
//
// A PARKED RUN THAT WRITES A NEW OUTCOME HAS ENDED AGAIN. A worker woken in its parked workspace, by a person or by a task of its own, can work
// for seconds between two looks and write its outcome without the pool ever seeing it `working`. So an outcome file written after the run
// parked, other than the one it parked on, settles the run as if it had been resumed and had finished.
//
// A RUN WHOSE OWN BACKGROUND WORK IS STILL RUNNING IS NOT OVER (A11-80). A worker that ends a turn while a shell, a Monitor or a task of its own
// runs on (a long Ansible run, say) must still write an outcome file for the stop hook, and `needs-human` was the only one that fitted: the
// board showed Needs you though nothing was asked of the person, and parked a run that carried on by itself. It writes `working` instead. The
// pool records its reason as the run's latest note and leaves the run running, holding its slot and watched as before: the outcome it writes
// when its work wakes it replaces the note and ends the run as usual. An agent that sits idle with no newer outcome for `tickets.stallMinutes`
// is marked stalled on the board, so a run whose work never woke it is still noticed; nothing is ended and no key is sent; the one prompt says the background work is gone (A11-85).
//
// A `working` RUN WITH NOTHING TO WAKE IT IS STALLED IN MINUTES, NOT THIRTY (A11-85). The board reads the run's pane for the background work its status
// line counts (`· 1 shell, 1 monitor`). An idle run whose pane shows none for `BACKGROUND_GONE_MS` is marked stalled, and told once, with
// `BACKGROUND_GONE_PROMPT`, to check its background work and carry on. A pane that cannot be read leaves the thirty-minute rule to decide alone.
//
// A RUN WAITING ON ITS OWN BACKGROUND WORK IS NOT STALLED WHILE IT WAITS (A11-236). A pane that shows a live shell or Monitor, or a `working` note that names a
// `waitingOn` job, makes the run `waiting`: the board says "Waiting on background work", and the thirty-minute rule does not apply until `deadlineOf`, the note's
// `until` or `BACKGROUND_WAIT_MS` after the outcome file. Past it the worker is prompted once, and with no newer outcome `tickets.stallMinutes` later the run is stalled, and the reason names the job (A11-245).
//
// A RUN READY TO MERGE IS WATCHED. Every few minutes (`watchFeedback`) the board reads the open pull requests of each finished run (`readPullFeedback`,
// through `gh`). A review, a conversation comment or an inline comment newer than the run's last round, from anyone but the account the workers
// use, or a check failing on the head commit since then, queues another review round that resumes the same worker to answer it (`feedbackRound`),
// up to three before a person must approve again. So does a pull request that conflicts with its base branch: a conflict is a state, not an event,
// so it is feedback on every watch until a round clears it. The watch is for runs that ended `reviewed` (Ready to merge, or Awaiting review until their pull requests are approved at their head and
// green there: a run is not ready because its round ended, A11-179) or Published, and for a parked run with a conflict (below); a draft's read is kept for its footprint. A red check that fails on the
// default branch too, or on another run's pull request that touches none of the run's paths, is named on the card and starts no round (`pool-foreign-checks.ts`).
// EVERY OPEN PULL REQUEST OF A TICKET IS WATCHED IN ANY PHASE (A11-286). The watch above reads a finished run's pull requests; the ones of a ticket queued for its next step, queued again, running or planned are found from its run log (`kept-pulls.ts`) and read
// on the same cadence (`watchKeptPulls`, `pool-base-merge.ts`). A pull request that conflicts or is behind has its base merged into it by the code host first (`mergeBaseInto`): the armed auto-merge carries on from the new head, and no worker is asked. Only a
// conflict the merge reports as real starts a conflict round, naming the files, the base and the merge command, ahead of the step the ticket was queued for, which waits in `afterRound` until the round has pushed. A run that holds a workspace is not pushed to.
// A PARKED RUN WITH A CONFLICT IS RESUMED TOO (A11-89). A run that parked on a question, or ended with no outcome, still has its pull requests read, and
// a conflict alone resumes it: its workspace is closed and a round queued (`conflictRound`), within the same three. Nothing else wakes a parked run.
//
// A RUN WAITS FOR A PATH ANOTHER RUN HOLDS. Ticket mode starts queued runs side by side, so two that touch one file would conflict. A run's footprint
// is the paths its plan declares (`## Paths`, read from the plan files, `overlap.ts`) and the files its open pull requests change. A run held in its
// repository (live, or finished with a pull request open) holds that footprint, and a queued run that shares a path with one waits, shown as Blocked
// with its reason, until the holder's pull request merges or closes. Runs of one pass see each other: the first one chosen holds for the rest.
//
// A PERSON'S PUBLISH STARTS ONE PUBLISH RUN. It posts the pull requests of every run ticked, all in one go, with the host file's
// `tickets.publish`, in a folder of its own (`publishDir`), holding one slot. Only it may run the publisher plugin's skill and the connectors
// `tickets.publish.connectors` names (`hook.ts`). When it writes `published`, each run it posted shows Published with a link to the message.
//
// A RESTART OF THE INSTANCE LEAVES THE WORKERS ALONE (A11-78, A11-169). The workers run in herdr's server, which runs in a service of its own (`agent-org-herdr.service`; this process only starts the unit,
// `ensureSession`), so stopping or restarting the instance stops only the instance. A pool that starts up re-adopts what herdr lists and the
// queue file holds (`reconcile`) and carries on watching it: it sends a running worker no key and no second start of its own accord. The only keys
// the pool ever sends answer a start dialog, and only on a run this pool started itself, until its agent is first seen up (`startedHere`): a
// pane it adopted is never one it is starting. The other things it sends are its answer to a Claude Code safety prompt (A11-174): Esc, and one message saying why, and the one resume prompt
// (A11-279) to a run its first pass finds idle at a prompt, or interrupted, with no outcome written (`pool-resume.ts`). Both are safe on an adopted run, and a run that is working is sent nothing. A reviewer is recorded as started before it is started, so a restart in between never starts it
// twice, and one herdr still lists for its head is adopted. `agent-org update` restarts the instance over a live run whatever it is doing, and a breaking release
// drains instead (`pool-drain.ts`, `update.ts`, A11-169).
//
// A REVIEWER IS CLOSED AFTER ITS VERDICT, AND RETIRED WITH ITS PULL REQUEST (A11-81). The port closes the reviewer for a head once the verdict on that head
// is posted, and only once it is not working: its checkout stays, since a head that moves re-points it. `releaseReviewers`, on the server's own sweep, retires
// each reviewer whose pull request has merged or closed: its workspaces, then its review checkout (uncommitted changes reported first), then what the pool
// remembers of it. A pull request whose state cannot be read is asked again, and nothing is forgotten until its checkout is gone.

import { ensureSession, talkTo } from "./pool-start.ts";
import { applyEdit, discardEdit, dismiss, remove, respond, retryRun, stop, stopWriterRun } from "./pool-actions.ts";
import { cloneMissing } from "./pool-org-repos.ts";
import { closesSettledWithin } from "./pool-close.ts";
import { answer, type Answer } from "./pool-answer.ts";
import { close } from "./pool-settle.ts";
import { tick, watchFeedback } from "./pool-watch.ts";
import { watchKeptPulls } from "./pool-base-merge.ts";
import { reconcile } from "./pool-readopt.ts";
import { rebaseStacked, refreshTracker, retargetStacked } from "./pool-tracker.ts";
import { hostAlertsSettled } from "./host-alerts.ts";
import { noteStopping, poolFigures } from "./pool-figures.ts";
import { startReadsSettled } from "./pool-start-reads.ts";
import { claimWarningOf, pullReviewsOf, releaseReviewers, reviewNewHeads, startGreenReviewers } from "./pool-reviewers.ts";
import { newPoolContext, type PoolContext, type PoolDeps, type QueueStore } from "./pool-context.ts";
import { log, messageOf } from "./pool-state.ts";

export { MAX_REPOST_ATTEMPTS } from "./pool-reviewers.ts";
export { AnswerNotDelivered, type Answered } from "./pool-answer.ts";
export { herdrName, herdrServerCommand, type Herdr, type HerdrAsync } from "./pool-herdr.ts";
export { batchDir, batchFolder, publishDir, publishFolder, worktreesIn } from "./pool-paths.ts";
export { isStartDialog } from "./pool-start.ts";
export { countTokens, findFolderSession, findTranscript } from "./pool-transcripts.ts";
export { conflictLines, doneComment, feedbackSince, parseOutcome, publishResult } from "./pool-outcome.ts";
export { readEdit } from "./outcome.ts";
export { startsReviewers, type PoolDeps, type QueueStore } from "./pool-context.ts";
export { ticketDir, ticketFolder } from "./ticket-paths.ts";

/**
 * The watch of a finished run's pull requests, after the restack of the stacked ones (A11-248), and then of the pull requests of every other run (A11-286, {@link watchKeptPulls}): the first is done when this returns, and the second runs on
 * (`keptSweep.done` settles once the pull requests it found conflicting have had their files listed and the conflict round that is due is queued and started). The member above one that merged conflicts with `main` the moment GitHub recomputes it, and the watch
 * would start a plain conflict round that names neither the stack nor the merged member, a round the restack then leaves alone. So the restack goes first: a restack that conflicts starts its own round,
 * which takes the run out of `finished`, and the watch leaves it alone. The restack is idempotent per merged member (its pull requests are read again, and nothing is restacked or asked twice), so it still runs on its own timer too. A restack that throws is said, and the watch runs.
 */
async function restackThenWatch(ctx: PoolContext): Promise<void> {
  try {
    await retargetStacked(ctx);
  } catch (err) {
    log(`the stacked pull requests could not be restacked before the feedback watch: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
  }
  await watchFeedback(ctx);
  ctx.keptSweep.done = watchKeptPulls(ctx).then((queued) => { if (queued) void tick(ctx); });
}

/**
 * A pass asked for now, beside the caller (A11-364): the run that just became queued is decided on at once. It is held with the reads, so {@link startReadsSettled} waits for it too. A pass that is under way is asked to run once
 * more after it, as any tick asked for during one is. Never rejects.
 */
function wakePass(ctx: PoolContext): void {
  const { pending } = ctx.startReads;
  const pass: Promise<void> = tick(ctx).catch((err) => log(`the pass after a run was queued failed: ${messageOf(err).split("\n")[0]}`)).finally(() => { pending.delete(pass); });
  pending.add(pass);
}

export function createPool(store: QueueStore, deps: PoolDeps) {
  const ctx = newPoolContext(store, deps);
  // Deferred one turn: the work that asks has its own bookkeeping to finish first.
  ctx.wake.run = () => queueMicrotask(() => wakePass(ctx));
  return {
    tick: () => tick(ctx),
    stop: (key: string) => stop(ctx, key),
    close: (key: string) => close(ctx, key),
    dismiss: (key: string) => dismiss(ctx, key),
    talk: (key: string) => talkTo(ctx, key),
    respond: (key: string) => respond(ctx, key),
    /** A person's Retry (A11-355): queues a finished run again, in the repository its `wrong-repo` named when that is the organisation's. Rejects, naming why, for a run that cannot be retried. */
    retry: (key: string) => retryRun(ctx, key),
    /** Clones every live repository of the organisation this machine has no clone of (A11-355); resolves with how many. Never rejects. */
    cloneMissing: () => cloneMissing(ctx),
    /** A person's answer to the run waiting on them: written into the ticket's Decisions, then sent to the run (A11-250). */
    answer: (key: string, given: Answer) => answer(ctx, key, given),
    remove: (key: string) => remove(ctx, key),
    reconcile: () => reconcile(ctx),
    ensureSession: () => ensureSession(ctx),
    refreshTracker: () => refreshTracker(ctx),
    watchFeedback: () => restackThenWatch(ctx),
    /** Settles once the sweep of the pull requests no finished run's watch reads (A11-286) that `watchFeedback` last started has been looked at and the conflict round it found is queued and started. Never rejects. */
    keptWatchDone: () => ctx.keptSweep.done,
    releaseReviewers: () => releaseReviewers(ctx),
    reviewNewHeads: () => reviewNewHeads(ctx),
    /** The first review of each green head, on its own minute (A11-306). */
    startGreenReviewers: () => startGreenReviewers(ctx),
    /** The review state of each open pull request the pool has read, by url, as the board words it (A11-119). */
    pullReviews: () => pullReviewsOf(ctx),
    /** The one line for pull requests whose review claim could not be written, or null (A11-172). */
    claimWarning: () => claimWarningOf(ctx),
    reviewerState: () => ctx.reviewerState,
    retargetStacked: () => retargetStacked(ctx),
    rebaseStacked: () => rebaseStacked(ctx),
    applyEdit: (key: string) => applyEdit(ctx, key),
    discardEdit: (key: string) => discardEdit(ctx, key),
    stopWriterRun: (id: string) => stopWriterRun(ctx, id),
    /** What is wrong with the host itself (A11-279): `/tmp` over its limit, a soft lockup this boot, a serve the board could not put back, the hang settings drifting. Empty while nothing is. */
    hostAlerts: () => ctx.hostAlerts.alerts,
    /** Settles once the host read the last tick started has answered (A11-279). Never rejects. */
    hostAlertsSettled: () => hostAlertsSettled(ctx),
    /** Settles once the reads a start is decided on (blockers, heads, plans) that the last passes began have ended, and the pass each woke has run (A11-364). Never rejects. */
    startReadsSettled: () => startReadsSettled(ctx),
    /** Why runs are held: the `tickets.preflight` command that failed and what it said, or null while none has. */
    held: () => ctx.gate.held(),
    /** The runs and `fill()` passes as `/api/health` serves them (A11-363): the latest start, the startable entries, the free slots, and when a pass last completed. */
    figures: () => poolFigures(ctx),
    /** The instance is stopping (A11-363): no run starts from now on, so the runs still starting are the last. */
    endStarts: () => noteStopping(ctx),
    settleCloses: (limitMs: number) => closesSettledWithin(ctx, limitMs),
  };
}

export type Pool = ReturnType<typeof createPool>;
