The ticket board refuses to start a worker whose `tickets.plugins` are not installed where its session will load them (`unreachablePlugins` in `src/ticket-mode/plugins.ts`, called from `prepare` in `src/ticket-mode/pool.ts`), and both briefs tell a worker to stop when a skill they name is missing (`src/ticket-mode/worker-files.ts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```
