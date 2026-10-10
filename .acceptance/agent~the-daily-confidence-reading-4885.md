The daily confidence reading (`src/decision-confidence-post.ts`, a11ign#4755) is scheduled as a host unit pair, `host/confidence-post.service.in` and `host/confidence-post.timer.in`, and the three files that pin the shipped unit lists count it. Carried over from a11ign#4879's build (commit `c9e7be5b`, rebased onto agent-org `b7a247af`), plus the two count pins that build found failing: `src/no-loader.test.ts` (`SIX_UNITS` gains `confidence-post`) and `src/packaging/host-project-paths.test.ts` (the renamed-unit and `acme-` lists gain the pair, entries 28 to 30, scanned files 31 to 33, and a `confidencePost` positive control in the subtraction).

Evidence (measured on this branch at agent-org `b7a247af` + 2 commits): the Acceptance command prints `VERDICT pass: 185 tests in 3 files`. Mutations, each restored byte-identical (`cmp`) and each run over the same three files: deleting the service's `AGENT_ORG_HOST` line fails 1 of 185; making the timer `Mon *-*-*` fails 1 of 185; dropping the pair from `TOOL_ENTRIES` fails 11 of 185; dropping `confidence-post` from `SIX_UNITS` fails 1 of 185. Full suite on this branch: 33 of 8821 failed in 12 files (`milestone-clock`, `row-file`, `tick-heartbeat-is-written`, `mjs-ratchet`, `public-claim`, and seven more), none naming a unit; the same 12 files run on an unmodified `origin/main` detached worktree give `33 of 315 failed in 12 files`, so they are pre-existing. `pnpm run typecheck` reports two errors, both in `mjs-ratchet.test.ts` (`@a11ign/toolchain/mjs-ratchet`), the same file failing at runtime on `main`.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/no-loader.test.ts
npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/host-units.test.ts src/packaging/host-project-paths.test.ts src/no-loader.test.ts
```

The row's own command is `cd /home/agent/repos/agent-org && AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/host-units.test.ts src/packaging/host-project-paths.test.ts src/no-loader.test.ts`; the primary checkout carries the new pair and pins only after the merge, so the second command above is the same three files run in the PR's own tree with `AGENT_ORG_HOST` set to a11y-witness's `host.json`, which the run needs, and printed `VERDICT pass: 185 tests in 3 files`. CI's acceptance job has no `history` (`host-units.test.ts` and `host-project-paths.test.ts` read `git log --all` through `shippedUnits`) and refuses that line; the first line is the one it can run, and it covers the `SIX_UNITS` pin that the pair's addition moved.

Mutation: delete `Environment=AGENT_ORG_HOST=` from `host/confidence-post.service.in` and the unit-lines test fails; restore and it passes.

Closes a11ign/a11ign#4885

platform: systemd timer with `Persistent=true` (the platform's own clock and catch-up), no scheduler built

🤖 Generated with [Claude Code](https://claude.com/claude-code)
