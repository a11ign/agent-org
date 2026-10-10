The verify row is filed by the path a normal merge takes, and for a live-check item (a11ign/agent-org#719, a11ign#4627, class closed-on-merge-not-outcome). Before, `fileVerifyRowsFor` had one caller, on the manual-dispatch path; `trunk.yml` runs `close-rows-sweep` on every push, which never filed one, so no `<!-- verify-row: build #N -->` row existed 21 hours and about 60 merged rows after `8059ad40`.

Closes a11ign/agent-org#719

## What changes, and why

- **`src/close-rows-sweep.ts`.** `closeOnePr` calls `fileVerifyRowsFor` for the rows it closed and the rows it found closed, the same function and marker the dispatch path uses. The build rows come off the lookup that already ran (`title body milestone parent` added to the one GraphQL query), so there is no second read per row. A PR whose `mergedAt` was not read says `NOT CHECKED`, never "has none". A verify row that could not be filed is returned as `lost`, only when non-empty (the existing `deepEqual` on the result in `src/packaging/close-rows-sweep.test.ts` is untouched), and `sweepExit` turns a DONE into `COULD_NOT_CLOSE` with a line, as the dispatch path does. Lines are `SWEEP: VERIFY-ROW: ...`.
- **`src/unsplit-done-when.ts`.** `liveCheckItems`: a quoted record on a row, a switch read on, `is live`, a log line after the merge, a published version, `in production`. It is NOT a fourth refusal (`unfinishableItems` and `row-file` are unchanged); an item that is `future-time`, `seat-act` or `row-outcome`, a record quoted on the build's own row, and anything inside quotes or backticks are not returned.
- **`src/verify-row.ts`.** A reading is `future-time` or `live-check`; one verify row carries every reading of its build in the order written (it carried the first only) with `Not-before:` the latest of their waits. `declinedItems` names a `seat-act` or `row-outcome` item beside the outcome.
- **`src/close-rows-for-merged-pr.ts`.** `verifyOutcomeLine` says `NONE FILED -- Not taken: "<item>" (a seat's act: ...)` instead of printing nothing for a build with such an item, and the dispatch path prefixes the lines `CLOSE-ROWS:`.
- **Tests.** New `src/close-rows-sweep.test.ts` (8, through `closeOnePr`, plus a walk that fails if a file closing a row from a merge does not call `fileVerifyRowsFor`); 4 added to `src/unsplit-done-when.test.ts`; 5 to `src/verify-row.test.ts`.
- **`.changeset/the-verify-row-is-filed-on-every-closing-path-719.md`.** A patch.

## How you verified it

```
$ AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json node --import tsx --test src/verify-row.test.ts src/unsplit-done-when.test.ts src/close-rows-sweep.test.ts
tests 33, pass 33, fail 0
$ the same plus src/packaging/{close-rows-sweep,trunk-sweep,settle-closed-status,closed-row-ends-instance}.test.ts src/close-rows-full-form.test.ts src/board-truth-audit.test.ts
tests 167, pass 167, fail 0
$ npx tsc --noEmit -p tsconfig.json     # only the two pre-existing mjs-ratchet.test.ts errors
```

Failing before: the three new/extended test files run against the base commit's sources: 12 of 24 red (the new cases), 0 red after.

Acceptance: `AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json node --import tsx --test src/verify-row.test.ts src/unsplit-done-when.test.ts src/close-rows-sweep.test.ts`

Mutation: each file copied aside, one change at a time, restored from the copy and compared byte-identical. Red counts are of the three files, measured: the sweep never files (call removed) -> 5 red; the sweep's `lost` dropped -> 1; the already-closed rows skipped -> 2; `sweepExit` ignores `lost` -> 1; `liveCheckItems` never fires -> 9; always fires -> 12; seat-act and row-outcome not excluded from it -> 1; declined items never named -> 3; the call site's identifier deleted so the walk finds no `fileVerifyRowsFor(` -> 7 (including the walk). A stray `["issue", "close"` file in `src/` turns the walk red and is removed.

## Anything a reviewer should be sceptical of

- **The patterns are deliberately narrow.** A false negative is caught by the reopen rule; a false positive files a row nobody can finish. Done-when 1 of this very row quotes `"one record per use is quoted on #4627"` and describes its verify row, and files nothing (a test pins it).
- **`src/packaging/live-tree-independence.test.ts` and 8 tests in `row-file*.test.ts` fail** at the base commit and with this change alike (measured on a clean worktree of `HEAD`); not touched.
- **The sweep re-reads the verify row's marker on every push for every already-closed build with a reading in the 60-minute window** (one `gh issue list` search per such row). Rows with no reading make no call.
- **The refusal at `pr:open` for `Closes: none` on a post-merge item is agent-org#744**, not here.
