A held hour is no baseline for the machinery canary (agent-org#1425, a11ign#5497). While the account pause holds Claude work, a tick's sample is marked `held`, and a flag's before-hour that holds such a sample reads `unknown` per signal, with a detail that names the pause; a flag whose every reading is `unknown` at the end of its hour stays `watching` and is not `passed`. The same numbers with no pause still read `degraded` and revert (the positive control), and a pause that begins inside the hour after the switch is read.

Acceptance: `node --test src/packaging/machinery-canary.test.ts`

Mutation: the held mark never set (the pause ignored) failed `#5497 (1)`; the held mark always set failed the controls `(1b)`, `(1c)` and the #5100 tests; the all-unknown guard removed failed `#5497 (1)`. These three were run on the version that imported `pausedNow`. On the version that reads the record itself, the pause reader made to fail OPEN (an unreadable record holds nothing) failed `#5497 (1d)`. Each restored byte-identical (`cmp` against a copy).

Fails before: on HEAD's `org-health.ts`, `#5497 (1)` and `(1d)` fail; `(1b)` and `(1c)` pass as controls.

Measured: `ℹ tests 28 / ℹ pass 28 / ℹ fail 0` for the acceptance file; `src/org-health.test.ts` and `src/account-limit.test.ts`, 37/37; `src/packaging/messaging-units-start.test.ts`, 4/4 (it failed 2 of 4 under an earlier version that imported `account-limit.ts` into `org-health.ts`, which is why the pause is written out here). `pnpm run typecheck` exits 0. The full suite (`pnpm test`) fails in 25 files, none new: those 25 are a subset of the 26 files that fail on HEAD too, and the same 223 failing test lines come out of `node --test` on those 26 files with and without this change (timings aside). Among them `org-health.test.ts` (4 tests, on HEAD as well). Not compared per name under rstest on HEAD.

Closes a11ign/agent-org#1425
