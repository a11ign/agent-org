---
"agent-org": patch
---

The board's "Linear failures" figure counts a call once, however many times the Linear client tries it (A11-345). Before, every attempt was counted, so one call that failed all four attempts while the host had no network (2026-11-08 00:17Z: 174 attempts, 4 failed, 2.3%) read as four failures and breached the 1% the reliability watch holds, and reopened the ticket for a host outage that one call out of 171 had met. Now the first attempt of a call is counted (failed if it failed, so a failure a retry covers still shows) and the retries go through a new tracker dep, `retryFetch`, which counts nothing but still tells the ledger whether the attempt got through, so a retry that is answered still reads as the network being up again (`networkUpSince`). Doctor's own count in `linear-calls.json` still counts every attempt (`src/plugins/loader.ts`, `src/ticket-mode/call-outcomes.ts`, `plugins/linear/linear.ts`).
