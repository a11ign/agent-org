# A11-345: one call, one count in the board's Linear failure figure

The board reopened A11-345 a third time: "Linear failures" read 2.3% (174 attempts, 4 failed) after one call to Linear failed all four of its attempts while the host's network was down (00:17Z, 2026-11-08; the Telegram poller and GitHub failed in the same minute). The figure counted each attempt, so one failed call read as four.

The first attempt of a call now goes through the counted `fetch`; its retries go through `retryFetch`, which counts nothing but tells the ledger whether the attempt got through. One call is one entry in the figure, failed if its first attempt failed.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/call-outcomes.test.ts plugins/linear/linear.test.ts src/plugins/loader.test.ts plugins/linear/call-log.test.ts src/ticket-mode/pool-crash-retry.test.ts src/ticket-mode/reliability/sweep.test.ts
```

Consumer-declaration: the reliability watch (`src/ticket-mode/reliability`) and `networkUpSince` (A11-399) read the ledger's figures and last-call times; both keep their meaning (one failed call is still a failure; a retry that is answered still marks the network up). Doctor's `linear-calls.json` is unchanged and still counts every attempt.
