---
"@a11ign/agent-org": patch
---

A failure entry the ledger refused no longer wakes `orchestrator`. `repeatedOrdersNow` returns no order when `recordFailures` reports `refused`, as it already did for `skipped`, so the order is sent only for a filing that happened. The repeat is retried on the next tick (agent-org#1101, fix-forward of agent-org#1098 and a11ign/a11ign#5147).
