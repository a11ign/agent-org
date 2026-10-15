A pane that `crash-recover` resumes after an unclean boot now has `AGENT_ORG_HOST` in its shell: `resumeCommand` types `AGENT_ORG_HOST=<hostConfigPath()> claude --resume <id> <flags>`, the path taken from the same `hostConfigPath()` that `spawnEnvironment` calls, and the resolver is loaded with the launch flags (`prepare`) so `crash-recover.ts` still does not import `host-config.ts` at the top. A call with no host path keeps the old form, so the existing assertion stays as it is.

Acceptance:
```bash
pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/crash-recover.test.ts
```

Mutation: the prefix in `resumeCommand` was dropped (`const env: string[] = [];`) and the file restored from a copy and checked with `cmp` (byte-identical). With the prefix dropped, 2 tests fail: the new seat-and-worker test and the recover test that asserts the pane run command starts with `AGENT_ORG_HOST=/fixture/host.json claude --resume `.

Measured: `pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/crash-recover.test.ts` prints `VERDICT pass: 11 tests in 1 file` with the change (10 on the unchanged file). `pnpm run typecheck` exits 0. The full `pnpm test` has 112 failing tests in 25 files under `src/packaging/`, all on a unix socket path-length error that the untouched HEAD also shows (`src/packaging/pr-owner-gone.test.ts`: 4 of 21 fail with the change removed); no failing file is `crash-recover`.

Closes a11ign/agent-org#1484

Test: `src/crash-recover.test.ts`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
