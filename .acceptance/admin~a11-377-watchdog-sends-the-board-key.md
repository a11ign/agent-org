The watchdog sends the board's key as `x-ticket-token` when it asks `/api/health`, read from the mode-600 key file with `readBoardKey`. An instance that answers 401 or 403 is alive, so it is never restarted for it, and the watchdog says why. The blocking ledger treats `plugins/github/call-counter.ts` as a seam, so a held-loop line names the code that asked for the `gh` (A11-377).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/watchdog.test.ts src/ticket-mode/blocking-ledger.test.ts
```

Consumer-declaration: none -- no host file key changes meaning.
