The trace-freshness check no longer calls a store STALE because no turn is newer than ten minutes. STALE is now "a message the ingest owes a turn for has none": a settled message (past the five-minute hold-back at the previous ingest, `OWED_AFTER_MS` = `QUIET_MS` + `INGEST_EVERY_MS` = 10 minutes) with no turn of its own transcript at or after it in the store, read after this ingest. A session inside one long tool call (its message at 09:17:47Z, its result at 09:26:27Z, the store read at 09:31:34Z) is no longer an outage. A message is owed only inside the owed band (`OWED_WINDOW_MS`, 20 to 10 minutes old), so an owed message older than 20 minutes is not stale by this rule. `working` is display only, and `STALE_AFTER_MS` is unchanged.

Acceptance: `bash -c 'cd /home/agent/repos/wt-agent-org-1570 && AGENT_ORG_HOST=.agent-org/host.json pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/trace/freshness.test.ts'`

Mutation: not run. The 37 `work-gate.test.ts` failures were checked as pre-existing by swapping HEAD's `freshness.ts`, `trace.ts` and `codex-turns.ts` in and out (byte-identical restore by `cmp`); that is a baseline check, not a mutation.

Measured: `VERDICT pass: 29 tests in 1 file` for `src/trace/freshness.test.ts`; `VERDICT pass: 241 tests in 3 files` with `src/trace/freshness-healthy-schedules.test.ts` and `src/trace/trace-store-readers.test.ts`. `pnpm run typecheck` exit 0. The trace set's only failures are 37 tests in `src/packaging/work-gate.test.ts`, the same 37 on HEAD.

Not here, and named: `.agent-org/host.json` is absent from this worktree, so the literal acceptance command cannot run here; the verification used a scratch copy of the a11y-witness host file. `.agent-org/failure-classes.json` is not in this repository, so the `metrics-outage` guardNote that must name this case is NOT in this change and is an open item. The repository has no lint script, so lint was not run. The existing fixtures in `freshness.test.ts` and `freshness-healthy-schedules.test.ts` changed because the owed rule needs older messages, usage-bearing assistant lines, and `roots` in place of `working`.

Closes a11ign/agent-org#1570

platform: none; the code is pure TypeScript; the ingest's five-minute cadence is `host/trace-ingest.timer.in`, `OnUnitActiveSec=5min`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
