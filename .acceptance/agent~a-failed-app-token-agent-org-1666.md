A failed App-token mint no longer sends `pr create`, `pr merge` or `pr review` as the shared account when the flag `gh.refuseFallbackAuthor` is ON. The wrapper (`host/gh`) mints again, a bounded number of times (`A11Y_APP_AUTHOR_MINTS`, default 3). When every mint fails it REFUSES the call: non-zero exit, nothing sent, the reason on stderr, and one incident line per failed mint in the ledger. READS still fall back to the account. The flag is OFF when absent, so nothing changes until a person switches it on. A new health signal, `gh-author-fallback`, counts account-attributed authoring calls in the ledgers that are at most ten minutes old, and reads unread (null, not zero) when the ledgers cannot be read. The signal's switch and window are in `src/gh-author-fallback.ts`, with its readers in `src/org-health.ts` and `src/work-gate/causes/org-health-github-incident.ts`.

Acceptance: `node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/packaging/gh-author-fallback.test.ts` from the worktree.

Mutation (on the module in place, restored byte-identical and checked with `cmp` after each):
- The switch forced ON (`authorFallbackRefusalOn` returns `true`): `VERDICT fail: 4 of 13 tests failed in 1 file`. The four are the test that the switch reads ON only when the record says `on: true`, and three OFF-side tests: a switch absent with a failing mint falls back, a switch written OFF is the same as absent, and the wrapper's OFF-switch authoring call is the one the signal counts. The OFF side is what this mutation breaks.
- The signal window moved from ten minutes to eleven (`AUTHOR_FALLBACK_MINUTES = 11`): `VERDICT fail: 1 of 13 tests failed in 1 file`, the POSITIVE CONTROL "trips on an account-attributed authoring call at ten minutes old, and not at eleven".
- Restored: `VERDICT pass: 13 tests in 1 file`.

Measured, after the change:
- `src/packaging/gh-author-fallback.test.ts`: 13 of 13 pass.
- `src/packaging/machinery-flag-switch.test.ts`: 8 of 8 pass. The registry pin now names the sixteen flags a module reads, and the switch test switches `gh.refuseFallbackAuthor` on.
- `src/packaging/host-project-paths.test.ts`: 13 of 13 pass. Its templateValues pin gained `authorFlagScript` and `canaryStateFile`, and `TODAYS_GH_WRAPPER` moved to `277a71e45faa3985afb670d29f1837d299dcb7a567f0b1f1e644c75b53a9a246`. That is a deliberate change: the wrapper gained the author-refusal block and the mint retry.
- `src/org-health.test.ts` 5 of 5, `src/packaging/machinery-canary.test.ts` 28 of 28, `src/packaging/ownerless-pr-order.test.ts` 10 of 10.
- `pnpm run typecheck`: exit 0.
- Full suite, `node scripts/test-entry.ts` on the laid fixture with `AGENT_ORG_HOST` set and `node_modules/.bin` on PATH: 63 tests failed of 11934 that ran (229 skipped), in 20 of 733 test files. The same 20 files fail on HEAD `e9b19aa1`, run in a baseline worktree: the failing set matches file for file, so no file is new. The first full run in this worktree had 66 failures in 22 files: those 20 plus `host-project-paths.test.ts` and `machinery-flag-switch.test.ts`, which failed on my pins and are fixed above.

Not here, and named:
- The switch is OFF on every host. Nothing here has refused a real call, so the first refusal cannot be quoted until a person switches `gh.refuseFallbackAuthor` on and an authoring call hits a failed mint.
- The installed wrapper at `~/.local/bin/gh` still has the old text. A person must run a host install before any refusal can happen.
- The ledger cannot yet say, call by call, why an account-attributed authoring call on 2026-10-16 was not an App call. The hourly aggregate has no command column, and the live ledgers do not cover the whole window. The report on this row sets out the counts.
- `pnpm run lint` is not a script in this repository.
- The scheduler role gets the same rule as the other App roles. The test fixture declares it among the App roles, but no test sends an authoring call as the scheduler.

Closes a11ign/agent-org#1666

🤖 Generated with [Claude Code](https://claude.com/claude-code)
