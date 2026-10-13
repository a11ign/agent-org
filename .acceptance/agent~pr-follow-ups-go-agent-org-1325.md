Refs #1325: prs.ownerRouting -- an outside or chairman PR is ordered for its review only (the flag is OFF by default).

Flag: prs.ownerRouting
Health-signals: claims-refused, wakes-held
Revert: turn the flag off (`machinery:flag off prs.ownerRouting --session=<you>`), or revert this PR. With the flag off every order is byte-identical to today.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.ts src/pr-owner-routing.test.ts` (13 tests pass; typecheck clean)

Rework for the first review's `not convinced` at `a9608fdb` (by the chairman's session, while the agents' allowance is spent):
- The `pr-review-blocked` set order names several pull requests under one subject, so the subject filter could not take an outside or chairman pull request out of it. With the flag on, `decide` now drops those pull requests from `reviewBlocked`'s population before the set order is built (`reviewOnlyRefs`, shared with `withholdOutsideFollowUps`).
- The flag-off test compared the new path with itself. It now compares with `BEFORE_1325`: the orders `main` at `87ba0f6c` (no `prOwnerRouting`) decides for the same mixed fixture, run there and pinned.

Mutations, each restored afterwards:
- Remove the set filter: 2 tests red (the mixed set with the flag on; outside and chairman refused and unlabelled).
- Make the flag-off path withhold too: 5 tests red, the pinned baseline among them.
- Route an outside follow-up to `ceo` instead of withholding it: the first OUTSIDE test goes red, as before.

Not in this PR: the dead-owner respawn (b), the Dependabot/Renovate worker routing (c), the seven-day idle triage row (d).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
