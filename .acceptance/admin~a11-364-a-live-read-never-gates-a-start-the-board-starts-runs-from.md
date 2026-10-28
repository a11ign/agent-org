A queued run is started from the state the board already knows. The reads of its blockers, the heads of its stacked blockers' branches and its plan paths are made in the background (`pool-start-reads.ts`), each with a timeout (20 s), and `fill` awaits none of them. A run whose blockers or plan were never read, or whose blockers are older than 30 minutes and could not be read again, is held alone, with "blockers unread: <error>, retrying at <time>" on the board; every other run starts, and a held run takes no slot. Every pass of `fill` is kept (`pool.fillReport()`, in the snapshot `/api/health` reads) and said in the log whenever its decision changes, and a failed read is logged.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-start-reads.test.ts src/ticket-mode/queue/start-reads.test.ts src/ticket-mode/health-route.test.ts
```

Consumer-declaration: `fill` (pool-start.ts) and `tick` (pool-watch.ts), which the board's pool runs every 30 s, and the board's page, which reads the new entry fields.
