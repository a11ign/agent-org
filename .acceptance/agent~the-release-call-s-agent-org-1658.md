`release-tag-on-merge.test.ts` no longer skips its lockfile-premise test while `pnpm-lock.yaml` is tracked, and `release.yml`'s header says what is true: a tracked lockfile and no `packageManager`.

Acceptance:
```bash
node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/packaging/release-tag-on-merge.test.ts
```

What is true, read at the pinned toolchain sha `ab856fdd` (`release-per-merge.yml` lines 33-36 and `scripts/release-per-merge.mjs` `pnpmSetup`, `changesetVersionInCi`): "pnpm itself comes from `packageManager`, else from the `pnpm-version` input, and a repository with neither is refused by name" and "With [a lockfile], `version` runs `pnpm install --frozen-lockfile` and the repository's own `changeset`. Without, it installs nothing and runs `pnpm dlx @changesets/cli@<changesets-version>`". So `pnpm-version` stays live (no `packageManager`), and `changesets-version` is ignored while the lockfile stands. I kept the input rather than delete it: it is the fallback if the lockfile goes, and `ci.yml`'s `release-dry-run` (outside this Region) repeats it as `CHANGESETS_VERSION`.

The test's premise is now: with a lockfile, package.json declares `@changesets/cli` at the version `changesets-version` names and the lockfile locks it; a `packageManager` appearing is refused. Without a lockfile the `inputs` property still owns the version.

Mutation (each restored with `cp` and `diff`ed byte-identical): package.json `@changesets/cli` 3.0.1 to 3.0.2 fails the premise test (1 of 6); a `packageManager` added fails the premise test and its positive control (2 of 6); the lockfile's `@changesets/cli@3.0.1` renamed fails the premise test (1 of 6). Never-fires direction: the positive control asserts the lockfile branch is the one that runs here and refuses each broken premise.

Measured: `VERDICT pass: 6 tests in 1 file` (was 5 run, 1 skipped). `src/packaging/release-dry-run.test.ts`: `VERDICT pass: 10 tests in 1 file`. `pnpm run typecheck` exits 0. There is no `lint` script in this package. Test and workflow-comment change only; no product code, no changeset.
