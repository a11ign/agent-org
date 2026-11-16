---
"agent-org": patch
---

The board's call failure figure counts a call by how it ended, not by its first attempt (A11-345). On 2026-11-16 at 02:47Z, six minutes after a restart, one Linear call timed out on a stale connection and was answered on its retry; it was counted as failed, so "Linear failures" read 1 of 45, 2.1%, and the reliability watch reopened the ticket. Now a call whose retry got through is a call that worked; a call that failed every attempt, or that the breaker refused part-way, is still a failed call, and a brief outage is still counted once. Doctor's per-attempt `linear-calls.json` still counts every failed attempt (`src/ticket-mode/outside-client.ts`).
