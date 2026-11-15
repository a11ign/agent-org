---
"agent-org": patch
---

The board's "Linear failures" figure counts a brief outage once (A11-345). On 2026-11-15 at 00:12Z the host lost its network for a minute or two, and the board made three Linear calls one after another into it; each was counted, so the figure read 3 of 143, 2.1%, and the reliability watch reopened the ticket. Now a call that fails for good on the network, a 5xx or a 429 begins an outage of that service, which ends at its next answer; a later call that fails the same way while the outage is under five minutes old is only observed. Past five minutes every failed call counts again, so a service that stays down still reads as failing. A 4xx, a failure a retry covered and crashed-run recovery (`networkUpSince`) read as before (`src/ticket-mode/outside-client.ts`).
