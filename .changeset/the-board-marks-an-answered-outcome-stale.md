---
"agent-org": patch
---

The board no longer moves a worker's `outcome.json` aside when a person answers its parked run or talks to its finished run. It writes a stale mark beside the file instead, and the Stop hook reads the outcome once and judges one written at or before that mark as no outcome, so the worker writes a new one before it stops. A worker that writes its outcome and stops is never told to write it again, even while the board's watcher runs. The only move that remains is a Grill run's question, which waits while its Stop hook is reading the outcome (A11-152).
