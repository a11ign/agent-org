// #1227: PURE OF `gh`, and that is placement rather than style.
//
// `moveProjectStatus` lives in `row-claim.mjs`, whose closure carries a `token`. Importing it here would
// give every test that reaches this file a token requirement -- and `close-rows-on-merge.test.ts`
// already has one, so the row's named acceptance command could never run in the job that runs acceptance
// commands. #1009 records the rule: the fix is PLACEMENT, not weakening. `moveStatus` is injected and
// the entry points supply it.

export const PROJECT_UNREADABLE = "project-unreadable";

/** @typedef {{ row: number, cause: "project-unreadable" | "other", message: string }} Refusal */
/** @typedef {{ settled: boolean, refused: Refusal[] }} SettleOutcome */

/**
 * WHY A MOVE WAS REFUSED, CLASSIFIED WHERE THE REFUSAL IS MADE -- never re-read from log text at the exit.
 *
 * `project-unreadable` is GitHub's `NOT_FOUND` for the Project itself: CI's token cannot read the user-owned
 * Project until the transfer (#546), so every move in CI is refused with it (trunk run 34769927592, `02ae7420`,
 * four rows, one message). Anchored on the GraphQL error's own shape, `NOT_FOUND (<owner>.projectV2)`, so a
 * NOT_FOUND for anything else -- a repository, an item -- stays `other`.
 * @param {string} message the refusal's reason, as `moveProjectStatus` reported it
 * @returns {Refusal["cause"]}
 */
export function refusalCause(message) {
  return /NOT_FOUND \(\w+\.projectV2\): Could not resolve to a ProjectV2 with the number \d+/.test(message)
    ? PROJECT_UNREADABLE : "other";
}

/**
 * THE BRIDGE'S WHOLE DECISION, PURE: a run is DEGRADED -- not failed -- only when it has refusals and EVERY one
 * is `project-unreadable`. `other` names the refusals that still fail the run; empty refusals are neither.
 * @param {Refusal[]} unsettled
 * @returns {{ degraded: boolean, other: Refusal[] }}
 */
export function unsettledVerdict(unsettled) {
  const other = unsettled.filter((r) => r.cause !== PROJECT_UNREADABLE);
  return { degraded: unsettled.length > 0 && other.length === 0, other };
}

/**
 * #1227: MOVES A CLOSED ROW'S PROJECT STATUS TO `Done`, IN THE SAME ACT AS THE CLOSE.
 *
 * `row-claim` writes `In progress` on claim and nothing wrote the resting state, so the board refilled
 * with closed rows at a live Status **at the rate the org closes rows** -- measured during #1223/#1224 at
 * roughly one per twenty minutes. Two backfills cleared 316; neither closed the loop, because **a guard
 * that detects and a write that prevents are different things.**
 *
 * NEVER THROWS and never affects the close's outcome, the same trade `stripClaimLabels` makes: a row that
 * closed with a stale Status is strictly better than one left open because a board write failed.
 *
 * THE THREE OUTCOMES ARE DISTINCT, per ceo's 2026-09-08 ruling on `moveProjectStatus` itself: "'could not
 * ask' and 'asked and wrote' must not look the same, and a half-applied claim is worse than none."
 *
 * #1360: A ROW ALREADY AT `Done` ISSUES NO MOVE. Measured 2026-09-13 15:23Z: one sweep re-wrote Done for #1298,
 * #1292 and #1271, each already Done, and the account's GraphQL pool hit zero that afternoon. `currentStatus`
 * answers from data the caller ALREADY HOLDS -- the process's board snapshot -- never from a new read per row,
 * which would spend the same budget the skip exists to save. It is injected, like `moveStatus`, because the
 * snapshot's module carries a token into any test that imports it (`board-snapshot.mjs`'s own header).
 * `null` means "not known", and an unknown Status is moved exactly as before: skipping on a guess would leave
 * a closed row at a live Status, which is the defect #1227 exists to prevent.
 *
 * @param {number} n
 * @param {{ moveStatus: (n: number, status: string) =>
 *   ({ moved: true } | { moved: false, reason: string, notOnBoard: boolean }),
 *   currentStatus?: (n: number) => string | null,
 *   log?: (line: string) => void }} deps
 * @returns {SettleOutcome} `settled` is whether the row's Status is SETTLED -- moved, or not on the board so
 *   there is none to move -- and `refused` is empty then. A refused move carries its classified refusal there: a caller that discards it reports a
 *   repair that did not happen (both close-rows paths exited 0 with no Status moved until #1299), and a caller
 *   that cannot see its cause fails every CI run on a token that cannot read the Project.
 */
export function settleClosedStatus(n, { moveStatus, currentStatus = () => null, log = console.log }) {
  /** @type {string | null} */
  let status;
  try {
    status = currentStatus(n);
  } catch (error) {
    // #1360, `ceo`'s ruling: a Status read that fails REFUSES with its cause, and the move never reads again. In CI
    // the Project is unreadable until #546, so letting the move try would spend a second failed read per row.
    const reason = `could not read #${n}'s Status before moving it to "Done" -- ${/** @type {Error} */ (error).message}`;
    log(`CLOSE-ROWS: #${n} CLOSED but Status NOT moved -- ${reason}`);
    return { settled: false, refused: [{ row: n, cause: refusalCause(reason), message: reason }] };
  }
  if (status === "Done") {
    log(`CLOSE-ROWS: #${n} Status is already Done -- no move.`);
    return { settled: true, refused: [] };
  }
  const result = moveStatus(n, "Done");
  if (result.moved) {
    log(`CLOSE-ROWS: #${n} Status -> Done.`);
    return { settled: true, refused: [] };
  }
  if (result.notOnBoard) {
    log(`CLOSE-ROWS: #${n} is not on the Project -- no Status to move.`);
    return { settled: true, refused: [] };
  }
  log(`CLOSE-ROWS: #${n} CLOSED but Status NOT moved -- ${result.reason}`);
  return { settled: false, refused: [{ row: n, cause: refusalCause(result.reason), message: result.reason }] };
}
