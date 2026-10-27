The After-merge verifier no longer files a ticket for a check that was not ready or could not run, and a writer card no longer reads Failed for a ticket that was filed.

- A check about a delay after release ("7 days after release", "over 7 days", "for a week", or an `agent` check's plan `Window:`) is scheduled for its change's installation + window (`src/ticket-mode/after-merge/window.ts`, `scheduleWindows`) and is given to no verifier run before then (`queueVerifiers` in `src/ticket-mode/pool-check-runs.ts`). The Run detail shows "due <date>". A check that an earlier release of the board closed failed before its window could end (the "re-run on or after" chores) is opened again and scheduled the same way (`reopenClosedTooSoon`).
- A verifier run may end `cannot-run-here`, naming what the host lacks in `needs` (`verify.ts`). The check stays open, parked and routed (`capability.ts`); it is not failed and files no ticket of its own. The board files one ticket for each missing capability (`fileCapabilityRequests`), however many checks need it.
- A new-ticket run whose filed ticket cannot be read back is read again after 1s, 4s and 15s (`READ_BACK_BACKOFF_MS` in `src/ticket-mode/pool-board-runs.ts`); if it still cannot be read, the run ends Done and its card names the key the writer reported.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/after-merge/window.test.ts src/ticket-mode/after-merge/capability.test.ts src/ticket-mode/after-merge/verify.test.ts src/ticket-mode/after-merge/checks.test.ts src/ticket-mode/pool-check-windows.test.ts src/ticket-mode/pool-check-runs.test.ts
```

Consumer-declaration: none -- no host file changes meaning. A plan's `Window:` is new for an `agent` check and optional.
