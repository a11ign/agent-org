// @ts-check
// module: the failure ledger's recorders for one tick of the work gate (a11ign/a11ign#4450, move 1a of #4437)
//
// Beside `work-gate.ts` and not in it: the gate writes files, and `org-retro.test.ts` reads a source that names a state file AND writes anything as that file's writer. The gate
// naming `hand-fix-ledger` (to record its entries) would make it the "writer" of the hand-fix ledger. This module writes through `failure-ledger.ts` and `messaging/audit.ts` and names
// no file itself but the audit's cursor.
import { homedir } from "node:os";

import { FAILURE_LEDGER_FILE, mainRedEvents, recordFailures } from "./failure-ledger.ts";
import { recordHandReroutes } from "./hand-fix-ledger.ts";
import { auditMessaging } from "./messaging/audit.ts";
import { defaultLedgerPath } from "./messaging/state.ts";
import { unresolvedOwnerEvents } from "./pr-ownership.ts";

/** Where the messaging audit's cursor (how many ledger lines it has read) lives, beside `failure-ledger`: each tick is a fresh process. */
export const MESSAGING_AUDIT_CURSOR_FILE = "messaging-audit-cursor";

const sayOnStderr = (line: string) => process.stderr.write(`${line}\n`);

/**
 * THE EVENTS OF THIS TICK THAT NEVER BECOME A CLOSED ROW, appended to `failure-ledger` beside `wake-deferral-log` -- a red `main`, a pull request nobody could be named the owner of,
 * and (once a day) the hand fixes. A recorder reports a refusal and never throws, so the ledger can only ever be missing an event, never stop a tick.
 *
 * LAST, THE MESSAGING AUDIT (#928, #4746): an announcement that asks the chairman something is a `messaging-audience-misuse` line. `home` is whose messaging ledger it reads (a host with
 * none reads as an empty one, so only the cursor is written), and `say` is where its count line and refusals go -- stderr with the other recorders', never stdout, which is the orders.
 * @param {{ trunkRed: Parameters<typeof mainRedEvents>[0], keyedTrunkReds: Parameters<typeof mainRedEvents>[0][], prs: any[], stateDir: string, now: number, ownerOf: Parameters<typeof unresolvedOwnerEvents>[1], homeRepo: string, home?: string, say?: (line: string) => void }} seen
 */
export function recordTickFailures({ trunkRed, keyedTrunkReds, prs, stateDir, now, ownerOf, homeRepo, home = homedir(), say = sayOnStderr }: { trunkRed: Parameters<typeof mainRedEvents>[0]; keyedTrunkReds: Parameters<typeof mainRedEvents>[0][]; prs: any[]; stateDir: string; now: number; ownerOf: Parameters<typeof unresolvedOwnerEvents>[1]; homeRepo: string; home?: string; say?: (line: string) => void; }): void {
  const logPath = `${stateDir}/${FAILURE_LEDGER_FILE}`;
  recordFailures({ logPath, events: [...mainRedEvents(trunkRed), ...keyedTrunkReds.flatMap(mainRedEvents), ...unresolvedOwnerEvents(prs, ownerOf, homeRepo)], now });
  recordHandReroutes({ logPath, markerPath: `${logPath}-hand-read`, now });
  try {
    auditMessaging({ ledgerPath: defaultLedgerPath(home), failureLogPath: logPath, cursorPath: `${stateDir}/${MESSAGING_AUDIT_CURSOR_FILE}`, now, report: say, print: say });
  } catch (cause) {
    say(`messaging audit: recorder failed: ${String((cause as Error)?.message ?? cause).split("\n")[0]}`);
  }
}
