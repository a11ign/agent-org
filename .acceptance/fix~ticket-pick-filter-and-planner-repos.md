Ticket mode's Pick view lists what the host file's new `tickets.pick` names: the key's own tickets by default, with the same request as before (`pickQuery` in `src/ticket-mode/linear.ts`), or every open ticket of a team or a project (`pickOf` in `settings.ts`, refused by name otherwise); an empty Pick view says why and names the setting (`pick-scope.ts`, `GET /api/pick` in `server.ts`, drawn by `ui.html`). A batch planner's brief names the `clones` keys as the only repositories `order.json` may name (`batchPlanBriefText` in `worker-files.ts`), and the board refuses any other by name, handing that ticket to a person with no planned repository (`unknownRepos` in `batch-order.ts`, `attachBatch` in `pool.ts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/settings.test.ts src/ticket-mode/linear.test.ts src/ticket-mode/pick-scope.test.ts src/ticket-mode/server.test.ts src/ticket-mode/ui.test.ts src/ticket-mode/remote-proxy.test.ts src/ticket-mode/batch-order.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/pool.test.ts
```

Consumer-declaration: none -- `tickets.pick` is an optional host key whose absence keeps the Pick view's request unchanged; an `order.json` naming a clone's key, or null, is read as before.
