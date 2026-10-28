A queued run is started from the state the board already knows. The reads of its blockers, the heads of its stacked blockers' branches and its plan paths are made in the background (`pool-start-reads.ts`), each given `ctx.readMs` (20 s), and `fill` awaits none of them. A run whose blockers or plan were never read, or whose blockers are older than 30 minutes and could not be read again, is held alone, with "blockers unread: <error>, retrying at <time>" on the board; every other run starts, and a held run takes no slot (`nextStarts` is given the pool's clock). A pass that starts nothing says why in the log (`fill: ...`, A11-359), a failed read is logged, and the runs a pass held and why are in the fill figures `GET /api/health` serves (`fill.held`, A11-363): there is no second start report.

Stacked on A11-363 (#1982), which has A11-359's bounded reads from `main`.

After merge (the ticket's Done-when, 7 days):
- Runner: the board, as the After-merge check `board` of A11-364. No person runs it, and the person's session runs none of it. The board's own sweep that lists A11-364's After-merge lines records the result, and a failed result reopens the ticket (the epic A11-362: "Board-reliability fixes close on their measurement").
- Procedure: from the first pass of the instance that installs this release, and for 7 days, the board reads its own `GET /api/health` (`runs.startable`, `runs.freeSlots`, `runs.sinceLastStartMs`, `fill.held`) together with the `fill:` lines of its run log. A stretch is a 10-minute period in which `runs.startable` is above 0, `runs.freeSlots` is above 0 and `runs.sinceLastStartMs` stays above 10 minutes (the watchdog of A11-363 restarts the instance on the same reading and logs it).
- Pass: no such stretch in the 7 days, and every run in `fill.held` carries its reason (`blockers unread: ..., retrying at ...`, `plan unread: ...`). Fail: any such stretch; the evidence is the `fill:` line and the `/api/health` reading at its start and end.
- Before merge, the same readings are proven by the Acceptance block below: `pool-start-reads.test.ts` (a hung and a failed read hold only their own ticket, and the pass says why), `pool-bounded-reads.test.ts` (A11-359's cases on the new timing) and `pool-figures.test.ts` (`fill.held` and the figures).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-start-reads.test.ts src/ticket-mode/pool-bounded-reads.test.ts src/ticket-mode/queue/start-reads.test.ts src/ticket-mode/pool-figures.test.ts
```

Consumer-declaration: `fill` (pool-start.ts) and `tick` (pool-watch.ts), which the board's pool runs every 30 s, and the board's page, which reads the new entry fields.
