The ticket board's Pick footer sets the model and effort for one batch without changing the default (`batchChoice`, `batchOverride` and `batchNote` in `src/ticket-mode/board-view.ts`, the footer and Queue in `src/ticket-mode/ui.html`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```
