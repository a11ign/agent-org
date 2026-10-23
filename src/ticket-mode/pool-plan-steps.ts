// @ts-check
// module: reading how many numbered steps a ticket's plan has, for a merged partial run that gave no total (A11-173)

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { planStepCount } from "./plan-step-count.ts";
import { PLAN_FILE_BYTES } from "./pool-outcome.ts";
import { planFiles } from "./pool-ticket-text.ts";
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
