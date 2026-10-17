A merge-group failure that is a network error in an install step is infrastructure: the gate re-queues the ejected pull request once, behind the machinery flag `queue.reenqueueInfra` (OFF when absent). `jobFailuresOf` (`src/work-gate/causes/pr-ejected.ts`) marks a failing job whose FAILED STEP is an install and carries a `READS_OUTSIDE` signature (`src/ci-failure-class.ts`, now exported, reused rather than copied) or a registry 5xx; `ownershipOfFailure` answers `infrastructure` when every failing job is such a job and none names a file the pull request changes; `requeueEjected` arms it again inside the existing once-per-head bound (`REQUEUES_PER_HEAD`), with no wait for a green merge group (a dropped connection broke nothing on main). Every ejection of that shape that stays the owner's (bound spent, arm failed, or the flag off) is returned as `networkNotRequeued`, said in the tick's log with its error line, and counted by the new health signal `ejected-network-not-requeued` (`src/org-health.ts`). `.github/workflows/ci.yml` sets `npm_config_fetch_retries: 5` at workflow level, so every install retries a failed fetch five times.

Acceptance: `cd /home/agent/repos/wt-agent-org-1647 && node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/packaging/ejected-infra-requeue.test.ts src/packaging/work-gate-ejected-requeue.test.ts`

Mutation (on `src/work-gate/causes/pr-ejected.ts` in place, copied to the scratchpad first and restored from the copy; `diff` against it printed nothing after each):
- The network read never fires (`entries.filter(() => false)`): 7 of 29 fail, the new file's positive cases (re-queued once, registry 5xx, detector on the bound, flag-off detector, arm refused) and the two tests whose controls need a re-queue.
- Every failure is infrastructure (`if (true) return`): 11 of 29 fail, the new negative cases (own file, no signature, unknown) AND the older file's own/unknown/flag-off tests, which is the expected reach of an always-fire.
- The once-per-head bound never applies: 2 of 29 fail, the new bound test and the older file's `once per head` test.
- The flag ignored (`return true ? { requeue: true`): 1 of 29 fails, `CONTROL: the same ejection with the flag off, or with only the older flag on, stays the owner's`.
- The step name ignored (any step's network line counts): 1 of 29 fails, the test that puts `ECONNRESET` in a `Test` step.

Measured, after the last change:
- The row's command: `VERDICT pass: 29 tests in 2 files` (12 new in `ejected-infra-requeue.test.ts`, 17 in `work-gate-ejected-requeue.test.ts`, unchanged).
- The log shape in the new test is the real run's (`gh run view 38936509518 --repo a11ign/agent-org --log-failed`, read 2026-10-17): the signature is the FIRST error lines and the step ends on `npm error A complete log of this run can be found in` and `##[error]Process completed with exit code 152`, so "the last error line" is not the signature and the whole failed step is read.
- `src/packaging/flag-switch-ledger.test.ts` and `src/packaging/machinery-flag-switch.test.ts`: 32 tests pass; their pins gained `queue.reenqueueInfra` (seventeen flags in the registry).
- `pnpm run typecheck`: exit 0. `pnpm run lint` is not a script in this repository.
- 279 test files import a changed module (`ci-failure-class`, `machinery-flag`, `org-health`, `work-gate`, `pr-ejected`, `flag-switch`), run under the CI suite's fixture host (`AGENT_ORG_HOST` set to a laid copy of `src/packaging/fixtures/project-tree/`): 61 tests fail of 4785, and the 61 are the same set, test for test (50 distinct names), as on the base commit `b4709356` run in a detached worktree. None is new. The full `pnpm test` was not run.
- One rstest run right after I removed a scratch worktree reported `0 of 0 tests, 2 files failed` (a build-level failure) on the acceptance command; two reruns of the same command passed. I did not find its cause.

Not here, and named:
- The flag is OFF on every host. The first `pr-ejected-requeued` line after the switch cannot be quoted until a person switches `queue.reenqueueInfra` on (switch row a11ign/a11ign#5666, parked on this row), so Done-when 3's quote waits there, as agent-org#1666 ruled for its own.
- `ci.yml`'s retry is `npm_config_fetch_retries`, npm's own fetch retry (documented default 2). Whether pnpm reads that variable is inferred from pnpm reading `npm_config_*` for its settings, not measured; the `pnpm install` steps live in `release-dry-run`, which runs only when an install-affecting path changes. The test pins the setting and that no job overrides it, and cannot show a retry happening: the workflow changes only under a real run.
- The detector counts with the flag OFF too (from the log the tick already holds, no extra call), so the signal's baseline exists before the switch. It is counted by the removal's time falling in the tick's window, so one stuck pull request is one reading, not one a tick.
- The `work-gate.ts` line that passes the removal times into the tick is not run by a unit test; the signal's reader (`machineryValues`) and the producer (`readArmingOf`) are each tested.

Closes a11ign/agent-org#1647
Switch row: a11ign/a11ign#5666

🤖 Generated with [Claude Code](https://claude.com/claude-code)
