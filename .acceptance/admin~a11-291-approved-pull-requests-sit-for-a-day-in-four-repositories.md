Refs A11-291

An approved pull request with green checks that nothing merges is no longer "Awaiting review": a11ign/plugin#10 sat approved at `91cfe96d` for a day in a repository with no merge flow. The watch (`pool-watch.ts`) marks each pull request head it reads (`board-view/not-merging.ts`): `unmergedSince` when it is approved at its head, into the default branch, its required checks are green, it is mergeable and the host says it is not in the merge queue; `notMerging`, the reason, once that has lasted 15 minutes. The run then reads "Approved, not merging" (a new status, `RUN_STATUSES`), its card says `Approved, not merging: <pull request> at <head>, <reason>`, and after 60 minutes its `mergeNote` is a note under the escalation list's `access` item, which `runStatus` reads as Needs you (a note on the run, not a hand-back: the board still watches it and offers Approve and Publish). The reason is read from the code host (contract 1.25: `PullFeedback.armed`, `readMergeFlow`): the repository has no merge flow (auto-merge not allowed, no `.github/workflows/auto-arm.yml`), auto-merge is not on for it, or only that it is not in the queue. A pull request that adds `auto-arm.yml` to a repository that has none (`firstFlow`) reads Needs you the day it is approved, and `pr:open` refuses its body unless it carries `Needs a person to merge: <why>` (`firstMergeFlowReport`, in CI's list as `first-flow`). Doctor has a `merge flow` row (`plugins/github/merge-flow-checks.ts`): every GitHub repository a clone of the host names must allow auto-merge and hold `auto-arm.yml`; each that does not is named with what to add.

The tests that run a pool (`src/ticket-mode/board-view/not-merging-watch.test.ts`, which proves the 15 minutes, the hour and the first install end to end over the watch, and the doctor, board-view and queue tests that were changed) need the project's history, which this acceptance job does not have; CI's `suite` job runs them, with `AGENT_ORG_HOST` naming the fixture project.

Acceptance:
```bash
# The board's rules, pure: the thresholds, the stamp, the reason, the first install, a stacked pull request, several pull requests, a flicker of mergeable, and the note not removing Respond, Approve or Publish.
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/board-view/not-merging.test.ts
# Doctor's row (a repository with no flow is named with what to add; one with a flow passes; one that cannot be read fails saying so; one query) and the code host's reads of auto-merge, the default branch and the arm workflow.
npx rstest run --config scripts/rstest/rstest.config.ts plugins/github/merge-flow-checks.test.ts plugins/github/merge-flow.test.ts plugins/github/pull-feedback.test.ts
# pr:open refuses a first install's body that does not say a person merges it.
npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/first-merge-flow-report.test.ts src/packaging/pr-open-runs-every-ci-body-report.test.ts
npm run typecheck
npm run lint
# The rail and the run's callout.
pnpm --dir ui exec rstest run --config rstest.config.ts src/runs/runs-model.test.ts src/run-detail/run-detail-model.test.ts src/runs/runs-states.test.tsx
```

After merge: `agent-org doctor` on the agents host has a `merge flow` row in the code host's section, which names every repository that lacks a merge flow.
