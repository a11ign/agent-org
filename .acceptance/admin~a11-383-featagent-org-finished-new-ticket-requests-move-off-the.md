Finished ticket-writer requests (Done and Failed) are listed in a Notifications panel behind a bell in the sidebar's head, on every page, and are no longer cards on the Tickets page. The bell is named "Notifications, <n>" with a badge for the count; the panel lists each request with what it filed or why it failed, filters All / Succeeded / Failed, clears one (the existing dismiss) or all (`POST /api/writer/dismiss-finished`, one write that leaves requests under way), marks a request that finished while the page was open as New and opens the panel without taking focus, closes on Escape with the focus on the bell, and fits a 390px window. Requests under way keep their card with Open terminal and Stop.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/queue.test.ts src/ticket-mode/server.test.ts
(cd ui && npx rstest run --config rstest.config.ts --project components src/notifications src/new-ticket)
(cd ui && pnpm run build && npx rstest run --config rstest.config.ts --project pages test/notifications test/new-ticket)
```

Consumer-declaration: none -- no host file key changes meaning.
