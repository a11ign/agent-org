---
"@a11ign/agent-org": patch
---

A lock-gridlock episode still standing an hour after its holder was woken is escalated once to `product-manager` (agent-org#1426). On the first tick a fired episode has stood 60 minutes (`BLOCKING_ESCALATE_MINUTES`) with at least 5 rows still shelved (`BLOCKING_MIN_ROWS`), product-manager gets one order under `ready-row-unclaimable`, with the holder, its held row, the shelved rows, the minutes, and the three ways out in order: the holder lands its change (with its pull request's review decision), its Region splits or narrows, or the shelved rows are re-sequenced behind it by `blocked-by`. The order says it escalates the wake already sent to the holder and releases no claim. Each held row gets a `lock-gridlock-escalated` row comment. The escalation writes no `lock-gridlock` ledger line, so it does not count as another occurrence. The episode records `escalated`, and a record written before that key reads it as not escalated.
