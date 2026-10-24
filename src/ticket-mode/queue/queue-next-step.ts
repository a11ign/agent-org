// @ts-check
// module: the next plan step of a ticket whose partial pull request merged (A11-168) -- PURE
//
// A ticket whose plan has numbered steps ships one pull request for each (`board-view/plan-steps.ts`). When a step's pull request merges, its finished run is replaced by a
// queued one for the next step on the same plan, which starts like any queued run. The pool's settle sweep (`pool-tracker.ts`) asks {@link nextStepRuns} and applies {@link queueNextStep}.
//
// A TICKET THE TRACKER'S OWN INTEGRATION COMPLETED ON THAT MERGE (A11-178) is put back first, so the step is queued: {@link earlyCompletions} are the runs to ask the tracker about, and {@link earlyCompletionComment} is what the board posts when it puts one back.
import { isParked } from "../board-view/pull-status-and-notes.ts";
import { completedEarly, settledByPulls } from "../board-view/pull-settled.ts";
import { afterPartialMerge, stepNamed, type MergedStep, type PlanStep } from "../board-view/plan-steps.ts";
import { pullLabel } from "../board-view/pull-label.ts";
import { pullsOf } from "../board-view/view-types-and-filters.ts";
import { replace, SETTLED, type Entry, type Queue } from "./queue-entries-and-outcomes.ts";

/**
 * The run for the next step of a plan, queued at `now` in place of `entry`, whose partial pull requests merged and finished `step` (A11-168): the same ticket, model, effort,
 * plan paths (and the paths of each of its steps) and repositories, and `steps` with `step` appended. It is a fresh worker: it has no session, no plan to wait for (the plan is attached), and none of the finished
 * run's outcome, pull requests, declaration or state move. Not `movedFrom`: the first step merged, so the ticket has started, and a later step that ends with no pull
 * request must not put it back in Todo. PURE.
 */
function nextStepRun(entry: Entry, step: MergedStep, now: number): Entry {
  const { ticket, repos, model, effort, planned, paths, stepPaths, plannedRepo, projectRepo, planSteps, steps = [] } = entry;
  return { ticket, repos, model, effort, ...(planned ? { planned } : {}), ...(paths ? { paths } : {}), ...(stepPaths ? { stepPaths } : {}), ...(plannedRepo !== undefined ? { plannedRepo } : {}),
    ...(projectRepo !== undefined ? { projectRepo } : {}), ...(planSteps !== undefined ? { planSteps } : {}), steps: [...steps, step], phase: "queued", queuedAt: now };
}

/**
 * The finished runs whose partial pull requests merged and whose next plan step the board queues itself (A11-168): declared partial, with the merged bodies read (A11-181), not parked, whose pull requests have all
 * merged or closed with one merged, whose ticket the tracker has not finished, and whose step, named or counted by the board (A11-173), is below the plan's last and past every step
 * already merged. Each is paired with the step it finished. PURE.
 */
export function nextStepRuns(queue: Queue): { entry: Entry; step: MergedStep }[] {
  return queue.entries.flatMap((entry) => {
    const { partial } = entry;
    const finished = entry.phase === "finished" && !isParked(entry) && !SETTLED.has(entry.trackerState ?? "") && settledByPulls(entry) === "completed";
    if (!finished || partial === undefined || entry.declared === undefined) return [];
    const after = afterPartialMerge(partial, entry.steps ?? [], entry.planSteps);
    if ("stalled" in after) return [];
    const prs = pullsOf(entry).map(({ url }) => url).filter((url) => entry.pullStates?.[url] === "merged");
    return [{ entry, step: { step: after.next.step - 1, of: after.next.of, prs, ...(after.next.counted ? { counted: true as const } : {}) } }];
  });
}

/**
 * The finished runs whose plan's step count the board has to read (A11-173): declared partial (the merged bodies read, A11-181), not parked, whose pull requests merged and whose ticket the tracker has not
 * finished, whose declaration gives no `of <M>`, with no `of` in the record of steps already merged, and no count recorded yet. PURE.
 */
export const planStepsUnread = (queue: Queue): Entry[] => queue.entries.filter((entry) => entry.phase === "finished" && !isParked(entry) && !SETTLED.has(entry.trackerState ?? "")
  && entry.partial !== undefined && entry.declared !== undefined && entry.planSteps === undefined && (entry.steps ?? []).length === 0 && stepNamed(entry.partial) === null && settledByPulls(entry) === "completed");

/** Record how many numbered steps `key`'s plan has, on its finished run; 0 is recorded too, so a plan with none is not read again. */
export const recordPlanSteps = (queue: Queue, key: string, planSteps: number): Queue => replace(queue, key, (entry) => (entry.phase === "finished" ? { ...entry, planSteps } : entry));

