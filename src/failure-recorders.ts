// @ts-check
// module: the failure ledger's recorders for one tick of the work gate (a11ign/a11ign#4450, move 1a of #4437)
//
// Beside `work-gate.ts` and not in it: the gate writes files, and `org-retro.test.ts` reads a source that names a state file AND writes anything as that file's writer. The gate
// naming `hand-fix-ledger` (to record its entries) would make it the "writer" of the hand-fix ledger. This module writes through `failure-ledger.ts` and names no file itself.
import { FAILURE_LEDGER_FILE, mainRedEvents, recordFailures } from "./failure-ledger.ts";
import { recordHandReroutes } from "./hand-fix-ledger.ts";
import { unresolvedOwnerEvents } from "./pr-ownership.ts";

/**
 * THE EVENTS OF THIS TICK THAT NEVER BECOME A CLOSED ROW, appended to `failure-ledger` beside `wake-deferral-log` -- a red `main`, a pull request nobody could be named the owner of,
 * and (once a day) the hand fixes. A recorder reports a refusal and never throws, so the ledger can only ever be missing an event, never stop a tick.
 * @param {{ trunkRed: Parameters<typeof mainRedEvents>[0], prs: any[], stateDir: string, now: number, ownerOf: Parameters<typeof unresolvedOwnerEvents>[1], homeRepo: string }} seen
 */
export function recordTickFailures({ trunkRed, prs, stateDir, now, ownerOf, homeRepo }: { trunkRed: Parameters<typeof mainRedEvents>[0]; prs: any[]; stateDir: string; now: number; ownerOf: Parameters<typeof unresolvedOwnerEvents>[1]; homeRepo: string; }): void {
  const logPath = `${stateDir}/${FAILURE_LEDGER_FILE}`;
  recordFailures({ logPath, events: [...mainRedEvents(trunkRed), ...unresolvedOwnerEvents(prs, ownerOf, homeRepo)], now });
  recordHandReroutes({ logPath, markerPath: `${logPath}-hand-read`, now });
}
