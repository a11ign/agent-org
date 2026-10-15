The ticket board's Settings panel sets the model and effort for new runs and the number of workers at once, each saved as it changes (`openSettings`, `saveChoice` and `saveMax` in `src/ticket-mode/ui.html`, `POST /api/choice` in `src/ticket-mode/server.ts`, `runsWithLabel` and `workersLabel` in `src/ticket-mode/board-view.ts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```

Consumer-declaration: `POST /api/queue` no longer saves the model and effort it is sent. A script that relied on queueing to change the board's saved choice calls `POST /api/choice` instead.
