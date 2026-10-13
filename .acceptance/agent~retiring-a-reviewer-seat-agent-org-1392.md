Retiring a reviewer seat ends the runs of its causes: a capped cause whose seat is absent is started by the gate, not capped. The seat's teardown writes a `RESET` line for each cause the seat owns that has a run in the ledger (`endSeatRuns`, called from `endFinishedReviewers` at both the ended and the cleared sites), and `deliver` starts a capped cause again when its seat is absent from the registry and a complete listing, writing the `RESET` before its delivery line. A live seat stays capped.

Acceptance: `pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/seat-retire-reset.test.ts`

Mutation (each restored from a copy and diffed back to identical):
- the teardown's `endRuns` call removed: test (1) failed, `1 of 3 tests failed`.
- the restart not conditioned on an absent seat (`const restart = already >= MAX_DELIVERIES`): the live-seat control (2 control) failed.
- the restart's `endRun` moved after the delivery line: test (2) failed on the order of `reset` and `record`.

Measured: `VERDICT pass: 3 tests in 1 file` for the acceptance file; with `src/wake-reviewer-dead.test.ts` and `src/wake-reviewer-instance.test.ts`, `VERDICT pass: 67 tests in 3 files`. Full suite: see the PR body.
