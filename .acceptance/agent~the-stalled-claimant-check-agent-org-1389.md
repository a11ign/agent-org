The stalled-claimant check reads a claimed holder as `canary-hour` (waiting, not stopped) when its claimed row names a machinery flag the canary is still watching. `canaryWatching` (`src/work-gate/claim-stall-tick.ts`) reads the canary file in the state directory and returns the flags that are switched on, have no final verdict (`passed` or `reverted`), and are inside the hour that starts at their `onAt` (`DEFAULT_CANARY_OPTIONS.windowMinutes`, 60). `canaryHourOf` matches a flag name in the row's title or body as a whole word, the way `namesOwedKey` reads one. A flag that is still watched outranks the row's `Waiting-for:` line in `declaredWaitOf`, and a row with its own declared wait keeps that kind. A canary file that cannot be read returns `null`, which never excuses a quiet holder.

Decisions, named so they can be redirected:
- The watched flags are the canary file's own keys, not `FLAG_REGISTRY`. Importing the registry from `claim-stall-tick.ts` closes an import cycle (`machinery-flag.ts` imports `work-gate/shared-file-orders.ts`, which reaches this file) and in the first full run it failed at load with a TDZ error (`Cannot access 'RECHECK_FLAG' before initialization`) across many test files. `switchFlag` writes only registered names, so the keys are registered flags unless the file was edited by hand.
- `canary-hour` is NOT added to `WAIT_FIELDS` (`src/idle-claimant.ts`). `src/packaging/idle-claimant.test.ts` (out of this row's region) asserts its CASE table has exactly the `WAIT_FIELDS` keys, so adding the kind there breaks that test. The kind still reaches the idle reading through `waitKinds`, which is what the `canary-hour` field test checks.
- A flag with `onAt: null` (switched on, not yet started by the gate) counts as watching, because its hour has not begun.
- The hour is `DEFAULT_CANARY_OPTIONS.windowMinutes`. A host override of the window is not read by this check.

The brief's "verdict null" wording differs from the code: `evaluateFlag` writes `verdict: "watching"` at the start of the hour and `null` only before `onAt`. The rule is "no final verdict", so `watching` and `null` both count as undecided.

Acceptance: `pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/idle-claimant-stopped.test.ts`: `VERDICT pass: 19 tests in 1 file`. The CANARY HOUR test holds the watched holder silent on ticks 0 to 49 (the window closes at T0 + 50 minutes), and its twins are nudged at M = 10: the hour decided (`passed`), the hour over (`onAt` 61 minutes before T0), the flag off, the row silent, and an unreadable file. The `canary-hour` field test reads through `idleClaimantReading`. The header names the 18:08Z ref `worker-agent-org-1354/#1354/1791914892290`.

`pnpm run typecheck` exits 0. There is no `lint`, `verify` or `test:org` script in this repository, so none was run. `pnpm test` (rstest, full suite): `VERDICT fail: 5 of 11398 tests failed in 683 files`, in `host-install-agent-org-launcher`, `live-tree-independence` (2), `multi-board-gate` and `release-tag-on-merge`. The same five fail at HEAD with this change removed, when those four files are run alone, so they are not caused by this row.

Follow-up, not in this row: `waitKindsOf` (`src/work-gate/org-health.ts`) restates the wait kinds for the overdue path and does not know `canary-hour`.

Closes a11ign/agent-org#1389

🤖 Generated with [Claude Code](https://claude.com/claude-code)