/** Queue the next plan step of `key`'s run at `now`, in place of its finished run (A11-168): see {@link nextStepRun}. A run that is not finished is left as it is. */
export function queueNextStep(queue: Queue, key: string, step: MergedStep, now: number): Queue {
  return replace(queue, key, (entry) => (entry.phase === "finished" ? nextStepRun(entry, step, now) : entry));
}

/** Drop the declaration of what remains of `key`'s ticket (A11-173): a worker's `done` says nothing remains to build, and a round that ends as `reviewed` instead keeps it unless this is called. */
export const clearPartial = (queue: Queue, key: string): Queue => replace(queue, key, ({ partial: _declared, ...entry }) => entry);

/**
 * The finished runs whose ticket the tracker completed while their work was partial, and which no person is known to have completed (A11-178): the runs the board asks the tracker to put back, on every sweep
 * until it has, so a refused or unanswered ask is tried again. See {@link completedEarly}. PURE.
 */
export const earlyCompletions = (queue: Queue): Entry[] => queue.entries.filter(completedEarly);

/** `steps N to M of M`, `steps N and M of M` or `step N of M`, for the steps from `from` through `of`. PURE. */
function stepsFrom(from: number, of: number): string {
  if (from === of) return `step ${of} of ${of}`;
  return `steps ${from}${of - from === 1 ? " and " : " to "}${of} of ${of}`;
}

/** The pull requests of `entry` that merged, as the board names them. PURE. */
const mergedLabels = (entry: Entry): string[] => pullsOf(entry).map(({ url }) => url).filter((url) => entry.pullStates?.[url] === "merged").map(pullLabel);

/**
 * What the board says of the work that merged before the tracker completed the ticket (A11-178): the pull requests, the plan step they finished when it is known, and what remains. The work is the run's own
 * partial pull requests when they merged: the step is the one the declaration names, or the board counted (A11-173), and what remains is the steps after it, or the declaration's own words where no step follows.
 * Otherwise it is the last step already merged on the run (`steps`): a later step the integration completed the ticket under, which is still open or has just been queued. PURE.
 */
function mergedWork(entry: Entry): Readonly<{ prs: string[]; step: PlanStep | null; remaining: string }> {
  const { partial, steps = [] } = entry;
  const last = steps.at(-1);
  if (partial !== undefined && settledByPulls(entry) === "completed") {
    const after = afterPartialMerge(partial, steps, entry.planSteps);
    const step = "next" in after ? { step: after.next.step - 1, of: after.next.of } : stepNamed(partial);
    return { prs: mergedLabels(entry), step, remaining: "next" in after ? stepsFrom(after.next.step, after.next.of) : partial };
  }
  return { prs: (last?.prs ?? []).map(pullLabel), step: last ?? null, remaining: last === undefined ? "the rest of the plan" : stepsFrom(last.step + 1, last.of) };
}

/**
 * The comment the board posts on a ticket it puts back after the tracker's integration completed it (A11-178): the merged pull requests and the step they finished, what the integration did, and what remains of
 * the ticket. It names no closing word beside a key, since the board's own text is held to the rule it enforces. PURE.
 */
export function earlyCompletionComment(entry: Entry): string {
  const { prs, step, remaining } = mergedWork(entry);
  const finished = step === null ? "" : ` as step ${step.step} of ${step.of}`;
  const declared = entry.partial === undefined ? "" : ` (Partial: ${entry.partial})`;
  const merged = prs.length === 0 ? "A pull request" : prs.join(", ");
  return `${merged} merged${finished} of ${entry.ticket.key}${declared}. The tracker's integration moved the ticket to its completed state; the ticket board moved it back to the state it was in before. Remaining: ${remaining}.`;
}

/** The ticket was put back: the run no longer reads the tracker's Completed, so its next step is queued like that of any partial run, and any earlier failure to put it back is forgotten. */
export const recordReopened = (queue: Queue, key: string): Queue => replace(queue, key, ({ trackerState: _completed, reopenFailure: _failed, ...entry }) => entry);

/** A person completed the ticket: their move wins, the run reads Completed, and the board does not ask the tracker again. */
export const recordCompletedByPerson = (queue: Queue, key: string): Queue => replace(queue, key, ({ reopenFailure: _failed, ...entry }) => ({ ...entry, completedBy: "person" }));

/** The ticket could not be put back, and why: the card flags the run, and the next sweep tries again. */
export const recordReopenFailure = (queue: Queue, key: string, reason: string): Queue => replace(queue, key, (entry) => ({ ...entry, reopenFailure: reason }));
