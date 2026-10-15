A held hour is no baseline for the machinery canary (agent-org#1425, a11ign#5497). While the account pause holds Claude work, a tick's sample is marked `held`, and a flag's before-hour that holds such a sample reads `unknown` per signal, with a detail that names the pause; a flag whose every reading is `unknown` at the end of its hour stays `watching` and is not `passed`. The same numbers with no pause still read `degraded` and revert (the positive control), and a pause that begins inside the hour after the switch is read.

Acceptance: `node --test src/packaging/machinery-canary.test.ts`

Mutation: the held mark never set (the pause ignored) failed `#5497 (1)` and `(1d)`; the held mark always set failed the controls `(1b)`, `(1c)` and the #5100 tests; the pause reader made to fail OPEN (an unreadable record holds nothing, in `account-limit-record.ts`) failed `#5497 (1d)`. Each restored byte-identical (`cmp` against a copy).

Fails before: on main's `org-health.ts` (the version before the held mark), `#5497 (1)` and `(1d)` fail; `(1b)` and `(1c)` pass as controls.

Measured: `ℹ tests 28 / ℹ pass 28 / ℹ fail 0` for the acceptance file; `src/org-health.test.ts` and `src/account-limit.test.ts`, 37/37; `src/packaging/messaging-units-start.test.ts`, 4/4 (it failed 2 of 4 under an earlier version that imported `account-limit.ts` into `org-health.ts`, which is why both files read the record through the leaf `account-limit-record.ts`). The three test files that import `account-limit.ts` (`account-limit.test.ts`, `machinery-flag-switch.test.ts`, `machinery-canary.test.ts`) give 69/69 together. `pnpm run typecheck` exits 0. The full suite under `node --test` (no file arguments) gives 11500 tests, 11375 pass, 121 fail, and HEAD (`dc2ec0b1`, in a temporary worktree) gives the same 121: the failing test names are identical once the checkout path is normalized, so none are new. Not compared under rstest (`pnpm test`).

Closes a11ign/agent-org#1425
