# A11-345: a call whose retry got through is no failed call in the board's Linear failure figure

The board reopened A11-345 a fifth time: "Linear failures" read 2.1% at 2026-11-16T02:47:17Z. Six minutes earlier the board had restarted on a new release, so the hour's ledger, which is held in memory, held about 45 calls. At 02:47:02 one of them failed its first attempt with `ETIMEDOUT` and was answered on its retry on a new connection. No call to Linear failed, but the client counted a call by its first attempt, so the figure read 1 of 45.

Now a call is counted once, when it ends: failed only when it failed for good (every attempt failed, or the breaker refused it part-way). Each attempt that is tried again is only observed, so crashed-run recovery (`networkUpSince`, A11-399) still sees it. A brief outage is still counted once (the fourth reopen's rule), and a call that fails for good is still a failed call.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/outside-client.test.ts plugins/linear/linear.test.ts plugins/github/gh.test.ts src/plugins/loader.test.ts src/ticket-mode/call-outcomes.test.ts src/ticket-mode/pool-crash-retry.test.ts src/ticket-mode/reliability/sweep.test.ts
```

Consumer-declaration: the reliability watch (`src/ticket-mode/reliability`) and `/api/health` read the ledger's figures, which now hold fewer failures: a call covered by its retry is no longer one. `networkUpSince` (A11-399) reads the last-call times, which every attempt still moves. The breaker, the retries, `onAttempt` and doctor's per-attempt `linear-calls.json` (A11-359), which still counts every failed attempt, are unchanged.
