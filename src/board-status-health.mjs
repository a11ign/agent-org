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
 * #1996: THE RESTING STATUS, NAMED ONCE.
 *
 * `settleClosedStatus` wrote the literal `"Done"` and `statusContradictions` defaulted to the same
 * literal, so the two AGREED WITH EACH OTHER about a name the board did not have. Measured 2026-09-22 on
 * the org Project: the `Status` field offered Backlog / Ready / In progress / Blocked / Fleet-gated and
 * no `Done`, so every closed row's Status move had been refused since the board moved to the org, and
 * 121 closed rows sat at a live Status. The suite was green throughout, because every `"Done"` in it was
 * the code agreeing with itself.
 *
 * One copy is what makes `vocabularyDrift` able to check it: a name spelled in two files is a name no
 * check can hold.
 */
export const RESTING_STATUS = "Done";

/**
 * EVERY STATUS NAME THIS CODEBASE WRITES -- the population `vocabularyDrift` checks the live board against.
 *
 * NOT "every name the board offers". `Blocked` and `Fleet-gated` are set by hand, and a board that
 * stopped offering them would break no code path here. A name in THIS list is one some writer will try to
 * send, so a board that does not offer it turns that write into a refusal -- which is exactly how #1996
 * went unnoticed.
 *
 * `board-status-health.test.ts` DERIVES the same set from the writers' own source and fails if the two
 * disagree, so a fifth writer cannot appear without this list learning about it.
 */
export const WRITTEN_STATUSES = Object.freeze([
  "Backlog", // row-file.mjs `boardingFor` -- a row filed without `--ready`
  "Ready", // row-file.mjs `boardingFor`, and row-claim.mjs's promotion
  "In progress", // row-claim.mjs, on claim
  RESTING_STATUS, // settle-closed-status.mjs, on close
]);

/**
 * #1996: WHICH NAMES THIS CODE WRITES THAT THE LIVE BOARD DOES NOT OFFER.
 *
 * PURE, and handed the option names rather than reading them, for this file's stated reason: a `gh` call
 * here would put a token requirement into every test that imports the classifier. `board-snapshot.mjs`
 * makes the read -- in the query it already sends, so the check costs no extra call -- and calls this.
 *
 * ONE DIRECTION ONLY, deliberately. A name the board offers and nothing writes (`Blocked`,
 * `Fleet-gated`) is not a defect and reporting it would bury the one that is under permanent noise.
 *
 * @param {string[]} offered the live `Status` option names, in the board's own order
 * @param {{ written?: readonly string[] }} [vocabulary]
 * @returns {{ missing: string[] }} the written names the board cannot accept, in `written` order
 */
export function vocabularyDrift(offered, { written = WRITTEN_STATUSES } = {}) {
  if (!Array.isArray(offered)) {
    // A failed read must not wear the drift's clothes: `null` here would report every written name as
    // missing, which reads as "the board lost its whole vocabulary" when it means "nobody asked it".
    throw new TypeError("board-status-health: vocabularyDrift needs the live option names as an array -- "
      + `got ${offered === null ? "null" : typeof offered}. A read that failed is not a board that drifted (#1996).`);
  }
  return { missing: written.filter((name) => !offered.includes(name)) };
}

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
 *   silently reclassify every row here. #1996: the default is `RESTING_STATUS` rather than a second
 *   `"Done"` literal, so the name this classifies by and the name the settle path WRITES cannot drift
 *   apart -- which is what let both agree on a name the board did not offer.
 * @returns {{ closedButLive: BoardItem[], openButDone: BoardItem[], closedUnboarded: BoardItem[] }}
 */
export function statusContradictions(items, { done = RESTING_STATUS, live = undefined } = {}) {
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
