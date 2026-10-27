A ticket the tracker holds In Progress that has no run on the board and holds a queued run back is now acted on by the board's feedback-cadence sweep (`src/ticket-mode/idle-blockers.ts`, decided by `board-view/idle-blocker.ts`): completed in the tracker when every pull request it links has merged and one of them closes it, otherwise queued on the saved choice (`choice.json`'s model and effort, no plan run first). A ticket another instance holds is left alone. The wait's sentence (`holderMove`, on the Runs page and in `doctor`) names that action instead of only saying nothing is working on the ticket.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/board-view/idle-blocker.test.ts src/ticket-mode/pool-idle-blockers.test.ts src/ticket-mode/board-view/long-waits.test.ts src/packaging/project-vocabulary.test.ts
```

Consumer-declaration: none -- no existing host file changes meaning. The sweep needs no new setting: it reads `choice.json` and `tickets.providers.tracker.takenStates` as the queue route does.
