A queued run waits on the tickets that block it (`blockers` and `linkedPulls` in `src/ticket-mode/linear.ts`, `Blocker` in `source.ts`, `waitsOn` and `runStatus` in `board-view.ts`, `recordBlockers`, `unreadBlockerKeys` and `nextStarts` in `queue.ts`, `readBlockers`, `fill` and `refreshTracker` in `pool.ts`, `blockersText` in `worker-files.ts`, `row` in `ui.html`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```

Consumer-declaration: none -- `blockers` is optional on a ticket source, and a source without it holds no run back.
