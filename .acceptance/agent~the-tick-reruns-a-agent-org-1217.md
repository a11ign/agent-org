The tick now reruns a required check that went red on a GitHub 5xx, once, through the ticket port, and writes one `checks rerun on 5xx` line per rerun. `withCiFailureClass` (`src/wake.ts`) takes the facts it already reads (`readCiFailure`), asks the port for the red run (`redRunOfHead`, `src/ticket-port/ci-reads.ts`, the same check `readCiFailure` classified), puts the log and the run's attempt count through `rerunRedOn5xx`, and on `rerun` calls `rerunFailedJobsOf`, which runs exactly `run(["run", "rerun", String(runId), "--failed", "-R", repo])`. The line (`rerunLedgerLine`) goes to `ci-reruns-on-5xx` beside the delivery ledger, and to the tick's stderr. The order gains one note saying change nothing; a rerun needs no classification, so the provider is not asked. A refused rerun is `owner`: the order says GitHub refused and why, it is classified as before, and no line is written. `docs/gh-call-baseline.json` is not raised (the two calls live in the port).

Acceptance: `node --test src/ci-rerun-on-5xx.test.ts src/ticket-port/ticket-port.test.ts src/packaging/gh-call-ratchet.test.ts src/wake-ci-rerun-on-5xx.test.ts`

Measured: `ℹ tests 45, pass 45, fail 0` for that command plus `src/wake-ci-rerun-on-5xx.test.ts` (the row's tick test, 7 tests: ON rerun and ledger line, OFF byte for byte, the shipped flag, three negative controls, a refused rerun, the roll-up pick, the port). `src/wake-ci-class-review-depth.test.ts` and `src/wake-same-head-refail.test.ts` (the other callers of `withCiFailureClass`): 17 pass. `pnpm run typecheck` exits 0.

Mutation: `src/wake.ts` backed up with `cp` before and restored with `cp` after, proven byte-identical by `diff` each time.
- M1, the rerun never fires (`if (true) return null` in place of the flag test): 3 fail (the ON rerun, the refused rerun, the roll-up pick); the OFF tests stay green.
- M2, the rerun always fires (the flag test removed from the call site): 1 fails (the OFF test, which counts the reads and asserts no write); the decider's own flag test still answers `owner`, so the shipped-flag test stays green, and that is why the OFF test counts calls.
- M3, the once bound dropped (`rerunsOnThisHead: false`): 1 fails (the negative controls, at the head that was already rerun).

Not run: the real `gh run rerun`, and the live tick. The write is held to its argv by the test's fake `gh`; the flag ships OFF, so nothing reruns until it is switched on.

`pnpm test` (rstest) on this branch: `VERDICT fail: 115 of 11569 tests failed in 695 files`, every one in a work-gate / packaging file this diff does not touch (`work-gate.test.ts` 37, `work-gate-unlabelled-pr-owner` 10, ...). Three of those files (`work-gate-unlabelled-pr-owner`, `packaging/pr-owner-total`, `work-gate-github-incident`) run on a `git archive` of `origin/main` fail the same 24 tests (10 + 7 + 7), so they are not this change's. The other files were not rerun at `origin/main`.

Closes a11ign/agent-org#1217

platform: GitHub's own `gh run rerun --failed` is the rerun; the tick only decides and records. Not checked: whether GitHub or the workflow can retry a 5xx step itself.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
