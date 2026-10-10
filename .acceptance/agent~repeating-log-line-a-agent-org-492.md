`repeating-log-line` does not wake `orchestrator` for a line an open row already cites (a11ign/agent-org#492, Phase 1 of a11ign/a11ign#4505). `repeatingLinesTick` gained an optional `settle(groups)` hook (`src/repeating-lines.ts`, outside the declared Region, see below); `settleCitedRepeatingLines` in `src/work-gate.ts` is what the gate passes. Before an order is made, each group's headline is normalised and its first 80 characters are looked for in the rows the tick already read (no new read to find candidates); up to 3 candidates are re-read through the ticket port (`readItem`) and a cite counts only when that answer is open and still carries the line. A cited group makes no order, and its count is written to the row as one `postDecision` (`kind: repeating-line-count`) at 30, 60, 120 ... consecutive ticks. Every doubt is a wake: a `null` read, a closed row, a body without the line, a needle under 30 characters, a throwing lookup (the detector catches it and offers every line).

Acceptance: `bash -c 'cd /home/agent/repos/wt-agent-org-492 && AGENT_ORG_HOST=/home/agent/repos/wt-4788/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/work-gate-repeating-log-line-port.test.ts'`

Mutation: (each restored with `cp` from a copy, `diff` clean) the switch check removed failed 1 of 10 (the negative control); suppression never firing failed 6 of 10; the cite re-verification removed failed 1; the closed-row check removed failed 1; the milestone made always-true failed 1 (a write at 31); the milestone made always-false failed 5; a too-short needle allowed to suppress failed 1. One mutation survived and is equivalent: removing the `item === null` guard passes, because the null dereference throws inside `settle`, which `repeatingLinesTick` catches and answers by offering every line, so the outcome is still a wake.

Measured: `VERDICT pass: 10 tests in 1 file` for the acceptance file; with `src/packaging/repeating-lines.test.ts` and `src/packaging/work-gate.test.ts` `pass: 454 tests in 3 files`, both unchanged. `tsc --noEmit` shows only the two existing `mjs-ratchet.test.ts` errors. Full suite: `fail: 35 of 8609 tests failed in 476 files`; the 6 files beyond the 7 known from #484 (`live-tree-independence`, `mjs-ratchet`, `pr-template-acceptance`, `public-claim`, `tick-heartbeat-is-written`, `wake-engineer-brief`) fail with the same 11 failures on a detached worktree of the base commit, measured here. The repo has no `verify` or `lint` script, so neither was run.

The 7-day count (measured 2026-10-10, trace store read with `readStore`; scripts `measure.ts`, `extract.ts`, `join.ts`): 59 `repeating-log-line` wakes in the 7 days before; the delivered order's first quoted line could be read in 56; 10 of those 56 (18%) named a line that a row open at the wake cited (the line normalised with `normaliseLine`, its first 80 characters against the normalised title and body of the open rows). 4 were rows of this tracker and 6 of `a11ign/agent-org`'s. Not zero, so the row is built. This PR removes the 4; the 6 remain until the agent-org tracker's rows are in the gate's lanes (a follow-up row, not in this diff).

Calls per tick: none when no line repeats; no extra call for finding candidates; one `readItem` (one GraphQL `repository.issue`) per cited line per tick, at most 3, and one `postDecision` at a milestone. Listed in `GH_READS` as `conditionalOnCitedRepeatingLine`.

Switch: `A11IGN_REPEATING_LINE_SUPPRESSION=off` in the tick's environment restores every order, with no read and no write. Code revert, one line, the call site in `main()` of `src/work-gate.ts`: `repeatingLinesTick({ settle: ... })` back to `repeatingLinesTick()`. Live cutover, no shadow phase.

Outside-Region: src/repeating-lines.ts — the detector builds the orders, so the `settle` hook that drops a group before they are built has to be in it; 16 lines added and 4 removed, and with the hook absent it behaves as before.

Closes a11ign/agent-org#492

platform: the lookup and the write go through the ticket port; the GitHub adapter is the only place that names `gh`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
