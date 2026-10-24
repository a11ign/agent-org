// @ts-check
// module: what the board records of a run's plan and machine (A11-219) -- PURE
//
// The numbered steps of the plan a run starts with, the step its worker says it is on, and where it ran. They are read by the page's run detail, which draws them.

import { currentStepOf } from "../board-view/plan-steps.ts";
import type { PlannedStep } from "../plan-step-sections.ts";
import { find, isLive, replace, type Queue } from "./queue-entries-and-outcomes.ts";

/** Where a run ran (A11-219): the name of the instance whose pool started it, and the machine's host name. Over an SSH connection the page reads the remote instance's own queue, so `instance` there is the remote's. */
export type RunWorker = Readonly<{ instance: string; host: string }>;

/**
 * Record the numbered steps of the plan a run starts with (A11-219), and the step it begins on: the board's own for a multi-pull-request plan (`currentStepOf`), else none until the worker writes one. A run with no
 * numbered steps keeps none, so the page draws no section for it. PURE.
 */
export function recordPlannedSteps(queue: Queue, key: string, plannedSteps: readonly PlannedStep[]): Queue {
  if (plannedSteps.length === 0) return queue;
  return replace(queue, key, (entry) => {
    const begins = currentStepOf(entry);
    return { ...entry, plannedSteps, ...(begins === null ? {} : { currentStep: begins }) };
  });
}

/** Record the plan step a live run's worker says it is on (A11-219), as written. The queue is returned as it was when the run already has that step, or is not live. PURE. */
export function recordCurrentStep(queue: Queue, key: string, step: number): Queue {
  const entry = find(queue, key);
  if (entry === undefined || !isLive(entry) || entry.currentStep === step) return queue;
  return replace(queue, key, (live) => ({ ...live, currentStep: step }));
}
