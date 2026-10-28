---
"agent-org": patch
---

A live read never gates a start (A11-364, on A11-359's bounded reads and A11-363's fill figures). `fill()` no longer awaits any read of the tracker, the code host or a remote: the pool makes the reads of blockers, stacked heads and plan paths beside the pass (`pool-start-reads.ts`), each given `ctx.readMs` (now 20 s), and `fill` decides from what they last recorded. Every blockers read is stamped (`blockersReadAt`), and blockers older than 30 minutes are read again before a start that depends on them; a ticket whose read has not been made or has failed is held alone, with "blockers unread: <error>, retrying at <time>" (or the plan's reason) on the board, takes no slot, and is asked again 25 s after the read started. A read that ends wakes the pool, as does a plan attach that queues the ticket again. The runs a pass held, and why, are in `fill.held` of `GET /api/health`.
