A hold-reminder order quotes the manager direction posted on the held pull request after the hold was taken: the newest three, verbatim and attributed by seat and author, each cut at 1200 characters, with the count of older ones named. A comment counts only when a manager login posted it and its last `decided-by` marker names a manager seat. The hold module copies the manager logins and the `decided-by` parse rather than importing `lane-ownership.ts` and `claim-stall.ts`, because importing them loads the project declaration and creates an import cycle through the wake.

Acceptance: `node --test src/pr-hold-state-direction.test.ts` (run with `AGENT_ORG_HOST` set to a project declaration, as a worker's unit sets it; without it the module refuses to load on `main` and on this branch alike)

Mutation (positive control, the new test file run against `origin/main`'s `src/pr-hold-state.ts`):
- the wake quotes the direction (test 1): fails on `main`, `/Orchestrator ruling: drop your hold/` not in the order.
- newest three quoted, oldest first (test 3): fails on `main`, `direction 3 is quoted`.
- the cut at 1200 characters (test 4): fails on `main`, `/LONG x/` not in the order.
- the negatives (test 2: earlier, worker and unnamed-seat comments are not quoted; test 5: no direction, none quoted) pass on `main`, as they should: nothing was quoted before either.

Measured: `node --test src/pr-hold-state-direction.test.ts` with `AGENT_ORG_HOST` set to a scratch declaration: `ℹ tests 5`, `ℹ pass 5`, `ℹ fail 0`. Without it the file refuses to load, on `main` as well. `pnpm run typecheck`: exit 0. Full suite (`pnpm test`) with my change: `VERDICT fail: 161 of 5604 tests failed in 685 files`; the same suite with `origin/main`'s hold module: `VERDICT fail: 164 of 5604`. At file level, no file fails only with my change; `src/pr-hold.test.ts` passes in both full runs. The three tests that fail only on `main` are the new direction tests. The 161 failures are in packaging and repository-layout tests that do not depend on this change. No lint script exists in this repository.
