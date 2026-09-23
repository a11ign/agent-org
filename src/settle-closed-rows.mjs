#!/usr/bin/env node
// @ts-check
// command: settle every CLOSED row the board still shows at a live Status -- keyed on the board, never on a PR
//
// #2081: THE THIRD SETTLE PATH, AND THE ONLY ONE WHOSE POPULATION IS THE BOARD ITSELF.
//
// Measured 2026-09-23 08:31Z: 38 of the last 60 closed rows were not `Done`, from two causes that both
// survived #1996 (which added the `Done` option the board had been missing):
//
//   A. CI's token cannot read Project 1 (#546), so every settle in CI is refused -- and `closeRowsExit`'s
//      bridge turns that refusal into exit 0 with a DEGRADED line. The bridge is deliberate; what it cost
//      was not measured until now: the DEGRADED branch is the ONLY branch CI ever takes, so trunk is green
//      on every merge while no Status has moved in CI at all (trunk run 35836501174, six rows, one cause).
//   B. A row closed by hand is settled by NOTHING, in any context. Both existing paths are keyed on a
//      MERGED PR inside a window, and `gh issue close` puts a row in neither population. Of the 7 boarded
//      rows still drifted after a hand-run sweep that day, 5 had been closed by hand.
//
// This answers both at once: the population is every CLOSED board item whose Status is not `Done`
// (`closedRowsToSettle`), so a hand-closed row is in it by construction and a CI merge whose settle was
// refused is picked up on the next pass. The decision lives in `settle-closed-status.mjs`, which is pure
// of `gh`; this file is the wiring, and it supplies the two things that carry a token.
//
// IT NEVER CLOSES A ROW. Its population is rows GitHub ALREADY reports closed; it changes a Status and
// nothing else. That is the line between this and `close-rows-*`, whose own header names the risk
// ("a tool that closed rows automatically would eventually close one whose work did not actually land").
//
// NO `gh pr list`, ANYWHERE IN THIS FILE OR ITS CLOSURE -- that is the row's done-when, not an incidental
// property: reading a PR list is what makes a hand-closed row invisible.
//
// NO LAUNCH GATE (#1352), deliberately, and `close-rows-sweep.mjs` is the precedent: this runs in CI's
// plain clone as well as from a session's worktree, and the gate refuses a plain clone. The snapshot it
// writes resolves from the git common dir, so a session running it from any worktree writes where every
// other board mutation writes.
//
// Exit codes are the contract, and they are `close-rows-sweep.mjs`'s, imported rather than restated:
//   0  every drifted row settled -- or the board could not be read because the token cannot read the
//      Project (#546), which is DEGRADED and must not turn trunk red for a ceiling it cannot lift
//   2  the board could not be read for any OTHER cause. INCONCLUSIVE, never "fine".
//   3  one or more Statuses did not move. NAMED, never counted.
//
//   node packages/agent-org/src/settle-closed-rows.mjs
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
import { settleBoardRows, settleClosedStatus, boardReadRefusal } from "./settle-closed-status.mjs";
// The token-carrying halves, imported HERE (an entry point) and injected, so the decision module stays
// pure -- #1009's rule, and the reason this command's Acceptance can run in the job with no token.
import { fetchBoardItems } from "./board-snapshot.mjs";
// `EXIT` and `closeRowsExit` are the SAME contract both close paths take, imported rather than re-derived:
// "a second copy of that decision is the exact 'fact stated twice' shape this repo keeps paying for."
import { closeRowsExit, EXIT, LIVE_SETTLE_DEPS } from "./close-rows-for-merged-pr.mjs";

export const LOG_PREFIX = "SETTLE-BOARD";

/**
 * The live settle for ONE row: the live mover, and the Status this pass ALREADY READ in place of a second
 * per-row read. `LIVE_SETTLE_DEPS.currentStatus` is `scopedStatus`, one `gh` request per row -- which is
 * exactly the read the board sweep above has already made for every row at once, so answering from it is
 * #1360's own instruction ("answers from data the caller ALREADY HOLDS ... never from a new read per
 * row"), not a weakening of it.
 * @param {number} n @param {string | null} heldStatus
 * @returns {import("./settle-closed-status.mjs").SettleOutcome}
 */
function settleOne(n, heldStatus) {
  return settleClosedStatus(n, { ...LIVE_SETTLE_DEPS, currentStatus: () => heldStatus, prefix: LOG_PREFIX });
}

function main() {
  refuseUnknownFlags([], { entry: import.meta.url, command: "node packages/agent-org/src/settle-closed-rows.mjs" });

  let items;
  try {
    items = fetchBoardItems();
  } catch (cause) {
    const { degraded, line } = boardReadRefusal(cause instanceof Error ? cause.message : String(cause));
    console.error(line);
    process.exit(degraded ? EXIT.DONE : EXIT.CANNOT_ASK);
  }

  const { attempted, unsettled } = settleBoardRows(items, { settle: settleOne });
  const { code, lines } = closeRowsExit({ failed: [], unsettled }, LOG_PREFIX);
  for (const line of lines) console.error(line);
  console.log(`${LOG_PREFIX}: ${attempted.length - unsettled.length} of ${attempted.length} drifted row(s) `
    + `settled to Done.`);
  process.exit(code);
}

// The entry guard `merge-guard.mjs`/`close-rows-for-merged-pr.mjs` use.
if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
