The root package's `@types/node` moves from `^22.20.5` to `^25.9.9` (a11ign/agent-org#2016's `package.json` and `pnpm-lock.yaml`, carried unchanged), and the typecheck passes on it with no source change. `ui/`, `engines` and CI's Node 24.21.0 are as they were. `pool-org-repos.test.ts` no longer reads a wrong-repo's move before it ends: its helper waits for the clone and the restart, which a loaded runner made `suite (2)` fail on #2016. A new case with a clone slower than the old fixed turns fails without that wait.

Acceptance:
```bash
set -e
grep -q '"@types/node": "^25.9.9"' package.json
grep -q '"@types/node": "^26.6.5"' ui/package.json
grep -q '"node": ">=24"' package.json
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-org-repos.test.ts
```

Consumer-declaration: none -- no host file changes meaning. A type package and a test helper move.
