A parked run whose pull request conflicts with its base is resumed now: a run that parked on a question (`needs-human`), or ended with no outcome or crashed, has its workspace closed and a review round queued, which resumes the same worker to merge the base in. Only a conflict wakes a parked run, within the same cap of three rounds, and a run the tracker completed or canceled, or whose pull requests merged or closed, is left alone. The review brief tells the worker, when no check has started on its head commit, to read `mergeable` and `mergeStateStatus` first and to merge a conflicting base in rather than write `needs-human` for checks that did not start. The tests carry `A11-89` in their names.

Acceptance:
```bash
node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts --testNamePattern "A11-89" src/ticket-mode/board-view.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/worker-files.test.ts
```
