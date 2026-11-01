A run that crashes on a transient network error (`fetch failed`, `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, an undici `UND_ERR_*` code, a 5xx) is queued again by the board after a back-off of 30 s and then 2 min, twice at most, and each retry is on the run's log (`src/ticket-mode/crash-retry.ts`, `pool-crash-retry.ts`). A third transient crash, and a crash for any other reason, is not retried and the run reads Failed with its reason. A tracker write a run makes as it starts is tried again after a network failure and never crashes the run. The Linear client sends a query that failed with `fetch failed` once more on a connection that is closed after it. The board's log line for a network error names `err.cause.code`.

A ticket the board watches from its table of closed tickets (A11-282, A11-345) and has reopened is watched again only from a release installed after its next fix merged, as a ticket watched from its own `Figure:` line already is. Before, the watch began at the second the ticket was closed again, and read the hour of failures before the fix: A11-345 was reopened on 2026-11-01 after a ninety-second network outage of the host, and its next close would have breached on that same hour and reopened it again (`src/ticket-mode/reliability/sweep.ts`, `fixInstalled`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/reliability/sweep.test.ts src/ticket-mode/pool-crash-retry.test.ts plugins/linear/linear.test.ts src/ticket-mode/pool-attach-retry.test.ts src/ticket-mode/pool-write-retry.test.ts
```

Consumer-declaration: none -- the board's pool and the Linear plugin are the only readers of what changed; no project file or command is affected.
