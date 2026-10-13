Refs #1325: prs.ownerRouting -- an outside or chairman PR is ordered for its review only (the flag is OFF by default).

Flag: prs.ownerRouting
Health-signals: claims-refused, wakes-held
Revert: turn the flag off (`machinery:flag off prs.ownerRouting --session=<you>`), or revert this PR. With the flag off every order is byte-identical to today.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.ts src/pr-owner-routing.test.ts` (11 tests pass; mutation check red; typecheck clean)

Not in this PR: the dead-owner respawn (b), the Dependabot/Renovate worker routing (c), the seven-day idle triage row (d).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
