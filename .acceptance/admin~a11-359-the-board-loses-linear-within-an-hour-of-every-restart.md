Every call the board makes to Linear (a query, a mutation, a plan download, an upload) is made on a connection opened for it and closed after it (`src/fresh-fetch.ts`, which the board's plugin deps give the Linear plugin), so a socket Linear closed while the loop was busy is never reused. A call that fails to reach Linear, runs past 10 s, or is answered 429 or 5xx is tried again on a new connection, after 200 ms, 800 ms and 2 s, up to three times (`plugins/linear/linear.ts`). `fill()` gives every read a time (`readMs`, a minute), holds a ticket whose blockers or plan cannot be read with its reason while the other queued runs start, keeps the last good blockers, heads and project repository when a read fails, and logs why a pass started nothing, once for each reason (`src/ticket-mode/pool-start.ts`). The board logs the failure rate of its calls, and `agent-org doctor` fails its `linear calls` row above 1 failure in 100 calls over an hour (`plugins/linear/call-log.ts`, `checks.ts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/fresh-fetch.test.ts plugins/linear/linear.test.ts plugins/linear/call-log.test.ts plugins/linear/index.test.ts src/ticket-mode/pool-start-reads.test.ts src/ticket-mode/pool-reads.test.ts src/ticket-mode/pool-linear-connections.test.ts src/ticket-mode/pool.test.ts
```

Consumer-declaration: none -- no existing host file changes meaning. The Linear plugin and the board's pool are the readers of what changed; a plugin that gives no `freshFetch` is called through its `fetch`, as before.
