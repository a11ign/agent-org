The ticket board's Pick tab filters by priority (`priorityCounts`, `prioritiesOf`, `PRIORITY_NAMES` and the `priorities` filter of `visibleTickets` in `src/ticket-mode/board-view.ts`, `renderPriorities` in `src/ticket-mode/ui.html`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```
