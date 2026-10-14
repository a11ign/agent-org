The ticket board plans a ticket with no plan before it is worked: `tickets.planner` (`src/ticket-mode/settings.ts`), the planning run's brief and refusals (`planBriefText` and `PLANNING_DENY` in `src/ticket-mode/worker-files.ts`), attaching its plan and queueing the ticket again (`settle` and `attachPlan` in `src/ticket-mode/pool.ts`, `planDone` in `src/ticket-mode/queue.ts`, `attachPlan` in `src/ticket-mode/linear.ts`), the planning choice and Plan first (`src/ticket-mode/server.ts`, `src/ticket-mode/ui.html`, `runStatus`, `queueLabel` and `runChoiceLabel` in `src/ticket-mode/board-view.ts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```

Consumer-declaration: the board now writes to the tracker, but only when a machine sets `tickets.planner`: a planning run's files, attached to its ticket, and the ticket's move to the planner's state. A machine without it is unchanged. `choice.json` gains `planModel` and `planEffort`, and `POST /api/choice` accepts them.
