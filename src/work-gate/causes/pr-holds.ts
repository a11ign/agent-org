import { holdersOf, holderOrdersOf } from "../../pr-hold-state.ts";
import { readJsonObject } from "../../claim-stall/claim-stalled.ts";
import { writeJsonObject } from "../../claim-stall.ts";
import { WORKER_STATE_DIR, readDeclarations } from "../../worker-state.ts";
import { readAgents } from "../../herdr-agents.ts";
import { REVIEWER_STATE_DIR, labelsOf } from "../vocabulary.ts";

/** Where the hold-holder check (#4970) remembers, per hold, when its holder was first read idle and when it was woken and asked about. Beside the stall memory. */
export const HOLD_HOLDERS_FILE = "hold-holders.json";

/**
 * #4970: A HOLD ON A PULL REQUEST OUTLIVES NO HOLDER. The tick's step over the held pull requests it already read: a holder idle 30 minutes with no declared state, or whose session
 * no workspace carries, is woken ONCE; 30 minutes later, still idle or gone, `orchestrator` is asked to decide (`pr-hold-state.ts`'s `holderStep` is the reading). It COSTS NO `gh` CALL
 * (the pull requests are in hand) and makes one `herdr` listing when something is held. NEVER LIFTS A HOLD, and never throws: a refused pull-request list, a listing that is not the
 * whole org or declarations that cannot be read are silence, and the memory stays as it was.
 */
export function holdHolderOrdersNow({ prs, now = Date.now(), stateDir = REVIEWER_STATE_DIR, agents = readAgents, log = (line: string) => process.stderr.write(line) }:
  { prs: any[] | null; now?: number; stateDir?: string; agents?: typeof readAgents; log?: (line: string) => void; }): any[] {
  if (prs === null) return [];
  try {
    const path = `${stateDir}/${HOLD_HOLDERS_FILE}`;
    const before = readJsonObject(path);
    const held = prs.some((pr) => holdersOf(labelsOf(pr)).length > 0);
    if (!held) {
      if (Object.keys(before).length > 0) writeJsonObject(path, {});
      return [];
    }
    const declarations = readDeclarations(`${stateDir}/${WORKER_STATE_DIR}`);
    if (declarations === null) {
      log("hold-holders: the worker-state directory could not be read -- no hold is judged idle this tick.\n");
      return [];
    }
    const { orders, memory } = holderOrdersOf({ prs, agents: agents(), declarations: declarations.byClaimant, memory: before, now });
    if (JSON.stringify(memory) !== JSON.stringify(before)) writeJsonObject(path, memory);
    return orders;
  } catch (err) {
    log(`hold-holders: could not run (${String((err as Error)?.message ?? err).split("\n")[0].slice(0, 160)}) -- no order this tick.\n`);
    return [];
  }
}
