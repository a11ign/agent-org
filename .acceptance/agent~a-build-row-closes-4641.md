A build row that closes on its merge files its verify row in the same turn: `src/verify-row.ts` reads the closed row's Done-when with #4640's classifier (`unfinishableItems`, the `future-time` class only), and for a live reading files `Verify <build title>` carrying that one item, a `Not-before:` placed from the item's own words and the merge time, a blocked-by edge on the build, the build's `lane:*`, `out-of-release` and milestone, and a sub-issue link under the build's epic (so the epic's `subIssuesSummary` counts the build done when the verify row closes). A build with no live reading files nothing; a second merge, or a re-run, finds the marker `<!-- verify-row: build #N -->` and files no second row; a search that cannot be read files nothing and fails the job so the re-run files it. `close-rows-for-merged-pr.ts` calls it for every row it closed or found closed at the merge.

Acceptance: `bash -c 'cd /home/agent/repos/agent-org-wt-4641 && AGENT_ORG_HOST=/home/agent/repos/wt-4641/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/verify-row.test.ts'`

Mutation: a build always planned as having no reading (`if (!item || item) return null`) failed 6 of 10 tests (2, 3, 4, 5, 6, 9); the `future-time` filter removed (so a seat's act or another row's outcome is a reading) failed test 7 only; the existing-row check made never to match failed test 3 only; the sub-issue link made never to run failed test 2 only. `verify-row.ts` restored byte-identical each time (`diff` against a copy).

Measured: `VERDICT pass: 10 tests in 1 file` for the acceptance file; with `src/*close-rows*.test.ts`, `src/packaging/close-rows*.test.ts` and `src/packaging/project-vocabulary.test.ts`, passing. Full suite, compared by name against origin/main for the seven failing files (`board-truth-audit`, `auto-arm-token`, `milestone-clock-exact-start`, `milestone-clock`, `mjs-ratchet`, `pr-template-acceptance`, `public-claim`): the same failing names on both. One file this change first broke, `src/packaging/project-vocabulary.test.ts` (three vocabulary literals in `verify-row.ts`), now reads them from `project-vocabulary.ts`. `tsc --noEmit` shows only the two existing `mjs-ratchet.test.ts` errors.

Merge-simulated read-only (a fixture row `#3870` with a Done-when item "The `git worktree list` count is read on 2026-10-11 and posted on the row." and nothing filed): the verify row it would file is titled `Verify Count the git worktrees after the cleanup lands`, labelled `backlog`, `lane:any`, milestone `v1`, with Done-when item 1 that sentence, `Not-before: 2026-10-11T00:00:00Z`, `Verifies: #3870`, then blocked-by #3870 and a sub-issue of epic #3800.

Not here, and named: the fixed-measurement script lines are #4639's grammar and are not invented before it lands; the `Roadmap` Project field has no reader in this repository, so only the sub-issue link is copied; Project boarding goes through `row-file --board=`, which refuses a row with no Region, so a verify row is filed `backlog` and a refusal is printed beside it; the call site is in `close-rows-for-merged-pr.ts` (in the Region), not `work-gate.ts` or `wake.ts`.

Closes a11ign/a11ign#4641

platform: GitHub's own blocked-by edge and sub-issues API carry the order and the epic count; the filing is `gh issue create`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
