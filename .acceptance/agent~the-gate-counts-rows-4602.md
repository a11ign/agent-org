The gate counts rows shelved per holder and minutes: 5 rows for 30 minutes is a ledger incident that wakes the holder, and the daily pass names the top blocker (a11ign/a11ign#4602, fix 3 of 4 for the lock-gridlock class, epic #4437).

- `src/blocking-impact.ts` (new, pure core): `holdingsOf` sums a tick's `partitionUnclaimed(...).blocked` per holder (the `session:` label on the row or pull request a B4 reason names), `advance` carries the previous tick's record and raises an incident at `BLOCKING_MIN_ROWS = 5` rows for `BLOCKING_MIN_MINUTES = 30` minutes, once per holder per episode; `topBlocker` is the holder with the most row-minutes in 24 hours. `blockingImpactTick` is the one effectful call: it writes `blocking-impact.json`, records `lock-gridlock` with `recordFailure`, comments on the held row, and returns the holder's wake order (`you are blocking N rows; land, split or release`, rows listed).
- `src/blocking-impact.test.ts` (new, 20 tests): the boundary (5 rows at 29 minutes does not fire and at 31 does; 4 rows at 31 does not), one incident per episode and a second for a second episode, a gap in ticks ending the episode, the wake text, the two-holder top blocker, the 24-hour window, the report line, and the tick's effects through seams.
- `src/org-retro.ts`: the daily report prints a `Top blocker` line (`unknown` for a record that could not be read, never "nothing was shelved").
- `src/work-gate.ts`: `partitionUnclaimed` is computed once and its `blocked` list feeds both `reportWithheld` and `blockingImpactOrders`, the one call site.

Outside-Region: `.changeset/the-gate-counts-rows-shelved-per-holder.md`, the changeset every change here carries.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/blocking-impact.test.ts
```

Closes: a11ign/a11ign#4602

Verified (measured in this worktree, `AGENT_ORG_HOST=/home/agent/repos/wt-4602/.agent-org/host.json`): `blocking-impact.test.ts` 20 pass; with `src/org-retro*`, `src/work-gate*`, `src/failure*`, `src/cause*` 498 tests in 37 files pass. The full `rstest run` reads 34 failing of 7596 before the last fix and 33 after; the same 33 fail on a clean `origin/main` worktree (`src/packaging/*` and `src/board-truth-audit.test.ts`, run there and compared by file). `tsc --noEmit`: only the two existing `src/packaging/mjs-ratchet.test.ts` errors. agent-org has no lint script.

Live reading (a read-only script that calls `readPrs`, `readReadyRows`, `readLanesAfterOutageCheck`, `partitionUnclaimed` and the new `holdingsOf`; it writes nothing and is not the tick): 30 ready rows, 2 shelved, one behind a holder: `blocking-impact: worker-4601 shelves 1 rows behind #4601: #516` (#516 shelved by #527, which closes #4601). Below the threshold, so no incident. The real `work:tick` was NOT run from this worktree: the gate has no dry-run mode and would perform its actions.

Mutation: thirteen single-line mutations of `blocking-impact.ts`, one at a time against `blocking-impact.test.ts`, each file restored byte-identical (`cp` before, `diff` after): never fires (8 tests red), ignores minutes (5), minutes off by one (2), fires every tick (6), row floor of 1 (3), row floor of 6 (9), gap never breaks the episode (1), episodes never carry (8), top blocker ascending (1), ledger not written (2), same ledger ref for every episode (1), row comment never written (2), and samples never pruned, which SURVIVED the first twelve and is why the 24-hour retention test was added; with it that mutant fails 1 test.

platform: checked whether GitHub, systemd or git count B4 shelvings per holder over time; none does. The existing `failure-ledger` and `recordFailure` carry the event, `partitionUnclaimed`'s own `blocked` list is the input (no new read), and the wake reuses the existing `ready-row-unclaimable` cause rather than adding one to the closed vocabulary.

Caveats, not hidden: (1) `lock-gridlock` is not in `FAILURE_KINDS`, whose test pins the six first-move kinds; `class-repeat` reads any ledger key, but no `failure-classes.json` entry names it, so a repeat of it has no declared class to attach to. (2) A shelving whose reason names a row or pull request with no `session:` label is counted as unattributed in the log line, not as a holder. (3) A tick gap above 10 minutes ends an episode, so a long outage restarts the 30-minute clock.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
