A running run that waits on its own background work (a live shell or Monitor on its pane, or a `working` outcome that names a `waitingOn` job) is shown as "Waiting on background work", not Stalled, until the `until` its outcome gives or three hours after it was written; past that, with no newer outcome, it is Stalled and the reason names the job. A run with no live work and no named job stalls on `tickets.stallMinutes` as before.

Acceptance:
```bash
A11Y_PRIVATE_TMP_BASE=/tmp/ao-private-tmp npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/queue.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/outcome.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/worker-files.test.ts
```

Mutation: `watchWorking` was made to ignore `background === "live"` and `waitingOn` again, and the A11-236 tests in `queue.test.ts` and `pool.test.ts` went red; it was restored and the suite passed again.

Consumer-declaration: none -- `waitingOn`, `until` and `waiting` are optional fields of the working note, read only by `workingNote` and the pool's stall log; a queue stored before them reads as before.
