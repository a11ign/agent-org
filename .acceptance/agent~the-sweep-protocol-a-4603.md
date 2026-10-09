A row that declares a `Sweep:` freezes its Region while it is claimed, is boxed at 60 minutes of CI from its pull request opening and released past it, and cannot have follow-up rows filed into its area by its holder before the merge (a11ign/a11ign#4603, lock-gridlock fix 2 of 4, epic #4437).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.* src/sweep-window.test.ts
```

The row's command is `cd ~/repos/agent-org && npx rstest run --config scripts/rstest/rstest.config.* src/sweep-window.test.ts`. The primary checkout carries the new test only after the merge, so the command above is the same one run in the PR's own tree. It was run with `AGENT_ORG_HOST` UNSET, because the test records its own host. Printed:
```
VERDICT pass: 19 tests in 1 file -- full report: A11Y_RSTEST_FULL_REPORT=1
```

Mutation:
- Each mutant was applied with a script, run against `src/sweep-window.test.ts`, and restored from a copy (`cmp` identical afterwards; never `git checkout --`). Failures are of 19 tests.
  - overrun never fires: 6 fail (the 59/61 boundary, the no-PR release, the claim release, the pure rule, both filing tests). Overrun always fires: 12 fail, including every refusal.
  - stalled never fires: 4 fail (the 14/15 boundary, the no-PR release, the report, the unwritable report). Stalled always fires: 3 fail (the boundary, the 59-minute test, the 14-minute control).
  - no file is ever shared (the freeze never refuses): 8 fail, every refusal. Every file is shared (it always refuses): 3 fail, the no-shared-file control and both filing controls.
  - overrun still holds the window: 4 fail (the claim release, the pure release, both filing releases).
  - overrun report ignores its marker (written twice): 1 fails. Stalled report ignores its marker: 1 fails.
  - the claim ignores the freeze (`row-claim.ts`): 5 fail. `row-file` ignores the sweep: 1 fails. `check` does not predict the freeze: 1 fails (the `reportB4` test).
  Each pair (never, always) breaks its own tests and the always-fires direction breaks a control.

Suite: the whole `agent-org` suite, with `AGENT_ORG_HOST` set to a11y-witness's `.agent-org/host.json`, at `origin/main` (`15df8bf`, a clean detached worktree) and on this branch: `33 of 7625 tests failed in 411 files` before and `33 of 7644 tests failed in 412 files` after. The 33 failing test names are the same set (`comm -3` of the two sorted lists is empty), so none is new; they fail on `origin/main` too in this environment. `pnpm run typecheck`: the same 2 errors as `origin/main`, both in `src/packaging/mjs-ratchet.test.ts` (`@a11ign/toolchain/mjs-ratchet` not resolvable here), none in a file this row touches.

Decisions, because the row did not fix them:
- The box is spent STRICTLY past 60 minutes (at 60:00 the holder still has the box; the test pins 59, 60 and 61).
- A sweep that never opens a pull request has its box run from the moment the PR was due (claim + 15 minutes), so it is released at claim + 75 and never holds the lock for ever. The row fixed the box only "from the pull request opening".
- The box counts from the LATER of the PR opening and the claim, so an adopted PR that predates the claim does not start the box before the window did.
- `overrun` also releases the holder's own filing ban: "revert or split" needs rows filed.
- An unreadable sweep list refuses as INCONCLUSIVE (claim, `check` and `row-file`), the same policy as the claimed-row read beside it.
- The sweep read sends the same `gh issue list` argv as `lookupClaimedRegions`, so `host/gh`'s 20-second identical-read cache makes it free.

What this row does NOT do (Region): the stalled and overrun REPORTS are made when a claim or a filing asks, not on a tick, because `work-gate.ts` is outside the Region. A stalled sweep that nobody tries to claim against is not reported until somebody does. The follow-up that moves the report into the tick is named on the row.

Done-when 2, run for real: a11ign#4278 (the lab's `scripts/` rename) is declared a sweep. The line added to its body, after its Region section, read back by `declaresSweep` (`before: false, after: true`):
```
Sweep: the lab's `scripts/` rename to TypeScript must land as one row, because concurrent edits to those 37 files conflict (declared under the sweep protocol, a11ign#4603).
```
