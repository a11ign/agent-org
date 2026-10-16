The dora budget test's no-tags clone is made again, once, when git fails with the removal seen on run 38911039522 (`failed to copy file to .../no-tags/.git/objects/64/...: No such file or directory`), so the file no longer fails at import and runs no case. `cloneWithoutTags` in `src/dora-budget-spent-is-not-a-timeout.test.ts` removes the target and clones; it retries only when the error's stderr matches that removal and it is the first attempt, and throws every other error, and a second removal, as it is. The cause of the removal is not named: ten full local suite runs and an 80-clone parallel stress did not reproduce it, and no code in `src/` removes a path under the file's TMPDIR.

Acceptance: `node --test src/dora-budget-spent-is-not-a-timeout.test.ts`

Mutation: the retry made never to run (`attempt >= 2` changed to `attempt >= 1`) failed the two new tests and passed the 12 existing ones. The retry made to run on any error (`!removedUnderIt` changed to `!(removedUnderIt || true)`) failed the "fails any other way" test only (13 pass, 1 fail). The file restored by `cp` from a backup each time and confirmed identical with `diff`.

Before: the file at `efe2fad7` with the two new tests appended fails them with `ReferenceError: cloneWithoutTags is not defined` and passes the 12 existing ones.

Measured: `node --test src/dora-budget-spent-is-not-a-timeout.test.ts` reports 14 tests, 14 pass, 0 fail. `node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/dora-budget-spent-is-not-a-timeout.test.ts` exits 0 with `VERDICT pass: 14 tests in 1 file`. `pnpm run typecheck` exits 0. This checkout has no `lint` or `verify` script.
