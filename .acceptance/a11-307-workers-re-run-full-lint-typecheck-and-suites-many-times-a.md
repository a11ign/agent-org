`npm run check:changed` checks a change in one command: ESLint with a keyed `--cache` on the changed files, `tsc --noEmit` over the whole program (incremental), and the tests that import a changed file at any depth, name its path, or are changed themselves. It prints what it ran and why, and falls back to the whole suite and the whole lint for a shared fixture, `scripts/rstest/*`, the runner's setup files, `package.json`, the lockfile or a config. The worker brief, the house notes and `AGENTS.md` tell workers to use it; CI's jobs are unchanged.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/check-changed-selection.test.ts src/packaging/check-changed-lint-and-typecheck.test.ts src/ticket-mode/ci-spend/rules.test.ts
node scripts/check-changed.ts --plan
```

Consumer-declaration: none -- no host file, queue file or setting changes meaning. The shipped worker house notes gain a line, which a host that already has its own notes file keeps without.
