A reviewer starts on every new head of every open pull request the org holds, once its checks settle green, whatever its run is in: running, finished, `needs-human`, or no run at all, and whoever opened it. One reviewer per head: a head with a reviewer or a posted review is not started again, and a new head after requested changes is. `ticket:review` records its start in the same memory file the pool reads, so the pool does not start a second reviewer for that head. The board shows each open pull request's review state at its current head ("awaiting review at <h8>", "reviewing", "changes requested at <h8>, new head <h8> not yet reviewed"), beside a run's question or in a "Pull requests" section for a pull request no run lists.

Acceptance:
```bash
A11Y_PRIVATE_TMP_BASE=/tmp/ao-private-tmp npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool.test.ts src/ticket-mode/review-command.test.ts src/ticket-mode/server.test.ts src/ticket-mode/reviewer-port.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/ui.test.ts src/ticket-mode/ui-server.test.ts
```

Mutation: the write-time merge of the memory file in `rememberReviewers` was removed. The regression test "a start ticket:review recorded is kept by the pool's next write" went red, and passed again once restored.

Consumer-declaration: none -- `reviewNewHeads` is a new sweep that only adds starts for heads with no reviewer and no posted review. The watched run's path (`reviewerLines`) runs through the same start rule, and its existing tests are unchanged apart from three that started a head only after its verdict was posted, which the rule now refuses.
