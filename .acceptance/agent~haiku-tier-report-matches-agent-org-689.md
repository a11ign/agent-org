The Haiku trial reading counts a closed row whose closing pull request has no resolvable repository as `unresolved`, apart from the rows that have no closing pull request, instead of stopping the report or folding it into "none merged" (agent-org#689).

**Premise, re-checked at `origin/main` `e0ea7375` (v0.141.3).** Change 1 of the row (build the repo from `owner.login` and `name`, keep `nameWithOwner`) is already on `main`: it landed with a11ign/agent-org#530 (PR #708), after this row was filed at `f47c6697`. It is not redone; the new test pins it again, with the old expression as its negative control. What `main` did NOT do is change 2: `closedRowOf` THROWS on a repository it cannot read, so one such row among 295 stops the whole report, and no `n unresolved` is printed.

**What changes.** `closedRowOrUnresolved` keeps such a row with `pr: null` and `unresolved: true`; `readClosedRows` reads through it. `closersOf` counts, per arm, the rows with no closing pull request and the unresolved ones, and `groupLines` prints both beside the merged count. With any unresolved row the two "none merged" lines say they are not a reading. `closedRowOf` keeps its strict contract (`src/packaging/haiku-tier.test.ts` pins its throw), so it is untouched; with that assertion moved it can fold into `closedRowOrUnresolved` (a follow-up row, not this one's Region). `ClosedRow.unresolved` is optional so the literals in `src/packaging/haiku-tier-report.test.ts` still typecheck.

Acceptance: `cd /home/agent/repos/wt-agent-org-689 && AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/trace/haiku-tier-report.test.ts`

Mutation (each from a copy, `diff`-identical after restore): the old read `repository.name` in place of the `owner.login/name` branch failed 5 of 6; `unresolved` never set failed 3; `unresolved` set for every closer failed 3; the `none merged` wording ignoring the count failed 1; `noPr` counting unresolved rows failed 2.

Measured: `src/trace/haiku-tier-report.test.ts` passes 6 of 6, with `src/packaging/haiku-tier.test.ts` 19 of 19. `tsc --noEmit` reports only the two `mjs-ratchet.test.ts` errors `main` has. The module-graph-affected set (`rstest run --changed=origin/main`): `VERDICT fail: 29 of 5002 tests failed in 273 files`, in 8 files (`auto-arm-token`, `milestone-clock-exact-start`, `milestone-clock`, `row-file-refuses-duplicate-title`, `row-file`, `tick-heartbeat-is-written`, `wake-engineer-brief`, `work-gate-other-scopes-concurrent`); each run alone on a clean `origin/main` worktree fails the same count (2, 4, 7, 1, 8, 5, 1, 1), so none touches this change.

Done-when 2 (the report's header and stop-rule lines after a release carrying the merge) is NOT done here: it needs a release and the live `gh` read, and is for the row's reader after the release.

Closes a11ign/agent-org#689

platform: n/a (a count over rows `gh` already returned)
