A pull request whose base is not `main` now gets `ci.yml`'s checks, so its reviewer starts on its green head as for any other. `.github/workflows/ci.yml` has no `branches:` filter on `pull_request` (`merge_group` stays the merge condition for `main`). A stacked member's card reads `waits on #<base> (<state of the base>)` and the base's card reads `#<n> (<ticket>) is stacked on it` (`src/ticket-mode/board-view/stack-wait.ts`, drawn by `ui/src/runs/runs-model.ts`). `nextStarts` (`src/ticket-mode/queue.ts`) starts a queued run that has a pull request stacked on it before the other queued runs of its model. A reviewed stacked head keeps its review when its base is retargeted to `main`, since the head does not change.

Acceptance:
```bash
node --test src/ci-stacked-triggers.test.ts src/ticket-mode/stack-wait.test.ts src/ticket-mode/pool-stacked-review.test.ts
```
