A claim of a backlog row leaves `backlog` on it beside `in-progress`: `labelSetForClaim` keeps every label but `ready`. A claim now drops `backlog` as well, and a release of a row claimed from backlog leaves `backlog` and no `in-progress`.

**The change (`src/row-claim.ts`).**
- `labelSetForClaim` drops `ready` and `backlog` and keeps every other label (`lane:orchestrator`, `fleet-gated`).
- `declineAddLabels`: a release with no other state now writes `backlog`, so a released backlog row is not left with neither state. The answer branch is unchanged.

**Evidence.** `src/row-claim.test.ts` 37 of 37 (35 before, and the two new tests: the pure label set with the `ready` positive control, and a `declineRow` release of a row claimed from backlog). The two new tests fail on HEAD's `row-claim.ts`, 2 of 37. `src/state-label-exactly-one.test.ts` 19 of 19: a stateless plain decline now lands in `backlog`, so its refusal test asserts the missing-`backlog` throw and a landed release gets `backlog`. `pnpm run typecheck` exits 0.

**Not verified here.** A wider `rstest run --changed=origin/main` run shows 23 failing files that fail identically on HEAD, so they predate this change in this clone.

Acceptance: `AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/row-claim.test.ts`

Closes a11ign/agent-org#1568

platform: n/a (no GitHub, pnpm, systemd or git feature records a row's state label set; the labels are this repository's own)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
