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
//   - any other status (a dialog, a prompt waiting on a person) is shown on the board as waiting, and the run continues.
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
// context, and a brief that has it mark the pull requests ready and see them through their checks and review. A run whose session was not
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
// A RUN READY TO MERGE IS WATCHED. Every few minutes (`watchFeedback`) the board reads the open pull requests of each finished run (`readPullFeedback`,
// through `gh`). A review, a conversation comment or an inline comment newer than the run's last round, from anyone but the account the workers
// use, or a check failing on the head commit since then, queues another review round that resumes the same worker to answer it (`feedbackRound`),
// up to three before a person must approve again. So does a pull request that conflicts with its base branch: a conflict is a state, not an event,
// so it is feedback on every watch until a round clears it. The watch is for runs Ready to merge or Published, and for a parked run with a conflict (below);
// a draft's read is kept for its footprint.
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
// queue file holds (`reconcile`) and carries on watching it: it sends a running worker no key, no prompt and no second start. The only keys
// the pool ever sends answer a start dialog, and only on a run this pool started itself, until its agent is first seen up (`startedHere`): a
// pane it adopted is never one it is starting. A reviewer is recorded as started before it is started, so a restart in between never starts it
// twice, and one herdr still lists for its head is adopted. `agent-org update` restarts the instance over a live run whatever it is doing, and a breaking release
// drains instead (`pool-drain.ts`, `update.ts`, A11-169).
//
// A REVIEWER IS CLOSED AFTER ITS VERDICT, AND RETIRED WITH ITS PULL REQUEST (A11-81). The port closes the reviewer for a head once the verdict on that head
// is posted, and only once it is not working: its checkout stays, since a head that moves re-points it. `releaseReviewers`, on the server's own sweep, retires
// each reviewer whose pull request has merged or closed: its workspaces, then its review checkout (uncommitted changes reported first), then what the pool
// remembers of it. A pull request whose state cannot be read is asked again, and nothing is forgotten until its checkout is gone.

import { ensureSession, talkTo } from "./pool-start.ts";
import { applyEdit, discardEdit, dismiss, remove, respond, stop, stopWriterRun } from "./pool-actions.ts";
import { close } from "./pool-settle.ts";
import { reconcile, tick, watchFeedback } from "./pool-watch.ts";
import { rebaseStacked, refreshTracker, retargetStacked } from "./pool-tracker.ts";
import { pullReviewsOf, releaseReviewers, reviewNewHeads } from "./pool-reviewers.ts";
import { newPoolContext, type PoolDeps, type QueueStore } from "./pool-context.ts";

export { MAX_REPOST_ATTEMPTS } from "./pool-reviewers.ts";
export { herdrName, herdrServerCommand, type Herdr, type HerdrAsync } from "./pool-herdr.ts";
export { batchDir, batchFolder, publishDir, publishFolder, worktreesIn } from "./pool-paths.ts";
export { isStartDialog } from "./pool-start.ts";
export { countTokens, findFolderSession, findTranscript } from "./pool-transcripts.ts";
export { conflictLines, doneComment, feedbackSince, parseOutcome, publishResult } from "./pool-outcome.ts";
export { readEdit } from "./outcome.ts";
export { startsReviewers, type PoolDeps, type QueueStore } from "./pool-context.ts";
export { ticketDir, ticketFolder } from "./ticket-paths.ts";

export function createPool(store: QueueStore, deps: PoolDeps) {
  const ctx = newPoolContext(store, deps);
  return {
    tick: () => tick(ctx),
    stop: (key: string) => stop(ctx, key),
    close: (key: string) => close(ctx, key),
    dismiss: (key: string) => dismiss(ctx, key),
    talk: (key: string) => talkTo(ctx, key),
    respond: (key: string) => respond(ctx, key),
    remove: (key: string) => remove(ctx, key),
    reconcile: () => reconcile(ctx),
    ensureSession: () => ensureSession(ctx),
    refreshTracker: () => refreshTracker(ctx),
    watchFeedback: () => watchFeedback(ctx),
    releaseReviewers: () => releaseReviewers(ctx),
    reviewNewHeads: () => reviewNewHeads(ctx),
    /** The review state of each open pull request the pool has read, by url, as the board words it (A11-119). */
    pullReviews: () => pullReviewsOf(ctx),
    reviewerState: () => ctx.reviewerState,
    retargetStacked: () => retargetStacked(ctx),
    rebaseStacked: () => rebaseStacked(ctx),
    applyEdit: (key: string) => applyEdit(ctx, key),
    discardEdit: (key: string) => discardEdit(ctx, key),
    stopWriterRun: (id: string) => stopWriterRun(ctx, id),
    /** Why runs are held: the `tickets.preflight` command that failed and what it said, or null while none has. */
    held: () => ctx.gate.held(),
  };
}

export type Pool = ReturnType<typeof createPool>;
