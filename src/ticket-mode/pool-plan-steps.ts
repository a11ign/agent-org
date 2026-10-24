// @ts-check
// module: reading the numbered steps of a ticket's plan -- how many, for a merged partial run that gave no total (A11-173), and which, for a run that starts (A11-219)

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { planStepCount } from "./plan-step-count.ts";
import { type PlannedStep, planStepList } from "./plan-step-sections.ts";
import { PLAN_FILE_BYTES } from "./pool-outcome.ts";
import { planFiles, planTexts } from "./pool-ticket-text.ts";
import { log, messageOf, update } from "./pool-state.ts";
import { planStepsUnread, recordPlanSteps } from "./queue/queue-next-step.ts";
import { type PoolContext } from "./pool-context.ts";

/**
 * Count the numbered steps of the plan of each run whose partial pull request merged without saying `of <M>` (A11-173), once: the plan files are downloaded as the paths are read, and the
 * highest step number any plan file numbers is recorded, 0 included. A plan the tracker will not give is logged and asked again on the next sweep.
 */
export async function readPlanSteps(ctx: PoolContext): Promise<void> {
  const { settings, store } = ctx;
  if (settings.plan === null) return;
  const pattern = new RegExp(settings.plan);
  for (const { ticket } of planStepsUnread(store.get())) {
    try {
      const files = (await planFiles(ctx, ticket)).filter((file) => pattern.test(basename(file)) && statSync(file).size <= PLAN_FILE_BYTES);
      const count = Math.max(0, ...files.map((file) => planStepCount(readFileSync(file, "utf8"))));
      update(ctx, (queue) => recordPlanSteps(queue, ticket.key, count));
    } catch (err) {
      log(`${ticket.key}: its plan's steps could not be counted: ${messageOf(err)}`);
    }
  }
}

/**
 * The numbered steps, with their titles, of the plan files `planFiles` downloaded for ticket `key` (A11-219), or none when this machine names no plan, no plan file is there, or none numbers a step. Reads the
 * folder and downloads nothing, as `planStepSection` does: a plan the run was queued with is there. The first plan file, by name, that numbers any step gives them. Throws, naming the file, when a plan file cannot be read: that is not a ticket with no plan (see `planTexts`).
 */
export function plannedStepsOf(ctx: PoolContext, key: string): readonly PlannedStep[] {
  for (const text of planTexts(ctx, key)) {
    const steps = planStepList(text);
    if (steps.length > 0) return steps;
  }
  return [];
}
