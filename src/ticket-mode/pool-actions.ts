// @ts-check
// module: a person's actions on a run -- stop, dismiss, remove, stop a new-ticket run, and apply or discard a proposed edit

import { clearEdit, dismiss as dismissFinished, isLive, proposedEdit, remove as removeQueued, replace, retry as retryQueued, type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { close, end, restoreWorkingState } from "./pool-settle.ts";
import { stopWriter, writerOf } from "./queue.ts";
import { filedOf } from "./pool-board-runs.ts";
import { forgetRun, messageOf, update, writerPlace } from "./pool-state.ts";
import { closeWorkspaceLater } from "./pool-close.ts";
import { isBeingPublished, isParked } from "./board-view/pull-status-and-notes.ts";
import { respond as respondQueued, unpark } from "./queue/queue-transitions.ts";
import { retryRefusal } from "./queue/queue-retry-refusal.ts";
import { cloneOnDemand, organisationRepoNamed } from "./pool-org-repos.ts";
import type { HostRepository } from "../plugins/contracts/code-host.ts";
import { type PoolContext } from "./pool-context.ts";
import { openPullsFound } from "./opened-pulls.ts";
import { openPulls } from "./board-view/view-types-and-filters.ts";

/** Stop a live run: close its workspace and keep its worktrees. */
export function stop(ctx: PoolContext, key: string): void {
  const { store } = ctx;
  const entry = store.get().entries.find((e) => e.ticket.key === key && isLive(e));
  if (entry !== undefined) end(ctx, entry, { kind: "stopped" });
}

/**
 * A person pressed Respond to review (A11-154): a round that answers the run's open pull requests, or the ones the code host holds for its ticket when its record holds none (A11-240), is queued, whatever its outcome ended on. A run whose workspace
 * is still open (parked) has it closed first, because a second workspace would take the same herdr name. Throws, naming why, when Respond cannot act, and
 * nothing is closed then: the refusal is asked of the queue as if the workspace were closed already. A workspace herdr will not close leaves the run parked.
 */
export function respond(ctx: PoolContext, key: string): void {
  const { now, store } = ctx;
  const entry = store.get().entries.find((e) => e.ticket.key === key);
  const parked = entry !== undefined && isParked(entry);
  // A finished run whose record holds no open pull request may still have one on the code host, which the crash that emptied the record did not close (A11-240).
  const found = entry?.phase === "finished" && openPulls(entry).length === 0 ? openPullsFound(ctx, entry) : [];
  respondQueued(parked ? unpark(store.get(), key) : store.get(), key, now(), found);
  if (parked) close(ctx, key);
  update(ctx, (queue) => respondQueued(queue, key, now(), found));
}

/**
 * A person pressed Retry (A11-355): the run is queued again with a fresh worker. A run that ended `wrong-repo` naming a repository of the organisation is queued in that repository, which is cloned first if this machine has none, so
 * Retry does what the board does by itself (`settleWrongRepo`); one naming anything else is queued as it was. A `wrong-repo` run holds its workspace (it is parked), which is closed first, because a second workspace would take the same
 * herdr name. Any other parked run still has an agent a person may answer, so it is not retried until Close has ended it. THROWS, naming why, when the run cannot be retried or its repository cannot be cloned, and nothing is closed
 * then: Retry used to answer as if it had worked and leave the run finished. A workspace herdr will not close leaves the run parked.
 */
export async function retryRun(ctx: PoolContext, key: string): Promise<void> {
  const { now, store } = ctx;
  const entry = store.get().entries.find((e) => e.ticket.key === key);
  if (entry === undefined) throw new Error(`${key} is not on the board`);
  const parked = isParked(entry);
  const answerable = parked && entry.outcome?.kind !== "wrong-repo";
  const refusal = retryRefusal(answerable ? entry : { ...entry, workspace: undefined });
  if (refusal !== null) throw new Error(`${refusal}, so it was not retried`);
  const named = entry.outcome?.kind === "wrong-repo" ? organisationRepoNamed(ctx, entry.outcome.where) : null;
  const repo = named === null ? null : await cloneForRetry(ctx, named, key);
  const current = store.get().entries.find((e) => e.ticket.key === key);
  if (current === undefined) throw new Error(`${key} left the board while its repository was cloned, so it was not retried`);
  // Retried by someone else while the clone ran (a second press of the button): it is queued, which is what was asked.
  if (current.phase !== "finished") return;
  if (JSON.stringify(current.outcome) !== JSON.stringify(entry.outcome)) throw new Error(`${key} ended differently while its repository was cloned, so it was not retried`);
  if (parked) close(ctx, key);
  update(ctx, (queue) => (repo === null ? retryQueued(queue, key, now()) : placedIn(retryQueued(queue, key, now()), key, repo)));
}

/** The key of the clone of `repository`, cloned first when there is none. THROWS, naming the run that was not retried, when it cannot be cloned. */
async function cloneForRetry(ctx: PoolContext, repository: HostRepository, key: string): Promise<string> {
  try {
    return await cloneOnDemand(ctx, repository);
  } catch (err) {
    throw new Error(`${repository.fullName} is in the organisation but could not be cloned (${messageOf(err).split("\n")[0]}), so ${key} was not retried`);
  }
}

/** `queue` with ticket `key`'s run, once it is queued again, planned for `repo`: after the retry, which builds the entry afresh and so would drop it. PURE. */
const placedIn = (queue: Queue, key: string, repo: string): Queue => replace(queue, key, (entry) => (entry.phase === "queued" ? { ...entry, plannedRepo: repo } : entry));

/**
 * The person stopped a new-ticket run: its workspace is closed, and the tickets it has made stay. A run that has ended is left as it is. A run making its
 * tickets has no workspace left to close, since its agent ended when its outcome was read.
 */
export function stopWriterRun(ctx: PoolContext, id: string): void {
  const { now, store } = ctx;
  const run = writerOf(store.get(), id);
  if (run === undefined || run.phase === "finished") return;
  const { name } = writerPlace(ctx, run);
  if (run.workspace) closeWorkspaceLater(ctx, run.workspace);
  forgetRun(ctx, name);
  const filed = filedOf(ctx, run);
  update(ctx, (queue) => stopWriter(queue, id, now(), { tickets: filed.tickets, problem: filed.problem }));
}

/**
 * Write a run's proposed edit to its ticket's title and description, on a person's request (A11-91). The ticket is read first: when its text is no
 * longer the text the proposal was made against, nothing is written and the proposal stays. The proposal is dropped once the tracker has the edit.
 * Throws, with the reason, when it cannot be applied.
 */
export async function applyEdit(ctx: PoolContext, key: string): Promise<void> {
  const { source, store } = ctx;
  const entry = store.get().entries.find((e) => e.ticket.key === key);
  const edit = entry === undefined ? undefined : proposedEdit(entry);
  if (edit === undefined) throw new Error(`${key} has no proposed edit to apply`);
  if (source.updateTicketText === undefined) throw new Error(`this tracker cannot edit ${key}'s text`);
  const fresh = await source.read(key);
  if (fresh === null) throw new Error(`Linear has no ticket ${key}`);
  if (edit.base === undefined || fresh.title !== edit.base.title || fresh.description !== edit.base.description) {
    throw new Error(`the ticket changed since the worker proposed this: ${key} is not written, and the proposal stays`);
  }
  await source.updateTicketText(key, { ...(edit.title === undefined ? {} : { title: edit.title }), ...(edit.description === undefined ? {} : { description: edit.description }) });
  update(ctx, (queue) => clearEdit(queue, key));
}

/** Drop a run's proposed edit to its ticket's text, unapplied (A11-91). The ticket is left as it is. Throws when the run proposes none. */
export function discardEdit(ctx: PoolContext, key: string): void {
  const { store } = ctx;
  const entry = store.get().entries.find((e) => e.ticket.key === key);
  if (entry === undefined || proposedEdit(entry) === undefined) throw new Error(`${key} has no proposed edit to discard`);
  update(ctx, (queue) => clearEdit(queue, key));
}

/**
 * Dismiss a finished run: put its ticket back where the board found it, close its workspace if it is still open (parked), then take it off the
 * board. The ticket, its branch, its worktrees and its pull requests are left as they are. Throws, naming why, for a run that is queued or live,
 * or that the publish run under way is posting, with herdr's reason when the workspace cannot be closed, and with the tracker's reason when the
 * ticket cannot be put back. The run stays on the board in either case, for another try.
 */
export async function dismiss(ctx: PoolContext, key: string): Promise<void> {
  const { store } = ctx;
  const queue = store.get();
  const entry = queue.entries.find((e) => e.ticket.key === key);
  if (entry === undefined) return;
  if (entry.phase === "queued") throw new Error(`${key} is queued, not finished: Remove takes it off the queue`);
  if (entry.phase !== "finished") throw new Error(`${key} is still running: Stop it first, then dismiss it`);
  if (isBeingPublished(entry, queue.publish)) throw new Error(`${key}'s pull requests are being published: dismiss it once the publish run has ended`);
  // A batch's parked tickets share one workspace: closing it unparks them all, and only this one leaves the board.
  // The ticket goes back first: a refused restore then leaves the run exactly as it was, parked and answerable. A refused close after it leaves the
  // ticket where it was put, and the run on the board, for Dismiss to try again.
  await restoreWorkingState(ctx, key);
  if (isParked(entry)) close(ctx, key);
  update(ctx, (next) => dismissFinished(next, key, ctx.now()));
}

/**
 * Take a queued run off the queue. A queued run that carries the record of a move puts its ticket back first, so Remove never leaves a ticket In
 * Progress with no run on the board. No tick starts that run while its ticket is put back, so the run Remove takes off is the one that was
 * queued. Throws, with the tracker's reason, when the ticket cannot be put back, and the run stays queued for another try.
 */
export async function remove(ctx: PoolContext, key: string): Promise<void> {
  const { removing, store } = ctx;
  if (store.get().entries.some((e) => e.ticket.key === key && e.phase === "queued" && e.movedFrom !== undefined)) {
    removing.add(key);
    try { await restoreWorkingState(ctx, key); }
    finally { removing.delete(key); }
  }
  update(ctx, (queue) => removeQueued(queue, key, ctx.now()));
}
