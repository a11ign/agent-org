The daily pass records a claim idle more than 60 minutes with no open PR, or a PR with nothing pending, as a `row-not-finishable` ledger incident: `src/idle-claim-incident.ts` is the pure detector (it reads the idle decision from `idleClaimantReading`, one decider), `org-retro.ts` reads the gate's idle memory, prints the count and the first three refs, and records each incident once per idle run.

Acceptance: `bash -c 'cd /home/agent/repos/agent-org-wt-4642 && AGENT_ORG_HOST=/home/agent/repos/wt-4642/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/idle-claim-incident.test.ts'`

Mutation: the 60-minute threshold made never to fire (`return null`) failed 20 of 23 tests; made always fire (`true ?`) failed 4 (the boundary, the 50-minute case, the PR twin, the 60-minute PR case). The row's declared waits ignored (`waitKinds: []`) failed 2; the pull request's pending check, review, approval, evidence and hold ignored (`prs` stripped to the number) failed 4. The ref made to omit the idle run's start (so a second run on the row is invisible to the ledger) failed 5. `idle-claim-incident.ts` restored byte-identical each time (`diff` against a copy). One mutation, "treat `waiting` as idle", was equivalent (a `waiting` reading carries no `idleMs`, so the threshold already refuses it) and was replaced by the two above.

Measured: `VERDICT pass: 23 tests in 1 file` for the acceptance file; with `src/org-retro*.test.ts` and `src/packaging/org-retro.test.ts`, `VERDICT pass: 74 tests in 4 files`. Full suite, compared by name: origin/main `VERDICT fail: 33 of 7710 tests failed in 418 files`; this head the same 33 failing names, with a first run that had one more, `src/packaging/org-retro.test.ts` (a trended `NUMBERS` entry needs a bound in the host's `ceo.md`, outside this Region), fixed by dropping the entry. The 33 are pre-existing and none touches this change.

Live (read-only, 2026-10-09 ~20:36Z, `readIdleClaims` against the host's `claim-stalls.json`, the open-PR list and the herdr listing): 2 open PRs, 12 panes listed, the gate's idle memory empty (`{}`), so 0 incidents and no first refs. The fixture run is the test's: five idle claims print `5` and the first three refs.

Closes a11ign/a11ign#4642

platform: n/a (the detector joins `idleClaimantReading` and `recordFailures`, neither of which GitHub, pnpm, systemd or git provides)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
