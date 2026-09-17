// PURE. No `gh`, no network, no `execFileSync` -- and that is the point rather than a style.
//
// #1219: the classification below could have lived beside `readyRowsMissingStatus` in
// `board-snapshot.mjs`, which is where its sibling is. It does not, because that file's import closure
// carries a `token` requirement (`fetchReadyIssueNumbers` shells out to `gh`), and a test importing it
// inherits that requirement whether or not it calls anything -- so the row's own acceptance command
// would be REFUSED by `pr-open` in the job that runs acceptance commands, which has no token.
//
// That is #1009's lesson applied before the refusal rather than after it: the fix is PLACEMENT, not
// weakening. The classifier is pure and lives where a pure test can reach it; `board-snapshot.mjs`
// imports it and supplies the items it fetched.

/**
 * A board item, typed to what the PRODUCER actually emits rather than to what this file finds
 * convenient. `tsc` caught the narrower version: `board-snapshot.mjs` can return `number: null` and
 * `state: null` for a draft item, and a type here that forbade them would have made the two modules'
 * `BoardItem`s structurally incompatible -- two copies of one type, disagreeing.
 *
 * The nulls are real and the classifier already handles them: a row with no state is an offender in
 * neither direction, which is what the third clause of the test asserts.
 *
 * @typedef {{ number: number | null, state: string | null, status: string | null }} BoardItem
 */

/**
 * #1219: A CLOSED ROW MUST NOT ADVERTISE LIVE WORK, AND AN OPEN ROW MUST NOT ADVERTISE DONE.
 *
 * Measured 2026-09-13 across 444 items: **220 closed rows at `In progress`, 45 at `Ready`, 69 at
 * `Done`** — so `Done` is the exception rather than the resting state, and the board's most populated
 * live column is entirely finished work. A session reading the board to find work reads 220 rows that
 * are done.
 *
 * **BOTH DIRECTIONS, AS TWO DIFFERENT FAILURES.** The health check this replaces asked `label -> Status`
 * and never `Status -> label`, so it reported clean while every row disagreed in the direction it did
 * not test. A one-directional pin is satisfied by whichever half you did not look at — the same shape
 * #1193 found in a manifest six hours earlier, in the instrument that was watching for it.
 *
 * @param {BoardItem[]} items
 * @param {{ done?: string, live?: string[] }} [vocabulary] the Status names, injected so this file
 *   states no board's column names as fact -- a renamed column must fail LOUDLY at the caller, not
 *   silently reclassify every row here.
 * @returns {{ closedButLive: BoardItem[], openButDone: BoardItem[], closedUnboarded: BoardItem[] }}
 */
export function statusContradictions(items, { done = "Done", live = undefined } = {}) {
  const closedButLive = items.filter((i) =>
    i.state === "CLOSED" && i.status !== null && i.status !== done
    && (live === undefined || live.includes(i.status)));
  const openButDone = items.filter((i) => i.state === "OPEN" && i.status === done);
  // #1228: A THIRD OUTCOME, never folded into either. `i.status !== null` above is right for the
  // OFFENDER question -- a row nobody boarded is not the same defect as one boarded at the wrong column
  // -- but "not that defect" became "not reported at all": during #1224 three such rows existed while
  // this reported 41, and the truth was 44. Two sessions predicted 44 and 41 from one board and both
  // were right about different questions.
  //
  // SEPARATE BECAUSE THE REMEDIES DIFFER. A row at a live Status needs its Status corrected; a row with
  // none needs BOARDING, or a decision that it should not be on the board at all. One list with two
  // remedies is the exemption-table-as-a-list defect, so this is a third list rather than a wider filter.
  const closedUnboarded = items.filter((i) => i.state === "CLOSED" && i.status === null);
  return { closedButLive, openButDone, closedUnboarded };
}

/**
 * The census, as text, printed whatever the verdict.
 *
 * **"No row contradicts" and "no row was examined" are the same empty result** — a query that returned
 * nothing and a board that is clean are indistinguishable from the offender list alone. This is what
 * makes that distinction visible, and it is why clause 4 asks for it before the assertion rather than
 * in the failure message.
 *
 * @param {BoardItem[]} items @returns {string}
 */
export function statusCensus(items) {
  const byPair = new Map();
  for (const i of items) {
    const key = `${i.status ?? "(none)"} / ${i.state}`;
    byPair.set(key, (byPair.get(key) ?? 0) + 1);
  }
  const rows = [...byPair.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `  ${String(n).padStart(4)}  ${k}`);
  return `board census: ${items.length} item(s) examined\n${rows.join("\n")}`;
}
