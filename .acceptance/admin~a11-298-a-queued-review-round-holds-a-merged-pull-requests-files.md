A queued review round no longer holds a merged pull request's files, and no longer waits on its ticket's blockers. The watch (`settleQueuedRounds` in `src/ticket-mode/pool-round-pulls.ts`, called from `watchFeedback`) reads the state of every pull request a queued round names; one that merged or closed leaves the round's `review`, and a round left with none is dropped to the finished run it continued (`settleRoundPulls` in `src/ticket-mode/queue/queue-round-pulls.ts`), which the tracker sweep completes or queues for its next plan step. A round on an open pull request starts whatever its ticket's blockers are (`waitsOn`, `isRoundOnOpenPull`), except a ticket its own worker waited on. A wait cycle made of a files hold and blocker waits is told once, and says the board lifted the hold (`pool-wait-cycles.ts`). A queued run that has waited more than two hours on the same ticket is a banner on the Runs page and a `doctor` warning row, naming what it waits on and whether that ticket can move (`board-view/long-waits.ts`, `queue/queue-long-waits.ts`, `longWaitChecks` in `src/install/doctor.ts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/queue/queue-round-pulls.test.ts src/ticket-mode/board-view/round-pulls.test.ts src/ticket-mode/board-view/wait-cycles.test.ts src/ticket-mode/pool-round-pulls.test.ts src/ticket-mode/pool-wait-cycles.test.ts src/ticket-mode/board-view/long-waits.test.ts src/ticket-mode/queue/queue-long-waits.test.ts src/ticket-mode/pool-long-waits.test.ts
npx rstest run --config scripts/rstest/rstest.config.ts src/install/doctor.test.ts
pnpm --dir ui exec rstest run --config rstest.config.ts src/runs/runs-states.test.tsx
```

Consumer-declaration: none -- the queue file gains an optional `waitSince` on a queued run, which an older reader ignores; no option is added to a project declaration.
