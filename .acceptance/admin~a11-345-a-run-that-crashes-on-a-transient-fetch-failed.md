# A11-345: a brief outage is one failed call in the board's Linear failure figure

The board reopened A11-345 a fourth time: "Linear failures" read 2.1% (3 of 143 calls) at 2026-11-15T00:14:58Z. The host lost its network at 00:12Z (the Telegram poller logged `EHOSTUNREACH` and `ENETUNREACH`, and GitHub listings failed, all in the same minute), and the board made three Linear calls one after another into that drop. Each failed every attempt, and each was counted.

Now, once a counted call has failed for good on a failure a retry could get past (the network, a 5xx, a 429), the service is in an outage until its next answer. A call that starts during an outage younger than five minutes (`OUTAGE_COUNTED_ONCE_MS`) and fails the same way is part of that outage. It is only observed, not counted again. An outage that outlasts five minutes has every failed call counted again, as before, so a service that stays down still reads as failing.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/outside-client.test.ts plugins/linear/linear.test.ts src/plugins/loader.test.ts src/ticket-mode/call-outcomes.test.ts src/ticket-mode/pool-crash-retry.test.ts src/ticket-mode/reliability/sweep.test.ts
```

Consumer-declaration: the reliability watch (`src/ticket-mode/reliability`) reads the ledger's figures; `networkUpSince` (A11-399) reads its last-call times, which `observe` still moves for every attempt, so crashed-run recovery is unchanged. The breaker, the retries, `onAttempt` and doctor's per-attempt `linear-calls.json` are unchanged.
