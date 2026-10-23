// @ts-check
// module: the plan step a partial pull request finished, and what the board does when it merges (A11-168) -- PURE
//
// A ticket whose plan has numbered steps ships one pull request for each. A worker that finishes step N of M says so in the `Partial:` line of its body and, in the same
// words, in the `partial` of its outcome (A11-92). When that pull request merges, the board queues step N + 1 on the same plan. Only a numbered step that moves forward is
// queued: a declaration that names the last step, or a step that is not past the last one merged goes to a person, with the reason, so a worker that writes `Partial`
// without moving forward cannot loop the queue. A declaration that gives no `of <M>`, or no step at all, is counted by the board (A11-173): the step it finished is the one it names or else
// the first the plan's record does not show as merged, and the plan's size is the record's or the plan file's (`plan-step-count.ts`). Only a plan with no step left stops. This file is in `board-view/` because the page words the reason from it, and the page runs only what that folder holds.

/** A step of the plan, numbered from 1, out of the plan's `of` steps. */
export type PlanStep = Readonly<{ step: number; of: number }>;

/** A step of the plan's record, and whether the board counted it (A11-173). */
export type StepRecord = PlanStep & Readonly<{ counted?: true }>;

/** A step whose pull requests merged: the step, the web address of each pull request that finished it, and `counted` when the board counted the step because the declaration did not name it (A11-173). */
export type MergedStep = StepRecord & Readonly<{ prs: readonly string[] }>;

/** `step <N> of <M>`, as the ticket's plan numbers its steps and the brief tells a worker to word the `Partial:` line. */
const STEP_WORDS = /\bstep\s+(\d+)\s+of\s+(\d+)\b/i;

/**
 * The step a `partial` declaration names: the first `step <N> of <M>` in it, any case, or null when it names none or names an impossible one (a step 0, or one past the
 * last). PURE.
 */
export function stepNamed(partial: string): PlanStep | null {
  const found = STEP_WORDS.exec(partial);
  if (found === null) return null;
  const [step, of] = [Number(found[1]), Number(found[2])];
  return step >= 1 && step <= of ? { step, of } : null;
}

/**
 * The step a pull request's body says it finishes: the first `step <N> of <M>` on its `Partial:` line, or null when the body has no such line or the line names no step (A11-175). A body with no
 * `Partial:` line is a pull request that finishes its ticket, and one with a `Partial:` line that names no step is one the reviewer holds to the whole ticket as before. PURE.
 */
export function partialStepOf(body: string): PlanStep | null {
  const line = /^[\s>*_-]*Partial:[^\n]*/im.exec(body);
  return line === null ? null : stepNamed(line[0]);
}

/** The fields of a run that say which step of its plan it is on (A11-175): what it declared, the steps merged before it, and the paths the plan's step sections list. */
type StepFields = Readonly<{ partial?: string; steps?: readonly MergedStep[]; stepPaths?: Readonly<Record<string, readonly string[]>> }>;

/**
 * The plan step a run is on (A11-175), or null for a run that is no step of a plan: the step its `partial` names (a finished run whose partial pull request is open); else the step after the last
 * merged one (a run queued or running for the next step); else step 1, when the plan's step sections list paths. A run with no current step is a single-step run. PURE.
 */
export function currentStepOf({ partial, steps, stepPaths }: StepFields): number | null {
  const named = partial === undefined ? null : stepNamed(partial);
  if (named !== null) return named.step;
  if (steps !== undefined && steps.length > 0) return Math.max(...steps.map(({ step }) => step)) + 1;
  return Object.keys(stepPaths ?? {}).length > 0 ? 1 : null;
}

/** The paths the plan's section for the run's current step lists, or null when the run has no current step or that section lists none (A11-175). PURE. */
export function currentStepPaths(run: StepFields): readonly string[] | null {
  const step = currentStepOf(run);
  const own = step === null ? undefined : run.stepPaths?.[String(step)];
  return own === undefined || own.length === 0 ? null : own;
}

