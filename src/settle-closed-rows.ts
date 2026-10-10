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
// refused is picked up on the next pass. The decision lives in `settle-closed-status.ts`, which is pure
// of `gh`; this file is the wiring, and it supplies the two things that carry a token.
//
// IT NEVER CLOSES A ROW. Its population is rows GitHub ALREADY reports closed; it changes a Status and
// nothing else. That is the line between this and `close-rows-*`, whose own header names the risk
// ("a tool that closed rows automatically would eventually close one whose work did not actually land").
//
// NO `gh pr list`, ANYWHERE IN THIS FILE OR ITS CLOSURE -- that is the row's done-when, not an incidental
// property: reading a PR list is what makes a hand-closed row invisible.
//
// NO LAUNCH GATE (#1352), deliberately, and `close-rows-sweep.ts` is the precedent: this runs in CI's
// plain clone as well as from a session's worktree, and the gate refuses a plain clone. The snapshot it
// writes resolves from the git common dir, so a session running it from any worktree writes where every
// other board mutation writes.
//
// Exit codes are the contract, and they are `close-rows-sweep.ts`'s, imported rather than restated:
//   0  every drifted row settled -- or the board could not be read because the token cannot read the
//      Project (#546), which is DEGRADED and must not turn trunk red for a ceiling it cannot lift
//   2  the board could not be read for any OTHER cause. INCONCLUSIVE, never "fine".
//   3  one or more Statuses did not move. NAMED, never counted.
//
//   node packages/agent-org/src/settle-closed-rows.ts
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "@a11ign/toolchain/lib/cli-flags";
import { settleBoardRows, settleClosedStatus, boardReadRefusal, shortReadRefusal,
  closedRowsPageQuery, closedRowsPageFromRead, floorReadRefusal } from "./settle-closed-status.ts";
// The repository this pass reads, from the one place that names it.
import { REPO } from "./project-identity.ts";
// The token-carrying halves, imported HERE (an entry point) and injected, so the decision module stays
// pure -- #1009's rule, and the reason this command's Acceptance can run in the job with no token.
// `PROJECT_NUMBER` rides the import this file already makes: the floor's population read narrows to the
// Project from the ONE place that declares it, never from a literal here.
import { fetchBoardItems, PROJECT_NUMBER } from "./board-snapshot.ts";
// `EXIT` and `closeRowsExit` are the SAME contract both close paths take, imported rather than re-derived:
// "a second copy of that decision is the exact 'fact stated twice' shape this repo keeps paying for."
import { closeRowsExit, EXIT, LIVE_SETTLE_DEPS } from "./close-rows-for-merged-pr.ts";

export const LOG_PREFIX = "SETTLE-BOARD";

/**
 * #2719: THE SAFETY VALVE ON THE FLOOR'S CURSOR WALK -- NOT A POPULATION CAP, and the distinction is the
 * whole of this row. The search this replaced capped the POPULATION itself (GitHub refuses a search past
 * 1,000 results whatever `--limit` asks), so raising its number only moved the day it would fire again --
 * measured: it fired four days after being set at a number with "real headroom." `repository.issues` has
 * no such ceiling; this only bounds how many PAGES one run will walk before refusing rather than looping
 * forever on a page that never stops advancing. At 100 rows/page, 50 pages is 5,000 closed rows -- the
 * live population (measured 2026-09-27: 288 boarded closed rows) has to grow more than 17x before this
 * fires, and when it does the fix is to raise THIS number, never to reintroduce a search.
 */
const CLOSED_ROWS_MAX_PAGES = 50;

/** @param {string[]} args */
const gh = (args: string[]) => execFileSync("gh", args, { encoding: "utf8" }).trim();

/**
 * The floor's independent population: every CLOSED row GitHub itself reports as an item on THIS Project,
 * walked page by page over `repository.issues(states: CLOSED)` -- narrowed to this Project PER ISSUE,
 * because that connection carries no `project:` search qualifier -- rather than by a client-side guess at
 * what `projectItems` means. `gh api graphql`, never `gh pr list`: this pass's population must not depend
 * on any PR existing, which is the whole of #2081.
 *
 * `closedRowsPageQuery` and `closedRowsPageFromRead` are pure and carry the reasoning, the measurement and
 * the per-page contract; this function is the walk between them, and it is the only thing here that spends
 * a token.
 *
 * @param {(args: string[]) => string} [gh_]
 * @returns {number[]}
 */
export function closedRowsOnProject(gh_: (args: string[]) => string = gh): number[] {
  const [owner, name] = REPO.split("/");
  const numbers: number[] = [];
  let after: string | null = null;
  for (let page = 0; page < CLOSED_ROWS_MAX_PAGES; page++) {
    const raw = gh_(closedRowsPageQuery({ owner, name, after }));
    const result = closedRowsPageFromRead(raw, PROJECT_NUMBER);
    numbers.push(...result.numbers);
    if (!result.hasNextPage) return numbers;
    if (!result.endCursor || result.endCursor === after) {
      throw new Error("settle-closed-rows: the closed-row page said there was a next page but gave no "
        + "cursor to advance to -- refusing to guess whether the board read is complete.");
    }
    after = result.endCursor;
  }
  throw new Error(`settle-closed-rows: the closed-row read did not finish within ${CLOSED_ROWS_MAX_PAGES} `
    + `pages -- refusing to report a population that might still be paging. Raise CLOSED_ROWS_MAX_PAGES.`);
}

/**
 * The live settle for ONE row: the live mover, and the Status this pass ALREADY READ in place of a second
 * per-row read. `LIVE_SETTLE_DEPS.currentStatus` is `scopedStatus`, one `gh` request per row -- which is
 * exactly the read the board sweep above has already made for every row at once, so answering from it is
 * #1360's own instruction ("answers from data the caller ALREADY HOLDS ... never from a new read per
 * row"), not a weakening of it.
 * @param {number} n @param {string | null} heldStatus
 * @returns {import("./settle-closed-status.ts").SettleOutcome}
 */
function settleOne(n: number, heldStatus: string | null): import("./settle-closed-status.ts").SettleOutcome {
  return settleClosedStatus(n, { ...LIVE_SETTLE_DEPS, currentStatus: () => heldStatus, prefix: LOG_PREFIX });
}

function main() {
  refuseUnknownFlags([], { entry: import.meta.url, command: "node packages/agent-org/src/settle-closed-rows.ts" });

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

  // SEPARATE FROM THE BOARD READ, because they fail differently and one of them must stay loud --
  // `floorReadRefusal`'s header carries the reasoning and the test that holds it.
  let boardedClosedRows;
  try {
    boardedClosedRows = closedRowsOnProject();
  } catch (cause) {
    const { line } = floorReadRefusal(cause instanceof Error ? cause.message : String(cause));
    console.error(line);
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

// The entry guard `merge-guard.ts`/`close-rows-for-merged-pr.ts` use.
if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
