A failed App-token mint no longer sends `pr create`, `pr merge` or `pr review` as the shared account when the flag `gh.refuseFallbackAuthor` is ON. The wrapper (`host/gh`) mints again, a bounded number of times (`A11Y_APP_AUTHOR_MINTS`, default 3). When every mint fails it REFUSES the call: non-zero exit, nothing sent, the reason on stderr, and one incident line per failed mint in the ledger. READS still fall back to the account. The flag is OFF when absent, so nothing changes until a person switches it on. A new health signal, `gh-author-fallback`, counts account-attributed authoring calls in the ledgers that are at most ten minutes old, and reads unread (null, not zero) when the ledgers cannot be read. The signal's switch and window are in `src/gh-author-fallback.ts`, with its readers in `src/org-health.ts` and `src/work-gate/causes/org-health-github-incident.ts`.

Acceptance: `node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/packaging/gh-author-fallback.test.ts` from the worktree.

Measured, after the last change:
- `src/packaging/gh-author-fallback.test.ts`: 15 of 15 pass. Two tests are new since the first version (13 tests): the signal counts an account's authoring call only for a role the host declares `github-apps`, in each of the three ledgers (workers, leads, reviewer), and a ledger nobody wrote is no calls, not an error; an unreadable ledger reads UNREAD (null).
- `src/packaging/machinery-flag-switch.test.ts`: 8 of 8 pass. The registry pin now names the sixteen flags a module reads, and the switch test switches `gh.refuseFallbackAuthor` on.
- `src/packaging/host-project-paths.test.ts`: 13 of 13 pass. Its templateValues pin gained `authorFlagScript` and `canaryStateFile`, and `TODAYS_GH_WRAPPER` moved to `277a71e45faa3985afb670d29f1837d299dcb7a567f0b1f1e644c75b53a9a246`. That is a deliberate change: the wrapper gained the author-refusal block and the mint retry.
- `src/org-health.test.ts` 5 of 5, `src/packaging/machinery-canary.test.ts` 28 of 28, `src/packaging/ownerless-pr-order.test.ts` 10 of 10, `src/work-gate.test.ts` in the same run as the 7 pinned files: 467 tests in 7 files pass.
- `pnpm run typecheck`: exit 0.
- Full suite, `node scripts/test-entry.ts` with `AGENT_ORG_HOST` set to the laid fixture and `node_modules/.bin` on PATH: 63 tests failed of 11936 that ran (229 skipped), in 20 of 733 test files. The failing set is identical, file for file, to HEAD `e9b19aa1` run in the baseline worktree (the 20 files are listed in the run's JSON report). No file is new. Run output: `scratchpad/full-suite-3.txt`.

Mutation (on the module in place, restored byte-identical and checked with `cmp` after each):
- The author-role filter removed (`accountAuthoringTimes` counts every role, so non-`github-apps` roles are counted too): `VERDICT fail: 1 of 15 tests failed in 1 file`.
- The reviewer's ledger dropped from `authorFallbackTimes`: `VERDICT fail: 1 of 15 tests failed in 1 file`.
- The switch forced ON (`authorFallbackRefusalOn` returns `true`): `VERDICT fail: 2 of 15 tests failed in 1 file`. The two are the test that the switch reads ON only when the record says `on: true`, and the negative control "a switch written OFF is the same as an absent one". Output: `scratchpad/mut-switch-15.txt`.
- The signal window moved from ten minutes to eleven (`AUTHOR_FALLBACK_MINUTES = 11`): `VERDICT fail: 1 of 15 tests failed in 1 file`, the POSITIVE CONTROL "the signal trips on an account-attributed authoring call at ten minutes old, and not at eleven". Output: `scratchpad/mut-window-15.txt`.
- Each mutation was restored from `scratchpad/gh-author-fallback.keep.ts` and checked with `cmp`: byte-identical. The unmutated file: `VERDICT pass: 15 tests in 1 file`.

The author-role and reviewer-ledger mutations were measured on the same 15-test file when those fixes were made; their output is not kept in the scratchpad, only these counts.

Ledger findings for 2026-10-16 (done-when 1). These are read from the live files on this host as of 2026-10-17, not from a copy:
- `workers/gh/gh-calls.tsv` starts at `2026-10-17T00:34:34Z` (7,792 lines). It has no 2026-10-16 row. The per-call rows for 10-16 are gone from this file (it was trimmed), so they are not in it.
- `leads/gh/gh-calls.tsv` starts at `2026-10-16T11:21:08Z`. On 10-16 it has 53 account-attributed rows (44 core, 4 graphql, 1 graphql?, 4 other) and none is an authoring call. Its 20:xx rows are all `app:managers` (91 rows, none account-attributed).
- `reviewer/gh/gh-calls.tsv` (6 lines) has one 10-16 row, `app:reviewer` at `08:37:28Z`, and no account-attributed row. It has no line after 08:37:28Z.
- So no live file starts at 20:56Z, and the per-call files do not hide calls before 20:56Z on 10-16 for leads or the reviewer. The workers file was trimmed to 10-17, so its 10-16 calls are visible only in the hourly aggregate.
- The 21:19Z to 21:21Z window: no line exists in any live ledger. The leads file has 0 rows in 21:19 to 21:21, and the workers file has no 10-16 rows.
- The only 21:xx figure is the workers hourly aggregate, hour `2026-10-16T21`: `a11ign-ai-workers` 117 calls across 15 rows (resources cache 3, core 5, graphql 6, other 1). The aggregate has no command column and no minute, so it cannot show which of the 117 is an authoring call. Authoring calls on 21:xx cannot be counted from the data.
- Cause counts for the account-attributed calls on 10-16 (mint failed / role not resolved or explicit config dir / other) cannot be computed. The leads rows are all reads, so the 53 are not authoring calls; the 117 in workers hour 21 have no command.
- Incident lines on 10-16 in the workers hourly aggregate: hour 01 (`app:scheduler`, 1), hour 09 (`a11ign-ai-workers`, 6, command `app-token`), hour 11 (`app:workers`, 2), hour 16 (`app:workers`, 1). None falls in hour 21. An account-attributed call that never reached a mint (role not resolved, or an explicit config dir) writes no incident line. That is the likely reason there is none in 21:xx, but it is not proven.
- Why the mint failed: no file holds the cause of a 10-16 mint failure. The hourly aggregate gives the count of the hour-09 incidents, not their text. The only failure text in the live files is from 10-17, `app-token workers failed, fell back to the account: app token: token: POST /app/installations/170075092/access_tokens did not answer (exit 1)`, which is a transport failure and not a 401. It is dated 10-17, so it is not the 21:19Z mint.

Not here, and named:
- The switch is OFF on every host. Nothing here has refused a real call, so the first refusal cannot be quoted until a person switches `gh.refuseFallbackAuthor` on (switch row a11ign/a11ign#5675) and an authoring call hits a failed mint.
- The installed wrapper at `~/.local/bin/gh` still has the old text. A person must run a host install before any refusal can happen.
- The ledger cannot yet say, call by call, why an account-attributed authoring call on 2026-10-16 was not an App call. That is a data limit, stated here and on the PR; it is not claimed as fixed.
- The `work-gate.ts` line that passes the times into the tick is not run by any unit test; the reader it calls is tested.
- `pnpm run lint` is not a script in this repository.
- The scheduler role gets the same rule as the other App roles. No test sends an authoring call as the scheduler.
- The baseline worktree at `/tmp/claude-1000/-home-agent-repos-wt-agent-org-1666/93fd7013-e1c0-4ab8-be9f-3c07287df9ba/scratchpad/base` (detached at `e9b19aa1`) stays in place until a person approves its removal.

Closes a11ign/agent-org#1666
Switch row: a11ign/a11ign#5675

🤖 Generated with [Claude Code](https://claude.com/claude-code)
