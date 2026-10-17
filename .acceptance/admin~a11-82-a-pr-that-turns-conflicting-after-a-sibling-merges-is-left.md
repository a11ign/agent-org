When a run's pull request turns conflicting after a sibling merges, the board now resumes the same worker as a review round: the feedback watch reads `mergeable` and `mergeStateStatus` (a conflict is `CONFLICTING` or `DIRTY`, and `UNKNOWN` is no reading), the round counts toward the cap of three, and the worker merges the base in, never rebasing or force-pushing. Two queued runs in one repository that share a path, from their plans' `## Paths` section or from the files their open pull requests change, no longer start in parallel: the later one waits as Blocked, with its reason, until the holder's pull request merges or closes. Runs that share no path, and runs in different repositories, still start together. The tests carry `A11-82` in their names.

Acceptance:
```bash
node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts --testNamePattern "A11-82" src/ticket-mode/overlap.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/worker-files.test.ts src/ticket-port/pull-feedback.test.ts
```
