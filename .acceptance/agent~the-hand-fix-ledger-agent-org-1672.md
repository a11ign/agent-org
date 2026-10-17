Acceptance: `node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/packaging/hand-fix-null-pr-author.test.ts src/packaging/hand-fix-ledger.test.ts`

Mutation: the fix reverted (`actors: pr ? [pr.author] : []`) fails the new file's tests (a) and (c), which assert the null author adds no actor (measured before the fix: `VERDICT fail: 2 of 23 tests failed`, the actors diff `[null, "github-actions[bot]"]` against the expected `["github-actions[bot]"]`, and `[null]` against `[]` for a merge with no carried commit). With the fix: `VERDICT pass: 23 tests in 2 files`.

Adjacent suites, after the fix: `src/packaging/hand-fix-reading-trust.test.ts` (`VERDICT pass: 7 tests in 1 file`), and the five other test files that import the ledger (`src/close-rows-for-merged-pr-closes-none.test.ts`, `src/failure-ledger.test.ts`, `src/packaging/git-reads-name-their-checkout.test.ts`, `src/packaging/no-search-reads.test.ts`, `src/packaging/org-retro.test.ts`: `VERDICT pass: 107 tests in 5 files`). `pnpm run typecheck` exits 0.

Remaining unread (Done-when 2, the "names each remaining unread change and why" branch): the production reader (`gatherChanges` with `repo: "a11ign/agent-org"`, then `buildLedger` over the current 14-day window) read 956 changes and counted 42, with 10 UNREAD. Ten is not below 10, so the list is the evidence. Each of the 10 is a change whose author is a resolvable org login but which carries a commit whose author GitHub resolves to no account (an unlinked email, or `web-flow`); the row keeps those UNREAD:

- pr:1087 (a11ign#5152), author a11ign-workers, actors [a11ign-workers, null]
- pr:1033 (a11ign#5076), author a11ign-workers, actors [a11ign-workers, github-actions[bot], github-actions[bot], null]
- pr:731 (a11ign/a11ign#4885), author a11ign-ai-workers, actors [a11ign-ai-workers, github-actions[bot] x4, null]
- pr:630 (a11ign/a11ign#4799), author a11ign-ai-workers, actors [a11ign-ai-workers, null]
- pr:619 (#4746), author a11ign-ai-workers, actors [a11ign-ai-workers, null]
- pr:614 (#4759), author a11ign-ai-workers, actors [a11ign-ai-workers, github-actions[bot], null, null]
- pr:420 (#4211), author a11ign-ai-workers, actors [a11ign-ai-workers, null]
- pr:350 (#3967), author a11ign-ai-workers, actors [a11ign-ai-workers, github-actions[bot], null]
- pr:237 (a11ign/a11ign#3639), author a11ign-ai-workers, actors [a11ign-ai-workers, null]
- pr:92 (a11ign/a11ign#2898), author a11ign-ai-workers, actors [a11ign-ai-workers, github-actions[bot], null x5]

The previous window read 65 counted and 13 UNREAD on the same run. This is a worker's read of live data at the time it ran, not the daily retrospective's line; the retrospective will show its own count when it runs.
