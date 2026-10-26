A finished run in any status, Needs you included, has the base merged into each open pull request that conflicts or is behind (`mergesBase`, `watchFeedback` in `src/ticket-mode/pool-watch.ts`), so a run handed to a person no longer lets its pull request rot `CONFLICTING`. A real conflict on a run no worker is woken for is recorded as `held` (`decideRound` in `src/ticket-mode/pool-base-merge.ts`) and starts no round; the watch records `PullHead.conflict`, the card of any finished run with a conflicting open pull request says so (`conflictNote` in `src/ticket-mode/board-view/pull-conflict.ts`, the row's note in `ui/src/runs/runs-model.ts`), and Respond to review carries the conflict into its round.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-base-merge.test.ts
pnpm --dir ui exec rstest run --config rstest.config.ts src/runs/runs-model.test.ts
```

Consumer-declaration: none -- the queue file gains an optional `conflict` on a pull request's recorded head, which an older reader ignores; no option is added to a project declaration.
