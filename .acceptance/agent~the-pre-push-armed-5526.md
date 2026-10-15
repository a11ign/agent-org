The pre-push armed-PR guard reads the PR's `reviewDecision` off the same `gh pr list` that already answers armed and green, and `racesAnArmedMerge` refuses only when the decision is `APPROVED`, the decision a merge completes on. A PR whose decision is `CHANGES_REQUESTED` or `REVIEW_REQUIRED` cannot merge while `main` requires an approving review (a11ign#2022), so a push to it is allowed even when armed, green and up to date. An empty or absent decision is read as not `APPROVED` and allows, as every other unknown in the guard does.

Acceptance: `pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include 'src/packaging/pre-push-armed-pr.test.ts'`

Open question for product-manager, not a departure: the row's wording is followed as written, so an EMPTY decision allows. An empty decision means the base requires no review, so an armed merge can complete with nobody approving, and this change leaves that race open. Whether it should refuse is for product-manager to rule. It is pinned by the EMPTY test in `pre-push-armed-pr.test.ts`, and changing the answer is a one-line edit to `racesAnArmedMerge`. An earlier revision refused on an empty decision too; the reviewer's verdict found that this went beyond the row, and it was reverted.

Mutation: the review check made always true (`return true`) failed 5 of 18 (the CHANGES_REQUESTED, REVIEW_REQUIRED, EMPTY, unread-decision and lookup-asks-for-reviewDecision tests); the review check made always false failed 1 of 18 (the APPROVED test); `reviewDecision` dropped from the `gh pr list --json` fields failed 1 of 18 (the lookup test that asserts the field is requested). `armed-race-rule.ts` restored by `cp` from a scratchpad copy and confirmed identical by `diff` each time.

Measured: `VERDICT pass: 18 tests in 1 file` on the reworked tree. `pnpm run typecheck` exits 0 on the reworked tree. This repository has no `lint` script, so none was run. The affected-set run (`rstest --changed=origin/main`) fails 107 of 709 tests in 21 files on both this tree and origin/main, with identical failing test names; that figure was measured before the rework and was not re-run after it. Those failures are pre-existing and not on this change's path.

Closes a11ign/a11ign#5526

platform: none -- the guard is agent-org's own pre-push predicate; nothing in the platform changes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
