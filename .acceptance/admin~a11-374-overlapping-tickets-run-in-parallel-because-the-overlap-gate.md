A queued ticket that overlaps a run in its repository is started at once, stacked on that run's branch, instead of running beside it off `main` (A11-374). What a ticket with no plan claims is its open pull requests' files, else its ticket's Region, else its whole repository (`board-view/overlap-hold.ts`, `region-claims.ts`); `board-view/overlap-stack.ts` picks the run it stacks on (the most recently updated one it can stack on), `nextStarts` returns it with its `overlapStack`, and it enters `stackedOn` through `stackBlockersOf`, so the brief's `--from <branch>` / `gh pr create --base <branch>`, A11-248's restack and the arm bot's stack merge apply. A conflict round counts toward no cap, except at a base that did not move since the last one (`queue/queue-conflict-rounds.ts`), and the 4th conflict on one pull request names the pull requests it keeps colliding with.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/overlap-stack.test.ts src/ticket-mode/conflict-rounds.test.ts src/ticket-mode/overlap-hold.test.ts src/ticket-mode/queue.test.ts
```

Consumer-declaration: none -- the board's own start and round decisions; `ticket:serve` and its pool are the only consumers and change in this pull request.
