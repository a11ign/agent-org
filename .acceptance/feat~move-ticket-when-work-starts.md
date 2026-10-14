The ticket board moves a ticket to the host file's `tickets.workingState` as its implementation run starts (`moveTicketToWorkingState` in `src/ticket-mode/pool.ts`, `moveToWorkingState` and `moveTo` in `src/ticket-mode/linear.ts`, `workingState` in `src/ticket-mode/settings.ts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```
