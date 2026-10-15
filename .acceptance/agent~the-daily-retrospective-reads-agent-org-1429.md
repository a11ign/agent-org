The daily retrospective reads the Claude allowance's pause from `account-limit.ndjson` (the log `account-limit.ts` appends an `enter` and a `leave` to). `pausedIntervals` turns the log into the intervals the pause held, clipped to the window; a pause with no `leave` runs to the window's end; a log that cannot be read, or a line that does not parse, is UNKNOWN (`null`), never "not paused". `readAccountLimitLog` reads the file (no file is "not paused", a directory at its path is unknown). The report prints one pause line first: `Claude work paused 22h51m of 24h (start to end)`, `Claude work pause: not paused`, or `Claude work pause: unknown`. `idleStats` leaves out the ticks that started inside the pause, and its idle line says how many minutes were excluded. A `worse` read on a day the pause covered more than half of, in either the window or the one before it, reads `paused` (`compareReadings`); an unknown pause changes no verdict.

Not in this change, and routed: `idleClaimedHours` still counts the paused hours in each claim's idle span, because that span is computed in `src/idle-claim-incident.ts`, outside this row's Region; the closing paragraph that says a `paused` number is not a class to file is pinned to `.agent-org/roles/ceo.md`, also outside the Region. Both are named on the row.

Acceptance: `node --test src/org-retro-account-pause.test.ts` (11 tests, run in the worktree; the row names `cd ~/repos/agent-org`, the primary checkout, so the run is here instead).

Mutation: the verdict never made `paused` (`direct === "worse" && false`) failed 1 of 11 (the verdict test); the pause never excluded from the idle ticks (`held` made always false) failed 2 of 11 (the positive control and the verdict test). `org-retro.ts` restored byte-identical each time (`diff` against a copy).

Measured: `ℹ tests 11 / ℹ pass 11 / ℹ fail 0` for the acceptance file; the existing retro files (`src/org-retro-*.test.ts`, `src/packaging/org-retro*.test.ts`, `src/packaging/dora-report.test.ts`, `src/packaging/hand-fix-reading-trust.test.ts`, `src/found-by-chairman-daily.test.ts`, `src/wakes-per-row.test.ts`, `src/packaging/wake-capacity-deferral.test.ts`) pass. `pnpm run typecheck` exits 0 with no errors. The full `pnpm test` fails 112 of 11653 tests in 702 files, the same 112 names as origin/main (11645 tests, 701 files, the same failures): the failures are in the work-gate, PR-owner and org-health tests and predate this change. The real `~/.cache/a11ign/account-limit.ndjson` read through the new reader gives `paused 22h51m of 24h`.

Closes: none -- first half of agent-org#1429: the pause line, the idle exclusion and the `paused` verdict land here; the claimed-hours span and the ceo.md closing paragraph are the second half, named on the row.

platform: the pause is read from the state directory's own log, so nothing here reaches GitHub; the retrospective's other reads are unchanged.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
