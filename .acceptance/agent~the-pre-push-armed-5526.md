The pre-push armed-PR guard reads the PR's `reviewDecision` off the same `gh pr list` that already answers armed and green, and `racesAnArmedMerge` refuses only when the decision lets the merge complete without an approval: `APPROVED`, or empty (the base requires no review). A PR whose decision is `CHANGES_REQUESTED` or `REVIEW_REQUIRED` cannot merge while `main` requires an approving review (a11ign#2022), so a push to it is allowed even when armed, green and up to date. An absent decision is unknown and fails open, as every other unknown in the guard does.

Acceptance: `pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include 'src/packaging/pre-push-armed-pr.test.ts'`

Deliberate departure from the row's wording: the row names `APPROVED` as the only refusing decision. The empty decision also refuses, because an empty `reviewDecision` means the base requires no review, so the armed merge can complete with nobody approving and the race is real. The row's own premise requires it.

Mutation: the review check made always true (`return true`) failed 4 of 18 (the CHANGES_REQUESTED, REVIEW_REQUIRED, unread-decision and lookup-absent tests); the review check made always false failed 2 of 18 (the APPROVED and empty tests); `reviewDecision` dropped from the `gh pr list --json` fields failed 1 of 18 (the lookup test). `armed-race-rule.ts` restored by `cp` from a scratchpad copy and confirmed identical by `diff` each time.

Measured: `VERDICT pass: 18 tests in 1 file` on the commit. `pnpm run typecheck` exits 0. This repository has no `lint` script, so none was run. The affected-set run (`rstest --changed=origin/main`) fails 107 of 709 tests in 21 files on both this tree and origin/main, with identical failing test names; those failures are pre-existing and not on this change's path.

Closes a11ign/a11ign#5526

platform: none -- the guard is agent-org's own pre-push predicate; nothing in the platform changes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
