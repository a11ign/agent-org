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
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
import { settleBoardRows, settleClosedStatus, boardReadRefusal, shortReadRefusal,
  closedRowsQuery, closedRowsFromRead } from "./settle-closed-status.mjs";
// The repository this pass reads, from the one place that names it.
import { REPO } from "../../../scripts/repo-identity.mjs";
// The token-carrying halves, imported HERE (an entry point) and injected, so the decision module stays
// pure -- #1009's rule, and the reason this command's Acceptance can run in the job with no token.
// `PROJECT_OWNER`/`PROJECT_NUMBER` ride the import this file already makes: the floor's population
// read names the Project from the ONE place that declares it, never from a literal here.
import { fetchBoardItems, PROJECT_OWNER, PROJECT_NUMBER } from "./board-snapshot.mjs";
// `EXIT` and `closeRowsExit` are the SAME contract both close paths take, imported rather than re-derived:
// "a second copy of that decision is the exact 'fact stated twice' shape this repo keeps paying for."
import { closeRowsExit, EXIT, LIVE_SETTLE_DEPS } from "./close-rows-for-merged-pr.mjs";

export const LOG_PREFIX = "SETTLE-BOARD";

/**
 * The cap on the floor's population read -- NOT a sample size, and the distinction is what two reviews
 * were about. 500 against a live population of 201 (measured 2026-09-23) leaves real headroom, and
 * `closedRowsFromRead` REFUSES an exactly-full page rather than reporting it complete, so the cap can
 * never silently become a sample again. The remedy is to raise it, up to GitHub's 1,000-result search
 * ceiling; the refusal names what to do past that.
 *
 * 500 is `fetchReadyIssueNumbers`'s own number, for the same read shape and the same contract.
 */
const FLOOR_LIMIT = 500;

/** @param {string[]} args */
const gh = (args) => execFileSync("gh", args, { encoding: "utf8" }).trim();

/**
 * The floor's independent population: every CLOSED row GitHub itself reports as an item on THIS Project,
 * narrowed BY GITHUB through the `project:` search qualifier rather than by a client-side guess at what
 * `projectItems` means. `gh issue list`, never `gh pr list`: this pass's population must not depend on any
 * PR existing, which is the whole of #2081.
 *
 * `closedRowsQuery` and `closedRowsFromRead` are pure and carry the reasoning, the measurement and the
 * truncation contract; this function is the one call between them, and it is the only thing here that
 * spends a token.
 *
 * @param {(args: string[]) => string} [gh_]
 * @returns {number[]}
 */
export function closedRowsOnProject(gh_ = gh) {
  const query = closedRowsQuery({ repo: REPO, owner: PROJECT_OWNER, number: PROJECT_NUMBER, limit: FLOOR_LIMIT });
  return closedRowsFromRead(gh_(query), FLOOR_LIMIT);
}

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
    // `fetchReady: () => []` REPLACES #747's floor rather than removing it -- `shortReadRefusal` below is
    // this pass's own, over the population it acts on. `shortReadRefusal`'s header carries the measurement
    // and the reasoning; the substitution is here because the floor's population is a CALLER's choice.
    items = fetchBoardItems({ fetchReady: () => [] });
  } catch (cause) {
    const { degraded, line } = boardReadRefusal(cause instanceof Error ? cause.message : String(cause));
    console.error(line);
    process.exit(degraded ? EXIT.DONE : EXIT.CANNOT_ASK);
  }

  // SEPARATE FROM THE BOARD READ, because they fail differently and one of them must stay loud. The board
  // read above is DEGRADED in CI (#546's ceiling, which no operator can lift); the floor's population is a
  // plain issue search that CI's token can make, so a failure here is a real one -- including the
  // truncation refusal -- and must never borrow the board read's exit-0 bridge.
  let boardedClosedRows;
  try {
    boardedClosedRows = closedRowsOnProject();
  } catch (cause) {
    console.error(`${LOG_PREFIX}: CANNOT ASK -- the floor's own population could not be read, so this pass `
      + `cannot tell a complete board read from a partial one: `
      + `${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(EXIT.CANNOT_ASK);
  }

  const short = shortReadRefusal(items, boardedClosedRows);
  if (short) {
    console.error(`${LOG_PREFIX}: CANNOT ASK -- ${short}`);
    process.exit(EXIT.CANNOT_ASK);
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
