A queued run is started from the state the board already knows. The reads of its blockers, the heads of its stacked blockers' branches and its plan paths are made in the background (`pool-start-reads.ts`), each with a timeout (20 s), and `fill` awaits none of them. A run whose blockers or plan were never read, or whose blockers are older than 30 minutes and could not be read again, is held alone, with "blockers unread: <error>, retrying at <time>" on the board; every other run starts, and a held run takes no slot. Every pass of `fill` is kept (`pool.fillReport()`, in the snapshot `/api/health` reads) and said in the log whenever its decision changes, and a failed read is logged.

After merge (the ticket's Done-when, 7 days):
- Runner: the board, as the After-merge check `board` of A11-364. No person runs it, and the person's session runs none of it. The board's own sweep that lists A11-364's After-merge lines records the result, and a failed result reopens the ticket (the epic A11-362: "Board-reliability fixes close on their measurement").
- Procedure: from the first pass of the instance that installs this release, and for 7 days, the board reads `starts` in its own `GET /api/health` (written by every pass of `fill`: `at`, `decision`, `queued`, `started`, `held`) together with the `fill:` lines of its run log (written whenever the decision changes while runs are queued and none starts). A stretch is a 10-minute period in which `starts.queued` is above 0, a slot is free (`decision` is not `no free slot`, `the queue is paused`, `the host's load is over`, or a preflight failure) and `started` stays empty.
- Pass: no such stretch in the 7 days, and every held run in `starts.held` carries its reason (`blockers unread: ..., retrying at ...`, `plan unread: ...`). Fail: any such stretch; the evidence is the `fill:` line and the `starts` reading at its start and end.
- Before merge, the same readings are proven by the Acceptance block above: `pool-start-reads.test.ts` (a hung and a failed read hold only their own ticket, and the pass says why) and `health-route.test.ts` (`/api/health` carries `starts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-start-reads.test.ts src/ticket-mode/queue/start-reads.test.ts src/ticket-mode/health-route.test.ts
```

Consumer-declaration: `fill` (pool-start.ts) and `tick` (pool-watch.ts), which the board's pool runs every 30 s, and the board's page, which reads the new entry fields.
