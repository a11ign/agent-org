// @ts-check
// module: the next plan step of a ticket whose partial pull request merged (A11-168) -- PURE
//
// A ticket whose plan has numbered steps ships one pull request for each (`board-view/plan-steps.ts`). When a step's pull request merges, its finished run is replaced by a
// queued one for the next step on the same plan, which starts like any queued run. The pool's settle sweep (`pool-tracker.ts`) asks {@link nextStepRuns} and applies {@link queueNextStep}.
import { isParked, settledByPulls } from "../board-view/pull-status-and-notes.ts";
import { afterPartialMerge, type MergedStep } from "../board-view/plan-steps.ts";
import { pullsOf } from "../board-view/view-types-and-filters.ts";
import { replace, SETTLED, type Entry, type Queue } from "./queue-entries-and-outcomes.ts";

/**
 * The run for the next step of a plan, queued at `now` in place of `entry`, whose partial pull requests merged and finished `step` (A11-168): the same ticket, model, effort,
 * plan paths and repositories, and `steps` with `step` appended. It is a fresh worker: it has no session, no plan to wait for (the plan is attached), and none of the finished
 * run's outcome, pull requests, declaration or state move. Not `movedFrom`: the first step merged, so the ticket has started, and a later step that ends with no pull
 * request must not put it back in Todo. PURE.
 */
function nextStepRun(entry: Entry, step: MergedStep, now: number): Entry {
  const { ticket, repos, model, effort, planned, paths, plannedRepo, projectRepo, steps = [] } = entry;
  return { ticket, repos, model, effort, ...(planned ? { planned } : {}), ...(paths ? { paths } : {}), ...(plannedRepo !== undefined ? { plannedRepo } : {}),
    ...(projectRepo !== undefined ? { projectRepo } : {}), steps: [...steps, step], phase: "queued", queuedAt: now };
}

/**
 * The finished runs whose partial pull requests merged and whose next plan step the board queues itself (A11-168): declared partial, not parked, whose pull requests have all
 * merged or closed with one merged, whose ticket the tracker has not finished, and whose declaration names a step N of M with N below M and past every step already merged.
 * Each is paired with the step it finished. PURE.
 */
export function nextStepRuns(queue: Queue): { entry: Entry; step: MergedStep }[] {
  return queue.entries.flatMap((entry) => {
    const { partial } = entry;
    const finished = entry.phase === "finished" && !isParked(entry) && !SETTLED.has(entry.trackerState ?? "") && settledByPulls(entry) === "completed";
    if (!finished || partial === undefined) return [];
    const after = afterPartialMerge(partial, entry.steps ?? []);
    if ("stalled" in after) return [];
    const prs = pullsOf(entry).map(({ url }) => url).filter((url) => entry.pullStates?.[url] === "merged");
    return [{ entry, step: { step: after.next.step - 1, of: after.next.of, prs } }];
  });
}

/** Queue the next plan step of `key`'s run at `now`, in place of its finished run (A11-168): see {@link nextStepRun}. A run that is not finished is left as it is. */
export function queueNextStep(queue: Queue, key: string, step: MergedStep, now: number): Queue {
  return replace(queue, key, (entry) => (entry.phase === "finished" ? nextStepRun(entry, step, now) : entry));
}
