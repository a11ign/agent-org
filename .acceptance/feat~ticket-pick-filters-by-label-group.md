The ticket board's Pick tab filters by label group: Linear reads each ticket's labels with their group in the Pick request (`LABELS` and `toTicket` in `src/ticket-mode/linear.ts`, `TicketLabel` in `src/ticket-mode/source.ts`), the rows, chips and filter are pure functions (`labelRows`, `meetsLabels`, `withLabels`, `clearedRow`, `groupTags` in `src/ticket-mode/label-filters.ts`), the page service sends them as `/label-filters.js` (`labelFiltersScript` in `src/ticket-mode/ui-server.ts`), and the page draws them (`renderLabels` and `labelTags` in `src/ticket-mode/ui.html`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```

Consumer-declaration: none -- a tracker that reads no labels leaves the Pick view with no label rows, as before.
