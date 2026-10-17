Ticket mode's reviewer, behind `tickets.reviewer` (agent-org#1720). The stub prompt is replaced by the gate's own `awaitingVerdictPrompt`, exported from `src/work-gate/pr-orders.ts` and imported, not copied. A reviewer starts only for a settled-green head on a pull request that is not a draft, and only when `drafts` is off. The once-per-head memory (heads, started, resumed) is kept at `tickets/reviewers.json` under `stateDir`: a missing file remembers nothing, an unreadable one is said once in the log and remembers nothing. The reviewer's own review never moves `feedbackAt`, because the feedback reads go through `withoutReviewerReviews`. The field list the reviewer reads by (`REVIEW_PULL_FIELDS`) and `settledGreenOf` sit in `pr-orders.ts` beside `reviewHeadsOf`, a file already exempt in the red-state guard, so `reviewer-port.ts` names no rollup field and the guard in `org-health.test.ts` stays green without a new exemption.

Acceptance:
```bash
grep -q "a restarted pool starts no second reviewer on a head it already reviewed" src/ticket-mode/pool.test.ts && node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/reviewer-port.test.ts src/ticket-mode/pool.test.ts
```

The row's issue text starts the command with `cd ~/repos/agent-org`. That is the shared main checkout, on `a936d9c0` (`Release v0.231.1`), which does not carry this change: run there, the grep fails. This file therefore runs the same grep and the same two test files from the PR's own checkout root, as the other `.acceptance/` files do.

## Evidence

Acceptance (worktree, final code):
```
    "testFiles": 2,
    "failedTests": 0,
    "passedTests": 102,
EXIT 0
```

Red-state guard file alone (`src/packaging/org-health.test.ts`): `#2956 ONE DECIDER` passes; the four failing tests are the baseline ones listed below.

Typecheck (`pnpm run typecheck`, which runs `tsc --noEmit -p tsconfig.json`), final code:
```
> agent-org@0.2.0 typecheck /home/agent/repos/wt-agent-org-1720
> tsc --noEmit -p tsconfig.json

EXIT 0
```
The tsc program holds 1162 files outside `node_modules` (the floor is 440).

CI-equivalent gates, final code:
```
== leak-scan
leak scan: 2810 files examined, 0 leaks
EXIT 0
== workflow-paths
workflow paths: 7 workflows, 16 paths named, all present
EXIT 0
== layout-check
layout-check: ok (2808 files read under /home/agent/repos/wt-agent-org-1720)
EXIT 0
```

Full suite (`AGENT_ORG_HOST` naming the fixture project's `host.json`, `A11Y_RSTEST_FULL_REPORT=1`):
- Run #1, before the red-state guard was fixed: `VERDICT fail: 65 of 12165 tests failed in 755 files`. The extra failure is `#2956 ONE DECIDER` in `src/packaging/org-health.test.ts`.
- Run #2, before the two functions moved from `pr-state.ts` to `pr-orders.ts`: `VERDICT fail: 64 of 12165 tests failed in 755 files`.
- Run #3, final code: `VERDICT fail: 64 of 12165 tests failed in 755 files`, `"failedFiles": 20`, `"failedTests": 64`. Its failing files are exactly the 20 below.

Pre-existing failures: the suite is red on `origin/main` as well. Run in a detached worktree of `origin/main`, the same 20 files fail with 64 tests (41 in 12 files, 19 in 7 files, 4 in `org-health.test.ts`). The 20 files:
`src/board-truth-audit.test.ts`, `src/packaging/deferred-order-relane.test.ts`, `src/packaging/host-install-agent-org-launcher.test.ts`, `src/packaging/multi-board-gate.test.ts`, `src/packaging/org-health.test.ts`, `src/packaging/pr-open-requires-verify-stamp.test.ts`, `src/packaging/pr-owner-gone.test.ts`, `src/packaging/pr-owner-total.test.ts`, `src/packaging/pr-stall-reason.test.ts`, `src/packaging/queue-stalled.test.ts`, `src/packaging/ready-flip-on-green-checks.test.ts`, `src/packaging/verdict-valid-while-patch-unchanged.test.ts`, `src/packaging/wake-order-shape.test.ts`, `src/pr-approved-not-counted-cause.test.ts`, `src/tmp-fixtures-are-removed.test.ts`, `src/work-gate-checkless-pr.test.ts`, `src/work-gate-github-incident.test.ts`, `src/work-gate-runner-start-red.test.ts`, `src/work-gate-unlabelled-pr-owner.test.ts`, `src/work-gate-unordered-review-pr.test.ts`.

`package.json` has no `lint` or `verify` script; the checks above are the project's own gates.

## Mutation checks

These ran before the two functions moved to `pr-orders.ts`. The lines they change (in `pool.ts`) did not move, and the final-code runs above cover the rest. Each mutation was applied to one line of `pool.ts`, run through `src/ticket-mode/reviewer-port.test.ts` and `src/ticket-mode/pool.test.ts`, and then reverted by `cp` from a backup under the scratchpad. Each revert was confirmed with `cmp`. `git checkout --` was not used.

| Direction | Mutation (in `pool.ts`) | Result |
|---|---|---|
| Drafts gate | `reviewerOn = settings.reviewer !== null` (drops `&& !settings.drafts`) | 1 failed, 101 passed: `a machine with tickets.drafts true starts no reviewer, and one with tickets.drafts false does` |
| Memory | `remembered = reviewerOn && false ? readReviewerMemory(...) : undefined` (a restart forgets the file) | 3 failed, 99 passed: `a restarted pool starts no second reviewer on a head it already reviewed`; `a restarted pool asks for no second round for a verdict it already answered`; `a reviewer memory file that cannot be read is said once ...` |
| Wrapper | `feedbackGh = gh` (the reviewer's reviews reach `feedbackOf`) | 3 failed, 99 passed: `the reviewer's own review never moves feedbackAt ...`; `a restarted pool asks for no second round ...`; `a not-convinced verdict resumes the same worker ...` (`reviewer-port.test.ts`) |

After each revert, `cmp` confirmed `pool.ts` identical to its backup.

Consumer-declaration: none -- the change stays in ticket mode's reviewer. `pool.ts` (the loop the tool runs) imports `reviewer-port.ts`; `reviewer-port.ts` imports `pr-orders.ts`. No new module is added.
