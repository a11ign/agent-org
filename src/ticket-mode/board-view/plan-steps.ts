// @ts-check
// module: the plan step a partial pull request finished, and what the board does when it merges (A11-168) -- PURE
//
// A ticket whose plan has numbered steps ships one pull request for each. A worker that finishes step N of M says so in the `Partial:` line of its body and, in the same
// words, in the `partial` of its outcome (A11-92). When that pull request merges, the board queues step N + 1 on the same plan. Only a numbered step that moves forward is
// queued: a declaration that names no step, the last step, or a step that is not past the last one merged goes to a person, with the reason, so a worker that writes `Partial`
// without moving forward cannot loop the queue. This file is in `board-view/` because the page words the reason from it, and the page runs only what that folder holds.

/** A step of the plan, numbered from 1, out of the plan's `of` steps. */
export type PlanStep = Readonly<{ step: number; of: number }>;

/** A step whose pull requests merged: the step, and the web address of each pull request that finished it. */
export type MergedStep = PlanStep & Readonly<{ prs: readonly string[] }>;

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

/** What a merged partial pull request leads to: the next step to queue, or why nothing is queued, worded for the card. */
export type AfterMerge = Readonly<{ next: PlanStep } | { stalled: string }>;

/**
 * What follows a partial pull request that merged, given its `partial` declaration and the steps already merged on this ticket's run. The next step is queued only when the
 * declaration names step N of M with N below M, and N is past every step already recorded. Anything else is `stalled`, with the sentence the card shows. PURE.
 */
export function afterPartialMerge(partial: string, merged: readonly PlanStep[]): AfterMerge {
  const named = stepNamed(partial);
  const said = `Partial merged: ${partial}.`;
  if (named === null) return { stalled: `${said} It names no step, so nothing was queued: Dismiss it and queue the ticket` };
  if (named.step === named.of) return { stalled: `${said} It names step ${named.of} of ${named.of}, the last, with Partial: the last step closes the ticket` };
  const last = Math.max(0, ...merged.map(({ step }) => step));
  if (named.step <= last) return { stalled: `${said} Step ${named.step} is not after step ${last}: nothing was queued` };
  return { next: { step: named.step + 1, of: named.of } };
}

/** The line a run queued for the next step carries, `step 1 of 9 merged; step 2 queued`, or null for a run that is no later step. PURE. */
export const stepQueuedLine = (merged: readonly PlanStep[]): string | null => stepLine(merged, "queued");

/** The same line once the run has started, `step 1 of 9 merged; step 2 running`. PURE. */
export const stepRunningLine = (merged: readonly PlanStep[]): string | null => stepLine(merged, "running");

function stepLine(merged: readonly PlanStep[], state: "queued" | "running"): string | null {
  const last = merged.at(-1);
  return last === undefined ? null : `step ${last.step} of ${last.of} merged; step ${last.step + 1} ${state}`;
}
