A planned ticket whose team has no state of the planner's name keeps its state and still gets its plan (`attachPlan` in `src/ticket-mode/linear.ts`, its note logged by `attachPlan` in `src/ticket-mode/pool.ts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```

Consumer-declaration: `TicketSource.attachPlan` now returns `Promise<string | null>`, a note on what it left undone, where it returned `Promise<void>`. A source that implements it returns null when it did everything.
