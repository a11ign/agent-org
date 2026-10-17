A restart of the ticket instance leaves its workers alone: the session's herdr server starts outside the instance's systemd service (`herdrServerCommand` in `src/ticket-mode/pool.ts`), a pool that starts up sends an adopted run's pane no key, prompt or second start (`startedHere`, `reconcile`), a reviewer is recorded before it starts and adopted when herdr lists it for its head (`reviewerLines`), and `agent-org update` defers while the instance has a live run unless `--force` (`src/install/update.ts`, `liveRunCount` in `src/ticket-mode/queue.ts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode src/install
```
