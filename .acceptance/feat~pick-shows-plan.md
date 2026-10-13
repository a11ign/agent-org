The ticket board's Pick tab marks a ticket with no plan of its own, and filters by whether a ticket has one, on a machine whose host file names the pattern a plan's file name matches in `tickets.plan` (`missingPlan`, `planCounts` and `visibleTickets` in `src/ticket-mode/board-view.ts`, `planPattern` in `src/ticket-mode/settings.ts`, each ticket's `uploads` in `src/ticket-mode/linear.ts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```

Consumer-declaration: `tickets.plan` is a new optional key in the host file. Without it the board marks no ticket and shows no Plan filter, as before.