/** What a merged partial pull request leads to: the next step to queue, `counted` when the board counted the step the declaration finished, or why nothing is queued, worded for the card. */
export type AfterMerge = Readonly<{ next: PlanStep & Readonly<{ counted?: true }> } | { stalled: string }>;

/**
 * The first `step <N> of` a declaration names without a total, such as `step 2 of the plan`: the words the brief tells a worker to write, cut short. A bare `step 2` is not read, since
 * `step 2 remains` and `step 2 done` say opposite things. Null when it names none. */
const stepNumberNamed = (partial: string): number | null => {
  const found = /\bstep\s+(\d+)\s+of\b/i.exec(partial);
  return found === null ? null : Number(found[1]);
};

/** Why a step at or past the plan's last queues nothing, worded for the card: it is the last step, which closes the ticket, or it is past the plan's end. PURE. */
function beyondPlan({ step, size, counted }: Readonly<{ step: number; size: number; counted: boolean }>): string {
  if (step > size) return `It names step ${step}, past the plan's last step, ${size}: nothing was queued`;
  return `${counted ? `The board counted it as step ${size} of ${size}` : `It names step ${size} of ${size}`}, the last, with Partial: the last step closes the ticket`;
}

/**
 * What follows a partial pull request that merged, given its `partial` declaration, the steps already merged on this ticket's run and the number of numbered steps the plan file
 * has (`planSteps`, undefined while it has not been counted). The next step is queued only when the step finished is below the plan's size and past every step already recorded.
 * A declaration `step N of M` finishes step N of M. Otherwise the board counts (A11-173): the step finished is the first `step <N> of` the declaration names, or else the first after the
 * last recorded; the plan's size is the record's `of`, or else `planSteps`. Anything else is `stalled`, with the sentence the card shows. PURE.
 */
export function afterPartialMerge(partial: string, merged: readonly PlanStep[], planSteps?: number): AfterMerge {
  const said = `Partial merged: ${partial}.`;
  const last = Math.max(0, ...merged.map(({ step }) => step));
  const named = stepNamed(partial);
  // `step 3 of 2` names a step that is not in its own plan: that is a mistake for a person, not a step to count past.
  if (named === null && STEP_WORDS.test(partial)) return { stalled: `${said} It names no step, so nothing was queued: Dismiss it and queue the ticket` };
  const counted = named === null;
  const size = named?.of ?? (merged.at(-1)?.of ?? planSteps ?? 0);
  const step = named?.step ?? stepNumberNamed(partial) ?? last + 1;
  if (counted && size === 0) {
    const why = planSteps === 0 ? "It names no step, and the plan has no numbered steps" : "It names no step";
    return { stalled: `${said} ${why}, so nothing was queued: Dismiss it and queue the ticket` };
  }
  if (step >= size) return { stalled: `${said} ${beyondPlan({ step, size, counted })}` };
  if (step <= last) return { stalled: `${said} Step ${step} is not after step ${last}: nothing was queued` };
  return { next: { step: step + 1, of: size, ...(counted ? { counted: true as const } : {}) } };
}

/** The line a run queued for the next step carries, `step 1 of 9 merged; step 2 queued`, or null for a run that is no later step. PURE. */
export const stepQueuedLine = (merged: readonly StepRecord[]): string | null => stepLine(merged, "queued");

/** The same line once the run has started, `step 1 of 9 merged; step 2 running`. PURE. */
export const stepRunningLine = (merged: readonly StepRecord[]): string | null => stepLine(merged, "running");

/** What a step the board counted says of it: the declaration named no step (A11-173). */
const COUNTED_WORDS = "counted by the board: the Partial line named no step";

function stepLine(merged: readonly StepRecord[], state: "queued" | "running"): string | null {
  const last = merged.at(-1);
  return last === undefined ? null : `step ${last.step} of ${last.of} merged${last.counted ? ` (${COUNTED_WORDS})` : ""}; step ${last.step + 1} ${state}`;
}
