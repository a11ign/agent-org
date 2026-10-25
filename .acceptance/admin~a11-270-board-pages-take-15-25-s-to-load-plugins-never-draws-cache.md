A board page the tab has drawn before draws its last data at once and refreshes it in place (A11-270, step 3 of 4): each read's last good answer, and the connections list, is kept in the tab's `sessionStorage` per instance and path (`ui/src/api/session-cache.ts`), so Tickets, Runs, a run's page, Machine, Models, Workers and Plugins draw while every read is still in flight, with no skeleton, and the static HTML's skeleton is held back until the shell has drawn the kept data. The controls that write wait for the instance's own answer. A page whose SSH instance cannot be reached draws its last data under the existing unreachable frame, and Plugins shows the proxy's last known answer as the Unknown board. The first visit of a tab still draws the skeleton.

Acceptance:
```bash
pnpm ui:build
pnpm --dir ui exec rstest run --config rstest.config.ts src/api/session-cache.test.ts src/api/use-poll.test.tsx src/shell/pages-return.test.tsx src/settings/settings-unreachable.test.tsx src/run-detail/run-detail-lifecycle.test.tsx src/updating/updating.test.tsx test/return-visit.page.test.ts
```

Consumer-declaration: none -- the change is inside the board UI's browser code; no route, answer shape or file another package reads changes.
