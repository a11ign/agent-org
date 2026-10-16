agent-org names no project in its non-test source. The 15 files that named `a11y-witness` read the project from `.agent-org/project.json` through `project-config.ts`, or take it as a parameter, and no name moved into a comment or a renamed constant. `src/no-project-names.test.ts` refuses a new `a11y-witness` in any non-test, non-fixture file under `src`; its POSITIVE CONTROLS show the scan sees the name, the walk reaches the tree, and the fixture exemption holds the name it exempts.

`crash-recover.ts` resolves the default host declaration lazily (`resolveHomeCheckout()` inside `main()`), so the top-of-file import rule holds. With `AGENT_ORG_HOST` unset and no checkout resolvable it now refuses (exit 70) where it used to report "nothing done": a silent default to another project's path is the thing this row removed.

`walk-scope.ts`'s `Symbol.for` keys are renamed `agent-org.walk-scope`. The a11y-witness monorepo's own copy (`packages/guards/src/walk-scope.ts`) uses the old key, so a process that loads both copies no longer shares that state. Not verified whether any process does.

The guard reads the tracked tree (`git ls-files` under `src`), the same tree the row's `git grep` reads, not the disk. agent-org#1611's CI failed on a stray untracked file (`packaging/rehearsal-currency.ts`) left on the self-hosted runner, which the disk walk read as source. The same CI run failed three tests that hard-coded the primary checkout as `repos/a11y-witness`; on CI the host's checkout is `project`, so `PRIMARY_CHECKOUT` (= `HOME_CHECKOUT`) has that basename. `wake-one-row.test.ts` and `wake-spare-teardown.test.ts` now create `basename(PRIMARY_CHECKOUT)`, and `work-gate-engineer-order-paths.test.ts` reads any absolute path and keeps the host repos directory and `PRIMARY_CHECKOUT` by value. Checked under the real host, and under a simulated CI host whose checkout is `project` and is a git repository: the guard 4/4, `wake-one-row` 15/15, `wake-spare-teardown` 23/23, `engineer-order-paths` 16/16 on both.

Acceptance: `AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json node --test src/no-project-names.test.ts`

Measured: 4 pass, 0 fail. This is the guard, which asserts the row's check (the first test) and its controls. The guard needs `AGENT_ORG_HOST` set, as every test in this repository does; without it the tool refuses to guess a checkout.

Row acceptance (authoritative on the row, recorded here for the reviewer; not run by this job, because the job refuses a line that begins with `!` and one that begins with `cd`): `cd ~/repos/agent-org && ! git grep -q -E 'a11y-witness' -- src ':!*.test.ts' ':!*.test.mjs' ':!src/packaging/fixtures'`. Its result on this branch: exit 0.

Mutation (`node --test src/no-project-names.test.ts`, each file restored with `cp` from a backup and `diff`ed against it):
- a planted `// a11y-witness planted` line appended to `src/wake.ts`: exit 1, the main test fails and names `wake.ts:9066`; the three controls pass.
- the walk made to skip every file (`.filter(... && false)`): exit 1, only the CONTROL test fails ("only 0 source files were walked"); the main test passes on nothing, which is why the control exists.
- the scan made to report a fixed hit (`const hits = ["always fires"]`): exit 1, only the main test fails; the three controls pass.

Measured: `pnpm run typecheck` exits 0. This repository has no `lint` or `verify` script. `pnpm test` refuses to run from a standalone clone (its own message points to the narrow form). The narrow run `AGENT_ORG_HOST=<host.json> pnpm exec rstest run --config scripts/rstest/rstest.config.ts` over the 194 test files that import a changed module, plus the new guard, gives `VERDICT fail: 45 of 4192 tests failed in 195 files`. The same five failing files on origin/main (305d57da) give `45 of 510 tests failed in 5 files`, and the 45 failing test names are identical in both runs (`work-gate.test.ts` 37, `verdict-valid-while-patch-unchanged.test.ts` 4, `queue-stalled.test.ts` 2, `deferred-order-relane.test.ts` 1, `multi-board-gate.test.ts` 1). None of them is a change in this PR.

Measured, `HOME_CHECKOUT` with `AGENT_ORG_HOST` set here: `/home/agent/repos/a11y-witness`, the value the replaced literal had, so `PRIMARY_CHECKOUT` and the default board-report folder (`a11y-witness-board-reports`) are unchanged in this checkout.

Remaining occurrences, all outside the Region: test files (listed in the row's comment) and `src/packaging/fixtures/host-project-paths/a11ign-host.json`, introduced by a11ign/a11ign#3233 (commit `be28e232`).

Not here, and named: the `a11ign` family (`@a11ign/*`, `a11ign-board-*`, `row-carry`'s old name) is agent-org#1607, blocked by this row; the walk-scope key rename has the cross-copy coupling above; the `row-carry@agent-org.invalid` address is a new identity in git history from this commit onward.
