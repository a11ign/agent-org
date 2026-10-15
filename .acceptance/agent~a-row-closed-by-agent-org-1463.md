A closed row whose own merged pull request is named by `closedByPullRequestsReferences` (and owned by the session that holds the row's claim) now has its claim released by `closedClaimOrders` (`src/claim-stall.ts`), instead of returning null and leaving the labels on the row for ever. The line that says so is written ONCE per stand, through a memory file `closed-claim-lines.json` in the state directory (`closedClaimsNow` in `src/work-gate/claim-stall-tick.ts`, called from `withClosedClaims` and `keyedClosedClaimOrders` in `src/work-gate/tick.ts`). Without a state directory the line is said each time asked, as before.

Finding (on the row): no merge settle exists for agent-org rows. The close-rows sweep (`stripClaimLabelsVia` callers) lives in a11ign/a11ign's CI, and agent-org has no close-rows workflow; `settle-closed-rows.ts` moves Project Status only. #1325 was closed at 21:49Z on 2026-10-13 and kept its labels, because the work-gate debris strip is held by `holdsClosedRow` while herdr lists the instance as `unknown`, which is not a status that lets it go. That `unknown` reading contradicts the `goneReading` rule in `claim-stall.ts`; it is named as a follow-up and not changed here.

Acceptance: `cd /home/agent/repos/wt-agent-org-1463 && npx rstest run --config scripts/rstest/rstest.config.ts src/claim-stall.test.ts`

Positive control: the new test in `src/claim-stall.test.ts` ticks a closed row whose `closedByPullRequestsReferences` names #1378 (owned by `worker-agent-org-1325`) three times with one memory, and asserts a `closed` release on each tick and exactly one own-pull-request line. Measured: `VERDICT pass: 4 tests in 1 file`. Against the `origin/main` versions of `claim-stall.ts` and `claim-stall-tick.ts` the same test fails (`VERDICT fail: 1 of 4 tests failed`). The control drives `closedClaimsNow`, the function the tick calls for closed rows, and not `claimStallTick`: `claimStallTick` evaluates open claimed rows only, so a closed row never reaches it.

Measured: `tsc --noEmit` exits 0. The full suite (`VERDICT fail: 113 of 11675 tests failed in 702 files`) fails in 26 files. Run on the same 26 files, with my changes the count is 113, and with the five changed files at their `origin/main` versions it is 112. The one extra, `src/packaging/project-config.test.ts`'s repository-literal ratchet, came from a doc comment naming the host repository; it is fixed here and that file then passes (`VERDICT pass: 15 tests in 1 file`). The other 112 fail on `origin/main` too (environment: a missing `tsx` module, socket path length, and others), and are not touched by this change.

Outside-Region: `src/packaging/closed-row-ends-instance.test.ts` — pins the own-pull-request release (`why` is `closed`) and the `closedClaimsNow` call text in `withClosedClaims`, both changed here.

Labels cleared on #1325 (`in-progress`, `started`, `session:worker-agent-org-1325`) and on PR #1378 (`session:worker-agent-org-1325`) by `stripClaimLabelsVia`, the door the settle uses. The open-check reads `false`.

Closes a11ign/agent-org#1463

🤖 Generated with [Claude Code](https://claude.com/claude-code)
