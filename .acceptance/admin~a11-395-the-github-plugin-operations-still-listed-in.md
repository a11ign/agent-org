## What it is

Step 1 of 2 of A11-395. The GitHub plugin's `gh` operations that the board makes on an event (a merge queue removal, a red check, a branch that fell behind, a stack to merge, a pull request to close) still run `gh` through the synchronous `deps.exec` and hold the board's loop while they run (`STILL_SYNCHRONOUS` in `plugins/github/sync-gh-guard.test.ts`). This step adds an async form of each, over `deps.execAsync`, and makes doctor's `merge flow` row read asynchronously. The code host still hands out the synchronous forms, so nothing on the board changes except doctor's row; the contract major that makes the board await the async forms is step 2.

## Change

- `plugins/github/{merge-queue,default-branch-checks,merge-flow,closed-work,ticket-pulls,stack-merge,ci-run,check-runs,rerun-runs,update-branch,close-pull}.ts`: an `…Async` form of each operation, over an `AsyncGh`. The pure pieces (argument lists, parsing, refusal texts) are shared with the synchronous form; only the awaited sequence is written twice.
- `plugins/github/merge-flow-checks.ts`: `readingsOf` and `mergeFlowChecks` answer a promise, over `asyncGhRunner` and the existing `githubRepositoriesOfAsync` (exported from `checks.ts`). `index.ts` awaits it. `merge-flow-command.ts` wraps its synchronous runner.
- `plugins/github/event-operations-async.test.ts` (new): for every pair, the same `gh` calls in the same order and the same answer or refusal.
- `plugins/github/merge-flow-checks.test.ts`: the row is read over `execAsync`, and a case asserts that nothing ran through `deps.exec`.

## What it proves

The parity test and the row's tests pass, the plugin's other tests still pass, typecheck passes.

Acceptance:
```bash
npm run typecheck
npx rstest run --config scripts/rstest/rstest.config.ts plugins/github/event-operations-async.test.ts plugins/github/merge-flow-checks.test.ts plugins/github/merge-flow.test.ts plugins/github/merge-queue.test.ts plugins/github/closed-work.test.ts plugins/github/ticket-pulls.test.ts plugins/github/stack-merge.test.ts plugins/github/ci-run.test.ts plugins/github/check-runs.test.ts plugins/github/update-branch.test.ts plugins/github/close-pull.test.ts plugins/github/default-branch-checks.test.ts plugins/github/index.test.ts
```

Consumer-declaration: none -- the async forms have no caller yet and doctor's row keeps its name, its detail and its fix text; no command, flag or file a host declares changes.
