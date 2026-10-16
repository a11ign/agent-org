agent-org can ask, from outside a project, what that project's `deliberateRefusals` job asks, behind the flag `outside.refusals` in the project's `.agent-org/decisions.json` (absent = off, shipped OFF). Read through `readSwitches`, like every other key there. ON IS SHADOW: the host gate (`settleOutsideRefusals`, `src/work-gate/pr-orders.ts`, called in `readArmingOf` right after `settleOutsideArm`) asks `deliberateRefusalVerdict` (the job's own `mergeSafetyVerdict` and `closesVerdictOf`, agent-org#1501) for each open, same-repository pull request by an org identity once the job has settled at its head, and appends `{home, reason, job, agreement}` to `outside-refusals-shadow.jsonl` in the gate's state directory. It returns nothing the gate acts on: no hold, label, comment or refusal to arm. A head already recorded is not asked again (the second actor does nothing). Off, nothing is read from GitHub or disk and nothing is written.

Acceptance: `bash -c 'git grep -l -F outside.refusals -- src && npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/outside-refusals.test.ts src/packaging/project-vocabulary.test.ts'`

Mutation: each run on `src/packaging/outside-refusals.test.ts` (node:test), restored byte-identical by `cp` from a copy and `diff -q`. `outsideRefusalsOn` always true: 2 tests fail (the flag table, the off pass); always false: 7 fail (the flag table and every ON case). No already-recorded refusal: 3 fail (the second-actor test among them). Agreement always `agree`: 1 fails. No fork refusal: 1 fails; no org-author refusal: 1 fails; no wait for the job's verdict: 1 fails. The `on` check removed from the pass: 1 fails (off asks nothing). The call removed from `readArmingOf`: 1 fails.

Measured: `src/packaging/outside-refusals.test.ts` 10 of 10 and `src/packaging/project-vocabulary.test.ts` pass under rstest (27 tests in 2 files). `pnpm run typecheck` exit 0; `import('./src/work-gate/tick.ts')` loads. `rstest run --changed=origin/main` in this worktree: 108 failing tests, the count #1573 measured at `origin/main` in this clone; for `work-gate.test.ts`, `queue-table.test.ts`, `wake.test.ts`, `queue-stalled.test.ts`, `outside-arm.test.ts` and `project-vocabulary.test.ts` the pass and fail counts are identical with my three source files at HEAD and at this change (37 and 2 fail either way, in the first and fourth). The repository has no lint script, so lint was not run.

Not here, and named: the flag is set by a11ign/a11ign#5611 (parked on this row). The gate's pass was not run live: the flag is off everywhere, and the tests' stub `gh` is the only GitHub it met. The job's reason line is not machine-compared (it lives in the Actions log); the home's is recorded beside each verdict for the human reading of the canary. `~/repos/agent-org`, the row's own Acceptance path, has no `outside.refusals` until this merges; the first command of the Acceptance above is that same `git grep` in this worktree.

Closes a11ign/agent-org#1578

Flag: outside.refusals
Health-signals: blind-ticks, wakes-held
Revert: set `outside.refusals` to `false` (or delete the key) in the project's `.agent-org/decisions.json`; it ships OFF and is shadow when on, and a11ign's `deliberateRefusals` job stays in `gate`'s `needs`. Or revert this pull request.

Outside-Region: src/deliberate-refusal.ts — the flag and its reader, beside the verdict the home asks.
Outside-Region: src/work-gate/tick.ts — the one call site: `readArmingOf` calls `settleOutsideRefusals` after `settleOutsideArm`, and imports it.
Outside-Region: src/packaging/outside-refusals.test.ts — the new test of the flag, the shadow record, the second actor and the wiring.
Outside-Region: .changeset/agent-org-stands-alone-refusals-1578.md — the entry a project that pins a tag reads.

platform: the job's verdict is read from `statusCheckRollup`, which the tick already holds; GitHub has no cross-repository "second opinion" check, and the gate already ticks every 2 minutes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
