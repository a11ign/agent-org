Refs A11-291

An approved pull request with green checks that nothing merges is no longer "Awaiting review": a11ign/plugin#10 sat approved at `91cfe96d` for a day in a repository with no merge flow. The watch (`pool-watch.ts`) marks each pull request head it reads (`board-view/not-merging.ts`): `unmergedSince` when it is approved at its head, its required checks are green, it is mergeable and the host says it is not in the merge queue; `notMerging`, the reason, once that has lasted 15 minutes. The run then reads "Approved, not merging" (a new status, `RUN_STATUSES`), its card says `Approved, not merging: <pull request> at <head>, <reason>`, and after 60 minutes its `mergeNote` is a note under the escalation list's `access` item, which `runStatus` reads as Needs you (a note on the run, not a hand-back: the board still watches it and offers Approve and Publish). The reason is read from the code host (contract 1.25: `PullFeedback.armed`, `readMergeFlow`): the repository has no merge flow (auto-merge not allowed, no `.github/workflows/auto-arm.yml`), auto-merge is not on for it, or only that it is not in the queue. A pull request that adds `auto-arm.yml` to a repository that has none (`firstFlow`) reads Needs you the day it is approved, and `pr:open` refuses its body unless it carries `Needs a person to merge: <why>` (`firstMergeFlowReport`, in CI's list as `first-flow`). Doctor has a `merge flow` row (`plugins/github/merge-flow-checks.ts`): every GitHub repository a clone of the host names must allow auto-merge and hold `auto-arm.yml`; each that does not is named with what to add.

Acceptance:
```bash
# The board: 15 minutes, 60 minutes, the reason, the first install, and every case that is not stuck (queued, red, running, not mergeable, a new head, a draft).
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/board-view/not-merging.test.ts
# Doctor: a repository with no flow is named with what to add; one with a flow passes; one that cannot be read fails saying so. The code host reads auto-merge and the arm workflow.
npx rstest run --config scripts/rstest/rstest.config.ts plugins/github/merge-flow-checks.test.ts plugins/github/merge-flow.test.ts plugins/github/pull-feedback.test.ts
# pr:open refuses a first install's body that does not say a person merges it.
npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/first-merge-flow-report.test.ts src/packaging/pr-open-runs-every-ci-body-report.test.ts
# The existing board, queue and doctor tests, as they were.
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/board-view/stale-block.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/pool.test.ts src/install/doctor.test.ts
npm run typecheck
npm run lint
# The rail and the run's callout.
pnpm --dir ui exec rstest run --config rstest.config.ts src/runs/runs-model.test.ts src/run-detail/run-detail-model.test.ts src/runs/runs-states.test.tsx
```
Run the rstest lines with `AGENT_ORG_HOST` naming a host declaration, as CI's `suite` job does (the fixture project copied to a temporary directory), and with a stand-in `tailscale` first on `PATH` for the doctor line.

After merge: `agent-org doctor` on the agents host has a `merge flow` row in the code host's section, which names every repository that lacks a merge flow.
