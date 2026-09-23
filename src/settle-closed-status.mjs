// #1227: PURE OF `gh`, and that is placement rather than style.
//
// `moveProjectStatus` lives in `row-claim.mjs`, whose closure carries a `token`. Importing it here would
// give every test that reaches this file a token requirement -- and `close-rows-on-merge.test.ts`
// already has one, so the row's named acceptance command could never run in the job that runs acceptance
// commands. #1009 records the rule: the fix is PLACEMENT, not weakening. `moveStatus` is injected and
// the entry points supply it.

// #1996: the resting state's name comes from ONE place, and that place is pure -- so importing it here
// adds no `gh` to this file's closure and keeps the header's rule intact. The literal used to be spelled
// here AND defaulted in `statusContradictions`, and the two agreed about a name the board did not offer.
// #2081: `statusContradictions` comes from the same pure module, for the same reason -- the board-keyed
// population below is the one that classifier already names, and a second filter over `state`/`status`
// here would be the third copy of a rule this repo has already paid to consolidate twice.
import { RESTING_STATUS, statusContradictions } from "./board-status-health.mjs";

export const PROJECT_UNREADABLE = "project-unreadable";

/** @typedef {{ row: number, cause: "project-unreadable" | "other", message: string }} Refusal */
/** @typedef {{ settled: boolean, refused: Refusal[] }} SettleOutcome */
/** @typedef {import("./board-status-health.mjs").BoardItem} BoardItem */
/** @typedef {{ number: number, status: string | null }} SettleableRow */

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
 * #2081: `prefix` NAMES WHICH PATH DID THE WORK, and defaults to the one both close paths have always
 * logged. `close-rows-sweep.mjs`'s own header states the rule -- "which path did the work is a fact about
 * the pipeline's health" -- and this line was the one place it could not be honoured: the sweep prints
 * `SWEEP:` for everything it decides and `CLOSE-ROWS:` for everything settled here. The board-keyed pass
 * (`settle-closed-rows.mjs`) is a third path, and a log that cannot tell it from a merge's settle cannot
 * answer whether the board pass is now doing all the work.
 *
 * @param {number} n
 * @param {{ moveStatus: (n: number, status: string) =>
 *   ({ moved: true } | { moved: false, reason: string, notOnBoard: boolean }),
 *   currentStatus?: (n: number) => string | null,
 *   prefix?: string,
 *   log?: (line: string) => void }} deps
 * @returns {SettleOutcome} `settled` is whether the row's Status is SETTLED -- moved, or not on the board so
 *   there is none to move -- and `refused` is empty then. A refused move carries its classified refusal there: a caller that discards it reports a
 *   repair that did not happen (both close-rows paths exited 0 with no Status moved until #1299), and a caller
 *   that cannot see its cause fails every CI run on a token that cannot read the Project.
 */
export function settleClosedStatus(n, { moveStatus, currentStatus = () => null, log = console.log,
  prefix = "CLOSE-ROWS" }) {
  /** @type {string | null} */
  let status;
  try {
    status = currentStatus(n);
  } catch (error) {
    // #1360, `ceo`'s ruling: a Status read that fails REFUSES with its cause, and the move never reads again. In CI
    // the Project is unreadable until #546, so letting the move try would spend a second failed read per row.
    const reason = `could not read #${n}'s Status before moving it to "${RESTING_STATUS}" -- `
      + `${/** @type {Error} */ (error).message}`;
    log(`${prefix}: #${n} CLOSED but Status NOT moved -- ${reason}`);
    return { settled: false, refused: [{ row: n, cause: refusalCause(reason), message: reason }] };
  }
  if (status === RESTING_STATUS) {
    log(`${prefix}: #${n} Status is already ${RESTING_STATUS} -- no move.`);
    return { settled: true, refused: [] };
  }
  const result = moveStatus(n, RESTING_STATUS);
  if (result.moved) {
    log(`${prefix}: #${n} Status -> ${RESTING_STATUS}.`);
    return { settled: true, refused: [] };
  }
  if (result.notOnBoard) {
    log(`${prefix}: #${n} is not on the Project -- no Status to move.`);
    return { settled: true, refused: [] };
  }
  log(`${prefix}: #${n} CLOSED but Status NOT moved -- ${result.reason}`);
  return { settled: false, refused: [{ row: n, cause: refusalCause(result.reason), message: result.reason }] };
}

/**
 * #2081: THE POPULATION, KEYED ON THE BOARD RATHER THAN ON A MERGED PR.
 *
 * Both settle paths that existed before this one are keyed on **a merged PR inside a window**:
 * `close-rows-for-merged-pr.mjs` takes a PR number, and `close-rows-sweep.mjs` walks
 * `gh pr list --state merged` over its window. A row closed with `gh issue close` is in NEITHER
 * population, so nothing looks at its Status again -- not CI, not the sweep, not a session running the
 * sweep with any window at all. Measured 2026-09-23: of the 7 boarded rows still drifted after a
 * hand-run sweep, **5 had been closed by hand** (`closedByPullRequestsReferences` empty) and 2 by a PR
 * outside the window. #1978 sat at `Backlog` and #1976 at `Fleet-gated` -- closed rows advertising
 * themselves as pickable work.
 *
 * So this asks the BOARD: every item GitHub reports `CLOSED` whose Status is not the resting state. A
 * hand-closed row is in it by construction, and a CI merge whose settle was refused is picked up on the
 * next pass.
 *
 * **IT NEVER INFERS THAT A ROW SHOULD BE CLOSED.** The population is rows GitHub ALREADY reports closed;
 * `state` comes from the board read, and this changes a Status and nothing else.
 *
 * **THE TWO LISTS STAY APART, and #1228 is why.** A closed row AT a live Status and a closed row with NO
 * Status at all are different facts about the board -- one is finished work a session will take as
 * available, the other is invisible to any check that reads Statuses -- so they are counted separately
 * even though the write that repairs both is the same one. Folding them into a single filter would undo
 * exactly the split that row paid for.
 *
 * NOTHING WITHOUT AN ISSUE NUMBER IS EVER EMITTED. `board-snapshot.mjs` records a draft item -- one with
 * no linked issue -- as `number: null`, and `gh project item-edit --url` has no URL to name for it. Today
 * such an item is also `state: null`, so `statusContradictions` excludes it before this sees it; the
 * narrowing below is what makes that this function's own contract against its DECLARED input type, where
 * `number` and `state` are independently nullable, rather than an inherited property of one producer.
 *
 * @param {BoardItem[]} items the board, as the caller read it
 * @returns {{ atLiveStatus: SettleableRow[], withNoStatus: SettleableRow[] }}
 */
export function closedRowsToSettle(items) {
  const { closedButLive, closedUnboarded } = statusContradictions(items);
  const withIssueNumber = (/** @type {BoardItem[]} */ rows) => rows
    .filter((i) => typeof i.number === "number")
    .map((i) => ({ number: /** @type {number} */ (i.number), status: i.status }));
  return { atLiveStatus: withIssueNumber(closedButLive), withNoStatus: withIssueNumber(closedUnboarded) };
}

/**
 * #2081: SETTLE EVERY CLOSED ROW THE BOARD REPORTS AT SOMETHING OTHER THAN `Done` -- the whole pass, pure.
 *
 * `settle` is injected for the reason this file's header gives: the live one carries a `token`, and the
 * decision must be drivable by a test in the job that runs Acceptance commands. It takes the Status the
 * caller ALREADY HOLDS, because the board read that produced `items` is the same read `settleClosedStatus`
 * would otherwise make per row -- #1360's own header names that as the point of `currentStatus`.
 *
 * THE CENSUS IS PRINTED WHATEVER THE VERDICT, for `statusCensus`'s reason: "no closed row is drifted" and
 * "no item was examined" are the same empty result, and a pass that settled nothing must say which it was.
 *
 * @param {BoardItem[]} items
 * @param {{ settle: (n: number, heldStatus: string | null) => SettleOutcome,
 *   log?: (line: string) => void }} deps
 * @returns {{ attempted: number[], unsettled: Refusal[] }} every row a move was issued for, and the
 *   classified refusal for each one whose Status did not move
 */
export function settleBoardRows(items, { settle, log = console.log }) {
  const { atLiveStatus, withNoStatus } = closedRowsToSettle(items);
  log(`SETTLE-BOARD: ${items.length} board item(s) read -- ${atLiveStatus.length} CLOSED at a live Status, `
    + `${withNoStatus.length} CLOSED with no Status at all (#1228: counted apart, same repair).`);
  /** @type {number[]} */
  const attempted = [];
  /** @type {Refusal[]} */
  const unsettled = [];
  for (const { number, status } of [...atLiveStatus, ...withNoStatus]) {
    attempted.push(number);
    unsettled.push(...settle(number, status).refused);
  }
  return { attempted, unsettled };
}

/**
 * #2081: WHAT AN UNREADABLE BOARD MEANS FOR THIS PASS -- pure, and exported because a decision that lives
 * only in `main()` is one no test holds (`worker-capture`'s #1357 review, which found the dispatch path's
 * exit 3 revertible with the suite still green).
 *
 * **THE READ IS THE REFUSAL IN CI, not the move.** Where the other two paths reach `settleClosedStatus`
 * with a row in hand and are refused per row, this pass asks for the whole board FIRST, so CI's
 * unreadable Project (#546) stops it before any row exists to refuse. That must stay exit `0` with a
 * DEGRADED line for the same reason `closeRowsExit`'s bridge does: this command runs in both contexts,
 * and turning trunk red for a ceiling it cannot lift would make the repair's own arrival the outage.
 *
 * Classified by `refusalCause` -- the same classifier, on `fetchBoardItems`'s own thrown message, which
 * carries GraphQL's `NOT_FOUND (<owner>.projectV2)` verbatim (`board-snapshot.mjs` attaches it via
 * `graphqlErrorFromFailedRun`, #555).
 *
 * @param {string} message the message `fetchBoardItems` threw
 * @returns {{ degraded: boolean, line: string }} `degraded` is "stop, but do not fail the run"
 */
export function boardReadRefusal(message) {
  return refusalCause(message) === PROJECT_UNREADABLE
    ? { degraded: true, line: "SETTLE-BOARD: DEGRADED -- the board could not be read, so no Status was "
      + `examined: the token cannot read the Project (#546). ${message}` }
    : { degraded: false, line: `SETTLE-BOARD: CANNOT ASK -- the board could not be read: ${message}` };
}

/**
 * #2081: THIS PASS'S OWN COMPLETENESS FLOOR -- which CLOSED rows GitHub reports on the board did the
 * board read not come back with?
 *
 * **IT REPLACES AN INHERITED FLOOR RATHER THAN REMOVING ONE, and the reason is which population each one
 * watches.** `fetchBoardItems`'s #747 floor reads the item list against OPEN `ready` rows: a population
 * this pass never touches. Measured 2026-09-23 08:50-08:56Z, live: `projectV2.items` did not return
 * #2083, #2084 or #2086 -- each of which `issue.projectItems` reported as an item on Project 1 at that
 * same moment, and `items.totalCount` agreed with the SHORT list (220) rather than with the board. A row
 * filed minutes earlier is therefore missing from every full board read until GitHub's project index
 * catches up, so that floor refused three runs in a row and no operator action could satisfy it. A guard
 * that only a wait can clear, over rows the pass does not act on, stops being a floor and becomes an
 * outage -- `fetchBoardItems`'s own #1219 comment states the trade: "a refusal that blocks the repair
 * path is not a stricter guard, it is an absent one."
 *
 * So the floor is keyed on the population this pass DOES act on. A closed row was boarded when it was
 * filed, long before the index window this lag opens, so this is satisfiable in a way the inherited one
 * is not -- and it is the STRONGER check for this pass, because a read missing a closed row is a read
 * that would silently leave that row drifted while reporting the pass complete.
 *
 * @param {BoardItem[]} items the board, as the read returned it
 * @param {number[]} closedRowsOnBoard closed rows GitHub itself reports as items on this Project
 * @returns {string | null} the refusal, or `null` when the read accounts for every one of them
 */
export function shortReadRefusal(items, closedRowsOnBoard) {
  const seen = new Set(items.filter((i) => i.number !== null).map((i) => i.number));
  const missing = closedRowsOnBoard.filter((n) => !seen.has(n));
  if (missing.length === 0) return null;
  return `the board read came back without ${missing.length} CLOSED row(s) GitHub reports as items on `
    + `this Project -- refusing to settle from a partial read, which would report this pass complete `
    + `having never examined them: #${missing.join(", #")}`;
}

/**
 * #2081, ADDED ON REVIEW: THE FLOOR'S OWN POPULATION READ, AS THE ARGV `gh` IS GIVEN.
 *
 * **The first version of this floor sampled, and called the sample a population.** It asked for the 100
 * most recently closed issues and filtered them by `projectItems` being non-empty, then checked those ids
 * against the board read. `reviewer-2` (09:17Z) and `reviewer` (14:39Z) landed on it independently, five
 * and a half hours and one push apart: a boarded closed row ranked 101st or older is not in the sample, so
 * the pass reports a complete read over a row it never saw -- which is the defect the floor exists to
 * catch, arriving through the floor itself.
 *
 * **Measured 2026-09-23 15:2xZ, live, and it is not a corner:** `gh issue list --state closed --limit 100`
 * yielded **90** boarded rows reaching back to #1911, against **201** closed rows GitHub reports on this
 * Project. **111 of 201 -- 55% -- were outside the floor's population entirely**, the oldest being #21.
 *
 * So the read is now the population, and it is the SEARCH that narrows it rather than a client-side filter:
 *
 * - **`project:<owner>/<number>` is evaluated by GitHub**, which answers the second review point too. The
 *   old read asked for `--json number,projectItems`, whose entries carry no project number at all, so
 *   "has any project item" was the only membership question it could ask -- an item on some OTHER board
 *   made this floor refuse a read that was complete for this one. The qualifier discriminates: measured
 *   the same minute, `project:a11ign/99` returns `[]` where `project:a11ign/1` returns 201.
 * - **The whole population comes back, and an exactly-full page is refused** rather than reported as
 *   complete -- `fetchReadyIssueNumbers`'s contract, imported as a rule rather than as code, because the
 *   two reads share the shape ("returning exactly `limit` rows is indistinguishable from a truncated
 *   result"). At 201 against a limit of 500 there is real headroom, and "raise the limit" is a remedy an
 *   operator can take **up to GitHub's own 1,000-result search ceiling**; past that the read has to become
 *   a cursor walk of `repository.issues(states: CLOSED)`, and the refusal says so rather than leaving the
 *   next reader to discover the ceiling.
 * - **It is `gh issue list`, never `gh pr list`** -- this pass's population must not depend on any PR
 *   existing, which is the whole of #2081.
 *
 * The identity is passed in rather than imported because `board-snapshot-scope.mjs` -- the one place that
 * declares it -- already imports `refusalCause` from this file, and a cycle between two modules whose
 * headers are both about placement is a worse trade than one argument. `settle-closed-rows.mjs` supplies
 * it from that declaration, and the test pins this argv against the same constants.
 *
 * @param {{ repo: string, owner: string, number: number, limit: number }} project
 * @returns {string[]} the argv, so the qualifier that names the Project is asserted rather than described
 */
export function closedRowsQuery({ repo, owner, number, limit }) {
  return ["issue", "list", "--repo", repo, "--state", "closed",
    "--search", `project:${owner}/${number}`, "--limit", String(limit), "--json", "number"];
}

/**
 * #2081: `closedRowsQuery`'s response, parsed -- and REFUSED rather than trusted when it came back
 * exactly full, which is the truncation contract the reviews asked for.
 *
 * THROWS on every shape it does not recognise, `fetchReadyIssueNumbers`'s discipline and for its reason:
 * this list is the only thing that can tell a complete board read from a partial one, so a list this
 * function had to guess at would make the floor report clean over a population it never established.
 *
 * @param {string} raw `gh`'s stdout
 * @param {number} limit the `--limit` the read asked for -- exactly this many rows is a refusal
 * @returns {number[]}
 */
export function closedRowsFromRead(raw, limit) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`settle-closed-rows: gh's closed-row list was not JSON -- refusing to guess whether `
      + `the board read is complete. First 200 chars: ${raw.slice(0, 200)}`, { cause });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`settle-closed-rows: gh's closed-row list was not a list -- refusing to guess. `
      + `Got: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  if (parsed.length === limit) {
    throw new Error(`settle-closed-rows: gh returned exactly the requested limit (${limit}) of closed rows `
      + `on this Project -- indistinguishable from a truncated result, and a truncated population is one `
      + `this floor would report complete over the rows it did not see. Raise the limit; past GitHub's `
      + `1,000-result search ceiling, walk repository.issues(states: CLOSED) by cursor instead.`);
  }
  return parsed.map((/** @type {unknown} */ entry, /** @type {number} */ i) => {
    const number = /** @type {{ number?: unknown }} */ (entry)?.number;
    if (typeof number !== "number") {
      throw new Error(`settle-closed-rows: closed-row list entry ${i} has no number -- refusing to guess. `
        + `Got: ${JSON.stringify(entry).slice(0, 300)}`);
    }
    return number;
  });
}
