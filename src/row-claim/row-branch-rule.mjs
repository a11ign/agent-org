// @ts-check
// THE RULE: which branches on `origin` belong to a ROW, and what its number is. ONE COPY, TWO READERS.
//
// #2014 bought the interception at CLAIM time and defined the rule inside `row-claim.mjs`. #2031 needs
// the same question asked by `work-gate.mjs`, which is what actually OFFERS rows to the org -- and #2031's
// own filing says why it could not simply be re-written there: "both parse a trailing `-<n>` out of an
// `ls-remote` listing, and #2014's `rowBranchesOnOrigin` is the tested spelling ... a second, drifting
// copy of the same rule". `region-paths.mjs` states the same prohibition for "what counts as a path", and
// `work-gate.mjs`'s own B4 imports are this repo's precedent for honouring it: the gate imports the two
// functions `row-claim.mjs` runs at claim time rather than reimplementing them.
//
// LEAF BY CONSTRUCTION -- this file imports NOTHING. `work-gate.mjs`'s header states that it must run
// before any `npm ci` or build, and `pre-install-import-graph.test.ts` derives that population, so a rule
// the gate imports may not drag a module graph behind it.
//
// THE FAILURE POLICY IS DELIBERATELY NOT HERE, because the two callers differ and both are right.
// `row-claim.mjs` THROWS on a listing it could not get -- "could not ask origin" is not "the row has no
// branch", and a claim must refuse rather than write on a guess. `work-gate.mjs` degrades to "not asked"
// -- a tick that cannot reach origin must not invent a condition, and must not stop offering rows either.
// A shared rule that picked one would have forced the other caller to unpick it.

/**
 * The listing this rule parses. `git ls-remote --heads origin` SPENDS NO GraphQL and is not an API call
 * at all, which is the entire reason this detection can exist: the board goes stale precisely when the
 * pool is exhausted and no pull request could be opened, so a detector that spent the pool would be blind
 * in the same outage that produces the defect (#2014, #2031).
 * @type {readonly string[]}
 */
export const LS_REMOTE_ARGS = Object.freeze(["ls-remote", "--heads", "origin"]);

/**
 * PURE. Every head in an `ls-remote --heads` listing whose name ends `-<digits>`, with the row number
 * that trailing group names.
 *
 * A TRAILING NUMBER IS A CLAIM ABOUT THE ROW, NOT A PROOF. `agent/<slug>-<n>` is this repo's branch
 * convention and the only machine-readable link between a branch and a row that costs nothing to read;
 * a branch whose name merely ends in a number that happens to match is a coincidence this rule cannot
 * tell from the real thing, and both callers say so in their own words rather than pretending otherwise.
 *
 * @param {string} listing raw stdout of `git ls-remote --heads origin`
 * @returns {{ branch: string, head: string, row: number }[]}
 */
export function rowBranchesInListing(listing) {
  return String(listing ?? "").split("\n").flatMap((line) => {
    const match = /^(\S+)\s+refs\/heads\/(\S+)$/.exec(line.trim());
    const trailing = match && /-(\d+)$/.exec(match[2]);
    return trailing ? [{ branch: match[2], head: match[1], row: Number(trailing[1]) }] : [];
  });
}

/**
 * PURE. The branches in that listing that belong to ONE row -- #2014's shape, unchanged, and the shape
 * `row-claim.test.ts` already pins.
 * @param {string} listing @param {number} issueNumber
 * @returns {{ branch: string, head: string }[]}
 */
export function branchesForRow(listing, issueNumber) {
  return rowBranchesInListing(listing)
    .filter((b) => b.row === issueNumber)
    .map(({ branch, head }) => ({ branch, head }));
}
