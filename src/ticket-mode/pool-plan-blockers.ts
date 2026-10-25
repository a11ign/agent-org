// @ts-check
// module: the tickets a plan says its work waits on (A11-272) -- read from the plan's `## Blocked by` section and written to the tracker as blockers when the plan is attached, so the queue orders the two tickets before any run starts
//
// A STEP OF A PLAN CAN NEED ANOTHER TICKET'S WORK (A11-231's step 2 needed A11-229's step 3). Found by a worker in the middle of a run, that is a wait that parks the run; found by the planner it is a relation, and the
// queue holds the ticket behind it from the start. The planner's connectors are read-only and its folder takes markdown only, so it WRITES the dependency in the plan and the board records it, as it does a batch's
// `order.json` (the reading of the section is `plan-blockers.ts`).
import { readFileSync } from "node:fs";
import { type PoolContext } from "./pool-context.ts";
import { log, messageOf } from "./pool-state.ts";
import { plannedBlockers } from "./plan-blockers.ts";

/** The tickets the plan files `files` of ticket `key` name as its blockers ({@link plannedBlockers}). Read at once, so a plan that names none awaits nothing and the slot it frees is filled in the same pass. */
export const blockersOfPlan = (files: readonly string[], key: string): string[] => plannedBlockers(files.map((file) => readFileSync(file, "utf8")), key);

/**
 * Record `blockers`, the tickets a plan names, as blockers of ticket `key` in the tracker, and return the keys it recorded. A tracker that refuses the lot is asked for each key alone, so one key it does not know does not
 * lose the others; one that takes none records none. Every refusal is logged and the plan stands without that relation, as a batch's order does; only the log says the queue will not order the two.
 */
export async function writePlanBlockers(ctx: PoolContext, key: string, blockers: readonly string[]): Promise<readonly string[]> {
  const { source } = ctx;
  if (source.addBlockers === undefined) {
    log(`${blockers.join(", ")} could not be recorded as blocking ${key}: this tracker takes no blockers, so the queue does not order them`);
    return [];
  }
  const add = source.addBlockers.bind(source);
  const attempt = async (keys: readonly string[]): Promise<boolean> => {
    try {
      await add(key, keys);
      return true;
    } catch (err) {
      log(`${keys.join(", ")} could not be recorded as blocking ${key}: ${messageOf(err)}`);
      return false;
    }
  };
  if (await attempt(blockers)) return blockers;
  if (blockers.length === 1) return [];
  const each = [];
  for (const blocker of blockers) if (await attempt([blocker])) each.push(blocker);
  return each;
}
