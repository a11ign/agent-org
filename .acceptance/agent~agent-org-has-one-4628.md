`decide` (`src/decision-provider.ts`) is the one decision-provider interface: per-use switch in `.agent-org/decisions.json`, a deterministic fallback per question and per floor, an append-only decision log with `recordOutcome`; `triageOrder` is its first caller, unchanged.

Acceptance: `bash -c 'cd /home/agent/repos/agent-org-wt-4628 && AGENT_ORG_HOST=/home/agent/repos/wt-4628/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/decision-provider.test.ts'`

Mutation: the use switch made never to fire (`if (false) return`) failed 3 of 16 (off, malformed file, throwing deps); made always fire (`if (true)`) failed 12 of 16 (POSITIVE CONTROL: provider on, use on still asks). The floor made never to fire failed 3, always fire failed 6. The log made never to be written failed 4; the log made to carry the state failed 1 (the field-names-only test). `decision-provider.ts` restored byte-identical each time (`diff` against a copy).

Measured: `VERDICT pass: 16 tests in 1 file`; with `triage-provider.test.ts`, `triage-route.test.ts` and `tmp-fixtures-are-removed.test.ts`, `VERDICT pass: 45 tests in 4 files`. Full suite: origin/main `VERDICT fail: 33 of 7694 tests failed in 417 files`; this head, after the temp-directory fix, the same 33 failing (compared by name; the first run at this head had one more, `tmp-fixtures-are-removed`, which was this test's own and is fixed). The 33 are pre-existing and none touches this change.

Closes a11ign/a11ign#4628

platform: n/a (a seam over one HTTP provider; GitHub, pnpm, systemd and git do none of it)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
