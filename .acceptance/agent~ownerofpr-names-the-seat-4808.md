`ownerOfPr` names `product-manager` (`owner-gone`) for a pull request whose label names an ENDED session and whose named rows nobody holds, whether they are CLOSED (a11ign#4626, #4644) or OPEN and UNCLAIMED (a11ign#4805). `withClosingRowOwners` sets a new `closingRowsUnheld` beside `closingRowsClosed` (an open row is not "closed", and the order's words say which: "the row it closed is closed" / "the row it closes is open and no session holds it"). Unchanged: a label that stands, a row held by a live session, a split, a PR with no label (still `ceo` and still recorded), an empty rows read, a PR naming no row, and `dependency-bot` outranking the rung.

Acceptance: `AGENT_ORG_HOST=/home/agent/repos/role-product-manager/.agent-org/host.json node --test src/packaging/pr-owner-gone.test.ts src/packaging/pr-owner-total.test.ts`

Class: owner-unresolved (a repeat; the fifth ledger entry, a11ign#4805). Closes the open-and-unclaimed half that #4644 left as a pinned control.

Mutation: four, each restored byte-identical (`diff` against a copy taken before). (1) `closingRowsUnheld` never set: 5 tests failed (the #4805 shape, the unclaimed-variants test, the wording test and both grids). (2) the empty-rows guard removed: 1 failed (the empty-rows control). (3) the names-no-row guard removed: 3 failed (the same control and both grids). (4) the rung fired without `labelEnded`: 4 failed (no-label control, both grids, the live-session-holding-no-claim test).

Measured: 21 tests across the two files pass at agent-org `df7a527b` plus this change (18 before, 3 new). `tsc --noEmit` reports nothing in `pr-owners`, `pr-orders` or the two tests (its two errors are in `mjs-ratchet.test.ts`, which this change does not touch).

Closes a11ign/a11ign#4808
