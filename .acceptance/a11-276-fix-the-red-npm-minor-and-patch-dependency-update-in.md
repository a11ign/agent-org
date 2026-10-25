Every `@changesets/cli` pin that Dependabot does not edit now names 3.0.3, the version its `npm-minor-and-patch` group puts in `package.json` and `pnpm-lock.yaml`: the `changeset` script in `package.json`, `changesets-version` and its header comment in `.github/workflows/release.yml`, and `CHANGESETS_VERSION` in the release dry run of `.github/workflows/ci.yml`. The mutant "a changesets version the script does not run" in `release-tag-on-merge.test.ts` now sets `2.0.0`, a version that is never the real one, so it stays refused after the next bump.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/release-tag-on-merge.test.ts src/packaging/release-dry-run.test.ts
```

Consumer-declaration: none -- no existing host file changes meaning. Only version strings in this repository's own release tooling move.
