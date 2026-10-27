A watched run that has used the board's three rounds goes to the planner, not to a person: it gets a planner round (a brief with the rounds, the feedback, the open blockers and the way out; a Stop held to `cap-decision.json`) and no Needs-you note. The planner records a Decision and one more round of the worker starts with it (counted toward no cap), or marks the run as waiting on a named ticket, which reads Waiting (not Needs you) and starts a round again when that ticket's pull request merges (or the ticket is completed or canceled), or escalates with a `needs-human` outcome that names an item of the escalation list, which still reads Needs you. A round that answers only a check the ticket's Decisions call unrelated, or one a rerun found red again, counts toward no cap. A machine with no planner, and a run parked on a question, are handed to a person as before.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-cap.test.ts src/ticket-mode/cap-stop.test.ts src/ticket-mode/run-log.test.ts src/ticket-mode/pool-checks-rerun.test.ts
```

Consumer-declaration: none -- no host file changes meaning. The queue file gains two optional fields (`capRound`, `waitingOnTicket`), which an older queue simply does not have.
