When the pull request below a finished stacked run's open pull request merges, agent-org merges the default branch into the open one with the code host's `updateBranch` (no rebase, no force-push): once for each merged member, with the card showing `#N restacked on main after #M merged` or the conflict, and a conflict starting the run's conflict round with the stack and the merged member named (`src/ticket-mode/stack-restack.ts`, `sweepRestacks` in `src/ticket-mode/pool-tracker.ts`). Closing a member left with no changes of its own is step 2 of 2.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/stack-restack.test.ts src/ticket-mode/pool-restack.test.ts src/ticket-mode/pool-stack-merge.test.ts src/ticket-mode/stack-rebase.test.ts src/ticket-mode/worker-files.test.ts
```
