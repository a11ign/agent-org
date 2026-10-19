// @ts-check
// module: the tracker's view of the queue -- refreshing what it says, completing merged tickets, and retargeting stacked pull requests

import { readBlockers } from "./pool-start.ts";
import { completableRuns, recordPullStates, recordRetargets, recordTrackerStates, unsettledKeys } from "./queue/approve.ts";
import { log, messageOf, update } from "./pool-state.ts";
import { restoreStranded } from "./pool-settle.ts";
import { openPulls, pullsOf } from "./board-view/view-ticket.ts";
import { recordClosedByBoard } from "./queue.ts";
import { sweepRetargets } from "../ticket-port/stack-retarget.ts";
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
