On Pick, a parent folds the tickets under it and its checkbox picks them, never itself (`flatten` and `parentTick` in `src/ticket-mode/board-view.ts`, `renderPick`, `pickableShown` and `allOpen` in `ui.html`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```

Consumer-declaration: none -- the page changes only what it draws and what its checkboxes select; the queue API is unchanged.
