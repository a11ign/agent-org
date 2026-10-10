`ci.yml` and `release.yml` stop installing `tsx` (a `tsx@^4.22.4` install argument in each, `node --import tsx --test` in `release.yml`), and `.github/scripts/leak-scan.mjs` and `workflow-paths.mjs` become `.ts` (a11ign/agent-org#524, follows a11ign#4389).

Closes a11ign/agent-org#524

## What changes, and why

- **`.github/scripts/leak-scan.ts`, `workflow-paths.ts`** (renamed from `.mjs`, history kept): the JSDoc types are TypeScript annotations; the logic is unchanged. `ci.yml`'s two `node .github/scripts/*.mjs` steps name the `.ts`, which the job's Node 24.21.0 runs with no install.
- **`ci.yml`**: `tsx` leaves the `suite` install and the `typecheck` job's description; the comments that named it say "the old loader".
- **`release.yml`**: the `consumer-check` job runs on Node 24.21.0 (it was 22.22.1, which `ci.yml` leaves for the same reason) and runs `node --test src/*.test.ts`. The `release` job's `node-version: 22.22.1` is untouched: `release-tag-on-merge.test.ts` pins it.
- **`mjs-ratchet.baseline.json`** is `{"files": [], "exceptions": []}`; `src/packaging/mjs-ratchet.test.ts`'s end-state test asserts the empty list and an empty tree.
- **`src/release-consumer-check.test.ts`**: the two patterns that find the run steps follow `node --test`.
- **`src/lib/generic-leak-patterns.ts`**: one comment names the `.ts`.

## How you verified it

```
$ bash -c '! git grep -qE tsx -- .github/workflows && test "$(git ls-files | grep -cE "[.](mjs|js|cjs)$")" = 0'; echo $?
0
$ node .github/scripts/workflow-paths.ts
workflow paths: 3 workflows, 8 paths named, all present
$ node .github/scripts/leak-scan.ts
leak scan: 1326 files examined, 0 leaks
```

The acceptance is false at `origin/main` (`ci.yml:4`, `release.yml:4`, and the two `.mjs` listed), true here.

With `typescript`, `yaml`, `@rstest/core` and `@a11ign/toolchain@0.1.5` installed by name, as `ci.yml` does, under Node 24.21.0 and the plain `node --test` the release job now runs: `public-interface.test.ts` 8 of 8, `release-consumer-check.test.ts` 7 pass and 1 skipped (the consumer reading, which skips without `A11IGN_CHECKOUT`, as before), `mjs-ratchet.test.ts` 6 of 6, `release-tag-on-merge.test.ts` 5 of 5. `tsc --noEmit -p tsconfig.json` reports nothing in the files this change touches.

Acceptance: `bash -c '! git grep -qE tsx -- .github/workflows && test "$(git ls-files | grep -cE "[.](mjs|js|cjs)$")" = 0'`

Mutation: a stale `leak-scan.mjs` entry put back in `mjs-ratchet.baseline.json` turns the end-state test red (1 of 6) and no other; the file was restored byte-identical (`diff` clean).

## Anything a reviewer should be sceptical of

- The `suite` and `typecheck` jobs themselves were not run here (they need the a11ign project checkout); the two scripts they call, and the tests that read these workflows, were run directly under Node 24.21.0.
- `.github/scripts/*.ts` is not in `tsconfig.json`'s `include` (`src/` only, outside this row's Region), so they are type-stripped, not type-checked, as the `.mjs` were.
- `.agent-org/roles/engineer.md` is not in this repository; the brief was read from a sibling worktree of the project.
